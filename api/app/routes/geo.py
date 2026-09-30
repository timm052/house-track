"""Geography: address search, pins, the map, per-person areas, stations and places (milestone 2)."""

import os
import threading
from typing import Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import gnaf
from ..db import tx
from ..deps import OptionalPerson, Person, not_found
from ..geo_services import Valhalla
from ..schemas import AreaIn, AreaPatch, PlaceIn, PlacePatch, PointIn

router = APIRouter(prefix="/api")

# Hand-drawn polygons self-intersect; repair them, keep only the polygon parts, store as MultiPolygon.
CLEAN_GEOM = "ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3))"


# ─── addresses & pins ─────────────────────────────────────────────────
@router.get("/address/localities")
def address_localities(q: str) -> list[dict]:
    """Suburb and postcode suggestions, for typing an address the national address file doesn't have yet."""
    return gnaf.localities(q)


@router.get("/address/search")
def address_search(q: str) -> list[dict]:
    return [
        {k: r[k] for k in ("pid", "display", "unit", "street_number", "street", "suburb", "postcode",
                           "lot_number", "lon", "lat")}
        for r in gnaf.search(q)
    ]


@router.put("/properties/{property_id}/location")
def set_pin(property_id: UUID, body: PointIn, person: Person) -> dict:
    with tx(person) as conn:
        row = conn.execute(
            "UPDATE property SET manual_location = ST_SetSRID(ST_MakePoint(%s, %s), 4326), manual_location_by = %s"
            " WHERE id = %s RETURNING id",
            (body.lon, body.lat, person, property_id),
        ).fetchone()
    if row is None:
        raise not_found("Property")
    return {"id": property_id}


@router.delete("/properties/{property_id}/location", status_code=204)
def clear_pin(property_id: UUID, person: Person) -> None:
    """Drop the manual pin and go back to the geocoded point."""
    with tx(person) as conn:
        conn.execute("UPDATE property SET manual_location = NULL, manual_location_by = NULL WHERE id = %s",
                     (property_id,))


# ─── map ──────────────────────────────────────────────────────────────
def _feature(geometry: dict, properties: dict) -> dict:
    return {"type": "Feature", "geometry": geometry, "properties": properties}


@router.get("/map")
def map_data(person: OptionalPerson) -> dict:
    """Everything the map draws, with area flags worked out for the person asking (PLAN.md D3)."""
    with tx() as conn:
        props = conn.execute(
            """SELECT p.id, ST_AsGeoJSON(p.location)::json AS geometry, p.unit, p.street_number, p.street,
                      p.suburb, p.plan_number, p.lot_number, p.manual_location IS NOT NULL AS manual_pin,
                      s.status,
                      coalesce(f.excluded, false) AS excluded, coalesce(f.warned, false) AS warned,
                      coalesce(f.reasons, '{}') AS reasons,
                      coalesce((SELECT jsonb_agg(jsonb_build_object('owner_id', h.owner_id, 'kind', h.kind, 'name', h.name))
                                FROM property_area_hit h
                                WHERE h.property_id = p.id AND h.owner_id IS DISTINCT FROM %(me)s), '[]') AS others_flags,
                      coalesce((SELECT jsonb_agg(jsonb_build_object('person_id', person_id, 'stage', stage, 'stance', stance))
                                FROM opinion_current oc WHERE oc.property_id = p.id), '[]') AS opinions,
                      ns.name AS nearest_station, ns.walk_s AS nearest_station_walk_s, ns.drive_s AS nearest_station_drive_s,
                      (SELECT pc.attachment_id::text FROM property_cover pc WHERE pc.property_id = p.id) AS cover_id,
                      (SELECT round(avg(ps.score))::int FROM property_score ps WHERE ps.property_id = p.id) AS score_avg
               FROM property p
               JOIN property_status s ON s.property_id = p.id
               LEFT JOIN property_flags f ON f.property_id = p.id AND f.person_id = %(me)s
               LEFT JOIN property_nearest_station ns ON ns.property_id = p.id
               WHERE p.location IS NOT NULL""",
            {"me": person},
        ).fetchall()
        unpinned = conn.execute("SELECT count(*) AS n FROM property WHERE location IS NULL").fetchone()["n"]
        pending = routing_pending(conn)
        areas = conn.execute(
            """SELECT id, owner_id, name, kind, reason, ST_AsGeoJSON(geom)::json AS geometry, updated_at
               FROM area WHERE archived_at IS NULL ORDER BY created_at"""
        ).fetchall()
        places = conn.execute(
            """SELECT id, kind, name, person_id, station_osm_id, is_favourite, ST_AsGeoJSON(location)::json AS geometry
               FROM place WHERE archived_at IS NULL ORDER BY kind, name"""
        ).fetchall()

    def collection(rows: list[dict]) -> dict:
        return {"type": "FeatureCollection",
                "features": [_feature(r.pop("geometry"), {**r, "id": str(r["id"])}) for r in rows]}

    return {"properties": collection(props), "areas": collection(areas), "places": collection(places),
            "unpinned": unpinned, "pending": pending}


