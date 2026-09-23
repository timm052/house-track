"""Everything a listing page says about a house, read from what the bookmarklet sends (PLAN.md D12).

The bookmarklet runs in your own browser on the listing page, so nothing is blocked. It sends the page's
own structured data rather than the whole page:
  • `next_data`  Domain's __NEXT_DATA__ JSON (address parts, rooms, land, price text, sale method,
                 auction/EOI dates, inspections, agents, photos, map position, Statement of Information);
  • `argonaut`   realestate.com.au's page data (read generically: untested against live pages);
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

from . import listing_parse

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


def _method(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    key = v.strip().lower()
    return METHODS.get(key) or METHODS.get(key.replace(" ", "")) or next((m for k, m in METHODS.items() if k in key), None)


def _photos(raw: str, listing_id: str | None) -> list[str]:
    """Full-size photo URLs in listing order. Domain's image names start with the listing id and the photo number,
    which also keeps out photos of the other listings the page shows."""
    seen: dict[int, str] = {}
    for m in re.finditer(r"https://bucket-api\.domain\.com\.au/v1/bucket/image/(\d+)_(\d+)_\d+_[\w-]+", raw):
        if listing_id is None or m[1] == listing_id:
            seen.setdefault(int(m[2]), m[0])
    if seen:
        return [seen[k] for k in sorted(seen)][:MAX_PHOTOS]
    # realestate.com.au and others: templated or plain image URLs under a media/images key
    urls = re.findall(r'"(?:templatedUrl|url|uri|src)"\s*:\s*"(https://i\d?\.realestate\.com\.au/[^"]+?)"', raw)
    out: list[str] = []
    for u in urls:
        u = u.replace("{size}", "1144x888-format=webp")
        if u not in out:
            out.append(u)
    return out[:MAX_PHOTOS]


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


def extract(url: str, html: str = "", next_data: str | None = None, argonaut: str | None = None,
            text: str | None = None, image: str | None = None, known_tags: list[str] | None = None) -> dict:
    """All the suggested quick-add fields, plus extras (agents, inspections, photos, map position, tags)."""
    out = listing_parse.parse(html + (f"<body>{text}</body>" if text else ""), url)
    trees: list[Any] = []
    for blob in (next_data, argonaut):
        if blob:
            try:
                trees.append(_prune(json.loads(blob)))
            except ValueError:
                pass
    tree: Any = trees
    raw = json.dumps(trees)  # only this listing's data, after pruning
    listing_id = (re.search(r"-(\d{7,12})(?:[/?#]|$)", url) or [None, None])[1]

    # Domain's component props carry the address in parts, which beats re-parsing a display string.
    props = next((n for _, n in _walk(tree) if "streetNumber" in n and "suburb" in n and "postcode" in n), None)
    if props:
        out["address_parts"] = {"unit": props.get("unitNumber") or None, "street_number": props.get("streetNumber") or None,
                                "street": props.get("street") or None, "suburb": props.get("suburb") or None,
                                "postcode": props.get("postcode") or None}
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

    # Domain's listing summary title ("EOI $1,050,000 - $1,155,000"), else a display price.
    price_text = next((n.get("title") for _, n in _walk(tree) if "stats" in n and isinstance(n.get("title"), str)), None) \
        or _first(tree, "displayPrice", "price", kind=str)
    if isinstance(price_text, str) and "$" in price_text:
        lo, hi = listing_parse.price_range(price_text)
        if lo:
            out["guide_low_aud"], out["guide_high_aud"] = lo, hi
        out["price_text"] = price_text.replace("|", " · ")
    method = _method(next((n.get("method") for _, n in _walk(tree) if "stats" in n and n.get("method")), None)
                     or _first(tree, "saleMethod", "method", kind=str))
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
    headline = _first(tree, "headline", kind=str)
    words = " ".join(x for x in (headline, description, text or "") if x)
    out["auction_at"] = auction if out.get("sale_method") == "auction" else None
    out["eoi_closes_at"] = _eoi_from_text(words) if out.get("sale_method") == "eoi" else None
    out["listed_on"] = (_local(_first(tree, "dateCreated", "firstListedDate", "createdOn", kind=(str, dict))) or "")[:10] or None
    out["headline"] = headline
    out["description"] = description.strip()[:4000] if isinstance(description, str) else None

    lat, lon = _first(tree, "latitude", "lat", kind=(int, float)), _first(tree, "longitude", "lng", "lon", kind=(int, float))
    out["lat"], out["lon"] = (lat, lon) if lat and lon and -45 < lat < -9 and 110 < lon < 155 else (None, None)
    out["agents"] = _agents(tree)
    agency = _first(tree, "agencyName", kind=str)
    for a in out["agents"]:
        a["agency_name"] = agency
    out["inspections"] = _inspections(tree)
    soi = re.search(r'"(https://[^"]*(?:soi|statement[-_]?of[-_]?information)[^"]*\.pdf)"', raw, re.I)
    out["soi_url"] = soi[1] if soi else None
    out["photos"] = _photos(raw, listing_id)
    out["image_url"] = out.get("image_url") or image or (out["photos"][0] if out["photos"] else None)
    if out["image_url"] and out["photos"] and out["image_url"] not in out["photos"]:
        out["photos"] = [out["image_url"], *out["photos"]][:MAX_PHOTOS]
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
    return out
