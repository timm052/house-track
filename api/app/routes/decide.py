"""Milestone 6: weighted scoring and listing pre-fill."""

from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import listing_capture, listing_parse
from ..address import Address, display
from ..db import tx
from ..deps import Person, not_found

router = APIRouter(prefix="/api")


# ─── criteria & scores ────────────────────────────────────────────────
class CriterionIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    weight: int = Field(default=3, ge=1, le=5)


class CriterionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    weight: int | None = Field(default=None, ge=1, le=5)
    sort: int | None = None


class ScoreIn(BaseModel):
    criterion_id: UUID
    score: int = Field(ge=1, le=5)
    person_id: UUID | None = None  # defaults to the acting person


@router.get("/criteria")
def list_criteria() -> list[dict]:
    with tx() as conn:
        return conn.execute("SELECT id, name, weight, sort FROM criterion WHERE archived_at IS NULL ORDER BY sort, created_at").fetchall()


@router.post("/criteria", status_code=201)
def add_criterion(body: CriterionIn, person: Person) -> dict:
    with tx(person) as conn:
        return conn.execute(
            "INSERT INTO criterion (name, weight, sort) VALUES (%s, %s,"
            " (SELECT coalesce(max(sort), 0) + 1 FROM criterion)) RETURNING id, name, weight, sort",
            (body.name.strip(), body.weight)).fetchone()


@router.patch("/criteria/{criterion_id}")
def update_criterion(criterion_id: UUID, body: CriterionPatch, person: Person) -> dict:
    values = body.model_dump(exclude_unset=True)
    with tx(person) as conn:
        for k, v in values.items():
            conn.execute(f"UPDATE criterion SET {k} = %s WHERE id = %s", (v.strip() if isinstance(v, str) else v, criterion_id))
        row = conn.execute("SELECT id, name, weight, sort FROM criterion WHERE id = %s", (criterion_id,)).fetchone()
    if row is None:
        raise not_found("Criterion")
    return row


@router.delete("/criteria/{criterion_id}", status_code=204)
def archive_criterion(criterion_id: UUID, person: Person) -> None:
    """Archived, so scores already given keep their meaning in the history."""
    with tx(person) as conn:
        conn.execute("UPDATE criterion SET archived_at = now() WHERE id = %s", (criterion_id,))


@router.get("/properties/{property_id}/scores")
def property_scores(property_id: UUID) -> dict:
    with tx() as conn:
        scores = conn.execute(
            """SELECT s.criterion_id, s.person_id, s.score FROM criterion_score_current s
               JOIN criterion c ON c.id = s.criterion_id AND c.archived_at IS NULL WHERE s.property_id = %s""",
            (property_id,)).fetchall()
        totals = conn.execute("SELECT person_id, score, scored, criteria FROM property_score WHERE property_id = %s",
                              (property_id,)).fetchall()
    return {"scores": scores, "totals": totals}


