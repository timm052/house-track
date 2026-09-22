import json
import zipfile

from app.setup import overlays

from .conftest import as_

BOX = (145.0, -37.9, 145.3, -37.7)


def square(lon, lat, d=0.01):
    return {"type": "Polygon", "coordinates": [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d],
                                                [lon - d, lat + d], [lon - d, lat - d]]]}


def school_zip(tmp_path):
    path = tmp_path / "zones.zip"
    primary = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"School_Name": "Box Hill North Primary School"}, "geometry": square(145.20, -37.80)}]}
    year7 = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"School_Name": "Box Hill High School"}, "geometry": square(145.20, -37.80, 0.05)}]}
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Primary_Integrated_2026.geojson", json.dumps(primary))
        zf.writestr("Secondary_Integrated_Year7_2026.geojson", json.dumps(year7))
        zf.writestr("Secondary_Integrated_Year8_2026.geojson", json.dumps(year7))  # not imported
    return path


def fake_wfs(layer, bbox):
    if layer.code == "vic_flood":
        return [
            {"type": "Feature", "properties": {"zone_description": "LAND SUBJECT TO INUNDATION OVERLAY", "zone_code": "LSIO"},
             "geometry": {"type": "MultiPolygon", "coordinates": [square(145.2005, -37.8005, 0.002)["coordinates"]]}},
            # Crosses the edge of the search area: only the part inside is kept.
            {"type": "Feature", "properties": {"zone_description": "LAND SUBJECT TO INUNDATION OVERLAY"},
             "geometry": square(144.99, -37.75, 0.02)},
        ]
    if layer.code == "vic_heritage":
        return [{"type": "Feature", "properties": {"zone_description": "HERITAGE OVERLAY (HO35)"}, "geometry": square(145.2, -37.8, 0.003)}]
    return []


def test_labels_are_readable():
    assert overlays.nice_label("LAND SUBJECT TO INUNDATION OVERLAY") == "Land Subject to Inundation Overlay"
    assert overlays.nice_label("HERITAGE OVERLAY (HO35)") == "Heritage Overlay (HO35)"
    assert overlays.nice_label("NEIGHBOURHOOD RESIDENTIAL ZONE - SCHEDULE 5") == "Neighbourhood Residential Zone - Schedule 5"


def test_overlays_load_clip_and_flag(client, people, database_url, tmp_path, monkeypatch):
    monkeypatch.setattr(overlays, "wfs_features", fake_wfs)
    overlays.load(database_url, BOX, tmp_path, school_zip(tmp_path))
    layers = {layer["code"]: layer for layer in client.get("/api/overlays").json()}
    assert layers["vic_school_primary"]["pieces"] == 1 and len([c for c in layers if "school" in c]) == 2
    assert layers["vic_flood"]["pieces"] == 2  # the edge-crossing polygon is clipped, not dropped

    a = people["a"]
    r = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "1", "street": "Overlay Rd", "suburb": "Box Hill North", "postcode": "3129"}})
    pid = r.json()["id"]
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.2004, "lat": -37.8004})
    detail = client.get(f"/api/properties/{pid}").json()
    labels = {o["code"]: o["label"] for o in detail["overlays"]}
    assert labels["vic_school_primary"] == "Box Hill North Primary School"
    assert labels["vic_flood"] == "Land Subject to Inundation Overlay"
    assert labels["vic_heritage"] == "Heritage Overlay (HO35)"
    row = next(x for x in client.get("/api/overview", headers=as_(a)).json()["rows"] if x["id"] == pid)
    assert row["school_secondary"] == "Box Hill High School" and "Heritage Overlay (HO35)" in row["planning"]
    assert row["warned"] is True  # flood overlays warn by default, for everyone

    # Make floods a hard exclusion for the household.
    assert client.patch("/api/overlays/vic_flood", headers=as_(a), json={"effect": "hard_exclude"}).status_code == 200
    assert next(x for x in client.get("/api/overview", headers=as_(people["b"])).json()["rows"] if x["id"] == pid)["excluded"]
    client.patch("/api/overlays/vic_flood", headers=as_(a), json={"effect": "soft_warn"})

    fc = client.get("/api/overlays/vic_heritage/features", params={"bbox": "145.19,-37.81,145.21,-37.79", "zoom": 15}).json()
    assert fc["features"][0]["properties"]["label"] == "Heritage Overlay (HO35)"

    # Re-running replaces a layer rather than duplicating it.
    overlays.load(database_url, BOX, tmp_path, school_zip(tmp_path))
    assert {layer["code"]: layer for layer in client.get("/api/overlays").json()}["vic_heritage"]["pieces"] == 1
