"""Tags: free labels on houses ("corner block", "needs reno", "north garden"), shared by the household.
The tag and property_tag tables were in the signed-off schema (0001)."""

import re
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import tx
from ..deps import Person, not_found

router = APIRouter(prefix="/api")
PALETTE = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#db2777", "#0891b2", "#65a30d", "#dc2626"]


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    colour: str | None = Field(default=None, pattern=r"^#[0-9a-f]{6}$")


class TagPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    colour: str | None = Field(default=None, pattern=r"^#[0-9a-f]{6}$")


class PropertyTagsIn(BaseModel):
    names: list[str]


def clean(name: str) -> str:
    return re.sub(r"\s+", " ", name).strip()


def ensure_tags(conn, names: list[str]) -> list[UUID]:
    """Existing tags by name (case-insensitive), creating any that are new."""
    ids = []
    for name in dict.fromkeys(clean(n) for n in names if clean(n)):
        row = conn.execute("SELECT id FROM tag WHERE lower(name) = lower(%s)", (name,)).fetchone()
        if row is None:
            n = conn.execute("SELECT count(*) AS n FROM tag").fetchone()["n"]
            row = conn.execute("INSERT INTO tag (name, colour) VALUES (%s, %s) RETURNING id", (name, PALETTE[n % len(PALETTE)])).fetchone()
        ids.append(row["id"])
    return ids


def set_property_tags(conn, property_id: UUID, names: list[str]) -> None:
    wanted = ensure_tags(conn, names)
    conn.execute("DELETE FROM property_tag WHERE property_id = %s AND NOT (tag_id = ANY(%s))", (property_id, wanted))
    for tag_id in wanted:
        conn.execute("INSERT INTO property_tag (property_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (property_id, tag_id))


@router.get("/tags")
def list_tags() -> list[dict]:
    with tx() as conn:
        return conn.execute("""SELECT t.id, t.name, t.colour, count(pt.property_id) AS houses
                               FROM tag t LEFT JOIN property_tag pt ON pt.tag_id = t.id
                               GROUP BY t.id ORDER BY lower(t.name)""").fetchall()


@router.post("/tags", status_code=201)
def create_tag(body: TagIn, person: Person) -> dict:
    with tx(person) as conn:
        [tag_id] = ensure_tags(conn, [body.name])
        if body.colour:
            conn.execute("UPDATE tag SET colour = %s WHERE id = %s", (body.colour, tag_id))
        return conn.execute("SELECT id, name, colour FROM tag WHERE id = %s", (tag_id,)).fetchone()


@router.patch("/tags/{tag_id}")
def update_tag(tag_id: UUID, body: TagPatch, person: Person) -> dict:
    with tx(person) as conn:
        if body.name is not None:
            clash = conn.execute("SELECT 1 FROM tag WHERE lower(name) = lower(%s) AND id <> %s", (clean(body.name), tag_id)).fetchone()
            if clash:
                raise HTTPException(409, "There's already a tag with that name.")
            conn.execute("UPDATE tag SET name = %s WHERE id = %s", (clean(body.name), tag_id))
        if body.colour is not None:
            conn.execute("UPDATE tag SET colour = %s WHERE id = %s", (body.colour, tag_id))
        row = conn.execute("SELECT id, name, colour FROM tag WHERE id = %s", (tag_id,)).fetchone()
    if row is None:
        raise not_found("Tag")
    return row


@router.delete("/tags/{tag_id}", status_code=204)
def delete_tag(tag_id: UUID, person: Person) -> None:
    """Removes the tag from every house (audited)."""
    with tx(person) as conn:
        conn.execute("DELETE FROM property_tag WHERE tag_id = %s", (tag_id,))
        conn.execute("DELETE FROM tag WHERE id = %s", (tag_id,))


@router.put("/properties/{property_id}/tags")
def put_property_tags(property_id: UUID, body: PropertyTagsIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        set_property_tags(conn, property_id, body.names)
        names = [r["name"] for r in conn.execute(
            "SELECT t.name FROM property_tag pt JOIN tag t ON t.id = pt.tag_id WHERE pt.property_id = %s ORDER BY lower(t.name)",
            (property_id,))]
    return {"tags": names}
