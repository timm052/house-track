import io
import uuid

from PIL import Image

from .conftest import as_


def house(client, person, n, auction="2099-10-17T11:00:00+11:00"):
    r = client.post("/api/properties", headers=as_(person), json={
        "address": {"street_number": str(n), "street": "Drive Way", "suburb": "Blackburn", "postcode": "3130"},
        "campaign": {"sale_method": "auction", "auction_at": auction}})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_inspections_attendees_and_single_event_ics(client, people):
    a, b = people["a"], people["b"]
    pid = house(client, a, 1)
    iid = client.post(f"/api/properties/{pid}/inspections", headers=as_(a),
                      json={"kind": "open", "starts_at": "2099-10-11T10:00:00+11:00"}).json()["id"]
    client.put(f"/api/inspections/{iid}/attendees/{b['id']}", headers=as_(a), json={"note": "Damp in the laundry"})
    [insp] = client.get(f"/api/properties/{pid}").json()["inspections"]
    assert insp["state"] == "attended" and insp["attendees"] == [{"person_id": b["id"], "note": "Damp in the laundry"}]
    assert insp["ends_at"].startswith("2099-10-10T23:30")  # 30 minutes by default (stored in UTC)

    assert client.get("/api/calendar.ics").text.startswith("BEGIN:VCALENDAR")
    one = client.get(f"/api/events/inspection/{iid}.ics")
    assert one.status_code == 200
    assert "SUMMARY:Open for inspection: 1 Drive Way\\, Blackburn 3130" in one.text
    assert "DTSTART:20991010T230000Z" in one.text


def test_upcoming_events_include_auctions_and_feed(client, people):
    pid = house(client, people["a"], 2, auction="2026-12-31T11:00:00+11:00")
    events = client.get("/api/inspections", params={"days": 400}).json()
    assert any(e["property_id"] == pid and e["type"] == "auction" for e in events)


def jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (1200, 900), (180, 120, 60)).save(buf, "JPEG")
    return buf.getvalue()


def test_photo_upload_thumbnail_and_dedup(client, people, tmp_path, monkeypatch):
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))
    a = people["a"]
    pid = house(client, a, 3)
    data = jpeg()
    r1 = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                     files={"file": ("kitchen.jpg", data, "image/jpeg")}, data={"kind": "photo", "caption": "Kitchen"})
    r2 = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                     files={"file": ("again.jpg", data, "image/jpeg")}, data={"kind": "photo"})
    assert r1.status_code == 201 and r2.status_code == 201, r1.text
    atts = client.get(f"/api/properties/{pid}").json()["attachments"]
    assert len(atts) == 2 and atts[0]["sha256"] == atts[1]["sha256"]
    assert len([p for p in tmp_path.rglob(atts[0]["sha256"]) if p.is_file()]) == 1  # stored once
    thumb = client.get(f"/api/attachments/{atts[0]['id']}/thumb")
    assert thumb.status_code == 200 and max(Image.open(io.BytesIO(thumb.content)).size) <= 480
    assert client.get(f"/api/attachments/{atts[0]['id']}/file").content == data
    assert (atts[0]["width"], atts[0]["height"]) == (1200, 900)  # for the photo viewer, before it loads
    # A portrait phone photo is stored sideways with an EXIF tag to turn it: its size is as it's shown, upright.
    buf, exif = io.BytesIO(), Image.Exif()
    exif[0x0112] = 6
    Image.new("RGB", (1200, 900), (60, 120, 180)).save(buf, "JPEG", exif=exif)
    client.post(f"/api/properties/{pid}/attachments", headers=as_(a), files={"file": ("tall.jpg", buf.getvalue(), "image/jpeg")},
                data={"kind": "photo"})
    tall = next(x for x in client.get(f"/api/properties/{pid}").json()["attachments"] if x["original_name"] == "tall.jpg")
    assert (tall["width"], tall["height"]) == (900, 1200)

    # A vendor statement link works without a file; nothing at all is refused.
    r = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                    data={"kind": "vendor_statement", "url": "https://docs.example/s32.pdf"})
    assert r.status_code == 201
    assert client.post(f"/api/properties/{pid}/attachments", headers=as_(a), data={"kind": "photo"}).status_code == 422


