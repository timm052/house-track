"""Milestone 5: context layers (school zones, planning overlays) for the map and property pages."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from ..db import tx
from ..deps import Person, not_found
from ..setup.overlays import STREAMED

router = APIRouter(prefix="/api")


@router.get("/overlays")
def list_layers() -> list[dict]:
    """Layers and how the map draws them: streamed ones as image tiles straight from the state's
    map service, local ones (school zones) as vector features from this server."""
    with tx() as conn:
        rows = conn.execute(
            """SELECT l.code, l.title, l.effect, l.data_as_of, l.imported_at, count(f.id) AS pieces
               FROM overlay_layer l LEFT JOIN overlay_feature f ON f.layer_id = l.id
               GROUP BY l.id ORDER BY l.code"""
        ).fetchall()
    for r in rows:
        streamed = STREAMED.get(r["code"])
        r["tiles"] = streamed.wms_tiles() if streamed else None
    return rows


class LayerPatch(BaseModel):
    effect: Literal["info", "soft_warn", "hard_exclude"]


@router.patch("/overlays/{code}")
def set_effect(code: str, body: LayerPatch, _: Person) -> dict:
    """Whether a layer only informs, warns, or excludes houses for everyone (e.g. make floodways a hard no)."""
    with tx() as conn:
        row = conn.execute("UPDATE overlay_layer SET effect = %s WHERE code = %s RETURNING code, effect",
                           (body.effect, code)).fetchone()
    if row is None:
        raise not_found("Layer")
    return row


@router.get("/overlays/{code}/features")
def features(code: str, bbox: str, zoom: float = 14) -> dict:
    """Features in the visible map area, simplified to the zoom level so the payload stays small."""
    minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
    tolerance = 0 if zoom >= 16 else 0.00002 * 2 ** (16 - zoom)
    with tx() as conn:
        rows = conn.execute(
            """SELECT f.label, ST_AsGeoJSON(ST_SimplifyPreserveTopology(f.geom, %s), 6)::json AS geometry
               FROM overlay_feature f JOIN overlay_layer l ON l.id = f.layer_id
               WHERE l.code = %s AND f.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)
               LIMIT 6000""",
            (tolerance, code, minx, miny, maxx, maxy),
        ).fetchall()
    return {"type": "FeatureCollection",
            "features": [{"type": "Feature", "geometry": r["geometry"], "properties": {"label": r["label"]}} for r in rows]}


def overlays_for(conn, property_id) -> list[dict]:
    return conn.execute(
        """SELECT DISTINCT h.code, l.title, h.effect, h.label FROM property_overlay_hit h
           JOIN overlay_layer l ON l.code = h.code WHERE h.property_id = %s ORDER BY h.code, h.label""",
        (property_id,),
    ).fetchall()
