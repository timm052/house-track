"""Everything a listing page says about a house, read from what the bookmarklet sends (PLAN.md D12).

The bookmarklet runs in your own browser on the listing page, so nothing is blocked. It sends the page's
own structured data rather than the whole page:
  • `next_data`  Domain's __NEXT_DATA__ JSON (address parts, rooms, land, price text, sale method,
                 auction/EOI dates, inspections, agents, photos, map position, Statement of Information);
  • `argonaut`   realestate.com.au's page data (read generically: untested against live pages), and `page_state`,
                 whatever other page-state object the page keeps (__INITIAL_STATE__ and the like), for sites we know
                 less about. Either may hold JSON inside a string, which is unpacked before reading;
  • `html`       the page head (Open Graph tags) plus JSON-LD blocks;
  • `text`       the visible text, for the text fallbacks in listing_parse.

⚠ Still fragile by design: portals change their data without notice. Every field is a suggestion the person
confirms on the quick-add form; nothing here is saved without them seeing it first.
"""

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from urllib.parse import urlsplit

from . import listing_parse, listing_text

MELBOURNE = ZoneInfo("Australia/Melbourne")
MAX_PHOTOS = 30

PROPERTY_TYPES = {  # portal wording -> ours
    "house": "house", "free standing": "house", "freestanding": "house", "semi detached": "townhouse",
    "semi-detached": "townhouse", "duplex": "townhouse", "terrace": "townhouse", "townhouse": "townhouse", "villa": "unit",
    "unit": "unit", "apartment": "apartment", "apartment / unit / flat": "apartment", "flat": "apartment", "studio": "apartment",
    "land": "land", "vacant land": "land", "acreage": "land", "new land": "land", "new apartments": "apartment",
}
METHODS = {"auction": "auction", "privatetreaty": "private_sale", "private treaty": "private_sale", "private sale": "private_sale",
           "expressionofinterest": "eoi", "expressions of interest": "eoi", "eoi": "eoi", "tender": "other"}

# Words in the headline, features or description that suggest a tag. Existing tags that appear there are offered too.
TAG_HINTS = {
    "pool": r"\b(swimming )?pool\b", "garage": r"\bgarage\b", "renovated": r"\b(fully |newly )?renovated\b",
    "renovator": r"\brenovator|potential\b|\bneeds work\b|\boriginal condition\b", "north-facing": r"\bnorth[- ]facing\b|\bnortherly\b",
    "corner block": r"\bcorner (block|allotment|site)\b", "development": r"\bdevelopment (potential|site|opportunity)|subdivi",
    "character": r"\bcharacter\b|\bperiod\b|\bedwardian|\bvictorian\b|\bart deco\b|\bweatherboard\b", "solar": r"\bsolar\b",
    "study": r"\bstudy\b|\bhome office\b", "fireplace": r"\bfireplace\b", "deck": r"\bdeck(ing)?\b", "garden": r"\bgarden\b",
    "ensuite": r"\bensuite\b", "air conditioning": r"\bair[- ]?con|split system|reverse cycle|evaporative cooling\b",
    "heritage": r"\bheritage\b", "walk to station": r"\bwalk to .{0,30}station\b|\bstation .{0,20}(walk|stroll)\b",
}


# Parts of Domain's page data that describe *other* listings or the area, not this house.
SKIP = {"listingsMap", "otherListingsIds", "jsonLdItems", "otherProjects", "neighbourhoodInsights", "suburbInsights",
        "whatIsNearby", "locationProfileCards", "schoolCatchment", "similarListings", "recommendations", "nearbyListings"}


def _prune(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _prune(v) for k, v in obj.items() if k not in SKIP}
    if isinstance(obj, list):
        return [_prune(v) for v in obj]
    return obj


SCRIPT_BREAK = "\n/*--script--*/\n"   # what the bookmarklet puts between script tags it sends whole


def _load(blob: str) -> list[Any]:
    """The JSON in what the bookmarklet sent: plain JSON, or the text of a script tag (`window.ArgonautExchange={...};`),
    where the first value after the `=` is read and whatever follows it is ignored. Several scripts come as several."""
    out: list[Any] = []
    for part in blob.split(SCRIPT_BREAK):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(json.loads(part))
            continue
        except ValueError:
            pass
        m = re.search(r"=\s*([{\[])", part)
        start = m.start(1) if m else part.find("{")
        if start < 0:
            continue
        try:
            out.append(json.JSONDecoder().raw_decode(part[start:])[0])
        except ValueError:
            pass
    return out


