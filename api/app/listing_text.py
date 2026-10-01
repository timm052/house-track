"""Reading realestate.com.au and property.com.au listings from what a person can see on the page.

Both sites keep their listing data out of reach of the bookmarklet (realestate.com.au empties its page-data global once
it starts, and property.com.au keeps nothing the button can read), so what's left is the page itself: its address in the
head's structured data, and its visible text, which is laid out the same way every time. These readers work from that
text, line by line, as captured on real pages on 1 Oct 2026, and each says nothing about a field it can't find (the caller
keeps what the generic readers guessed only where these have nothing to say).

⚠ Fragile by nature: the sites change their pages without notice. Every field is a suggestion the person confirms.
"""

import json
import re
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

MELBOURNE = ZoneInfo("Australia/Melbourne")
KINDS = {"house": "house", "townhouse": "townhouse", "unit": "unit", "apartment": "apartment", "villa": "unit", "duplex": "townhouse",
         "terrace": "townhouse", "semi-detached": "townhouse", "land": "land", "acreage": "land", "rural": "land", "studio": "apartment",
         "block of units": "apartment", "retirement living": "unit"}
MONTHS = {m: i for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
DAYS = r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*"
MONEY = r"\$\s?[\d,]+(?:\.\d+)?\s*[mMkK]?"
AREA = re.compile(r"^(\d[\d,]*(?:\.\d+)?)\s*(m²|m2|sqm|ha)$", re.I)


def lines_of(text: str) -> list[str]:
    return [ln.strip() for ln in (text or "").replace("\r", "").split("\n") if ln.strip()]


def _area_m2(token: str) -> int | None:
    m = AREA.match(token.strip())
    if not m:
        return None
    n = float(m[1].replace(",", ""))
    return round(n * 10_000) if m[2].lower() == "ha" else round(n)


def _money(s: str) -> int | None:
    m = re.fullmatch(r"\$\s?([\d,]+(?:\.\d+)?)\s*([mMkK]?)", s.strip())
    if not m:
        return None
    n = float(m[1].replace(",", ""))
    return round(n * {"m": 1_000_000, "k": 1_000}.get(m[2].lower(), 1))


def _price_range(s: str) -> tuple[int | None, int | None]:
    """"$590,000 - $620,000", "Offers From $849,000", "$5.5m" -> (low, high); one number gives both."""
    nums = [n for n in (_money(x) for x in re.findall(MONEY, s)) if n]
    if not nums:
        return None, None
    return min(nums), max(nums)


def _melbourne_date(day: int, month: int, today: date | None = None) -> date | None:
    """The next day (this year or next) that is that day of that month."""
    today = today or datetime.now(MELBOURNE).date()
    for year in (today.year, today.year + 1):
        try:
            d = date(year, month, day)
        except ValueError:
            return None
        if d >= today:
            return d
    return None


def _clock(h: str, mm: str | None, meridiem: str) -> tuple[int, int]:
    hour = int(h) % 12 + (12 if meridiem.lower() == "pm" else 0)
    return hour, int(mm or 0)


def _times(day: date, start: tuple, end: tuple) -> dict:
    s = datetime(day.year, day.month, day.day, *start, tzinfo=MELBOURNE)
    e = datetime(day.year, day.month, day.day, *end, tzinfo=MELBOURNE)
    return {"starts_at": s.isoformat(), "ends_at": e.isoformat()}


def _inspections(lines: list[str], today: date | None = None) -> list[dict]:
    """realestate.com.au's inspections section: a date line ("Tuesday 6 October") followed by "From 12:30–1:00 pm"."""
    out: list[dict] = []
    for i, ln in enumerate(lines):
        d = re.fullmatch(rf"{DAYS},?\s+(\d{{1,2}})\s+([A-Za-z]{{3,9}})(?:\s+\d{{4}})?", ln)
        if not d or d[2][:3].lower() not in MONTHS or i + 1 >= len(lines):
            continue
        t = re.fullmatch(r"(?:From\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—–�]+\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)", lines[i + 1], re.I)
        day = _melbourne_date(int(d[1]), MONTHS[d[2][:3].lower()], today)
        if not t or not day:
            continue
        end = _clock(t[4], t[5], t[6])
        start = _clock(t[1], t[2], t[3] or t[6])
        if start > end and not t[3]:     # "11:30–12:00 pm": the start is in the morning
            start = _clock(t[1], t[2], "am")
        if start < end and {"starts_at": _times(day, start, end)["starts_at"]} not in [{"starts_at": o["starts_at"]} for o in out]:
            out.append(_times(day, start, end))
    return out[:10]


def ld_address(html: str) -> dict | None:
    """The address from the head's structured data (schema.org Residence/House with a PostalAddress), as parts."""
    from .address import parse
    for block in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html or "", re.S | re.I):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        for node in data if isinstance(data, list) else [data]:
            addr = node.get("address") if isinstance(node, dict) else None
            if not isinstance(addr, dict) or not addr.get("streetAddress") or not addr.get("addressLocality"):
                continue
            a = parse(f"{addr['streetAddress']}, {addr['addressLocality']} {addr.get('addressRegion') or 'VIC'} {addr.get('postalCode') or ''}".strip())
            if a and a.street and a.suburb:
                return {"unit": a.unit, "street_number": a.street_number, "street": a.street, "suburb": a.suburb, "postcode": a.postcode}
    return None


