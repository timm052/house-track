"""Context overlays for the region pack (PLAN.md milestone 5, streaming decision 2026-09-22).

- School zones: small (a ~12 MB zip a year), so they're downloaded and kept locally in overlay_feature.
- Planning overlays, zones and bushfire-prone areas: streamed from Victoria's open map service.
  The map draws them as WMS image tiles for whatever area is on screen; each house is looked up
  once by point (WFS) when it's pinned, and the answer saved (app/worker.py -> overlay_lookup).
"""

import json
import time
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import psycopg

from .fetch import USER_AGENT, download

WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs"
WMS = "https://opendata.maps.vic.gov.au/geoserver/wms"
CKAN = "https://discover.data.vic.gov.au/api/3/action/package_show?id="

Bbox = tuple[float, float, float, float]


@dataclass(frozen=True)
class StreamedLayer:
    code: str
    title: str
    type_name: str
    effect: str                    # default effect: info | soft_warn | hard_exclude (changeable in Settings)
    cql: str | None = None
    label: str = "zone_description"

    def wms_tiles(self) -> str:
        """Tile URL template for MapLibre; {bbox-epsg-3857} is filled in by the map."""
        params = {"service": "WMS", "version": "1.1.1", "request": "GetMap", "layers": self.type_name, "styles": "",
                  "format": "image/png", "transparent": "true", "srs": "EPSG:3857", "width": 256, "height": 256}
        url = f"{WMS}?{urlencode(params)}&bbox={{bbox-epsg-3857}}"
        return url + (f"&CQL_FILTER={quote(self.cql)}" if self.cql else "")


VIC_STREAMED = [
    StreamedLayer("vic_flood", "Flood overlays (LSIO, SBO, FO)", "open-data-platform:plan_overlay", "soft_warn",
                  "scheme_code IN ('LSIO','SBO','FO','RFO')"),
    StreamedLayer("vic_bushfire_bmo", "Bushfire Management Overlay", "open-data-platform:plan_overlay", "soft_warn",
                  "scheme_code IN ('BMO','WMO')"),
    StreamedLayer("vic_bushfire_prone", "Bushfire prone area", "open-data-platform:bushfire_prone_area", "soft_warn",
                  None, label=""),
    StreamedLayer("vic_heritage", "Heritage Overlay", "open-data-platform:plan_overlay", "info", "scheme_code = 'HO'"),
    StreamedLayer("vic_vegetation", "Vegetation and significant landscape overlays", "open-data-platform:plan_overlay",
                  "info", "scheme_code IN ('VPO','SLO','ESO')"),
    StreamedLayer("vic_residential_zones", "Residential zones (NRZ, GRZ, RGZ, MUZ)", "open-data-platform:plan_zone", "info",
                  "(zone_code LIKE 'NRZ%' OR zone_code LIKE 'GRZ%' OR zone_code LIKE 'RGZ%' OR zone_code LIKE 'MUZ%' OR zone_code LIKE 'TZ%')"),
]
STREAMED = {layer.code: layer for layer in VIC_STREAMED}

SCHOOL_FILES = {"Primary_Integrated": ("vic_school_primary", "Primary school zones"),
                "Secondary_Integrated_Year7": ("vic_school_secondary", "Secondary school zones (Year 7)")}
SMALL_WORDS = {"TO", "OF", "AND", "THE", "IN"}


def nice_label(text: object) -> object:
    """'LAND SUBJECT TO INUNDATION OVERLAY (LSIO)' -> 'Land Subject to Inundation Overlay (LSIO)'. Codes in
    brackets and tokens with digits stay as they are."""
    if not isinstance(text, str) or not text.isupper():
        return text
    out = []
    for i, word in enumerate(text.split()):
        if word.startswith("(") or any(ch.isdigit() for ch in word) or not word.isalpha():
            out.append(word)
        elif word in SMALL_WORDS and i > 0:
            out.append(word.lower())
        else:
            out.append(word.capitalize())
    return " ".join(out)


def _get_json(url: str, timeout: int = 60) -> dict:
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout) as r:
        return json.load(r)


# ─── per-house lookups (called by the worker) ─────────────────────────
def lookup_point(layer: StreamedLayer, lon: float, lat: float) -> list[dict]:
    """Features of one layer at one point. Raises on network errors so the caller can retry later."""
    point = f"INTERSECTS(geom,SRID=4326;POINT({lon} {lat}))"
    cql = f"{point} AND {layer.cql}" if layer.cql else point
    query = urlencode({"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer.type_name,
                       "outputFormat": "application/json", "count": 50, "CQL_FILTER": cql})
    features = _get_json(f"{WFS}?{query}", timeout=30)["features"]
    keep = ("zone_code", "scheme_code", "lga", "zone_description")
    return [{"label": nice_label(f["properties"].get(layer.label)) if layer.label else layer.title,
             "attrs": {k: v for k, v in f["properties"].items() if k in keep}}
            for f in features]


def lookup_all(lon: float, lat: float, pause: float = 0.2) -> dict[str, list[dict]]:
    out = {}
    for layer in VIC_STREAMED:
        out[layer.code] = lookup_point(layer, lon, lat)
        time.sleep(pause)  # be gentle with the state's server
    return out


def ensure_streamed_layers(conn: psycopg.Connection) -> None:
    """Register the streamed layers (keeping any effect the household chose) and drop features left
    over from the old download-everything import."""
    for layer in VIC_STREAMED:
        conn.execute(
            """INSERT INTO overlay_layer (code, title, effect, source_url) VALUES (%s, %s, %s, %s)
               ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, source_url = EXCLUDED.source_url""",
            (layer.code, layer.title, layer.effect, f"{WFS} {layer.type_name} (streamed)"),
        )
    conn.execute("DELETE FROM overlay_feature WHERE layer_id IN (SELECT id FROM overlay_layer WHERE code = ANY(%s))",
                 (list(STREAMED),))


