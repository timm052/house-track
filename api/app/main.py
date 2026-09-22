import logging
import os
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import db, gnaf
from .geo_services import Nominatim, Valhalla
from .routes import campaigns, decide, driveway, geo, money, overlays, overview, people, properties
from .worker import Worker

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.open_pool(os.environ["DATABASE_URL"])
    gnaf.configure(os.environ.get("GNAF_DATABASE_URL"))
    worker = None
    if os.environ.get("WORKER", "1") != "0":
        valhalla_url = os.environ.get("VALHALLA_URL")
        # Public Nominatim by default (free, 1 request/second); set NOMINATIM_URL="" to turn it off.
        nominatim_url = os.environ.get("NOMINATIM_URL", "https://nominatim.openstreetmap.org")
        worker = Worker(Valhalla(valhalla_url) if valhalla_url else None,
                        Nominatim(nominatim_url) if nominatim_url else None)
        worker.start()
    yield
    if worker:
        worker.stop()
    gnaf.reset()
    db.close_pool()


app = FastAPI(title="House Track", version="0.1.0", lifespan=lifespan)
app.include_router(people.router)
app.include_router(properties.router)
app.include_router(campaigns.router)
app.include_router(geo.router)
app.include_router(overview.router)
app.include_router(driveway.router)
app.include_router(money.router)
app.include_router(overlays.router)
app.include_router(decide.router)


@app.get("/api/health")
def health() -> dict:
    with db.tx() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


# The schema is the source of truth for integrity; its violations become client errors.
@app.exception_handler(psycopg.errors.UniqueViolation)
def unique_violation(_: Request, exc: psycopg.Error) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": exc.diag.message_primary})


@app.exception_handler(psycopg.errors.IntegrityError)
def integrity_error(_: Request, exc: psycopg.Error) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.diag.message_primary})


@app.exception_handler(psycopg.errors.RaiseException)
def raised(_: Request, exc: psycopg.Error) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": exc.diag.message_primary})
