"""Campaigns (listings) and what hangs off them: links, price guides, joint price judgements, agents."""

from datetime import date
from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException

from ..db import tx
from ..deps import Person, not_found, update_columns
from ..listing import clean_url, recognise
from ..schemas import AgentIn, CampaignIn, CampaignPatch, JudgementIn, LinkIn, PriceGuideIn

router = APIRouter(prefix="/api")


# ─── helpers shared with quick-add ────────────────────────────────────
def insert_campaign(conn: psycopg.Connection, property_id: UUID, body: CampaignIn) -> UUID:
    live = conn.execute(
        "SELECT id FROM campaign WHERE property_id = %s AND outcome IS NULL", (property_id,)
    ).fetchone()
    if live:
        raise HTTPException(
            409, "This property already has a live campaign. Record its outcome before starting a new one."
        )
    continues = body.continues_campaign_id
    if continues is None:
        # A relist continues the most recent earlier campaign, so price history spans both.
        prev = conn.execute(
            "SELECT id FROM campaign WHERE property_id = %s ORDER BY created_at DESC LIMIT 1", (property_id,)
        ).fetchone()
        continues = prev["id"] if prev else None
    return conn.execute(
        "INSERT INTO campaign (property_id, continues_campaign_id, sale_method, listed_on, auction_at, eoi_closes_at)"
        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (property_id, continues, body.sale_method, body.listed_on, body.auction_at, body.eoi_closes_at),
    ).fetchone()["id"]


def insert_link(conn: psycopg.Connection, campaign_id: UUID, url: str, portal: str | None = None) -> dict:
    url = clean_url(url)
    detected, external_id = recognise(url)
    existing = conn.execute(
        "SELECT l.campaign_id, c.property_id FROM campaign_link l JOIN campaign c ON c.id = l.campaign_id"
        " WHERE l.url = %s OR (l.portal = %s AND l.external_id = %s)",
        (url, detected, external_id),
    ).fetchone()
    if existing:
        raise HTTPException(
            409,
            {
                "message": "That listing is already linked.",
                "existing_property_id": str(existing["property_id"]),
                "existing_campaign_id": str(existing["campaign_id"]),
            },
        )
    return conn.execute(
        "INSERT INTO campaign_link (campaign_id, portal, url, external_id) VALUES (%s, %s, %s, %s)"
        " RETURNING id, portal, url, external_id",
        (campaign_id, portal or detected, url, external_id),
    ).fetchone()


def insert_price_guide(conn: psycopg.Connection, campaign_id: UUID, body: PriceGuideIn) -> dict:
    high = body.high_aud if body.high_aud is not None else body.low_aud
    if high < body.low_aud:
        raise HTTPException(422, "The top of the range is below the bottom.")
    return conn.execute(
        "INSERT INTO price_guide (campaign_id, source, low_aud, high_aud, statement_suburb_median_aud,"
        " observed_at, note) VALUES (%s, %s, %s, %s, %s, coalesce(%s, now()), %s) RETURNING id",
        (campaign_id, body.source, body.low_aud, high, body.statement_suburb_median_aud,
         body.observed_at, body.note),
    ).fetchone()


def campaign_property(conn: psycopg.Connection, campaign_id: UUID) -> UUID:
    row = conn.execute("SELECT property_id FROM campaign WHERE id = %s", (campaign_id,)).fetchone()
    if row is None:
        raise not_found("Campaign")
    return row["property_id"]


# ─── endpoints ────────────────────────────────────────────────────────
@router.post("/properties/{property_id}/campaigns", status_code=201)
def create_campaign(property_id: UUID, body: CampaignIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        return {"id": insert_campaign(conn, property_id, body)}


@router.patch("/campaigns/{campaign_id}")
def update_campaign(campaign_id: UUID, body: CampaignPatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True)
    if "outcome" in values:
        if values["outcome"] is None:
            # Re-opening a campaign clears the whole outcome.
            values.update(outcome_on=None, sold_price_aud=None, passed_in_bid_aud=None, bought_by_us=False)
        elif values.get("outcome_on") is None:
            values["outcome_on"] = date.today()
    with tx(person) as conn:
        if update_columns(conn, "campaign", campaign_id, values) is None:
            raise not_found("Campaign")
        return {"id": campaign_id}


@router.post("/campaigns/{campaign_id}/links", status_code=201)
def add_link(campaign_id: UUID, body: LinkIn, person: Person) -> dict:
    with tx(person) as conn:
        campaign_property(conn, campaign_id)
        return insert_link(conn, campaign_id, body.url, body.portal)


@router.delete("/links/{link_id}", status_code=204)
def remove_link(link_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        if conn.execute("DELETE FROM campaign_link WHERE id = %s RETURNING id", (link_id,)).fetchone() is None:
            raise not_found("Link")


@router.post("/campaigns/{campaign_id}/price-guides", status_code=201)
def add_price_guide(campaign_id: UUID, body: PriceGuideIn, person: Person) -> dict:
    with tx(person) as conn:
        campaign_property(conn, campaign_id)
        return insert_price_guide(conn, campaign_id, body)


@router.post("/campaigns/{campaign_id}/price-judgements", status_code=201)
def add_judgement(campaign_id: UUID, body: JudgementIn, person: Person) -> dict:
    with tx(person) as conn:
        campaign_property(conn, campaign_id)
        return conn.execute(
            "INSERT INTO price_judgement (campaign_id, kind, amount_aud, note) VALUES (%s, %s, %s, %s) RETURNING id",
            (campaign_id, body.kind, body.amount_aud, body.note),
        ).fetchone()


@router.post("/campaigns/{campaign_id}/agents", status_code=201)
def add_agent(campaign_id: UUID, body: AgentIn, person: Person) -> dict:
    with tx(person) as conn:
        campaign_property(conn, campaign_id)
        agency_id = None
        if body.agency_name:
            agency_id = conn.execute(
                "INSERT INTO agency (name, office) VALUES (%s, %s)"
                " ON CONFLICT (name, office) DO UPDATE SET name = EXCLUDED.name RETURNING id",
                (body.agency_name.strip(), (body.office or "").strip() or None),
            ).fetchone()["id"]
        agent = conn.execute(
            "SELECT id FROM agent WHERE lower(name) = lower(%s) AND agency_id IS NOT DISTINCT FROM %s",
            (body.name.strip(), agency_id),
        ).fetchone()
        if agent is None:
            agent = conn.execute(
                "INSERT INTO agent (agency_id, name, mobile, email) VALUES (%s, %s, %s, %s) RETURNING id",
                (agency_id, body.name.strip(), body.mobile, body.email),
            ).fetchone()
        elif body.mobile or body.email:
            conn.execute(
                "UPDATE agent SET mobile = coalesce(%s, mobile), email = coalesce(%s, email) WHERE id = %s",
                (body.mobile, body.email, agent["id"]),
            )
        if body.is_lead:
            conn.execute("UPDATE campaign_agent SET is_lead = false WHERE campaign_id = %s", (campaign_id,))
        conn.execute(
            "INSERT INTO campaign_agent (campaign_id, agent_id, is_lead) VALUES (%s, %s, %s)"
            " ON CONFLICT (campaign_id, agent_id) DO UPDATE SET is_lead = EXCLUDED.is_lead",
            (campaign_id, agent["id"], body.is_lead),
        )
        return {"id": agent["id"]}


@router.delete("/campaigns/{campaign_id}/agents/{agent_id}", status_code=204)
def remove_agent(campaign_id: UUID, agent_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM campaign_agent WHERE campaign_id = %s AND agent_id = %s", (campaign_id, agent_id))
