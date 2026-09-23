"""Geography: address search, pins, the map, per-person areas, stations and places (milestone 2)."""

from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException

from .. import gnaf
from ..db import tx
from ..deps import OptionalPerson, Person, not_found
from ..schemas import AreaIn, AreaPatch, PlaceIn, PlacePatch, PointIn

router = APIRouter(prefix="/api")

# Hand-drawn polygons self-intersect; repair them, keep only the polygon parts, store as MultiPolygon.
CLEAN_GEOM = "ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)), 3))"


# ─── addresses & pins ─────────────────────────────────────────────────
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
                      ns.name AS nearest_station, ns.duration_s AS nearest_station_walk_s,
                      (SELECT pc.attachment_id::text FROM property_cover pc WHERE pc.property_id = p.id) AS cover_id
               FROM property p
               JOIN property_status s ON s.property_id = p.id
               LEFT JOIN property_flags f ON f.property_id = p.id AND f.person_id = %(me)s
               LEFT JOIN property_station_access ns ON ns.property_id = p.id AND ns.is_nearest
               WHERE p.location IS NOT NULL""",
            {"me": person},
        ).fetchall()
        unpinned = conn.execute("SELECT count(*) AS n FROM property WHERE location IS NULL").fetchone()["n"]
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
            "unpinned": unpinned}


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


@router.get("/stations/count")
def station_count() -> dict:
    with tx() as conn:
        return conn.execute("SELECT count(*) AS n FROM station").fetchone()


@router.get("/places")
def list_places() -> list[dict]:
    with tx() as conn:
        return conn.execute(
            """SELECT id, kind, name, person_id, station_osm_id, is_favourite, ST_X(location) AS lon, ST_Y(location) AS lat
               FROM place WHERE archived_at IS NULL ORDER BY kind DESC, name"""
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
            """INSERT INTO place (kind, name, person_id, location)
               VALUES ('destination', %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326)) RETURNING id""",
            (body.name.strip(), body.person_id, body.location.lon, body.location.lat),
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
                  max(t.duration_s) FILTER (WHERE t.mode = 'drive') AS drive_s
           FROM place pl
           LEFT JOIN travel_estimate t ON t.place_id = pl.id AND t.property_id = %s
           WHERE pl.kind = 'destination' AND pl.archived_at IS NULL
           GROUP BY pl.id ORDER BY pl.name""",
        (property_id,),
    ).fetchall()
    pending = conn.execute("SELECT count(*) AS n FROM travel_estimate_stale WHERE property_id = %s",
                           (property_id,)).fetchone()["n"]
    return {"stations": stations, "destinations": destinations, "pending": pending}

