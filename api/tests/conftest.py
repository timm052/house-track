"""Integration tests run against a real PostGIS 18 server.

Set TEST_ADMIN_URL to a superuser connection on a scratch server, e.g.
    docker run -d --name housetrack-testdb -e POSTGRES_USER=house -e POSTGRES_PASSWORD=house \
        -p 55432:5432 postgis/postgis:18-3.6
    TEST_ADMIN_URL=postgresql://house:house@localhost:55432/postgres uv run pytest
A fresh `house_test` database is created for each run. Tests that need it are skipped when
TEST_ADMIN_URL is unset.
"""

import os
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg.rows import dict_row

ADMIN_URL = os.environ.get("TEST_ADMIN_URL")


def _db_url(name: str) -> str:
    parts = urlsplit(ADMIN_URL)
    return urlunsplit(parts._replace(path=f"/{name}"))


@pytest.fixture(scope="session")
def database_url() -> str:
    if not ADMIN_URL:
        pytest.skip("TEST_ADMIN_URL not set")
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS house_test WITH (FORCE)")
        conn.execute("CREATE DATABASE house_test")
    from app.migrate import migrate

    url = _db_url("house_test")
    migrate(url)
    return url


@pytest.fixture(scope="session")
def gnaf_url(database_url, tmp_path_factory) -> str:
    """A `gnaf_test` database loaded from a tiny zip laid out like a real G-NAF release."""
    from app.setup.gnaf_load import load

    from .gnaf_fixture import build_zip

    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS gnaf_test WITH (FORCE)")
        conn.execute("CREATE DATABASE gnaf_test")
    url = _db_url("gnaf_test")
    load(build_zip(tmp_path_factory.mktemp("gnaf")), "VIC", url)
    return url


@pytest.fixture(scope="session")
def client(database_url, gnaf_url):
    os.environ["DATABASE_URL"] = database_url
    os.environ["GNAF_DATABASE_URL"] = gnaf_url
    os.environ["WORKER"] = "0"  # tests drive the worker's steps directly
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def sql(database_url):
    """Raw connection for asserting on the schema directly."""
    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as conn:
        yield conn


@pytest.fixture(scope="session")
def people(client) -> dict[str, dict]:
    a = client.post("/api/persons", json={"display_name": "Alex", "colour": "#1f77b4"}).json()
    b = client.post("/api/persons", json={"display_name": "Sam", "colour": "#d62728"}).json()
    return {"a": a, "b": b}


def as_(person: dict) -> dict:
    return {"X-Person-Id": str(person["id"])}
