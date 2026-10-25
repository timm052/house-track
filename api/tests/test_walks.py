"""The hills on the walk to the station, on made-up ground (the routing engine and the open map service are replaced):
a walk 600 m due north that climbs 15 m at 5% over 300 m, drops 10 m at 10% over the next 100 m, then runs flat."""

import math

from app import blocks, walks
from app.db import tx
from app.geo_services import Route

from .conftest import as_

LON0, LAT0 = 145.2500, -37.6000
M_LON = 1 / (111_320 * math.cos(math.radians(LAT0)))
M_LAT = 1 / 110_574


def pt(x: float, y: float) -> list[float]:
    return [LON0 + x * M_LON, LAT0 + y * M_LAT]


def ground(y: float) -> float:
    return 100 + y * 0.05 if y <= 300 else 115 - (y - 300) * 0.1 if y <= 400 else 105


def fake_features(type_name, fields, cql=None, bbox=None, sort=None):
    assert type_name == "el_contour_1to5m"
    return [{"geometry": {"type": "LineString", "coordinates": [pt(-300, y), pt(300, y)]},
             "properties": {"ufi": 90_000 + y, "altitude": round(ground(y), 2)}} for y in range(-60, 700, 10)]


class FakeValhalla:
    def route_path(self, origin, target, mode):
        assert mode == "walk"
        return Route(600, 450), [pt(0, y) for y in range(0, 601, 50)]

    def walk_routes(self, origin, target):
        # The usual way, and a longer way round over the same hill (no less climbing, so not offered).
        return [[pt(0, y) for y in range(0, 601, 50)], [pt(0, 0), pt(150, 0), pt(150, 600), pt(0, 600)]]


def test_rating_and_numbers():
    assert walks.rating(0, 1000, 2) == "Flat"
    assert walks.rating(20, 1000, 5) == "Rolling"
    assert walks.rating(20, 1000, 13) == "Hilly"          # a short sharp hill makes it a step harder
    assert walks.rating(80, 1000, 20) == "Steep"
    s = walks.stats([0, 1, 2, 3, 2, 1, 1, 1, 1, 1, 1, 1], 110)
    assert s["climb_to"] > 1 and s["climb_home"] > 1
    main = {"climb_to": 30, "climb_home": 60, "distance_m": 1600}
    ways = walks.better_ways(main, [
        {"climb_to": 20, "climb_home": 40, "distance_m": 1800, "steepest_up": 5, "steepest_down": 8},   # 30 m less, 200 m more
        {"climb_to": 29, "climb_home": 60, "distance_m": 1650, "steepest_up": 5, "steepest_down": 8},   # hardly less
        {"climb_to": 0, "climb_home": 0, "distance_m": 4000, "steepest_up": 0, "steepest_down": 0},     # far too long
    ])
    assert [(w["saves_m"], w["extra_m"]) for w in ways] == [(30, 200)] and ways[0]["rating_home"] == "Rolling"


def test_a_house_walk_is_profiled_and_compared(client, people, monkeypatch):
    monkeypatch.setattr(blocks, "_features", fake_features)
    a = as_(people["a"])
    lon, lat = pt(0, 0)
    slon, slat = pt(0, 600)
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "3", "street": "Hill Street", "suburb": "Testvale", "postcode": "3999"}}).json()["id"]
    client.put(f"/api/properties/{pid}/location", headers=a, json={"lon": lon, "lat": lat})
    with tx(people["a"]["id"]) as conn:
        conn.execute("INSERT INTO station (osm_id, name, location) VALUES (777, 'Testvale', ST_SetSRID(ST_MakePoint(%s, %s), 4326))",
                     (slon, slat))
        conn.execute("""INSERT INTO station_access (property_id, station_osm_id, mode, origin, distance_m, duration_s)
                        VALUES (%s, 777, 'walk', ST_SetSRID(ST_MakePoint(%s, %s), 4326), 600, 450)""", (pid, lon, lat))
    assert client.get(f"/api/properties/{pid}/station-walk").json()["pending"] is True

    for _ in range(10):
        if not walks.profile_pending(FakeValhalla()):
            break
    got = client.get(f"/api/properties/{pid}/station-walk").json()
    w = got["walk"]
    assert got["station"] == "Testvale" and not got["pending"]
    assert abs(w["distance_m"] - 600) < 5 and abs(w["climb_to"] - 15) < 2.5 and abs(w["climb_home"] - 10) < 2.5, w
    assert 4 <= w["steepest_up"] <= 6.5 and 8 <= w["steepest_down"] <= 11, w
    assert w["rating_to"] == "Rolling" and w["rating_home"] == "Gentle" and w["flat_m_to"] > 600
    assert 60 <= len(w["heights"]) <= 62   # every 10 m, and the end
    assert len(w["points"]) == len(w["heights"]) and abs(w["points"][-1][1] - slat) < 1e-4
    assert w["alternatives"] == []   # the way round climbs the same hill

    # Benchmarks: none to start with; one added beside the house is profiled on the same made-up ground and compared.
    assert got["benchmarks"] == []
    blon, blat = pt(5, 0)
    new = client.post("/api/walk-benchmarks", headers=a, json={"name": "Next door", "lon": blon, "lat": blat}).json()
    assert new["station"] == "Testvale"
    client.post(f"/api/walk-benchmarks/{new['id']}/main", headers=a)
    assert client.get("/api/walk-benchmarks").json()[0]["name"] == "Next door"
    for _ in range(5):
        if not walks.profile_pending(FakeValhalla()):
            break
    row = next(r for r in client.get("/api/overview", headers=a).json()["rows"] if r["id"] == pid)
    assert row["walk_hills"] == "Rolling" and row["walk_climb_to"] == round(w["climb_to"]) and row["walk_vs_benchmark"] == 100
    assert client.get("/api/stations/near", params={"lon": lon, "lat": lat}).json()[0]["name"] == "Testvale"

    client.delete(f"/api/walk-benchmarks/{new['id']}", headers=a)
    client.delete(f"/api/properties/{pid}", headers=a)
