"""The Overview grid (PLAN.md D15-D17): one flat row per house, and single-cell writes with
per-field conflict checks.

Each row carries `_v`, the version the client saw for every editable cell: the plain value for
ordinary fields, or the latest entry's id for history fields (status, verdicts, guides, joint
figures). A write sends that back as `expected`; if the field changed underneath, the write is
refused with the current value, who changed it and when.
"""

import os
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from fastapi import HTTPException

from . import blocks
from .address import Address, display

STAGES = {"pre": "pre_inspection", "post": "post_inspection"}
JUDGEMENTS = ("estimated_reserve", "expected_sale", "walk_away")
PROPERTY_FIELDS = {
    "property_type": str, "build_status": str, "beds": int, "baths": int, "car_spaces": int, "land_m2": int,
    "building_m2": int, "owners_corp_fees_aud_pa": int, "council_rates_aud_pa": int, "notes": str,
}
CAMPAIGN_FIELDS = {"sale_method": str, "listed_on": date, "outcome": str, "sold_price_aud": int,
                   "passed_in_bid_aud": int}


def _day(t: datetime | None) -> date | None:
    """Calendar date in the household's time zone (a 9 am Melbourne change is not "yesterday")."""
    return t.astimezone(ZoneInfo(os.environ.get("TZ", "Australia/Melbourne"))).date() if t else None


def _street(r: dict) -> str:
    if r["street_number"]:
        return f"{r['unit']}/{r['street_number']} {r['street']}" if r["unit"] else f"{r['street_number']} {r['street']}"
    return f"Lot {r['lot_number']} {r['street'] or ''}".strip()


def _mins(seconds: int | None) -> int | None:
    return None if seconds is None else max(1, round(seconds / 60))


def _mid(low: int | None, high: int | None) -> float | None:
    return None if low is None else (low + (high or low)) / 2


ENDED_ON_LISTING = {"sold", "archived", "offmarket", "withdrawn", "leased"}


def _needs_outcome(c: dict | None, sale_at: datetime | None) -> bool:
    """A live campaign whose auction or EOI has been and gone, or whose listing says it's over: time to record how it ended."""
    if not c or c["outcome"] is not None:
        return False
    listing = (c["listing_status"] or "").replace("_", "").replace(" ", "").lower()
    passed = sale_at is not None and sale_at < datetime.now(ZoneInfo("UTC")) - timedelta(hours=3)
    return passed or listing in ENDED_ON_LISTING


def _max_bid(conn: psycopg.Connection) -> int | None:
    """The most we can bid with every cost included (Settings → Budget), or None if the budget isn't set."""
    from .money import max_bid
    from .routes.money import load_costs
    costs = load_costs(conn)
    return max_bid(costs) if costs.budget else None


def _budget(guide: dict | None, cap: int | None) -> str | None:
    """Where the current guide sits against the max bid: within it, only its top above ("stretch"), or over."""
    if not guide or cap is None:
        return None
    high = guide["high_aud"] or guide["low_aud"]
    return "over" if guide["low_aud"] > cap else "stretch" if high > cap else "within"


