"""Region packs (PLAN.md D9). Only Victoria exists; a new state adds an entry here plus its
overlay importers (milestone 5) and labels in the web app."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Region:
    code: str
    gnaf_state: str
    osm_extract: str
    default_bbox: tuple[float, float, float, float]  # min lon, min lat, max lon, max lat


REGIONS = {
    "vic": Region(
        code="vic",
        gnaf_state="VIC",
        # Geofabrik has no per-state extracts for Australia; the national file is clipped to BBOX.
        osm_extract="https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf",
        default_bbox=(140.96, -39.20, 150.00, -33.98),  # all of Victoria
    ),
}


def get(code: str) -> Region:
    try:
        return REGIONS[code.lower()]
    except KeyError:
        raise SystemExit(f"Unknown REGION {code!r}; known: {', '.join(REGIONS)}") from None


def parse_bbox(text: str | None, region: Region) -> tuple[float, float, float, float]:
    if not text:
        return region.default_bbox
    parts = [float(p) for p in text.split(",")]
    if len(parts) != 4 or parts[0] >= parts[2] or parts[1] >= parts[3]:
        raise SystemExit("BBOX must be minLon,minLat,maxLon,maxLat")
    return parts[0], parts[1], parts[2], parts[3]