# ─── school zones (downloaded) ────────────────────────────────────────
def school_zone_zip(download_dir: Path, year: int | None = None) -> Path:
    """This year's zones, or last year's if this year's aren't on DataVic yet."""
    year = year or date.today().year
    for y in (year, year - 1):
        try:
            resources = _get_json(CKAN + f"victorian-government-school-zones-{y}")["result"]["resources"]
        except Exception:
            continue
        zips = [r["url"] for r in resources if r.get("url", "").lower().endswith(".zip")]
        if zips:
            return download(zips[0], download_dir)
    raise RuntimeError("Couldn't find a school zones dataset on DataVic; set SCHOOL_ZONES_ZIP to a local file.")


def school_features(zip_path: Path) -> dict[str, tuple[str, list[dict]]]:
    out = {}
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            stem = Path(name).stem.rsplit("_", 1)[0]
            if name.endswith(".geojson") and stem in SCHOOL_FILES:
                code, title = SCHOOL_FILES[stem]
                out[code] = (title, json.loads(zf.read(name))["features"])
    return out


def replace_layer(conn: psycopg.Connection, code: str, title: str, effect: str, source: str, features,
                  label_key: str, bbox: Bbox) -> tuple[int, int]:
    """Swap one local layer's features, clipped to the search area and subdivided for fast point lookups."""
    with conn.transaction():
        layer_id = conn.execute(
            """INSERT INTO overlay_layer (code, title, effect, source_url, data_as_of) VALUES (%s, %s, %s, %s, current_date)
               ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, source_url = EXCLUDED.source_url,
                   data_as_of = EXCLUDED.data_as_of, imported_at = now()
               RETURNING id""",
            (code, title, effect, source),
        ).fetchone()[0]
        conn.execute("DELETE FROM overlay_feature WHERE layer_id = %s", (layer_id,))
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS overlay_in (label text, attrs jsonb, geom text) ON COMMIT DROP")
        count = 0
        with conn.cursor() as cur, cur.copy("COPY overlay_in (label, attrs, geom) FROM STDIN") as cp:
            for f in features:
                count += 1
                props = f.get("properties") or {}
                label = nice_label(props.get(label_key)) if label_key else title
                cp.write_row((label, json.dumps(props, default=str), json.dumps(f["geometry"])))
        n = conn.execute(
            """INSERT INTO overlay_feature (layer_id, label, attrs, geom)
               SELECT %s, label, attrs, ST_Multi(part)
               FROM overlay_in,
                    LATERAL ST_Subdivide(ST_CollectionExtract(
                        ST_Intersection(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(geom), 4326)),
                                        ST_MakeEnvelope(%s, %s, %s, %s, 4326)), 3), 256) AS part
               WHERE NOT ST_IsEmpty(part)""",
            (layer_id, *bbox),
        ).rowcount
        conn.execute("DROP TABLE overlay_in")
    return count, n


def load_schools(database_url: str, bbox: Bbox, download_dir: Path, school_zip: Path | None = None,
                 locations_csv: Path | None = None) -> None:
    with psycopg.connect(database_url) as conn:
        zones = school_features(school_zip or school_zone_zip(download_dir))
        for code, (title, features) in zones.items():
            _, n = replace_layer(conn, code, title, "info", "DataVic: Victorian Government School Zones", features, "School_Name", bbox)
            print(f"schools: {title}: {n} pieces", flush=True)
        try:
            n = load_school_locations(conn, locations_csv or school_locations_csv(download_dir), bbox)
            print(f"schools: {n} school locations", flush=True)
        except (OSError, RuntimeError, ValueError) as e:  # the zones still work without them; only travel times wait
            print(f"schools: couldn't load school locations ({e}); travel times to schools are skipped", flush=True)


def school_locations_csv(download_dir: Path, year: int | None = None) -> Path:
    """DataVic's list of every school with its position (published yearly; the newest one found is used)."""
    from datetime import date
    this = year or date.today().year
    for y in (this, this - 1, this - 2):
        path = download_dir / f"school_locations_{y}.csv"
        if path.exists():
            return path
        try:
            resources = _get_json(CKAN + f"school-locations-{y}")["result"]["resources"]
        except (HTTPError, URLError):
            continue
        csv_url = next((r["url"] for r in resources if (r.get("format") or "").upper() == "CSV"), None)
        if csv_url:
            download_dir.mkdir(parents=True, exist_ok=True)
            with urlopen(Request(csv_url, headers={"User-Agent": USER_AGENT}), timeout=120) as r:
                path.write_bytes(r.read())
            return path
    raise RuntimeError("Couldn't find a school locations dataset on DataVic.")


def load_school_locations(conn: psycopg.Connection, csv_path: Path, bbox: Bbox) -> int:
    """Open schools inside the search area, replacing what was there."""
    import csv
    import io
    text = csv_path.read_bytes().decode("utf-8-sig", errors="replace")
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            lon, lat, no = float(r["X"]), float(r["Y"]), int(r["School_No"])
        except (KeyError, ValueError):
            continue
        if r.get("School_Status", "O") != "O" or not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
            continue
        rows.append((no, r["School_Name"].strip(), r.get("School_Type") or None, r.get("Education_Sector") or "Government", lon, lat))
    if not rows:
        raise ValueError("no schools in the file")
    with conn.transaction():
        conn.execute("DELETE FROM school")
        with conn.cursor() as cur:
            cur.executemany("""INSERT INTO school (school_no, name, school_type, sector, location)
                               VALUES (%s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                               ON CONFLICT (school_no) DO NOTHING""", rows)
    return len(rows)
