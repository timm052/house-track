import uuid
from datetime import date, timedelta

from .conftest import as_


def new_house(client, person, n, **extra):
    body = {"address": {"street_number": str(n), "street": "Grid Lane", "suburb": "Ringwood", "postcode": "3134"},
            "beds": 3, "campaign": {"sale_method": "auction", "guide_low_aud": 900_000, "guide_high_aud": 990_000}} | extra
    r = client.post("/api/properties", headers=as_(person), json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def row_for(client, person, pid):
    return next(r for r in client.get("/api/overview", headers=as_(person)).json()["rows"] if r["id"] == pid)


def cell(client, person, pid, column, value, expected=None, check=True):
    return client.post("/api/overview/cell", headers=as_(person), json={
        "property_id": pid, "column": column, "value": value, "expected": expected, "check": check})


def test_overview_row_has_flat_fields_and_versions(client, people):
    pid = new_house(client, people["a"], 101)
    r = row_for(client, people["a"], pid)
    assert (r["address"], r["suburb"], r["beds"], r["sale_method"]) == ("101 Grid Lane", "Ringwood", 3, "auction")
    assert (r["guide_low"], r["guide_high"], r["guide_source"]) == (900_000, 990_000, "advertised")
    assert r["_v"]["guide"] and r["_v"]["status"] and r["days_on_market"] is None  # not listed on a known date
    listed = (date.today() - timedelta(days=12)).isoformat()
    assert cell(client, people["a"], pid, "listed_on", listed).status_code == 200
    assert row_for(client, people["a"], pid)["days_on_market"] in (11, 12, 13)  # (the server's day is Melbourne's)


def test_plain_cell_save_and_field_level_conflict(client, people):
    a, b = people["a"], people["b"]
    pid = new_house(client, a, 102)
    seen = row_for(client, a, pid)
    # B edits baths; A's edit to beds must not conflict (different field).
    assert cell(client, b, pid, "baths", 2, expected=seen["baths"]).status_code == 200
    assert cell(client, a, pid, "beds", 4, expected=seen["beds"]).json()["beds"] == 4
    # Now both change beds from the same starting value: the second one conflicts.
    assert cell(client, b, pid, "beds", 5, expected=4).status_code == 200
    r = cell(client, a, pid, "beds", 6, expected=4)
    assert r.status_code == 409
    d = r.json()["detail"]
    assert d["current"] == 5 and d["changed_by"] == "Sam"
    # Keep mine = resend without the check.
    assert cell(client, a, pid, "beds", 6, check=False).json()["beds"] == 6


def test_history_cells_append_and_conflict_on_latest_entry(client, people):
    a, b = people["a"], people["b"]
    pid = new_house(client, a, 103)
    seen = row_for(client, a, pid)
    col = f"v:{b['id']}:post"
    r = cell(client, a, pid, col, "yes", expected=seen["_v"].get(col))  # A enters B's verdict
    assert r.status_code == 200 and r.json()[col] == "yes" and r.json()[f"{col}:by"] == "Alex"
    stale = seen["_v"].get(col)
    assert cell(client, b, pid, col, "no", expected=stale).status_code == 409

    r = cell(client, a, pid, "walk_away", 1_000_000, expected=None).json()
    assert r["walk_away"] == 1_000_000
    r = cell(client, a, pid, "guide_high", 1_050_000, expected=r["_v"]["guide"]).json()
    assert (r["guide_low"], r["guide_high"]) == (900_000, 1_050_000)
    r = cell(client, a, pid, "guide_source", "agent_verbal", expected=r["_v"]["guide"]).json()
    assert r["guide_source"] == "agent_verbal" and r["guide_high"] == 1_050_000
    r = cell(client, a, pid, "status", "shortlisted", expected=r["_v"]["status"]).json()
    assert r["status"] == "shortlisted"


def test_campaign_cells_and_readonly_columns(client, people):
    a = people["a"]
    pid = new_house(client, a, 104, campaign=None)
    assert cell(client, a, pid, "sale_at", "2026-11-07T11:00:00+11:00", check=False).status_code == 422
    assert cell(client, a, pid, "sale_method", "auction", check=False).json()["sale_method"] == "auction"
    r = cell(client, a, pid, "sale_at", "2026-11-07T11:00:00+11:00", expected=None).json()
    assert r["sale_at"].startswith("2026-11-07")
    r = cell(client, a, pid, "agent_name", "Jo Agent", expected=None).json()
    r = cell(client, a, pid, "agent_phone", "0400 111 222", expected=None).json()
    assert (r["agent_name"], r["agent_phone"]) == ("Jo Agent", "0400 111 222")
    r = cell(client, a, pid, "listing_url", "https://www.domain.com.au/104-grid-lane-ringwood-vic-3134-2019990001", expected=None).json()
    assert r["listing_url"].endswith("2019990001")
    assert cell(client, a, pid, "days_on_market", 3, check=False).status_code == 422
    assert cell(client, a, pid, "address", "1 Other St", check=False).status_code == 422
    r = cell(client, a, pid, "outcome", "passed_in", expected=None).json()
    assert r["outcome"] == "passed_in" and r["outcome_on"]


def test_saved_views_and_single_default(client, people):
    a = as_(people["a"])
    v1 = client.post("/api/views", headers=a, json={"name": "Shortlist", "is_default": True, "columns": ["address", "status"],
                                                   "filters": [{"column": "status", "op": "in", "value": ["shortlisted"]}]}).json()
    v2 = client.post("/api/views", headers=a, json={"name": "Everything", "is_default": True}).json()
    views = {v["name"]: v for v in client.get("/api/views").json()}
    assert views["Everything"]["is_default"] and not views["Shortlist"]["is_default"]
    client.patch(f"/api/views/{v1['id']}", headers=a, json={"sort": [{"column": "guide_high", "dir": "desc"}]})
    assert next(v for v in client.get("/api/views").json() if v["id"] == v1["id"])["sort"][0]["dir"] == "desc"
    client.delete(f"/api/views/{v2['id']}", headers=a)
    assert "Everything" not in {v["name"] for v in client.get("/api/views").json()}


def test_at_most_five_favourite_places(client, people):
    a = as_(people["a"])
    ids = [client.post("/api/places", headers=a, json={"kind": "destination", "name": f"Fav {uuid.uuid4().hex[:6]}",
                                                        "location": {"lon": 145.0, "lat": -37.8}}).json()["id"] for _ in range(6)]
    for place_id in ids[:5]:
        assert client.put(f"/api/places/{place_id}/favourite", headers=a, json={"is_favourite": True}).status_code == 200
    assert client.put(f"/api/places/{ids[5]}/favourite", headers=a, json={"is_favourite": True}).status_code == 422
    client.put(f"/api/places/{ids[0]}/favourite", headers=a, json={"is_favourite": False})
    assert client.put(f"/api/places/{ids[5]}/favourite", headers=a, json={"is_favourite": True}).status_code == 200
    for place_id in ids:
        client.delete(f"/api/places/{place_id}", headers=a)


def test_tags_on_houses_and_in_the_grid(client, people):
    a, b = people["a"], people["b"]
    pid = new_house(client, a, 150)
    r = client.put(f"/api/properties/{pid}/tags", headers=as_(a), json={"names": ["Corner block", " needs  reno "]})
    assert r.json()["tags"] == ["Corner block", "needs reno"]
    row = row_for(client, a, pid)
    assert row["tags"] == ["Corner block", "needs reno"]
    # Grid edit replaces the set; an existing tag is matched case-insensitively.
    r = cell(client, a, pid, "tags", ["corner block", "North garden"], expected=row["tags"])
    assert r.status_code == 200 and sorted(r.json()["tags"]) == ["Corner block", "North garden"]
    assert cell(client, b, pid, "tags", ["x"], expected=["Corner block"]).status_code == 409
    tags = {t["name"]: t for t in client.get("/api/tags").json()}
    assert tags["Corner block"]["houses"] >= 1 and tags["needs reno"]["houses"] == 0
    client.delete(f"/api/tags/{tags['North garden']['id']}", headers=as_(a))
    assert row_for(client, a, pid)["tags"] == ["Corner block"]
    assert client.patch(f"/api/tags/{tags['needs reno']['id']}", headers=as_(a), json={"name": "Corner Block"}).status_code == 409
    # The house page sends a change, not the set: b's page still only knew "Corner block", and a's new tag survives it.
    client.put(f"/api/properties/{pid}/tags", headers=as_(a), json={"add": ["Solar"]})
    r = client.put(f"/api/properties/{pid}/tags", headers=as_(b), json={"remove": ["corner block"], "add": ["Carport"]})
    assert r.json()["tags"] == ["Carport", "Solar"]


def test_price_history_columns(client, people):
    a = people["a"]
    pid = new_house(client, a, 151)
    cid = row_for(client, a, pid)["campaign_id"]
    # A day after the house's first guide (which is now), whatever today is.
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    later = datetime.now(ZoneInfo("Australia/Melbourne")).replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=1)
    client.post(f"/api/campaigns/{cid}/price-guides", headers=as_(a),
                json={"source": "advertised", "low_aud": 850_000, "high_aud": 935_000, "observed_at": later.isoformat()})
    row = row_for(client, a, pid)
    assert (row["first_guide_low"], row["first_guide_high"]) == (900_000, 990_000)
    assert row["guide_changes"] == 1 and row["last_guide_change"] == later.date().isoformat() and row["guide_change"] == -52_500


