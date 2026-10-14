"""Block analysis: the suburbs analysed, the household's block preferences, every block for the map, areas where
many blocks fit, one block in detail, and a tracked house's block. See app/blocks.py for how blocks are measured."""

import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, model_validator

from .. import blocks
from ..db import tx
from ..deps import Person, not_found

router = APIRouter(prefix="/api")

Direction = Literal["level", "up", "down", "across"]
BLOCK_COLUMNS = ("pfi, suburb, address, is_unit, addresses, area_m2, frontage_m, depth_m, regularity, battleaxe, fall_m, cross_fall_m, "
                 "along_pct, across_pct, incline_pct, steepest_pct, direction, profile, rear_bearing, zone_code")


# ─── suburbs ───────────────────────────────────────────────────────────
class SuburbIn(BaseModel):
    suburb: str = Field(min_length=2, max_length=60, pattern=r"^[A-Za-z' -]+$")


@router.get("/blocks/suburbs")
def suburbs() -> list[dict]:
    with tx() as conn:
        return conn.execute("""SELECT suburb, status, error, blocks, analysed_at, created_at FROM block_suburb
                               ORDER BY suburb""").fetchall()


@router.post("/blocks/suburbs", status_code=201)
def add_suburb(body: SuburbIn, person: Person) -> dict:
    """Queue a suburb for analysis (the worker downloads and measures it, about a minute)."""
    name = " ".join(body.suburb.upper().split())
    with tx(person) as conn:
        if conn.execute("SELECT count(*) FILTER (WHERE suburb <> %s) AS n FROM block_suburb", (name,)).fetchone()["n"] >= 25:
            raise HTTPException(422, "That's 25 suburbs already. Remove one first.")
        conn.execute("""INSERT INTO block_suburb (suburb) VALUES (%s)
                        ON CONFLICT (suburb) DO UPDATE SET status = 'pending', error = NULL""", (name,))
    return {"suburb": name, "status": "pending"}


