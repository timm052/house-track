"""Reading a Victorian Statement of Information (PLAN.md: price statements).

The first page is Consumer Affairs Victoria's fixed form, so the parts we want are always worded the same way:
the indicative selling price ("Range between $A & $B" or "Single price $A"), the suburb median ("Median price $M
... Period - From dd/mm/yyyy to dd/mm/yyyy"), and up to three comparable sales, one per line: "1 8 Marks Av
HEIDELBERG HEIGHTS 3081 $1,100,000 13/07/2026". Agents often attach their own report as a second page with each
comparable's rooms, land and sale method; those are picked up when they're there.
"""

import io
import re
from datetime import date

MONEY = r"\$\s?([\d,]+)"


def _aud(s: str) -> int:
    return int(s.replace(",", ""))


def _day(s: str) -> date | None:
    d, m, y = (int(x) for x in s.split("/"))
    try:
        return date(y, m, d)
    except ValueError:
        return None


def text_of(pdf: bytes) -> str:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def read(pdf: bytes) -> dict:
    """Everything useful in a Statement of Information. Raises ValueError if the PDF isn't one."""
    return read_text(text_of(pdf))


def read_text(text: str) -> dict:
    if "Statement of Information" not in text or "Indicative selling price" not in text:
        raise ValueError("This PDF doesn't look like a Statement of Information.")
    out: dict = {"comparables": []}

    if m := re.search(r"Range between\s*" + MONEY + r"\s*(?:&|and|-|to)\s*" + MONEY, text, re.I):
        out["indicative_low"], out["indicative_high"] = _aud(m[1]), _aud(m[2])
    elif m := re.search(r"Single price\s*" + MONEY, text, re.I):
        out["indicative_low"] = out["indicative_high"] = _aud(m[1])
    if m := re.search(r"Median price\s*" + MONEY, text, re.I):
        out["median"] = _aud(m[1])
    if m := re.search(r"Period\s*-?\s*From\s*(\d{1,2}/\d{1,2}/\d{4})\s*to\s*(\d{1,2}/\d{1,2}/\d{4})", text, re.I):
        out["median_from"], out["median_to"] = _day(m[1]), _day(m[2])

    # The form's table: numbered lines with an address, a price and a date.
    section = text.split("Address of comparable property", 1)[-1].split("This Statement of Information was prepared", 1)[0]
    for m in re.finditer(r"^\s*([1-3])\s+(.+?)\s+" + MONEY + r"\s+(\d{1,2}/\d{1,2}/\d{4})\s*$", section, re.M):
        out["comparables"].append({"address": m[2].strip(), "price": _aud(m[3]), "sold_on": _day(m[4])})

    # The agent's report, when attached: "8 Marks Av HEIDELBERG HEIGHTS 3081 (REI)", then "3 2 4" (bed bath car),
    # then Price:, Method:, Date: and sometimes Land Size:.
    for c in out["comparables"]:
        at = text.lower().find(c["address"].lower() + " (")
        if at < 0:
            continue
        block = text[at:at + 400]
        block = block.split("Agent Comments", 1)[0]  # each sale's details end there; don't read the next one's
        if m := re.search(r"\)\s*\n\s*(\d+|-)\s+(\d+|-)\s+(\d+|-)", block):
            for key, v in zip(("beds", "baths", "car_spaces"), m.groups()):
                if v != "-":
                    c[key] = int(v)
        if m := re.search(r"Method:\s*([^\n]+)", block):
            c["method"] = m[1].strip()
        if m := re.search(r"Land Size:\s*([\d,]+)\s*(?:sqm|m²|m2)", block, re.I):
            c["land_m2"] = _aud(m[1])
    for c in out["comparables"]:
        c["address"] = _tidy(c["address"])
    out["none_nearby"] = not out["comparables"] and bool(re.search(r"fewer than three\s+comparable", text, re.I))
    return out


def _tidy(address: str) -> str:
    """"8 Marks Av HEIDELBERG HEIGHTS 3081" → "8 Marks Av, Heidelberg Heights 3081" (suburbs come in capitals)."""
    m = re.match(r"(.+?)\s+([A-Z][A-Z '\-]+?)\s+(\d{4})$", address.strip())
    if not m:
        return re.sub(r"\s+", " ", address.strip())
    return f"{m[1]}, {m[2].title()} {m[3]}"
