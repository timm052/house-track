"""Milestone 4: costs and the affordable bid, due-diligence checklist, comparable sales, auction day."""

from dataclasses import asdict, fields
from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..address import Address, display
from ..db import tx
from ..deps import Person, not_found
from ..money import CostSettings, breakdown, max_bid

router = APIRouter(prefix="/api")


# ─── costs ────────────────────────────────────────────────────────────
def load_costs(conn) -> CostSettings:
    row = conn.execute("SELECT value FROM household_setting WHERE key = 'costs'").fetchone()
    known = {f.name for f in fields(CostSettings)}
    return CostSettings(**{k: v for k, v in (row["value"] if row else {}).items() if k in known})


class CostsIn(BaseModel):
    cash_aud: int = Field(ge=0)
    loan_preapproval_aud: int = Field(ge=0)
    loan_expiry: date | None = None
    first_home_buyer: bool = False
    principal_residence: bool = True
    conveyancing_aud: int = Field(ge=0)
    inspections_aud: int = Field(ge=0)
    other_aud: int = Field(ge=0)


@router.get("/costs")
def get_costs(price: int | None = None) -> dict:
    with tx() as conn:
        s = load_costs(conn)
    out = {"settings": asdict(s), "max_bid": max_bid(s) if s.budget else None}
    if price:
        out["breakdown"] = breakdown(price, s)
    return out


@router.put("/costs")
def put_costs(body: CostsIn, person: Person) -> dict:
    value = body.model_dump(mode="json")
    with tx(person) as conn:
        conn.execute("INSERT INTO household_setting (key, value) VALUES ('costs', %s)"
                     " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", (Jsonb(value),))
    return get_costs()


# ─── due-diligence checklist ──────────────────────────────────────────
DEFAULT_CHECKLIST = [
    "Section 32 (vendor statement) received",
    "Section 32 reviewed by our conveyancer",
    "Contract of sale reviewed by our conveyancer",
    "Building inspection done",
    "Pest inspection done",
    "Owners corporation certificate and strata report (units)",
    "Finance pre-approval current for this price",
    "Insurance quote obtained",
    "Planning overlays and zoning checked",
    "Cooling-off: private sale 3 business days; none at auction or within 3 days of one",
]


class ChecklistIn(BaseModel):
    label: str = Field(min_length=1, max_length=200)


class ChecklistPatch(BaseModel):
    done: bool | None = None
    label: str | None = Field(default=None, min_length=1, max_length=200)
    note: str | None = None


def _campaign(conn, campaign_id: UUID) -> dict:
    c = conn.execute("SELECT * FROM campaign WHERE id = %s", (campaign_id,)).fetchone()
    if c is None:
        raise not_found("Campaign")
    return c


@router.get("/campaigns/{campaign_id}/checklist")
def get_checklist(campaign_id: UUID) -> list[dict]:
    with tx() as conn:
        return conn.execute("SELECT id, label, sort, done_at, done_by, note FROM checklist_item"
                            " WHERE campaign_id = %s ORDER BY sort, created_at", (campaign_id,)).fetchall()


@router.post("/campaigns/{campaign_id}/checklist/defaults", status_code=201)
def add_default_checklist(campaign_id: UUID, person: Person) -> list[dict]:
    with tx(person) as conn:
        _campaign(conn, campaign_id)
        existing = {r["label"] for r in conn.execute("SELECT label FROM checklist_item WHERE campaign_id = %s", (campaign_id,))}
        for i, label in enumerate(DEFAULT_CHECKLIST):
            if label not in existing:
                conn.execute("INSERT INTO checklist_item (campaign_id, label, sort) VALUES (%s, %s, %s)", (campaign_id, label, i))
    return get_checklist(campaign_id)