def build_rows(conn: psycopg.Connection, me: UUID | None, only: UUID | None = None) -> list[dict]:
    where = "WHERE p.id = %(only)s" if only else ""
    props = conn.execute(
        f"""SELECT p.*, ST_Y(p.location) AS lat, ST_X(p.location) AS lon, s.status, s.occurred_at AS status_since, s.status_id,
                   coalesce(f.excluded, false) AS excluded, coalesce(f.warned, false) AS warned
            FROM property p
            JOIN LATERAL (SELECT e.id AS status_id, e.status, e.occurred_at FROM status_event e
                          WHERE e.property_id = p.id ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) s ON true
            LEFT JOIN property_flags f ON f.property_id = p.id AND f.person_id = %(me)s
            {where} ORDER BY p.created_at""",
        {"me": me, "only": only},
    ).fetchall()
    ids = [p["id"] for p in props]
    if not ids:
        return []

    def by_property(sql: str, n: int = 1) -> dict:
        out = defaultdict(list)
        for r in conn.execute(sql, (ids,) * n).fetchall():
            out[r["property_id"]].append(r)
        return out

    campaigns = by_property(
        "SELECT * FROM campaign WHERE property_id = ANY(%s) ORDER BY (outcome IS NULL) DESC, created_at DESC")
    links = by_property(
        "SELECT c.property_id, l.campaign_id, l.url FROM campaign_link l JOIN campaign c ON c.id = l.campaign_id"
        " WHERE c.property_id = ANY(%s) ORDER BY l.created_at")
    agents = by_property(
        """SELECT c.property_id, ca.campaign_id, a.id, a.name, a.mobile, a.email, ag.name AS agency
           FROM campaign_agent ca JOIN campaign c ON c.id = ca.campaign_id JOIN agent a ON a.id = ca.agent_id
           LEFT JOIN agency ag ON ag.id = a.agency_id
           WHERE c.property_id = ANY(%s) ORDER BY ca.is_lead DESC""")
    guides = by_property(
        """SELECT c.property_id, g.* FROM price_guide g JOIN campaign c ON c.id = g.campaign_id
           WHERE c.property_id = ANY(%s) ORDER BY g.observed_at, g.id""")
    judgements = by_property(
        """SELECT c.property_id, j.* FROM price_judgement j JOIN campaign c ON c.id = j.campaign_id
           WHERE c.property_id = ANY(%s) ORDER BY j.created_at, j.id""")
    opinions = by_property("SELECT * FROM opinion_current WHERE property_id = ANY(%s)")
    hits = by_property("SELECT property_id, owner_id, kind, name FROM property_area_hit WHERE property_id = ANY(%s)")
    context = by_property("SELECT DISTINCT property_id, code, label FROM property_overlay_hit WHERE property_id = ANY(%s)")
    scores = by_property("SELECT property_id, person_id, score FROM property_score WHERE property_id = ANY(%s)")
    attended = by_property("""SELECT i.property_id, a.person_id FROM inspection_attendee a
                              JOIN inspection i ON i.id = a.inspection_id WHERE i.property_id = ANY(%s)
                              UNION SELECT x.property_id, pe.id FROM property_inspected x CROSS JOIN person pe
                              WHERE pe.active AND x.property_id = ANY(%s)""", 2)
    to_inspect = {r["property_id"]: r for r in conn.execute(
        "SELECT property_id, created_at FROM inspect_list WHERE property_id = ANY(%s)", (ids,)).fetchall()}
    covers = {r["property_id"]: str(r["attachment_id"]) for r in conn.execute(
        "SELECT property_id, attachment_id FROM property_cover WHERE property_id = ANY(%s)", (ids,)).fetchall()}
    # For the house card: how many photos, and the floor plan kept in House Track (to open its viewer).
    media = {r["property_id"]: r for r in conn.execute(
        """SELECT property_id, count(*) FILTER (WHERE kind = 'photo' AND sha256 IS NOT NULL) AS photos,
                  (array_agg(id ORDER BY created_at) FILTER (WHERE kind = 'floorplan' AND sha256 IS NOT NULL))[1] AS plan
           FROM attachment WHERE property_id = ANY(%s) GROUP BY property_id""", (ids,)).fetchall()}
    # The block each house sits on, where its suburb has been analysed (map's Blocks mode), and what the household's
    # block preferences make of it.
    block_prefs = blocks.prefs(conn)
    on_block = {r["property_id"]: blocks.summary(r, block_prefs) for r in conn.execute(
        """SELECT DISTINCT ON (p.id) p.id AS property_id, b.* FROM property p JOIN block b ON ST_Intersects(b.geom, p.location)
           WHERE p.id = ANY(%s) ORDER BY p.id, b.is_unit""", (ids,)).fetchall()}
    tag_rows = by_property("SELECT pt.property_id, t.name FROM property_tag pt JOIN tag t ON t.id = pt.tag_id"
                           " WHERE pt.property_id = ANY(%s) ORDER BY lower(t.name)")
    travel = by_property(
        """SELECT t.property_id, t.place_id, t.mode, t.duration_s, t.peak_s FROM travel_estimate t
           JOIN place pl ON pl.id = t.place_id AND pl.archived_at IS NULL WHERE t.property_id = ANY(%s)""")
    transit = by_property("SELECT property_id, place_id, duration_s, home_duration_s FROM transit_estimate"
                          " WHERE property_id = ANY(%s) AND duration_s IS NOT NULL")
    nearest = {r["property_id"]: r for r in conn.execute(
        "SELECT property_id, name, walk_s, walk_m, drive_s FROM property_nearest_station WHERE property_id = ANY(%s)",
        (ids,)).fetchall()}
    persons = {r["id"]: r["display_name"] for r in conn.execute("SELECT id, display_name FROM person")}
    cap = _max_bid(conn)

    today = _day(datetime.now(ZoneInfo("UTC")))
    rows = []
    for p in props:
        pid = p["id"]
        cs = campaigns.get(pid, [])
        c = cs[0] if cs else None
        cg = [g for g in guides.get(pid, []) if c and g["campaign_id"] == c["id"]]
        latest_guide = cg[-1] if cg else None
        first_any = guides.get(pid, [None])[0]
        cj = {j["kind"]: j for j in judgements.get(pid, []) if c and j["campaign_id"] == c["id"]}
        lead = next((a for a in agents.get(pid, []) if c and a["campaign_id"] == c["id"]), None)
        link = next((l["url"] for l in links.get(pid, []) if c and l["campaign_id"] == c["id"]), None)
        started = c and c["listed_on"]  # unknown until the listing says (the weekly refresh fills it in), not the day we added it
        ended = c and c["outcome_on"]
        sale_at = c and (c["auction_at"] if c["sale_method"] == "auction" else c["eoi_closes_at"] if c["sale_method"] == "eoi" else None)
        guide_high = latest_guide and latest_guide["high_aud"]

        row: dict[str, Any] = {
            "id": str(pid),
            "address": _street(p),
            "street": p["street"], "street_number": p["street_number"], "unit": p["unit"],  # for grouping by street
            "full_address": display(Address(**{k: p[k] for k in ("unit", "street_number", "street", "suburb",
                                                                   "postcode", "plan_number", "lot_number")})),
            "suburb": p["suburb"], "postcode": p["postcode"],
            "plan_lot": f"{p['lot_number']}\\{p['plan_number']}" if p["plan_number"] else None,
            "created_at": _day(p["created_at"]),
            "added_at": p["created_at"].isoformat(),  # to the second, for "newest added" among a day's additions
            "pin_source": "manual" if p["manual_location"] else p["geocode_source"],
            "lat": p["lat"], "lon": p["lon"],
            **{k: p[k] for k in PROPERTY_FIELDS},
            "status": p["status"], "status_since": _day(p["status_since"]),
            "excluded": p["excluded"], "warned": p["warned"],
            "flagged_by": ", ".join(sorted({persons.get(h["owner_id"], "?") for h in hits.get(pid, [])
                                            if h["owner_id"] != me and h["kind"] == "hard_exclude"})) or None,
            "campaign_id": c and str(c["id"]),
            "sale_method": c and c["sale_method"], "sale_at": sale_at, "listed_on": c and c["listed_on"],
            "days_on_market": ((ended or today) - started).days if started else None,
            "outcome": c and c["outcome"], "outcome_on": c and c["outcome_on"],
            "sold_price_aud": c and c["sold_price_aud"], "passed_in_bid_aud": c and c["passed_in_bid_aud"],
            "bought_by_us": bool(c and c["bought_by_us"]),
            "listing_status": c and c["listing_status"], "listing_price_text": c and c["listing_price_text"],
            "needs_outcome": _needs_outcome(c, sale_at),
            "listing_url": link, "relists": max(len(cs) - 1, 0),
            "agent_name": lead and lead["name"], "agency": lead and lead["agency"],
            "agent_phone": lead and lead["mobile"], "agent_email": lead and lead["email"],
            "guide_low": latest_guide and latest_guide["low_aud"], "guide_high": guide_high,
            "budget": _budget(latest_guide, cap),
            "guide_source": latest_guide and latest_guide["source"],
            "guide_date": latest_guide and _day(latest_guide["observed_at"]),
            "suburb_median": latest_guide and latest_guide["statement_suburb_median_aud"],
            "guide_change": (round(_mid(latest_guide["low_aud"], latest_guide["high_aud"]) - _mid(first_any["low_aud"], first_any["high_aud"]))
                             if latest_guide and first_any else None),
            # Price history across every campaign: how often the guide or asking price moved, and when.
            "first_guide_low": first_any and first_any["low_aud"], "first_guide_high": first_any and first_any["high_aud"],
            "guide_changes": max(len(guides.get(pid, [])) - 1, 0),
            "last_guide_change": (_day(guides[pid][-1]["observed_at"]) if len(guides.get(pid, [])) > 1 else None),
            "tags": [t["name"] for t in tag_rows.get(pid, [])],
            "cover_id": covers.get(pid),
            "photo_count": media[pid]["photos"] if pid in media else 0,
            "floorplan_id": str(media[pid]["plan"]) if pid in media and media[pid]["plan"] else None,
            "attended_by": [str(r["person_id"]) for r in attended.get(pid, [])],
            "to_inspect": pid in to_inspect, "to_inspect_since": _day(to_inspect[pid]["created_at"]) if pid in to_inspect else None,
            **{k: (cj[k]["amount_aud"] if k in cj else None) for k in JUDGEMENTS},
            "sold_vs_guide_pct": (round((c["sold_price_aud"] / guide_high - 1) * 100, 1)
                                  if c and c["sold_price_aud"] and guide_high else None),
            "guide_per_m2": round(guide_high / p["land_m2"]) if guide_high and p["land_m2"] else None,
            "school_primary": ", ".join(sorted({h["label"] for h in context.get(pid, []) if h["code"].endswith("school_primary")})) or None,
            "school_secondary": ", ".join(sorted({h["label"] for h in context.get(pid, []) if h["code"].endswith("school_secondary")})) or None,
            "planning": ", ".join(sorted({h["label"] for h in context.get(pid, []) if "school" not in h["code"]})) or None,
            "nearest_station": nearest.get(pid, {}).get("name"),
            "nearest_station_walk": _mins(nearest.get(pid, {}).get("walk_s")),
            "nearest_station_drive": _mins(nearest.get(pid, {}).get("drive_s")),
            "nearest_station_km": round(nearest[pid]["walk_m"] / 1000, 1) if nearest.get(pid, {}).get("walk_m") else None,
            **_block_fields(on_block.get(pid)),
        }
        v: dict[str, Any] = {"status": str(p["status_id"]), "guide": latest_guide and str(latest_guide["id"])}
        for k in JUDGEMENTS:
            v[k] = str(cj[k]["id"]) if k in cj else None
        latest_by_person: dict = {}
        latest_at: dict = {}
        for o in opinions.get(pid, []):
            short = "pre" if o["stage"] == "pre_inspection" else "post"
            key = f"v:{o['person_id']}:{short}"
            row[key] = o["stance"]
            row[f"{key}:note"] = o["note"]
            row[f"{key}:by"] = persons.get(o["created_by"])
            v[key] = str(o["id"])
            latest_by_person[o["person_id"]] = max(latest_by_person.get(o["person_id"], o["recorded_at"]), o["recorded_at"])
            # Their most recent response, whether it was before or after inspecting.
            if f"latest_verdict:{o['person_id']}" not in row or o["recorded_at"] > latest_at[o["person_id"]]:
                row[f"latest_verdict:{o['person_id']}"] = o["stance"]
                latest_at[o["person_id"]] = o["recorded_at"]
        for person_id, when in latest_by_person.items():
            row[f"last_verdict:{person_id}"] = _day(when)
        person_scores = [s for s in scores.get(pid, []) if s["score"] is not None]
        for s in person_scores:
            row[f"score:{s['person_id']}"] = int(s["score"])
        row["score_avg"] = round(sum(int(s["score"]) for s in person_scores) / len(person_scores)) if person_scores else None
        for t in transit.get(pid, []):
            row[f"transit:{t['place_id']}"] = _mins(t["duration_s"])
            row[f"transit_home:{t['place_id']}"] = _mins(t["home_duration_s"])
        for t in travel.get(pid, []):
            if t["duration_s"] is not None:
                row[f"{t['mode']}:{t['place_id']}"] = round(t["duration_s"] / 60)
            if t["peak_s"] is not None:  # a drive is a commute: its peak-hour figure is the one shown, sorted and filtered
                row[f"drive_free:{t['place_id']}"] = row.get(f"drive:{t['place_id']}")
                row[f"drive:{t['place_id']}"] = round(t["peak_s"] / 60)
        row["_v"] = v
        rows.append(row)
    return rows


