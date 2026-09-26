"""Floor plan markups: named versions shared by the household, and a save that doesn't overwrite a newer one."""

import io

from PIL import Image

from .conftest import as_


def plan(client, person, tmp_path, monkeypatch, number="3"):
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))
    pid = client.post("/api/properties", headers=as_(person), json={
        "address": {"street_number": number, "street": "Plan Street", "suburb": "Mitcham", "postcode": "3132"}}).json()["id"]
    png = io.BytesIO()
    Image.new("RGB", (800, 600), "white").save(png, "PNG")
    r = client.post(f"/api/properties/{pid}/attachments", headers=as_(person),
                    files={"file": ("plan.png", png.getvalue(), "image/png")}, data={"kind": "floorplan"})
    return pid, r.json()["id"]


def test_versions_are_shared_and_saves_dont_overwrite(client, people, tmp_path, monkeypatch):
    a, b = people["a"], people["b"]
    pid, att = plan(client, a, tmp_path, monkeypatch)
    wall = {"id": "s1", "type": "line", "points": [[10, 10], [410, 10]]}
    first = client.post(f"/api/attachments/{att}/markups", headers=as_(a),
                        json={"name": "As listed", "px_per_m": 100, "shapes": [wall]})
    assert first.status_code == 201, first.text
    v1 = first.json()
    assert v1["created_by"] == a["id"] and v1["shapes"] == [wall]
    # Everyone sees it, and the house's file list counts it.
    assert [m["name"] for m in client.get(f"/api/attachments/{att}/markups", headers=as_(b)).json()] == ["As listed"]
    assert next(x for x in client.get(f"/api/properties/{pid}").json()["attachments"] if x["id"] == att)["markups"] == 1

    bed = {"id": "f1", "type": "furniture", "item": "queen", "x": 200, "y": 200, "w": 1.53, "h": 2.03, "rotation": 90}
    saved = client.put(f"/api/markups/{v1['id']}", headers=as_(b), json={
        "name": "As listed", "px_per_m": 100, "shapes": [wall, bed], "expected_updated_at": v1["updated_at"]})
    assert saved.status_code == 200 and saved.json()["updated_by"] == b["id"]
    # Saving over it with the old copy is refused, naming who saved in between.
    stale = client.put(f"/api/markups/{v1['id']}", headers=as_(a), json={
        "name": "As listed", "px_per_m": 100, "shapes": [wall], "expected_updated_at": v1["updated_at"]})
    assert stale.status_code == 409 and people["b"]["display_name"] in stale.json()["detail"]

    v2 = client.post(f"/api/attachments/{att}/markups", headers=as_(a), json={"name": "Our layout", "shapes": []}).json()
    assert [m["name"] for m in client.get(f"/api/attachments/{att}/markups").json()] == ["As listed", "Our layout"]
    assert client.delete(f"/api/markups/{v2['id']}", headers=as_(a)).status_code == 204
    assert len(client.get(f"/api/attachments/{att}/markups").json()) == 1


def test_only_images_and_pdfs(client, people, tmp_path, monkeypatch):
    a = people["a"]
    pid, _ = plan(client, a, tmp_path, monkeypatch, number="4")
    doc = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                      files={"file": ("notes.txt", b"hello", "text/plain")}, data={"kind": "other"}).json()["id"]
    assert client.post(f"/api/attachments/{doc}/markups", headers=as_(a), json={"name": "x"}).status_code == 422
