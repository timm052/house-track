"""Lookups against the G-NAF address database built by the setup job (app/setup/gnaf_load.py).

G-NAF lives in its own database (`gnaf`), rebuilt from source each quarter and left out of
backups (PLAN.md §4). Everything here degrades to "no result" when that database hasn't been
built yet, so milestone-1 behaviour keeps working.
"""

import logging
import re
import time

import psycopg
from psycopg.rows import dict_row

from .address import STREET_TYPES

log = logging.getLogger(__name__)
_url: str | None = None
_down_until = 0.0  # while the database is missing or unreachable, skip lookups instead of waiting
RETRY_AFTER_S = 60

# Confidence by G-NAF default geocode type: parcel/building-level points are good enough for a pin;
# street- and locality-level ones are not.
GEOCODE_CONFIDENCE = {"STL": 0.4, "LOC": 0.2, "GG": 0.6}


def confidence_for(geocode_type: str | None) -> float:
    return GEOCODE_CONFIDENCE.get(geocode_type or "", 0.9)


def configure(url: str | None) -> None:
    """Lookups are occasional (autocomplete, the worker), so plain short-lived connections suffice."""
    global _url, _down_until
    _url, _down_until = url, 0.0


def reset() -> None:
    global _url
    _url = None


def _query(sql: str, params: tuple) -> list[dict]:
    global _down_until
    if _url is None or time.monotonic() < _down_until:
        return []
    try:
        with psycopg.connect(_url, connect_timeout=3, row_factory=dict_row) as conn:
            return conn.execute(sql, params).fetchall()
    except psycopg.errors.UndefinedTable:
        return []  # database exists but setup hasn't loaded G-NAF yet
    except psycopg.OperationalError as e:
        _down_until = time.monotonic() + RETRY_AFTER_S
        log.warning("G-NAF lookups paused for %ss: %s", RETRY_AFTER_S, str(e).strip().splitlines()[-1])
        return []


COLUMNS = "pid, unit, street_number, street, suburb, postcode, lot_number, display, geocode_type, lon, lat"


def by_pid(pid: str) -> dict | None:
    rows = _query(f"SELECT {COLUMNS} FROM address WHERE pid = %s", (pid,))
    return rows[0] if rows else None


def by_key(address_key: str) -> dict | None:
    # Principal addresses first when an alias shares the key.
    rows = _query(f"SELECT {COLUMNS} FROM address WHERE address_key = %s ORDER BY is_alias LIMIT 1", (address_key,))
    return rows[0] if rows else None


def by_parcel(plan_number: str, lot_number: str) -> dict | None:
    rows = _query(f"SELECT {COLUMNS} FROM address WHERE plan_number = %s AND lot_number = %s ORDER BY is_alias LIMIT 1",
                  (plan_number, lot_number))
    return rows[0] if rows else None


_localities: tuple[object, list[dict]] | None = None  # (loaded_at, [{suburb, postcode}])


def localities(q: str, limit: int = 8) -> list[dict]:
    """Suburbs (with their postcodes) matching what's been typed: names starting with it first, then containing it.
    The distinct list takes seconds to read from 4 million addresses, so it's read once per G-NAF release."""
    global _localities
    stamp = loaded_at()
    if stamp is None:
        return []
    if _localities is None or _localities[0] != stamp:
        rows = _query("SELECT DISTINCT suburb, postcode FROM address WHERE suburb IS NOT NULL ORDER BY suburb, postcode", ())
        _localities = (stamp, rows)
    q = q.strip().lower()
    if len(q) < 2:
        return []
    names = _localities[1]
    first = [r for r in names if r["suburb"].lower().startswith(q)]
    return (first + [r for r in names if q in r["suburb"].lower() and r not in first])[:limit]


def loaded_at():
    """When the current G-NAF release was loaded, or None if it hasn't been."""
    rows = _query("SELECT loaded_at FROM meta", ())
    return rows[0]["loaded_at"] if rows else None


def search_text(q: str) -> str:
    """Lower-case the query and expand street-type abbreviations the way stored addresses are written.
    "st" is only read as "street" when it isn't directly after a number ("12 St Kilda Rd")."""
    words = re.sub(r"[^a-z0-9/ -]+", " ", q.lower()).split()
    out = []
    for i, w in enumerate(words):
        prev_is_number = i > 0 and words[i - 1][:1].isdigit()
        if w in STREET_TYPES and not (w == "st" and (prev_is_number or i == 0)):
            w = STREET_TYPES[w]
        out.append(w)
    return " ".join(out)


def search(q: str, limit: int = 8) -> list[dict]:
    text = search_text(q)
    if len(text) < 4:
        return []
    number = re.match(r"^(?:[0-9a-z]+/)?(\d+)", text)
    return _query(
        f"""SELECT {COLUMNS}, word_similarity(%s, search) AS score FROM address
            WHERE %s <%% search AND (%s::text IS NULL OR number_first = %s)
            ORDER BY score DESC, is_alias, display LIMIT %s""",
        (text, text, number and number.group(1), number and number.group(1), limit),
    )
