"""Background work inside the API process (single instance, so no queue is needed):

1. Geocode properties that have no pin: G-NAF by address key, then by plan + lot, then Nominatim.
2. Route properties to places wherever `travel_estimate_stale` says a result is missing or out of date.
3. Read Statements of Information: download linked ones, record their comparable sales and indicative price.

Writes to `property` are attributed to whoever last edited that property, because the schema
requires a person on every change and this work happens on their behalf.
"""

import logging
import re
import threading
from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from psycopg.types.json import Jsonb

from . import blobs, blocks, gnaf, statement
from .setup import overlays
from .address import Address, address_key, normalise
from .db import tx
from .geo_services import Nominatim, Transitous, Valhalla, next_weekday_9am

log = logging.getLogger("housetrack.worker")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def apply_geocode(property_id: UUID, person: UUID, lon: float, lat: float, source: str, confidence: float,
                  detail: dict, gnaf_pid: str | None = None) -> None:
    with tx(person) as conn:
        conn.execute(
            """UPDATE property SET geocoded_location = ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                   geocode_source = %s, geocode_confidence = %s, geocode_detail = %s,
                   gnaf_pid = coalesce(%s, gnaf_pid)
               WHERE id = %s""",
            (lon, lat, source, confidence, Jsonb(detail | {"status": "done", "at": _now()}), gnaf_pid, property_id),
        )


def mark_unmatched(property_id: UUID, person: UUID, tried: list[str]) -> None:
    with tx(person) as conn:
        conn.execute("UPDATE property SET geocode_detail = %s WHERE id = %s",
                     (Jsonb({"status": "no_match", "tried": tried, "at": _now()}), property_id))


def gnaf_hit_to_detail(hit: dict) -> dict:
    return {"gnaf_display": hit["display"], "geocode_type": hit["geocode_type"]}


def match_gnaf(row: dict) -> dict | None:
    a = normalise(Address(**{k: row[k] for k in ("unit", "street_number", "street", "suburb", "postcode",
                                                  "plan_number", "lot_number")}))
    hit = gnaf.by_key(address_key(a))
    if hit is None and a.plan_number and a.lot_number:
        hit = gnaf.by_parcel(a.plan_number, a.lot_number)
    return hit


def geocode_pending(nominatim: Nominatim | None, limit: int = 5) -> int:
    """Returns how many properties it attempted."""
    gnaf_loaded = gnaf.loaded_at()
    with tx() as conn:
        rows = conn.execute(
            """SELECT id, unit, street_number, street, suburb, postcode, plan_number, lot_number, updated_by,
                      geocode_detail
               FROM property
               WHERE manual_location IS NULL AND geocoded_location IS NULL
                 AND (geocode_detail IS NULL OR geocode_detail->>'status' = 'pending'
                      OR (geocode_detail->>'status' = 'no_match' AND %s::timestamptz > (geocode_detail->>'at')::timestamptz))
               ORDER BY updated_at LIMIT %s""",
            (gnaf_loaded, limit),
        ).fetchall()
    for row in rows:
        tried = []
        hit = match_gnaf(row)
        tried.append("gnaf")
        if hit:
            apply_geocode(row["id"], row["updated_by"], hit["lon"], hit["lat"], "gnaf",
                          gnaf.confidence_for(hit["geocode_type"]), gnaf_hit_to_detail(hit), hit["pid"])
            continue
        if nominatim and row["street_number"] and row["street"]:
            tried.append("nominatim")
            try:
                result = nominatim.geocode(f"{row['street_number']} {row['street']}", row["suburb"], row["postcode"])
            except Exception as e:  # network down: try again later, don't mark as unmatched
                log.warning("nominatim failed: %s", e)
                return len(rows)
            if result:
                lon, lat, confidence, detail = result
                apply_geocode(row["id"], row["updated_by"], lon, lat, "nominatim", confidence, detail)
                continue
        mark_unmatched(row["id"], row["updated_by"], tried)
    return len(rows)


