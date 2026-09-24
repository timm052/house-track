"""The bookmarklet capture: a Domain-shaped page in, every field and extra out, then saved once."""

import json
from datetime import datetime, timedelta

from app.listing_capture import MELBOURNE, extract

from .conftest import as_

SOON = (datetime.now(MELBOURNE) + timedelta(days=3)).strftime("%Y-%m-%d")
IMG = "https://bucket-api.domain.com.au/v1/bucket/image/2029990001_{n}_1_260922_062323-w2048-h1365"
OTHER_IMG = "https://bucket-api.domain.com.au/v1/bucket/image/2017962540_1_1_260101_000000-w2048-h1365"

# Shaped like Domain's __NEXT_DATA__, trimmed, with made-up people and a similar listing that must be ignored.
NEXT_DATA = json.dumps({"props": {"pageProps": {"layoutProps": {
    "digitalData": {"page": {"pageInfo": {"property": {"bedrooms": 3, "primaryPropertyType": "House", "landSize": "650.0 sqm"}}}},
    "jsonLdItems": [{"@type": "Residence", "numberOfRooms": 9, "address": {"streetAddress": "1 Wrong Road"}}],
}, "componentProps": {
    "listingsMap": {"2017962540": {"listingModel": {"price": "$9,999,999", "features": {"beds": 9, "landSize": 9999},
                                                    "images": [OTHER_IMG]}}},
    "unitNumber": "", "streetNumber": "14", "street": "Example Street", "suburb": "Mitcham", "postcode": "3132",
    "propertyType": "House", "beds": 3, "headline": "Renovated family home, walk to the station",
    "description": ["Expressions of Interest Closing Tuesday, 20th October 5pm", "", "North-facing garden with a pool and a double garage."],
    "listingSummary": {"address": "14 Example Street, Mitcham VIC 3132", "baths": 2, "beds": 3, "parking": 2, "method": "privateTreaty",
                       "propertyType": "House", "stats": [{"key": "landArea", "value": 650}], "title": "EOI $1,050,000 - $1,150,000"},
    "agents": [{"name": "Pat Agent", "mobile": "0400 000 001", "phone": "03 9000 0000", "email": None},
               {"name": "Sam Seller", "mobile": "0400 000 002", "phone": "03 9000 0000", "email": None}],
    "agencyName": "Example Realty Mitcham",
    "inspection": {"inspectionTimes": [{"openingDateTime": f"{SOON}T10:00:00", "closingDateTime": f"{SOON}T10:30:00"},
                                       {"openingDateTime": "2020-01-01T10:00:00", "closingDateTime": "2020-01-01T10:30:00"}]},
    "gallery": {"slides": [{"images": {"original": {"url": IMG.format(n=2)}}}, {"images": {"original": {"url": IMG.format(n=1)}}}]},
    "map": {"latitude": -37.8166, "longitude": 145.1932},
    "priceGuide": {"agencyName": "Example Realty Mitcham",
                   "pdfLink": "https://p-soi.domainstatic.com.au/soi-2029990001-abc.pdf"},
    "rootGraphQuery": {"listingByIdV2": {"dateCreated": {"isoDate": "2026-09-10T09:00:00"}, "buildingArea": None,
                                         "auctionDetails": None}},
}}}})
URL = "https://www.domain.com.au/14-example-street-mitcham-vic-3132-2029990001"
HEAD = '<head><meta property="og:image" content="' + IMG.format(n=1) + '"></head>'


def test_extract_reads_the_whole_listing_and_ignores_the_others():
    got = extract(URL, HEAD, next_data=NEXT_DATA, known_tags=["family home"])
    assert got["address_parts"] == {"unit": None, "street_number": "14", "street": "Example Street", "suburb": "Mitcham", "postcode": "3132"}
    assert (got["beds"], got["baths"], got["car_spaces"], got["land_m2"]) == (3, 2, 2, 650)
    assert got["property_type"] == "house" and got["sale_method"] == "eoi"
    assert (got["guide_low_aud"], got["guide_high_aud"]) == (1_050_000, 1_150_000)
    assert got["eoi_closes_at"].endswith("+11:00") and "-10-20T17:00" in got["eoi_closes_at"]
    assert got["listed_on"] == "2026-09-10" and (got["lat"], got["lon"]) == (-37.8166, 145.1932)
    assert [a["name"] for a in got["agents"]] == ["Pat Agent", "Sam Seller"] and got["agents"][0]["agency_name"] == "Example Realty Mitcham"
    assert len(got["inspections"]) == 1 and got["inspections"][0]["starts_at"].startswith(SOON)  # past times dropped
    assert got["soi_url"].endswith("abc.pdf")
    assert got["photos"] == [IMG.format(n=1), IMG.format(n=2)] and OTHER_IMG not in got["photos"]  # in order, only this listing
    assert got["image_url"] == IMG.format(n=1)
    for tag in ("renovated", "north-facing", "pool", "garage", "garden", "walk to station", "family home"):
        assert tag in got["suggested_tags"], tag


