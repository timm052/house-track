"""Address normalisation.

Every entry path (quick-add, edit, later imports) goes through `normalise`, so the
same dwelling always produces the same `address_key`. The key is the fallback natural
key after the G-NAF ID and plan + lot (PLAN.md §2).
"""

import re
from dataclasses import dataclass, replace

STREET_TYPES = {
    "st": "street", "str": "street", "rd": "road", "ave": "avenue", "av": "avenue",
    "cres": "crescent", "cr": "crescent", "cresc": "crescent", "ct": "court", "crt": "court",
    "dr": "drive", "drv": "drive", "pde": "parade", "pl": "place", "gr": "grove", "gve": "grove",
    "hwy": "highway", "bvd": "boulevard", "blvd": "boulevard", "bld": "boulevard",
    "cl": "close", "tce": "terrace", "sq": "square", "ln": "lane", "wy": "way",
    "cct": "circuit", "cir": "circuit", "esp": "esplanade", "gdns": "gardens",
    "hts": "heights", "pkwy": "parkway", "pwy": "parkway", "rdg": "ridge", "rise": "rise",
    "wk": "walk", "wlk": "walk", "mews": "mews", "row": "row", "vw": "view", "vista": "vista",
    "ch": "chase", "cove": "cove", "gln": "glen", "bnd": "bend", "brk": "break",
}

STATES = {"vic", "nsw", "qld", "sa", "wa", "tas", "act", "nt"}

UNIT_PREFIX = re.compile(r"^(?:unit|u|apartment|apt|flat|shop|suite|villa|townhouse|th)\s*", re.I)


@dataclass(frozen=True)
class Address:
    unit: str | None = None
    street_number: str | None = None
    street: str | None = None
    suburb: str | None = None
    postcode: str | None = None
    plan_number: str | None = None
    lot_number: str | None = None


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = re.sub(r"\s+", " ", value).strip(" ,")
    return value or None


def _title(value: str) -> str:
    # "o'brien street" -> "O'Brien Street", "mcdonald" stays "Mcdonald" (good enough for display)
    return " ".join(w[:1].upper() + w[1:] for w in value.lower().split(" "))


def normalise_street(street: str) -> str:
    words = street.lower().replace(".", "").split()
    if len(words) >= 2 and words[-1] in STREET_TYPES:
        words[-1] = STREET_TYPES[words[-1]]
    return _title(" ".join(words))


def normalise_unit(unit: str | None) -> str | None:
    unit = _clean(unit)
    if unit is None:
        return None
    return UNIT_PREFIX.sub("", unit).upper() or None


def normalise(a: Address) -> Address:
    street = _clean(a.street)
    return replace(
        a,
        unit=normalise_unit(a.unit),
        street_number=(_clean(a.street_number) or "").upper() or None,
        street=normalise_street(street) if street else None,
        suburb=_title(_clean(a.suburb)) if _clean(a.suburb) else None,
        postcode=_clean(a.postcode),
        plan_number=(_clean(a.plan_number) or "").upper().replace(" ", "") or None,
        lot_number=(_clean(a.lot_number) or "").upper() or None,
    )


def address_key(a: Address) -> str:
    """Stable lower-case key. Expects an already-normalised address."""
    if a.street_number:
        parts = [a.unit or "", a.street_number, a.street or "", a.suburb or "", a.postcode or ""]
    else:
        parts = ["lot", a.lot_number or "", a.plan_number or "", a.street or "", a.suburb or "", a.postcode or ""]
    key = " ".join(p for p in parts if p).lower()
    return re.sub(r"[^a-z0-9]+", " ", key).strip()


def display(a: Address) -> str:
    if a.street_number:
        first = f"{a.unit}/{a.street_number}" if a.unit else a.street_number
        line = f"{first} {a.street}"
    else:
        line = f"Lot {a.lot_number}" + (f" {a.street}" if a.street else "") + f" ({a.plan_number})"
    return f"{line}, {a.suburb} {a.postcode}"


_PASTE = re.compile(
    r"""^\s*
    (?:(?P<unit>(?:unit|u|apt|apartment|flat)?\s*[\w-]+)\s*/\s*)?   # 3/ or Unit 3/
    (?P<number>\d+[a-z]?(?:-\d+[a-z]?)?)\s+                         # 12, 12a, 12-14
    (?P<street>[^,]+?)\s*,?\s+
    (?P<suburb>[a-z][a-z' -]*?)\s*,?\s*
    (?:(?P<state>vic|nsw|qld|sa|wa|tas|act|nt)\s*)?
    (?P<postcode>\d{4})?\s*$""",
    re.I | re.X,
)
_UNIT_WORDS = re.compile(r"^(?:unit|u|apt|apartment|flat)\s+(?P<unit>[\w-]+)\s*,?\s+(?P<rest>.+)$", re.I)


def parse(text: str) -> Address | None:
    """Best-effort split of a pasted one-line address, e.g. from a listing page.

    Handles "3/12 Smith St, Box Hill VIC 3128" and "Unit 3, 12 Smith St Box Hill 3128".
    The suburb/street boundary is ambiguous without commas, so the UI always shows the
    parsed fields for confirmation.
    """
    text = _clean(text) or ""
    unit_words = _UNIT_WORDS.match(text)
    if unit_words:
        text = f"{unit_words['unit']}/{unit_words['rest']}"
    m = _PASTE.match(text)
    if not m:
        return None
    street, suburb = m["street"], m["suburb"]
    if "," not in text:
        # No comma: assume the street ends at the first street-type word.
        words = f"{street} {suburb}".split()
        for i, w in enumerate(words[1:], start=1):
            if w.lower().rstrip(".") in STREET_TYPES or w.lower() in STREET_TYPES.values():
                street, suburb = " ".join(words[: i + 1]), " ".join(words[i + 1 :])
                break
    if not suburb or suburb.lower() in STATES:
        return None
    return normalise(
        Address(unit=m["unit"], street_number=m["number"], street=street, suburb=suburb, postcode=m["postcode"])
    )
