"""The hills on the walk to the station (PLAN.md row 19).

For each house's walk to its nearest station, and each benchmark walk, the worker:
1. asks the routing engine for the walking path;
2. downloads Vicmap's 1 m contours around it (once per area; blocks share the same contour table);
3. reads the ground height every 10 m along it (block_elevation, migration 0021), smoothed a little;
4. works out the climbing each way, the steepest 100 m each way, and rates each direction the way running routes
   are rated: by metres climbed per kilometre, a step harder for a short sharp hill.

Ratings and comparisons are worked out when read (summary), so changing them needs no new profiles.
"""

import json
import logging

import psycopg
from psycopg.types.json import Jsonb

from . import blocks
from .db import tx
from .geo_services import Valhalla

log = logging.getLogger("housetrack.walks")

STEP_M = 10            # a height every 10 m along the path
WINDOW_M = 100         # "steepest" is over this distance, so one kerb or contour wobble doesn't count
MARGIN_DEG = 0.002     # contours this far past the path (about 200 m)
RATINGS = ["Flat", "Gentle", "Rolling", "Hilly", "Steep"]
# Metres climbed per kilometre at which each rating starts (Flat below the first).
PER_KM = [8, 18, 30, 45]
SHARP_PCT = 12         # a stretch this steep makes the walk a step harder
FLAT_EQUIVALENT = 8    # Naismith: each metre climbed is about 8 m more walking on the flat


# ─── the work queue ────────────────────────────────────────────────────
PENDING = """
SELECT * FROM (
  SELECT walk_key(p.location, s.pt) AS key, ST_X(p.location) AS olon, ST_Y(p.location) AS olat, ST_X(s.pt) AS tlon, ST_Y(s.pt) AS tlat
  FROM property_nearest_station n JOIN property p ON p.id = n.property_id
  CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_MakePoint(n.lon, n.lat), 4326) AS pt) s
  UNION
  SELECT walk_key(b.origin, b.target), ST_X(b.origin), ST_Y(b.origin), ST_X(b.target), ST_Y(b.target) FROM walk_benchmark b
) w WHERE NOT EXISTS (SELECT 1 FROM walk_profile x WHERE x.key = w.key AND x.alternatives IS NOT NULL) LIMIT 1
"""


def profile_pending(valhalla: Valhalla) -> int:
    """Profile the next walk waiting, if any (one per worker pass). Network errors are raised for the worker to retry."""
    with tx() as conn:
        row = conn.execute(PENDING).fetchone()
    if row is None:
        return 0
    origin, target = (row["olon"], row["olat"]), (row["tlon"], row["tlat"])
    paths = valhalla.walk_routes(origin, target)
    with tx() as conn:
        if not paths:
            save(conn, row["key"], origin, target, None, error="No walking route found.")
            return 1
        path = paths[0]
        contours = ensure_contours(conn, [p for x in paths for p in x])
        heights, length, _ = sample(conn, path) if contours else ([], 0.0, [])
        if not heights or any(h is None for h in heights):
            save(conn, row["key"], origin, target, path, error="No height data along this walk.")
            return 1
        others = []
        for other in paths[1:]:
            hs, d, pts = sample(conn, other)
            if hs and not any(h is None for h in hs):
                s = stats(hs, d)
                others.append({"distance_m": round(d), "heights": [round(h, 2) for h in s["smooth"]], "points": pts,
                               **{k: s[k] for k in ("climb_to", "climb_home", "steepest_up", "steepest_down")}})
        save(conn, row["key"], origin, target, path, heights=heights, distance=round(length), contours=contours, alternatives=others)
    return 1


