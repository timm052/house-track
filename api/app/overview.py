"""The Overview grid (PLAN.md D15-D17): one flat row per house, and single-cell writes with
per-field conflict checks.

Each row carries `_v`, the version the client saw for every editable cell: the plain value for
ordinary fields, or the latest entry's id for history fields (status, verdicts, guides, joint
figures). A write sends that back as `expected`; if the field changed underneath, the write is
refused with the current value, who changed it and when.
"""

import os
from collections import defaultdict
from datetime import date, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from fastapi import HTTPException

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


def _mid(low: int | None, high: int | None) -> float | None:
    return None if low is None else (low + (high or low)) / 2


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

    def by_property(sql: str) -> dict:
        out = defaultdict(list)
        for r in conn.execute(sql, (ids,)).fetchall():
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
    covers = {r["property_id"]: str(r["attachment_id"]) for r in conn.execute(
        "SELECT property_id, attachment_id FROM property_cover WHERE property_id = ANY(%s)", (ids,)).fetchall()}
    tag_rows = by_property("SELECT pt.property_id, t.name FROM property_tag pt JOIN tag t ON t.id = pt.tag_id"
                           " WHERE pt.property_id = ANY(%s) ORDER BY lower(t.name)")
    travel = by_property(
        """SELECT t.property_id, t.place_id, t.mode, t.duration_s FROM travel_estimate t
           JOIN place pl ON pl.id = t.place_id AND pl.archived_at IS NULL WHERE t.property_id = ANY(%s)""")
    nearest = {r["property_id"]: r for r in conn.execute(
        "SELECT property_id, name, duration_s FROM property_station_access WHERE is_nearest AND property_id = ANY(%s)",
        (ids,)).fetchall()}
    persons = {r["id"]: r["display_name"] for r in conn.execute("SELECT id, display_name FROM person")}

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
        started = (c and (c["listed_on"] or _day(c["created_at"]))) or None
        ended = c and c["outcome_on"]
        sale_at = c and (c["auction_at"] if c["sale_method"] == "auction" else c["eoi_closes_at"] if c["sale_method"] == "eoi" else None)
        guide_high = latest_guide and latest_guide["high_aud"]

        row: dict[str, Any] = {
            "id": str(pid),
            "address": _street(p),
            "full_address": display(Address(**{k: p[k] for k in ("unit", "street_number", "street", "suburb",
                                                                   "postcode", "plan_number", "lot_number")})),
            "suburb": p["suburb"], "postcode": p["postcode"],
            "plan_lot": f"{p['lot_number']}\\{p['plan_number']}" if p["plan_number"] else None,
            "created_at": _day(p["created_at"]),
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
            "listing_url": link, "relists": max(len(cs) - 1, 0),
            "agent_name": lead and lead["name"], "agency": lead and lead["agency"],
            "agent_phone": lead and lead["mobile"], "agent_email": lead and lead["email"],
            "guide_low": latest_guide and latest_guide["low_aud"], "guide_high": guide_high,
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
            **{k: (cj[k]["amount_aud"] if k in cj else None) for k in JUDGEMENTS},
            "sold_vs_guide_pct": (round((c["sold_price_aud"] / guide_high - 1) * 100, 1)
                                  if c and c["sold_price_aud"] and guide_high else None),
            "guide_per_m2": round(guide_high / p["land_m2"]) if guide_high and p["land_m2"] else None,
            "school_primary": ", ".join(sorted({h["label"] for h in context.get(pid, []) if h["code"].endswith("school_primary")})) or None,
            "school_secondary": ", ".join(sorted({h["label"] for h in context.get(pid, []) if h["code"].endswith("school_secondary")})) or None,
            "planning": ", ".join(sorted({h["label"] for h in context.get(pid, []) if "school" not in h["code"]})) or None,
            "nearest_station": nearest.get(pid, {}).get("name"),
            "nearest_station_walk": round(nearest[pid]["duration_s"] / 60) if pid in nearest else None,
        }
        v: dict[str, Any] = {"status": str(p["status_id"]), "guide": latest_guide and str(latest_guide["id"])}
        for k in JUDGEMENTS:
            v[k] = str(cj[k]["id"]) if k in cj else None
        latest_by_person: dict = {}
        for o in opinions.get(pid, []):
            short = "pre" if o["stage"] == "pre_inspection" else "post"
            key = f"v:{o['person_id']}:{short}"
            row[key] = o["stance"]
            row[f"{key}:note"] = o["note"]
            row[f"{key}:by"] = persons.get(o["created_by"])
            v[key] = str(o["id"])
            latest_by_person[o["person_id"]] = max(latest_by_person.get(o["person_id"], o["recorded_at"]), o["recorded_at"])
        for person_id, when in latest_by_person.items():
            row[f"last_verdict:{person_id}"] = _day(when)
        person_scores = [s for s in scores.get(pid, []) if s["score"] is not None]
        for s in person_scores:
            row[f"score:{s['person_id']}"] = int(s["score"])
        row["score_avg"] = round(sum(int(s["score"]) for s in person_scores) / len(person_scores)) if person_scores else None
        for t in travel.get(pid, []):
            if t["duration_s"] is not None:
                row[f"{t['mode']}:{t['place_id']}"] = round(t["duration_s"] / 60)
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
        conn.execute(f'UPDATE property SET "{column}" = %s WHERE id = %s',
                     (_coerce(PROPERTY_FIELDS[column], value), property_id))
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

    if column in CAMPAIGN_FIELDS or column == "sale_at":
        target = ("auction_at" if c["sale_method"] == "auction" else "eoi_closes_at" if c["sale_method"] == "eoi" else None) \
            if column == "sale_at" else column
        if target is None:
            raise HTTPException(422, "Only auctions and EOIs have a date.")
        if check and not _same(c[target], expected):
            raise _conflict(column, c[target], c["updated_by"], c["updated_at"], conn)
        new = value if column == "sale_at" else _coerce(CAMPAIGN_FIELDS[column], value)
        extra = ""
        if column == "outcome":
            extra = ", outcome_on = CASE WHEN %(v)s::text IS NULL THEN NULL ELSE coalesce(outcome_on, current_date) END"
        conn.execute(f'UPDATE campaign SET "{target}" = %(v)s{extra} WHERE id = %(id)s', {"v": new, "id": c["id"]})
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