@router.post("/campaigns/{campaign_id}/checklist", status_code=201)
def add_checklist_item(campaign_id: UUID, body: ChecklistIn, person: Person) -> dict:
    with tx(person) as conn:
        _campaign(conn, campaign_id)
        return conn.execute(
            "INSERT INTO checklist_item (campaign_id, label, sort) VALUES (%s, %s,"
            " (SELECT coalesce(max(sort), 0) + 1 FROM checklist_item WHERE campaign_id = %s)) RETURNING id",
            (campaign_id, body.label.strip(), campaign_id)).fetchone()


@router.patch("/checklist/{item_id}")
def update_checklist_item(item_id: UUID, body: ChecklistPatch, person: Person) -> dict:
    with tx(person) as conn:
        values = body.model_dump(exclude_unset=True)
        if "done" in values:
            done = values.pop("done")
            conn.execute("UPDATE checklist_item SET done_at = CASE WHEN %s THEN now() END,"
                         " done_by = CASE WHEN %s THEN %s::uuid END WHERE id = %s", (done, done, person, item_id))
        for k, v in values.items():
            conn.execute(f"UPDATE checklist_item SET {k} = %s WHERE id = %s", (v, item_id))
        row = conn.execute("SELECT id FROM checklist_item WHERE id = %s", (item_id,)).fetchone()
    if row is None:
        raise not_found("Checklist item")
    return row