def test_sale_method_switch_from_the_grid_and_the_house_page(client, people):
    """Every path that changes the sale method drops the date that belonged to the old one (it used to fail on
    the campaign's check constraint from the grid)."""
    from .test_driveway import house
    a = people["a"]
    pid = house(client, a, 78)  # an auction with a date
    cell = lambda col, v: client.post("/api/overview/cell", headers=as_(a),
                                      json={"property_id": pid, "column": col, "value": v, "expected": None, "check": False})
    assert cell("sale_method", "eoi").status_code == 200
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["sale_method"] == "eoi" and c["auction_at"] is None
    assert cell("sale_at", "2099-11-02T17:00:00+11:00").status_code == 200
    r = client.patch(f"/api/campaigns/{c['id']}", headers=as_(a), json={"sale_method": "private_sale"})
    assert r.status_code == 200, r.text
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["sale_method"] == "private_sale" and c["eoi_closes_at"] is None
    r = client.patch(f"/api/campaigns/{c['id']}", headers=as_(a), json={"sale_method": "auction", "auction_at": "2099-11-09T11:00:00+11:00"})
    assert r.status_code == 200 and client.get(f"/api/properties/{pid}").json()["campaigns"][0]["auction_at"] is not None
    assert cell("sale_method", None).status_code == 422


