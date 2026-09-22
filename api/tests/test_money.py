from app.money import CostSettings, breakdown, max_bid, vic_duty

from .conftest import as_


def test_vic_duty_bands():
    assert vic_duty(600_000, principal_residence=False) == 31_070       # 2,870 + 6% over 130k
    assert vic_duty(500_000) == 21_370                                  # PPR band: 2,870 + 5% over 130k
    assert vic_duty(1_000_000) == 55_000                                # 5.5% of the whole value
    assert vic_duty(2_500_000) == 142_500                               # 110,000 + 6.5% over 2m
    assert vic_duty(590_000, first_home_buyer=True) == 0                 # exempt up to 600k
    assert vic_duty(675_000, first_home_buyer=True) == round((2_870 + 0.06 * 545_000) / 2)  # halfway through the taper


def test_max_bid_fits_budget_to_the_nearest_thousand():
    s = CostSettings(cash_aud=250_000, loan_preapproval_aud=800_000, conveyancing_aud=2_000, inspections_aud=800, other_aud=3_200)
    bid = max_bid(s)
    assert breakdown(bid, s)["headroom"] >= 0
    assert breakdown(bid + 1_000, s)["headroom"] < 0
    assert 980_000 <= bid <= 1_000_000


def house(client, person, n, **campaign):
    r = client.post("/api/properties", headers=as_(person), json={
        "address": {"street_number": str(n), "street": "Money Street", "suburb": "Box Hill", "postcode": "3128"},
        "campaign": {"sale_method": "auction"} | campaign})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    return pid, client.get(f"/api/properties/{pid}").json()["campaigns"][0]["id"]


def test_costs_settings_round_trip(client, people):
    a = as_(people["a"])
    r = client.put("/api/costs", headers=a, json={"cash_aud": 200_000, "loan_preapproval_aud": 700_000, "first_home_buyer": True,
                                                  "principal_residence": True, "conveyancing_aud": 2_000, "inspections_aud": 800, "other_aud": 3_000})
    assert r.status_code == 200 and r.json()["max_bid"] > 800_000
    b = client.get("/api/costs", params={"price": 700_000}).json()["breakdown"]
    assert b["duty"] == vic_duty(700_000, first_home_buyer=True) and b["total"] == 700_000 + b["duty"] + 5_800


def test_checklist_defaults_toggle_and_custom(client, people):
    a = people["a"]
    _, cid = house(client, a, 1)
    items = client.post(f"/api/campaigns/{cid}/checklist/defaults", headers=as_(a)).json()
    assert len(items) >= 8 and items[0]["label"].startswith("Section 32")
    again = client.post(f"/api/campaigns/{cid}/checklist/defaults", headers=as_(a)).json()
    assert len(again) == len(items)  # idempotent
    client.patch(f"/api/checklist/{items[0]['id']}", headers=as_(a), json={"done": True})
    client.post(f"/api/campaigns/{cid}/checklist", headers=as_(a), json={"label": "Ask about the easement"})
    items = client.get(f"/api/campaigns/{cid}/checklist").json()
    assert items[0]["done_by"] == a["id"] and items[-1]["label"] == "Ask about the easement"
    client.patch(f"/api/checklist/{items[0]['id']}", headers=as_(a), json={"done": False})
    assert client.get(f"/api/campaigns/{cid}/checklist").json()[0]["done_at"] is None


def test_comparables_entered_and_tracked(client, people):
    a = people["a"]
    subject, cid = house(client, a, 2)
    sold, sold_cid = house(client, a, 3)
    for pid, lon in ((subject, 145.1200), (sold, 145.1250)):
        client.put(f"/api/properties/{pid}/location", headers=as_(a), json={"lon": lon, "lat": -37.8190})
    client.patch(f"/api/campaigns/{sold_cid}", headers=as_(a), json={"outcome": "sold_at_auction", "sold_price_aud": 1_210_000})
    client.post(f"/api/campaigns/{cid}/comparables", headers=as_(a),
                json={"address": "9 Near St, Box Hill", "sold_price_aud": 1_150_000, "sold_on": "2026-08-01", "beds": 3})
    comps = client.get(f"/api/campaigns/{cid}/comparables").json()
    assert comps["entered"][0]["address"] == "9 Near St, Box Hill"
    [tracked] = [t for t in comps["tracked"] if t["property_id"] == sold]
    assert tracked["sold_price_aud"] == 1_210_000 and 400 < tracked["distance_m"] < 500


def test_auction_bids_and_walk_away_block(client, people):
    a = people["a"]
    _, cid = house(client, a, 4, auction_at="2026-10-24T11:00:00+11:00")
    client.post(f"/api/campaigns/{cid}/price-judgements", headers=as_(a), json={"kind": "walk_away", "amount_aud": 1_100_000})
    assert client.post(f"/api/campaigns/{cid}/bids", headers=as_(a), json={"amount_aud": 950_000, "bidder": "vendor"}).status_code == 201
    assert client.post(f"/api/campaigns/{cid}/bids", headers=as_(a), json={"amount_aud": 1_000_000, "bidder": "us"}).status_code == 201
    over = client.post(f"/api/campaigns/{cid}/bids", headers=as_(a), json={"amount_aud": 1_120_000, "bidder": "us"})
    assert over.status_code == 422 and over.json()["detail"]["limit"] == 1_100_000
    assert client.post(f"/api/campaigns/{cid}/bids", headers=as_(a),
                       json={"amount_aud": 1_120_000, "bidder": "us", "over_limit_ok": True}).status_code == 201
    state = client.get(f"/api/campaigns/{cid}/auction").json()
    assert state["walk_away"] == 1_100_000 and [b["bidder"] for b in state["bids"]] == ["vendor", "us", "us"]
    client.delete(f"/api/bids/{state['bids'][-1]['id']}", headers=as_(a))
    assert len(client.get(f"/api/campaigns/{cid}/auction").json()["bids"]) == 2
