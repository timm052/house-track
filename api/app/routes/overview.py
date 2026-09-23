"""Overview grid, saved views and favourite places (milestone 2.5, PLAN.md D15-D19)."""

from typing import Any
from uuid import UUID

from fastapi import APIRouter
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from ..db import tx
from ..deps import OptionalPerson, Person, not_found
from ..overview import EXPECT_ANY, apply_cell, build_rows

router = APIRouter(prefix="/api")


@router.get("/overview")
def overview(person: OptionalPerson) -> dict:
    with tx() as conn:
        rows = build_rows(conn, person)
        places = conn.execute(
            "SELECT id, kind, name, person_id, is_favourite, modes FROM place WHERE archived_at IS NULL ORDER BY kind, name"
        ).fetchall()
    return {"rows": rows, "places": places}


@router.get("/overview/rows/{property_id}")
def overview_row(property_id: UUID, person: OptionalPerson) -> dict:
    with tx() as conn:
        rows = build_rows(conn, person, property_id)
    if not rows:
        raise not_found("Property")
    return rows[0]


class CellIn(BaseModel):
    property_id: UUID
    column: str
    value: Any = None
    # The version the client saw (D17). Omit it to overwrite whatever is there.
    expected: Any = Field(default=None)
    check: bool = True


@router.post("/overview/cell")
def write_cell(body: CellIn, person: Person) -> dict:
    with tx(person) as conn:
        apply_cell(conn, person, body.property_id, body.column, body.value,
                   body.expected if body.check else EXPECT_ANY)
        [row] = build_rows(conn, person, body.property_id)
    return row


# ─── saved views (D18) ────────────────────────────────────────────────
class ViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    is_default: bool = False
    filters: list = []
    sort: list = []
    columns: list[str] = []


class ViewPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    is_default: bool | None = None
    filters: list | None = None
    sort: list | None = None
    columns: list[str] | None = None


VIEW_COLUMNS = "id, name, is_default, filters, sort, columns, updated_at, updated_by"


@router.get("/views")
def list_views() -> list[dict]:
    with tx() as conn:
        return conn.execute(f"SELECT {VIEW_COLUMNS} FROM grid_view ORDER BY is_default DESC, name").fetchall()


@router.post("/views", status_code=201)
def create_view(body: ViewIn, person: Person) -> dict:
    with tx(person) as conn:
        if body.is_default:
            conn.execute("UPDATE grid_view SET is_default = false WHERE is_default")
        return conn.execute(
            f"INSERT INTO grid_view (name, is_default, filters, sort, columns) VALUES (%s, %s, %s, %s, %s) RETURNING {VIEW_COLUMNS}",
            (body.name.strip(), body.is_default, Jsonb(body.filters), Jsonb(body.sort), Jsonb(body.columns)),
        ).fetchone()


@router.patch("/views/{view_id}")
def update_view(view_id: UUID, body: ViewPatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True)
    with tx(person) as conn:
        if values.get("is_default"):
            conn.execute("UPDATE grid_view SET is_default = false WHERE is_default AND id <> %s", (view_id,))
        for key in ("filters", "sort", "columns"):
            if key in values:
                values[key] = Jsonb(values[key])
        sets = ", ".join(f"{k} = %({k})s" for k in values) or "name = name"
        row = conn.execute(f"UPDATE grid_view SET {sets} WHERE id = %(id)s RETURNING {VIEW_COLUMNS}",
                           values | {"id": view_id}).fetchone()
    if row is None:
        raise not_found("View")
    return row


@router.delete("/views/{view_id}", status_code=204)
def delete_view(view_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM grid_view WHERE id = %s", (view_id,))


class FavouriteIn(BaseModel):
    is_favourite: bool


@router.put("/places/{place_id}/favourite")
def set_favourite(place_id: UUID, body: FavouriteIn, person: Person) -> dict:
    with tx(person) as conn:
        row = conn.execute("UPDATE place SET is_favourite = %s WHERE id = %s RETURNING id, is_favourite",
                           (body.is_favourite, place_id)).fetchone()
    if row is None:
        raise not_found("Place")
    return row