def test_house_page_and_grid_follow_the_same_rules(client, people):
    from .test_driveway import house
    a, b = people["a"], people["b"]
    pid = house(client, a, 79)
    cell = lambda col, v: client.post("/api/overview/cell", headers=as_(b),
                                      json={"property_id": pid, "column": col, "value": v, "expected": None, "check": False})
    # The grid refuses what the house page's form refuses.
    assert cell("land_m2", 0).status_code == 422
    assert cell("beds", 3).status_code == 200

    # A form save that started before B's edit is refused, rather than undoing it.
    r = client.patch(f"/api/properties/{pid}", headers=as_(a), json={"beds": 4, "expected": {"beds": None}})
    assert r.status_code == 409 and r.json()["detail"]["current"] == 3
    assert client.patch(f"/api/properties/{pid}", headers=as_(a), json={"beds": 4, "expected": {"beds": 3}}).status_code == 200

    # Status: same check as the grid's.
    seen = client.get(f"/api/properties/{pid}").json()["status_history"][0]["id"]
    assert client.post(f"/api/properties/{pid}/status", headers=as_(b), json={"status": "interested"}).status_code == 201
    r = client.post(f"/api/properties/{pid}/status", headers=as_(a),
                    json={"status": "shortlisted", "check_latest": True, "expected_latest_id": seen})
    assert r.status_code == 409 and r.json()["detail"]["current"] == "interested"

    # Re-opening a sale from the grid clears its result, as the house page does.
    assert cell("outcome", "sold").status_code == 200 and cell("sold_price_aud", 1200000).status_code == 200
    assert cell("outcome", None).status_code == 200
    c = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    assert c["outcome"] is None and c["sold_price_aud"] is None and c["outcome_on"] is None