def route_stale(valhalla: Valhalla, limit: int = 200) -> int:
    with tx() as conn:
        rows = conn.execute(
            """SELECT s.property_id, s.place_id, s.mode,
                      ST_X(p.location) AS plon, ST_Y(p.location) AS plat,
                      ST_X(pl.location) AS tlon, ST_Y(pl.location) AS tlat
               FROM travel_estimate_stale s
               JOIN property p ON p.id = s.property_id
               JOIN place pl ON pl.id = s.place_id
               LIMIT %s""",
            (limit,),
        ).fetchall()
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["property_id"], r["mode"], r["plon"], r["plat"])].append(r)
    for (property_id, mode, plon, plat), targets in groups.items():
        routes = valhalla.matrix((plon, plat), [(t["tlon"], t["tlat"]) for t in targets], mode)
        with tx() as conn:
            for t, route in zip(targets, routes):
                conn.execute(
                    """INSERT INTO travel_estimate (property_id, place_id, mode, origin, destination,
                                                    distance_m, duration_s, engine, computed_at)
                       VALUES (%s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                               ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s, 'valhalla', now())
                       ON CONFLICT (property_id, place_id, mode) DO UPDATE
                       SET origin = EXCLUDED.origin, destination = EXCLUDED.destination,
                           distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s,
                           engine = EXCLUDED.engine, computed_at = EXCLUDED.computed_at, peak_s = NULL""",
                    (property_id, t["place_id"], mode, plon, plat, t["tlon"], t["tlat"],
                     route.distance_m, route.duration_s),
                )
    return len(rows)


PEAK_PENDING = """SELECT t.property_id, t.place_id, ST_X(t.origin) AS lon, ST_Y(t.origin) AS lat,
                          ST_X(t.destination) AS to_lon, ST_Y(t.destination) AS to_lat
                   FROM travel_estimate t JOIN place pl ON pl.id = t.place_id AND pl.kind = 'destination'
                   WHERE t.mode = 'drive' AND t.duration_s IS NOT NULL AND t.peak_s IS NULL"""


def route_peak(valhalla: Valhalla, limit: int = 2) -> int:
    """Each drive to a destination again in peak hour, weighted by the kinds of road it uses (migration 0012).
    Two routing requests a drive."""
    with tx() as conn:
        rows = conn.execute(PEAK_PENDING + " LIMIT %s", (limit,)).fetchall()
    for r in rows:
        peak = valhalla.drive_peak((r["lon"], r["lat"]), (r["to_lon"], r["to_lat"]))
        with tx() as conn:
            # No answer: the free-flow time stands in, so it isn't asked for forever.
            conn.execute("""UPDATE travel_estimate SET peak_s = coalesce(%s, duration_s)
                            WHERE property_id = %s AND place_id = %s AND mode = 'drive'""", (peak, r["property_id"], r["place_id"]))
    return len(rows)


def route_transit(transitous: Transitous, limit: int = 2) -> int:
    """Public transport from each pinned house to each destination, arriving by 9am on the next weekday, and home
    again leaving at 5pm (migrations 0010, 0012)."""
    with tx() as conn:
        rows = conn.execute("SELECT * FROM transit_estimate_stale LIMIT %s", (limit,)).fetchall()
    arrive_by = next_weekday_9am()
    leave_at = arrive_by.replace(hour=17)
    for r in rows:
        found = transitous.plan((r["lon"], r["lat"]), (r["to_lon"], r["to_lat"]), arrive_by=arrive_by) or {}
        home = transitous.plan((r["to_lon"], r["to_lat"]), (r["lon"], r["lat"]), depart_at=leave_at) or {}
        with tx() as conn:
            conn.execute(
                """INSERT INTO transit_estimate (property_id, place_id, origin, destination, arrive_by, depart_at, arrive_at,
                                               duration_s, transfers, legs, home_depart_at, home_arrive_at, home_duration_s,
                                               home_transfers, home_legs, computed_at)
                   VALUES (%(p)s, %(pl)s, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), ST_SetSRID(ST_MakePoint(%(tlon)s, %(tlat)s), 4326),
                           %(by)s, %(dep)s, %(arr)s, %(dur)s, %(tr)s, %(legs)s, %(hdep)s, %(harr)s, %(hdur)s, %(htr)s, %(hlegs)s, now())
                   ON CONFLICT (property_id, place_id) DO UPDATE SET origin = EXCLUDED.origin, destination = EXCLUDED.destination,
                       arrive_by = EXCLUDED.arrive_by, depart_at = EXCLUDED.depart_at, arrive_at = EXCLUDED.arrive_at,
                       duration_s = EXCLUDED.duration_s, transfers = EXCLUDED.transfers, legs = EXCLUDED.legs,
                       home_depart_at = EXCLUDED.home_depart_at, home_arrive_at = EXCLUDED.home_arrive_at,
                       home_duration_s = EXCLUDED.home_duration_s, home_transfers = EXCLUDED.home_transfers,
                       home_legs = EXCLUDED.home_legs, computed_at = now()""",
                {"p": r["property_id"], "pl": r["place_id"], "lon": r["lon"], "lat": r["lat"], "tlon": r["to_lon"], "tlat": r["to_lat"],
                 "by": arrive_by, "dep": found.get("depart_at"), "arr": found.get("arrive_at"), "dur": found.get("duration_s"),
                 "tr": found.get("transfers"), "legs": Jsonb(found.get("legs", [])),
                 "hdep": home.get("depart_at"), "harr": home.get("arrive_at"), "hdur": home.get("duration_s"),
                 "htr": home.get("transfers"), "hlegs": Jsonb(home.get("legs", []))})
    return len(rows)


