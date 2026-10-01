"""Block analysis (map's Blocks mode, PLAN.md row 18).

For each suburb the household picks, the worker downloads from Victoria's open map service (the same one the planning
overlays come from): the suburb's boundary, every property boundary in it with its address (Vicmap Property), and the
1 m contours, roads and planning zones around it. Then, for every block:

- the street it faces (the road its address is on, else the nearest) and so its front and back: the front is the
  point of the boundary nearest that road, the back where a line from there through the middle of the block leaves it;
- size, frontage (boundary along the street), depth (front to back), shape (area over its enclosing rectangle) and
  whether it's a battle-axe (a narrow handle to a wide block);
- ground height at nine points from front to back and two across the middle, from the contours either side
  (block_elevation in migration 0021), giving the fall, the slope along and across, the steepest stretch, and which
  way it falls: up or down from the street, across, or level;
- which way the back faces, and the zone at its middle.

The household's preferences (Settings, `block_prefs`) aren't applied here: they're applied when blocks are read, so
changing them needs no new analysis.
"""

import json
import logging
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg

from .db import tx
from .setup.fetch import USER_AGENT

log = logging.getLogger("housetrack.blocks")

WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs"
PAGE = 5000
LEVEL_PCT = 2.0      # gentler than 1 in 50 both ways: level
MARGIN_DEG = 0.003   # contours and roads this far past the suburb's edge (about 300 m), for blocks on its border

DEFAULT_PREFS = {
    "min_m2": 600, "max_m2": 2000,      # block size wanted
    "max_incline": 8,                    # % slope, either way
    "directions": ["level", "up", "down", "across"],
    "include_units": False,              # a unit's strata lot is not a block you'd buy
    "split": {"NRZ": 400, "GRZ": 300, "RGZ": 200, "MUZ": 200},   # smallest lot a subdivision might give, by zone
    "split_frontage": 12,                # metres of street needed to split (a driveway and a lot)
}


# ─── reading the open map service ──────────────────────────────────────
def _features(type_name: str, fields: list[str], cql: str | None = None, bbox: tuple | None = None,
              sort: str | None = None) -> list[dict]:
    """Every feature of a layer matching a filter or box, a page at a time, in WGS84."""
    out: list[dict] = []
    start = 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"open-data-platform:{type_name}",
                  "outputFormat": "application/json", "srsName": "EPSG:4326", "propertyName": ",".join(fields),
                  "count": PAGE, "startIndex": start}
        if sort:
            params["sortBy"] = sort
        if cql:
            params["CQL_FILTER"] = cql
        if bbox:
            w, s, e, n = bbox
            # WFS 2.0 with EPSG:4326 wants latitude first.
            params["BBOX"] = f"{s},{w},{n},{e},urn:ogc:def:crs:EPSG::4326"
        with urlopen(Request(f"{WFS}?{urlencode(params)}", headers={"User-Agent": USER_AGENT}), timeout=180) as r:
            page = json.load(r)["features"]
        out.extend(page)
        if len(page) < PAGE:
            return out
        start += PAGE
        time.sleep(0.3)  # be gentle with the state's server


def suburb_boundary(name: str) -> dict | None:
    """The suburb's outline as GeoJSON, or None if Vicmap has no locality by that name."""
    found = _features("vmlite_locality_polygon", ["geom", "locality_name"], cql=f"locality_name='{_quote(name)}'")
    return found[0]["geometry"] if found else None


def _quote(s: str) -> str:
    return s.upper().replace("'", "''")


def _bbox(geom: dict) -> tuple[float, float, float, float]:
    pts = []

    def walk(c):
        if isinstance(c[0], (int, float)):
            pts.append(c)
        else:
            for x in c:
                walk(x)
    walk(geom["coordinates"])
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


