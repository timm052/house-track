from app import gnaf
from app.geo_services import Route, parse_matrix
from app.setup.osm import load_stations
from app.worker import geocode_pending, route_stale

from .conftest import as_


# ─── G-NAF load and lookups ───────────────────────────────────────────
def test_gnaf_loads_current_addresses_only(client, gnaf_url):
    import psycopg

    with psycopg.connect(gnaf_url) as conn:
        pids = {r[0] for r in conn.execute("SELECT pid FROM address")}
    assert pids == {"GAVIC0001", "GAVIC0002", "GAVIC0003", "GAVIC0004"}  # 0005 is retired


def test_gnaf_rows_use_the_property_normaliser(client):
    hit = gnaf.by_pid("GAVIC0002")
    assert hit["display"] == "3/12 Smith Street, Box Hill 3128"
    assert gnaf.by_key("3 12 smith street box hill 3128")["pid"] == "GAVIC0002"
    assert gnaf.by_pid("GAVIC0004")["street_number"] == "14-16"
    assert gnaf.by_parcel("PS812345", "23")["pid"] == "GAVIC0003"


def test_address_search_expands_abbreviations(client):
    results = client.get("/api/address/search", params={"q": "12 smith st box"}).json()
    assert [r["pid"] for r in results][:1] == ["GAVIC0001"]
    assert gnaf.search_text("12 St Kilda Rd") == "12 st kilda road"


def test_quick_add_from_autocomplete_is_pinned_immediately(client, people):
    r = client.post("/api/properties", headers=as_(people["a"]), json={
        "address": {"street_number": "12", "street": "Smith Street", "suburb": "Box Hill", "postcode": "3128",
                    "unit": None},
        "gnaf_pid": "GAVIC0001"})
    # 12 Smith St may already exist from test_api; either way the G-NAF point is what we check.
    pid = r.json().get("id") or r.json()["detail"]["existing_property_id"]
    if r.status_code == 201:
        p = client.get(f"/api/properties/{pid}").json()
        assert (p["geocode_source"], p["lon"], p["lat"]) == ("gnaf", 145.1201, -37.8201)


# ─── worker: geocoding ────────────────────────────────────────────────
class FakeNominatim:
    def __init__(self, result):
        self.result, self.calls = result, 0

    def geocode(self, street, suburb, postcode):
        self.calls += 1
        return self.result


def add(client, person, **address):
    body = {"address": {"suburb": "Box Hill", "postcode": "3128"} | address}
    r = client.post("/api/properties", headers=as_(person), json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def drain(nominatim=None):
    while geocode_pending(nominatim):
        pass


def test_worker_geocodes_typed_address_via_gnaf(client, people):
    pid = add(client, people["a"], street_number="14-16", street="Smith St")
    drain()
    p = client.get(f"/api/properties/{pid}").json()
    assert p["geocode_source"] == "gnaf" and p["geocode_confidence"] == 0.4  # street-level geocode type
    assert p["geocode_status"] == "done"


def test_worker_matches_off_the_plan_lot_by_plan_and_lot(client, people):
    r = client.post("/api/properties", headers=as_(people["a"]), json={
        "address": {"street": "Harvest Rd", "suburb": "Clyde North", "postcode": "3978",
                    "plan_number": "PS812345", "lot_number": "23"}, "build_status": "off_the_plan"})
    pid = r.json().get("id") or r.json()["detail"]["existing_property_id"]
    drain()
    p = client.get(f"/api/properties/{pid}").json()
    assert (p["lon"], p["lat"]) == (145.3301, -38.0901)


def test_worker_falls_back_to_nominatim_then_gives_up(client, people):
    found = add(client, people["b"], street_number="1", street="Nowhere Gr")
    fake = FakeNominatim((145.2, -37.9, 0.6, {"display_name": "1 Nowhere Grove"}))
    drain(fake)
    p = client.get(f"/api/properties/{found}").json()
    assert p["geocode_source"] == "nominatim" and fake.calls >= 1

    lost = add(client, people["b"], street_number="2", street="Nowhere Gr")
    drain(FakeNominatim(None))
    assert client.get(f"/api/properties/{lost}").json()["geocode_status"] == "no_match"


def test_editing_the_address_regeocodes(client, people):
    pid = add(client, people["a"], street_number="3", street="Other St")
    drain(FakeNominatim((145.0, -37.0, 0.3, {})))
    assert client.get(f"/api/properties/{pid}").json()["geocode_source"] == "nominatim"
    client.patch(f"/api/properties/{pid}", headers=as_(people["a"]), json={
        "address": {"unit": "3", "street_number": "12", "street": "Smith St", "suburb": "Box Hill", "postcode": "3128"}})
    drain()
    p = client.get(f"/api/properties/{pid}").json()
    assert p["gnaf_pid"] == "GAVIC0002" and p["geocode_source"] == "gnaf"


# ─── pins, areas, map ─────────────────────────────────────────────────
def test_manual_pin_overrides_and_can_be_cleared(client, people):
    pid = add(client, people["a"], street_number="5", street="Pin St")
    drain(FakeNominatim((145.05, -37.85, 0.3, {})))
    client.put(f"/api/properties/{pid}/location", headers=as_(people["b"]), json={"lon": 145.06, "lat": -37.86})
    p = client.get(f"/api/properties/{pid}").json()
    assert (p["lon"], p["lat"], p["manual_pin"]) == (145.06, -37.86, True)
    client.delete(f"/api/properties/{pid}/location", headers=as_(people["b"]))
    p = client.get(f"/api/properties/{pid}").json()
    assert (p["lon"], p["manual_pin"]) == (145.05, False)


def square(lon, lat, d=0.01):
    return {"type": "Polygon", "coordinates": [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d],
                                                [lon - d, lat + d], [lon - d, lat - d]]]}