NEAREST_CANDIDATES = 3


def route_station_access(valhalla: Valhalla, limit: int = 3) -> int:
    """Each pinned house's walk and drive to its three closest train stations (as the crow flies), from which
    property_nearest_station picks the nearest (migration 0009). Two routing requests a house."""
    with tx() as conn:
        rows = conn.execute("SELECT property_id, lon, lat FROM station_access_stale LIMIT %s", (limit,)).fetchall()
    for r in rows:
        origin = (r["lon"], r["lat"])
        with tx() as conn:
            near = conn.execute(
                """SELECT osm_id, ST_X(location) AS lon, ST_Y(location) AS lat FROM station
                   ORDER BY location <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326) LIMIT %s""",
                (*origin, NEAREST_CANDIDATES)).fetchall()
        if not near:
            continue
        targets = [(s["lon"], s["lat"]) for s in near]
        routes = {mode: valhalla.matrix(origin, targets, mode) for mode in ("walk", "drive")}
        with tx() as conn:
            conn.execute("DELETE FROM station_access WHERE property_id = %s", (r["property_id"],))
            for mode, found in routes.items():
                for s, route in zip(near, found):
                    conn.execute(
                        """INSERT INTO station_access (property_id, station_osm_id, mode, origin, distance_m, duration_s)
                           VALUES (%s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s)""",
                        (r["property_id"], s["osm_id"], mode, *origin, route.distance_m, route.duration_s))
    return len(rows)


SCHOOL_DRIVE_AFTER_S = 35 * 60  # a walk to school longer than this gets a drive time too


def route_school_access(valhalla: Valhalla, limit: int = 3) -> int:
    """The walk from each pinned house to its zoned primary and secondary school (migration 0013), and the drive
    as well when the walk is over 35 minutes."""
    with tx() as conn:
        rows = conn.execute("SELECT * FROM school_access_stale LIMIT %s", (limit,)).fetchall()
    for r in rows:
        origin, target = (r["lon"], r["lat"]), (r["to_lon"], r["to_lat"])
        [walk] = valhalla.matrix(origin, [target], "walk")
        drive = valhalla.matrix(origin, [target], "drive")[0] if walk.duration_s is None or walk.duration_s > SCHOOL_DRIVE_AFTER_S else None
        with tx() as conn:
            conn.execute(
                """INSERT INTO school_access (property_id, school_no, origin, walk_m, walk_s, drive_m, drive_s)
                   VALUES (%s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s, %s, %s)
                   ON CONFLICT (property_id, school_no) DO UPDATE SET origin = EXCLUDED.origin, walk_m = EXCLUDED.walk_m,
                       walk_s = EXCLUDED.walk_s, drive_m = EXCLUDED.drive_m, drive_s = EXCLUDED.drive_s, computed_at = now()""",
                (r["property_id"], r["school_no"], *origin, walk.distance_m, walk.duration_s,
                 drive and drive.distance_m, drive and drive.duration_s))
    return len(rows)


