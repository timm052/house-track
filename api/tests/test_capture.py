"""The bookmarklet capture: a Domain-shaped page in, every field and extra out, then saved once."""

import json
from datetime import datetime, timedelta

from app.listing_capture import MELBOURNE, SCRIPT_BREAK, extract

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
    # Under offer is news, not a job: it's said once, and the house shows in Under offer.
    assert "Agents: Pat Agent, Sam Seller" in r["changes"] and "Now under offer" in r["changes"] and r["flag"] is None
    assert "Listed 10 Sep 2026" in r["changes"]  # added from a link with no date: now days listed can be counted
    assert client.get(f"/api/properties/{pid}").json()["campaigns"][0]["listed_on"] == "2026-09-10"
    again = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                                  "next_data": json.dumps(data)}).json()
    assert again["changes"] == ["2 photos from the listing"]  # nothing else new (the stub above never saves the photos)
    assert [t for t in client.get("/api/listing/targets").json() if t["id"] == pid][0]["last_checked_at"] is not None
    gone = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 404}).json()
    assert gone["flag"] == "The listing has been taken down."


def test_ruled_out_houses_are_refreshed_for_prices_only(client, people, monkeypatch):
    """A ruled-out house still on the market stays in the weekly refresh, after the others: its price guide and sale
    are kept up to date, but not its inspections, agents, rooms or photos."""
    fetched: list[str] = []
    monkeypatch.setattr("app.routes.driveway.save_photos_later", lambda pid, person, urls, plans=(): fetched.extend(urls))
    a = as_(people["a"])
    url = "https://www.domain.com.au/4-gone-grove-mitcham-vic-3132-2029990044"
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "4", "street": "Gone Grove", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "eoi", "url": url, "guide_low_aud": 1_050_000, "guide_high_aud": 1_150_000}}).json()["id"]
    active = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "6", "street": "Gone Grove", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "eoi", "url": url.replace("4-gone", "6-gone").replace("44", "46")}}).json()["id"]
    assert client.post(f"/api/properties/{pid}/status", headers=a, json={"status": "ruled_out"}).status_code == 201
    targets = client.get("/api/listing/targets").json()
    ids = [t["id"] for t in targets]
    assert pid in ids and ids.index(active) < ids.index(pid)
    assert next(t for t in targets if t["id"] == pid)["prices_only"] is True
    assert next(t for t in targets if t["id"] == active)["prices_only"] is False

    data = json.loads(NEXT_DATA)
    data["props"]["pageProps"]["componentProps"]["listingSummary"].update(title="EOI $1,100,000 - $1,155,000")
    r = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                              "next_data": json.dumps(data)}).json()
    assert r["prices_only"] is True
    assert any(ch.startswith("New price guide $1.1m–$1.155m (was ") for ch in r["changes"])
    assert not any(ch.startswith(("1 new inspection", "Agents:", "Bedrooms", "Land")) or "photo" in ch for ch in r["changes"])
    assert r["differs"] == [] and fetched == []
    p = client.get(f"/api/properties/{pid}").json()
    assert p["inspections"] == [] and p["campaigns"][0]["agents"] == [] and p["beds"] is None
    # When it sells, the price is recorded, and it leaves the refresh once the price is known.
    data["props"]["pageProps"]["componentProps"]["listingSummary"].update(status="sold", title="Sold for $1,180,000")
    sold = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                                 "next_data": json.dumps(data)}).json()
    # (The sold page's generic "private treaty" doesn't switch the method: it sold by EOI.)
    assert sold["changes"] == ["Sold for $1.18m: recorded"]
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert (c["outcome"], c["sold_price_aud"], c["sale_method"]) == ("sold", 1_180_000, "eoi")
    assert pid not in [t["id"] for t in client.get("/api/listing/targets").json()]


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