def test_areas_flag_their_owner_and_badge_the_other(client, people):
    a, b = people["a"], people["b"]
    pid = add(client, a, street_number="8", street="Flag St")
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.40, "lat": -37.70})
    area = client.post("/api/areas", headers=as_(a), json={
        "name": "Flight path", "kind": "hard_exclude", "geometry": square(145.40, -37.70)}).json()["id"]

    def feature(person):
        fc = client.get("/api/map", headers=as_(person)).json()["properties"]
        return next(f["properties"] for f in fc["features"] if f["properties"]["id"] == pid)

    mine, theirs = feature(a), feature(b)
    assert mine["excluded"] is True and mine["reasons"] == ["Flight path"]
    assert theirs["excluded"] is False
    assert theirs["others_flags"] == [{"owner_id": a["id"], "kind": "hard_exclude", "name": "Flight path"}]

    # Soften it, then archive it.
    client.patch(f"/api/areas/{area}", headers=as_(a), json={"kind": "soft_warn"})
    assert feature(a)["warned"] is True and feature(a)["excluded"] is False
    client.delete(f"/api/areas/{area}", headers=as_(a))
    assert feature(a)["warned"] is False
    assert area not in [f["properties"]["id"] for f in client.get("/api/map").json()["areas"]["features"]]


def test_self_intersecting_drawing_is_repaired(client, people):
    bowtie = {"type": "Polygon", "coordinates": [[[145.5, -37.5], [145.52, -37.52], [145.52, -37.5],
                                                  [145.5, -37.52], [145.5, -37.5]]]}
    r = client.post("/api/areas", headers=as_(people["b"]), json={"name": "Bowtie", "kind": "soft_warn", "geometry": bowtie})
    assert r.status_code == 201, r.text
    area = next(f for f in client.get("/api/map").json()["areas"]["features"] if f["properties"]["id"] == r.json()["id"])
    assert area["geometry"]["type"] == "MultiPolygon" and len(area["geometry"]["coordinates"]) == 2
    assert area["properties"]["owner_id"] == people["b"]["id"]


# ─── stations, places, travel ─────────────────────────────────────────
class FakeValhalla:
    """Walking at 5 km/h and driving at 40 km/h over straight-line distance."""

    def matrix(self, origin, targets, mode):
        from math import cos, hypot, radians

        speed = 5 / 3.6 if mode == "walk" else 40 / 3.6
        out = []
        for lon, lat in targets:
            metres = hypot((lon - origin[0]) * 111_320 * cos(radians(lat)), (lat - origin[1]) * 110_540)
            out.append(Route(round(metres), round(metres / speed)))
        return out

    def drive_peak(self, origin, target):
        return round(self.matrix(origin, [target], "drive")[0].duration_s * 1.5)