def lookup_overlays(limit: int = 3) -> int:
    """Streamed planning layers: look each pinned house up once, and again if its pin moves."""
    with tx() as conn:
        rows = conn.execute(
            """SELECT p.id, ST_X(p.location) AS lon, ST_Y(p.location) AS lat
               FROM property p LEFT JOIN overlay_check c ON c.property_id = p.id
               WHERE p.location IS NOT NULL AND (c.property_id IS NULL OR NOT ST_Equals(c.origin, p.location))
               ORDER BY p.updated_at DESC LIMIT %s""",
            (limit,),
        ).fetchall()
    for r in rows:
        found = overlays.lookup_all(r["lon"], r["lat"])  # network errors propagate: retried later
        with tx() as conn:
            conn.execute("DELETE FROM overlay_lookup WHERE property_id = %s", (r["id"],))
            for code, hits in found.items():
                for h in hits:
                    conn.execute("INSERT INTO overlay_lookup (property_id, layer_code, label, attrs) VALUES (%s, %s, %s, %s)",
                                 (r["id"], code, h["label"], Jsonb(h["attrs"])))
            conn.execute(
                """INSERT INTO overlay_check (property_id, origin) VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                   ON CONFLICT (property_id) DO UPDATE SET origin = EXCLUDED.origin, checked_at = now()""",
                (r["id"], r["lon"], r["lat"]),
            )
    return len(rows)


STATEMENT_RETRY = "1 day"  # a Statement that couldn't be downloaded is tried again after this


def locate_comparable(address: str) -> dict | None:
    """G-NAF's best match for a comparable's address, but only when it's the same house number in the same suburb:
    a near miss would put the sale on the wrong street."""
    hits = gnaf.search(address, limit=1)
    if not hits:
        return None
    hit = hits[0]
    number = (re.match(r"\s*(?:[\w]+/)?(\d+)", address) or [None, None])[1]
    suburb = (address.rsplit(",", 1)[-1] if "," in address else address).lower()
    if not number or str(hit.get("street_number") or "").split("-")[0] != number or (hit.get("suburb") or "~").lower() not in suburb:
        return None
    return hit


def read_statements(limit: int = 1) -> int:
    """Statements of Information not read yet (migration 0012): kept as a copy if they were a link, then read for
    the indicative price, suburb median and comparable sales. Work is done as whoever added the Statement."""
    from fastapi import HTTPException
    from .routes.driveway import download_file
    with tx() as conn:
        rows = conn.execute(
            f"""SELECT a.id, a.property_id, a.campaign_id, a.url, a.sha256, a.mime_type, a.created_by FROM attachment a
                LEFT JOIN statement_read r ON r.attachment_id = a.id
                WHERE a.kind = 'price_statement' AND a.campaign_id IS NOT NULL
                  AND (a.url IS NOT NULL OR a.mime_type = 'application/pdf')
                  AND (r.attachment_id IS NULL OR (r.error IS NOT NULL AND a.url IS NOT NULL AND r.read_at < now() - interval '{STATEMENT_RETRY}'))
                ORDER BY a.created_at DESC LIMIT %s""", (limit,)).fetchall()
    for a in rows:
        found: dict = {}
        error = None
        try:
            if a["url"]:
                data, mime = download_file(a["url"], ("application/pdf",), "application/pdf", "Statement of Information")
                sha = blobs.store(data)
                name = a["url"].split("?")[0].rstrip("/").rsplit("/", 1)[-1][:200] or "statement.pdf"
                with tx(a["created_by"]) as conn:
                    same = conn.execute("""SELECT id FROM attachment WHERE property_id = %s AND campaign_id = %s
                                           AND kind = 'price_statement' AND sha256 = %s AND id <> %s""",
                                        (a["property_id"], a["campaign_id"], sha, a["id"])).fetchone()
                    if same:  # the same Statement under another link: the copy already here is enough
                        conn.execute("DELETE FROM attachment WHERE id = %s", (a["id"],))
                        continue
                    # Kept, so it opens in the app and outlives the listing; the link it came from is remembered
                    # so the next capture of the listing knows it's here.
                    conn.execute("""UPDATE attachment SET sha256 = %s, mime_type = %s, byte_size = %s, original_name = %s,
                                           url = NULL, source_url = %s
                                    WHERE id = %s""", (sha, mime, len(data), name, a["url"], a["id"]))
            else:
                data = blobs.path_for(a["sha256"]).read_bytes()
            found = statement.read(data)
        except HTTPException as e:
            error = str(e.detail)
        except Exception as e:  # noqa: BLE001  a PDF that won't parse is recorded, not retried forever
            error = str(e)[:300] or type(e).__name__
        with tx(a["created_by"]) as conn:
            if not error:
                save_statement(conn, a["campaign_id"], a["id"], found)
            conn.execute("""INSERT INTO statement_read (attachment_id, found, error) VALUES (%s, %s, %s)
                            ON CONFLICT (attachment_id) DO UPDATE SET read_at = now(), found = EXCLUDED.found, error = EXCLUDED.error""",
                         (a["id"], Jsonb(_jsonable(found)), error))
        if error:
            log.info("statement %s: %s", a["id"], error)
    return len(rows)


