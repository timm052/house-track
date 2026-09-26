import uuid

import psycopg
import pytest

from .conftest import as_


def quick_add(client, person, **overrides):
    body = {
        "address": {"street_number": "12", "street": "Smith St", "suburb": "Box Hill", "postcode": "3128"},
        "beds": 3, "baths": 2, "car_spaces": 1,
        "campaign": {
            "sale_method": "auction",
            "auction_at": "2026-10-17T11:00:00+11:00",
            "url": "https://www.domain.com.au/12-smith-street-box-hill-vic-3128-2019876543?utm=x",
            "guide_low_aud": 1_200_000,
            "guide_high_aud": 1_300_000,
        },
    } | overrides
    return client.post("/api/properties", json=body, headers=as_(person))


def unique_address(n: int) -> dict:
    return {"street_number": str(n), "street": "Test Parade", "suburb": "Mitcham", "postcode": "3132"}


def test_writes_need_a_profile(client, people):
    r = client.post("/api/properties", json={"address": unique_address(1)})
    assert r.status_code == 400


def test_quick_add_then_list_and_detail(client, people):
    r = quick_add(client, people["a"])
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    listed = {p["id"]: p for p in client.get("/api/properties").json()}[pid]
    assert listed["address"] == "12 Smith Street, Box Hill 3128"
    assert listed["status"] == "watching"
    assert (listed["guide_low_aud"], listed["guide_high_aud"]) == (1_200_000, 1_300_000)
    assert listed["sale_method"] == "auction"

    detail = client.get(f"/api/properties/{pid}").json()
    [campaign] = detail["campaigns"]
    [link] = campaign["links"]
    assert link["portal"] == "domain" and link["external_id"] == "2019876543"
    assert "utm" not in link["url"]


def test_same_house_differently_spelt_is_recognised(client, people):
    first = quick_add(client, people["a"], address=unique_address(2), campaign=None).json()["id"]
    r = client.post(
        "/api/properties",
        json={"address": {"street_number": "2", "street": "TEST PDE", "suburb": "mitcham", "postcode": "3132"}},
        headers=as_(people["b"]),
    )
    assert r.status_code == 409
    assert r.json()["detail"]["existing_property_id"] == first


def test_same_listing_cannot_be_linked_twice(client, people):
    pid = quick_add(client, people["a"], address=unique_address(3), campaign={
        "sale_method": "eoi", "url": "https://www.realestate.com.au/property-house-vic-mitcham-143456789"}).json()["id"]
    other = quick_add(client, people["a"], address=unique_address(4), campaign={"sale_method": "eoi"}).json()["id"]
    campaign_id = client.get(f"/api/properties/{other}").json()["campaigns"][0]["id"]
    r = client.post(f"/api/campaigns/{campaign_id}/links",
                    json={"url": "https://realestate.com.au/property-house-vic-mitcham-143456789/"},
                    headers=as_(people["a"]))
    assert r.status_code == 409
    assert r.json()["detail"]["existing_property_id"] == pid


def test_off_the_plan_lot_without_street_number(client, people):
    r = client.post("/api/properties", headers=as_(people["a"]), json={
        "address": {"street": "Harvest Rd", "suburb": "Clyde North", "postcode": "3978",
                    "plan_number": "PS812345", "lot_number": "23"},
        "build_status": "off_the_plan", "property_type": "land"})
    assert r.status_code == 201, r.text
    detail = client.get(f"/api/properties/{r.json()['id']}").json()
    assert detail["address"] == "Lot 23 Harvest Road (PS812345), Clyde North 3978"


def test_address_needs_street_or_lot(client, people):
    r = client.post("/api/properties", headers=as_(people["a"]),
                    json={"address": {"street": "Nowhere Rd", "suburb": "Ringwood", "postcode": "3134"}})
    assert r.status_code == 422


def test_opinions_are_per_person_with_history_and_idempotent_replay(client, people, sql):
    pid = quick_add(client, people["a"], address=unique_address(5), campaign={"sale_method": "private_sale"}).json()["id"]
    a, b = people["a"], people["b"]
    client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json={"stage": "pre_inspection", "stance": "maybe"})
    client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json={"stage": "pre_inspection", "stance": "yes"})
    # B's verdict, typed on A's phone in the driveway, queued offline and replayed twice.
    queued = {"id": str(uuid.uuid4()), "person_id": b["id"], "stage": "post_inspection", "stance": "no",
              "note": "Backs onto the freeway", "recorded_at": "2026-09-19T11:20:00+10:00"}
    assert client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json=queued).status_code == 201
    assert client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json=queued).status_code == 201

    detail = client.get(f"/api/properties/{pid}").json()
    assert len(detail["opinions"]) == 3
    b_row = next(o for o in detail["opinions"] if o["id"] == queued["id"])
    assert b_row["person_id"] == b["id"] and b_row["created_by"] == a["id"]
    assert b_row["campaign_id"] == detail["campaigns"][0]["id"]

    current = sql.execute("SELECT person_id::text, stage, stance FROM opinion_current WHERE property_id = %s"
                          " ORDER BY stage", (pid,)).fetchall()
    assert {(r["person_id"], r["stage"], r["stance"]) for r in current} == {
        (a["id"], "pre_inspection", "yes"), (b["id"], "post_inspection", "no")}