def test_tag_rename_clash_offers_a_merge(client, people):
    a = people["a"]
    make = lambda n: client.post("/api/properties", headers=as_(a), json={"address": {"street_number": str(n), "street": "Tag Street",
                                 "suburb": "Mitcham", "postcode": "3132"}}).json()["id"]
    one, two = make(1), make(2)
    client.put(f"/api/properties/{one}/tags", headers=as_(a), json={"names": ["north facing"]})
    client.put(f"/api/properties/{two}/tags", headers=as_(a), json={"names": ["north-facing", "pool"]})
    tags = {t["name"]: t["id"] for t in client.get("/api/tags").json()}
    r = client.patch(f"/api/tags/{tags['north-facing']}", headers=as_(a), json={"name": "north facing"})
    assert r.status_code == 409 and r.json()["detail"]["merge_into"] == tags["north facing"]
    r = client.patch(f"/api/tags/{tags['north-facing']}", headers=as_(a), json={"name": "north facing", "merge": True})
    assert r.status_code == 200 and r.json()["id"] == tags["north facing"]
    counts = {t["name"]: t["houses"] for t in client.get("/api/tags").json()}
    assert counts.get("north facing") == 2 and "north-facing" not in counts


def test_latest_verdict_is_the_most_recent_response(client, people):
    """Before or after inspecting, whichever was said last."""
    a = people["a"]
    pid = new_house(client, a, 152)
    say = lambda stage, stance, when: client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json={
        "stage": stage, "stance": stance, "recorded_at": when})
    say("pre_inspection", "yes", "2026-09-01T10:00:00+10:00")
    say("post_inspection", "no", "2026-09-05T10:00:00+10:00")
    assert row_for(client, a, pid)[f"latest_verdict:{a['id']}"] == "no"
    say("pre_inspection", "maybe", "2026-09-20T10:00:00+10:00")  # changed their mind later, before a second look
    assert row_for(client, a, pid)[f"latest_verdict:{a['id']}"] == "maybe"


def test_updates_feed(client, people):
    """What's happened lately: houses added, guide changes (with the guide before), statuses and sales (not verdicts)."""
    a, b = people["a"], people["b"]
    pid = new_house(client, a, 153)
    cid = row_for(client, a, pid)["campaign_id"]
    guide = lambda low, high, when: client.post(f"/api/campaigns/{cid}/price-guides", headers=as_(a), json={
        "source": "advertised", "low_aud": low, "high_aud": high, "observed_at": when})
    guide(900_000, 990_000, "2099-01-01T09:00:00+10:00")
    guide(850_000, 935_000, "2099-01-02T09:00:00+10:00")
    client.post(f"/api/properties/{pid}/opinions", headers=as_(b), json={"stage": "pre_inspection", "stance": "yes", "note": "Love the street"})
    client.post(f"/api/properties/{pid}/status", headers=as_(a), json={"status": "shortlisted", "reason": "Both said yes"})
    assert client.patch(f"/api/campaigns/{cid}", headers=as_(a), json={"outcome": "sold", "sold_price_aud": 910_000}).status_code == 200

    feed = [e for e in client.get("/api/updates?days=120").json() if e["property_id"] == pid]
    kinds = [e["kind"] for e in feed]
    assert {"added", "guide", "status", "sale"} <= set(kinds) and "verdict" not in kinds
    assert kinds.count("guide") == 1                      # the first guide isn't a change
    g = next(e for e in feed if e["kind"] == "guide")
    assert (g["data"]["prev_low"], g["data"]["prev_high"], g["data"]["low"], g["data"]["high"]) == (900_000, 990_000, 850_000, 935_000)
    s = next(e for e in feed if e["kind"] == "sale")
    assert s["data"]["outcome"] == "sold" and s["data"]["price"] == 910_000
    assert client.get("/api/updates?days=0").status_code == 422