def test_stations_places_and_travel(client, people, database_url):
    a = people["a"]
    load_stations([
        {"osm_id": 101, "name": "Blackburn", "geometry": {"type": "Point", "coordinates": [145.1300, -37.8230]}},
        {"osm_id": 102, "name": "Box Hill", "geometry": {"type": "Point", "coordinates": [145.1210, -37.8190]}},
        {"osm_id": 103, "name": "Far Away", "geometry": {"type": "Point", "coordinates": [145.9000, -37.8200]}},
    ], database_url)
    assert [s["name"] for s in client.get("/api/stations/search", params={"q": "box"}).json()] == ["Box Hill"]

    for osm_id in (101, 102, 103):
        assert client.post("/api/places", headers=as_(a), json={"kind": "station", "station_osm_id": osm_id}).status_code == 201
    work = client.post("/api/places", headers=as_(a), json={
        "kind": "destination", "name": "Work", "person_id": a["id"], "location": {"lon": 144.9631, "lat": -37.8136}}).json()["id"]

    pid = add(client, a, street_number="20", street="Travel St")
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.1220, "lat": -37.8200})
    initially_pending = client.get(f"/api/properties/{pid}").json()["travel"]["pending"]
    assert initially_pending >= 5  # 3 stations walk, work walk + drive (plus places from other tests)
    from app.worker import route_peak, route_station_access, route_transit

    class NoJourney:  # public transport isn't under test here
        def plan(self, *args, **kwargs):
            return None
    while route_stale(FakeValhalla()) + route_station_access(FakeValhalla()) + route_transit(NoJourney()) + route_peak(FakeValhalla()):
        pass

    travel = client.get(f"/api/properties/{pid}").json()["travel"]
    assert travel["pending"] == 0
    # The nearest of all the stations, whether or not it was picked on the Places screen, walking and driving.
    nearest = travel["nearest"]
    assert nearest["name"] == "Box Hill" and nearest["walk_s"] > nearest["drive_s"] > 0
    row = next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert row["nearest_station"] == "Box Hill" and row["nearest_station_walk"] >= row["nearest_station_drive"] >= 1
    assert {"Box Hill", "Blackburn", "Far Away"} <= {f["properties"]["name"] for f in client.get("/api/stations").json()["features"]}
    names = [s["name"] for s in travel["stations"]]
    assert names == ["Box Hill", "Blackburn"]  # nearest, then within the 15-minute limit; Far Away hidden
    assert travel["stations"][0]["is_nearest"] and travel["stations"][0]["duration_s"] < 120
    [dest] = [d for d in travel["destinations"] if d["place_id"] == work]
    assert dest["drive_s"] < dest["walk_s"] and dest["walk_m"] == dest["drive_m"]

    listed = next(p for p in client.get("/api/properties").json() if p["id"] == pid)
    assert listed["nearest_station"] == "Box Hill"

    # Moving the pin makes every route for this property stale again.
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.1300, "lat": -37.8200})
    assert client.get(f"/api/properties/{pid}").json()["travel"]["pending"] == initially_pending

    # Removing and re-choosing a station reuses its row.
    box_hill = next(p for p in client.get("/api/places").json() if p["station_osm_id"] == 102)
    client.delete(f"/api/places/{box_hill['id']}", headers=as_(a))
    again = client.post("/api/places", headers=as_(a), json={"kind": "station", "station_osm_id": 102}).json()
    assert again["id"] == box_hill["id"]


def test_station_refresh_moves_designated_places(client, people, database_url):
    load_stations([{"osm_id": 101, "name": "Blackburn", "geometry": {"type": "Point", "coordinates": [145.1310, -37.8240]}}],
                  database_url)
    place = next(p for p in client.get("/api/places").json() if p["station_osm_id"] == 101)
    assert (place["lon"], place["lat"]) == (145.131, -37.824)
    # 102 and 103 were not in this refresh but are still designated, so they're kept.
    assert {p["station_osm_id"] for p in client.get("/api/places").json()} >= {101, 102, 103}


def test_valhalla_matrix_shapes():
    rows = {"sources_to_targets": [[{"distance": 1.234, "time": 900, "to_index": 1},
                                    {"distance": None, "time": None, "to_index": 0}]]}
    assert parse_matrix(rows, 2) == [Route(None, None), Route(1234, 900)]
    arrays = {"sources_to_targets": {"distances": [[0.5, None]], "durations": [[360, None]]}}
    assert parse_matrix(arrays, 2) == [Route(500, 360), Route(None, None)]