# ─── areas ────────────────────────────────────────────────────────────
@router.post("/areas", status_code=201)
def create_area(body: AreaIn, person: Person) -> dict:
    with tx(person) as conn:
        row = conn.execute(
            f"""INSERT INTO area (owner_id, name, kind, reason, geom)
                VALUES (coalesce(%s, app_person()), %s, %s, %s, {CLEAN_GEOM}) RETURNING id""",
            (body.owner_id, body.name.strip(), body.kind, body.reason, body.geometry.model_dump_json()),
        ).fetchone()
    return {"id": row["id"]}


@router.patch("/areas/{area_id}")
def update_area(area_id: UUID, body: AreaPatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True, exclude={"geometry"})
    sets = [f"{k} = %({k})s" for k in values]
    if body.geometry is not None:
        sets.append(f"geom = {CLEAN_GEOM.replace('%s', '%(geometry)s')}")
        values["geometry"] = body.geometry.model_dump_json()
    if not sets:
        return {"id": area_id}
    with tx(person) as conn:
        row = conn.execute(
            f"UPDATE area SET {', '.join(sets)} WHERE id = %(id)s AND archived_at IS NULL RETURNING id",
            values | {"id": area_id},
        ).fetchone()
    if row is None:
        raise not_found("Area")
    return {"id": area_id}


@router.delete("/areas/{area_id}", status_code=204)
def archive_area(area_id: UUID, person: Person) -> None:
    """Archived, not deleted, so earlier exclusions still make sense (PLAN.md §2)."""
    with tx(person) as conn:
        conn.execute("UPDATE area SET archived_at = now() WHERE id = %s AND archived_at IS NULL", (area_id,))


# ─── stations & places ────────────────────────────────────────────────
@router.get("/stations/search")
def station_search(q: str) -> list[dict]:
    q = q.strip()
    if len(q) < 2:
        return []
    with tx() as conn:
        return conn.execute(
            """SELECT s.osm_id, s.name, ST_X(s.location) AS lon, ST_Y(s.location) AS lat,
                      EXISTS (SELECT 1 FROM place pl WHERE pl.station_osm_id = s.osm_id AND pl.archived_at IS NULL) AS chosen
               FROM station s
               WHERE s.name ILIKE %s OR s.name %% %s
               ORDER BY s.name ILIKE %s DESC, similarity(s.name, %s) DESC, s.name LIMIT 10""",
            (f"%{q}%", q, f"{q}%", q),
        ).fetchall()


@router.get("/stations")
def all_stations() -> dict:
    """Every train station in the region, for the map."""
    with tx() as conn:
        rows = conn.execute("SELECT osm_id, name, ST_X(location) AS lon, ST_Y(location) AS lat FROM station ORDER BY name").fetchall()
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
         "properties": {"osm_id": r["osm_id"], "name": r["name"]}} for r in rows]}


@router.get("/stations/count")
def station_count() -> dict:
    with tx() as conn:
        return conn.execute("SELECT count(*) AS n FROM station").fetchone()


@router.get("/places")
def list_places() -> list[dict]:
    with tx() as conn:
        return conn.execute(
            """SELECT pl.id, pl.kind, pl.name, pl.person_id, pl.station_osm_id, pl.is_favourite, pl.modes,
                      ST_X(pl.location) AS lon, ST_Y(pl.location) AS lat,
                      (SELECT count(DISTINCT t.property_id) FROM travel_estimate t WHERE t.place_id = pl.id) AS houses
               FROM place pl WHERE pl.archived_at IS NULL ORDER BY pl.kind DESC, pl.name"""
        ).fetchall()


@router.post("/places", status_code=201)
def create_place(body: PlaceIn, person: Person) -> dict:
    with tx(person) as conn:
        if body.kind == "station":
            existing = conn.execute("SELECT id, archived_at FROM place WHERE station_osm_id = %s",
                                    (body.station_osm_id,)).fetchone()
            if existing:
                # Re-choosing a station that was removed brings the old row (and its cached routes) back.
                conn.execute("UPDATE place SET archived_at = NULL WHERE id = %s", (existing["id"],))
                return {"id": existing["id"]}
            row = conn.execute(
                """INSERT INTO place (kind, name, station_osm_id, location)
                   SELECT 'station', name, osm_id, location FROM station WHERE osm_id = %s RETURNING id""",
                (body.station_osm_id,),
            ).fetchone()
            if row is None:
                raise not_found("Station")
            return {"id": row["id"]}
        row = conn.execute(
            """INSERT INTO place (kind, name, person_id, location, modes)
               VALUES ('destination', %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s) RETURNING id""",
            (body.name.strip(), body.person_id, body.location.lon, body.location.lat,
             sorted(set(body.modes)) if body.modes is not None else ["drive", "transit", "walk"]),
        ).fetchone()
        return {"id": row["id"]}