def test_photos_follow_the_listing_gallery_and_floor_plans_are_kept_apart():
    """Domain's own gallery order (largeMedia), not photo-number order; resized URLs become the full-size original."""
    data = json.loads(NEXT_DATA)
    resized = "https://rimh2.domainstatic.com.au/abc=/fit-in/1920x1080/filters:format(jpeg)/2029990001_{n}_1_260922_062323-w2048-h1365"
    plan = "https://rimh2.domainstatic.com.au/xyz=/fit-in/1920x1080/2029990001_9_3_260922_062323-w1600-h1200"
    data["props"]["pageProps"]["componentProps"]["rootGraphQuery"]["listingByIdV2"]["largeMedia"] = [
        {"url": resized.format(n=4), "type": "photo"}, {"url": resized.format(n=1), "type": "photo"},
        {"url": plan, "type": "floorplan"}, {"url": "https://youtube.com/x", "type": "youtube"}]
    got = extract(URL, HEAD, next_data=json.dumps(data))
    assert got["photos"] == [IMG.format(n=4), IMG.format(n=1)]
    assert got["floorplans"] == ["https://bucket-api.domain.com.au/v1/bucket/image/2029990001_9_3_260922_062323-w1600-h1200"]
    assert got["image_url"] == IMG.format(n=4)  # the gallery's first photo is the cover


def test_auction_date_from_the_schedule():
    data = json.loads(NEXT_DATA)
    cp = data["props"]["pageProps"]["componentProps"]
    cp["listingSummary"].update(method="auction", title="Auction for Registered Bidders|$2.2m - $2.3m")
    cp["rootGraphQuery"]["listingByIdV2"]["auctionDetails"] = {"auctionSchedule": {"openingDateTime": {"isoDate": "2026-09-27T11:00:00"}}}
    got = extract(URL, "", next_data=json.dumps(data))
    assert got["sale_method"] == "auction" and got["auction_at"] == "2026-09-27T11:00:00+10:00"
    assert (got["guide_low_aud"], got["guide_high_aud"]) == (2_200_000, 2_300_000) and got["eoi_closes_at"] is None


def test_capture_then_save_then_capture_again(client, people, monkeypatch):
    from app.routes import driveway
    saved: list[str] = []
    monkeypatch.setattr(driveway, "save_photos_later", lambda pid, person, urls, plans=(): saved.extend(urls))
    monkeypatch.setattr("app.routes.properties.save_photos_later", lambda pid, person, urls, plans=(): saved.extend(urls))
    a = as_(people["a"])
    got = client.post("/api/listing/parse", headers=a, json={"url": URL, "html": HEAD, "next_data": NEXT_DATA}).json()
    assert got["existing_property_id"] is None and got["agents"]

    extras = {"lat": got["lat"], "lon": got["lon"], "agents": got["agents"], "inspections": got["inspections"],
              "soi_url": got["soi_url"], "tags": ["pool", "renovated"], "photos": got["photos"][:1]}
    pid = client.post("/api/properties", headers=a, json={
        "address": got["address_parts"], "beds": got["beds"], "baths": got["baths"], "car_spaces": got["car_spaces"],
        "land_m2": got["land_m2"], "campaign": {"sale_method": "eoi", "eoi_closes_at": got["eoi_closes_at"], "url": URL,
                                                "listed_on": got["listed_on"], "guide_low_aud": got["guide_low_aud"],
                                                "guide_high_aud": got["guide_high_aud"]},
        "listing": extras}).json()["id"]
    p = client.get(f"/api/properties/{pid}").json()
    assert p["lat"] == -37.8166 and p["geocode_source"] == "listing"
    assert [ag["name"] for ag in p["campaigns"][0]["agents"]] == ["Pat Agent", "Sam Seller"]
    assert len(p["inspections"]) == 1 and sorted(p["tags"]) == ["pool", "renovated"]
    assert [x["kind"] for x in p["attachments"]] == ["price_statement"] and saved == got["photos"][:1]

    # Captured again a week later: already tracked; the new guide is recorded once, nothing else doubles up.
    again = client.post("/api/listing/parse", headers=a, json={"url": URL + "?utm=x", "html": HEAD, "next_data": NEXT_DATA}).json()
    assert again["existing_property_id"] == pid
    update = {**extras, "guide_low_aud": 1_100_000, "guide_high_aud": 1_200_000}
    first = client.post(f"/api/properties/{pid}/listing-update", headers=a, json=update).json()
    second = client.post(f"/api/properties/{pid}/listing-update", headers=a, json=update).json()
    assert first["guide"] is True and first["agents"] == 0 and first["inspections"] == 0 and first["soi"] == 0
    assert second["guide"] is False
    guides = client.get(f"/api/properties/{pid}").json()["campaigns"][0]["price_guides"]
    assert (guides[0]["low_aud"], guides[0]["high_aud"]) == (1_100_000, 1_200_000) and len(guides) == 2  # newest first


