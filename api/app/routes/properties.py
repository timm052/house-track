"""Properties: list, quick-add, detail, edit, opinions and shared status."""

from dataclasses import asdict
from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException

from .. import gnaf, listing_apply
from ..address import Address, address_key, display, normalise, parse
from ..db import tx
from ..deps import OptionalPerson, Person, not_found, update_columns
from ..schemas import AddressIn, OpinionIn, PriceGuideIn, PropertyIn, PropertyPatch, Stage, Status, StatusIn
from .campaigns import insert_campaign, insert_link, insert_price_guide
from .driveway import attachments_for, inspections_for, save_photos_later
from .geo import travel_for
from .overlays import overlays_for
from ..overview import _conflict as conflict, _same as same


router = APIRouter(prefix="/api")

ADDRESS_FIELDS = ("unit", "street_number", "street", "suburb", "postcode", "plan_number", "lot_number")

PROPERTY_COLUMNS = """
    p.id, p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number,
    p.gnaf_pid, p.property_type, p.build_status, p.beds, p.baths, p.car_spaces, p.land_m2,
    p.building_m2, p.owners_corp_fees_aud_pa, p.council_rates_aud_pa, p.notes,
    ST_Y(p.location) AS lat, ST_X(p.location) AS lon, p.manual_location IS NOT NULL AS manual_pin,
    p.geocode_source, p.geocode_confidence, coalesce(p.geocode_detail->>'status', 'pending') AS geocode_status,
    p.created_at, p.updated_at
"""

# Clearing these makes the worker geocode the new address (app/worker.py).
RESET_GEOCODE = {"gnaf_pid": None, "geocoded_location": None, "geocode_source": None,
                 "geocode_confidence": None, "geocode_detail": None}


def with_address(row: dict) -> dict:
    row["address"] = display(Address(**{k: row[k] for k in ADDRESS_FIELDS}))
    return row


def to_address(body: AddressIn) -> Address:
    return normalise(Address(**body.model_dump()))


def find_duplicate(conn: psycopg.Connection, a: Address, exclude: UUID | None = None) -> UUID | None:
    row = conn.execute(
        "SELECT id FROM property WHERE (address_key = %s OR (plan_number = %s AND lot_number = %s))"
        " AND id IS DISTINCT FROM %s LIMIT 1",
        (address_key(a), a.plan_number, a.lot_number, exclude),
    ).fetchone()
    return row["id"] if row else None


def duplicate_error(existing: UUID) -> HTTPException:
    # Relist recognition: the UI offers to open the existing property and add a new campaign there.
    return HTTPException(
        409, {"message": "This house is already in House Track.", "existing_property_id": str(existing)}
    )


@router.get("/address/parse")
def parse_address(text: str) -> dict:
    a = parse(text)
    if a is None:
        raise HTTPException(422, "Couldn't split that address. Fill in the fields instead.")
    return asdict(a)


@router.get("/properties")
def list_properties(person: OptionalPerson, status: Status | None = None, q: str | None = None) -> list[dict]:
    pattern = f"%{' '.join(q.lower().split())}%" if q else None
    with tx() as conn:
        rows = conn.execute(
            f"""
            SELECT {PROPERTY_COLUMNS}, s.status,
                   c.id AS campaign_id, c.sale_method, c.listed_on, c.auction_at, c.eoi_closes_at,
                   c.outcome, c.sold_price_aud,
                   g.low_aud AS guide_low_aud, g.high_aud AS guide_high_aud,
                   coalesce(o.opinions, '[]'::jsonb) AS opinions,
                   ns.name AS nearest_station, ns.walk_s AS nearest_station_walk_s, ns.drive_s AS nearest_station_drive_s,
                   coalesce(f.excluded, false) AS excluded, coalesce(f.warned, false) AS warned
            FROM property p
            JOIN property_status s ON s.property_id = p.id
            LEFT JOIN LATERAL (
                SELECT * FROM campaign c WHERE c.property_id = p.id
                ORDER BY (c.outcome IS NULL) DESC, c.created_at DESC LIMIT 1) c ON true
            LEFT JOIN LATERAL (
                SELECT low_aud, high_aud FROM price_guide g WHERE g.campaign_id = c.id
                ORDER BY observed_at DESC, id DESC LIMIT 1) g ON true
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(jsonb_build_object('person_id', person_id, 'stage', stage, 'stance', stance)) AS opinions
                FROM opinion_current oc WHERE oc.property_id = p.id) o ON true
            LEFT JOIN property_nearest_station ns ON ns.property_id = p.id
            LEFT JOIN property_flags f ON f.property_id = p.id AND f.person_id = %(me)s
            WHERE (%(status)s::text IS NULL OR s.status = %(status)s)
              AND (%(pattern)s::text IS NULL OR p.address_key LIKE %(pattern)s OR lower(p.suburb) LIKE %(pattern)s)
            ORDER BY coalesce(c.auction_at, c.eoi_closes_at) NULLS LAST, p.created_at DESC
            """,
            {"status": status, "pattern": pattern, "me": person},
        ).fetchall()
    return [with_address(r) for r in rows]


