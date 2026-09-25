"""Listing URLs. Recognising the portal and its listing ID from the URL shape is the only
portal-specific logic in milestone 1; it doesn't fetch anything (PLAN.md D12)."""

import re
from urllib.parse import urlsplit, urlunsplit

PORTAL_HOSTS = {"domain.com.au": "domain", "realestate.com.au": "rea"}
_TRAILING_ID = re.compile(r"-(\d{6,})/?$")


def clean_url(url: str) -> str:
    """Drop query string and fragment (tracking parameters) so the same advert matches itself."""
    parts = urlsplit(url.strip())
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", "", ""))


def recognise(url: str) -> tuple[str, str | None]:
    """Returns (portal, external_id). Unknown hosts are 'other' with no id."""
    parts = urlsplit(url)
    host = parts.netloc.lower().removeprefix("www.")
    portal = PORTAL_HOSTS.get(host, "other")
    if portal == "other":
        return portal, None
    m = _TRAILING_ID.search(parts.path)
    return portal, m.group(1) if m else None


# ─── the address in a Domain link ─────────────────────────────────────
# Domain's listing URLs spell out the address: /3-14-example-street-box-hill-north-vic-3129-2029990001 is unit 3,
# 14 Example Street, Box Hill North VIC 3129. Enough to add a house from a shared link on a phone; the rest (rooms,
# price, photos) comes with the weekly refresh. realestate.com.au's URLs don't carry the address.
_DOMAIN_SLUG = re.compile(r"^(?P<words>.+)-(?P<state>[a-z]{2,3})-(?P<postcode>\d{4})-\d{6,}$")
_NUMBER = re.compile(r"^\d+[a-z]?$")


def address_from_link(url: str) -> dict | None:
    """{unit, street_number, street, suburb, postcode} from a Domain listing link, or None. Where the street ends
    and the suburb begins is checked against G-NAF when it's loaded ("12 glen street glen waverley"); failing that,
    the street runs to its last street-type word before the suburb."""
    from . import gnaf
    from .address import STATES, STREET_TYPES, _title
    if recognise(url)[0] != "domain":
        return None
    slug = urlsplit(url).path.strip("/").split("/")[-1].lower()
    m = _DOMAIN_SLUG.match(slug)
    if not m or m["state"] not in STATES:
        return None
    words, postcode = m["words"].split("-"), m["postcode"]
    unit = None
    if len(words) > 3 and _NUMBER.match(words[0]) and _NUMBER.match(words[1]):
        unit, words = words[0], words[1:]
    if len(words) < 3 or not _NUMBER.match(words[0]):
        return None  # a lot or a development without a street number: typed in by hand
    number, rest = words[0], words[1:]

    # G-NAF's record is only taken when it is this address: the same number, unit, street and suburb as the link
    # (a near miss, like 1/12 Beacon Street for 12 Glen Street, falls through to reading the link itself).
    slug_text = " " + " ".join(rest) + " "
    for hit in gnaf.search(" ".join(([f"{unit}/{number}"] if unit else [number]) + rest + [postcode]), limit=5):
        street, suburb = str(hit.get("street") or "").lower(), str(hit.get("suburb") or "").lower()
        if (hit.get("postcode") == postcode and str(hit.get("street_number") or "").lower() == number
                and str(hit.get("unit") or "").lower() == (unit or "")
                and street and f" {street} " in slug_text and suburb and slug_text.endswith(f" {suburb} ")):
            return {"unit": hit.get("unit"), "street_number": hit["street_number"], "street": _title(hit["street"]),
                    "suburb": _title(hit["suburb"]), "postcode": postcode}

    # "street", "road" and the like end a street; "glen", "view", "heights" and the like are just as often part of a
    # name (Glen Street, Hill View Road, Glen Waverley), so they only end it when nothing clearer does.
    types = set(STREET_TYPES.values()) | {"street", "road", "avenue", "boulevard", "circuit", "lane", "track", "highway"}
    unclear = {"glen", "view", "heights", "rise", "ridge", "vista", "gardens", "cove", "chase", "bend", "grove", "mews",
               "row", "walk", "break", "square"}
    clear = [i for i, w in enumerate(rest[:-1]) if i > 0 and w in types - unclear]
    other = [i for i, w in enumerate(rest[:-1]) if w in types]
    if not clear and not other:
        return None
    end = clear[0] if clear else other[-1]
    return {"unit": unit.upper() if unit else None, "street_number": number.upper(), "street": _title(" ".join(rest[:end + 1])),
            "suburb": _title(" ".join(rest[end + 1:])), "postcode": postcode}