def _jsonable(v):
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v.isoformat() if hasattr(v, "isoformat") else v


def save_statement(conn, campaign_id: UUID, attachment_id: UUID, found: dict) -> None:
    """What a Statement says, recorded once: its comparable sales (placed on the map where G-NAF knows the address)
    and its indicative price with the suburb median, as a price guide."""
    for c in found.get("comparables", []):
        hit = locate_comparable(c["address"])
        conn.execute(
            """INSERT INTO comparable_sale (campaign_id, source, address, location, sold_price_aud, sold_on, beds, baths,
                                            car_spaces, land_m2, sale_method, attachment_id)
               VALUES (%s, 'price_statement', %s, CASE WHEN %s::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(%s, %s), 4326) END,
                       %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (campaign_id, lower(address), sold_on) DO NOTHING""",
            (campaign_id, c["address"], hit and hit["lon"], hit and hit["lon"], hit and hit["lat"], c["price"], c["sold_on"],
             c.get("beds"), c.get("baths"), c.get("car_spaces"), c.get("land_m2"), c.get("method"), attachment_id))
    low, high = found.get("indicative_low"), found.get("indicative_high")
    if low:
        same = conn.execute("""SELECT 1 FROM price_guide WHERE campaign_id = %s AND source = 'price_statement'
                               AND low_aud = %s AND high_aud = %s""", (campaign_id, low, high or low)).fetchone()
        if not same:
            conn.execute("""INSERT INTO price_guide (campaign_id, source, low_aud, high_aud, statement_suburb_median_aud, note)
                            VALUES (%s, 'price_statement', %s, %s, %s, 'From the Statement of Information')""",
                         (campaign_id, low, max(high or low, low), found.get("median")))


class Worker(threading.Thread):
    def __init__(self, valhalla: Valhalla | None, nominatim: Nominatim | None, lookups: bool = True,
                 transitous: Transitous | None = None):
        super().__init__(name="housetrack-worker", daemon=True)
        self.valhalla, self.nominatim, self.lookups, self.transitous = valhalla, nominatim, lookups, transitous
        self.stop_event = threading.Event()

    def run(self) -> None:
        try:
            with tx() as conn:
                overlays.ensure_streamed_layers(conn)
                # A suburb the last run was part-way through starts again.
                conn.execute("UPDATE block_suburb SET status = 'pending' WHERE status = 'running'")
        except Exception as e:
            log.warning("worker: couldn't register streamed layers: %s", e)
        backoff = 0
        while not self.stop_event.is_set():
            busy = 0
            try:
                busy += geocode_pending(self.nominatim)
                if self.valhalla:
                    busy += route_stale(self.valhalla)
                    busy += route_station_access(self.valhalla)
                    busy += route_peak(self.valhalla)
                    busy += route_school_access(self.valhalla)
                if self.transitous:
                    busy += route_transit(self.transitous)
                if self.lookups:
                    busy += lookup_overlays()
                    busy += blocks.analyse_pending()
                busy += read_statements()
                backoff = 0
            except Exception as e:  # routing engine still building tiles, database restarting, ...
                backoff = min(backoff + 10, 120)
                log.warning("worker: %s (retrying in %ss)", e, backoff)
            self.stop_event.wait(backoff or (0.5 if busy else 3))

    def stop(self) -> None:
        self.stop_event.set()