def ensure_contours(conn: psycopg.Connection, path: list[list[float]]) -> str | None:  # path: any points to cover
    """Download the contours around a path unless an earlier walk already covered the area. Vicmap's 1 m contours
    cover Melbourne and the towns; elsewhere its statewide contours (10 m apart, coarser) are used. Returns which,
    or None where there are none."""
    xs, ys = [p[0] for p in path], [p[1] for p in path]
    box = (min(xs) - MARGIN_DEG, min(ys) - MARGIN_DEG, max(xs) + MARGIN_DEG, max(ys) + MARGIN_DEG)
    envelope = "ST_MakeEnvelope(%s, %s, %s, %s, 4326)"
    covered = conn.execute(f"""SELECT ST_Covers(ST_Union(area), {envelope}) AS yes, max(contours) AS contours FROM contour_cover
                               WHERE ST_Intersects(area, {envelope})""", box + box).fetchone()
    if covered and covered["yes"]:
        return covered["contours"]
    found, source, sign = blocks._features("el_contour_1to5m", ["geom", "ufi", "altitude"], bbox=box, sort="ufi"), "1 m", 1
    if not found:
        # The statewide layer's ids are its own: kept negative so they can't clash with the 1 m layer's.
        found, source, sign = blocks._features("el_contour", ["geom", "ufi", "altitude"], bbox=box, sort="ufi"), "10 m", -1
    if not found:
        return None
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO block_contour (ufi, altitude, geom)
               VALUES (%s, %s, ST_Transform(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 7855)) ON CONFLICT (ufi) DO NOTHING""",
            [(sign * f["properties"]["ufi"], f["properties"]["altitude"], json.dumps(f["geometry"]))
             for f in found if f.get("geometry") and f["properties"].get("altitude") is not None])
    conn.execute(f"INSERT INTO contour_cover (area, contours) VALUES ({envelope}, %s)", box + (source,))
    return source


def sample(conn: psycopg.Connection, path: list[list[float]]) -> tuple[list[float | None], float, list[list[float]]]:
    """Ground heights every STEP_M metres along the path (and at its end), its length in metres, and where each
    height was read as [lon, lat]."""
    line = json.dumps({"type": "LineString", "coordinates": path})
    rows = conn.execute(
        """WITH l AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 7855) AS g)
           SELECT ST_Length(g) AS length, ST_X(p) AS x, ST_Y(p) AS y, ST_X(ST_Transform(p, 4326)) AS lon, ST_Y(ST_Transform(p, 4326)) AS lat
           FROM l, LATERAL (SELECT generate_series(0, greatest(ceil(ST_Length(g) / %s)::int - 1, 0)) * %s AS d UNION ALL SELECT ST_Length(g)) s,
                LATERAL (SELECT ST_LineInterpolatePoint(g, least(s.d / greatest(ST_Length(g), 0.01), 1)) AS p) q
           ORDER BY s.d""", (line, STEP_M, STEP_M)).fetchall()
    if not rows:
        return [], 0.0, []
    heights = blocks.elevations(conn, [(r["x"], r["y"]) for r in rows])
    return heights, rows[0]["length"], [[round(r["lon"], 6), round(r["lat"], 6)] for r in rows]


def save(conn: psycopg.Connection, key: str, origin, target, path, heights: list[float] | None = None,
         distance: int | None = None, error: str | None = None, contours: str | None = None,
         alternatives: list[dict] | None = None) -> None:
    s = stats(heights, distance) if heights else {}
    conn.execute(
        """INSERT INTO walk_profile (key, origin, target, path, distance_m, heights, climb_to, climb_home, steepest_up, steepest_down, contours, error, alternatives)
           VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                   CASE WHEN %s::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) END, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (key) DO UPDATE SET path = EXCLUDED.path, distance_m = EXCLUDED.distance_m, heights = EXCLUDED.heights,
             climb_to = EXCLUDED.climb_to, climb_home = EXCLUDED.climb_home, steepest_up = EXCLUDED.steepest_up,
             steepest_down = EXCLUDED.steepest_down, contours = EXCLUDED.contours, error = EXCLUDED.error,
             alternatives = EXCLUDED.alternatives, computed_at = now()""",
        (key, origin[0], origin[1], target[0], target[1],
         json.dumps({"type": "LineString", "coordinates": path}) if path else None,
         json.dumps({"type": "LineString", "coordinates": path}) if path else None,
         distance, [round(h, 2) for h in s.get("smooth", [])] or None, s.get("climb_to"), s.get("climb_home"),
         s.get("steepest_up"), s.get("steepest_down"), contours, error, Jsonb(alternatives or [])))


# ─── the numbers ───────────────────────────────────────────────────────
def smooth(heights: list[float]) -> list[float]:
    """A three-point average: contours give small steps that aren't really there."""
    if len(heights) < 3:
        return list(heights)
    return [heights[0]] + [(a + b + c) / 3 for a, b, c in zip(heights, heights[1:], heights[2:])] + [heights[-1]]


