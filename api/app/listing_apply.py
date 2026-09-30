"""Saving what a listing capture found, once the person has ticked what they want (PLAN.md D12).

Idempotent, so the same listing can be captured again to pick up what changed: agents, inspections, links and
photos already there are skipped, and a price guide is only added when it differs from the latest one.
"""

import re
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg

from .routes.campaigns import attach_agent, insert_price_guide, set_sale_method
from .routes.tags import ensure_tags
from .deps import update_columns
from .schemas import AgentIn, ListingExtras, ListingUpdateIn, PriceGuideIn

MELBOURNE = ZoneInfo("Australia/Melbourne")
DETAILS = (("beds", "Bedrooms"), ("baths", "Bathrooms"), ("car_spaces", "Car spaces"), ("land_m2", "Land"), ("building_m2", "Building"))
METHODS = {"auction": "auction", "eoi": "expressions of interest", "private_sale": "private sale", "other": "another way"}


def apply(conn: psycopg.Connection, property_id: UUID, campaign_id: UUID | None, x: ListingExtras) -> dict:
    added = {"agents": 0, "inspections": 0, "soi": 0, "tags": 0, "pinned": False, "agent_names": [], "inspection_times": []}
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
                added["agent_names"].append(agent.name.strip())
        # Already here if it's still a link, or a copy kept from that link (see migration 0016).
        if x.soi_url and not conn.execute("SELECT 1 FROM attachment WHERE property_id = %s AND %s IN (url, source_url)",
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
            added["inspection_times"].append(i.starts_at)
    for tag_id in ensure_tags(conn, x.tags):
        added["tags"] += conn.execute("INSERT INTO property_tag (property_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                                      (property_id, tag_id)).rowcount
    return added


def money(n: int) -> str:
    return f"${n / 1_000_000:.3f}".rstrip("0").rstrip(".") + "m" if n >= 1_000_000 else f"${round(n / 1000)}k"


def money_range(low: int, high: int | None) -> str:
    return money(low) + (f"–{money(high)}" if high and high != low else "")


def when(t: datetime) -> str:
    t = t.astimezone(MELBOURNE)
    return f"{t:%a} {t.day} {t:%b}, {t.hour % 12 or 12}:{t.minute:02d} {'am' if t.hour < 12 else 'pm'}"


def on(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def detail(field: str, v: int) -> str:
    if field == "land_m2":
        return f"{v / 10_000:.2f}".rstrip("0").rstrip(".") + " ha" if v >= 10_000 else f"{v:,} m²"
    return f"{v:,} m²" if field == "building_m2" else str(v)


def refresh(conn: psycopg.Connection, property_id: UUID, body: ListingUpdateIn) -> dict:
    """A tracked house, captured again: apply the extras, record a new guide, sale method or date if it changed,
    and correct rooms and areas (see apply_details). Returns what it did, including `changes`, sentences for
    people, which the + House Track panel (as a preview) and the weekly refresh both show."""
    live = conn.execute("""SELECT id, sale_method, listed_on, auction_at, eoi_closes_at, listing_status FROM campaign
                           WHERE property_id = %s AND outcome IS NULL""", (property_id,)).fetchone()
    added = apply(conn, property_id, live and live["id"], body)
    added.update(guide=False, date=False, method=None, listed=False, details=[], differs=[])
    changes: list[str] = []

    prop = conn.execute("SELECT " + ", ".join(f for f, _ in DETAILS) + " FROM property WHERE id = %s", (property_id,)).fetchone()
    for field, label in DETAILS:
        listed = getattr(body, field)
        if listed is not None and prop and listed != prop[field]:
            was = f" (was {detail(field, prop[field])})" if prop[field] is not None else ""
            if body.apply_details or (body.fill_missing and prop[field] is None):
                added["details"].append(field)
                changes.append(f"{label}: {detail(field, listed)}{was}")
            else:
                have = detail(field, prop[field]) if prop[field] is not None else "nothing"
                added["differs"].append(f"The listing says {label.lower()} {detail(field, listed)}; you have {have}")
    if added["details"]:
        update_columns(conn, "property", property_id, {f: getattr(body, f) for f in added["details"]})

    was_status = listing_state(live and live["listing_status"])
    if live is not None and (body.listing_status or body.listing_price_text):
        if listing_state(body.listing_status) == "underoffer" and was_status != "underoffer":
            changes.append("Now under offer")
        conn.execute("""UPDATE campaign SET listing_status = %s, listing_price_text = %s, listing_checked_at = now()
                        WHERE id = %s""", (body.listing_status, body.listing_price_text, live["id"]))

    if live is not None:
        method = live["sale_method"]
        if body.sale_method and body.sale_method != method:
            # The listing changed how it's selling: switch, dropping the date that belonged to the old method.
            method = body.sale_method
            set_sale_method(conn, live["id"], method)
            live = conn.execute("SELECT id, sale_method, listed_on, auction_at, eoi_closes_at FROM campaign WHERE id = %s",
                                (live["id"],)).fetchone()
            added["method"] = method
            changes.append(f"Now selling by {METHODS.get(method, method)}")
        # When it went on the market, for days listed: filled in if missing, corrected when a person updates.
        if body.listed_on and body.listed_on != live["listed_on"] and (live["listed_on"] is None or body.apply_details):
            conn.execute("UPDATE campaign SET listed_on = %s WHERE id = %s", (body.listed_on, live["id"]))
            added["listed"] = True
            changes.append(f"Listed {on(body.listed_on)}" + (f" (was {on(live['listed_on'])})" if live["listed_on"] else ""))
        if body.guide_low_aud:
            latest = conn.execute("SELECT low_aud, high_aud FROM price_guide WHERE campaign_id = %s ORDER BY observed_at DESC, id DESC LIMIT 1",
                                  (live["id"],)).fetchone()
            high = body.guide_high_aud or body.guide_low_aud
            if latest is None or (latest["low_aud"], latest["high_aud"]) != (body.guide_low_aud, high):
                insert_price_guide(conn, live["id"], PriceGuideIn(source="advertised", low_aud=body.guide_low_aud, high_aud=high,
                                                                  note="From the listing"))
                added["guide"] = True
                changes.append(f"New price guide {money_range(body.guide_low_aud, high)}"
                               + (f" (was {money_range(latest['low_aud'], latest['high_aud'])})" if latest else ""))
        for col, needs, label in (("auction_at", "auction", "Auction"), ("eoi_closes_at", "eoi", "EOI closes")):
            value = getattr(body, col)
            if value is not None and method == needs and live[col] != value:
                conn.execute(f"UPDATE campaign SET {col} = %s WHERE id = %s", (value, live["id"]))
                added["date"] = True
                changes.append(f"{label} {when(value)}" + (f" (was {when(live[col])})" if live[col] else ""))

    if added["inspection_times"]:
        n = len(added["inspection_times"])
        changes.append(f"{n} new inspection {'time' if n == 1 else 'times'}: " + " · ".join(when(t) for t in added["inspection_times"]))
    if added["agent_names"]:
        changes.append("Agents: " + ", ".join(added["agent_names"]))
    if added["soi"]:
        changes.append("Statement of Information")
    if added["tags"]:
        changes.append(f"{added['tags']} {'tag' if added['tags'] == 1 else 'tags'} added")
    if added["pinned"]:
        changes.append("Pinned from the listing's map position")
    if live is not None and listing_state(body.listing_status) == "sold":
        changes.append(record_sale(conn, property_id, live, body.sold_price_aud))
    elif live is None and body.sold_price_aud:
        # Sold already, with the price held back at the time: the listing shows it now.
        late = conn.execute("""UPDATE campaign SET sold_price_aud = %s
                               WHERE id = (SELECT id FROM campaign WHERE property_id = %s AND outcome LIKE 'sold%%'
                                           ORDER BY outcome_on DESC, created_at DESC LIMIT 1) AND sold_price_aud IS NULL
                               RETURNING id""", (body.sold_price_aud, property_id)).fetchone()
        if late:
            changes.append(f"Sold price: {money(body.sold_price_aud)}")
    added["changes"] = changes
    return added


def listing_state(s: str | None) -> str:
    """What a listing says about itself, whatever the spelling: "Under offer", "under_offer" → "underoffer"."""
    return re.sub(r"[^a-z]", "", (s or "").lower())


def record_sale(conn: psycopg.Connection, property_id: UUID, live: dict, price: int | None) -> str:
    """The listing says it sold: record the outcome (with the price, when the listing shows it), so nobody has to.
    Sold before an auction date still to come is "sold prior"; otherwise at auction, or plain sold for other methods.
    If we were offering on it, the house moves to Sold too (bought is for a person to say)."""
    now = datetime.now(MELBOURNE)
    auction = live["sale_method"] == "auction" and live["auction_at"]
    outcome = ("sold_prior" if auction and live["auction_at"] > now else "sold_at_auction" if auction else "sold")
    sold_on = live["auction_at"].astimezone(MELBOURNE).date() if outcome == "sold_at_auction" else now.date()
    conn.execute("UPDATE campaign SET outcome = %s, outcome_on = %s, sold_price_aud = %s WHERE id = %s",
                 (outcome, sold_on, price, live["id"]))
    status = conn.execute("SELECT status FROM property_status WHERE property_id = %s", (property_id,)).fetchone()
    if status and status["status"] == "offering":
        conn.execute("INSERT INTO status_event (property_id, status, reason) VALUES (%s, 'missed_out', 'The listing says it sold')",
                     (property_id,))
    return "Sold" + (f" for {money(price)}" if price else "") + ": recorded"