# ─── analysis ──────────────────────────────────────────────────────────
def analyse(conn: psycopg.Connection, suburb: str) -> int:
    """Download and analyse one suburb's blocks. Returns how many."""
    boundary = suburb_boundary(suburb)
    if boundary is None:
        raise ValueError(f"Vicmap has no suburb called {suburb.title()}.")
    w, s, e, n = _bbox(boundary)
    around = (w - MARGIN_DEG, s - MARGIN_DEG, e + MARGIN_DEG, n + MARGIN_DEG)
    conn.execute("UPDATE block_suburb SET boundary = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)) WHERE suburb = %s",
                 (json.dumps(boundary), suburb))

    props = _features("v_property_mp_address",
                      ["geom", "prop_pfi", "add_blg_unit_id_1", "add_house_number_1", "add_house_suffix_1", "add_road_name",
                       "add_road_type", "add_num_address"],
                      cql=f"add_locality_name='{_quote(suburb)}'", sort="prop_pfi")
    contours = _features("el_contour_1to5m", ["geom", "ufi", "altitude"], bbox=around, sort="ufi")
    roads = _features("tr_road", ["geom", "ufi", "road_name", "road_type"], bbox=around, sort="ufi")
    zones = _features("plan_zone", ["geom", "ufi", "zone_code"], bbox=around, sort="ufi")
    log.info("blocks: %s: %d addresses, %d contours, %d roads, %d zones", suburb, len(props), len(contours), len(roads), len(zones))

    def put(table: str, cols: str, rows: list[tuple], geom_sql: str) -> None:
        with conn.cursor() as cur:
            cur.executemany(f"INSERT INTO {table} (ufi, {cols}, geom) VALUES (%s, %s, {geom_sql}) ON CONFLICT (ufi) DO NOTHING", rows)

    to_m = "ST_Transform(ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 7855)"
    put("block_contour", "altitude", [(f["properties"]["ufi"], f["properties"]["altitude"], json.dumps(f["geometry"]))
                                      for f in contours if f.get("geometry") and f["properties"].get("altitude") is not None], to_m)
    put("block_road", "name", [(f["properties"]["ufi"], " ".join(x for x in (f["properties"].get("road_name"), f["properties"].get("road_type")) if x) or None,
                                json.dumps(f["geometry"])) for f in roads if f.get("geometry")], to_m)
    put("block_zone", "zone_code", [(f["properties"]["ufi"], f["properties"].get("zone_code"), json.dumps(f["geometry"]))
                                    for f in zones if f.get("geometry")], f"ST_MakeValid({to_m}, 'method=structure')")

    # One row per property: a property has an address per unit or per number on it.
    blocks: dict[str, dict] = {}
    for f in props:
        p = f["properties"]
        if not f.get("geometry") or not p.get("prop_pfi"):
            continue
        b = blocks.setdefault(p["prop_pfi"], {"geom": f["geometry"], "addresses": set(), "unit": False, "street": None})
        street = " ".join(x for x in (p.get("add_road_name"), p.get("add_road_type")) if x) or None
        number = p.get("add_num_address") or "".join(str(x) for x in (p.get("add_house_number_1"), p.get("add_house_suffix_1")) if x)
        if street:
            b["street"] = b["street"] or street
            b["addresses"].add(f"{number} {street.title()}".strip())
        b["unit"] = b["unit"] or p.get("add_blg_unit_id_1") is not None
    conn.execute("DELETE FROM block WHERE suburb = %s", (suburb,))
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO block (pfi, suburb, geom, address, street, is_unit, addresses)
               VALUES (%s, %s, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 'method=structure')), %s, %s, %s, %s)
               ON CONFLICT (pfi) DO NOTHING""",
            [(pfi, suburb, json.dumps(b["geom"]), sorted(b["addresses"])[0] if b["addresses"] else None, b["street"], b["unit"],
              max(len(b["addresses"]), 1)) for pfi, b in blocks.items()])

    measure(conn, suburb)
    count = conn.execute("SELECT count(*) AS n FROM block WHERE suburb = %s", (suburb,)).fetchone()["n"]
    return count


MEASURE = """
WITH b AS (
  SELECT pfi, street, ST_Transform(geom, 7855) AS g FROM block WHERE suburb = %(suburb)s
), r AS (   -- the street it faces: the road its address is on (if close), else the nearest road
  SELECT b.*, coalesce(
           (SELECT rd.geom FROM block_road rd WHERE rd.name = b.street AND ST_DWithin(rd.geom, b.g, 80) ORDER BY rd.geom <-> b.g LIMIT 1),
           (SELECT rd.geom FROM block_road rd ORDER BY rd.geom <-> b.g LIMIT 1)) AS road
  FROM b
), f AS (
  SELECT r.*, ST_ClosestPoint(ST_Boundary(r.g), ST_ClosestPoint(r.road, ST_PointOnSurface(r.g))) AS fp,  -- mid-front
          ST_PointOnSurface(r.g) AS mid, ST_Distance(r.g, r.road) AS gap
  FROM r WHERE r.road IS NOT NULL
), k AS (   -- the back: where a line from the front through the middle of the block leaves it
  SELECT f.*, ST_EndPoint(ST_LongestLine(f.fp, ST_Intersection(f.g, ST_MakeLine(f.fp, far.p)))) AS bp
  FROM f, LATERAL (SELECT ST_SetSRID(ST_MakePoint(
           ST_X(f.fp) + (ST_X(f.mid) - ST_X(f.fp)) * 400 / greatest(ST_Distance(f.fp, f.mid), 0.01),
           ST_Y(f.fp) + (ST_Y(f.mid) - ST_Y(f.fp)) * 400 / greatest(ST_Distance(f.fp, f.mid), 0.01)), 7855) AS p) far
)
SELECT k.pfi, ST_Area(k.g) AS area, ST_Distance(k.fp, k.bp) AS depth,
       -- frontage: the boundary's straight pieces with both ends near the street (so not the sides running back from it)
       (SELECT coalesce(sum(ST_Length(s.geom)), 0) FROM ST_DumpSegments(ST_Boundary(k.g)) s
        WHERE ST_Distance(ST_StartPoint(s.geom), k.road) <= k.gap + 3 AND ST_Distance(ST_EndPoint(s.geom), k.road) <= k.gap + 3) AS frontage,
       ST_Area(k.g) / nullif(ST_Area(ST_OrientedEnvelope(k.g)), 0) AS regularity,
       degrees(ST_Azimuth(k.fp, k.bp)) AS bearing,
       ST_X(k.fp) AS fx, ST_Y(k.fp) AS fy, ST_X(k.bp) AS bx, ST_Y(k.bp) AS by,
       (SELECT z.zone_code FROM block_zone z WHERE ST_Intersects(z.geom, ST_PointOnSurface(k.g)) LIMIT 1) AS zone