def test_weekly_refresh_targets_and_updates(client, people, monkeypatch):
    monkeypatch.setattr("app.routes.properties.save_photos_later", lambda pid, person, urls, plans=(): None)
    fetched: list[str] = []
    monkeypatch.setattr("app.routes.driveway.save_photos_later", lambda pid, person, urls, plans=(): fetched.extend(urls))
    a = as_(people["a"])
    url = "https://www.domain.com.au/9-refresh-road-mitcham-vic-3132-2029990009"
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "9", "street": "Refresh Road", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "eoi", "url": url, "guide_low_aud": 1_050_000, "guide_high_aud": 1_150_000}}).json()["id"]
    targets = client.get("/api/listing/targets").json()
    mine = [t for t in targets if t["id"] == pid]
    assert mine and mine[0]["url"] == url and mine[0]["address"].startswith("9 Refresh Road") and mine[0]["last_checked_at"] is None

    data = json.loads(NEXT_DATA)
    data["props"]["pageProps"]["componentProps"]["listingSummary"].update(title="EOI $1,100,000 - $1,155,000", status="underOffer")
    mine_img = "https://bucket-api.domain.com.au/v1/bucket/image/2029990009_{n}_1_260922_062323-w2048-h1365"
    data["props"]["pageProps"]["componentProps"]["rootGraphQuery"]["listingByIdV2"]["largeMedia"] = [
        {"url": mine_img.format(n=2), "type": "photo"}, {"url": mine_img.format(n=1), "type": "photo"}]
    r = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                              "next_data": json.dumps(data)}).json()
    assert any(ch.startswith("New price guide $1.1m–$1.155m (was ") for ch in r["changes"])
    # What we had nothing for is filled in (rooms, land, photos); nothing we had is overwritten.
    assert "Bedrooms: 3" in r["changes"] and "Land: 650 m²" in r["changes"] and "2 photos from the listing" in r["changes"]
    assert fetched == [mine_img.format(n=2), mine_img.format(n=1)]  # in the listing's order
    assert any(ch.startswith("1 new inspection time: ") for ch in r["changes"])
    assert "Agents: Pat Agent, Sam Seller" in r["changes"] and r["flag"].startswith("Under offer")
    again = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                                  "next_data": json.dumps(data)}).json()
    assert again["changes"] == ["2 photos from the listing"]  # nothing else new (the stub above never saves the photos)
    assert [t for t in client.get("/api/listing/targets").json() if t["id"] == pid][0]["last_checked_at"] is not None
    gone = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 404}).json()
    assert gone["flag"] == "The listing has been taken down."


def test_update_switches_sale_method(client, people):
    """A house saved as an auction whose listing is an EOI: the update switches it rather than failing."""
    a = as_(people["a"])
    url = "https://www.domain.com.au/7-switch-street-woodend-vic-3442-2029990007"
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "7", "street": "Switch Street", "suburb": "Woodend", "postcode": "3442"},
        "campaign": {"sale_method": "auction", "auction_at": "2026-10-10T11:00:00+11:00", "url": url}}).json()["id"]
    r = client.post(f"/api/properties/{pid}/listing-update", headers=a,
                    json={"sale_method": "eoi", "eoi_closes_at": "2026-10-20T17:00:00+11:00"})
    assert r.status_code == 200, r.text
    assert r.json()["method"] == "eoi" and r.json()["date"] is True
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["sale_method"] == "eoi" and c["auction_at"] is None and c["eoi_closes_at"].startswith("2026-10-20")
    # The weekly refresh does the same, and says so.
    data = json.loads(NEXT_DATA)
    data["props"]["pageProps"]["componentProps"]["listingSummary"].update(method="auction", title="Auction $900k - $990k")
    data["props"]["pageProps"]["componentProps"]["rootGraphQuery"]["listingByIdV2"]["auctionDetails"] = {
        "auctionSchedule": {"openingDateTime": {"isoDate": "2026-11-07T11:00:00"}}}
    got = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                                "next_data": json.dumps(data)}).json()
    assert "Now selling by auction" in got["changes"] and "Auction Sat 7 Nov, 11:00 am" in got["changes"]
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["sale_method"] == "auction" and c["eoi_closes_at"] is None and c["auction_at"].startswith("2026-11-07")


