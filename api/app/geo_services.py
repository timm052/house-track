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


# Peak hour (arriving at 9, leaving at 5): how much slower each kind of road gets. Big roads carry the commute
# and clog; side streets barely change. An estimate: the free routing engines have no live or historic traffic.
PEAK_FACTOR = {"motorway": 1.8, "trunk": 1.6, "primary": 1.5, "secondary": 1.35, "tertiary": 1.2}
PEAK_OTHER = 1.05


def peak_factor(edges: list[dict]) -> float:
    """The route's slow-down in peak hour: each stretch's free-flow time weighted by its road type's factor."""
    free = peak = 0.0
    for e in edges:
        length, speed = e.get("length"), e.get("speed")
        if not length or not speed:
            continue
        t = length / speed  # km / km/h: only the proportions matter
        free += t
        peak += t * PEAK_FACTOR.get(e.get("road_class") or "", PEAK_OTHER)
    return peak / free if free else 1.0


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
                # A matrix cell that's empty, or says 0 m between points more than 200 m apart, gets asked again alone.
                bogus = route.distance_m == 0 and crow_m(origin, targets[i]) > 200
                routes[i] = route if route.duration_s is not None and not bogus else self.route(origin, targets[i], mode)
        return routes

    def isochrone(self, origin: tuple[float, float], minutes: int, mode: str) -> dict:
        """The area reachable within `minutes`, as one GeoJSON polygon feature."""
        body = {"locations": [{"lon": origin[0], "lat": origin[1]}], "costing": COSTING[mode],
                "contours": [{"time": minutes}], "polygons": True, "denoise": 0.5, "generalize": 60}
        feature = self._post("isochrone", body)["features"][0]
        return {"type": "Feature", "geometry": feature["geometry"], "properties": {"minutes": minutes, "mode": mode}}

    def route_path(self, origin: tuple[float, float], target: tuple[float, float], mode: str) -> tuple[Route, list[list[float]]]:
        """A single route with the path it takes, as [lon, lat] points (for drawing on the map)."""
        body = {"locations": [{"lon": origin[0], "lat": origin[1]}, {"lon": target[0], "lat": target[1]}],
                "costing": COSTING[mode], "units": "kilometers", "directions_type": "none"}
        try:
            trip = self._post("route", body)["trip"]
        except HTTPError as e:
            if e.code != 400:
                raise
            return Route(None, None), []
        path = [p for leg in trip["legs"] for p in decode_polyline6(leg["shape"])]
        return Route(round(trip["summary"]["length"] * 1000), round(trip["summary"]["time"])), path

    def drive_peak(self, origin: tuple[float, float], target: tuple[float, float]) -> int | None:
        """The drive in peak hour, in seconds: the route's own time, slowed by the road types it uses."""
        body = {"locations": [{"lon": origin[0], "lat": origin[1]}, {"lon": target[0], "lat": target[1]}],
                "costing": "auto", "units": "kilometers", "directions_type": "none"}
        try:
            trip = self._post("route", body)["trip"]
            edges = []
            for leg in trip["legs"]:
                got = self._post("trace_attributes", {"encoded_polyline": leg["shape"], "shape_match": "map_snap", "costing": "auto",
                                                      "filters": {"attributes": ["edge.road_class", "edge.length", "edge.speed"],
                                                                  "action": "include"}})
                edges += got.get("edges", [])
        except HTTPError as e:
            if e.code != 400:
                raise
            return None
        return round(trip["summary"]["time"] * peak_factor(edges))

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