@router.patch("/places/{place_id}")
def update_place(place_id: UUID, body: PlacePatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True)
    with tx(person) as conn:
        kind = conn.execute("SELECT kind FROM place WHERE id = %s", (place_id,)).fetchone()
        if kind is None:
            raise not_found("Place")
        if kind["kind"] == "station" and "location" in values:
            raise HTTPException(422, "A station's location comes from the station list.")
        if "modes" in values and values["modes"] is not None:
            if kind["kind"] == "station":
                raise HTTPException(422, "Stations are always walking times.")
            modes = sorted(set(values["modes"]))
            conn.execute("UPDATE place SET modes = %s WHERE id = %s", (modes, place_id))
            # Times for a mode that's been turned off go, so they don't linger on the cards and in the grid.
            conn.execute("DELETE FROM travel_estimate WHERE place_id = %s AND NOT (mode = ANY(%s))", (place_id, modes))
            if "transit" not in modes:
                conn.execute("DELETE FROM transit_estimate WHERE place_id = %s", (place_id,))
        if "name" in values:
            conn.execute("UPDATE place SET name = %s WHERE id = %s", (values["name"].strip(), place_id))
        if "person_id" in values:
            conn.execute("UPDATE place SET person_id = %s WHERE id = %s", (values["person_id"], place_id))
        if "location" in values:
            loc = values["location"]
            conn.execute("UPDATE place SET location = ST_SetSRID(ST_MakePoint(%s, %s), 4326) WHERE id = %s",
                         (loc["lon"], loc["lat"], place_id))
    return {"id": place_id}


