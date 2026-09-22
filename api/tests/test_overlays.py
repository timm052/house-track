import json
import zipfile

from app import worker
from app.db import tx
from app.setup import overlays

from .conftest import as_

BOX = (144.0, -39.0, 146.5, -37.0)


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


class FakeService:
    """Stands in for Victoria's WFS: a flood overlay and a heritage overlay near (145.2, -37.8)."""

    def __init__(self):
        self.calls = 0

    def __call__(self, lon, lat, pause=0):
        self.calls += 1
        near = abs(lon - 145.2) < 0.01 and abs(lat + 37.8) < 0.01
        return {layer.code: [] for layer in overlays.VIC_STREAMED} | ({
            "vic_flood": [{"label": "Land Subject to Inundation Overlay", "attrs": {"scheme_code": "LSIO"}}],
            "vic_heritage": [{"label": "Heritage Overlay (HO35)", "attrs": {"scheme_code": "HO"}}],
        } if near else {})


def test_labels_are_readable():
    assert overlays.nice_label("LAND SUBJECT TO INUNDATION OVERLAY") == "Land Subject to Inundation Overlay"
    assert overlays.nice_label("HERITAGE OVERLAY (HO35)") == "Heritage Overlay (HO35)"
    assert overlays.nice_label("NEIGHBOURHOOD RESIDENTIAL ZONE - SCHEDULE 5") == "Neighbourhood Residential Zone - Schedule 5"


def test_streamed_layers_have_wms_tiles():
    url = overlays.STREAMED["vic_heritage"].wms_tiles()
    assert "request=GetMap" in url and "{bbox-epsg-3857}" in url and "CQL_FILTER=scheme_code%20%3D%20%27HO%27" in url


def test_school_zones_local_and_planning_looked_up_once(client, people, database_url, tmp_path, monkeypatch):
    fake = FakeService()
    monkeypatch.setattr(overlays, "lookup_all", fake)
    overlays.load_schools(database_url, BOX, tmp_path, school_zip(tmp_path))
    with tx() as conn:
        overlays.ensure_streamed_layers(conn)
    layers = {layer["code"]: layer for layer in client.get("/api/overlays").json()}
    assert layers["vic_school_primary"]["pieces"] == 1 and layers["vic_school_primary"]["tiles"] is None
    assert layers["vic_flood"]["tiles"].startswith("https://") and layers["vic_flood"]["pieces"] == 0

    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "1", "street": "Overlay Rd", "suburb": "Box Hill North", "postcode": "3129"}}).json()["id"]
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.2004, "lat": -37.8004})
    while worker.lookup_overlays():
        pass
    detail = client.get(f"/api/properties/{pid}").json()
    labels = {o["code"]: o["label"] for o in detail["overlays"]}
    assert labels["vic_school_primary"] == "Box Hill North Primary School"
    assert labels["vic_flood"] == "Land Subject to Inundation Overlay" and labels["vic_heritage"] == "Heritage Overlay (HO35)"
    row = next(x for x in client.get("/api/overview", headers=as_(a)).json()["rows"] if x["id"] == pid)
    assert row["school_secondary"] == "Box Hill High School" and "Heritage Overlay (HO35)" in row["planning"]
    assert row["warned"] is True  # flood warns by default, for everyone

    # Saved: no second lookup until the pin moves.
    calls = fake.calls
    assert worker.lookup_overlays() == 0 and fake.calls == calls
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.30, "lat": -37.85})
    while worker.lookup_overlays():
        pass
    labels = {o["code"] for o in client.get(f"/api/properties/{pid}").json()["overlays"]}
    assert "vic_flood" not in labels and fake.calls > calls

    # The household can turn a warning layer into a hard exclusion.
    client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": 145.2004, "lat": -37.8004})
    while worker.lookup_overlays():
        pass
    assert client.patch("/api/overlays/vic_flood", headers=as_(a), json={"effect": "hard_exclude"}).status_code == 200
    assert next(x for x in client.get("/api/overview", headers=as_(people["b"])).json()["rows"] if x["id"] == pid)["excluded"]
    client.patch("/api/overlays/vic_flood", headers=as_(a), json={"effect": "soft_warn"})