def _kind_index(lines: list[str], start: int, stop: int) -> int | None:
    for i in range(start, min(stop, len(lines))):
        if lines[i].lower() in KINDS:
            return i
    return None


def _header_figures(lines: list[str], i: int) -> tuple[list[int], list[int]]:
    """The run of whole numbers (beds, baths, cars) and then areas that follows a point in the header."""
    nums: list[int] = []
    areas: list[int] = []
    for ln in lines[i:i + 8]:
        if re.fullmatch(r"\d{1,2}", ln) and not areas:
            nums.append(int(ln))
        elif (a := _area_m2(ln)) is not None:
            areas.append(a)
        elif ln.lower() in KINDS or not (ln == "�" or len(ln) < 2):
            break
    return nums, areas


def _block(lines: list[str], head: str, stop: tuple[str, ...]) -> list[str]:
    """The lines after the first line that starts with `head`, up to the first that starts with one of `stop`."""
    for i, ln in enumerate(lines):
        if ln.startswith(head):
            out = []
            for nxt in lines[i + 1:]:
                if nxt.startswith(stop):
                    break
                out.append(nxt)
            return out
    return []


def realestate(text: str, html: str = "", today: date | None = None) -> dict:
    """realestate.com.au: the header (rooms, area, type, price or status), the headline and description, the features, the
    inspection times and the agents."""
    lines = lines_of(text)
    out: dict[str, Any] = {}
    save = next((i for i, ln in enumerate(lines) if ln == "Save"), None)
    if save is None:
        return out
    kind_at = _kind_index(lines, save + 1, save + 14)
    head = lines[save + 1:kind_at] if kind_at is not None else lines[save + 1:save + 8]
    nums, areas = _header_figures(lines, save + 1)
    beds_ad = re.search(r"(\d+) bedroom", html or "")
    if nums and (not beds_ad or int(beds_ad[1]) == nums[0]):      # the figures are beds, baths, cars, in that order
        out["beds"] = nums[0]
        if len(nums) > 1:
            out["baths"] = nums[1]
        if len(nums) > 2:
            out["car_spaces"] = nums[2]
    if kind_at is not None:
        out["property_type"] = KINDS[lines[kind_at].lower()]
    # One area: the land of a house, the floor area of an apartment (the features say which, below).
    if areas:
        key = "building_m2" if out.get("property_type") in ("apartment", "unit") else "land_m2"
        out[key] = areas[0]

    after = lines[kind_at + 1:kind_at + 8] if kind_at is not None else []
    status = next((ln for ln in after if re.fullmatch(r"UNDER CONTRACT|UNDER OFFER|SOLD|Under offer|Sold|WITHDRAWN", ln, re.I)), None)
    if status:
        out["listing_status"] = "sold" if status.lower() == "sold" else "withdrawn" if status.lower() == "withdrawn" else "under_offer"
    price = next((ln for ln in after if re.search(MONEY, ln) and len(ln) < 70), None)
    out["price_known"] = bool(price)
    if price:
        out["price_text"] = price
        low, high = _price_range(price)
        if low:
            out["guide_low_aud"], out["guide_high_aud"] = low, high
    auction = next((ln for ln in lines[save + 1:save + 14] if re.match(r"auction\b", ln, re.I)), None)
    if auction:
        out["sale_method"] = "auction"
        m = re.search(rf"{DAYS},?\s+(\d{{1,2}})\s+([A-Za-z]{{3,9}})\D+(\d{{1,2}})(?::(\d{{2}}))?\s*(am|pm)", auction, re.I)
        if m and m[2][:3].lower() in MONTHS and (day := _melbourne_date(int(m[1]), MONTHS[m[2][:3].lower()], today)):
            h, mm = _clock(m[3], m[4], m[5])
            out["auction_at"] = datetime(day.year, day.month, day.day, h, mm, tzinfo=MELBOURNE).isoformat()
    elif price and re.search(r"\bEOI\b|expressions? of interest", price, re.I):
        out["sale_method"] = "eoi"

    # The headline, then the address in capitals, then the description, up to "Read more".
    caps = next((i for i, ln in enumerate(lines) if i > save and re.fullmatch(r"[0-9A-Z/ '\-.,&]+,\s*[A-Z '\-]+", ln) and any(c.isalpha() for c in ln)), None)
    if caps is not None:
        out["headline"] = lines[caps - 1] if caps > 0 else None
        body = []
        for ln in lines[caps + 1:]:
            if ln in ("Read more", "Property features") or ln.startswith("Property features"):
                break
            body.append(ln)
        if body:
            out["description"] = "\n".join(body)[:4000]
    features = _block(lines, "Property features", ("Show ", "nbn", "Disclaimer"))
    sizes = {k.lower(): v for k, v in (re.fullmatch(r"([A-Za-z ]+?):\s*(.+)", f).groups() for f in features if re.fullmatch(r"[A-Za-z ]+?:\s*.+", f))}
    if (n := _area_m2(sizes.get("land size", ""))) is not None:
        out["land_m2"] = n
    if (n := _area_m2(sizes.get("building size", ""))) is not None:
        out["building_m2"] = n
    if m := re.fullmatch(r"(\d+)", sizes.get("garage spaces", sizes.get("car spaces", ""))):
        out.setdefault("car_spaces", int(m[1]))
    out["features"] = [f for f in features if ":" not in f][:30]
    if "No upcoming inspections" not in lines:
        out["inspections"] = _inspections(lines, today)

    # Agents: the agency's name and address, then each agent with their rating and review count (phones are cut short).
    agents, agency = [], None
    for i, ln in enumerate(lines):
        if re.fullmatch(r"\d+ reviews?", ln) and i >= 1:
            name = lines[i - 2] if re.fullmatch(r"\d\.\d\s*•?", lines[i - 1]) and i >= 2 else lines[i - 1]
            if name and name not in {a["name"] for a in agents} and len(name) < 60:
                agents.append({"name": name, "mobile": None, "email": None})
        elif agency is None and re.search(r",\s*[A-Z]{2,3},\s*\d{4}$", ln) and i >= 1 and "inspections" not in lines[i - 1]:
            agency = lines[i - 1]
    for a in agents:
        a["agency_name"] = agency
    out["agents"] = agents[:4]
    if m := next((re.fullmatch(r"Property ID:\s*(\d+)", ln) for ln in lines if ln.startswith("Property ID:")), None):
        out["listing_id"] = m[1]
    return out


