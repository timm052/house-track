from typing import Annotated, Any
from uuid import UUID

import psycopg
from fastapi import Depends, Header, HTTPException
from psycopg import sql

from .db import tx


def acting_person(x_person_id: Annotated[UUID | None, Header()] = None) -> UUID:
    """Identity, not authentication: the profile picker sends the chosen person's id."""
    if x_person_id is None:
        raise HTTPException(400, "Pick a profile first (X-Person-Id header missing).")
    with tx() as conn:
        row = conn.execute("SELECT active FROM person WHERE id = %s", (x_person_id,)).fetchone()
    if row is None or not row["active"]:
        raise HTTPException(403, "Unknown or inactive profile.")
    return x_person_id


Person = Annotated[UUID, Depends(acting_person)]


def maybe_person(x_person_id: Annotated[UUID | None, Header()] = None) -> UUID | None:
    """For reads that personalise (per-person area flags) but also work without a profile."""
    return x_person_id


OptionalPerson = Annotated[UUID | None, Depends(maybe_person)]


def update_columns(conn: psycopg.Connection, table: str, row_id: UUID, values: dict[str, Any]) -> dict | None:
    """UPDATE only the given columns. Column names come from Pydantic models, never from request keys."""
    if not values:
        return conn.execute(
            sql.SQL("SELECT id FROM {} WHERE id = %s").format(sql.Identifier(table)), (row_id,)
        ).fetchone()
    assignments = sql.SQL(", ").join(
        sql.SQL("{} = {}").format(sql.Identifier(k), sql.Placeholder(k)) for k in values
    )
    query = sql.SQL("UPDATE {} SET {} WHERE id = %(id)s RETURNING id").format(sql.Identifier(table), assignments)
    return conn.execute(query, {**values, "id": row_id}).fetchone()


def not_found(what: str) -> HTTPException:
    return HTTPException(404, f"{what} not found.")