def test_history_tables_are_append_only(client, people, sql):
    pid = quick_add(client, people["a"], address=unique_address(6), campaign={"sale_method": "auction"}).json()["id"]
    client.post(f"/api/properties/{pid}/opinions", headers=as_(people["a"]), json={"stage": "pre_inspection", "stance": "no"})
    with pytest.raises(psycopg.errors.RaiseException, match="append-only"):
        sql.execute("UPDATE opinion SET stance = 'yes' WHERE property_id = %s", (pid,))


def test_writes_without_a_person_are_rejected_by_the_schema(sql):
    with pytest.raises(psycopg.errors.NotNullViolation):
        sql.execute("INSERT INTO tag (name) VALUES ('unattributed')")


def test_edits_are_attributed_in_the_audit_log(client, people, sql):
    pid = quick_add(client, people["a"], address=unique_address(7), campaign=None).json()["id"]
    r = client.patch(f"/api/properties/{pid}", headers=as_(people["b"]), json={"beds": 4})
    assert r.status_code == 200
    row = sql.execute("SELECT person_id::text, old_row->>'beds' AS old, new_row->>'beds' AS new FROM audit_log"
                      " WHERE table_name = 'property' AND row_id = %s AND op = 'U' ORDER BY id DESC LIMIT 1",
                      (pid,)).fetchone()
    assert row == {"person_id": people["b"]["id"], "old": "3", "new": "4"}


def test_campaign_lifecycle_pass_in_then_relist(client, people):
    a = as_(people["a"])
    pid = quick_add(client, people["a"], address=unique_address(8), campaign={"sale_method": "auction"}).json()["id"]
    first = client.get(f"/api/properties/{pid}").json()["campaigns"][0]["id"]

    assert client.post(f"/api/properties/{pid}/campaigns", headers=a, json={"sale_method": "private_sale"}).status_code == 409

    r = client.patch(f"/api/campaigns/{first}", headers=a, json={"outcome": "passed_in", "passed_in_bid_aud": 1_150_000})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/properties/{pid}/campaigns", headers=a, json={"sale_method": "private_sale"})
    assert r.status_code == 201
    campaigns = client.get(f"/api/properties/{pid}").json()["campaigns"]
    assert campaigns[0]["continues_campaign_id"] == first
    assert campaigns[1]["outcome"] == "passed_in" and campaigns[1]["outcome_on"] is not None

    # Sold price on a passed-in campaign breaks a schema rule and comes back as a client error.
    r = client.patch(f"/api/campaigns/{first}", headers=a, json={"sold_price_aud": 1_200_000})
    assert r.status_code == 422


def test_joint_price_judgements_and_guides(client, people):
    a, b = as_(people["a"]), as_(people["b"])
    pid = quick_add(client, people["a"], address=unique_address(9), campaign={"sale_method": "auction"}).json()["id"]
    cid = client.get(f"/api/properties/{pid}").json()["campaigns"][0]["id"]
    client.post(f"/api/campaigns/{cid}/price-guides", headers=a,
                json={"source": "price_statement", "low_aud": 950_000, "high_aud": 1_045_000})
    assert client.post(f"/api/campaigns/{cid}/price-guides", headers=a,
                       json={"source": "agent_verbal", "low_aud": 1_000_000, "high_aud": 900_000}).status_code == 422
    client.post(f"/api/campaigns/{cid}/price-judgements", headers=a, json={"kind": "walk_away", "amount_aud": 1_050_000})
    client.post(f"/api/campaigns/{cid}/price-judgements", headers=b, json={"kind": "walk_away", "amount_aud": 1_080_000})
    campaign = client.get(f"/api/properties/{pid}").json()["campaigns"][0]
    latest = campaign["judgements"][0]
    assert latest["amount_aud"] == 1_080_000 and latest["created_by"] == people["b"]["id"]
    assert campaign["price_guides"][0]["source"] == "price_statement"