def test_valhalla_long_walks_and_empty_cells():
    """Walks too far are recorded as no route without asking; cells the matrix leaves empty are routed one by one."""
    from app.geo_services import Valhalla
    v = Valhalla("http://valhalla:8002")
    calls = []

    def post(path, body):
        calls.append((path, body))
        if path == "sources_to_targets":  # the second target comes back empty, as long drives do on the public server
            return {"sources_to_targets": [[{"distance": 2.0, "time": 300, "to_index": 0},
                                            {"distance": None, "time": None, "to_index": 1}]]}
        return {"trip": {"summary": {"length": 88.3, "time": 4252.4}}}
    v._post = post
    woodend, near, box_hill = (144.5318, -37.3612), (144.54, -37.37), (145.132, -37.808)
    assert v.matrix(woodend, [near, box_hill], "drive") == [Route(2000, 300), Route(88300, 4252)]

    zero = lambda path, body: ({"sources_to_targets": [[{"distance": 0, "time": 0, "to_index": 0}]]} if path == "sources_to_targets"
                               else {"trip": {"summary": {"length": 5.2, "time": 600}}})
    v._post = zero
    assert v.matrix(woodend, [box_hill], "drive") == [Route(5200, 600)]  # "0 m" across 70 km: asked again alone
    v._post = post
    assert [c[0] for c in calls] == ["sources_to_targets", "route"]

    calls.clear()
    assert v.matrix(woodend, [box_hill], "walk") == [Route(None, None)]
    assert calls == []  # 70 km: not worth a walking route, and the public server refuses it


def test_plan_legs_and_isochrone_are_asked_once(client, monkeypatch):
    from app.routes import geo
    calls = []

    class Fake:
        def route(self, a, b, mode):
            calls.append(("route", a, b))
            return Route(1000, 300)

        def isochrone(self, origin, minutes, mode):
            calls.append(("iso", origin, minutes))
            return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": []}, "properties": {"minutes": minutes}}
    monkeypatch.setattr(geo, "_routing", lambda: Fake())
    monkeypatch.setattr(geo, "_legs", {})
    monkeypatch.setattr(geo, "_areas", {})
    pts = [[145.1, -37.8], [145.2, -37.81], [145.1, -37.8]]
    r = client.post("/api/plan/legs", json={"points": pts})
    assert r.status_code == 200 and r.json()["legs"] == [{"distance_m": 1000, "duration_s": 300}] * 2
    client.post("/api/plan/legs", json={"points": pts})
    assert len(calls) == 2  # the second plan reused both legs
    assert client.get("/api/isochrone", params={"lon": 145.1, "lat": -37.8, "minutes": 30}).json()["properties"]["minutes"] == 30
    client.get("/api/isochrone", params={"lon": 145.1, "lat": -37.8, "minutes": 30})
    assert len(calls) == 3
    assert client.get("/api/isochrone", params={"lon": 145.1, "lat": -37.8, "minutes": 90}).status_code == 422


def test_suburb_suggestions(client, gnaf_url):
    from app import gnaf
    gnaf._localities = None
    hits = client.get("/api/address/localities", params={"q": "box"}).json()
    assert {"suburb": "Box Hill", "postcode": "3128"} in hits and all("box" in h["suburb"].lower() for h in hits)
    assert client.get("/api/address/localities", params={"q": "b"}).json() == []  # too short to be useful


def test_polyline6_decoding():
    from app.geo_services import decode_polyline6
    # Two points, encoded at six decimal places the way Valhalla sends route shapes.
    def enc(v):
        v = ~(v << 1) if v < 0 else v << 1
        out = ""
        while v >= 0x20:
            out += chr((0x20 | (v & 0x1F)) + 63)
            v >>= 5
        return out + chr(v + 63)
    pts = [(-37.8136, 144.9631), (-37.8183, 144.9670)]
    s, prev = "", (0, 0)
    for lat, lon in pts:
        la, lo = round(lat * 1e6), round(lon * 1e6)
        s += enc(la - prev[0]) + enc(lo - prev[1])
        prev = (la, lo)
    assert decode_polyline6(s) == [[144.9631, -37.8136], [144.967, -37.8183]]


