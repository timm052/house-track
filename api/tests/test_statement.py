"""Reading a Statement of Information. The text below is made up but laid out like the Consumer Affairs Victoria
form (and an agent's report after it), as pypdf reads it; real Statements aren't kept in the repository."""

import pytest

from app import statement

from .conftest import as_

FORM = """Statement of Information
Single residential property located in the Melbourne metropolitan area
Indicative selling price
For the meaning of this price see consumer.vic.gov.au/underquoting
Range between $1,050,000 & $1,150,000
Median sale price
Median price $1,210,000 Property Type House Suburb Example Park
Period - From 01/07/2025 to 30/06/2026 Source REIV
Comparable property sales (*Delete A or B below as applicable)
Address of comparable property Price Date of sale
1 8 Sample Av EXAMPLE PARK 3999 $1,100,000 13/07/2026
2 21 Pretend St EXAMPLE PARK 3999 $1,085,000 02/05/2026
3 4/17 Madeup Rd NORTH EXAMPLE 3998 $990,000 19/06/2026
This Statement of Information was prepared on: 01/09/2026
"""
REPORT = """Comparable sales
8 Sample Av EXAMPLE PARK 3999 (REI)
3 2 2
Price: $1,100,000
Method: Auction Sale
Date: 13/07/2026
Property Type: House (Res)
Land Size: 612 sqm approx
Agent Comments
21 Pretend St EXAMPLE PARK 3999 (VG)
4 - 1
Price: $1,085,000
Method: Sold Before Auction
Date: 02/05/2026
Agent Comments
"""


def test_reads_the_form_and_the_agents_report():
    got = statement.read_text(FORM + REPORT)
    assert (got["indicative_low"], got["indicative_high"], got["median"]) == (1_050_000, 1_150_000, 1_210_000)
    assert str(got["median_from"]) == "2025-07-01" and str(got["median_to"]) == "2026-06-30"
    first, second, third = got["comparables"]
    assert first == {"address": "8 Sample Av, Example Park 3999", "price": 1_100_000, "sold_on": first["sold_on"],
                     "beds": 3, "baths": 2, "car_spaces": 2, "method": "Auction Sale", "land_m2": 612}
    assert str(first["sold_on"]) == "2026-07-13"
    assert second["beds"] == 4 and "baths" not in second and "land_m2" not in second  # land didn't leak from the next one
    assert second["method"] == "Sold Before Auction"
    assert third["address"] == "4/17 Madeup Rd, North Example 3998" and "beds" not in third
    assert got["none_nearby"] is False


def test_single_price_and_no_comparables():
    got = statement.read_text("""Statement of Information
Indicative selling price
Single price $6,900,000
Median price $1,030,000
The estate agent or agent's representative reasonably believes that fewer than three comparable properties were sold
""")
    assert got["indicative_low"] == got["indicative_high"] == 6_900_000
    assert got["comparables"] == [] and got["none_nearby"] is True


def test_anything_else_is_refused():
    with pytest.raises(ValueError):
        statement.read_text("Contract of Sale of Real Estate")


def test_worker_reads_linked_statements_once(client, people, monkeypatch, tmp_path):
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))  # the kept copy is stored here
    from app import worker
    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "5", "street": "Statement St", "suburb": "Example Park", "postcode": "3999"},
        "campaign": {"sale_method": "auction", "auction_at": "2099-10-17T11:00:00+11:00"}}).json()["id"]
    url = "https://p-soi.example.test/soi-5-statement-st.pdf"
    att = client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                      data={"kind": "price_statement", "url": url}).json()["id"]

    downloads = []
    monkeypatch.setattr("app.routes.driveway.download_file",
                        lambda u, *args: (downloads.append(u), (b"%PDF-1.7 made up", "application/pdf"))[1])
    monkeypatch.setattr(statement, "read", lambda pdf: statement.read_text(FORM + REPORT))
    monkeypatch.setattr(worker, "locate_comparable",
                        lambda address: {"lon": 145.1, "lat": -37.8} if address.startswith("8 Sample") else None)
    while worker.read_statements():
        pass
    assert downloads.count(url) == 1  # (other tests' Statements are read too)
    assert worker.read_statements() == 0  # read once

    detail = client.get(f"/api/properties/{pid}").json()
    doc = next(x for x in detail["attachments"] if x["id"] == att)
    assert doc["url"] is None and doc["mime_type"] == "application/pdf"  # kept, so it opens in the app
    campaign = detail["campaigns"][0]
    guide = campaign["price_guides"][0]
    assert (guide["source"], guide["low_aud"], guide["high_aud"], guide["statement_suburb_median_aud"]) == (
        "price_statement", 1_050_000, 1_150_000, 1_210_000)
    comps = client.get(f"/api/campaigns/{campaign['id']}/comparables").json()["entered"]
    assert len(comps) == 3
    placed = next(c for c in comps if c["address"].startswith("8 Sample"))
    assert (placed["lon"], placed["lat"], placed["sale_method"], placed["land_m2"]) == (145.1, -37.8, "Auction Sale", 612)
    assert all(c["attachment_id"] == att for c in comps)

    # The same Statement uploaded again doesn't double up the sales.
    from app.db import tx
    with tx(a["id"]) as conn:
        worker.save_statement(conn, campaign["id"], att, statement.read_text(FORM))
    assert len(client.get(f"/api/campaigns/{campaign['id']}/comparables").json()["entered"]) == 3

    # Updating from the listing again, which still links it, doesn't add it again now that it's kept.
    again = client.post(f"/api/properties/{pid}/listing-update", headers=as_(a), json={"soi_url": url}).json()
    assert again["soi"] == 0 and "Statement of Information" not in again["changes"]
    # The same file under another link is added, then dropped once it's downloaded and found to be the same.
    client.post(f"/api/properties/{pid}/attachments", headers=as_(a), data={"kind": "price_statement", "url": url + "?v=2"})
    while worker.read_statements():
        pass
    docs = [x for x in client.get(f"/api/properties/{pid}").json()["attachments"] if x["kind"] == "price_statement"]
    assert [x["id"] for x in docs] == [att] and docs[0]["source_url"] == url


def test_a_statement_that_cannot_be_read_is_recorded(client, people, monkeypatch, tmp_path):
    monkeypatch.setenv("BLOB_DIR", str(tmp_path))
    from fastapi import HTTPException
    from app import worker
    a = people["a"]
    pid = client.post("/api/properties", headers=as_(a), json={
        "address": {"street_number": "6", "street": "Statement St", "suburb": "Example Park", "postcode": "3999"},
        "campaign": {"sale_method": "auction", "auction_at": "2099-10-17T11:00:00+11:00"}}).json()["id"]
    client.post(f"/api/properties/{pid}/attachments", headers=as_(a),
                data={"kind": "price_statement", "url": "https://p-soi.example.test/gone.pdf"})

    def refuse(*args):
        raise HTTPException(502, "Couldn't download the Statement of Information (403).")
    monkeypatch.setattr("app.routes.driveway.download_file", refuse)
    while worker.read_statements():
        pass
    from app.db import tx
    with tx() as conn:
        row = conn.execute("""SELECT r.error FROM statement_read r JOIN attachment a ON a.id = r.attachment_id
                              WHERE a.property_id = %s""", (pid,)).fetchone()
    assert "403" in row["error"]