def test_sold_listing_records_the_outcome(client, people):
    """A sold listing's price is the sale price, never a new guide; the sale is recorded from it with no one
    entering it, and a house we were offering on moves to Sold."""
    sold = {"props": {"pageProps": {"componentProps": {"listingSummary": {
        "stats": [], "status": "sold", "title": "Sold for $1,250,000"}}}}}
    got = extract(URL, "", next_data=json.dumps(sold))
    assert got["listing_status"] == "sold" and got["sold_price_aud"] == 1_250_000 and "guide_low_aud" not in got

    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "8", "street": "Sold Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    assert client.post(f"/api/properties/{pid}/status", headers=as_(a), json={"status": "offering"}).status_code == 201
    row = lambda: next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert row()["needs_outcome"] is False
    r = client.post(f"/api/properties/{pid}/listing-update", headers=as_(a),
                    json={"listing_status": "sold", "listing_price_text": "Sold for $1,250,000", "sold_price_aud": 1_250_000})
    assert r.status_code == 200 and r.json()["guide"] is False and "Sold for $1.25m: recorded" in r.json()["changes"]
    got = row()
    assert got["needs_outcome"] is False and got["listing_status"] == "sold" and got["listing_price_text"] == "Sold for $1,250,000"
    assert (got["outcome"], got["sold_price_aud"], got["status"]) == ("sold", 1_250_000, "missed_out")

    # An auction that sold before its date is "sold prior"; a house we only watched keeps its status.
    later = (datetime.now(MELBOURNE) + timedelta(days=10)).isoformat()
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "10", "street": "Sold Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "auction", "auction_at": later}}).json()["id"]
    assert client.post(f"/api/properties/{pid}/listing-update", headers=as_(a), json={"listing_status": "sold"}).status_code == 200
    got = row()
    assert (got["outcome"], got["sold_price_aud"], got["status"]) == ("sold_prior", None, "watching")


def test_a_sold_page_keeps_the_auction(client, people):
    """Domain's sold page can say "private treaty" for a house that was going to auction: the refresh records the sale
    as sold prior (the auction was still to come) and keeps the auction and its date."""
    a = as_(people["a"])
    url = "https://www.domain.com.au/12-sold-street-mitcham-vic-3132-2029990012"
    later = (datetime.now(MELBOURNE) + timedelta(days=10)).replace(microsecond=0)
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "12", "street": "Sold Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "auction", "auction_at": later.isoformat(), "url": url}}).json()["id"]
    data = json.loads(NEXT_DATA)
    data["props"]["pageProps"]["componentProps"]["listingSummary"].update(status="sold", title="Sold for $1,300,000", method="privateTreaty")
    r = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                              "next_data": json.dumps(data)}).json()
    assert not any(ch.startswith("Now selling by") for ch in r["changes"])
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert (c["outcome"], c["sold_price_aud"], c["sale_method"]) == ("sold_prior", 1_300_000, "auction")
    assert c["auction_at"] is not None


def test_address_from_a_shared_domain_link(monkeypatch):
    from app import gnaf
    from app.listing import address_from_link
    monkeypatch.setattr(gnaf, "search", lambda q, limit=8: [])  # no G-NAF: the street ends at its type word
    got = lambda slug: address_from_link(f"https://www.domain.com.au/{slug}")
    assert got("3-14-example-street-box-hill-north-vic-3129-2029990001") == {
        "unit": "3", "street_number": "14", "street": "Example Street", "suburb": "Box Hill North", "postcode": "3129"}
    assert got("12-glen-street-glen-waverley-vic-3150-2029990003")["suburb"] == "Glen Waverley"
    assert got("15-hill-view-road-mount-evelyn-vic-3796-2029990004")["street"] == "Hill View Road"
    # A near miss isn't taken: another street, or a unit when the link has none.
    monkeypatch.setattr(gnaf, "search", lambda q, limit=8: [
        {"unit": "1", "street_number": "12", "street": "BEACON STREET", "suburb": "GLEN WAVERLEY", "postcode": "3150"},
        {"unit": "1", "street_number": "12", "street": "GLEN STREET", "suburb": "GLEN WAVERLEY", "postcode": "3150"}])
    assert got("12-glen-street-glen-waverley-vic-3150-2029990003") == {
        "unit": None, "street_number": "12", "street": "Glen Street", "suburb": "Glen Waverley", "postcode": "3150"}
    assert got("lot-5-new-road-clyde-vic-3978-2029990006") is None
    assert address_from_link("https://www.realestate.com.au/property-house-vic-mitcham-145678901") is None
    # With G-NAF, its record wins (and says where the street ends).
    monkeypatch.setattr(gnaf, "search", lambda q, limit=8: [
        {"unit": None, "street_number": "15", "street": "HILL VIEW ROAD", "suburb": "MOUNT EVELYN", "postcode": "3796"}])
    assert got("15-hill-view-road-mount-evelyn-vic-3796-2029990004")["street"] == "Hill View Road"


