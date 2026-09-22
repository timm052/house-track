from app.listing_parse import parse, price_range

from .conftest import as_

LISTING = """<html><head>
<title>12 Smith Street, Box Hill VIC 3128 - House for Sale | example.com.au</title>
<meta property="og:title" content="12 Smith Street, Box Hill VIC 3128">
<meta property="og:description" content="Price guide $1,200,000 - $1,300,000. Auction Saturday 11am.">
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "SingleFamilyResidence",
  "address": {"@type": "PostalAddress", "streetAddress": "12 Smith Street", "addressLocality": "Box Hill",
              "addressRegion": "VIC", "postalCode": "3128"}, "numberOfRooms": 4}</script>
</head><body><h1>12 Smith Street</h1><ul><li>4 Beds</li><li>2 Baths</li><li>2 Parking</li><li>Land 652m²</li></ul>
<p>AUCTION Sat 17 Oct, 11:00am</p><script>var junk = "$99";</script></body></html>"""


def test_parse_listing_page():
    got = parse(LISTING, "https://www.domain.com.au/12-smith-street-box-hill-vic-3128-2019876543?utm=1")
    assert got["address"] == "12 Smith Street, Box Hill VIC 3128"
    assert (got["beds"], got["baths"], got["car_spaces"], got["land_m2"]) == (4, 2, 2, 652)
    assert (got["guide_low_aud"], got["guide_high_aud"]) == (1_200_000, 1_300_000)
    assert got["sale_method"] == "auction" and got["portal"] == "domain" and "utm" not in got["url"]


def test_price_text_variants():
    assert price_range("Offers over $950k") == (950_000, 950_000)
    assert price_range("$1.2m - $1.3m") == (1_200_000, 1_300_000)
    assert price_range("Contact agent") == (None, None)
    assert price_range("$1,050,000 to $1,150,000") == (1_050_000, 1_150_000)


def test_bookmarklet_capture_endpoint(client, people):
    r = client.post("/api/listing/parse", headers=as_(people["a"]), json={"url": "https://www.realestate.com.au/property-house-vic-box+hill-143456789", "html": LISTING})
    assert r.status_code == 200 and r.json()["portal"] == "rea" and r.json()["beds"] == 4


def test_weighted_scores(client, people):
    a, b = people["a"], people["b"]
    garden = client.post("/api/criteria", headers=as_(a), json={"name": "Garden", "weight": 5}).json()
    light = client.post("/api/criteria", headers=as_(a), json={"name": "Natural light", "weight": 1}).json()
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "7", "street": "Score St", "suburb": "Mitcham", "postcode": "3132"}}).json()["id"]
    client.post(f"/api/properties/{pid}/scores", headers=as_(a), json={"criterion_id": garden["id"], "score": 5})
    client.post(f"/api/properties/{pid}/scores", headers=as_(a), json={"criterion_id": light["id"], "score": 1})
    client.post(f"/api/properties/{pid}/scores", headers=as_(a), json={"criterion_id": garden["id"], "score": 2, "person_id": b["id"]})
    s = client.get(f"/api/properties/{pid}/scores").json()
    totals = {t["person_id"]: t for t in s["totals"]}
    assert totals[a["id"]]["score"] == round(100 * (5 * 4 + 1 * 0) / (6 * 4))  # 83
    assert totals[b["id"]]["score"] == 25 and totals[b["id"]]["scored"] == 1
    # Re-scoring appends; the current score wins.
    client.post(f"/api/properties/{pid}/scores", headers=as_(a), json={"criterion_id": light["id"], "score": 5})
    totals = {t["person_id"]: t for t in client.get(f"/api/properties/{pid}/scores").json()["totals"]}
    assert totals[a["id"]]["score"] == 100
    row = next(r for r in client.get("/api/overview").json()["rows"] if r["id"] == pid)
    assert row[f"score:{a['id']}"] == 100 and row["score_avg"] == round((100 + 25) / 2)
    # Archiving a criterion drops it from the totals.
    client.delete(f"/api/criteria/{light['id']}", headers=as_(a))
    assert [c["name"] for c in client.get("/api/criteria").json()].count("Natural light") == 0


def test_listing_main_photo():
    from app.listing_parse import main_image
    og = '<meta property="og:image" content="https://rimh2.domainstatic.com.au/abc/1.jpg">'
    assert parse(og + LISTING)["image_url"] == "https://rimh2.domainstatic.com.au/abc/1.jpg"
    ld = '<script type="application/ld+json">{"@type": "Residence", "image": [{"@type": "ImageObject", "url": "https://img.example/a.jpg"}]}</script>'
    assert main_image(ld) == "https://img.example/a.jpg"
    assert parse(LISTING)["image_url"] is None


def test_bookmarklet_passes_the_photo(client, people):
    # The bookmarklet can pass the image it read from the page.
    body = {"url": "https://www.domain.com.au/x-2019876543", "html": LISTING, "image": "https://img.example/b.jpg"}
    r = client.post("/api/listing/parse", headers=as_(people["a"]), json=body)
    assert r.status_code == 200 and r.json()["image_url"] == "https://img.example/b.jpg"


def test_capture_of_a_tracked_listing_points_at_the_house(client, people):
    a = as_(people["a"])
    url = "https://www.domain.com.au/12-smith-street-box-hill-vic-3128-2019870001"
    pid = client.post("/api/properties", headers=a, json={
        "address": {"street_number": "212", "street": "Capture Street", "suburb": "Box Hill", "postcode": "3128"},
        "campaign": {"sale_method": "auction", "url": url}}).json()["id"]
    got = client.post("/api/listing/parse", headers=a, json={"url": url + "?utm_source=x", "html": LISTING}).json()
    assert got["existing_property_id"] == pid and got["existing_address"].startswith("212 Capture Street")