def _unwrap(obj: Any, depth: int = 0) -> Any:
    """Page data often keeps JSON inside a string (realestate.com.au's urqlClientCache is one, with more inside it).
    Unpack those, a few levels down, so the rest of the reading sees the real structure."""
    if depth > 4:
        return obj
    if isinstance(obj, dict):
        return {k: _unwrap(v, depth) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_unwrap(v, depth) for v in obj]
    if isinstance(obj, str) and len(obj) > 40 and obj.lstrip()[:1] in "{[":
        try:
            return _unwrap(json.loads(obj), depth + 1)
        except ValueError:
            return obj
    return obj


def _address_parts(tree: Any) -> dict | None:
    """The address as parts from a node that has a street line, suburb and postcode (realestate.com.au's address):
    {"streetAddress": "3/12 Smith Street", "suburb": "Box Hill", "postcode": "3128"}, or the street in display.shortAddress."""
    from .address import parse
    for _, n in _walk(tree):
        suburb, postcode = n.get("suburb"), n.get("postcode")
        display = n.get("display") if isinstance(n.get("display"), dict) else {}
        street = n.get("streetAddress") or display.get("shortAddress")
        if not (isinstance(suburb, str) and isinstance(street, str) and street.strip() and postcode and re.fullmatch(r"\d{4}", str(postcode))):
            continue
        a = parse(f"{street.strip()}, {suburb} {n.get('state') or 'VIC'} {postcode}")
        if a and a.street and a.suburb:
            return {"unit": a.unit, "street_number": a.street_number, "street": a.street, "suburb": a.suburb, "postcode": a.postcode}
    return None


def _rea_listing(tree: Any) -> dict | None:
    """The listing in realestate.com.au's page data (details.listing): the node with generalFeatures and an address."""
    for _, n in _walk(tree):
        if isinstance(n.get("generalFeatures"), dict) and isinstance(n.get("address"), dict):
            return n
    return None


def _val(v: Any) -> Any:
    return v.get("value") if isinstance(v, dict) else v


def _size_m2(size: Any) -> int | None:
    """realestate.com.au's {"displayValue": "612", "sizeUnit": {"displayValue": "m²"}} (or just text), in square metres."""
    if not isinstance(size, dict):
        return _area_m2(size)
    unit = size.get("sizeUnit")
    unit = unit.get("displayValue") if isinstance(unit, dict) else unit
    shown = size.get("displayValue") if size.get("displayValue") is not None else size.get("value")
    if shown is None:
        return None
    return (_area_m2(f"{shown} {unit}") if unit else None) or _area_m2(shown)


def _plain(html_text: str) -> str:
    """A description's HTML as plain text: line breaks kept, tags dropped, entities decoded."""
    import html
    text = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</div>", "\n", html_text)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"[ \t]*\n[ \t]*", "\n", re.sub(r"[ \t]+", " ", text)).strip()


def _walk(obj: Any, path: tuple = ()):
    """Every dict in the tree with the key path that reached it."""
    if isinstance(obj, dict):
        yield path, obj
        for k, v in obj.items():
            yield from _walk(v, path + (k,))
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, path)


def _first(tree: Any, *keys: str, kind: type | tuple = (int, float, str)) -> Any:
    for _, node in _walk(tree):
        for k in keys:
            v = node.get(k)
            if isinstance(v, kind) and v not in ("", None) and not isinstance(v, bool):
                return v
    return None


def _int(v: Any) -> int | None:
    if v is None:
        return None
    m = re.search(r"\d[\d,]*(?:\.\d+)?", str(v))
    try:
        return int(float(m[0].replace(",", ""))) if m else None
    except ValueError:
        return None


AREA_UNITS = {"ha": 10_000, "hectare": 10_000, "hectares": 10_000, "acre": 4046.86, "acres": 4046.86, "ac": 4046.86,
              "m²": 1, "m2": 1, "sqm": 1, "m": 1, "": 1}