FROM k WHERE ST_Distance(k.fp, k.bp) > 1
"""


def measure(conn: psycopg.Connection, suburb: str) -> None:
    rows = conn.execute(MEASURE, {"suburb": suburb}).fetchall()
    # Nine points from just inside the front to just inside the back (the very edge can sit on a road cutting), and
    # three pairs across the block at a quarter, half and three quarters of the way back (looking from the street:
    # left, right), averaged, so one retaining wall doesn't decide which way a block falls. Heights read in batches.
    points: list[tuple[float, float]] = []
    for r in rows:
        depth = r["depth"]
        dx, dy = (r["bx"] - r["fx"]) / depth, (r["by"] - r["fy"]) / depth
        half = 0.4 * r["area"] / depth
        r["half"] = half
        at = lambda t: (r["fx"] + dx * depth * t, r["fy"] + dy * depth * t)  # noqa: E731
        points += [at(0.03 + 0.94 * i / 8) for i in range(9)]
        for t in (0.25, 0.5, 0.75):
            mx, my = at(t)
            points += [(mx - dy * half, my + dx * half), (mx + dy * half, my - dx * half)]
    heights = elevations(conn, points)
    updates = []
    for n, r in enumerate(rows):
        depth, area, half = r["depth"], r["area"], r["half"]
        hs = heights[n * 15:(n + 1) * 15]
        if any(h is None for h in hs):
            updates.append(_shape_only(r, area, depth))
            continue
        profile, pairs = hs[:9], hs[9:]
        run = depth * 0.94
        fall = profile[-1] - profile[0]
        cross = sum(pairs[i] - pairs[i + 1] for i in (0, 2, 4)) / 3
        along_pct = abs(fall) / run * 100
        across_pct = abs(cross) / (2 * half) * 100 if half > 0.5 else 0.0
        # The steepest stretch over a quarter of the depth (an eighth is too short to trust the contours).
        steepest = max(abs(profile[i + 2] - profile[i]) for i in range(7)) / (run / 4) * 100
        incline = max(along_pct, across_pct)
        direction = ("level" if incline < LEVEL_PCT else "across" if across_pct > 1.5 * along_pct
                     else "up" if fall > 0 else "down")
        updates.append({**_shape_only(r, area, depth), "front_elev": round(profile[0], 2), "fall_m": round(fall, 2),
                        "cross_fall_m": round(cross, 2), "along_pct": round(along_pct, 1), "across_pct": round(across_pct, 1),
                        "incline_pct": round(incline, 1), "steepest_pct": round(steepest, 1), "direction": direction,
                        "profile": [round(h - profile[0], 2) for h in profile]})
    with conn.cursor() as cur:
        cur.executemany(
            """UPDATE block SET area_m2 = %(area_m2)s, depth_m = %(depth_m)s, frontage_m = %(frontage_m)s, regularity = %(regularity)s,
                   battleaxe = %(battleaxe)s, rear_bearing = %(rear_bearing)s, zone_code = %(zone_code)s,
                   front_elev = %(front_elev)s, fall_m = %(fall_m)s, cross_fall_m = %(cross_fall_m)s, along_pct = %(along_pct)s,
                   across_pct = %(across_pct)s, incline_pct = %(incline_pct)s, steepest_pct = %(steepest_pct)s,
                   direction = %(direction)s, profile = %(profile)s
               WHERE pfi = %(pfi)s""", updates)


def elevations(conn: psycopg.Connection, points: list[tuple[float, float]], batch: int = 2000) -> list[float | None]:
    """Ground height at each point (metres, GDA2020 MGA zone 55), a batch per query."""
    out: list[float | None] = []
    for i in range(0, len(points), batch):
        chunk = points[i:i + batch]
        rows = conn.execute(
            """SELECT block_elevation(ST_SetSRID(ST_MakePoint(t.x, t.y), 7855)) AS z
               FROM unnest(%s::float8[], %s::float8[]) WITH ORDINALITY AS t(x, y, i) ORDER BY t.i""",
            ([p[0] for p in chunk], [p[1] for p in chunk])).fetchall()
        out += [r["z"] for r in rows]
    return out


def _shape_only(r: dict, area: float, depth: float) -> dict:
    frontage = r["frontage"] or 0
    return {"pfi": r["pfi"], "area_m2": round(area), "depth_m": round(depth, 1), "frontage_m": round(frontage, 1),
            "regularity": round(r["regularity"], 2) if r["regularity"] else None,
            # A battle-axe: a handle too narrow for a house, opening onto a block much wider than it.
            "battleaxe": bool(frontage and frontage < 6 and area / depth > 2 * frontage and area > 250),
            "rear_bearing": round(r["bearing"]) % 360 if r["bearing"] is not None else None, "zone_code": r["zone"],
            "front_elev": None, "fall_m": None, "cross_fall_m": None, "along_pct": None, "across_pct": None,
            "incline_pct": None, "steepest_pct": None, "direction": None, "profile": None}


# ─── the worker's part ─────────────────────────────────────────────────
def analyse_pending() -> int:
    """Analyse the next suburb waiting, if any. Runs inside the worker loop: one suburb per pass."""
    with tx() as conn:
        row = conn.execute("""SELECT suburb, created_by FROM block_suburb WHERE status = 'pending'
                              ORDER BY created_at LIMIT 1""").fetchone()
    if row is None:
        return 0
    suburb, person = row["suburb"], row["created_by"]
    with tx(person) as conn:
        conn.execute("UPDATE block_suburb SET status = 'running', error = NULL WHERE suburb = %s", (suburb,))
    started = time.monotonic()
    try:
        with tx(person) as conn:
            n = analyse(conn, suburb)
            conn.execute("UPDATE block_suburb SET status = 'done', blocks = %s, analysed_at = now() WHERE suburb = %s", (n, suburb))
        log.info("blocks: %s analysed, %d blocks in %.0fs", suburb, n, time.monotonic() - started)
    except Exception as e:  # noqa: BLE001  a failure is shown in Settings, with Try again
        log.warning("blocks: %s failed: %s", suburb, e)
        with tx(person) as conn:
            conn.execute("UPDATE block_suburb SET status = 'error', error = %s WHERE suburb = %s", (str(e)[:300], suburb))
    return 1


# ─── reading, with the household's preferences ─────────────────────────
def prefs(conn: psycopg.Connection) -> dict:
    row = conn.execute("SELECT value FROM household_setting WHERE key = 'block_prefs'").fetchone()
    return {**DEFAULT_PREFS, **(row["value"] if row else {})}


def zone_family(code: str | None) -> str | None:
    """'GRZ1' -> 'GRZ'."""
    if not code:
        return None
    letters = "".join(ch for ch in code if ch.isalpha())
    return letters or None


def split_lots(b: dict, p: dict) -> int:
    """How many lots the block might split into under the household's rule for its zone (0 or 1: it can't)."""
    smallest = (p.get("split") or {}).get(zone_family(b.get("zone_code")) or "")
    if not smallest or b.get("is_unit") or not b.get("area_m2"):
        return 0
    if (b.get("frontage_m") or 0) < p.get("split_frontage", 12) and not b.get("battleaxe"):
        return 1
    return min(int(b["area_m2"] // smallest), 9)


def fits(b: dict, p: dict) -> bool | None:
    """Whether a block meets the preferences: True, False, or None when its slope isn't known."""
    if b.get("is_unit") and not p.get("include_units"):
        return False
    area = b.get("area_m2")
    if area is None or not (p["min_m2"] <= area <= p["max_m2"]):
        return False
    if b.get("incline_pct") is None:
        return None
    return b["incline_pct"] <= p["max_incline"] and b.get("direction") in p["directions"]


COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


def facing(bearing: int | None) -> str | None:
    return None if bearing is None else COMPASS[round(bearing / 45) % 8]


def summary(b: dict, p: dict) -> dict:
    """What the app shows about a block, in one place: the stored measures plus what the preferences make of them."""
    out = {k: b.get(k) for k in ("pfi", "suburb", "address", "is_unit", "addresses", "area_m2", "frontage_m", "depth_m",
                                 "regularity", "battleaxe", "fall_m", "cross_fall_m", "along_pct", "across_pct", "incline_pct",
                                 "steepest_pct", "direction", "profile", "rear_bearing", "zone_code")}
    out["rear_facing"] = facing(b.get("rear_bearing"))
    out["split_lots"] = split_lots(b, p)
    out["fits"] = fits(b, p)
    return out