def property_com_au(text: str, html: str = "", today: date | None = None) -> dict:
    """A property.com.au property page: its facts, the listing's price, who listed it and when, the estimated value and
    the property's past sales. The notes carry the estimate and the history, which no listing site gives."""
    lines = lines_of(text)
    out: dict[str, Any] = {}
    kind_at = next((i for i, ln in enumerate(lines) if ln.lower() in KINDS and i + 3 < len(lines) and re.fullmatch(r"\d{1,2}", lines[i + 1])), None)
    if kind_at is not None:
        out["property_type"] = KINDS[lines[kind_at].lower()]
        nums, areas = _header_figures(lines, kind_at + 1)
        for field, n in zip(("beds", "baths", "car_spaces"), nums):
            out[field] = n
        if areas:
            building_type = out["property_type"] in ("apartment", "unit")
            if len(areas) > 1:
                out["land_m2"], out["building_m2"] = areas[0], areas[1]
            else:
                out["building_m2" if building_type else "land_m2"] = areas[0]
    about = next((ln for ln in lines if "currently listed for sale" in ln or (" bedroom" in ln and " bathroom" in ln and " in " in ln)), "")
    if m := re.search(r"sits on an? (\d[\d,]*(?:\.\d+)?)\s*(ha|m²|m2|sqm) lot", about, re.I):
        if (n := _area_m2(f"{m[1]} {m[2]}")) is not None:
            out["land_m2"] = n
    if m := re.search(rf"currently listed for sale at ({MONEY}(?:\s*[-–]\s*{MONEY})?)", about):
        out["price_text"] = m[1]
        low, high = _price_range(m[1])
        if low:
            out["guide_low_aud"], out["guide_high_aud"] = low, high
    out["price_known"] = "price_text" in out

    # "Listed 27 May 2026 by LJ Hooker Lifestyle Group", the agent's name above "Licensed Real Estate Agent".
    for i, ln in enumerate(lines):
        if (m := re.fullmatch(r"Listed (\d{1,2}) ([A-Za-z]{3,9}) (\d{4}) by (.+)", ln)) and m[2][:3].lower() in MONTHS and "listed_on" not in out:
            out["listed_on"] = date(int(m[3]), MONTHS[m[2][:3].lower()], int(m[1])).isoformat()
            agency = m[4].strip()
            agent = lines[i - 2] if i >= 2 and lines[i - 1] == "Licensed Real Estate Agent" else None
            out["agents"] = [{"name": agent, "mobile": None, "email": None, "agency_name": agency}] if agent else []
    # Notes: the estimate and the sales history.
    notes = []
    est = next((i for i, ln in enumerate(lines) if ln == "Property value"), None)
    if est is not None:
        window = lines[est:est + 14]
        value = next((x for x in window if re.fullmatch(MONEY, x)), None)
        rng = [x for x in window if re.fullmatch(r"\$[\d.,]+[mMkK]?", x)]
        if value:
            span = f" ({rng[1]}–{rng[2]})" if len(rng) >= 3 else ""
            when = next((x[len("Last updated "):] .split(",")[0] for x in window if x.startswith("Last updated")), None)
            notes.append(f"property.com.au estimates {value}{span}" + (f", updated {when}." if when else "."))
    sold = [f"{m[2]}: sold {m[1]}" for ln in lines if (m := re.fullmatch(rf"({MONEY})\s*\|?\s*(\d{{1,2}} [A-Za-z]{{3}} \d{{4}}).*", ln))]
    for i, ln in enumerate(lines):
        if re.fullmatch(r"Sold", ln) and i + 2 < len(lines) and re.fullmatch(MONEY, lines[i + 1]) and re.match(r"\d{1,2} [A-Za-z]{3} \d{4}", lines[i + 2]):
            sold.append(f"{lines[i + 2].split(' by ')[0]}: sold {lines[i + 1]}")
    if sold:
        notes.append("Past sales: " + "; ".join(dict.fromkeys(sold)) + ".")
    if notes:
        out["description"] = "\n".join(notes)
    return out