@router.post("/properties", status_code=201)
def create_property(body: PropertyIn, person: Person) -> dict:
    a = to_address(body.address)
    hit = gnaf.by_pid(body.gnaf_pid) if body.gnaf_pid else None
    with tx(person) as conn:
        if (existing := find_duplicate(conn, a)) is not None:
            raise duplicate_error(existing)
        property_id = conn.execute(
            """INSERT INTO property (address_key, unit, street_number, street, suburb, postcode,
                   plan_number, lot_number, property_type, build_status, beds, baths, car_spaces,
                   land_m2, building_m2, notes)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (address_key(a), a.unit, a.street_number, a.street, a.suburb, a.postcode, a.plan_number,
             a.lot_number, body.property_type, body.build_status, body.beds, body.baths, body.car_spaces,
             body.land_m2, body.building_m2, body.notes),
        ).fetchone()["id"]
        conn.execute("INSERT INTO status_event (property_id, status) VALUES (%s, 'watching')", (property_id,))
        if hit is not None:
            # Picked from G-NAF autocomplete: pinned straight away; otherwise the worker geocodes it.
            conn.execute(
                """UPDATE property SET gnaf_pid = %s, geocoded_location = ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                       geocode_source = 'gnaf', geocode_confidence = %s,
                       geocode_detail = jsonb_build_object('status', 'done', 'geocode_type', %s::text)
                   WHERE id = %s""",
                (hit["pid"], hit["lon"], hit["lat"], gnaf.confidence_for(hit["geocode_type"]),
                 hit["geocode_type"], property_id),
            )
        if (c := body.campaign) is not None:
            campaign_id = insert_campaign(conn, property_id, c)
            if c.url:
                insert_link(conn, campaign_id, c.url)
            if c.guide_low_aud:
                insert_price_guide(
                    conn, campaign_id,
                    PriceGuideIn(source="advertised", low_aud=c.guide_low_aud, high_aud=c.guide_high_aud),
                )
        else:
            campaign_id = None
        if body.listing is not None:
            listing_apply.apply(conn, property_id, campaign_id, body.listing)
    if body.listing is not None and (body.listing.photos or body.listing.floorplans):
        save_photos_later(property_id, person, body.listing.photos, body.listing.floorplans)
    return {"id": property_id}


@router.get("/properties/{property_id}")
def get_property(property_id: UUID) -> dict:
    with tx() as conn:
        prop = conn.execute(
            f"SELECT {PROPERTY_COLUMNS} FROM property p WHERE p.id = %s", (property_id,)
        ).fetchone()
        if prop is None:
            raise not_found("Property")
        with_address(prop)
        prop["status_history"] = conn.execute(
            "SELECT id, status, reason, occurred_at, created_by FROM status_event"
            " WHERE property_id = %s ORDER BY occurred_at DESC, id DESC",
            (property_id,),
        ).fetchall()
        prop["status"] = prop["status_history"][0]["status"] if prop["status_history"] else "watching"
        prop["to_inspect"] = conn.execute("SELECT 1 FROM inspect_list WHERE property_id = %s", (property_id,)).fetchone() is not None
        prop["opinions"] = conn.execute(
            "SELECT id, person_id, campaign_id, stage, stance, note, recorded_at, created_by FROM opinion"
            " WHERE property_id = %s ORDER BY recorded_at DESC, id DESC",
            (property_id,),
        ).fetchall()
        campaigns = conn.execute(
            "SELECT id, continues_campaign_id, sale_method, listed_on, auction_at, eoi_closes_at, outcome,"
            " outcome_on, sold_price_aud, passed_in_bid_aud, bought_by_us, listing_status, listing_price_text, created_at FROM campaign"
            " WHERE property_id = %s ORDER BY created_at DESC",
            (property_id,),
        ).fetchall()
        ids = [c["id"] for c in campaigns]
        children = {
            "links": "SELECT campaign_id, id, portal, url, external_id FROM campaign_link"
                     " WHERE campaign_id = ANY(%s) ORDER BY created_at",
            "price_guides": "SELECT campaign_id, id, source, low_aud, high_aud, statement_suburb_median_aud,"
                            " observed_at, note, created_by FROM price_guide WHERE campaign_id = ANY(%s)"
                            " ORDER BY observed_at DESC, id DESC",
            "judgements": "SELECT campaign_id, id, kind, amount_aud, note, created_at, created_by"
                          " FROM price_judgement WHERE campaign_id = ANY(%s) ORDER BY created_at DESC, id DESC",
            "agents": "SELECT ca.campaign_id, a.id, a.name, a.mobile, a.email, ca.is_lead,"
                      " ag.name AS agency_name, ag.office FROM campaign_agent ca JOIN agent a ON a.id = ca.agent_id"
                      " LEFT JOIN agency ag ON ag.id = a.agency_id WHERE ca.campaign_id = ANY(%s)"
                      " ORDER BY ca.is_lead DESC, a.name",
        }
        for c in campaigns:
            for key in children:
                c[key] = []
        by_id = {c["id"]: c for c in campaigns}
        for key, query in children.items():
            for row in conn.execute(query, (ids,)).fetchall():
                by_id[row.pop("campaign_id")][key].append(row)
        prop["campaigns"] = campaigns
        prop["travel"] = travel_for(conn, property_id)
        prop["inspections"] = inspections_for(conn, property_id)
        prop["attachments"] = attachments_for(conn, property_id)
        cover = conn.execute("SELECT attachment_id FROM property_cover WHERE property_id = %s", (property_id,)).fetchone()
        prop["cover_id"] = cover and cover["attachment_id"]
        prop["overlays"] = overlays_for(conn, property_id)
        prop["tags"] = [r["name"] for r in conn.execute(
            "SELECT t.name FROM property_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.property_id = %s ORDER BY lower(t.name)",
            (property_id,))]
    return prop


EXPECTABLE = {"unit", "street_number", "street", "suburb", "postcode", "plan_number", "lot_number", "property_type",
              "build_status", "beds", "baths", "car_spaces", "land_m2", "building_m2", "owners_corp_fees_aud_pa",
              "council_rates_aud_pa", "notes"}


def check_expected(conn: psycopg.Connection, property_id: UUID, expected: dict) -> None:
    """The same "someone changed this since you loaded it" check the Overview grid makes, for a form save."""
    row = conn.execute("SELECT * FROM property WHERE id = %s", (property_id,)).fetchone()
    if row is None:
        raise not_found("Property")
    for field, seen in expected.items():
        if field in EXPECTABLE and not same(row[field], seen):
            raise conflict(field, row[field], row["updated_by"], row["updated_at"], conn)


@router.patch("/properties/{property_id}")
def update_property(property_id: UUID, body: PropertyPatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True, exclude={"address", "expected"})
    with tx(person) as conn:
        if body.expected:
            check_expected(conn, property_id, body.expected)
        if body.address is not None:
            a = to_address(body.address)
            if (existing := find_duplicate(conn, a, exclude=property_id)) is not None:
                raise duplicate_error(existing)
            values |= {k: getattr(a, k) for k in ADDRESS_FIELDS} | {"address_key": address_key(a)}
            current = conn.execute("SELECT address_key FROM property WHERE id = %s", (property_id,)).fetchone()
            if current and current["address_key"] != values["address_key"]:
                values |= RESET_GEOCODE
        if update_columns(conn, "property", property_id, values) is None:
            raise not_found("Property")
    return {"id": property_id}


@router.delete("/properties/{property_id}", status_code=204)
def delete_property(property_id: UUID, person: Person) -> None:
    """For mistakes and duplicates: the house and everything recorded about it (audited; photo files stay in the
    blob store and backups). A house you've decided against keeps its history: set its status instead."""
    with tx(person) as conn:
        if conn.execute("DELETE FROM property WHERE id = %s RETURNING id", (property_id,)).fetchone() is None:
            raise not_found("Property")


@router.post("/properties/{property_id}/opinions", status_code=201)
def add_opinion(property_id: UUID, body: OpinionIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        if body.expected_latest_id is not None or body.check_latest:
            # Offline queue (PLAN.md D17): refuse if this verdict changed after the phone last saw it.
            latest = conn.execute(
                "SELECT id, stance, created_by, created_at FROM opinion_current WHERE property_id = %s AND person_id = %s AND stage = %s",
                (property_id, body.person_id or person, body.stage)).fetchone()
            seen = latest and latest["id"]
            if seen != body.expected_latest_id and not (latest and latest["id"] == body.id):
                who = latest and conn.execute("SELECT display_name FROM person WHERE id = %s", (latest["created_by"],)).fetchone()
                raise HTTPException(409, {"message": "This verdict changed since your phone last synced.",
                                          "current": latest and latest["stance"], "changed_by": who and who["display_name"],
                                          "changed_at": latest and latest["created_at"].isoformat()})
        campaign_id = body.campaign_id
        if campaign_id is None:
            live = conn.execute(
                "SELECT id FROM campaign WHERE property_id = %s AND outcome IS NULL", (property_id,)
            ).fetchone()
            campaign_id = live["id"] if live else None
        # ON CONFLICT DO NOTHING makes a replayed offline write a no-op.
        row = conn.execute(
            "INSERT INTO opinion (id, property_id, campaign_id, person_id, stage, stance, note, recorded_at)"
            " VALUES (coalesce(%s, uuidv7()), %s, %s, %s, %s, %s, %s, coalesce(%s, now()))"
            " ON CONFLICT (id) DO NOTHING RETURNING id",
            (body.id, property_id, campaign_id, body.person_id or person, body.stage, body.stance,
             body.note, body.recorded_at),
        ).fetchone()
    return {"id": row["id"] if row else body.id}


@router.delete("/properties/{property_id}/opinions", status_code=204)
def clear_opinion(property_id: UUID, person_id: UUID, stage: Stage, person: Person) -> None:
    """Take back a verdict: someone's before- or after-inspecting verdict and its history go, so the house shows no
    verdict from them for that stage (and comes back to Rate). Each deleted entry is kept in the audit log."""
    with tx(person) as conn:
        conn.execute("DELETE FROM opinion WHERE property_id = %s AND person_id = %s AND stage = %s", (property_id, person_id, stage))


@router.delete("/opinions/{opinion_id}", status_code=204)
def delete_opinion(opinion_id: UUID, person: Person) -> None:
    """One entry from a verdict's history, say a mistaken tap; the one before it becomes current again."""
    with tx(person) as conn:
        if conn.execute("DELETE FROM opinion WHERE id = %s RETURNING id", (opinion_id,)).fetchone() is None:
            raise not_found("Verdict")


# ─── the "To inspect" list ─────────────────────────────────────────────
@router.put("/properties/{property_id}/inspect-list")
def add_to_inspect(property_id: UUID, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        conn.execute("INSERT INTO inspect_list (property_id) VALUES (%s) ON CONFLICT (property_id) DO NOTHING", (property_id,))
    return {"id": property_id, "to_inspect": True}


@router.delete("/properties/{property_id}/inspect-list", status_code=204)
def remove_from_inspect(property_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM inspect_list WHERE property_id = %s", (property_id,))


@router.post("/properties/{property_id}/shortlist")
def shortlist(property_id: UUID, person: Person) -> dict:
    """Swiped up in Rate: onto the shortlist (unless it's already further along, say offering) and the To inspect
    list. Safe to repeat, so it can wait in the offline outbox."""
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        now = conn.execute("SELECT status FROM property_status WHERE property_id = %s", (property_id,)).fetchone()
        status = now["status"] if now else "watching"
        if status in ("watching", "interested"):
            conn.execute("INSERT INTO status_event (property_id, status, reason) VALUES (%s, 'shortlisted', 'Shortlisted in Rate')",
                         (property_id,))
            status = "shortlisted"
        added = conn.execute("INSERT INTO inspect_list (property_id) VALUES (%s) ON CONFLICT (property_id) DO NOTHING",
                             (property_id,)).rowcount
        if added:
            who = conn.execute("SELECT display_name FROM person WHERE id = %s", (person,)).fetchone()
            p = conn.execute("SELECT unit, street_number, street, suburb, postcode, plan_number, lot_number FROM property WHERE id = %s",
                             (property_id,)).fetchone()
    if added:
        from .. import push
        from ..address import Address, display
        push.send("shortlist", f"{who['display_name'] if who else 'Someone'} shortlisted a house",
                  display(Address(**p)).split(",")[0] + f", {p['suburb']}", f"/p/{property_id}", exclude=person)
    return {"id": property_id, "status": status, "to_inspect": True}


@router.post("/properties/{property_id}/status", status_code=201)
def set_status(property_id: UUID, body: StatusIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        if body.check_latest:
            latest = conn.execute("SELECT id, status, created_by, created_at FROM status_event WHERE property_id = %s"
                                  " ORDER BY occurred_at DESC, id DESC LIMIT 1", (property_id,)).fetchone()
            if latest and latest["id"] != body.expected_latest_id:
                raise conflict("status", latest["status"], latest["created_by"], latest["created_at"], conn)
        return conn.execute(
            "INSERT INTO status_event (property_id, status, reason) VALUES (%s, %s, %s) RETURNING id",
            (property_id, body.status, body.reason),
        ).fetchone()
