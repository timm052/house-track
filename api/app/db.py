from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_pool: ConnectionPool | None = None


def open_pool(url: str) -> None:
    global _pool
    _pool = ConnectionPool(url, min_size=1, max_size=8, kwargs={"row_factory": dict_row}, open=True)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def tx(person_id: UUID | None = None) -> Iterator[psycopg.Connection]:
    """One transaction. Writes pass the acting person, which the schema's defaults,
    touch() and audit_row() read back through app_person(); unattributed writes fail
    the NOT NULL created_by/updated_by columns."""
    assert _pool is not None, "database pool not open"
    with _pool.connection() as conn, conn.transaction():
        if person_id is not None:
            conn.execute("SELECT set_config('app.person_id', %s, true)", (str(person_id),))
        yield conn
