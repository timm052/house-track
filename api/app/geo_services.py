"""Clients for the two outside services the worker uses: Valhalla (self-hosted routing, PLAN.md D11)
and Nominatim (free public geocoding fallback, PLAN.md decision 6)."""

import json
import time
from dataclasses import dataclass
from urllib.parse import urlencode
from urllib.request import Request, urlopen

USER_AGENT = "HouseTrack/0.2 (self-hosted house-hunting app)"
COSTING = {"walk": "pedestrian", "drive": "auto"}


@dataclass
class Route:
    distance_m: int | None
    duration_s: int | None


class Valhalla:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def matrix(self, origin: tuple[float, float], targets: list[tuple[float, float]], mode: str) -> list[Route]:
        """One origin to many targets. Points are (lon, lat). Unroutable pairs come back as None."""
        body = {
            "sources": [{"lon": origin[0], "lat": origin[1]}],
            "targets": [{"lon": lon, "lat": lat} for lon, lat in targets],
            "costing": COSTING[mode],
            "units": "kilometers",
        }
        req = Request(f"{self.base_url}/sources_to_targets", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req, timeout=30) as r:
            data = json.load(r)
        return parse_matrix(data, len(targets))


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
