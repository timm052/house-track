import uuid

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
    assert r["_v"]["guide"] and r["_v"]["status"] and r["days_on_market"] == 0


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