@router.delete("/places/{place_id}", status_code=204)
def archive_place(place_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("UPDATE place SET archived_at = now() WHERE id = %s", (place_id,))


ROUTING_PENDING = """SELECT (SELECT count(*) FROM travel_estimate_stale {w}) + (SELECT count(*) FROM station_access_stale {w})
                          + (SELECT count(*) FROM transit_estimate_stale {w})
                          + (SELECT count(*) FROM ({peak}) x {w})
                          + (SELECT count(*) FROM school_access_stale {w}) AS n"""


def routing_pending(conn: psycopg.Connection, property_id: UUID | None = None) -> int:
    """Travel times still to be worked out (after a pin or a place moves, or a mode is switched on): screens that show
    them check again until this is zero."""
    where = "WHERE property_id = %(p)s" if property_id else ""
    from ..worker import PEAK_PENDING
    return conn.execute(ROUTING_PENDING.format(w=where, peak=PEAK_PENDING), {"p": property_id}).fetchone()["n"]


def travel_for(conn: psycopg.Connection, property_id: UUID) -> dict:
    """Stations to show (nearest + within the walk limit) and every destination's walk/drive figures."""
    stations = conn.execute(
        """SELECT place_id, name, distance_m, duration_s, is_nearest, within_limit
           FROM property_station_access WHERE property_id = %s AND (is_nearest OR within_limit)
           ORDER BY duration_s""",
        (property_id,),
    ).fetchall()
    destinations = conn.execute(
        """SELECT pl.id AS place_id, pl.name, pl.person_id,
                  max(t.distance_m) FILTER (WHERE t.mode = 'walk') AS walk_m,
                  max(t.duration_s) FILTER (WHERE t.mode = 'walk') AS walk_s,
                  max(t.distance_m) FILTER (WHERE t.mode = 'drive') AS drive_m,
                  max(t.duration_s) FILTER (WHERE t.mode = 'drive') AS drive_s,
                  max(t.peak_s) FILTER (WHERE t.mode = 'drive') AS drive_peak_s,
                  (SELECT jsonb_build_object('duration_s', x.duration_s, 'depart_at', x.depart_at, 'arrive_at', x.arrive_at,
                                             'arrive_by', x.arrive_by, 'transfers', x.transfers, 'legs', x.legs,
                                             'home', CASE WHEN x.home_duration_s IS NOT NULL THEN jsonb_build_object(
                                               'duration_s', x.home_duration_s, 'depart_at', x.home_depart_at,
                                               'arrive_at', x.home_arrive_at, 'transfers', x.home_transfers, 'legs', x.home_legs) END)
                   FROM transit_estimate x WHERE x.property_id = %(p)s AND x.place_id = pl.id) AS transit
           FROM place pl
           LEFT JOIN travel_estimate t ON t.place_id = pl.id AND t.property_id = %(p)s
           WHERE pl.kind = 'destination' AND pl.archived_at IS NULL
           GROUP BY pl.id ORDER BY pl.name""",
        {"p": property_id},
    ).fetchall()
    pending = routing_pending(conn, property_id)
    nearest = conn.execute("""SELECT station_osm_id, name, walk_m, walk_s, drive_m, drive_s FROM property_nearest_station
                              WHERE property_id = %s""", (property_id,)).fetchone()
    schools = conn.execute(
        """SELECT z.level, z.name, a.walk_m, a.walk_s, a.drive_m, a.drive_s
           FROM property_zoned_school z LEFT JOIN school_access a ON a.property_id = z.property_id AND a.school_no = z.school_no
           WHERE z.property_id = %s ORDER BY z.level""", (property_id,)).fetchall()
    return {"nearest": nearest, "stations": stations, "destinations": destinations, "schools": schools, "pending": pending}



# ─── inspection planner and commute areas ──────────────────────────────
# Asked of the routing engine on demand (the free public server unless VALHALLA_URL says otherwise), a second
# apart, and remembered for the life of the process: the same leg or area is only asked for once.
_routing_lock = threading.Lock()
_routing_client: Valhalla | None = None
_legs: dict[tuple, dict | None] = {}
_areas: dict[tuple, dict] = {}


def _routing() -> Valhalla:
    global _routing_client
    if _routing_client is None:
        _routing_client = Valhalla(os.environ.get("VALHALLA_URL") or "https://valhalla1.openstreetmap.de")
    return _routing_client


class LegsIn(BaseModel):
    points: list[tuple[float, float]] = Field(min_length=2, max_length=12)  # (lon, lat), in visiting order
    mode: Literal["drive", "walk"] = "drive"


@router.post("/plan/legs")
def plan_legs(body: LegsIn) -> dict:
    """Travel between consecutive stops of an inspection plan: one entry per leg, None where there's no route."""
    out = []
    with _routing_lock:
        for a, b in zip(body.points, body.points[1:]):
            key = (round(a[0], 5), round(a[1], 5), round(b[0], 5), round(b[1], 5), body.mode)
            if key not in _legs:
                try:
                    r = _routing().route(a, b, body.mode)
                except OSError as e:
                    raise HTTPException(502, f"The routing service didn't answer ({e}). Try again in a minute.") from None
                _legs[key] = None if r.duration_s is None else {"distance_m": r.distance_m, "duration_s": r.duration_s}
            out.append(_legs[key])
    return {"legs": out}


_paths: dict[tuple, dict] = {}


@router.get("/properties/{property_id}/station-route")
def station_route(property_id: UUID) -> dict:
    """The walk and the drive from a house to its nearest train station, with the paths, for the map."""
    with tx() as conn:
        row = conn.execute("""SELECT ST_X(p.location) AS lon, ST_Y(p.location) AS lat, n.name, n.lon AS s_lon, n.lat AS s_lat
                              FROM property p JOIN property_nearest_station n ON n.property_id = p.id
                              WHERE p.id = %s""", (property_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "No nearest station yet. The house needs a pin first.")
    origin, target = (row["lon"], row["lat"]), (row["s_lon"], row["s_lat"])
    out = {"station": {"name": row["name"], "lon": row["s_lon"], "lat": row["s_lat"]}}
    with _routing_lock:
        for mode in ("walk", "drive"):
            key = (round(origin[0], 5), round(origin[1], 5), round(target[0], 5), round(target[1], 5), mode)
            if key not in _paths:
                try:
                    route, path = _routing().route_path(origin, target, mode)
                except OSError as e:
                    raise HTTPException(502, f"The routing service didn't answer ({e}). Try again in a minute.") from None
                _paths[key] = {"distance_m": route.distance_m, "duration_s": route.duration_s,
                               "geometry": {"type": "LineString", "coordinates": path} if path else None}
            out[mode] = _paths[key]
    return out


@router.get("/isochrone")
def isochrone(lon: float, lat: float, minutes: int = Query(ge=5, le=60), mode: Literal["drive", "walk"] = "drive") -> dict:
    """Everywhere reachable from a point within so many minutes, as a GeoJSON polygon feature (for the map)."""
    key = (round(lon, 4), round(lat, 4), minutes, mode)
    with _routing_lock:
        if key not in _areas:
            try:
                _areas[key] = _routing().isochrone((lon, lat), minutes, mode)
            except OSError as e:
                raise HTTPException(502, f"The routing service didn't answer ({e}). Try again in a minute.") from None
        return _areas[key]


@router.get("/map-config")
def map_config() -> dict:
    """Where the map's satellite photos come from: Esri's keyed imagery service with the household's free ArcGIS key
    (ARCGIS_API_KEY) when there is one; otherwise None, and the map uses Esri's open tiles."""
    key = os.environ.get("ARCGIS_API_KEY", "").strip()
    return {"satellite": "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token="
                         + key if key else None}