def test_agents_are_reused_across_campaigns(client, people):
    a = as_(people["a"])
    ids = []
    for n in (10, 11):
        pid = quick_add(client, people["a"], address=unique_address(n), campaign={"sale_method": "auction"}).json()["id"]
        cid = client.get(f"/api/properties/{pid}").json()["campaigns"][0]["id"]
        r = client.post(f"/api/campaigns/{cid}/agents", headers=a,
                        json={"name": "Jo Agent", "agency_name": "Acme Realty", "office": "Box Hill", "mobile": "0400 000 000"})
        ids.append(r.json()["id"])
    assert ids[0] == ids[1]


def test_status_is_shared_and_filterable(client, people):
    pid = quick_add(client, people["a"], address=unique_address(12), campaign=None).json()["id"]
    client.post(f"/api/properties/{pid}/status", headers=as_(people["b"]), json={"status": "shortlisted"})
    shortlisted = [p["id"] for p in client.get("/api/properties", params={"status": "shortlisted"}).json()]
    assert pid in shortlisted
    assert client.get(f"/api/properties/{pid}").json()["status"] == "shortlisted"


def test_search_matches_normalised_address(client, people):
    quick_add(client, people["a"], address=unique_address(13), campaign=None)
    found = [p["address"] for p in client.get("/api/properties", params={"q": "13 test parade"}).json()]
    assert found == ["13 Test Parade, Mitcham 3132"]


def test_walk_limit_setting(client, people):
    assert client.get("/api/settings").json()["walk_limit_min"] == 20
    assert client.put("/api/settings/walk_limit_min", headers=as_(people["a"]), json={"value": 15}).status_code == 200
    assert client.get("/api/settings").json()["walk_limit_min"] == 15
    assert client.put("/api/settings/walk_limit_min", headers=as_(people["a"]), json={"value": "lots"}).status_code == 422


def test_parse_endpoint(client):
    assert client.get("/api/address/parse", params={"text": "3/12 Smith St, Box Hill VIC 3128"}).json()["unit"] == "3"
    assert client.get("/api/address/parse", params={"text": "???"}).status_code == 422


# ─── schema behaviour the milestone-2 UI will rely on ─────────────────
def pin(sql, person_id, property_id, lon, lat):
    with sql.transaction():
        sql.execute("SELECT set_config('app.person_id', %s, true)", (person_id,))
        sql.execute("UPDATE property SET manual_location = ST_SetSRID(ST_MakePoint(%s, %s), 4326),"
                    " manual_location_by = %s WHERE id = %s", (lon, lat, person_id, property_id))


def test_areas_flag_only_their_owner(client, people, sql):
    a, b = people["a"]["id"], people["b"]["id"]
    pid = quick_add(client, people["a"], address=unique_address(14), campaign=None).json()["id"]
    pin(sql, a, pid, 145.20, -37.82)
    with sql.transaction():
        sql.execute("SELECT set_config('app.person_id', %s, true)", (a,))
        sql.execute("INSERT INTO area (name, kind, geom) VALUES ('Near the freeway', 'hard_exclude',"
                    " ST_Multi(ST_MakeEnvelope(145.19, -37.83, 145.21, -37.81, 4326)))")
    flags = {r["person_id"]: r for r in sql.execute(
        "SELECT person_id::text, excluded, reasons FROM property_flags WHERE property_id = %s", (pid,))}
    assert flags[a]["excluded"] is True and flags[a]["reasons"] == ["Near the freeway"]
    assert flags[b]["excluded"] is False
    hit = sql.execute("SELECT owner_id::text FROM property_area_hit WHERE property_id = %s", (pid,)).fetchone()
    assert hit["owner_id"] == a


def test_travel_estimates_go_stale_when_a_pin_moves(client, people, sql):
    a = people["a"]["id"]
    pid = quick_add(client, people["a"], address=unique_address(15), campaign=None).json()["id"]
    pin(sql, a, pid, 145.10, -37.80)
    with sql.transaction():
        sql.execute("SELECT set_config('app.person_id', %s, true)", (a,))
        sql.execute("INSERT INTO station (osm_id, name, location) VALUES (1, 'Mitcham', ST_SetSRID(ST_MakePoint(145.19, -37.82), 4326))")
        station = sql.execute("INSERT INTO place (kind, name, station_osm_id, location) SELECT 'station', name, osm_id, location"
                              " FROM station WHERE osm_id = 1 RETURNING id").fetchone()["id"]
        sql.execute("INSERT INTO place (kind, name, location) VALUES ('destination', 'Work', ST_SetSRID(ST_MakePoint(144.96, -37.81), 4326))")

    def stale():
        return {(r["name"], r["mode"]) for r in sql.execute(
            "SELECT pl.name, s.mode FROM travel_estimate_stale s JOIN place pl ON pl.id = s.place_id"
            " WHERE s.property_id = %s", (pid,))}

    assert stale() == {("Mitcham", "walk"), ("Work", "walk"), ("Work", "drive")}
    sql.execute("INSERT INTO travel_estimate (property_id, place_id, mode, origin, destination, distance_m, duration_s, engine)"
                " SELECT %s, %s, 'walk', p.location, pl.location, 900, 660, 'test' FROM property p, place pl"
                " WHERE p.id = %s AND pl.id = %s", (pid, station, pid, station))
    assert stale() == {("Work", "walk"), ("Work", "drive")}
    access = sql.execute("SELECT is_nearest, within_limit FROM property_station_access WHERE property_id = %s", (pid,)).fetchone()
    assert access == {"is_nearest": True, "within_limit": True}

    pin(sql, a, pid, 145.11, -37.80)
    assert ("Mitcham", "walk") in stale()