def stats(heights: list[float], distance: float | None) -> dict:
    h = smooth(heights)
    rises = [b - a for a, b in zip(h, h[1:])]
    n = max(1, min(WINDOW_M // STEP_M, len(h) - 1))
    grades = [(h[i + n] - h[i]) / (n * STEP_M) * 100 for i in range(len(h) - n)] or [0.0]
    return {"smooth": h, "climb_to": round(sum(r for r in rises if r > 0), 1), "climb_home": round(-sum(r for r in rises if r < 0), 1),
            "steepest_up": round(max(0.0, max(grades)), 1), "steepest_down": round(max(0.0, -min(grades)), 1)}


def rating(climb: float, distance_m: float, steepest: float) -> str:
    per_km = climb / max(distance_m / 1000, 0.3)
    level = sum(per_km >= x for x in PER_KM)
    if steepest >= SHARP_PCT:
        level = min(level + 1, len(RATINGS) - 1)
    return RATINGS[level]


def summary(w: dict | None) -> dict | None:
    """A profiled walk as the app shows it: both directions rated, with the flat-walking equivalent."""
    if w is None:
        return None
    if w.get("error") or not w.get("heights"):
        return {"error": w.get("error") or "Not profiled yet."}
    d = w["distance_m"]
    out = {"distance_m": d, "heights": w["heights"], "climb_to": w["climb_to"], "climb_home": w["climb_home"],
           "steepest_up": w["steepest_up"], "steepest_down": w["steepest_down"], "start_m": w["heights"][0], "end_m": w["heights"][-1],
           "rating_to": rating(w["climb_to"], d, w["steepest_up"]), "rating_home": rating(w["climb_home"], d, w["steepest_down"]),
           "flat_m_to": round(d + FLAT_EQUIVALENT * w["climb_to"]), "flat_m_home": round(d + FLAT_EQUIVALENT * w["climb_home"]),
           "contours": w.get("contours")}
    out["alternatives"] = better_ways(out, w.get("alternatives") or [])
    # One number to compare walks by: metres climbed per km, averaged over the trip there and back.
    out["climb_per_km"] = round((w["climb_to"] + w["climb_home"]) / 2 / max(d / 1000, 0.3), 1)
    out["rating"] = max(out["rating_to"], out["rating_home"], key=RATINGS.index)
    return out


def better_ways(main: dict, others: list[dict]) -> list[dict]:
    """Other ways worth showing: less climbing there or back (by 3 m or more), and not much further (at most 40% or
    600 m more). Rated like the usual way, least climbing first, two at most."""
    out = []
    for o in others:
        saves = (main["climb_to"] + main["climb_home"]) - (o["climb_to"] + o["climb_home"])
        extra = o["distance_m"] - main["distance_m"]
        if saves >= 3 and extra <= max(600, 0.4 * main["distance_m"]):
            out.append({**o, "saves_m": round(saves, 1), "extra_m": extra,
                        "rating_to": rating(o["climb_to"], o["distance_m"], o["steepest_up"]),
                        "rating_home": rating(o["climb_home"], o["distance_m"], o["steepest_down"])})
    return sorted(out, key=lambda o: -o["saves_m"])[:2]


def points(conn: psycopg.Connection, key: str, n: int) -> list[list[float]]:
    """Where each height was read, as [lon, lat]: every 10 m along the path and its end, the same as sample()."""
    rows = conn.execute(
        """WITH l AS (SELECT ST_Transform(path, 7855) AS g FROM walk_profile WHERE key = %s)
           SELECT ST_X(p) AS lon, ST_Y(p) AS lat
           FROM l, LATERAL (SELECT generate_series(0, %s - 2) * %s AS d UNION ALL SELECT ST_Length(g)) s,
                LATERAL (SELECT ST_Transform(ST_LineInterpolatePoint(g, least(s.d / greatest(ST_Length(g), 0.01), 1)), 4326) AS p) q
           ORDER BY s.d""", (key, n, STEP_M)).fetchall()
    return [[round(r["lon"], 6), round(r["lat"], 6)] for r in rows]


def benchmarks(conn: psycopg.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT b.id, b.name, b.station, b.position, ST_X(b.origin) AS lon, ST_Y(b.origin) AS lat, w.*
           FROM walk_benchmark b LEFT JOIN walk_profile w ON w.key = walk_key(b.origin, b.target)
           ORDER BY b.position, b.created_at""").fetchall()
    return [{"id": str(r["id"]), "name": r["name"], "station": r["station"], "lon": r["lon"], "lat": r["lat"],
             "walk": summary(r) if r["key"] else None} for r in rows]