def _area_m2(v: Any) -> int | None:
    """An area in square metres from a number or text with a unit: 652, "652m²", "2.69 acre", "1.2 ha"."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return round(v)
    m = re.fullmatch(r"\s*(\d[\d,]*(?:\.\d+)?)\s*([a-z²2]*)\.?\s*", str(v or "").lower())
    if not m or m[2] not in AREA_UNITS:
        return None
    return round(float(m[1].replace(",", "")) * AREA_UNITS[m[2]])


def _local(iso: Any) -> str | None:
    """Portal times are Melbourne wall-clock without an offset; return an aware ISO string."""
    if isinstance(iso, dict):
        iso = iso.get("isoDate") or iso.get("dateTime") or iso.get("value")
    if not isinstance(iso, str) or not re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", iso):
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=MELBOURNE)).isoformat()


def _date(v: Any) -> str | None:
    """The Melbourne calendar date of a portal time (a UTC one can be the day before), or a plain date as given."""
    iso = _local(v)
    if iso:
        return datetime.fromisoformat(iso).astimezone(MELBOURNE).date().isoformat()
    return v if isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v) else None


def _method(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    key = v.strip().lower()
    return METHODS.get(key) or METHODS.get(key.replace(" ", "")) or next((m for k, m in METHODS.items() if k in key), None)


BUCKET = "https://bucket-api.domain.com.au/v1/bucket/image/"
REA_CDN = re.compile(r"^https://i\d?\.(?:au\.reastatic\.net|realestate\.com\.au)/")   # realestate.com.au's images


def _bucket(url: str) -> str | None:
    """Domain's resized image URL -> the full-size original ("…/fit-in/1920x1080/filters:…/2020775315_4_1_…-w2000-h1500"
    -> bucket-api/…/2020775315_4_1_…-w2000-h1500)."""
    if url.startswith(BUCKET):
        return url
    if "domainstatic.com.au" in url:
        name = url.rstrip("/").rsplit("/", 1)[-1]
        if re.match(r"\d+_\d+_\d+_", name):
            return BUCKET + name
    return None


def _media(tree: Any, raw: str, listing_id: str | None) -> tuple[list[str], list[str]]:
    """(photos, floor plans) as full-size URLs, in the listing's own gallery order. Domain lists them in the listing's
    largeMedia ([{url, type: photo|floorplan|video}]); failing that, image names start with the listing id and photo
    number, which also keeps out photos of other listings the page shows. Floor plan images are named …_<n>_3_…."""
    photos: list[str] = []
    plans: list[str] = []
    for _, n in _walk(tree):
        media = n.get("largeMedia") or n.get("media")
        if not isinstance(media, list) or not media or not all(isinstance(m, dict) for m in media):
            continue
        for m in media:
            kind, url = str(m.get("type") or m.get("category") or "").lower(), m.get("url")
            if not isinstance(url, str) or kind not in ("photo", "image", "floorplan", "floor_plan"):
                continue
            full = _bucket(url) or url
            if listing_id and full.startswith(BUCKET) and not full[len(BUCKET):].startswith(listing_id + "_"):
                continue
            target = plans if "floor" in kind else photos
            if full not in target:
                target.append(full)
        if photos or plans:
            return photos[:MAX_PHOTOS], plans[:5]

    seen: dict[int, str] = {}
    for m in re.finditer(r"https://bucket-api\.domain\.com\.au/v1/bucket/image/(\d+)_(\d+)_(\d+)_[\w-]+", raw):
        if listing_id is None or m[1] == listing_id:
            if m[3] == "3":
                if m[0] not in plans:
                    plans.append(m[0])
            else:
                seen.setdefault(int(m[2]), m[0])
    if seen or plans:
        return [seen[k] for k in sorted(seen)][:MAX_PHOTOS], plans[:5]
    # realestate.com.au: images on its own CDN, usually as a template with a {size} to fill in; anything under a
    # floor plan key is a plan, the rest are photos (in the order the page lists them).
    for path, n in _walk(tree):
        for key in ("templatedUrl", "url", "uri", "src"):
            u = n.get(key)
            if isinstance(u, str) and (REA_CDN.match(u) or (key == "templatedUrl" and u.startswith("https://"))):
                u = u.replace("{size}", "1144x888-format=webp")
                target = plans if any("floor" in str(k).lower() for k in path) else photos
                if u not in target:
                    target.append(u)
                break
    return photos[:MAX_PHOTOS], plans[:5]


def _agents(tree: Any) -> list[dict]:
    out: list[dict] = []
    for path, node in _walk(tree):
        if "agent" not in "/".join(map(str, path)).lower() and "lister" not in "/".join(map(str, path)).lower():
            continue
        name = node.get("name") or node.get("fullName") or " ".join(x for x in (node.get("firstName"), node.get("lastName")) if x)
        phones = [node.get(k) for k in ("mobile", "mobileNumber", "phone", "phoneNumber")]
        mobile = next((p for p in phones if isinstance(p, str) and p.strip()), None)
        if isinstance(p := node.get("phoneNumber"), dict):
            mobile = mobile or p.get("display")
        if isinstance(name, str) and name.strip() and (mobile or node.get("email")) and name not in {a["name"] for a in out}:
            out.append({"name": name.strip(), "mobile": mobile, "email": node.get("email") or None})
    return out[:4]


def _inspections(tree: Any) -> list[dict]:
    out: list[dict] = []
    for _, node in _walk(tree):
        start = _local(node.get("openingDateTime") or node.get("startTime"))
        end = _local(node.get("closingDateTime") or node.get("endTime"))
        if start and end and {"starts_at": start, "ends_at": end} not in out:
            out.append({"starts_at": start, "ends_at": end})
    now = datetime.now(MELBOURNE).isoformat()
    return sorted((i for i in out if i["ends_at"] >= now), key=lambda i: i["starts_at"])[:10]


def _eoi_from_text(text: str) -> str | None:
    """'Expressions of Interest Closing Tuesday, 20th October 5pm' -> an aware datetime."""
    m = re.search(r"(?:expressions? of interest|eoi)[^.\n]{0,40}?clos\w*[^.\n]{0,15}?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Z][a-z]+)"
                  r"(?:\s+(\d{4}))?[^.\n]{0,12}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)", text, re.I)
    if not m:
        return None
    now = datetime.now(MELBOURNE)
    try:
        month = datetime.strptime(m[2][:3], "%b").month
    except ValueError:
        return None
    hour = int(m[4]) % 12 + (12 if m[6].lower() == "pm" else 0)
    year = int(m[3]) if m[3] else now.year + (1 if month < now.month - 1 else 0)
    try:
        return datetime(year, month, int(m[1]), hour, int(m[5] or 0), tzinfo=MELBOURNE).isoformat()
    except ValueError:
        return None


def _tags(text: str, known: list[str]) -> list[str]:
    lowered = text.lower()
    out = [t for t, rx in TAG_HINTS.items() if re.search(rx, lowered)]
    out += [k for k in known if len(k) > 2 and re.search(rf"\b{re.escape(k.lower())}\b", lowered) and k.lower() not in out]
    return out[:12]


TEXT_FIELDS = ("beds", "baths", "car_spaces", "land_m2", "building_m2", "property_type", "headline", "description", "listed_on",
               "listing_status", "sale_method", "auction_at", "price_text", "guide_low_aud", "guide_high_aud")


def _apply_text(out: dict, got: dict, structured: bool) -> None:
    """What the text readers found goes over the generic readers' guesses. When the page's own structured data was read,
    it wins: the text only fills in what that left empty."""
    if got.get("price_known") is False and not structured:
        for k in ("guide_low_aud", "guide_high_aud", "price_text"):
            out.pop(k, None)   # a page that shows no price: the generic readers' guess ("mid $800,000s") isn't one
    for k in TEXT_FIELDS:
        if got.get(k) is not None and (not structured or out.get(k) is None):
            out[k] = got[k]
    for k in ("agents", "inspections", "features"):
        if got.get(k) and not out.get(k):
            out[k] = got[k]
    if got.get("building_m2") and out.get("land_m2") == out.get("building_m2") and got.get("land_m2") is None:
        out["land_m2"] = None   # an apartment's one area is the building, not a lot the generic reader guessed
    if got.get("sale_method") is None and not structured:
        out.pop("sale_method", None)   # no sale method on the page: the generic guess ("private sale") isn't one


def extract(url: str, html: str = "", next_data: str | None = None, argonaut: str | None = None,
            text: str | None = None, image: str | None = None, known_tags: list[str] | None = None,
            page_state: str | None = None) -> dict:
    """All the suggested quick-add fields, plus extras (agents, inspections, photos, map position, tags)."""
    out = listing_parse.parse(html + (f"<body>{text}</body>" if text else ""), url)
    trees: list[Any] = []
    for blob in (next_data, argonaut, page_state):
        for data in _load(blob) if blob else []:
            trees.append(_prune(_unwrap(data)))
    tree: Any = trees
    raw = json.dumps(trees)  # only this listing's data, after pruning
    listing_id = (re.search(r"-(\d{7,12})(?:[/?#]|$)", url) or [None, None])[1]

    # Domain's component props carry the address in parts, which beats re-parsing a display string.
    props = next((n for _, n in _walk(tree) if "streetNumber" in n and "suburb" in n and "postcode" in n), None)
    if props:
        # As text: some pages (sold listings among them) give the number or postcode as a number.
        part = lambda k: str(props[k]).strip() or None if props.get(k) not in (None, "") else None  # noqa: E731
        out["address_parts"] = {"unit": part("unitNumber"), "street_number": part("streetNumber"), "street": part("street"),
                                "suburb": part("suburb"), "postcode": part("postcode")}
    if not props and (found := _address_parts(tree)):
        out["address_parts"] = found
    for field, keys in (("beds", ("beds", "bedrooms")), ("baths", ("baths", "bathrooms")),
                        ("car_spaces", ("parking", "parkingSpaces", "carspaces", "garages"))):
        v = _first(tree, *keys, kind=(int, float, str))
        if (n := _int(v)) is not None and n <= 50:
            out[field] = n
    # Domain gives land in square metres as a number (landAreaSqm, landArea, the stats' landArea); landSize is
    # display text in the agent's unit ("2.69 acre"), so it's only a fallback, read with its unit.
    land = (_first(tree, "landAreaSqm", "landArea", kind=(int, float))
            or next((s.get("value") for _, s in _walk(tree) if s.get("key") == "landArea"), None))
    n = round(land) if isinstance(land, (int, float)) else _area_m2(_first(tree, "landSize", "landArea"))
    if n and 20 <= n <= 5_000_000:
        out["land_m2"] = n
    if (n := _int(_first(tree, "buildingArea", "buildingSize"))) and 10 <= n <= 100_000:
        out["building_m2"] = n
    ptype = _first(tree, "primaryPropertyType", "propertyType", kind=str)
    out["property_type"] = PROPERTY_TYPES.get(ptype.strip().lower()) if isinstance(ptype, str) else None
    # realestate.com.au keeps its figures in nested objects (generalFeatures.bedrooms.value, propertySizes.land...).
    rea = _rea_listing(tree)
    if rea:
        for field, key in (("beds", "bedrooms"), ("baths", "bathrooms"), ("car_spaces", "parkingSpaces")):
            if (n := _int(_val(rea["generalFeatures"].get(key)))) is not None and n <= 50:
                out[field] = n
        sizes = rea.get("propertySizes") if isinstance(rea.get("propertySizes"), dict) else {}
        if (n := _size_m2(sizes.get("land"))) and 20 <= n <= 5_000_000:
            out["land_m2"] = n
        if (n := _size_m2(sizes.get("building"))) and 10 <= n <= 100_000:
            out["building_m2"] = n
        kind = rea.get("propertyType")
        kind = kind.get("display") if isinstance(kind, dict) else kind
        if isinstance(kind, str) and (mapped := PROPERTY_TYPES.get(kind.strip().lower())):
            out["property_type"] = mapped

    # Domain's listing summary title ("EOI $1,050,000 - $1,155,000"), else a display price.
    price_text = next((n.get("title") for _, n in _walk(tree) if "stats" in n and isinstance(n.get("title"), str)), None) \
        or next((p["display"] for _, n in _walk(tree) if isinstance(p := n.get("price"), dict) and isinstance(p.get("display"), str)), None) \
        or _first(tree, "displayPrice", "price", kind=str)
    if isinstance(price_text, str) and "$" in price_text:
        lo, hi = listing_parse.price_range(price_text)
        if lo:
            out["guide_low_aud"], out["guide_high_aud"] = lo, hi
        out["price_text"] = price_text.replace("|", " · ")
    method = _method(next((n.get("method") for _, n in _walk(tree) if "stats" in n and n.get("method")), None)
                     or _first(tree, "saleMethod", "method", kind=str))
    if not method and rea and isinstance(rea.get("auction"), dict) and rea["auction"]:
        method = "auction"   # realestate.com.au: an auction object on the listing
    if isinstance(price_text, str) and re.search(r"\bEOI\b|expressions? of interest", price_text, re.I):
        method = "eoi"
    if method:
        out["sale_method"] = method

    auction = next((_local(n["auctionSchedule"].get("openingDateTime")) for _, n in _walk(tree)
                    if isinstance(n.get("auctionSchedule"), dict)), None)
    auction = auction or next((_local(n.get("dateTime") or n.get("date")) for p, n in _walk(tree) if p and "auction" in str(p[-1]).lower()), None)
    description = _first(tree, "description", kind=(str, list))
    if isinstance(description, list):
        description = "\n".join(str(x) for x in description)
    if isinstance(description, str) and "<" in description:
        description = _plain(description)
    headline = _first(tree, "headline", kind=str)
    words = " ".join(x for x in (headline, description, text or "") if x)
    out["auction_at"] = auction if out.get("sale_method") == "auction" else None
    out["eoi_closes_at"] = _eoi_from_text(words) if out.get("sale_method") == "eoi" else None
    out["listed_on"] = _date(_first(tree, "dateCreated", "firstListedDate", "createdOn", kind=(str, dict)))
    out["headline"] = headline
    out["description"] = description.strip()[:4000] if isinstance(description, str) else None

    lat, lon = _first(tree, "latitude", "lat", kind=(int, float)), _first(tree, "longitude", "lng", "lon", kind=(int, float))
    out["lat"], out["lon"] = (lat, lon) if lat and lon and -45 < lat < -9 and 110 < lon < 155 else (None, None)
    out["agents"] = _agents(tree)
    company = rea.get("listingCompany") if rea and isinstance(rea.get("listingCompany"), dict) else {}
    agency = _first(tree, "agencyName", kind=str) or (company.get("name") if isinstance(company.get("name"), str) else None)
    for a in out["agents"]:
        a["agency_name"] = agency
    out["inspections"] = _inspections(tree)
    soi = re.search(r'"(https://[^"]*(?:soi|statement[-_]?of[-_]?information)[^"]*\.pdf)"', raw, re.I)
    out["soi_url"] = soi[1] if soi else None
    out["photos"], out["floorplans"] = _media(tree, raw, listing_id)
    # The gallery's first photo is the listing's main one; the page's og:image is only a fallback.
    out["image_url"] = (out["photos"][0] if out["photos"] else None) or out.get("image_url") or image
    if out["image_url"] and not out["photos"]:
        out["photos"] = [out["image_url"]]
    features = [f.get("name") if isinstance(f, dict) else f for _, n in _walk(tree) for k in ("features", "structuredFeatures")
                for f in (n.get(k) if isinstance(n.get(k), list) else [])]
    out["features"] = [f for f in dict.fromkeys(features) if isinstance(f, str)][:30]
    out["suggested_tags"] = _tags(" ".join([words, *out["features"]]), known_tags or [])
    status = next((n.get("status") for _, n in _walk(tree) if "stats" in n and isinstance(n.get("status"), str)), None)
    archived = any(n.get("isArchived") is True for _, n in _walk(tree))
    out["listing_status"] = "archived" if archived else status
    # A sold listing's price line is the sale price ("Sold for $1,250,000"), not a new guide.
    sold = (status or "").lower() == "sold" or re.match(r"\s*sold\b", out.get("price_text") or "", re.I)
    if sold:
        out["listing_status"] = "sold"
        out["sold_price_aud"] = out.pop("guide_low_aud", None) if out.get("guide_low_aud") == out.get("guide_high_aud") else None
        out.pop("guide_low_aud", None)
        out.pop("guide_high_aud", None)
    # The two REA Group sites keep their listing out of the bookmarklet's reach, so what is on screen is read instead.
    host = (urlsplit(url).hostname or "").removeprefix("www.")
    reader = {"realestate.com.au": listing_text.realestate, "property.com.au": listing_text.property_com_au}.get(host)
    if host == "realestate.com.au" and not out.get("address_parts") and (found := listing_text.ld_address(html)):
        out["address_parts"] = found
    if reader and text:
        _apply_text(out, reader(text, html), structured=bool(rea))
        # Tags from the listing's own words, not the whole page (its menus and boilerplate say "heritage" and "pool" too).
        out["suggested_tags"] = _tags(" ".join(x for x in (out.get("headline"), out.get("description"), *(out.get("features") or [])) if x), known_tags or [])
    return out