def test_transit_journey_choice_and_times():
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from app.geo_services import next_weekday_9am, pick_itinerary
    mel = ZoneInfo("Australia/Melbourne")
    # Friday afternoon plans for Monday; Monday plans for Tuesday.
    assert next_weekday_9am(datetime(2026, 9, 25, 15, 0, tzinfo=mel)) == datetime(2026, 9, 28, 9, 0, tzinfo=mel)
    assert next_weekday_9am(datetime(2026, 9, 28, 7, 0, tzinfo=mel)) == datetime(2026, 9, 29, 9, 0, tzinfo=mel)
    by = datetime(2026, 9, 29, 9, 0, tzinfo=mel)
    its = [{"startTime": "2026-09-28T22:11:00Z", "endTime": "2026-09-28T22:45:00Z", "duration": 2040},
           {"startTime": "2026-09-28T22:26:00Z", "endTime": "2026-09-28T22:51:00Z", "duration": 1500},
           {"startTime": "2026-09-28T23:10:00Z", "endTime": "2026-09-28T23:40:00Z", "duration": 1800}]  # arrives 9:40: late
    assert pick_itinerary(its, by)["startTime"] == "2026-09-28T22:26:00Z"  # on time, and leaves latest
    assert pick_itinerary(its[2:], by)["startTime"] == "2026-09-28T23:10:00Z"  # nothing on time: a little late will do
    evening_before = {"startTime": "2026-09-28T06:00:00Z", "endTime": "2026-09-28T10:35:00Z", "duration": 16500}
    assert pick_itinerary([evening_before, its[2]], by) is its[2]  # arriving the evening before doesn't count
    assert pick_itinerary([evening_before], by) is None  # and on its own means no commute was found


def test_worker_plans_public_transport_to_destinations(client, people):
    from app.worker import route_transit
    a = people["a"]

    class FakeTransitous:
        calls = 0

        def plan(self, origin, target, arrive_by=None, depart_at=None):
            FakeTransitous.calls += 1
            if depart_at:  # the trip home
                return {"depart_at": "2026-09-29T07:05:00Z", "arrive_at": "2026-09-29T07:40:00Z", "duration_s": 2100, "transfers": 0,
                        "legs": [{"mode": "train", "name": "Lilydale", "minutes": 30, "from": "Flinders Street", "to": "Box Hill"}]}
            return {"depart_at": "2026-09-28T22:26:00Z", "arrive_at": "2026-09-28T22:51:00Z", "duration_s": 1500, "transfers": 1,
                    "legs": [{"mode": "walk", "name": None, "minutes": 3, "from": None, "to": "Box Hill"},
                             {"mode": "train", "name": "Lilydale", "minutes": 20, "from": "Box Hill", "to": "Flinders Street"}]}
    office = client.post("/api/places", headers=as_(a), json={
        "kind": "destination", "name": "Office", "location": {"lon": 144.9670, "lat": -37.8183}}).json()["id"]
    pid = add(client, a, street_number="21", street="Transit St")
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.1220, "lat": -37.8200})
    fake = FakeTransitous()
    while route_transit(fake):
        pass
    [dest] = [d for d in client.get(f"/api/properties/{pid}").json()["travel"]["destinations"] if d["place_id"] == office]
    assert dest["transit"]["duration_s"] == 1500 and dest["transit"]["legs"][1]["name"] == "Lilydale"
    assert dest["transit"]["home"]["duration_s"] == 2100  # and home again, leaving at 5pm
    row = next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert row[f"transit:{office}"] == 25 and row[f"transit_home:{office}"] == 35
    before = FakeTransitous.calls
    route_transit(fake)
    assert FakeTransitous.calls == before  # stored: not asked again until it's a fortnight old or a pin moves


def test_place_modes_decide_what_is_routed(client, people):
    """A place driven to only: no walking or public transport times are worked out, and turning a mode off drops its times."""
    a = people["a"]
    gym = client.post("/api/places", headers=as_(a), json={
        "kind": "destination", "name": "Gym", "location": {"lon": 145.10, "lat": -37.82}, "modes": ["drive"]}).json()["id"]
    pid = add(client, a, street_number="22", street="Modes St")
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.1220, "lat": -37.8200})

    while route_stale(FakeValhalla()):
        pass
    assert transit_queue_for(gym) == 0  # public transport is off for this place: never asked for
    [dest] = [d for d in client.get(f"/api/properties/{pid}").json()["travel"]["destinations"] if d["place_id"] == gym]
    assert dest["drive_s"] and dest["walk_s"] is None and dest["transit"] is None
    assert next(p for p in client.get("/api/places").json() if p["id"] == gym)["modes"] == ["drive"]

    client.patch(f"/api/places/{gym}", headers=as_(a), json={"modes": ["walk", "drive"]})
    while route_stale(FakeValhalla()):
        pass
    [dest] = [d for d in client.get(f"/api/properties/{pid}").json()["travel"]["destinations"] if d["place_id"] == gym]
    assert dest["walk_s"] and dest["drive_s"]
    client.patch(f"/api/places/{gym}", headers=as_(a), json={"modes": ["walk"]})
    [dest] = [d for d in client.get(f"/api/properties/{pid}").json()["travel"]["destinations"] if d["place_id"] == gym]
    assert dest["walk_s"] and dest["drive_s"] is None


