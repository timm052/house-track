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
    while route_stale(FakeValhalla()):
        pass

    travel = client.get(f"/api/properties/{pid}").json()["travel"]
    assert travel["pending"] == 0
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
