"""Basemap: a Protomaps PMTiles extract clipped to the search area, plus the fonts and sprites the
style needs, so the map works with no internet connection (PLAN.md decision 5)."""

import json
import shutil
import subprocess
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

from .fetch import USER_AGENT, download

BUILDS = "https://build-metadata.protomaps.dev/builds.json"
BUILD_BASE = "https://build.protomaps.com/"
ASSETS_ZIP = "https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip"
FONTS = ("Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic")


def latest_build_url() -> str:
    with urlopen(Request(BUILDS, headers={"User-Agent": USER_AGENT}), timeout=60) as r:
        builds = json.load(r)
    keys = sorted(b["key"] for b in builds if b.get("key", "").endswith(".pmtiles"))
    if not keys:
        raise RuntimeError("No Protomaps builds listed; set PMTILES_SOURCE to a .pmtiles URL.")
    return BUILD_BASE + keys[-1]


def extract(bbox: tuple[float, float, float, float], out_dir: Path, source: str | None = None, maxzoom: int = 15) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    source = source or latest_build_url()
    target = out_dir / "basemap.pmtiles"
    partial = out_dir / "basemap.pmtiles.part"
    print(f"tiles: extracting {source} to zoom {maxzoom}", flush=True)
    subprocess.run(["pmtiles", "extract", source, str(partial), f"--bbox={','.join(map(str, bbox))}",
                    f"--maxzoom={maxzoom}"], check=True)
    partial.replace(target)
    return target


def assets(out_dir: Path, download_dir: Path) -> Path:
    """Glyphs for the three fonts the light style uses, and the v4 sprites."""
    archive = download(ASSETS_ZIP, download_dir)
    dest = out_dir / "assets"
    if dest.exists():
        shutil.rmtree(dest)
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            parts = name.split("/", 1)
            if len(parts) < 2 or name.endswith("/"):
                continue
            rel = parts[1]
            if (rel.startswith("fonts/") and rel.split("/")[1] in FONTS) or rel.startswith("sprites/v4/light"):
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(name) as src, target.open("wb") as f:
                    shutil.copyfileobj(src, f)
    print(f"tiles: fonts and sprites in {dest}", flush=True)
    return dest