@router.post("/properties/{property_id}/scores", status_code=201)
def add_score(property_id: UUID, body: ScoreIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        conn.execute("INSERT INTO criterion_score (property_id, criterion_id, person_id, score) VALUES (%s, %s, %s, %s)",
                     (property_id, body.criterion_id, body.person_id or person, body.score))
    return property_scores(property_id)


# ─── listing pre-fill (⚠ scraping, fragile: PLAN.md D12) ──────────────
class PrefillIn(BaseModel):
    url: str = Field(pattern=r"^https?://")


class CaptureIn(BaseModel):
    """What the bookmarklet sends: the page as the browser rendered it."""
    url: str = Field(pattern=r"^https?://")
    html: str = Field(default="", max_length=3_000_000)
    image: str | None = Field(default=None, pattern=r"^https?://", max_length=2000)  # the page's og:image, read in the browser
    next_data: str | None = Field(default=None, max_length=4_000_000)  # Domain's __NEXT_DATA__
    argonaut: str | None = Field(default=None, max_length=4_000_000)   # realestate.com.au's page data
    text: str | None = Field(default=None, max_length=400_000)         # the visible text


BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/140.0 Safari/537.36")


@router.post("/listing/prefill")
def prefill(body: PrefillIn, _: Person) -> dict:
    """Fetch the listing from the server. Often blocked by the portals; the bookmarklet is the fallback."""
    try:
        page = fetch_page(body.url)
    except HTTPException:
        raise HTTPException(502, "Couldn't read that page. Use the + House Track button, or fill in the form.") from None
    return with_existing(listing_parse.parse(page, body.url))


class LinkIn(BaseModel):
    url: str = Field(pattern=r"^https?://", max_length=2000)


@router.post("/listing/from-link")
def from_link(body: LinkIn, _: Person) -> dict:
    """A listing link shared from a phone: the address, where the link spells it out (Domain's do), and whether the
    listing is already tracked. Nothing is fetched from the portal; the weekly refresh fills in the rest."""
    from ..listing import address_from_link, clean_url
    url = clean_url(body.url)
    return with_existing({"url": url, "address_parts": address_from_link(url)})


class ShareIn(BaseModel):
    """What an iPhone shortcut sends: the link (or links) it was given, or text with a link in it."""
    url: str | list[str] | None = None
    text: str | None = None


@router.post("/share")
def share(body: ShareIn, person: Person) -> dict:
    """A listing shared from a phone, with no browser (the iPhone shortcut): added as a house straight away when
    its link spells out the address (Domain's do), otherwise kept on the Shared links list to finish in the app.
    Always answers with a `message` for the phone's notification."""
    import re
    from ..listing import address_from_link, clean_url
    from ..schemas import AddressIn, PropertyIn, QuickCampaignIn
    from .properties import create_property
    shared = ([body.url] if isinstance(body.url, str) else list(body.url or [])) + [body.text or ""]
    link = next((m[0] for s in shared if (m := re.search(r"https?://[^\s\"<>]+", s or ""))), None)
    if not link:
        return {"status": "no_link", "message": "Nothing to add. The share had no link in it."}
    url = clean_url(link)
    known = with_existing({"url": url})
    if known["existing_property_id"]:
        return {"status": "exists", "property_id": known["existing_property_id"],
                "message": f"Already in House Track: {known['existing_address']}"}
    parts = address_from_link(url)
    if parts:
        gnaf_pid = parts.pop("gnaf_pid", None)
        try:
            # Private sale until the weekly refresh reads the listing (it switches to auction or EOI if need be).
            created = create_property(PropertyIn(address=AddressIn(**parts), gnaf_pid=gnaf_pid,
                                                 campaign=QuickCampaignIn(sale_method="private_sale", url=url)), person)
        except HTTPException as e:
            if e.status_code != 409:
                raise
            return {"status": "exists", "property_id": e.detail["existing_property_id"],
                    "message": f"Already in House Track: {display(Address(**{k: parts.get(k) for k in ('unit', 'street_number', 'street', 'suburb', 'postcode')}))}"}
        address = display(Address(**{k: parts.get(k) for k in ("unit", "street_number", "street", "suburb", "postcode")}))
        return {"status": "added", "property_id": str(created["id"]),
                "message": f"Added {address}."}
    with tx(person) as conn:
        conn.execute("""INSERT INTO shared_link (url, shared_by) VALUES (%s, %s)
                        ON CONFLICT (url) DO UPDATE SET shared_at = now(), shared_by = EXCLUDED.shared_by, dismissed_at = NULL""",
                     (url, person))
    return {"status": "saved", "message": "Link saved. Open House Track to finish adding it."}


@router.get("/shared-links")
def shared_links() -> list[dict]:
    """Links shared from a phone still waiting to be added (not dismissed, and not yet on any house)."""
    with tx() as conn:
        return conn.execute(
            """SELECT s.id, s.url, s.shared_by, s.shared_at FROM shared_link s
               WHERE s.dismissed_at IS NULL AND NOT EXISTS (SELECT 1 FROM campaign_link l WHERE l.url = s.url)
               ORDER BY s.shared_at DESC""").fetchall()


@router.delete("/shared-links/{link_id}", status_code=204)
def dismiss_shared_link(link_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("UPDATE shared_link SET dismissed_at = now() WHERE id = %s", (link_id,))


@router.post("/listing/parse")
def parse_capture(body: CaptureIn, _: Person) -> dict:
    with tx() as conn:
        known = [r["name"] for r in conn.execute("SELECT name FROM tag ORDER BY name").fetchall()]
    out = listing_capture.extract(body.url, body.html, body.next_data, body.argonaut, body.text, body.image, known)
    return with_existing(out)


def with_existing(out: dict) -> dict:
    """Already tracking this listing? Then the capture can add its photo to that house instead."""
    with tx() as conn:
        row = conn.execute("""SELECT c.property_id, p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number
                              FROM campaign_link l JOIN campaign c ON c.id = l.campaign_id JOIN property p ON p.id = c.property_id
                              WHERE l.url = %s LIMIT 1""", (out.get("url"),)).fetchone()
    out["existing_property_id"] = row and str(row.pop("property_id"))
    out["existing_address"] = row and display(Address(**row))
    return out


def fetch_page(url: str) -> str:
    try:
        req = Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html", "Accept-Language": "en-AU"})
        with urlopen(req, timeout=15) as r:
            return r.read(3_000_000).decode("utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError) as e:
        raise HTTPException(502, f"The listing site blocked the request ({getattr(e, 'code', None) or 'no response'}). "
                                 "Use + House Track on the listing instead.") from None


# ─── weekly refresh: the "Refresh from Domain" bookmarklet ───────────────
# It runs in your own browser on domain.com.au, loads each tracked listing a few seconds apart, and hands the
# page data to House Track's /refresh page, which posts each one here. Changes are applied automatically.
OFF_MARKET = {"sold": "Sold", "underoffer": "Under offer", "under offer": "Under offer", "archived": "No longer listed",
              "offmarket": "Off the market", "withdrawn": "Withdrawn", "leased": "No longer listed"}
MAX_TARGETS = 150  # a run is about ten minutes at the page's pace of one listing every four seconds


@router.get("/listing/targets")
def refresh_targets() -> list[dict]:
    """Houses with a Domain link, least recently checked first: active ones with a live campaign, and ones sold in
    the last two weeks whose price we don't have yet (agents often add it a few days after the sale)."""
    with tx() as conn:
        rows = conn.execute(
            """SELECT DISTINCT ON (p.id) p.id, l.url, l.last_checked_at, p.unit, p.street_number, p.street, p.suburb, p.postcode,
                      p.plan_number, p.lot_number
               FROM campaign_link l
               JOIN campaign c ON c.id = l.campaign_id
               JOIN property p ON p.id = c.property_id
               JOIN property_status s ON s.property_id = p.id
               WHERE l.portal = 'domain'
                 AND ((c.outcome IS NULL AND s.status NOT IN ('ruled_out', 'missed_out', 'bought'))
                      OR (c.outcome LIKE 'sold%%' AND c.sold_price_aud IS NULL AND NOT c.bought_by_us
                          AND c.outcome_on >= current_date - 14))
               ORDER BY p.id, (c.outcome IS NULL) DESC, c.created_at DESC, l.created_at DESC""").fetchall()
    out = [{"id": str(r.pop("id")), "url": r.pop("url"), "last_checked_at": r.pop("last_checked_at"), "address": display(Address(**r))}
           for r in rows]
    out.sort(key=lambda t: (t["last_checked_at"] is not None, t["last_checked_at"] or ""))
    return out[:MAX_TARGETS]


class RefreshIn(BaseModel):
    property_id: UUID
    url: str = Field(pattern=r"^https?://")
    status_code: int | None = None
    next_data: str | None = Field(default=None, max_length=4_000_000)
    image: str | None = Field(default=None, max_length=2000)
    fill_missing: bool = True  # fill in rooms and areas we have nothing for, and photos and floor plans if there are none


@router.post("/listing/refresh")
def refresh_one(body: RefreshIn, person: Person) -> dict:
    """One listing's page data, as loaded by the bookmarklet: apply what changed and say what it was."""
    from .. import listing_apply
    from ..listing import clean_url
    from ..schemas import ListingUpdateIn
    with tx(person) as conn:
        conn.execute("UPDATE campaign_link SET last_checked_at = now() WHERE url = %s", (clean_url(body.url),))
    if body.status_code in (404, 410):
        return {"property_id": str(body.property_id), "changes": [], "flag": "The listing has been taken down."}
    if not body.next_data:
        return {"property_id": str(body.property_id), "changes": [],
                "error": f"Couldn't read the listing (HTTP {body.status_code or '?'}). Try it again later, or open it and use + House Track."}
    got = listing_capture.extract(body.url, "", body.next_data, image=body.image if (body.image or "").startswith("http") else None)
    method = got.get("sale_method")
    update = ListingUpdateIn(
        guide_low_aud=got.get("guide_low_aud"), guide_high_aud=got.get("guide_high_aud"), sale_method=method,
        auction_at=got.get("auction_at") if method == "auction" else None,
        eoi_closes_at=got.get("eoi_closes_at") if method == "eoi" else None,
        inspections=got.get("inspections") or [], agents=got.get("agents") or [], soi_url=got.get("soi_url"),
        listed_on=got.get("listed_on"),
        **{f: got.get(f) for f, _ in listing_apply.DETAILS}, apply_details=False,  # unattended: report, don't overwrite
        fill_missing=body.fill_missing,
        listing_status=got.get("listing_status"), listing_price_text=got.get("price_text"), sold_price_aud=got.get("sold_price_aud"),
    )
    with tx(person) as conn:
        added = listing_apply.refresh(conn, body.property_id, update)
        have = conn.execute("""SELECT count(*) FILTER (WHERE kind = 'photo') AS photos, count(*) FILTER (WHERE kind = 'floorplan') AS plans
                               FROM attachment WHERE property_id = %s AND sha256 IS NOT NULL""", (body.property_id,)).fetchone()
    if body.fill_missing:
        from .driveway import save_photos_later
        photos = got.get("photos") or [] if not have["photos"] else []
        plans = got.get("floorplans") or [] if not have["plans"] else []
        if photos or plans:
            save_photos_later(body.property_id, person, photos, plans)
            if photos:
                added["changes"].append(f"{len(photos)} {'photo' if len(photos) == 1 else 'photos'} from the listing")
            if plans:
                added["changes"].append("Floor plan from the listing")
    from .. import push
    push.listing_changed(body.property_id, added["changes"], person)
    # Sold and under offer are recorded above; taken down or withdrawn still need a person to say how it ended.
    status = listing_apply.listing_state(got.get("listing_status"))
    flag = OFF_MARKET.get(status) if status not in ("sold", "underoffer") else None
    return {"property_id": str(body.property_id), "changes": added["changes"], "differs": added["differs"],
            "price_text": got.get("price_text"),
            "flag": f"{flag}: check the outcome and update the status." if flag else None}
