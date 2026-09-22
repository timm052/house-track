"""Load one state's G-NAF release into the `gnaf` database as a single flat `address` table.

The quarterly G-NAF zip (data.gov.au, Open G-NAF EULA) holds pipe-separated files per state.
We stage the four tables we need, join them, and compute each address's key with the same
normaliser the API uses, so an exact key lookup matches a typed-in property (PLAN.md §2).
The new table is built beside the old one and swapped in at the end, so a failed run leaves
the previous release in place.
"""

import json
import re
import time
import zipfile
from pathlib import Path
from urllib.request import urlopen

import psycopg

from ..address import Address, address_key, display, normalise
from .fetch import download

CKAN_PACKAGE = "https://data.gov.au/data/api/3/action/package_show?id=geocoded-national-address-file-g-naf"
TABLES = ("ADDRESS_DETAIL", "ADDRESS_DEFAULT_GEOCODE", "STREET_LOCALITY", "LOCALITY")
PARCEL = re.compile(r"^(?P<lot>[0-9A-Z]+)\\(?P<plan>[A-Z]{2}[0-9]+[A-Z]?)$")


def latest_zip_url() -> str:
    """The newest GDA2020 PSV zip listed on data.gov.au."""
    with urlopen(CKAN_PACKAGE, timeout=60) as r:
        resources = json.load(r)["result"]["resources"]
    zips = [
        res for res in resources
        if res.get("url", "").lower().endswith(".zip") and "gda2020" in (res.get("url", "") + res.get("name", "")).lower()
    ]
    if not zips:
        raise RuntimeError("No G-NAF GDA2020 zip found on data.gov.au; set GNAF_ZIP_URL to override.")
    zips.sort(key=lambda res: res.get("last_modified") or res.get("created") or "", reverse=True)
    return zips[0]["url"]


def fetch(download_dir: Path, url: str | None = None) -> Path:
    return download(url or latest_zip_url(), download_dir)


def _member(zf: zipfile.ZipFile, state: str, table: str) -> str:
    pattern = re.compile(rf"(^|/)Standard/{state}_{table}_psv\.psv$", re.I)
    names = [n for n in zf.namelist() if pattern.search(n)]
    if not names:
        raise RuntimeError(f"{state}_{table}_psv.psv not found in the G-NAF zip")
    return names[0]


def _stage(conn: psycopg.Connection, zf: zipfile.ZipFile, member: str, table: str) -> None:
    with zf.open(member) as f:
        header = f.readline().decode("utf-8-sig").strip().lower().split("|")
    cols = ", ".join(f'"{c}" text' for c in header)
    conn.execute(f"DROP TABLE IF EXISTS stage.{table}")
    conn.execute(f"CREATE UNLOGGED TABLE stage.{table} ({cols})")
    # G-NAF files aren't quoted CSV: disable quoting with a byte that never appears.
    copy_sql = f"COPY stage.{table} FROM STDIN WITH (FORMAT csv, DELIMITER '|', HEADER true, QUOTE E'\\x01')"
    with conn.cursor() as cur, cur.copy(copy_sql) as cp, zf.open(member) as f:
        while chunk := f.read(1 << 20):
            cp.write(chunk)


JOIN = """
SELECT ad.address_detail_pid,
       nullif(concat(ad.flat_number_prefix, ad.flat_number, ad.flat_number_suffix), '') AS unit,
       nullif(concat(ad.number_first_prefix, ad.number_first, ad.number_first_suffix), '') AS n1,
       nullif(concat(ad.number_last_prefix, ad.number_last, ad.number_last_suffix), '') AS n2,
       nullif(ad.number_first, '') AS number_first,
       concat_ws(' ', nullif(sl.street_name, ''), nullif(sl.street_type_code, '')) AS street,
       l.locality_name, ad.postcode,
       nullif(concat(ad.lot_number_prefix, ad.lot_number, ad.lot_number_suffix), '') AS lot,
       ad.legal_parcel_id,
       ad.alias_principal = 'A' AS is_alias,
       g.geocode_type_code, g.longitude, g.latitude
FROM stage.address_detail ad
JOIN stage.street_locality sl ON sl.street_locality_pid = ad.street_locality_pid
JOIN stage.locality l ON l.locality_pid = ad.locality_pid
JOIN stage.address_default_geocode g
  ON g.address_detail_pid = ad.address_detail_pid AND coalesce(g.date_retired, '') = ''
WHERE coalesce(ad.date_retired, '') = ''
"""