# ─── writes ───────────────────────────────────────────────────────────
def _conflict(column: str, current: Any, by: UUID | None, at: datetime | None, conn: psycopg.Connection) -> HTTPException:
    name = conn.execute("SELECT display_name FROM person WHERE id = %s", (by,)).fetchone() if by else None
    return HTTPException(409, {
        "message": f"{name['display_name'] if name else 'Someone'} changed this since you loaded it.",
        "column": column, "current": current, "changed_by": name and name["display_name"],
        "changed_at": at and at.isoformat(),
    })


def _same(a: Any, b: Any) -> bool:
    norm = lambda x: None if x in (None, "") else str(x)  # noqa: E731
    return norm(a) == norm(b)


def _coerce(kind: type, value: Any) -> Any:
    if value in (None, ""):
        return None
    try:
        if kind is int:
            return int(float(value))
        if kind is date:
            return date.fromisoformat(str(value)[:10])
        return str(value).strip()
    except ValueError:
        raise HTTPException(422, f"Not a valid {kind.__name__}: {value!r}") from None


def _validated(model: type, field: str, value: Any) -> Any:
    """Run a grid value through the same schema the house page's forms use, so both accept the same values."""
    from pydantic import ValidationError
    try:
        return getattr(model.model_validate({field: value}), field)
    except ValidationError as e:
        raise HTTPException(422, f"{field.replace('_', ' ').capitalize()}: {e.errors()[0]['msg'].lower()}") from None