def test_shared_link_finds_a_tracked_listing(client, people, monkeypatch):
    from app import gnaf
    monkeypatch.setattr(gnaf, "search", lambda q, limit=8: [])
    a = as_(people["a"])
    url = "https://www.domain.com.au/8-shared-street-mitcham-vic-3132-2029990088"
    got = client.post("/api/listing/from-link", headers=a, json={"url": url + "?utm_source=app"}).json()
    assert got["url"] == url and got["address_parts"]["street"] == "Shared Street" and got["existing_property_id"] is None
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "8", "street": "Shared Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "private_sale", "url": url}}).json()["id"]
    assert client.post("/api/listing/from-link", headers=a, json={"url": url}).json()["existing_property_id"] == pid


def test_share_from_a_phone_adds_the_house_or_keeps_the_link(client, people, monkeypatch):
    from app import gnaf
    monkeypatch.setattr(gnaf, "search", lambda q, limit=8: [])
    a = as_(people["a"])
    domain = "https://www.domain.com.au/9-phone-street-mitcham-vic-3132-2029990099"
    # The shortcut sends the list its "Get URLs" step made; the Domain app shares text with the link in it.
    r = client.post("/api/share", headers=a, json={"url": [domain + "?utm_medium=share"]}).json()
    assert r["status"] == "added" and r["message"].startswith("Added 9 Phone Street, Mitcham 3132")
    house = client.get(f"/api/properties/{r['property_id']}").json()
    assert house["campaigns"][0]["sale_method"] == "private_sale" and house["campaigns"][0]["links"][0]["url"] == domain
    again = client.post("/api/share", headers=a, json={"text": f"Check out this property on Domain: {domain}"}).json()
    assert again["status"] == "exists" and again["property_id"] == r["property_id"]

    rea = "https://www.realestate.com.au/property-house-vic-mitcham-145678909"
    kept = client.post("/api/share", headers=a, json={"url": rea}).json()
    assert kept["status"] == "saved" and "finish adding" in kept["message"]
    [waiting] = [x for x in client.get("/api/shared-links").json() if x["url"] == rea]
    assert waiting["shared_by"] == people["a"]["id"]
    # Once it's on a house, it's no longer waiting; a dismissed one isn't either.
    client.post("/api/properties", headers=a, json={
        "address": {"street_number": "10", "street": "Phone Street", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "auction", "url": rea}})
    assert rea not in [x["url"] for x in client.get("/api/shared-links").json()]
    other = client.post("/api/share", headers=a, json={"url": "https://www.realestate.com.au/property-unit-vic-mitcham-145678910"}).json()
    [link] = [x for x in client.get("/api/shared-links").json() if x["url"].endswith("145678910")]
    assert other["status"] == "saved" and client.delete(f"/api/shared-links/{link['id']}", headers=a).status_code == 204
    assert not [x for x in client.get("/api/shared-links").json() if x["url"].endswith("145678910")]
    assert client.post("/api/share", headers=a, json={"text": "no link here"}).json()["status"] == "no_link"


def test_a_sold_price_that_comes_later(client, people):
    """Sold with the price held back: the house stays on the refresh list for two weeks, and the price is filled in
    when the listing shows it."""
    a = as_(people["a"])
    url = "https://www.domain.com.au/3-late-lane-mitcham-vic-3132-2029990033"
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "3", "street": "Late Lane", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "private_sale", "url": url}}).json()["id"]
    client.post(f"/api/properties/{pid}/listing-update", headers=a, json={"listing_status": "sold"})
    targets = lambda: [t["id"] for t in client.get("/api/listing/targets").json()]
    assert pid in targets()
    r = client.post(f"/api/properties/{pid}/listing-update", headers=a,
                    json={"listing_status": "sold", "listing_price_text": "Sold for $990,000", "sold_price_aud": 990_000}).json()
    assert "Sold price: $990k" in r["changes"]
    row = next(x for x in client.get("/api/overview").json()["rows"] if x["id"] == pid)
    assert (row["outcome"], row["sold_price_aud"]) == ("sold", 990_000)
    assert pid not in targets()


def _rea_page(listing: dict) -> str:
    """Shaped like realestate.com.au's page data: the interesting part is JSON inside a string, inside another one."""
    inner = json.dumps({"details": {"listing": listing}})
    cache = json.dumps({"-123456": {"data": inner}})
    return json.dumps({"resi-property_listing-experience-web": {"urqlClientCache": cache}})