def transit_queue_for(place_id):
    """How many public transport journeys to this place are waiting to be planned."""
    from app.db import tx
    with tx() as conn:
        return conn.execute("SELECT count(*) AS n FROM transit_estimate_stale WHERE place_id = %s", (place_id,)).fetchone()["n"]


def test_moving_a_pin_recalculates_and_says_so(client, people, database_url):
    """Travel times belong to the pin they were worked out from: moving it makes them pending (so screens keep
    checking) until the worker has routed the new spot, then the new times show."""
    from app.worker import route_station_access
    a = people["a"]
    load_stations([{"osm_id": 201, "name": "Here", "geometry": {"type": "Point", "coordinates": [145.00, -37.80]}},
                   {"osm_id": 202, "name": "There", "geometry": {"type": "Point", "coordinates": [145.20, -37.80]}}], database_url)
    pid = add(client, a, street_number="23", street="Moving St")
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.001, "lat": -37.80})
    while route_stale(FakeValhalla()) + route_station_access(FakeValhalla()):
        pass
    assert client.get(f"/api/properties/{pid}").json()["travel"]["nearest"]["name"] == "Here"

    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.199, "lat": -37.80})
    assert client.get("/api/overview").json()["pending"] > 0 and client.get("/api/map", headers=as_(a)).json()["pending"] > 0
    travel = client.get(f"/api/properties/{pid}").json()["travel"]
    assert travel["pending"] > 0 and travel["nearest"] is None  # the old times aren't shown for the new spot
    while route_stale(FakeValhalla()) + route_station_access(FakeValhalla()):
        pass
    travel = client.get(f"/api/properties/{pid}").json()["travel"]
    assert travel["nearest"]["name"] == "There"


def test_peak_hour_weights_big_roads_more():
    from app.geo_services import peak_factor
    freeway = [{"road_class": "motorway", "length": 10, "speed": 100}]
    streets = [{"road_class": "residential", "length": 1, "speed": 40}]
    assert peak_factor(freeway) == 1.8 and peak_factor(streets) == 1.05
    mixed = peak_factor(freeway + streets)  # mostly freeway by time, so close to its factor
    assert 1.05 < mixed < 1.8 and mixed > 1.6
    assert peak_factor([]) == 1.0


def test_trip_home_leaves_at_or_after_five():
    from datetime import datetime, timezone
    from app.geo_services import pick_departure
    five = datetime(2026, 9, 29, 7, 0, tzinfo=timezone.utc)  # 5pm in Melbourne
    its = [{"startTime": "2026-09-29T06:50:00Z", "endTime": "2026-09-29T07:30:00Z", "duration": 2400},  # before 5: no
           {"startTime": "2026-09-29T07:05:00Z", "endTime": "2026-09-29T07:50:00Z", "duration": 2700},
           {"startTime": "2026-09-29T07:10:00Z", "endTime": "2026-09-29T07:40:00Z", "duration": 1800}]
    assert pick_departure(its, five) is its[2]  # home first
    assert pick_departure(its[:1], five) is None


def test_public_transport_prefers_no_bus():
    """Without buses (walking up to 30 minutes at either end) unless a bus lets you leave more than 20 minutes later
    and still be there by 9."""
    from app.geo_services import Transitous

    class Planner(Transitous):
        def __init__(self, train_leaves, bus_leaves):
            self.train_leaves, self.bus_leaves = train_leaves, bus_leaves

        def _plan(self, origin, target, arrive_by, depart_at, no_bus):
            leaves = self.train_leaves if no_bus else self.bus_leaves
            return None if leaves is None else {"depart_at": f"2026-09-28T{leaves}:00Z", "arrive_at": "2026-09-28T22:55:00Z",
                                                "legs": [{"mode": "train" if no_bus else "bus"}]}
    pick = lambda train, bus: Planner(train, bus).plan((0, 0), (1, 1), arrive_by=object())["legs"][0]["mode"]
    assert pick("21:50", "21:40") == "train"  # the train lets you leave later anyway
    assert pick("21:40", "21:55") == "train"  # the bus only buys 15 minutes: walk to the station
    assert pick("21:10", "21:50") == "bus"    # 40 minutes more in bed: take the bus
    assert pick(None, "21:50") == "bus"       # no way without one

