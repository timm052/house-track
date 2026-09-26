"""Household members and household settings."""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from psycopg import sql
from psycopg.types.json import Jsonb

from ..db import tx
from ..deps import Person, not_found, update_columns
from ..schemas import PersonIn, PersonPatch, SettingIn

router = APIRouter(prefix="/api")

SETTING_KEYS = {"walk_limit_min"}


@router.get("/persons")
def list_persons() -> list[dict]:
    with tx() as conn:
        return conn.execute(
            "SELECT id, display_name, colour, active FROM person ORDER BY created_at"
        ).fetchall()


@router.post("/persons", status_code=201)
def create_person(body: PersonIn) -> dict:
    # No X-Person-Id needed: this is how the first-run screen creates the household.
    with tx() as conn:
        return conn.execute(
            "INSERT INTO person (display_name, colour) VALUES (%s, %s) "
            "RETURNING id, display_name, colour, active",
            (body.display_name.strip(), body.colour),
        ).fetchone()


@router.patch("/persons/{person_id}")
def update_person(person_id: UUID, body: PersonPatch, _: Person) -> dict:
    with tx() as conn:
        if update_columns(conn, "person", person_id, body.model_dump(exclude_unset=True)) is None:
            raise not_found("Person")
        return conn.execute(
            "SELECT id, display_name, colour, active FROM person WHERE id = %s", (person_id,)
        ).fetchone()


# Deleting a person: what happens to each column that refers to them. Created-by and updated-by columns
# everywhere are handed to whoever deletes them; anything not listed here stops the delete, so a new
# reference added later can't be silently mishandled.
REMOVE_WITH_PERSON = {("opinion", "person_id"), ("criterion_score", "person_id"), ("area", "owner_id"),
                      ("inspection_attendee", "person_id")}  # their own verdicts, scores, areas, attendance
CLEAR = {("place", "person_id"), ("audit_log", "person_id")}  # "Sam's work" becomes a shared place; the log keeps the rest
HAND_OVER = {("property", "manual_location_by"), ("checklist_item", "done_by"), ("shared_link", "shared_by")}


@router.delete("/persons/{person_id}", status_code=204)
def delete_person(person_id: UUID, me: Person) -> None:
    """Remove someone from the household (see migration 0007)."""
    if person_id == me:
        raise HTTPException(409, "You can't delete yourself. Switch to someone else first.")
    with tx(me) as conn:
        if conn.execute("SELECT 1 FROM person WHERE id = %s FOR UPDATE", (person_id,)).fetchone() is None:
            raise not_found("Person")
        conn.execute("SELECT set_config('app.handing_over', 'on', true)")
        refs = conn.execute("""SELECT kcu.table_name, kcu.column_name
                               FROM information_schema.referential_constraints rc
                               JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
                               JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name
                               WHERE ccu.table_name = 'person' AND kcu.table_name <> 'person'""").fetchall()
        refs = sorted({(r["table_name"], r["column_name"]) for r in refs}, key=lambda r: ((r not in REMOVE_WITH_PERSON), r))
        for table, column in refs:
            target = sql.SQL("{}.{}").format(sql.Identifier(table), sql.Identifier(column))
            if (table, column) in REMOVE_WITH_PERSON:
                conn.execute(sql.SQL("DELETE FROM {} WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(column)), (person_id,))
            elif (table, column) in CLEAR:
                conn.execute(sql.SQL("UPDATE {} SET {} = NULL WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(column),
                                                                                     sql.Identifier(column)), (person_id,))
            elif column in ("created_by", "updated_by") or (table, column) in HAND_OVER:
                conn.execute(sql.SQL("UPDATE {} SET {} = %s WHERE {} = %s").format(sql.Identifier(table), sql.Identifier(column),
                                                                                   sql.Identifier(column)), (me, person_id))
            else:
                raise HTTPException(500, f"Don't know how to hand over {target.as_string(conn)} when deleting a person.")
        conn.execute("DELETE FROM person WHERE id = %s", (person_id,))


@router.get("/settings")
def get_settings() -> dict:
    with tx() as conn:
        rows = conn.execute("SELECT key, value FROM household_setting").fetchall()
    return {"walk_limit_min": 20} | {r["key"]: r["value"] for r in rows}


@router.put("/settings/{key}")
def put_setting(key: str, body: SettingIn, person: Person) -> dict:
    if key not in SETTING_KEYS:
        raise not_found("Setting")
    if key == "walk_limit_min" and not (type(body.value) is int and 1 <= body.value <= 120):
        raise HTTPException(422, "walk_limit_min must be a whole number of minutes from 1 to 120.")
    with tx(person) as conn:
        conn.execute(
            "INSERT INTO household_setting (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (key, Jsonb(body.value)),
        )
    return get_settings()