def test_json_inside_strings_is_read(client):
    """realestate.com.au keeps its listing as JSON inside a string; that's unpacked, and an address given as a street
    line, suburb and postcode becomes address parts."""
    page = _rea_page({
        "address": {"streetAddress": "3/12 Smith Street", "suburb": "Box Hill", "state": "VIC", "postcode": "3128"},
        "propertyType": "Townhouse", "bedrooms": 3, "bathrooms": 2, "parkingSpaces": 1, "landArea": 280,
        "price": {"display": "$950,000 - $1,040,000"}})
    got = extract("https://www.realestate.com.au/property-townhouse-vic-box+hill-145678901", "", argonaut=page)
    assert got["address_parts"] == {"unit": "3", "street_number": "12", "street": "Smith Street", "suburb": "Box Hill", "postcode": "3128"}
    assert (got["beds"], got["baths"], got["car_spaces"], got["land_m2"]) == (3, 2, 1, 280)
    assert got["property_type"] == "townhouse" and (got["guide_low_aud"], got["guide_high_aud"]) == (950_000, 1_040_000)
    # The same data as a page-state blob from some other site reads the same way, and a plain string is left alone.
    other = extract("https://www.example.com.au/listing/1", "", page_state=page)
    assert other["address_parts"]["street"] == "Smith Street"
    assert extract("https://www.example.com.au/listing/2", "", page_state=json.dumps({"note": "not {json} at all, just a long sentence of words"}))["beds"] is None


def test_what_a_realestate_link_says():
    from app.listing import hints_from_link
    assert hints_from_link("https://www.realestate.com.au/property-house-vic-box+hill+north-145678901") == {
        "suburb": "Box Hill North", "state": "VIC", "property_type": "house"}
    assert hints_from_link("https://www.realestate.com.au/property-unit-vic-mitcham-145678901?cid=x")["property_type"] == "unit"
    assert hints_from_link("https://www.realestate.com.au/buy/in-mitcham,+vic+3132/list-1") is None
    assert hints_from_link("https://www.domain.com.au/3-14-example-street-box-hill-north-vic-3129-2029990001") is None


def test_from_link_gives_the_hints(client, people):
    got = client.post("/api/listing/from-link", headers=as_(people["a"]),
                      json={"url": "https://www.realestate.com.au/property-house-vic-mitcham-145678909"}).json()
    assert got["address_parts"] is None and got["link_hint"]["suburb"] == "Mitcham" and got["property_type"] == "house"


def test_captures_are_kept_only_when_asked(client, people, monkeypatch, tmp_path):
    """A test copy keeps what each bookmarklet capture sent, so the readers can be checked against real pages."""
    monkeypatch.setenv("BLOB_DIR", str(tmp_path / "blobs"))
    body = {"url": "https://www.property.com.au/vic/mitcham-3132/1-example-st-pid-1/", "html": "<html><head><title>x</title></head></html>",
            "page_state": json.dumps({"a": 1}), "text": "3 bed"}
    monkeypatch.delenv("CAPTURE_SAMPLES", raising=False)
    assert client.post("/api/listing/parse", headers=as_(people["a"]), json=body).status_code == 200
    assert not (tmp_path / "blobs" / "_capture_samples").exists()
    monkeypatch.setenv("CAPTURE_SAMPLES", "1")
    assert client.post("/api/listing/parse", headers=as_(people["a"]), json=body).status_code == 200
    [kept] = list((tmp_path / "blobs" / "_capture_samples").glob("property.com.au-*.json"))
    assert json.loads(kept.read_text(encoding="utf-8"))["page_state"] == json.dumps({"a": 1})


def test_realestate_photos_and_floor_plans():
    """Its images are on reastatic.net, as templates with a {size}; floor plans sit under a floor plan key. They were
    out of reach before (the JSON holding them was inside a string, and the host was wrong)."""
    page = _rea_page({
        "address": {"streetAddress": "5 Example Road", "suburb": "Mitcham", "postcode": "3132"},
        "media": {"images": [{"templatedUrl": "https://i2.au.reastatic.net/{size}/aaa111/image.jpg"},
                             {"templatedUrl": "https://i2.au.reastatic.net/{size}/bbb222/image.jpg"},
                             {"templatedUrl": "https://i2.au.reastatic.net/{size}/aaa111/image.jpg"}],
                  "floorplans": [{"url": "https://i2.au.reastatic.net/800x600/ccc333/floorplan.jpg"}]}})
    got = extract("https://www.realestate.com.au/property-house-vic-mitcham-145678902", "", argonaut=page)
    assert got["photos"] == ["https://i2.au.reastatic.net/1144x888-format=webp/aaa111/image.jpg",
                             "https://i2.au.reastatic.net/1144x888-format=webp/bbb222/image.jpg"]
    assert got["floorplans"] == ["https://i2.au.reastatic.net/800x600/ccc333/floorplan.jpg"]


