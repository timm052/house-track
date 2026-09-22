"""Best-effort reading of a listing page into quick-add fields (PLAN.md D12).

⚠ Fragile by design: it reads whatever structured data the page happens to carry (JSON-LD, Open Graph
tags) and falls back to patterns in the visible text. Portal markup changes will break parts of it;
every field it returns is a suggestion the person confirms on the quick-add form, never saved directly.
"""

import html
import json
import re
from typing import Any

from .listing import clean_url, recognise

_JSONLD = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)
_META = re.compile(r'<meta[^>]+(?:property|name)=["\']([^"\']+)["\'][^>]+content=["\']([^"\']*)["\']', re.I)
_TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_TAGS = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)
_MONEY = r"\$\s?(\d[\d,.]*)\s*(k|m|million)?"
_RANGE = re.compile(_MONEY + r"\s*(?:-|–|to)\s*" + _MONEY, re.I)
_SINGLE = re.compile(_MONEY, re.I)


def _amount(num: str, suffix: str | None) -> int | None:
    try:
        n = float(num.replace(",", ""))
    except ValueError:
        return None
    mult = {"k": 1_000, "m": 1_000_000, "million": 1_000_000}.get((suffix or "").lower(), 1)
    n *= mult
    return int(n) if 50_000 <= n <= 50_000_000 else None


def price_range(text: str) -> tuple[int | None, int | None]:
    m = _RANGE.search(text)
    if m:
        lo, hi = _amount(m[1], m[2]), _amount(m[3], m[4] or m[2])
        if lo and hi and hi >= lo:
            return lo, hi
    for m in _SINGLE.finditer(text):
        v = _amount(m[1], m[2])
        if v:
            return v, v
    return None, None


def _walk(obj: Any):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def _count(text: str, words: str) -> int | None:
    m = re.search(rf"(\d{{1,2}})\s*(?:{words})\b", text, re.I) or re.search(rf"(?:{words})\s*:?\s*(\d{{1,2}})\b", text, re.I)
    return int(m[1]) if m else None


def parse(page: str, url: str | None = None) -> dict:
    """Returns suggested quick-add fields; any may be None."""
    out: dict[str, Any] = {"url": clean_url(url) if url else None}
    metas = {k.lower(): html.unescape(v) for k, v in _META.findall(page)}
    title = html.unescape((_TITLE.search(page) or [None, ""])[1]).strip()

    # 1. Structured data.
    for block in _JSONLD.findall(page):
        try:
            data = json.loads(block.strip())
        except ValueError:
            continue
        for node in _walk(data):
            addr = node.get("address")
            if isinstance(addr, dict) and addr.get("streetAddress") and not out.get("address"):
                rest = " ".join(str(addr[k]) for k in ("addressLocality", "addressRegion", "postalCode") if addr.get(k))
                out["address"] = f"{addr['streetAddress']}, {rest}".strip(", ")
            for key, field in (("numberOfBedrooms", "beds"), ("numberOfRooms", "beds"), ("numberOfBathroomsTotal", "baths"),
                               ("numberOfBathrooms", "baths")):
                if key in node and out.get(field) is None:
                    try:
                        out[field] = int(float(str(node[key])))
                    except ValueError:
                        pass

    # 2. Visible text.
    text = html.unescape(re.sub(r"\s+", " ", _TAGS.sub(" ", page)))
    if not out.get("address"):
        candidate = metas.get("og:title") or title
        m = re.search(r"(\d[\w/-]*\s+[A-Za-z' ]+?(?:Street|St|Road|Rd|Avenue|Ave|Court|Ct|Drive|Dr|Crescent|Cres|Parade|Pde|Place|Pl|Grove|Gr|Lane|Way|Close|Terrace|Boulevard|Highway|Hwy)\b.*?\d{4})", candidate, re.I)
        out["address"] = m[1].strip() if m else None
    out.setdefault("beds", None)
    out.setdefault("baths", None)
    if out["beds"] is None:
        out["beds"] = _count(text, "beds?|bedrooms?|bd")
    if out["baths"] is None:
        out["baths"] = _count(text, "baths?|bathrooms?|ba")
    out["car_spaces"] = _count(text, "parking|cars?|car spaces?|garages?")
    land = re.search(r"(?:land(?: size| area)?\s*:?\s*)?(\d[\d,]{1,6})\s?(?:m²|m2|sqm)", text, re.I)
    out["land_m2"] = int(land[1].replace(",", "")) if land else None

    lowered = text.lower()
    method = "auction" if "auction" in lowered else "eoi" if ("expressions of interest" in lowered or " eoi" in lowered) else None
    out["sale_method"] = method or ("private_sale" if lowered.count("$") else None)
    price_text = metas.get("og:description", "") + " " + text[:20000]
    out["guide_low_aud"], out["guide_high_aud"] = price_range(price_text)
    if url:
        out["portal"] = recognise(clean_url(url))[0]
    return out