def test_offline_verdict_conflict_check(client, people):
    a, b = people["a"], people["b"]
    pid = house(client, a, 4)
    # A's phone saw no verdict; meanwhile B entered one on A's behalf.
    client.post(f"/api/properties/{pid}/opinions", headers=as_(b),
                json={"person_id": a["id"], "stage": "post_inspection", "stance": "no"})
    queued = {"id": str(uuid.uuid4()), "stage": "post_inspection", "stance": "yes", "check_latest": True}
    r = client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json=queued)
    assert r.status_code == 409 and r.json()["detail"]["current"] == "no"
    # Keep mine: resend without the check. Replaying the same queued item later is not a conflict.
    assert client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json=queued | {"check_latest": False}).status_code == 201
    assert client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json=queued).status_code == 201
    current = [o for o in client.get(f"/api/properties/{pid}").json()["opinions"] if o["person_id"] == a["id"]]
    assert current[0]["stance"] == "yes" and len(current) == 2


def test_overview_rows_carry_coordinates(client, people):
    pid = house(client, people["a"], 5)
    client.put(f"/api/properties/{pid}/location", headers=as_(people["a"]), json={"lon": 145.15, "lat": -37.82})
    row = next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert (row["lon"], row["lat"]) == (145.15, -37.82)


def test_listing_photo_saved_once(client, people, tmp_path, monkeypatch):
    from app.routes import driveway
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))
    data = jpeg()
    monkeypatch.setattr(driveway, "download_image", lambda url: (data, "image/jpeg"))
    a = people["a"]
    pid = house(client, a, 7)
    body = {"url": "https://rimh2.domainstatic.com.au/abc/lead.jpg"}
    r1 = client.post(f"/api/properties/{pid}/attachments/from-url", headers=as_(a), json=body)
    r2 = client.post(f"/api/properties/{pid}/attachments/from-url", headers=as_(a), json=body)
    assert r1.status_code == 201 and r2.json()["existing"] is True, r1.text
    [photo] = client.get(f"/api/properties/{pid}").json()["attachments"]
    assert photo["kind"] == "photo" and photo["caption"] == "From the listing" and photo["original_name"] == "lead.jpg"
    assert client.get(f"/api/attachments/{photo['id']}/thumb").status_code == 200
    # No listing link: a clear message rather than a failed fetch.
    assert client.post(f"/api/properties/{pid}/listing-photo", headers=as_(a)).status_code == 422


def test_cover_photo(client, people, tmp_path, monkeypatch):
    """The listing's main photo (saved first) is the cover until someone picks another; removing it falls back."""
    from app.routes import driveway
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))

    def image(shade: int) -> bytes:
        buf = io.BytesIO()
        Image.new("RGB", (64, 48), (shade, 90, 40)).save(buf, "JPEG")
        return buf.getvalue()
    shades = iter([10, 60, 110])
    monkeypatch.setattr(driveway, "download_image", lambda url: (image(next(shades)), "image/jpeg"))
    a = people["a"]
    pid = house(client, a, 12)
    ids = [client.post(f"/api/properties/{pid}/attachments/from-url", headers=as_(a),
                       json={"url": f"https://rimh2.domainstatic.com.au/abc/{n}.jpg"}).json()["id"] for n in ("main", "kitchen", "yard")]
    own = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                      files={"file": ("mine.jpg", image(200), "image/jpeg")}, data={"kind": "photo"}).json()["id"]

    def cover():
        detail = client.get(f"/api/properties/{pid}").json()["cover_id"]
        row = next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)["cover_id"]
        assert str(detail) == str(row)
        return str(detail)
    assert cover() == str(ids[0])  # the listing's main photo, not the newest

    r = client.put(f"/api/properties/{pid}/cover", headers=as_(a), json={"attachment_id": own})
    assert r.status_code == 200 and str(r.json()["cover_id"]) == str(own)
    assert cover() == str(own)

    other = house(client, a, 13)
    assert client.put(f"/api/properties/{other}/cover", headers=as_(a), json={"attachment_id": own}).status_code == 422

    client.delete(f"/api/attachments/{own}", headers=as_(a))
    assert cover() == str(ids[0])
    client.put(f"/api/properties/{pid}/cover", headers=as_(a), json={"attachment_id": None})
    assert cover() == str(ids[0])