def test_realestate_script_text_and_field_names():
    """What the bookmarklet sends from a real realestate.com.au page: the text of the script tag (the page deletes its
    own global), with the listing's own field names: generalFeatures.bedrooms.value, propertySizes.land, listers..."""
    listing = {
        "id": "145678901",
        "address": {"suburb": "Mitcham", "state": "VIC", "postcode": "3132",
                    "display": {"shortAddress": "7 Example Road", "fullAddress": "7 Example Road, Mitcham, VIC 3132",
                                "geocode": {"latitude": -37.82, "longitude": 145.19}}},
        "propertyType": {"id": "house", "display": "House"},
        "generalFeatures": {"bedrooms": {"value": 4}, "bathrooms": {"value": 2}, "parkingSpaces": {"value": 2}},
        "propertySizes": {"land": {"displayValue": "612", "sizeUnit": {"displayValue": "m²"}},
                          "building": {"displayValue": "180", "sizeUnit": {"displayValue": "m²"}}},
        "price": {"display": "$1,050,000 - $1,150,000"}, "auction": {"dateTime": {"value": "2099-10-24T11:00:00"}},
        "description": "Light-filled home.<br/>North-facing garden with a <b>pool</b> &amp; double garage.",
        "listingCompany": {"name": "Example Realty Mitcham"},
        "listers": [{"name": "Pat Agent", "phoneNumber": {"display": "0400 000 001"}}],
        "media": {"images": [{"templatedUrl": "https://i2.au.reastatic.net/{size}/aaa111/image.jpg"}],
                  "floorplans": [{"templatedUrl": "https://i2.au.reastatic.net/{size}/ccc333/floorplan.jpg"}]}}
    other_script = 'window.something = {"unrelated": true};'
    script = "window.ArgonautExchange=" + _rea_page(listing) + ";\nwindow.after = 1;"
    got = extract("https://www.realestate.com.au/property-house-vic-mitcham-145678901", "<head></head>",
                  argonaut=other_script + SCRIPT_BREAK + script)
    assert got["address_parts"] == {"unit": None, "street_number": "7", "street": "Example Road", "suburb": "Mitcham", "postcode": "3132"}
    assert (got["beds"], got["baths"], got["car_spaces"], got["land_m2"], got["building_m2"]) == (4, 2, 2, 612, 180)
    assert got["property_type"] == "house" and (got["guide_low_aud"], got["guide_high_aud"]) == (1_050_000, 1_150_000)
    assert got["sale_method"] == "auction" and got["auction_at"].startswith("2099-10-24T11:00")
    assert got["agents"] == [{"name": "Pat Agent", "mobile": "0400 000 001", "email": None, "agency_name": "Example Realty Mitcham"}]
    assert (got["lat"], got["lon"]) == (-37.82, 145.19)
    assert got["photos"] == ["https://i2.au.reastatic.net/1144x888-format=webp/aaa111/image.jpg"]
    assert got["floorplans"] == ["https://i2.au.reastatic.net/1144x888-format=webp/ccc333/floorplan.jpg"]
    assert got["description"] == "Light-filled home.\nNorth-facing garden with a pool & double garage."
    assert {"pool", "garage", "north-facing", "garden"} <= set(got["suggested_tags"])


def test_domain_leads_other_sites_fill_gaps(client, people):
    """A capture from realestate.com.au on a house with a Domain listing never overwrites what's there: it fills
    missing rooms and areas and adds new things. The same capture from Domain does overwrite."""
    a = as_(people["a"])
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "9", "street": "Fallback Court", "suburb": "Woodend", "postcode": "3442"}, "land_m2": 600,
        "campaign": {"sale_method": "private_sale", "url": "https://www.domain.com.au/9-fallback-court-woodend-vic-3442-2099990088",
                     "guide_low_aud": 900000, "guide_high_aud": 950000}}).json()["id"]
    body = {"land_m2": 640, "beds": 3, "guide_low_aud": 1_000_000, "guide_high_aud": 1_050_000, "sale_method": "auction",
            "auction_at": "2099-11-01T11:00:00+11:00", "source": "rea"}
    r = client.post(f"/api/properties/{pid}/listing-update", headers=a, json=body).json()
    p = client.get(f"/api/properties/{pid}").json()
    assert p["land_m2"] == 600 and p["beds"] == 3 and r["guide"] is False
    assert p["campaigns"][0]["sale_method"] == "private_sale"
    assert not any(c.startswith(("Land", "New price guide", "Now selling")) for c in r["changes"])

    client.post(f"/api/properties/{pid}/listing-update", headers=a, json={**body, "source": "domain"})
    assert client.get(f"/api/properties/{pid}").json()["land_m2"] == 640


