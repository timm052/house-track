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
    monkeypatch.setattr(driveway, "save_photos_later", lambda pid, person, urls: saved.extend(urls))
    monkeypatch.setattr("app.routes.properties.save_photos_later", lambda pid, person, urls: saved.extend(urls))
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
    monkeypatch.setattr("app.routes.properties.save_photos_later", lambda pid, person, urls: None)
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
    r = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                              "next_data": json.dumps(data)}).json()
    assert r["changes"][0] == "New price guide $1.1m–$1.155m" and "1 new inspection time" in r["changes"]
    assert "2 new agents" in r["changes"] and r["flag"].startswith("Under offer")
    again = client.post("/api/listing/refresh", headers=a, json={"property_id": pid, "url": url, "status_code": 200,
                                                                  "next_data": json.dumps(data)}).json()
    assert again["changes"] == []  # nothing new the second time
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
    assert "Now selling by auction" in got["changes"] and "Auction date changed" in got["changes"]
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["sale_method"] == "auction" and c["eoi_closes_at"] is None and c["auction_at"].startswith("2026-11-07")