@router.delete("/checklist/{item_id}", status_code=204)
def delete_checklist_item(item_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM checklist_item WHERE id = %s", (item_id,))


# ─── comparable sales ─────────────────────────────────────────────────
class ComparableIn(BaseModel):
    source: Literal["price_statement", "own_research"] = "price_statement"
    address: str = Field(min_length=3)
    sold_price_aud: int | None = Field(default=None, gt=0)
    sold_on: date | None = None
    beds: int | None = Field(default=None, ge=0, le=20)
    baths: int | None = Field(default=None, ge=0, le=20)
    car_spaces: int | None = Field(default=None, ge=0, le=20)
    land_m2: int | None = Field(default=None, gt=0)
    note: str | None = None


@router.get("/campaigns/{campaign_id}/comparables")
def comparables(campaign_id: UUID) -> dict:
    """Comparables entered from the price statement or our own research, plus houses we tracked that sold
    within 2 km in the last year (they become comparables automatically)."""
    with tx() as conn:
        c = _campaign(conn, campaign_id)
        entered = conn.execute(
            "SELECT id, source, address, sold_price_aud, sold_on, beds, baths, car_spaces, land_m2, note"
            " FROM comparable_sale WHERE campaign_id = %s ORDER BY sold_on DESC NULLS LAST", (campaign_id,)).fetchall()
        tracked = conn.execute(
            """SELECT p.id AS property_id, p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number,
                      p.lot_number, p.beds, p.baths, p.car_spaces, p.land_m2, oc.sold_price_aud, oc.outcome_on AS sold_on,
                      round(ST_Distance(p.location::geography, me.location::geography)) AS distance_m
               FROM property me
               JOIN property p ON p.id <> me.id AND p.location IS NOT NULL
               JOIN campaign oc ON oc.property_id = p.id AND oc.outcome LIKE 'sold%%' AND oc.sold_price_aud IS NOT NULL
                                 AND oc.outcome_on >= current_date - 365
               WHERE me.id = %s AND me.location IS NOT NULL
                 AND ST_DWithin(p.location::geography, me.location::geography, 2000)
               ORDER BY oc.outcome_on DESC""",
            (c["property_id"],)).fetchall()
    for t in tracked:
        t["address"] = display(Address(**{k: t.pop(k) for k in ("unit", "street_number", "street", "suburb", "postcode",
                                                                   "plan_number", "lot_number")}))
    return {"entered": entered, "tracked": tracked}


@router.post("/campaigns/{campaign_id}/comparables", status_code=201)
def add_comparable(campaign_id: UUID, body: ComparableIn, person: Person) -> dict:
    with tx(person) as conn:
        _campaign(conn, campaign_id)
        return conn.execute(
            """INSERT INTO comparable_sale (campaign_id, source, address, sold_price_aud, sold_on, beds, baths, car_spaces,
                                            land_m2, note) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (campaign_id, body.source, body.address.strip(), body.sold_price_aud, body.sold_on, body.beds, body.baths,
             body.car_spaces, body.land_m2, body.note)).fetchone()


@router.delete("/comparables/{comparable_id}", status_code=204)
def delete_comparable(comparable_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM comparable_sale WHERE id = %s", (comparable_id,))


# ─── auction day ──────────────────────────────────────────────────────
class BidIn(BaseModel):
    amount_aud: int = Field(gt=0, le=2_000_000_000)
    bidder: Literal["us", "other", "vendor"]
    label: str | None = None
    over_limit_ok: bool = False  # the UI blocks our bids above the walk-away limit unless confirmed


def _latest(conn, campaign_id: UUID, kind: str) -> int | None:
    row = conn.execute("SELECT amount_aud FROM price_judgement WHERE campaign_id = %s AND kind = %s"
                       " ORDER BY created_at DESC, id DESC LIMIT 1", (campaign_id, kind)).fetchone()
    return row and row["amount_aud"]


@router.get("/campaigns/{campaign_id}/auction")
def auction(campaign_id: UUID) -> dict:
    with tx() as conn:
        c = _campaign(conn, campaign_id)
        p = conn.execute("SELECT * FROM property WHERE id = %s", (c["property_id"],)).fetchone()
        bids = conn.execute("SELECT id, amount_aud, bidder, label, called_at, created_by FROM auction_bid"
                            " WHERE campaign_id = %s ORDER BY called_at, id", (campaign_id,)).fetchall()
        guide = conn.execute("SELECT low_aud, high_aud FROM price_guide WHERE campaign_id = %s"
                             " ORDER BY observed_at DESC, id DESC LIMIT 1", (campaign_id,)).fetchone()
        costs = load_costs(conn)
        return {
            "campaign": {k: c[k] for k in ("id", "property_id", "sale_method", "auction_at", "outcome", "sold_price_aud")},
            "address": display(Address(**{k: p[k] for k in ("unit", "street_number", "street", "suburb", "postcode",
                                                              "plan_number", "lot_number")})),
            "walk_away": _latest(conn, campaign_id, "walk_away"),
            "estimated_reserve": _latest(conn, campaign_id, "estimated_reserve"),
            "guide": guide,
            "max_affordable": max_bid(costs) if costs.budget else None,
            "bids": bids,
        }


@router.post("/campaigns/{campaign_id}/bids", status_code=201)
def add_bid(campaign_id: UUID, body: BidIn, person: Person) -> dict:
    with tx(person) as conn:
        _campaign(conn, campaign_id)
        limit = _latest(conn, campaign_id, "walk_away")
        if body.bidder == "us" and limit and body.amount_aud > limit and not body.over_limit_ok:
            raise HTTPException(422, {"message": f"That's over your walk-away limit of ${limit:,}.", "limit": limit})
        return conn.execute("INSERT INTO auction_bid (campaign_id, amount_aud, bidder, label) VALUES (%s, %s, %s, %s) RETURNING id",
                            (campaign_id, body.amount_aud, body.bidder, body.label)).fetchone()


@router.delete("/bids/{bid_id}", status_code=204)
def delete_bid(bid_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM auction_bid WHERE id = %s", (bid_id,))


@router.get("/comparables")
def all_comparables() -> list[dict]:
    """Every comparable sale entered from price statements or research, for the trends page. The
    suburb is read from the address text (comparables are stored as plain addresses)."""
    from ..address import parse as parse_address

    with tx() as conn:
        rows = conn.execute("SELECT id, address, sold_price_aud, sold_on, beds, baths, car_spaces, land_m2, source"
                            " FROM comparable_sale WHERE sold_price_aud IS NOT NULL ORDER BY sold_on DESC NULLS LAST").fetchall()
    for r in rows:
        parsed = parse_address(r["address"])
        r["suburb"] = parsed.suburb if parsed else (r["address"].rsplit(",", 1)[-1].strip() if "," in r["address"] else None)
    return rows
