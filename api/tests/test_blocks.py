"""Block analysis against a made-up suburb (the open map service is replaced by synthetic features): a 20 × 40 m
house block facing a street on its south side, on ground rising 1 m every 10 m to the north, a unit lot beside it,
and a General Residential zone over both."""

import math

from app import blocks
from app.db import tx

from .conftest import as_

LON0, LAT0 = 145.0700, -37.7400
M_LON = 1 / (111_320 * math.cos(math.radians(LAT0)))
M_LAT = 1 / 110_574


def pt(x: float, y: float) -> list[float]:
    """Metres east and north of the corner, as [lon, lat]."""
    return [LON0 + x * M_LON, LAT0 + y * M_LAT]


def rect(x0, y0, x1, y1) -> dict:
    return {"type": "MultiPolygon", "coordinates": [[[pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1), pt(x0, y0)]]]}


def fake_features(type_name, fields, cql=None, bbox=None, sort=None):
    if type_name == "vmlite_locality_polygon":
        return [{"geometry": {"type": "Polygon", "coordinates": rect(-200, -200, 200, 200)["coordinates"][0]},
                 "properties": {"locality_name": "TESTVALE"}}]
    if type_name == "v_property_mp_address":
        return [
            {"geometry": rect(0, 0, 20, 40), "properties": {"prop_pfi": "1001", "add_house_number_1": 12, "add_road_name": "TEST",
                                                          "add_road_type": "STREET", "add_num_address": "12"}},
            {"geometry": rect(20, 0, 30, 25), "properties": {"prop_pfi": "1002", "add_blg_unit_id_1": 1, "add_house_number_1": 14,
                                                           "add_road_name": "TEST", "add_road_type": "STREET", "add_num_address": "1/14"}},
        ]
    if type_name == "el_contour_1to5m":
        return [{"geometry": {"type": "LineString", "coordinates": [pt(-100, y), pt(100, y)]},
                 "properties": {"ufi": 5000 + y, "altitude": 50 + y / 10}} for y in range(-30, 80, 10)]
    if type_name == "tr_road":
        return [{"geometry": {"type": "LineString", "coordinates": [pt(-100, -10), pt(100, -10)]},
                 "properties": {"ufi": 7001, "road_name": "TEST", "road_type": "STREET"}}]
    if type_name == "plan_zone":
        return [{"geometry": rect(-100, -100, 100, 100), "properties": {"ufi": 8001, "zone_code": "GRZ1"}}]
    raise AssertionError(type_name)


def test_a_suburb_is_analysed_and_read_with_the_preferences(client, people, monkeypatch):
    monkeypatch.setattr(blocks, "_features", fake_features)
    a = as_(people["a"])
    assert client.post("/api/blocks/suburbs", headers=a, json={"suburb": "Testvale"}).status_code == 201
    assert blocks.analyse_pending() == 1
    [s] = [x for x in client.get("/api/blocks/suburbs").json() if x["suburb"] == "TESTVALE"]
    assert s["status"] == "done" and s["blocks"] == 2, s

    with tx() as conn:
        house = conn.execute("SELECT * FROM block WHERE pfi = '1001'").fetchone()
    assert house["address"] == "12 Test Street" and not house["is_unit"]
    assert abs(house["area_m2"] - 800) <= 8
    assert abs(house["frontage_m"] - 20) <= 1.5 and abs(house["depth_m"] - 40) <= 1.5
    assert house["direction"] == "up" and abs(house["fall_m"] - 3.76) < 0.3 and abs(house["incline_pct"] - 10) < 1
    assert house["profile"][0] == 0 and house["profile"][-1] > 3.4
    assert blocks.facing(house["rear_bearing"]) == "north" and house["zone_code"] == "GRZ1"

    # Preferences: a 10% slope is too steep for 8%; at 12% it fits; the unit lot never does.
    client.put("/api/blocks/prefs", headers=a, json={"min_m2": 600, "max_m2": 1000, "max_incline": 8,
                                                     "directions": ["level", "up", "down", "across"]})
    one = client.get("/api/blocks/1001").json()
    assert one["fits"] is False and one["split_lots"] == 2 and one["rear_facing"] == "north"
    client.put("/api/blocks/prefs", headers=a, json={"min_m2": 600, "max_m2": 1000, "max_incline": 12, "directions": ["up"]})
    assert client.get("/api/blocks/1001").json()["fits"] is True
    assert client.get("/api/blocks/1002").json()["fits"] is False

    fc = client.get("/api/blocks/geojson?suburb=Testvale").json()
    assert {f["properties"]["pfi"] for f in fc["features"]} == {"1001", "1002"}
    areas = client.post("/api/blocks/areas", json={"min_m2": 600, "max_m2": 1000, "max_incline": 12, "directions": ["up"],
                                                   "include_units": True, "size": 400}).json()
    assert sum(h["properties"]["fit"] for h in areas["hexes"]["features"]) <= 1

    # A tracked house on the block gets its block, in the grid and on its page.
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "12", "street": "Test Street", "suburb": "Testvale", "postcode": "3999"}}).json()["id"]
    lon, lat = pt(10, 20)
    client.put(f"/api/properties/{pid}/location", headers=a, json={"lon": lon, "lat": lat})
    assert client.get(f"/api/properties/{pid}/block").json()["pfi"] == "1001"
    row = next(r for r in client.get("/api/overview", headers=a).json()["rows"] if r["id"] == pid)
    assert row["block_falls"] == "up" and row["block_fits"] is True and row["block_split"] == 2 and row["block_rear"] == "north"
    assert next(f for f in client.get("/api/blocks/geojson?suburb=Testvale").json()["features"]
                if f["properties"]["pfi"] == "1001")["properties"]["t"] == pid

    client.delete("/api/blocks/suburbs/Testvale", headers=a)
    assert client.get(f"/api/properties/{pid}/block").json() is None
    client.delete(f"/api/properties/{pid}", headers=a)


def test_an_unknown_suburb_is_reported(client, people, monkeypatch):
    monkeypatch.setattr(blocks, "_features", lambda *a, **k: [])
    client.post("/api/blocks/suburbs", headers=as_(people["a"]), json={"suburb": "Nowhere"})
    blocks.analyse_pending()
    [s] = [x for x in client.get("/api/blocks/suburbs").json() if x["suburb"] == "NOWHERE"]
    assert s["status"] == "error" and "no suburb called Nowhere" in s["error"]
    client.delete("/api/blocks/suburbs/Nowhere", headers=as_(people["a"]))
