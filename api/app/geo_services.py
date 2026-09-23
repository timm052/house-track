"""Clients for the two outside services the worker uses: Valhalla (self-hosted routing, PLAN.md D11)
and Nominatim (free public geocoding fallback, PLAN.md decision 6)."""

import json
import math
import time
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = "HouseTrack/0.2 (self-hosted house-hunting app)"
COSTING = {"walk": "pedestrian", "drive": "auto"}
# Beyond this straight-line distance a walk isn't worth asking about (and the public server refuses walks
# over 30 km, which used to stall the worker on the same request forever): recorded as "no route".
MAX_WALK_M = 25_000


def crow_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Straight-line distance in metres between two (lon, lat) points."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


@dataclass
class Route:
    distance_m: int | None
    duration_s: int | None


class Valhalla:
    """A self-hosted engine, or the free public FOSSGIS server (fair use: we pause a second between
    requests, and results are cached in travel_estimate so each route is asked for once)."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.pause = 0.0 if any(h in self.base_url for h in ("localhost", "valhalla:", "127.0.0.1")) else 1.0
        self._last = 0.0

    def _post(self, path: str, body: dict) -> dict:
        wait = self.pause - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        req = Request(f"{self.base_url}/{path}", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", "User-Agent": USER_AGENT}, method="POST")
        with urlopen(req, timeout=30) as r:
            return json.load(r)

    def matrix(self, origin: tuple[float, float], targets: list[tuple[float, float]], mode: str) -> list[Route]:
        """One origin to many targets. Points are (lon, lat). Unroutable pairs come back as Route(None, None).
        Walks too far to matter aren't asked for, and pairs the matrix leaves empty (it gives up on long
        drives on the public server) are asked for again one at a time."""
        routes = [Route(None, None)] * len(targets)
        ask = [i for i, t in enumerate(targets) if mode != "walk" or crow_m(origin, t) <= MAX_WALK_M]
        if ask:
            body = {"sources": [{"lon": origin[0], "lat": origin[1]}],
                    "targets": [{"lon": targets[i][0], "lat": targets[i][1]} for i in ask],
                    "costing": COSTING[mode], "units": "kilometers"}
            try:
                got = parse_matrix(self._post("sources_to_targets", body), len(ask))
            except HTTPError as e:
                if e.code != 400:
                    raise  # server down or busy: the worker backs off and tries again
                got = [Route(None, None)] * len(ask)  # a request it won't answer, such as a limit: one at a time
            for i, route in zip(ask, got):
                routes[i] = route if route.duration_s is not None else self.route(origin, targets[i], mode)
        return routes

    def route(self, origin: tuple[float, float], target: tuple[float, float], mode: str) -> Route:
        """A single route; Route(None, None) when there's no way there (or the server won't say)."""
        body = {"locations": [{"lon": origin[0], "lat": origin[1]}, {"lon": target[0], "lat": target[1]}],
                "costing": COSTING[mode], "units": "kilometers", "directions_type": "none"}
        try:
            summary = self._post("route", body)["trip"]["summary"]
        except HTTPError as e:
            if e.code != 400:
                raise
            return Route(None, None)
        return Route(round(summary["length"] * 1000), round(summary["time"]))


def parse_matrix(data: dict, n: int) -> list[Route]:
    """Valhalla has returned both a list-of-rows of cells and a {distances, durations} object."""
    matrix = data["sources_to_targets"]
    if isinstance(matrix, dict):
        distances, durations = matrix["distances"][0], matrix["durations"][0]
    else:
        row = sorted(matrix[0], key=lambda c: c.get("to_index", 0))
        distances = [c.get("distance") for c in row]
        durations = [c.get("time") for c in row]
    routes = []
    for i in range(n):
        d, t = distances[i], durations[i]
        routes.append(Route(None, None) if d is None or t is None else Route(round(d * 1000), round(t)))
    return routes


class Nominatim:
    """Structured search, at most one request per second (the public server's usage policy)."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._last = 0.0

    def geocode(self, street: str, suburb: str, postcode: str) -> tuple[float, float, float, dict] | None:
        wait = 1.1 - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        query = urlencode({"street": street, "city": suburb, "postalcode": postcode, "countrycodes": "au",
                           "format": "jsonv2", "limit": 1, "addressdetails": 0})
        req = Request(f"{self.base_url}/search?{query}", headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=20) as r:
            results = json.load(r)
        if not results:
            return None
        hit = results[0]
        # place_rank 30 is a building/house number; anything coarser only locates the street.
        confidence = 0.6 if int(hit.get("place_rank", 0)) >= 30 else 0.3
        return float(hit["lon"]), float(hit["lat"]), confidence, {
            "display_name": hit.get("display_name"), "osm_type": hit.get("osm_type"), "place_rank": hit.get("place_rank"),
        }