def test_domain_capture_of_a_house_tracked_from_another_site(client, people):
    """A Domain capture whose address matches a house added from realestate.com.au is that house, and updating
    adds the Domain link so it joins the weekly refresh."""
    a = as_(people["a"])
    addr = {"street_number": "11", "street": "Match Street", "suburb": "Woodend", "postcode": "3442"}
    pid = client.post("/api/properties", headers=a, json={
        "address": addr, "campaign": {"sale_method": "private_sale", "url": "https://www.realestate.com.au/property-house-vic-woodend-145678999"}}).json()["id"]
    domain = "https://www.domain.com.au/11-match-street-woodend-vic-3442-2099990111"
    got = client.post("/api/listing/parse", headers=a, json={"url": domain, "html": "<head></head>", "text": "11 Match Street, Woodend VIC 3442"}).json()
    if got.get("address_parts"):
        assert got["existing_property_id"] == pid
    r = client.post(f"/api/properties/{pid}/listing-update", headers=a, json={"url": domain, "source": "domain"}).json()
    assert any("weekly refresh" in c for c in r["changes"])
    links = [l["portal"] for c in client.get(f"/api/properties/{pid}").json()["campaigns"] for l in c["links"]]
    assert sorted(links) == ["domain", "rea"]


def test_not_going_is_kept_and_can_be_restored(client, people):
    """Marking an inspection Not going takes it off the calendar but keeps it, with who did it, until it's added back."""
    a, b = as_(people["a"]), as_(people["b"])
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "5", "street": "Skip Road", "suburb": "Woodend", "postcode": "3442"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    when = (datetime.now(MELBOURNE) + timedelta(days=3)).isoformat()
    iid = client.post(f"/api/properties/{pid}/inspections", headers=a, json={"kind": "open", "starts_at": when}).json()["id"]
    client.patch(f"/api/inspections/{iid}", headers=b, json={"state": "skipped"})
    assert iid not in [str(e["id"]) for e in client.get("/api/inspections?days=14").json()]
    gone = [e for e in client.get("/api/inspections/removed").json() if str(e["id"]) == iid]
    assert gone and gone[0]["removed_by_name"] == people["b"]["display_name"]
    client.patch(f"/api/inspections/{iid}", headers=a, json={"state": "planned"})
    assert iid in [str(e["id"]) for e in client.get("/api/inspections?days=14").json()]
    assert not [e for e in client.get("/api/inspections/removed").json() if str(e["id"]) == iid]


def test_ticking_already_inspected(client, people):
    """"We've been to this house" counts as inspected for both of you, and takes it off the To inspect list."""
    a = as_(people["a"])
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "6", "street": "Tick Road", "suburb": "Woodend", "postcode": "3442"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    client.put(f"/api/properties/{pid}/inspect-list", headers=a)
    assert client.put(f"/api/properties/{pid}/inspected", headers=a).status_code == 200
    row = next(r for r in client.get("/api/overview", headers=a).json()["rows"] if r["id"] == pid)
    assert sorted(row["attended_by"]) == sorted(str(people[k]["id"]) for k in ("a", "b")) and not row["to_inspect"]
    assert len(client.get(f"/api/properties/{pid}").json()["inspected_by"]) == 2
    client.delete(f"/api/properties/{pid}/inspected", headers=a)
    assert client.get(f"/api/properties/{pid}").json()["inspected_by"] == []


def test_address_parts_are_text_when_the_page_gives_numbers():
    """Some pages (sold listings among them) give the street number and postcode as numbers; the Add form needs text."""
    data = json.loads(NEXT_DATA)
    props = data["props"]["pageProps"]["componentProps"]
    props.update(streetNumber=14, postcode=3132, unitNumber=None)
    got = extract(URL, HEAD, json.dumps(data))
    assert got["address_parts"] == {"unit": None, "street_number": "14", "street": "Example Street", "suburb": "Mitcham",
                                    "postcode": "3132"}
