"""OpenStreetMap: clip the region's extract to the search area (Valhalla's input) and load the
station list the Places screen picks from (PLAN.md D10)."""

import json
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import tempfile
from pathlib import Path

import psycopg

from .fetch import USER_AGENT, download

# Public Overpass servers, tried in turn: each is often busy or rate-limited (429, 504). OVERPASS_URL puts another first.
OVERPASS_SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
                    "https://overpass.private.coffee/api/interpreter"]

Bbox = tuple[float, float, float, float]


def clip(source_pbf: Path, bbox: Bbox, out_pbf: Path) -> Path:
    out_pbf.parent.mkdir(parents=True, exist_ok=True)
    print(f"osm: clipping {source_pbf.name} to {bbox}", flush=True)
    subprocess.run(
        ["osmium", "extract", "--bbox", ",".join(map(str, bbox)), "--overwrite", "-o", str(out_pbf), str(source_pbf)],
        check=True,
    )
    return out_pbf


def fetch_and_clip(url: str, download_dir: Path, bbox: Bbox, out_pbf: Path) -> Path:
    return clip(download(url, download_dir), bbox, out_pbf)


def read_stations(region_pbf: Path) -> list[dict]:
    """Named railway stations (nodes, or station areas reduced to a point later)."""
    with tempfile.TemporaryDirectory() as tmp:
        filtered = Path(tmp) / "stations.osm.pbf"
        exported = Path(tmp) / "stations.geojsonseq"
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(filtered), str(region_pbf),
                        "nwr/railway=station"], check=True)
        subprocess.run(["osmium", "export", "--overwrite", "-f", "geojsonseq", "--attributes", "type,id",
                        "-o", str(exported), str(filtered)], check=True)
        stations = []
        for line in exported.read_text(encoding="utf-8").splitlines():
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            feature = json.loads(line)
            props = feature["properties"]
            name = props.get("name")
            if not name or props.get("station") == "miniature" or props.get("railway") != "station":
                continue
            # Node, way and relation ids share a number space; keep them distinct in one bigint.
            offset = {"n": 0, "w": 10**12, "r": 2 * 10**12}[props["@type"][0]]
            stations.append({"osm_id": offset + int(props["@id"]), "name": name, "geometry": feature["geometry"]})
        return stations


def load_stations(stations: list[dict], database_url: str) -> int:
    with psycopg.connect(database_url) as conn:
        started = conn.execute("SELECT now()").fetchone()[0]
        for s in stations:
            conn.execute(
                """INSERT INTO station (osm_id, name, location)
                   VALUES (%s, %s, ST_PointOnSurface(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)))
                   ON CONFLICT (osm_id) DO UPDATE
                   SET name = EXCLUDED.name, location = EXCLUDED.location, refreshed_at = now()""",
                (s["osm_id"], s["name"], json.dumps(s["geometry"])),
            )
        # A designated station that moved in OSM moves its place too (the stale view then re-routes it).
        # The change is attributed to whoever last edited that place.
        moved = conn.execute(
            """SELECT pl.id, pl.updated_by FROM place pl JOIN station s ON s.osm_id = pl.station_osm_id
               WHERE NOT ST_Equals(pl.location, s.location)"""
        ).fetchall()
        for place_id, person in moved:
            conn.execute("SELECT set_config('app.person_id', %s, true)", (str(person),))
            conn.execute("UPDATE place pl SET location = s.location FROM station s"
                         " WHERE pl.id = %s AND s.osm_id = pl.station_osm_id", (place_id,))
        conn.execute(
            """DELETE FROM station WHERE refreshed_at < %s
               AND osm_id NOT IN (SELECT station_osm_id FROM place WHERE station_osm_id IS NOT NULL)""",
            (started,),
        )
    print(f"osm: {len(stations)} stations loaded", flush=True)
    return len(stations)


def _overpass(query: str, rounds: int = 3, pause_s: float = 30) -> list[dict]:
    """The query's elements, from whichever public server answers: each server in turn, a few rounds, pausing
    between rounds (a busy server usually has room again within a minute)."""
    import os
    import time
    servers = [u for u in [os.environ.get("OVERPASS_URL")] if u] + OVERPASS_SERVERS
    body = urlencode({"data": query}).encode()
    problems = []
    for attempt in range(rounds):
        for url in servers:
            try:
                req = Request(url, data=body, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
                with urlopen(req, timeout=120) as r:
                    return json.load(r)["elements"]
            except (HTTPError, URLError, TimeoutError, ValueError, KeyError) as e:
                problem = f"{url.split('/')[2]}: {getattr(e, 'code', None) or e}"
                problems.append(problem)
                print(f"osm: {problem}", flush=True)
        if attempt < rounds - 1:
            print(f"osm: every Overpass server was busy; trying again in {pause_s:.0f}s", flush=True)
            time.sleep(pause_s)
    raise RuntimeError("no Overpass server answered (" + "; ".join(problems[-len(servers):]) + ")")


TILES = (4, 3)  # the search area is asked for in pieces: a busy server turns away a whole-state query (504)


def overpass_stations(bbox: Bbox, rounds: int = 5, pause_s: float = 30) -> list[dict]:
    """Named railway stations in the search area from the public Overpass API: a few hundred records,
    instead of downloading and clipping the national OpenStreetMap extract. Asked for a piece of the area at a
    time; if any piece still fails after its retries, nothing is returned (a partial list would drop stations)."""
    west, south, east, north = bbox
    cols, rows = TILES
    found: dict[tuple, dict] = {}
    for i in range(cols):
        for j in range(rows):
            w, e = west + (east - west) * i / cols, west + (east - west) * (i + 1) / cols
            s, n = south + (north - south) * j / rows, south + (north - south) * (j + 1) / rows
            query = (f"[out:json][timeout:90];(node[railway=station]({s},{w},{n},{e});"
                     f"way[railway=station]({s},{w},{n},{e}););out center tags;")
            for el in _overpass(query, rounds, pause_s):
                found[(el["type"], el["id"])] = el  # a station on a piece's edge comes back twice
            print(f"osm: stations, piece {i * rows + j + 1} of {cols * rows}", flush=True)
    elements = list(found.values())
    stations = []
    for e in elements:
        tags = e.get("tags", {})
        if not tags.get("name") or tags.get("station") == "miniature" or tags.get("disused") == "yes":
            continue
        lon, lat = (e["lon"], e["lat"]) if e["type"] == "node" else (e["center"]["lon"], e["center"]["lat"])
        offset = {"node": 0, "way": 10**12, "relation": 2 * 10**12}[e["type"]]
        stations.append({"osm_id": offset + e["id"], "name": tags["name"],
                         "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    return stations