def test_inspection_logged_offline_is_created_once(client, people):
    """The Drive page queues "log an inspection now" with an id made on the phone; a resend changes nothing."""
    a = people["a"]
    pid = house(client, a, 14)
    iid = str(uuid.uuid4())
    body = {"id": iid, "kind": "private", "starts_at": "2026-09-24T10:00:00+10:00", "state": "attended"}
    for _ in range(2):
        r = client.post(f"/api/properties/{pid}/inspections", headers=as_(a), json=body)
        assert r.status_code == 201 and str(r.json()["id"]) == iid
    assert client.put(f"/api/inspections/{iid}/attendees/{a['id']}", headers=as_(a), json={"note": None}).status_code in (200, 201, 204)
    [i] = client.get(f"/api/properties/{pid}").json()["inspections"]
    assert i["id"] == iid and [x["person_id"] for x in i["attendees"]] == [a["id"]]


def test_keep_a_copy_of_a_linked_document(client, people, tmp_path, monkeypatch):
    """A linked PDF (the listing's Statement of Information, say) is downloaded once and then served from House Track."""
    from app.routes import driveway
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))
    pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
    monkeypatch.setattr(driveway, "download_file", lambda url, *a, **k: (pdf, "application/pdf"))
    a = people["a"]
    pid = house(client, a, 15)
    r = client.post(f"/api/properties/{pid}/attachments", headers=as_(a), data={"kind": "other", "url": "https://docs.example/soi.pdf"})
    aid = r.json()["id"]
    r = client.post(f"/api/attachments/{aid}/keep-copy", headers=as_(a))
    assert r.status_code == 200 and r.json()["mime_type"] == "application/pdf", r.text
    f = client.get(f"/api/attachments/{aid}/file")
    assert f.status_code == 200 and f.content == pdf and f.headers["content-type"] == "application/pdf"
    [att] = client.get(f"/api/properties/{pid}").json()["attachments"]
    assert att["url"] is None and att["original_name"] == "soi.pdf"
    assert client.post(f"/api/attachments/{aid}/keep-copy", headers=as_(a)).status_code == 422


def test_finished_houses_leave_the_calendar(client, people):
    """Ruled out: its inspections and auction drop off the calendar, and come back if it's back in play."""
    from datetime import datetime, timedelta, timezone
    a = as_(people["a"])
    soon = (datetime.now(timezone.utc) + timedelta(days=2)).replace(microsecond=0)
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "8", "street": "Finished Way", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "auction", "auction_at": (soon + timedelta(days=1)).isoformat()}}).json()["id"]
    client.post(f"/api/properties/{pid}/inspections", headers=a, json={"starts_at": soon.isoformat()})
    mine = lambda: sorted(e["type"] for e in client.get("/api/inspections?days=10").json() if e["property_id"] == pid)
    assert mine() == ["auction", "inspection"]
    client.post(f"/api/properties/{pid}/status", headers=a, json={"status": "ruled_out"})
    assert mine() == []
    client.post(f"/api/properties/{pid}/status", headers=a, json={"status": "interested"})
    assert mine() == ["auction", "inspection"]