def decode_polyline6(encoded: str) -> list[list[float]]:
    """Valhalla's route shapes: Google's encoded-polyline format at six decimal places. Returns [lon, lat] points."""
    points, lat, lon, i = [], 0, 0, 0
    while i < len(encoded):
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                b = ord(encoded[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        points.append([lon / 1e6, lat / 1e6])
    return points


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


# ─── public transport ──────────────────────────────────────────────────
MELBOURNE_TZ = "Australia/Melbourne"
TRANSIT_MODES = {"WALK": "walk", "BUS": "bus", "COACH": "coach", "TRAM": "tram", "SUBWAY": "train", "RAIL": "train",
                 "REGIONAL_RAIL": "V/Line train", "REGIONAL_FAST_RAIL": "V/Line train", "LONG_DISTANCE": "train",
                 "SUBURBAN": "train", "FERRY": "ferry", "METRO": "train"}


def pick_departure(itineraries: list[dict], depart_at) -> dict | None:
    """The journey home: the first to arrive of those leaving at or after the time (within two hours)."""
    from datetime import datetime, timedelta
    def when(t: str):
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    ok = [i for i in itineraries if depart_at <= when(i["startTime"]) <= depart_at + timedelta(hours=2)]
    return min(ok, key=lambda i: (when(i["endTime"]), i["duration"]), default=None)


SHORT_RIDE_S = 10 * 60  # a ride shorter than this is walked instead: no waiting for a tram to go two stops


def has_short_ride(it: dict) -> bool:
    return any(leg.get("mode") != "WALK" and leg.get("duration", 0) < SHORT_RIDE_S for leg in it.get("legs", []))


WALKABLE_RIDE_M = 1500   # a short ride this close (as the crow flies) is walked instead
WALK_M_PER_S = 1.3       # about 4.7 km/h
WALK_DETOUR = 1.3        # streets aren't straight lines


def _when(t: str):
    from datetime import datetime
    return datetime.fromisoformat(t.replace("Z", "+00:00"))


def _iso(dt) -> str:
    from datetime import timezone
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _point(p: dict | None) -> tuple[float, float] | None:
    return (p["lon"], p["lat"]) if p and p.get("lon") is not None and p.get("lat") is not None else None


def walk_short_rides(it: dict, arrive_by=None, depart_at=None) -> dict:
    """The first or last ride of a journey, if it's under 10 minutes and walkable (1.5 km), walked instead: along with
    the walks either side of it, as one walk. A walk at the start ends when the next ride leaves; one at the end
    starts when the last ride arrives. Only if it still gets there by 9 (or leaves after 5)."""
    from datetime import timedelta
    legs = list(it["legs"])
    changed = False
    for end in ("last", "first"):
        rides = [i for i, leg in enumerate(legs) if leg.get("mode") != "WALK"]
        if not rides:
            break
        i = rides[-1] if end == "last" else rides[0]
        ride = legs[i]
        a_pt, b_pt = _point(ride.get("from")), _point(ride.get("to"))
        if ride.get("duration", SHORT_RIDE_S) >= SHORT_RIDE_S or not a_pt or not b_pt or crow_m(a_pt, b_pt) > WALKABLE_RIDE_M:
            continue
        a = i - 1 if i > 0 and legs[i - 1].get("mode") == "WALK" else i
        b = i + 1 if i + 1 < len(legs) and legs[i + 1].get("mode") == "WALK" else i
        start_pt, end_pt = _point(legs[a].get("from")), _point(legs[b].get("to"))
        if not start_pt or not end_pt:
            continue
        walk_s = round(crow_m(start_pt, end_pt) * WALK_DETOUR / WALK_M_PER_S)
        if walk_s > WALK_INSTEAD_S:
            continue
        if b == len(legs) - 1 and (end == "last" or a != 0):  # to the destination: set off when you would have
            start = _when(legs[a]["startTime"])
            finish = start + timedelta(seconds=walk_s)
        elif a == 0:  # from the start: leave in time for the next ride
            finish = _when(legs[b]["endTime"])
            start = finish - timedelta(seconds=walk_s)
        else:
            continue
        if (arrive_by and finish > arrive_by) or (depart_at and start < depart_at):
            continue
        walk = {"mode": "WALK", "from": legs[a].get("from"), "to": legs[b].get("to"),
                "startTime": _iso(start), "endTime": _iso(finish), "duration": walk_s}
        legs = legs[:a] + [walk] + legs[b + 1:]
        changed = True
    if not changed:
        return it
    rides = sum(1 for leg in legs if leg.get("mode") != "WALK")
    begin, finish = _when(legs[0]["startTime"]), _when(legs[-1]["endTime"])
    return {**it, "legs": legs, "startTime": legs[0]["startTime"], "endTime": legs[-1]["endTime"],
            "duration": (finish - begin).total_seconds(), "transfers": max(0, rides - 1)}


def pick_journey(itineraries: list[dict], arrive_by=None, depart_at=None) -> dict | None:
    """The commute (see pick_itinerary and pick_departure). Short rides at either end are walked where that's
    close enough, and journeys still with a ride under 10 minutes only count if nothing else will do: we'd rather
    walk a few stops than wait for a tram to cover them."""
    pick = (lambda its: pick_itinerary(its, arrive_by)) if arrive_by else (lambda its: pick_departure(its, depart_at))
    itineraries = [walk_short_rides(i, arrive_by, depart_at) for i in itineraries]
    return pick([i for i in itineraries if not has_short_ride(i)]) or pick(itineraries)


def next_weekday_9am(now=None):
    """9am on the next weekday (never today, so there's a timetable to plan against), Melbourne time."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(MELBOURNE_TZ)
    day = (now or datetime.now(tz)).astimezone(tz).date() + timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return datetime(day.year, day.month, day.day, 9, 0, tzinfo=tz)


ARRIVAL_WINDOW_H = 3
# Buses are the last resort: a station up to a 30 minute walk away is preferred over a bus to it. These are
# Transitous's names for everything else that runs on a timetable (Melbourne's trains come back as SUBWAY).
NO_BUS_MODES = "RAIL,SUBWAY,TRAM,SUBURBAN,REGIONAL_RAIL,METRO"
WALK_INSTEAD_S = 30 * 60
BUS_WORTH_S = 20 * 60  # how much quicker a bus trip must be to be chosen over one without buses


def pick_itinerary(itineraries: list[dict], arrive_by) -> dict | None:
    """The journey arriving in the three hours before the time that leaves latest; else the first one arriving
    up to 90 minutes late; else none. Nothing leaving before 6am counts: that isn't a commute anyone would do (and
    the planner also offers journeys that arrive the evening before)."""
    from datetime import datetime, timedelta
    def when(t: str):
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    earliest = arrive_by - timedelta(hours=ARRIVAL_WINDOW_H)
    itineraries = [i for i in itineraries if when(i["startTime"]) >= earliest]
    on_time = [i for i in itineraries if earliest <= when(i["endTime"]) <= arrive_by]
    if on_time:
        return max(on_time, key=lambda i: (when(i["startTime"]), -i["duration"]))
    late = [i for i in itineraries if arrive_by < when(i["endTime"]) <= arrive_by + timedelta(minutes=90)]
    return min(late, key=lambda i: when(i["endTime"]), default=None)


def journey(it: dict) -> dict:
    """The parts of an itinerary worth keeping: times, transfers, and each leg in a line."""
    legs = []
    for leg in it["legs"]:
        mode = TRANSIT_MODES.get(leg.get("mode", ""), leg.get("mode", "").lower().replace("_", " "))
        legs.append({"mode": mode, "name": leg.get("routeShortName") or leg.get("displayName") or None,
                     "minutes": max(1, round(leg["duration"] / 60)), "at": leg.get("startTime"),
                     "from": (leg.get("from") or {}).get("name"), "to": (leg.get("to") or {}).get("name")})
    return {"depart_at": it["startTime"], "arrive_at": it["endTime"], "duration_s": round(it["duration"]),
            "transfers": it.get("transfers"), "legs": legs}


def bus_saving_s(trains: dict, any_way: dict, arriving: bool) -> float:
    """What taking a bus gains: going in, how much later you can leave and still be there by 9; coming home, how
    much sooner you're home. (Not the trip lengths: each trip is picked for when it leaves or arrives.)"""
    if arriving:
        return (_when(any_way["depart_at"]) - _when(trains["depart_at"])).total_seconds()
    return (_when(trains["arrive_at"]) - _when(any_way["arrive_at"])).total_seconds()


class Transitous:
    """The free community journey planner (transitous.org) over the published timetables. Fair use: one
    request every two seconds, and each journey is stored and only planned again after a fortnight."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._last = 0.0

    def plan(self, origin: tuple[float, float], target: tuple[float, float], arrive_by=None, depart_at=None) -> dict | None:
        """A journey arriving by `arrive_by`, or (for the trip home) leaving from `depart_at`. Without buses (walking up
        to 30 minutes at either end instead) unless a bus saves more than 20 minutes: a walk beats a bus to the
        station, but where the bus is the main part of the trip, going round by train isn't worth it."""
        trains = self._plan(origin, target, arrive_by, depart_at, no_bus=True)
        any_way = self._plan(origin, target, arrive_by, depart_at, no_bus=False)
        if trains and (any_way is None or bus_saving_s(trains, any_way, arrive_by is not None) <= BUS_WORTH_S):
            return trains
        return any_way

    def _plan(self, origin, target, arrive_by, depart_at, no_bus: bool) -> dict | None:
        wait = 2.0 - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        query = urlencode({"fromPlace": f"{origin[1]},{origin[0]}", "toPlace": f"{target[1]},{target[0]}",
                           "time": (arrive_by or depart_at).isoformat(), "arriveBy": "true" if arrive_by else "false",
                           # Enough journeys across two hours to find the one that leaves latest and still makes 9am
                           # (or gets home soonest after 5), not just the few the planner offers by default.
                           "numItineraries": 12, "searchWindow": 7200,
                           **({"transitModes": NO_BUS_MODES, "maxPreTransitTime": WALK_INSTEAD_S,
                               "maxPostTransitTime": WALK_INSTEAD_S} if no_bus else {})})
        try:
            with urlopen(Request(f"{self.base_url}/api/v1/plan?{query}", headers={"User-Agent": USER_AGENT}), timeout=60) as r:
                data = json.load(r)
        except HTTPError as e:
            if e.code in (400, 404, 422):
                return None  # no journey between these points
            raise
        its = data.get("itineraries") or []
        it = pick_journey(its, arrive_by=arrive_by, depart_at=depart_at)
        return journey(it) if it else None
