"""Region data setup: `python -m app.setup [all|gnaf|stations|schools|tiles|osm] ...`

`all` (the default) loads what's kept locally: G-NAF addresses, the station list and school zones.
The basemap, planning overlays and routing stream from free online services instead. Two optional
steps make them local for fully offline use: `tiles` (basemap extract) and `osm` (network for a
self-hosted Valhalla; then `docker compose --profile local-routing up -d valhalla`).
"""

import argparse
import os
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg

from ..migrate import migrate
from . import gnaf_load, osm, overlays, regions, tiles

STEPS = ("gnaf", "stations", "schools", "tiles", "osm")
DEFAULT_STEPS = {"gnaf", "stations", "schools"}


def ensure_database(database_url: str, name: str) -> str:
    """Create the sibling database (e.g. `gnaf`) on the same server if needed; return its URL."""
    url = urlunsplit(urlsplit(database_url)._replace(path=f"/{name}"))
    with psycopg.connect(database_url, autocommit=True) as conn:
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            conn.execute(f'CREATE DATABASE "{name}"')
    return url


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("steps", nargs="*", default=["all"], choices=("all", *STEPS))
    args = parser.parse_args()
    steps = DEFAULT_STEPS if "all" in args.steps else set(args.steps)

    region = regions.get(os.environ.get("REGION", "vic"))
    bbox = regions.parse_bbox(os.environ.get("BBOX"), region)
    database_url = os.environ["DATABASE_URL"]
    downloads = Path(os.environ.get("DOWNLOAD_DIR", "/downloads"))
    tiles_dir = Path(os.environ.get("TILES_DIR", "/out/tiles"))
    valhalla_dir = Path(os.environ.get("VALHALLA_DIR", "/out/valhalla"))
    print(f"setup: region {region.code}, bbox {bbox}, steps {sorted(steps)}", flush=True)

    migrate(database_url)  # station table must exist even if the API hasn't started yet

    if "gnaf" in steps:
        gnaf_url = ensure_database(database_url, "gnaf")
        zip_path = gnaf_load.fetch(downloads, os.environ.get("GNAF_ZIP_URL"))
        gnaf_load.load(zip_path, region.gnaf_state, gnaf_url)

    if "stations" in steps:
        osm.load_stations(osm.overpass_stations(bbox), database_url)

    if "osm" in steps:
        region_pbf = osm.fetch_and_clip(os.environ.get("OSM_EXTRACT_URL") or region.osm_extract,
                                        downloads, bbox, valhalla_dir / "region.osm.pbf")
        osm.load_stations(osm.read_stations(region_pbf), database_url)

    if "tiles" in steps:
        tiles.extract(bbox, tiles_dir, os.environ.get("PMTILES_SOURCE"))
        tiles.assets(tiles_dir, downloads)

    if "schools" in steps:
        school_zip = os.environ.get("SCHOOL_ZONES_ZIP")
        overlays.load_schools(database_url, bbox, downloads, Path(school_zip) if school_zip else None)

    print("setup: done." + (" Restart the local routing engine: docker compose restart valhalla" if "osm" in steps else ""),
          flush=True)


if __name__ == "__main__":
    main()