def test_short_rides_are_walked_instead():
    """A journey with a two-minute tram loses to one that walks that bit, if it still makes 9am."""
    from datetime import datetime, timezone
    from app.geo_services import pick_journey
    nine = datetime(2026, 9, 28, 23, 0, tzinfo=timezone.utc)
    tram = {"startTime": "2026-09-28T21:54:00Z", "endTime": "2026-09-28T22:56:00Z", "duration": 3720,
            "legs": [{"mode": "WALK", "duration": 1260}, {"mode": "SUBWAY", "duration": 1680}, {"mode": "TRAM", "duration": 120},
                     {"mode": "WALK", "duration": 540}]}
    walk = {"startTime": "2026-09-28T21:54:00Z", "endTime": "2026-09-28T22:59:00Z", "duration": 3900,
            "legs": [{"mode": "WALK", "duration": 1260}, {"mode": "SUBWAY", "duration": 1680}, {"mode": "WALK", "duration": 960}]}
    assert pick_journey([tram, walk], arrive_by=nine) is walk
    assert pick_journey([tram], arrive_by=nine) is tram  # nothing better: the short ride stands


def test_a_short_walkable_ride_at_the_end_is_walked():
    """Home from work: a two-minute bus for the last 600 m becomes a walk, starting when the train gets in."""
    from datetime import datetime, timezone
    from app.geo_services import pick_journey
    five = datetime(2026, 9, 29, 7, 0, tzinfo=timezone.utc)
    stop, near_home, home = {"lon": 145.0700, "lat": -37.7300}, {"lon": 145.0760, "lat": -37.7320}, {"lon": 145.0770, "lat": -37.7340}
    it = {"startTime": "2026-09-29T07:05:00Z", "endTime": "2026-09-29T07:58:00Z", "duration": 3180, "transfers": 1, "legs": [
        {"mode": "SUBWAY", "duration": 1800, "startTime": "2026-09-29T07:05:00Z", "endTime": "2026-09-29T07:35:00Z",
         "from": {"lon": 144.97, "lat": -37.81}, "to": stop},
        {"mode": "WALK", "duration": 120, "startTime": "2026-09-29T07:35:00Z", "endTime": "2026-09-29T07:37:00Z", "from": stop, "to": stop},
        {"mode": "BUS", "duration": 120, "startTime": "2026-09-29T07:45:00Z", "endTime": "2026-09-29T07:47:00Z", "from": stop, "to": near_home},
        {"mode": "WALK", "duration": 660, "startTime": "2026-09-29T07:47:00Z", "endTime": "2026-09-29T07:58:00Z", "from": near_home, "to": home}]}
    got = pick_journey([it], depart_at=five)
    assert [leg["mode"] for leg in got["legs"]] == ["SUBWAY", "WALK"]
    assert got["legs"][1]["startTime"] == "2026-09-29T07:35:00Z" and got["transfers"] == 0
    assert got["endTime"] < "2026-09-29T07:58:00Z"  # and home sooner than waiting for the bus


def test_nothing_leaving_before_six_is_a_commute():
    from datetime import datetime, timezone
    from app.geo_services import pick_journey
    nine = datetime(2026, 9, 28, 23, 0, tzinfo=timezone.utc)
    dawn = {"startTime": "2026-09-28T16:00:00Z", "endTime": "2026-09-28T22:57:00Z", "duration": 25020,
            "legs": [{"mode": "REGIONAL_RAIL", "duration": 3900}]}
    assert pick_journey([dawn], arrive_by=nine) is None


def test_satellite_uses_the_arcgis_key_when_set(client, monkeypatch):
    monkeypatch.delenv("ARCGIS_API_KEY", raising=False)
    assert client.get("/api/map-config").json() == {"satellite": None}
    monkeypatch.setenv("ARCGIS_API_KEY", "abc123")
    url = client.get("/api/map-config").json()["satellite"]
    assert url.startswith("https://ibasemaps-api.arcgis.com/") and url.endswith("{z}/{y}/{x}?token=abc123")
