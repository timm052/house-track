"""The hills on the walk to the station: a house's walk, benchmark walks to compare with, and nearby stations for
choosing a benchmark's. See app/walks.py for how walks are profiled and rated."""

from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import walks
from ..db import tx
from ..deps import Person, not_found

router = APIRouter(prefix="/api")


@router.get("/properties/{property_id}/station-walk")
def station_walk(property_id: UUID) -> dict:
    """The house's walk to its nearest station, profiled (or `pending` until the worker gets to it), and the
    benchmarks to compare it with."""
    with tx() as conn:
        near = conn.execute("SELECT name FROM property_nearest_station WHERE property_id = %s", (property_id,)).fetchone()
        row = conn.execute("SELECT * FROM property_station_walk WHERE property_id = %s", (property_id,)).fetchone()
        marks = walks.benchmarks(conn)
    return {"station": near and near["name"], "walk": walks.summary(row), "pending": near is not None and row is None,
            "benchmarks": marks}


@router.get("/walk-benchmarks")
def list_benchmarks() -> list[dict]:
    with tx() as conn:
        return walks.benchmarks(conn)


@router.get("/stations/near")
def stations_near(lon: float, lat: float, limit: int = 5) -> list[dict]:
    """The closest train stations to a point, as the crow flies (to pick a benchmark walk's station)."""
    with tx() as conn:
        return conn.execute(
            """SELECT osm_id::text AS osm_id, name, round((ST_Distance(location::geography, ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography)
                      / 1000)::numeric, 1) AS km
               FROM station ORDER BY location <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326) LIMIT %s""",
            (lon, lat, lon, lat, min(limit, 10))).fetchall()


class BenchmarkIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    lon: float = Field(ge=110, le=155)
    lat: float = Field(ge=-45, le=-9)
    station_osm_id: int | None = None      # the nearest station if not given


@router.post("/walk-benchmarks", status_code=201)
def add_benchmark(body: BenchmarkIn, person: Person) -> dict:
    with tx(person) as conn:
        if body.station_osm_id is not None:
            station = conn.execute("SELECT name, location FROM station WHERE osm_id = %s", (body.station_osm_id,)).fetchone()
        else:
            station = conn.execute("""SELECT name, location FROM station
                                      ORDER BY location <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326) LIMIT 1""", (body.lon, body.lat)).fetchone()
        if station is None:
            raise HTTPException(422, "No train stations loaded yet. Run the map setup first.")
        if conn.execute("SELECT count(*) AS n FROM walk_benchmark").fetchone()["n"] >= 12:
            raise HTTPException(422, "That's 12 benchmarks already. Remove one first.")
        row = conn.execute(
            """INSERT INTO walk_benchmark (name, origin, station, target, position)
               VALUES (%s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s, %s, (SELECT coalesce(max(position), -1) + 1 FROM walk_benchmark))
               RETURNING id""", (body.name.strip(), body.lon, body.lat, station["name"], station["location"])).fetchone()
    return {"id": str(row["id"]), "station": station["name"]}


@router.post("/walk-benchmarks/{benchmark_id}/main")
def make_main(benchmark_id: UUID, person: Person) -> dict:
    """The benchmark houses are compared with first."""
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM walk_benchmark WHERE id = %s", (benchmark_id,)).fetchone() is None:
            raise not_found("Benchmark")
        conn.execute("UPDATE walk_benchmark SET position = position + 1 WHERE id <> %s", (benchmark_id,))
        conn.execute("UPDATE walk_benchmark SET position = 0 WHERE id = %s", (benchmark_id,))
    return {"id": str(benchmark_id)}


@router.delete("/walk-benchmarks/{benchmark_id}", status_code=204)
def remove_benchmark(benchmark_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM walk_benchmark WHERE id = %s", (benchmark_id,))