def _live_campaign(conn: psycopg.Connection, property_id: UUID) -> dict | None:
    return conn.execute(
        "SELECT * FROM campaign WHERE property_id = %s ORDER BY (outcome IS NULL) DESC, created_at DESC LIMIT 1",
        (property_id,),
    ).fetchone()


EXPECT_ANY = object()  # "expected" omitted: last write wins


def apply_cell(conn: psycopg.Connection, person: UUID, property_id: UUID, column: str, value: Any,
               expected: Any = EXPECT_ANY) -> None:
    prop = conn.execute("SELECT * FROM property WHERE id = %s FOR UPDATE", (property_id,)).fetchone()
    if prop is None:
        raise HTTPException(404, "Property not found.")
    check = expected is not EXPECT_ANY

    if column in PROPERTY_FIELDS:
        if check and not _same(prop[column], expected):
            raise _conflict(column, prop[column], prop["updated_by"], prop["updated_at"], conn)
        from .schemas import PropertyPatch
        new = _validated(PropertyPatch, column, _coerce(PROPERTY_FIELDS[column], value))
        conn.execute(f'UPDATE property SET "{column}" = %s WHERE id = %s', (new, property_id))
        return

    if column == "tags":
        from .routes.tags import set_property_tags
        current = [r["name"] for r in conn.execute(
            "SELECT t.name FROM property_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.property_id = %s ORDER BY lower(t.name)",
            (property_id,))]
        if check and sorted(n.lower() for n in current) != sorted(str(n).lower() for n in (expected or [])):
            raise _conflict(column, current, prop["updated_by"], prop["updated_at"], conn)
        names = value if isinstance(value, list) else [n for n in str(value or "").split(",")]
        set_property_tags(conn, property_id, [str(n) for n in names])
        return

    if column == "status":
        from .schemas import OLD_STATUS, STATUSES
        value = OLD_STATUS.get(value, value)
        if value not in STATUSES:
            raise HTTPException(422, f"Not a status: {value!r}")
        latest = conn.execute("SELECT id, status, created_by, created_at FROM status_event WHERE property_id = %s"
                              " ORDER BY occurred_at DESC, id DESC LIMIT 1", (property_id,)).fetchone()
        if check and not _same(latest and latest["id"], expected):
            raise _conflict(column, latest and latest["status"], latest and latest["created_by"], latest and latest["created_at"], conn)
        conn.execute("INSERT INTO status_event (property_id, status) VALUES (%s, %s)", (property_id, value))
        return

    if column.startswith("v:"):
        _, person_id, short = column.split(":")
        stage = STAGES[short]
        if value not in ("yes", "maybe", "no"):
            raise HTTPException(422, "A verdict is yes, maybe or no.")
        latest = conn.execute("SELECT id, stance, created_by, created_at FROM opinion_current"
                              " WHERE property_id = %s AND person_id = %s AND stage = %s", (property_id, person_id, stage)).fetchone()
        if check and not _same(latest and latest["id"], expected):
            raise _conflict(column, latest and latest["stance"], latest and latest["created_by"], latest and latest["created_at"], conn)
        live = conn.execute("SELECT id FROM campaign WHERE property_id = %s AND outcome IS NULL", (property_id,)).fetchone()
        conn.execute("INSERT INTO opinion (property_id, campaign_id, person_id, stage, stance, recorded_at)"
                     " VALUES (%s, %s, %s, %s, %s, now())", (property_id, live and live["id"], person_id, stage, value))
        return

    c = _live_campaign(conn, property_id)
    if column == "sale_method" and c is None:
        conn.execute("INSERT INTO campaign (property_id, sale_method) VALUES (%s, %s)", (property_id, value))
        return
    if c is None:
        raise HTTPException(422, "This house has no campaign yet. Set its sale method first.")

    if column == "sale_method":
        if check and not _same(c["sale_method"], expected):
            raise _conflict(column, c["sale_method"], c["updated_by"], c["updated_at"], conn)
        from .routes.campaigns import set_sale_method
        set_sale_method(conn, c["id"], _coerce(str, value))
        return

    if column in CAMPAIGN_FIELDS or column == "sale_at":
        target = ("auction_at" if c["sale_method"] == "auction" else "eoi_closes_at" if c["sale_method"] == "eoi" else None) \
            if column == "sale_at" else column
        if target is None:
            raise HTTPException(422, "Only auctions and EOIs have a date.")
        if check and not _same(c[target], expected):
            raise _conflict(column, c[target], c["updated_by"], c["updated_at"], conn)
        from .routes.campaigns import update_campaign_fields
        from .schemas import CampaignPatch
        new = _validated(CampaignPatch, target, value if column == "sale_at" else _coerce(CAMPAIGN_FIELDS[column], value))
        if column == "outcome" and new is not None and c["outcome_on"] is not None:
            update_campaign_fields(conn, c["id"], {"outcome": new, "outcome_on": c["outcome_on"]})
        else:
            update_campaign_fields(conn, c["id"], {target: new})
        return

    if column == "listing_url":
        from .routes.campaigns import insert_link
        current = conn.execute("SELECT url FROM campaign_link WHERE campaign_id = %s ORDER BY created_at LIMIT 1", (c["id"],)).fetchone()
        if check and not _same(current and current["url"], expected):
            raise _conflict(column, current and current["url"], c["updated_by"], c["updated_at"], conn)
        if value:
            insert_link(conn, c["id"], str(value))
        return

    if column in ("agent_name", "agent_phone"):
        lead = conn.execute("SELECT a.* FROM campaign_agent ca JOIN agent a ON a.id = ca.agent_id"
                            " WHERE ca.campaign_id = %s ORDER BY ca.is_lead DESC LIMIT 1", (c["id"],)).fetchone()
        field = "name" if column == "agent_name" else "mobile"
        if check and not _same(lead and lead[field], expected):
            raise _conflict(column, lead and lead[field], lead and lead["updated_by"], lead and lead["updated_at"], conn)
        if lead:
            conn.execute(f"UPDATE agent SET {field} = %s WHERE id = %s", (value or None, lead["id"]))
        elif column == "agent_name" and value:
            agent = conn.execute("INSERT INTO agent (name) VALUES (%s) RETURNING id", (value,)).fetchone()
            conn.execute("INSERT INTO campaign_agent (campaign_id, agent_id, is_lead) VALUES (%s, %s, true)", (c["id"], agent["id"]))
        else:
            raise HTTPException(422, "Add the agent's name first.")
        return

    if column in ("guide_low", "guide_high", "guide_source"):
        latest = conn.execute("SELECT * FROM price_guide WHERE campaign_id = %s ORDER BY observed_at DESC, id DESC LIMIT 1",
                              (c["id"],)).fetchone()
        if check and not _same(latest and latest["id"], expected):
            current = latest and {"guide_low": latest["low_aud"], "guide_high": latest["high_aud"], "guide_source": latest["source"]}[column]
            raise _conflict(column, current, latest and latest["created_by"], latest and latest["created_at"], conn)
        low, high = (latest["low_aud"], latest["high_aud"]) if latest else (None, None)
        source = latest["source"] if latest else "advertised"
        if column == "guide_low":
            low = _coerce(int, value)
            high = high if high and low and high >= low else low
        elif column == "guide_high":
            high = _coerce(int, value)
            low = low if low and high and low <= high else high
        else:
            source = value
        if low is None:
            raise HTTPException(422, "Enter the guide price first.")
        conn.execute("INSERT INTO price_guide (campaign_id, source, low_aud, high_aud, statement_suburb_median_aud)"
                     " VALUES (%s, %s, %s, %s, %s)",
                     (c["id"], source, low, high, latest and latest["statement_suburb_median_aud"]))
        return

    if column in JUDGEMENTS:
        latest = conn.execute("SELECT id, amount_aud, created_by, created_at FROM price_judgement WHERE campaign_id = %s AND kind = %s"
                              " ORDER BY created_at DESC, id DESC LIMIT 1", (c["id"], column)).fetchone()
        if check and not _same(latest and latest["id"], expected):
            raise _conflict(column, latest and latest["amount_aud"], latest and latest["created_by"], latest and latest["created_at"], conn)
        conn.execute("INSERT INTO price_judgement (campaign_id, kind, amount_aud) VALUES (%s, %s, %s)",
                     (c["id"], column, _coerce(int, value)))
        return

    raise HTTPException(422, f"{column} can't be edited here.")


def _block_fields(b: dict | None) -> dict:
    """A house's block for the grid, cards and filters (empty where its suburb isn't analysed)."""
    if b is None:
        return {"block_m2": None, "block_incline": None, "block_falls": None, "block_fall_m": None, "block_frontage": None,
                "block_depth": None, "block_shape": None, "block_rear": None, "block_split": None, "block_fits": None}
    shape = ("Battle-axe" if b["battleaxe"] else "Regular" if (b["regularity"] or 0) >= 0.9
             else "Slightly irregular" if (b["regularity"] or 0) >= 0.75 else "Irregular")
    return {"block_m2": b["area_m2"], "block_incline": b["incline_pct"], "block_falls": b["direction"], "block_fall_m": b["fall_m"],
            "block_frontage": b["frontage_m"], "block_depth": b["depth_m"], "block_shape": shape, "block_rear": b["rear_facing"],
            "block_split": b["split_lots"] if b["split_lots"] >= 2 else None, "block_fits": b["fits"]}

