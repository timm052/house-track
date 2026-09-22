"""Background work inside the API process (single instance, so no queue is needed):

1. Geocode properties that have no pin: G-NAF by address key, then by plan + lot, then Nominatim.
2. Route properties to places wherever `travel_estimate_stale` says a result is missing or out of date.

Writes to `property` are attributed to whoever last edited that property, because the schema
requires a person on every change and this work happens on their behalf.
"""

import logging
import threading
from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from psycopg.types.json import Jsonb

from . import gnaf
from .setup import overlays
from .address import Address, address_key, normalise
from .db import tx
from .geo_services import Nominatim, Valhalla

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
                           engine = EXCLUDED.engine, computed_at = EXCLUDED.computed_at""",
                    (property_id, t["place_id"], mode, plon, plat, t["tlon"], t["tlat"],
                     route.distance_m, route.duration_s),
                )
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


class Worker(threading.Thread):
    def __init__(self, valhalla: Valhalla | None, nominatim: Nominatim | None, lookups: bool = True):
        super().__init__(name="housetrack-worker", daemon=True)
        self.valhalla, self.nominatim, self.lookups = valhalla, nominatim, lookups
        self.stop_event = threading.Event()

    def run(self) -> None:
        try:
            with tx() as conn:
                overlays.ensure_streamed_layers(conn)
        except Exception as e:
            log.warning("worker: couldn't register streamed layers: %s", e)
        backoff = 0
        while not self.stop_event.is_set():
            busy = 0
            try:
                busy += geocode_pending(self.nominatim)
                if self.valhalla:
                    busy += route_stale(self.valhalla)
                if self.lookups:
                    busy += lookup_overlays()
                backoff = 0
            except Exception as e:  # routing engine still building tiles, database restarting, ...
                backoff = min(backoff + 10, 120)
                log.warning("worker: %s (retrying in %ss)", e, backoff)
            self.stop_event.wait(backoff or (0.5 if busy else 3))

    def stop(self) -> None:
        self.stop_event.set()