def test_delete_a_person_hands_over_their_records(client, people):
    """Their own verdicts and areas go; the houses, guides and statuses they entered stay, credited to whoever
    deleted them (history tables allow only that change, only then)."""
    a = people["a"]
    c = client.post("/api/persons", json={"display_name": "Temp", "colour": "#123456"}).json()
    pid = client.post("/api/properties", headers=as_(c), json={
        "address": {"street_number": "5", "street": "Handover Road", "suburb": "Blackburn", "postcode": "3130"},
        "campaign": {"sale_method": "private_sale"}}).json()["id"]
    cid = client.get(f"/api/properties/{pid}").json()["campaigns"][0]["id"]
    client.post(f"/api/campaigns/{cid}/price-guides", headers=as_(c), json={"source": "advertised", "low_aud": 900_000, "high_aud": 950_000})
    client.post(f"/api/properties/{pid}/opinions", headers=as_(c), json={"stage": "pre_inspection", "stance": "yes"})
    client.post(f"/api/properties/{pid}/status", headers=as_(c), json={"status": "interested"})
    area = client.post("/api/areas", headers=as_(c), json={"name": "Too far", "kind": "hard_exclude",
                "geometry": {"type": "MultiPolygon", "coordinates": [[[[145, -37.8], [145.01, -37.8], [145.01, -37.81], [145, -37.8]]]]}})
    assert area.status_code == 201, area.text
    assert any(x["properties"]["owner_id"] == c["id"] for x in client.get("/api/map", headers=as_(a)).json()["areas"]["features"])

    assert client.delete(f"/api/persons/{a['id']}", headers=as_(a)).status_code == 409  # not yourself
    r = client.delete(f"/api/persons/{c['id']}", headers=as_(a))
    assert r.status_code == 204, r.text
    assert c["id"] not in [p["id"] for p in client.get("/api/persons").json()]
    p = client.get(f"/api/properties/{pid}").json()
    assert p["status"] == "interested" and p["status_history"][0]["created_by"] == a["id"] and p["opinions"] == []
    assert [g["created_by"] for g in p["campaigns"][0]["price_guides"]] == [a["id"]]
    assert all(x["properties"]["owner_id"] != c["id"] for x in client.get("/api/map", headers=as_(a)).json()["areas"]["features"])


def test_old_status_names_still_work(client, people):
    """A phone still on the app before 0.4.2 sends the old names until it reloads: they're taken as the new ones."""
    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "7", "street": "Renamed Road", "suburb": "Blackburn", "postcode": "3130"}}).json()["id"]
    for old, new in (("bidding", "offering"), ("lost", "missed_out"), ("rejected", "ruled_out")):
        assert client.post(f"/api/properties/{pid}/status", headers=as_(a), json={"status": old}).status_code == 201
        assert client.get(f"/api/properties/{pid}").json()["status"] == new
    assert client.post(f"/api/properties/{pid}/status", headers=as_(a), json={"status": "withdrawn"}).status_code == 422


def test_delete_a_house(client, people):
    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "6", "street": "Mistake Mews", "suburb": "Mitcham", "postcode": "3132"},
        "campaign": {"sale_method": "auction", "auction_at": "2099-10-17T11:00:00+11:00"}}).json()["id"]
    client.post(f"/api/properties/{pid}/opinions", headers=as_(a), json={"stage": "pre_inspection", "stance": "no"})
    assert client.delete(f"/api/properties/{pid}", headers=as_(a)).status_code == 204
    assert client.get(f"/api/properties/{pid}").status_code == 404
    assert all(r["id"] != pid for r in client.get("/api/overview").json()["rows"])
    assert client.delete(f"/api/properties/{pid}", headers=as_(a)).status_code == 404