COLUMNS = ("pid", "unit", "street_number", "number_first", "street", "suburb", "postcode", "lot_number",
           "plan_number", "display", "address_key", "search", "geocode_type", "is_alias", "lon", "lat", "location")


def _rows(conn: psycopg.Connection):
    with conn.cursor(name="gnaf_join") as cur:
        cur.itersize = 20_000
        cur.execute(JOIN)
        for (pid, unit, n1, n2, number_first, street, suburb, postcode, lot, parcel, is_alias,
             gtype, lon, lat) in cur:
            m = PARCEL.match(parcel or "")
            plan, parcel_lot = (m["plan"], m["lot"]) if m else (None, None)
            number = f"{n1}-{n2}" if n1 and n2 else n1
            if not number and not plan:
                continue  # neither a street number nor a plan: nothing to match on
            a = normalise(Address(unit=unit, street_number=number, street=street.title() or None,
                                  suburb=suburb, postcode=postcode,
                                  plan_number=plan, lot_number=(lot or parcel_lot) if plan else None))
            text = display(a)
            yield (pid, a.unit, a.street_number, number_first, a.street, a.suburb, a.postcode, a.lot_number,
                   a.plan_number, text, address_key(a), re.sub(r"[^a-z0-9/ -]+", " ", text.lower()),
                   gtype, is_alias, float(lon), float(lat), f"SRID=4326;POINT({lon} {lat})")


def load(zip_path: Path, state: str, gnaf_url: str) -> int:
    started = time.monotonic()
    with psycopg.connect(gnaf_url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        conn.execute("CREATE SCHEMA IF NOT EXISTS stage")
        with zipfile.ZipFile(zip_path) as zf:
            for table in TABLES:
                print(f"gnaf: staging {state} {table}", flush=True)
                _stage(conn, zf, _member(zf, state, table), table.lower())

        conn.execute("DROP TABLE IF EXISTS address_new")
        conn.execute("""CREATE TABLE address_new (
            pid text PRIMARY KEY, unit text, street_number text, number_first text, street text,
            suburb text, postcode text, lot_number text, plan_number text, display text NOT NULL,
            address_key text NOT NULL, search text NOT NULL, geocode_type text, is_alias boolean NOT NULL,
            lon double precision NOT NULL, lat double precision NOT NULL,
            location geometry(Point, 4326) NOT NULL)""")
        count = 0
        with psycopg.connect(gnaf_url) as reader, conn.cursor() as cur, \
                cur.copy(f"COPY address_new ({', '.join(COLUMNS)}) FROM STDIN") as cp:
            for row in _rows(reader):
                cp.write_row(row)
                count += 1
                if count % 500_000 == 0:
                    print(f"gnaf: {count:,} addresses", flush=True)

        print("gnaf: indexing", flush=True)
        conn.execute("CREATE INDEX address_new_key ON address_new (address_key)")
        conn.execute("CREATE INDEX address_new_number ON address_new (number_first)")
        conn.execute("CREATE INDEX address_new_parcel ON address_new (plan_number, lot_number)")
        conn.execute("CREATE INDEX address_new_search ON address_new USING gin (search gin_trgm_ops)")
        with conn.transaction():
            conn.execute("DROP TABLE IF EXISTS address")
            conn.execute("ALTER TABLE address_new RENAME TO address")
            for suffix in ("pkey", "key", "number", "parcel", "search"):
                conn.execute(f"ALTER INDEX IF EXISTS address_new_{suffix} RENAME TO address_{suffix}")
            conn.execute("CREATE TABLE IF NOT EXISTS meta (loaded_at timestamptz NOT NULL, source text, state text, rows bigint)")
            conn.execute("DELETE FROM meta")
            conn.execute("INSERT INTO meta VALUES (now(), %s, %s, %s)", (zip_path.name, state, count))
        conn.execute("DROP SCHEMA stage CASCADE")
        conn.execute("ANALYZE address")
    print(f"gnaf: {count:,} {state} addresses loaded in {time.monotonic() - started:.0f}s", flush=True)
    return count