@router.post("/blocks/suburbs/{suburb}/refresh")
def refresh_suburb(suburb: str, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("UPDATE block_suburb SET status = 'pending', error = NULL WHERE suburb = %s RETURNING suburb",
                        (suburb.upper(),)).fetchone() is None:
            raise not_found("Suburb")
    return {"suburb": suburb.upper(), "status": "pending"}


@router.delete("/blocks/suburbs/{suburb}", status_code=204)
def remove_suburb(suburb: str, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM block_suburb WHERE suburb = %s", (suburb.upper(),))


# ─── preferences ───────────────────────────────────────────────────────
class PrefsIn(BaseModel):
    min_m2: int = Field(ge=0, le=1_000_000)
    max_m2: int = Field(ge=0, le=1_000_000)
    max_incline: float = Field(ge=0, le=100)
    directions: list[Direction] = Field(min_length=1)
    include_units: bool = False
    split: dict[str, int | None] = Field(default_factory=lambda: dict(blocks.DEFAULT_PREFS["split"]))
    split_frontage: float = Field(default=12, ge=0, le=100)

    @model_validator(mode="after")
    def ordered(self) -> "PrefsIn":
        if self.max_m2 < self.min_m2:
            raise ValueError("The largest block size is below the smallest.")
        return self


@router.get("/blocks/prefs")
def get_prefs() -> dict:
    with tx() as conn:
        return blocks.prefs(conn)


@router.put("/blocks/prefs")
def put_prefs(body: PrefsIn, person: Person) -> dict:
    with tx(person) as conn:
        conn.execute("""INSERT INTO household_setting (key, value) VALUES ('block_prefs', %s)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value""", (Jsonb(body.model_dump()),))
        return blocks.prefs(conn)


# ─── the map ───────────────────────────────────────────────────────────
@router.get("/blocks/geojson")
def suburb_blocks(suburb: str) -> Response:
    """Every block in an analysed suburb, with short property names to keep it small (a suburb is a few thousand).
    The map works out which fit from these, so changing the preferences there is instant."""
    with tx() as conn:
        row = conn.execute(
            """SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(json_build_object(
                 'type', 'Feature', 'id', b.pfi::bigint,
                 'geometry', ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geom, 0.000003), 6)::json,
                 'properties', json_strip_nulls(json_build_object(
                   'pfi', b.pfi, 'a', b.area_m2, 'i', b.incline_pct, 'd', b.direction, 'fa', b.fall_m, 'fw', b.frontage_m,
                   'dp', b.depth_m, 'rg', b.regularity, 'bx', CASE WHEN b.battleaxe THEN 1 END, 'u', CASE WHEN b.is_unit THEN 1 END,
                   'rb', b.rear_bearing, 'z', b.zone_code, 't', t.id)))), '[]'::json)) AS fc
               FROM block b
               LEFT JOIN LATERAL (SELECT p.id FROM property p WHERE ST_Intersects(b.geom, p.location) LIMIT 1) t ON true
               WHERE b.suburb = %s""", (suburb.upper(),)).fetchone()
    return Response(json.dumps(row["fc"], separators=(",", ":")), media_type="application/json",
                    headers={"Cache-Control": "private, max-age=300"})


class AreaQuery(BaseModel):
    min_m2: int
    max_m2: int
    max_incline: float
    directions: list[Direction]
    include_units: bool = False
    size: int = Field(default=250, ge=80, le=2000)   # hexagon width, metres


@router.post("/blocks/areas")
def areas(q: AreaQuery) -> dict:
    """Where many blocks fit: a grid of hexagons over the analysed suburbs, each with how many blocks it holds and how
    many fit, and the streets with the most that fit."""
    params = {"min": q.min_m2, "max": q.max_m2, "inc": q.max_incline, "dirs": q.directions, "units": q.include_units,
              "size": q.size / 2}
    fit = """(b.area_m2 BETWEEN %(min)s AND %(max)s AND b.incline_pct <= %(inc)s AND b.direction = ANY(%(dirs)s)
              AND (%(units)s OR NOT b.is_unit))"""
    with tx() as conn:
        # Each block's own hexagon, found from its point (the grid is anchored at the origin, so every block's lookup
        # agrees): the work grows with the blocks, not with the area the suburbs span.
        hexes = conn.execute(
            f"""WITH b AS (SELECT *, ST_Transform(ST_PointOnSurface(geom), 7855) AS pt FROM block
                           WHERE %(units)s OR NOT is_unit),
                    h AS (SELECT DISTINCT ON (b.pfi) b.*, g.i, g.j, g.geom AS hex
                          FROM b, LATERAL ST_HexagonGrid(%(size)s, b.pt) g WHERE ST_Intersects(g.geom, b.pt)
                          ORDER BY b.pfi, g.i, g.j)
               SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID((array_agg(hex))[1], 7855), 4326), 6)::json AS geometry,
                      count(*) AS total, count(*) FILTER (WHERE {fit.replace("b.", "")}) AS fit
               FROM h GROUP BY i, j HAVING count(*) >= 3""", params).fetchall()
        streets = conn.execute(
            f"""SELECT initcap(b.street) AS street, initcap(b.suburb) AS suburb, count(*) AS total,
                       count(*) FILTER (WHERE {fit}) AS fit
                FROM block b WHERE b.street IS NOT NULL AND (%(units)s OR NOT b.is_unit)
                GROUP BY b.street, b.suburb HAVING count(*) FILTER (WHERE {fit}) >= 3
                ORDER BY count(*) FILTER (WHERE {fit}) DESC, count(*) FILTER (WHERE {fit})::float / count(*) DESC LIMIT 8""",
            params).fetchall()
    features = [{"type": "Feature", "geometry": h["geometry"],
                 "properties": {"total": h["total"], "fit": h["fit"], "share": round(h["fit"] / h["total"], 3)}} for h in hexes]
    return {"hexes": {"type": "FeatureCollection", "features": features}, "streets": streets}


@router.get("/blocks/{pfi}")
def block(pfi: str) -> dict:
    with tx() as conn:
        b = conn.execute(f"SELECT {BLOCK_COLUMNS} FROM block WHERE pfi = %s", (pfi,)).fetchone()
        if b is None:
            raise not_found("Block")
        out = blocks.summary(b, blocks.prefs(conn))
        out["tracked"] = conn.execute(
            """SELECT p.id, s.status FROM property p JOIN block b ON ST_Intersects(b.geom, p.location)
               LEFT JOIN property_status s ON s.property_id = p.id WHERE b.pfi = %s LIMIT 1""", (pfi,)).fetchone()
    return out


@router.get("/properties/{property_id}/block")
def property_block(property_id: UUID) -> dict | None:
    """The block a tracked house sits on (its own lot, not a neighbouring unit's), or null if its suburb isn't analysed."""
    with tx() as conn:
        b = conn.execute(
            f"""SELECT {', '.join('b.' + c.strip() for c in BLOCK_COLUMNS.split(','))} FROM property p
                JOIN block b ON ST_Intersects(b.geom, p.location) WHERE p.id = %s ORDER BY b.is_unit LIMIT 1""",
            (property_id,)).fetchone()
        return blocks.summary(b, blocks.prefs(conn)) if b else None