def test_land_is_read_in_square_metres():
    """Acreage: Domain's landSize is text in the agent's unit ("2.69 acre"); the numeric landArea is m²."""
    from app.listing_capture import _area_m2
    woodend = {"props": {"pageProps": {"layoutProps": {"digitalData": {
        "page": {"pageInfo": {"property": {"landArea": 10886.0437698}}},
        "pageFromGraph": {"pageInfo": {"property": {"landSize": "2.69 acre", "landArea": 10886.0437698}}}}}}}}
    assert extract(URL, "", next_data=json.dumps(woodend))["land_m2"] == 10886
    only_text = {"props": {"pageProps": {"layoutProps": {"digitalData": {"page": {"pageInfo": {"property": {"landSize": "2.69 acre"}}}}}}}}
    assert extract(URL, "", next_data=json.dumps(only_text))["land_m2"] == 10886
    assert [_area_m2(v) for v in (652, "652m²", "650.0 sqm", "1.2 ha", "2.69 acre", "1,012 m2", "about 4", None)] == \
        [652, 652, 650, 12000, 10886, 1012, None, None]



def test_update_preview_and_details(client, people):
    """The + House Track panel previews exactly what Update will do (nothing saved); Update then fixes rooms and
    land; the weekly refresh reports a differing land size instead of overwriting it."""
    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "7", "street": "Preview Lane", "suburb": "Woodend", "postcode": "3442"}, "land_m2": 4,
        "campaign": {"sale_method": "eoi", "eoi_closes_at": "2099-10-20T17:00:00+11:00",
                     "url": "https://www.domain.com.au/7-preview-lane-woodend-vic-3442-2099990077"}}).json()["id"]
    body = {"land_m2": 10886, "beds": 4, "guide_low_aud": 2500000, "guide_high_aud": 2750000}
    r = client.post(f"/api/properties/{pid}/listing-update?preview=true", headers=as_(a), json=body).json()
    assert "Land: 1.09 ha (was 4 m²)" in r["changes"] and "Bedrooms: 4" in r["changes"]
    assert any(ch.startswith("New price guide $2.5m–$2.75m") for ch in r["changes"])
    p = client.get(f"/api/properties/{pid}").json()
    assert p["land_m2"] == 4 and p["campaigns"][0]["price_guides"] == []  # nothing saved by the preview

    assert client.post(f"/api/properties/{pid}/listing-update", headers=as_(a), json=body).json()["changes"] == r["changes"]
    assert client.get(f"/api/properties/{pid}").json()["land_m2"] == 10886

    from app.listing_apply import refresh
    from app.db import tx
    from app.schemas import ListingUpdateIn
    with tx() as conn:
        got = refresh(conn, pid, ListingUpdateIn(land_m2=900, apply_details=False))
    assert got["differs"] == ["The listing says land 900 m²; you have 1.09 ha"] and got["changes"] == []
    assert client.get(f"/api/properties/{pid}").json()["land_m2"] == 10886


def test_sold_listing_asks_for_the_outcome(client, people):
    """A sold listing's price is the sale price, never a new guide; the campaign remembers the listing said sold,
    and the house is flagged as needing its outcome recorded."""
    sold = {"props": {"pageProps": {"componentProps": {"listingSummary": {
        "stats": [], "status": "sold", "title": "Sold for $1,250,000"}}}}}
    got = extract(URL, "", next_data=json.dumps(sold))
    assert got["listing_status"] == "sold" and got["sold_price_aud"] == 1_250_000 and "guide_low_aud" not in got

    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "8", "street": "Sold Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    row = lambda: next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert row()["needs_outcome"] is False
    r = client.post(f"/api/properties/{pid}/listing-update", headers=as_(a),
                    json={"listing_status": "sold", "listing_price_text": "Sold for $1,250,000"})
    assert r.status_code == 200 and r.json()["guide"] is False
    got = row()
    assert got["needs_outcome"] is True and got["listing_status"] == "sold" and got["listing_price_text"] == "Sold for $1,250,000"
