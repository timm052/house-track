"""Household members and household settings."""

from uuid import UUID

from fastapi import APIRouter, HTTPException
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
