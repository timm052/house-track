"""OpenStreetMap: clip the region's extract to the search area (Valhalla's input) and load the
station list the Places screen picks from (PLAN.md D10)."""

import json
import subprocess
import tempfile
from pathlib import Path

import psycopg

from .fetch import download

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
