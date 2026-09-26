"""Floor plan markups (migration 0015): named versions of a floor plan with a scale, drawings, dimension lines and
real-size furniture, shared by the household. Saving checks the version hasn't changed since it was opened, so two
people editing the same version don't silently overwrite each other; the second is asked to save a new version."""

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import tx
from ..deps import Person, not_found

router = APIRouter(prefix="/api")

MAX_SHAPES = 2000
COLUMNS = "id, attachment_id, name, px_per_m, shapes, created_at, created_by, updated_at, updated_by"


class MarkupIn(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    px_per_m: Annotated[float, Field(gt=0)] | None = None
    shapes: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_SHAPES)


class MarkupSave(MarkupIn):
    # When the version was loaded: saving over someone else's newer save is refused (409).
    expected_updated_at: datetime | None = None


def _plan(conn, attachment_id: UUID) -> dict:
    row = conn.execute("SELECT id, mime_type FROM attachment WHERE id = %s", (attachment_id,)).fetchone()
    if row is None:
        raise not_found("Attachment")
    if not (row["mime_type"] or "").startswith(("image/", "application/pdf")):
        raise HTTPException(422, "Only an image or a PDF can be marked up.")
    return row


@router.get("/attachments/{attachment_id}/markups")
def markups(attachment_id: UUID) -> list[dict]:
    with tx() as conn:
        _plan(conn, attachment_id)
        return conn.execute(f"SELECT {COLUMNS} FROM floorplan_markup WHERE attachment_id = %s ORDER BY created_at",
                            (attachment_id,)).fetchall()


@router.post("/attachments/{attachment_id}/markups", status_code=201)
def create_markup(attachment_id: UUID, body: MarkupIn, person: Person) -> dict:
    from psycopg.types.json import Jsonb
    with tx(person) as conn:
        _plan(conn, attachment_id)
        return conn.execute(
            f"""INSERT INTO floorplan_markup (attachment_id, name, px_per_m, shapes) VALUES (%s, %s, %s, %s)
                RETURNING {COLUMNS}""", (attachment_id, body.name.strip(), body.px_per_m, Jsonb(body.shapes))).fetchone()


@router.put("/markups/{markup_id}")
def save_markup(markup_id: UUID, body: MarkupSave, person: Person) -> dict:
    from psycopg.types.json import Jsonb
    with tx(person) as conn:
        current = conn.execute("SELECT updated_at, updated_by FROM floorplan_markup WHERE id = %s FOR UPDATE",
                               (markup_id,)).fetchone()
        if current is None:
            raise not_found("Markup")
        if body.expected_updated_at is not None and current["updated_at"] != body.expected_updated_at:
            name = conn.execute("SELECT display_name FROM person WHERE id = %s", (current["updated_by"],)).fetchone()
            raise HTTPException(409, f"{name['display_name'] if name else 'Someone'} saved this version since you opened it. "
                                     "Save yours as a new version, or reload to see theirs.")
        return conn.execute(
            f"""UPDATE floorplan_markup SET name = %s, px_per_m = %s, shapes = %s WHERE id = %s RETURNING {COLUMNS}""",
            (body.name.strip(), body.px_per_m, Jsonb(body.shapes), markup_id)).fetchone()


@router.delete("/markups/{markup_id}", status_code=204)
def delete_markup(markup_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM floorplan_markup WHERE id = %s", (markup_id,))
