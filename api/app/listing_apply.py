"""Saving what a listing capture found, once the person has ticked what they want (PLAN.md D12).

Idempotent, so the same listing can be captured again to pick up what changed: agents, inspections, links and
photos already there are skipped, and a price guide is only added when it differs from the latest one.
"""

from uuid import UUID

import psycopg

from .routes.campaigns import attach_agent, insert_price_guide
from .routes.tags import ensure_tags
from .schemas import AgentIn, ListingExtras, ListingUpdateIn, PriceGuideIn


def apply(conn: psycopg.Connection, property_id: UUID, campaign_id: UUID | None, x: ListingExtras) -> dict:
    added = {"agents": 0, "inspections": 0, "soi": 0, "tags": 0, "pinned": False}
    if x.lat is not None and x.lon is not None:
        # Only when nothing better is known: G-NAF and hand-placed pins win over the listing's map position.
        row = conn.execute(
            """UPDATE property SET geocoded_location = ST_SetSRID(ST_MakePoint(%s, %s), 4326), geocode_source = 'listing',
                   geocode_confidence = 0.8, geocode_detail = jsonb_build_object('status', 'done', 'source', 'listing')
               WHERE id = %s AND geocoded_location IS NULL AND manual_location IS NULL RETURNING id""",
            (x.lon, x.lat, property_id)).fetchone()
        added["pinned"] = row is not None
    if campaign_id is not None:
        for i, agent in enumerate(x.agents):
            known = conn.execute("""SELECT 1 FROM campaign_agent ca JOIN agent a ON a.id = ca.agent_id
                                    WHERE ca.campaign_id = %s AND lower(a.name) = lower(%s)""", (campaign_id, agent.name.strip())).fetchone()
            if not known:
                attach_agent(conn, campaign_id, AgentIn(**{**agent.model_dump(), "is_lead": i == 0 and not added["agents"]}))
                added["agents"] += 1
        if x.soi_url and not conn.execute("SELECT 1 FROM attachment WHERE property_id = %s AND url = %s",
                                          (property_id, x.soi_url)).fetchone():
            conn.execute("""INSERT INTO attachment (property_id, campaign_id, kind, url, caption)
                            VALUES (%s, %s, 'price_statement', %s, 'Statement of Information (from the listing)')""",
                         (property_id, campaign_id, x.soi_url))
            added["soi"] = 1
    for i in x.inspections:
        if not conn.execute("SELECT 1 FROM inspection WHERE property_id = %s AND starts_at = %s", (property_id, i.starts_at)).fetchone():
            conn.execute("""INSERT INTO inspection (property_id, campaign_id, kind, starts_at, ends_at, state)
                            VALUES (%s, %s, 'open', %s, coalesce(%s, %s + interval '30 minutes'), 'planned')""",
                         (property_id, campaign_id, i.starts_at, i.ends_at, i.starts_at))
            added["inspections"] += 1
    for tag_id in ensure_tags(conn, x.tags):
        added["tags"] += conn.execute("INSERT INTO property_tag (property_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                      (property_id, tag_id)).rowcount
    return added


def refresh(conn: psycopg.Connection, property_id: UUID, body: ListingUpdateIn) -> dict:
    """A tracked house, captured again: apply the extras, and record a new guide or sale date if it changed."""
    live = conn.execute("SELECT id, sale_method, auction_at, eoi_closes_at FROM campaign WHERE property_id = %s AND outcome IS NULL",
                        (property_id,)).fetchone()
    added = apply(conn, property_id, live and live["id"], body)
    added["guide"] = False
    added["date"] = False
    added["method"] = None
    if live is None:
        return added
    method = live["sale_method"]
    if body.sale_method and body.sale_method != method:
        # The listing changed how it's selling: switch, and drop the date that belonged to the old method
        # (a campaign can only carry an auction date when it's an auction, an EOI date when it's an EOI).
        method = body.sale_method
        conn.execute("""UPDATE campaign SET sale_method = %s,
                            auction_at = CASE WHEN %s = 'auction' THEN auction_at END,
                            eoi_closes_at = CASE WHEN %s = 'eoi' THEN eoi_closes_at END,
                            passed_in_bid_aud = CASE WHEN %s = 'auction' THEN passed_in_bid_aud END
                        WHERE id = %s""", (method, method, method, method, live["id"]))
        live = conn.execute("SELECT id, sale_method, auction_at, eoi_closes_at FROM campaign WHERE id = %s", (live["id"],)).fetchone()
        added["method"] = method
    if body.guide_low_aud:
        latest = conn.execute("SELECT low_aud, high_aud FROM price_guide WHERE campaign_id = %s ORDER BY observed_at DESC, id DESC LIMIT 1",
                              (live["id"],)).fetchone()
        high = body.guide_high_aud or body.guide_low_aud
        if latest is None or (latest["low_aud"], latest["high_aud"]) != (body.guide_low_aud, high):
            insert_price_guide(conn, live["id"], PriceGuideIn(source="advertised", low_aud=body.guide_low_aud, high_aud=high,
                                                              note="From the listing"))
            added["guide"] = True
    for col, needs in (("auction_at", "auction"), ("eoi_closes_at", "eoi")):
        value = getattr(body, col)
        if value is not None and method == needs and live[col] != value:
            conn.execute(f"UPDATE campaign SET {col} = %s WHERE id = %s", (value, live["id"]))
            added["date"] = True
    return added
