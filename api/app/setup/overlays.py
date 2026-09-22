"""Context overlays for the region pack (PLAN.md milestone 5): school zones and planning controls,
loaded into overlay_layer / overlay_feature, clipped to the search area.

Victoria's sources:
- School zones: the Department of Education's yearly zip on DataVic (GeoJSON inside, lon/lat).
- Planning overlays, zones and bushfire-prone areas: Vicmap Planning through the open WFS at
  opendata.maps.vic.gov.au, filtered and clipped to BBOX on the server.
Each layer is replaced in one transaction, so a failed refresh keeps the previous data.
"""

import json
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import psycopg

from .fetch import USER_AGENT, download

WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs"
CKAN = "https://discover.data.vic.gov.au/api/3/action/package_show?id="
PAGE = 2000

Bbox = tuple[float, float, float, float]


@dataclass(frozen=True)
class WfsLayer:
    code: str
    title: str
    type_name: str
    effect: str                    # info | soft_warn | hard_exclude
    cql: str | None = None         # extra filter, combined with the search-area box
    label: str = "zone_description"
    sort_by: str | None = "ufi"    # stable order for paging; not every layer has ufi


VIC_WFS = [
    WfsLayer("vic_flood", "Flood overlays (LSIO, SBO, FO)", "open-data-platform:plan_overlay", "soft_warn",
             "scheme_code IN ('LSIO','SBO','FO','RFO')"),
    WfsLayer("vic_bushfire_bmo", "Bushfire Management Overlay", "open-data-platform:plan_overlay", "soft_warn",
             "scheme_code IN ('BMO','WMO')"),
    WfsLayer("vic_bushfire_prone", "Bushfire prone area", "open-data-platform:bushfire_prone_area", "soft_warn",
             None, label="", sort_by=None),
    WfsLayer("vic_heritage", "Heritage Overlay", "open-data-platform:plan_overlay", "info", "scheme_code = 'HO'"),
    WfsLayer("vic_vegetation", "Vegetation and significant landscape overlays", "open-data-platform:plan_overlay", "info",
             "scheme_code IN ('VPO','SLO','ESO')"),
    WfsLayer("vic_residential_zones", "Residential zones (NRZ, GRZ, RGZ, MUZ)", "open-data-platform:plan_zone", "info",
             "(zone_code LIKE 'NRZ%' OR zone_code LIKE 'GRZ%' OR zone_code LIKE 'RGZ%' OR zone_code LIKE 'MUZ%' OR zone_code LIKE 'TZ%')"),
]

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


def _get_json(url: str) -> dict:
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=180) as r:
        return json.load(r)


def wfs_features(layer: WfsLayer, bbox: Bbox) -> list[dict]:
    box = f"BBOX(geom,{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]},'EPSG:4326')"
    cql = f"{box} AND {layer.cql}" if layer.cql else box
    features, start = [], 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": layer.type_name,
                  "outputFormat": "application/json", "srsName": "EPSG:4326", "count": PAGE, "startIndex": start,
                  "CQL_FILTER": cql}
        if layer.sort_by:
            params["sortBy"] = layer.sort_by
        query = urlencode(params)
        page = _get_json(f"{WFS}?{query}")["features"]
        features += page
        if len(page) < PAGE:
            return features
        start += PAGE


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


def replace_layer(conn: psycopg.Connection, code: str, title: str, effect: str, source: str, features: list[dict],
                  label_key: str, bbox: Bbox) -> int:
    """Swap one layer's features, clipped to the search area and subdivided for fast point lookups."""
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
        with conn.cursor() as cur, cur.copy("COPY overlay_in (label, attrs, geom) FROM STDIN") as cp:
            for f in features:
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
    return n


def load(database_url: str, bbox: Bbox, download_dir: Path, school_zip: Path | None = None) -> None:
    with psycopg.connect(database_url) as conn:
        zones = school_features(school_zip or school_zone_zip(download_dir))
        for code, (title, features) in zones.items():
            n = replace_layer(conn, code, title, "info", "DataVic: Victorian Government School Zones", features, "School_Name", bbox)
            print(f"overlays: {title}: {n} pieces", flush=True)
        for layer in VIC_WFS:
            features = wfs_features(layer, bbox)
            n = replace_layer(conn, layer.code, layer.title, layer.effect, f"Vicmap Planning WFS {layer.type_name}",
                              features, layer.label, bbox)
            print(f"overlays: {layer.title}: {len(features)} features, {n} pieces", flush=True)
