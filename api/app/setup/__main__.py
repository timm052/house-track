"""Region data setup: `python -m app.setup [all|gnaf|stations|schools|tiles|osm] ...`

`all` (the default) loads what's kept locally: G-NAF addresses, the station list and school zones.
The basemap, planning overlays and routing stream from free online services instead. Two optional
steps make them local for fully offline use: `tiles` (basemap extract) and `osm` (network for a
self-hosted Valhalla; then `docker compose --profile local-routing up -d valhalla`).
"""

import argparse
import os
import sys
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
    # No default on the argument itself: newer Pythons check a list default against the choices as one value.
    parser.add_argument("steps", nargs="*", choices=("all", *STEPS), help="default: all")
    argv = sys.argv[1:]
    # Up to 0.3.7 the image had no entrypoint, so steps had to be given as `setup python -m app.setup <steps>`.
    # Scripts written that way keep working.
    if argv[:3] == ["python", "-m", "app.setup"]:
        argv = argv[3:]
    args = parser.parse_args(argv)
    steps = DEFAULT_STEPS if not args.steps or "all" in args.steps else set(args.steps)

    region = regions.get(os.environ.get("REGION", "vic"))
    bbox = regions.parse_bbox(os.environ.get("BBOX"), region)
    database_url = os.environ["DATABASE_URL"]
    downloads = Path(os.environ.get("DOWNLOAD_DIR", "/downloads"))
    tiles_dir = Path(os.environ.get("TILES_DIR", "/out/tiles"))
    valhalla_dir = Path(os.environ.get("VALHALLA_DIR", "/out/valhalla"))
    print(f"setup: region {region.code}, bbox {bbox}, steps {sorted(steps)}", flush=True)

    migrate(database_url)  # station table must exist even if the API hasn't started yet

    def gnaf_step():
        gnaf_url = ensure_database(database_url, "gnaf")
        zip_path = gnaf_load.fetch(downloads, os.environ.get("GNAF_ZIP_URL"))
        gnaf_load.load(zip_path, region.gnaf_state, gnaf_url)

    def osm_step():
        region_pbf = osm.fetch_and_clip(os.environ.get("OSM_EXTRACT_URL") or region.osm_extract,
                                        downloads, bbox, valhalla_dir / "region.osm.pbf")
        osm.load_stations(osm.read_stations(region_pbf), database_url)

    def tiles_step():
        tiles.extract(bbox, tiles_dir, os.environ.get("PMTILES_SOURCE"))
        tiles.assets(tiles_dir, downloads)

    def schools_step():
        school_zip = os.environ.get("SCHOOL_ZONES_ZIP")
        overlays.load_schools(database_url, bbox, downloads, Path(school_zip) if school_zip else None)

    run = {"gnaf": gnaf_step, "stations": lambda: osm.load_stations(osm.overpass_stations(bbox), database_url),
           "osm": osm_step, "tiles": tiles_step, "schools": schools_step}
    # Each step on its own: one that fails (a download site down, a busy server) doesn't stop the others, and
    # what's loaded stays loaded. The failed ones are named at the end, to run again on their own.
    failed = []
    for step in ("gnaf", "stations", "osm", "tiles", "schools"):
        if step not in steps:
            continue
        try:
            run[step]()
        except Exception as e:  # noqa: BLE001
            print(f"setup: {step} failed: {e}", flush=True)
            failed.append(step)

    if failed:
        print(f"setup: finished, but {', '.join(failed)} failed. Run just those again later, e.g. "
              f"docker compose --profile setup run --rm setup {' '.join(failed)}", flush=True)
        sys.exit(1)
    print("setup: done." + (" Restart the local routing engine: docker compose restart valhalla" if "osm" in steps else ""),
          flush=True)


if __name__ == "__main__":
    main()
