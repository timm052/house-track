"""Milestone 3: inspections, photos and documents, and the calendar feed."""

from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

from .. import blobs
from ..address import Address, display
from ..db import tx
from ..deps import Person, not_found, update_columns
from ..schemas import ListingUpdateIn

router = APIRouter(prefix="/api")

InspectionKind = Literal["open", "private", "second_look", "building_pest", "display_suite", "pre_settlement", "other"]
InspectionState = Literal["planned", "attended", "skipped", "cancelled"]
AttachmentKind = Literal["photo", "floorplan", "price_statement", "vendor_statement", "contract", "building_report",
                         "pest_report", "strata_report", "strata_certificate", "plans_specs", "other"]
MAX_UPLOAD = 50 * 1024 * 1024


# ─── inspections ──────────────────────────────────────────────────────
class InspectionIn(BaseModel):
    id: UUID | None = None  # made on the phone, so a resend from the offline outbox is a no-op
    kind: InspectionKind = "open"
    starts_at: datetime
    ends_at: datetime | None = None
    state: InspectionState = "planned"
    inspector: str | None = None
    notes: str | None = None


class InspectionPatch(BaseModel):
    kind: InspectionKind | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    state: InspectionState | None = None
    inspector: str | None = None
    notes: str | None = None


class AttendeeIn(BaseModel):
    note: str | None = None


INSPECTION_SELECT = """
    SELECT i.id, i.property_id, i.campaign_id, i.kind, i.starts_at, i.ends_at, i.state, i.inspector, i.notes,
           i.created_by,
           coalesce((SELECT jsonb_agg(jsonb_build_object('person_id', a.person_id, 'note', a.note))
                     FROM inspection_attendee a WHERE a.inspection_id = i.id), '[]') AS attendees
    FROM inspection i
"""


def inspections_for(conn, property_id: UUID) -> list[dict]:
    return conn.execute(INSPECTION_SELECT + " WHERE i.property_id = %s ORDER BY i.starts_at DESC", (property_id,)).fetchall()


@router.post("/properties/{property_id}/inspections", status_code=201)
def create_inspection(property_id: UUID, body: InspectionIn, person: Person) -> dict:
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        live = conn.execute("SELECT id FROM campaign WHERE property_id = %s AND outcome IS NULL", (property_id,)).fetchone()
        ends = body.ends_at or (body.starts_at + timedelta(minutes=30 if body.kind == "open" else 60))
        row = conn.execute(
            """INSERT INTO inspection (id, property_id, campaign_id, kind, starts_at, ends_at, state, inspector, notes)
               VALUES (coalesce(%s, uuidv7()), %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO NOTHING RETURNING id""",
            (body.id, property_id, live and live["id"], body.kind, body.starts_at, ends, body.state, body.inspector, body.notes),
        ).fetchone()
    return {"id": row["id"] if row else body.id}


@router.patch("/inspections/{inspection_id}")
def update_inspection(inspection_id: UUID, body: InspectionPatch, person: Person) -> dict:
    with tx(person) as conn:
        if update_columns(conn, "inspection", inspection_id, body.model_dump(exclude_unset=True)) is None:
            raise not_found("Inspection")
    return {"id": inspection_id}


class DayIn(BaseModel):
    day: date  # a Melbourne day


@router.post("/inspections/cancel-day")
def cancel_day(body: DayIn, person: Person) -> dict:
    """Not going to any of a day's inspections: cancel them all. Cancelled, not deleted, so the weekly refresh
    doesn't add them back from the listing; ones already attended keep their notes and stay."""
    with tx(person) as conn:
        rows = conn.execute(
            """UPDATE inspection SET state = 'cancelled'
               WHERE (starts_at AT TIME ZONE 'Australia/Melbourne')::date = %s AND state IN ('planned', 'skipped')
               RETURNING id, property_id""", (body.day,)).fetchall()
    return {"cancelled": len(rows), "property_ids": sorted({str(r["property_id"]) for r in rows})}


@router.put("/inspections/{inspection_id}/attendees/{person_id}")
def set_attendee(inspection_id: UUID, person_id: UUID, body: AttendeeIn, person: Person) -> dict:
    """Record who went and their own notes. Marks the inspection attended."""
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM inspection WHERE id = %s", (inspection_id,)).fetchone() is None:
            raise not_found("Inspection")
        conn.execute(
            """INSERT INTO inspection_attendee (inspection_id, person_id, note) VALUES (%s, %s, %s)
               ON CONFLICT (inspection_id, person_id) DO UPDATE SET note = coalesce(EXCLUDED.note, inspection_attendee.note)""",
            (inspection_id, person_id, body.note),
        )
        conn.execute("UPDATE inspection SET state = 'attended' WHERE id = %s AND state = 'planned'", (inspection_id,))
        # Been to see it: off the To inspect list.
        conn.execute("DELETE FROM inspect_list WHERE property_id = (SELECT property_id FROM inspection WHERE id = %s)", (inspection_id,))
    return {"id": inspection_id}


@router.delete("/inspections/{inspection_id}/attendees/{person_id}", status_code=204)
def remove_attendee(inspection_id: UUID, person_id: UUID, person: Person) -> None:
    with tx(person) as conn:
        conn.execute("DELETE FROM inspection_attendee WHERE inspection_id = %s AND person_id = %s", (inspection_id, person_id))


@router.get("/inspections")
def upcoming(days: int = 14) -> list[dict]:
    """Inspections, auctions and EOI closings from yesterday onwards: the calendar screen."""
    with tx() as conn:
        return _events(conn, days)


def _events(conn, days: int) -> list[dict]:
    """What's coming up. Houses we're finished with (ruled out, or sold to someone else) are left out, without
    touching their inspections, so they come back if the house does; a house we bought keeps its own."""
    rows = conn.execute(
        """SELECT 'inspection' AS type, i.id, i.kind, i.state, i.starts_at, i.ends_at, p.id AS property_id,
                  p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number
           FROM inspection i JOIN property p ON p.id = i.property_id
           JOIN property_status s ON s.property_id = p.id
           LEFT JOIN campaign c ON c.id = i.campaign_id
           WHERE i.starts_at >= now() - interval '1 day' AND i.starts_at < now() + %(days)s * interval '1 day'
             AND i.state <> 'cancelled' AND s.status NOT IN ('ruled_out', 'missed_out')
             AND (c.outcome IS NULL OR c.bought_by_us)
           UNION ALL
           SELECT c.sale_method, c.id, c.sale_method, 'planned', coalesce(c.auction_at, c.eoi_closes_at),
                  coalesce(c.auction_at, c.eoi_closes_at) + interval '30 minutes', p.id,
                  p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number
           FROM campaign c JOIN property p ON p.id = c.property_id
           JOIN property_status s ON s.property_id = p.id
           WHERE c.outcome IS NULL AND s.status NOT IN ('ruled_out', 'missed_out')
             AND coalesce(c.auction_at, c.eoi_closes_at) >= now() - interval '1 day'
             AND coalesce(c.auction_at, c.eoi_closes_at) < now() + %(days)s * interval '1 day'
           ORDER BY starts_at""",
        {"days": days},
    ).fetchall()
    for r in rows:
        suburb = r["suburb"]
        r["address"] = display(Address(**{k: r.pop(k) for k in ("unit", "street_number", "street", "suburb", "postcode",
                                                                   "plan_number", "lot_number")}))
        r["suburb"] = suburb
    return rows


# ─── calendar feed (ICS) ──────────────────────────────────────────────
TITLES = {"open": "Open for inspection", "private": "Private inspection", "second_look": "Second look",
          "building_pest": "Building & pest inspection", "display_suite": "Display suite", "pre_settlement": "Pre-settlement",
          "other": "Inspection", "auction": "Auction", "eoi": "EOI closes"}


def _ics_text(s: str) -> str:
    return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _ics_time(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _ics(events: list[dict], base_url: str) -> str:
    now = _ics_time(datetime.now(timezone.utc))
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//House Track//EN", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:House Track", "X-PUBLISHED-TTL:PT1H"]
    for e in events:
        lines += [
            "BEGIN:VEVENT",
            f"UID:{e['type']}-{e['id']}@housetrack",
            f"DTSTAMP:{now}",
            f"DTSTART:{_ics_time(e['starts_at'])}",
            f"DTEND:{_ics_time(e['ends_at'] or e['starts_at'] + timedelta(minutes=30))}",
            f"SUMMARY:{_ics_text(TITLES.get(e['kind'], 'Inspection') + ': ' + e['address'])}",
            f"LOCATION:{_ics_text(e['address'])}",
            f"URL:{base_url}/p/{e['property_id']}",
            "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT60M", "DESCRIPTION:House Track", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def _base(request: Request) -> str:
    return f"{request.headers.get('x-forwarded-proto', request.url.scheme)}://{request.headers.get('host', request.url.netloc)}"


@router.get("/calendar.ics")
def calendar_feed(request: Request) -> Response:
    """Subscribe to this in the phone's calendar (over the tailnet); it refreshes about hourly."""
    with tx() as conn:
        events = _events(conn, 90)
    return Response(_ics(events, _base(request)), media_type="text/calendar; charset=utf-8")


@router.get("/events/{event_type}/{event_id}.ics")
def one_event(event_type: str, event_id: UUID, request: Request) -> Response:
    with tx() as conn:
        events = [e for e in _events(conn, 36500) if str(e["id"]) == str(event_id) and e["type"] == event_type]
    if not events:
        raise not_found("Event")
    return Response(_ics(events, _base(request)), media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{event_type}.ics"'})


# ─── photos & documents ───────────────────────────────────────────────
ATTACHMENT_SELECT = """SELECT id, property_id, campaign_id, inspection_id, kind, sha256, mime_type, byte_size,
                              original_name, url, source_url, caption, taken_at, created_at, created_by,
                              (SELECT count(*) FROM floorplan_markup m WHERE m.attachment_id = attachment.id) AS markups
                       FROM attachment"""


def attachments_for(conn, property_id: UUID) -> list[dict]:
    rows = conn.execute(ATTACHMENT_SELECT + " WHERE property_id = %s ORDER BY coalesce(taken_at, created_at) DESC",
                        (property_id,)).fetchall()
    for r in rows:  # images carry their size, which the photo viewer needs before they load
        size = blobs.image_size(r["sha256"]) if r["sha256"] and (r["mime_type"] or "").startswith("image/") else None
        r["width"], r["height"] = size or (None, None)
    return rows


@router.post("/properties/{property_id}/attachments", status_code=201)
async def upload(property_id: UUID, person: Person,
                 file: Annotated[UploadFile | None, File()] = None,
                 kind: Annotated[AttachmentKind, Form()] = "photo",
                 caption: Annotated[str | None, Form()] = None,
                 url: Annotated[str | None, Form()] = None,
                 inspection_id: Annotated[UUID | None, Form()] = None) -> dict:
    if (file is None) == (not url):
        raise HTTPException(422, "Upload a file or give a link, not both.")
    sha = mime = name = None
    size = None
    facts: dict = {}
    if file is not None:
        data = await file.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Files are limited to 50 MB.")
        sha, mime, name, size = blobs.store(data), file.content_type or "application/octet-stream", file.filename, len(data)
        if mime.startswith("image/"):
            facts = blobs.image_facts(data, sha)
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        live = conn.execute("SELECT id FROM campaign WHERE property_id = %s ORDER BY (outcome IS NULL) DESC, created_at DESC LIMIT 1",
                            (property_id,)).fetchone()
        needs_campaign = kind in ("price_statement", "vendor_statement", "contract")
        if needs_campaign and live is None:
            raise HTTPException(422, "Vendor documents belong to a campaign. Add the campaign first.")
        row = conn.execute(
            """INSERT INTO attachment (property_id, campaign_id, inspection_id, kind, sha256, mime_type, byte_size,
                                       original_name, url, caption, taken_at, taken_location)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                       CASE WHEN %s::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint(%s, %s), 4326) END)
               RETURNING id""",
            (property_id, live and live["id"], inspection_id, kind, sha, mime if sha else None, size, name,
             url or None, caption, facts.get("taken_at"), facts.get("lon"), facts.get("lon"), facts.get("lat")),
        ).fetchone()
    return {"id": row["id"]}


# ─── the listing's main photo ────────────────────────────────────────
MAX_IMAGE = 15 * 1024 * 1024


class PhotoFromUrl(BaseModel):
    url: str = Field(pattern=r"^https?://", max_length=2000)
    caption: str | None = "From the listing"


def download_image(url: str) -> tuple[bytes, str]:
    return download_file(url, ("image/",), "image/*", "photo")


MAX_DOCUMENT = 25 * 1024 * 1024
DOCUMENT_TYPES = ("application/pdf", "image/")


def download_file(url: str, types: tuple[str, ...] = DOCUMENT_TYPES, accept: str = "application/pdf,image/*",
                  noun: str = "document") -> tuple[bytes, str]:
    from .decide import BROWSER_UA
    limit = MAX_IMAGE if noun == "photo" else MAX_DOCUMENT
    try:
        req = UrlRequest(url, headers={"User-Agent": BROWSER_UA, "Accept": accept})
        with urlopen(req, timeout=30) as r:
            mime = (r.headers.get_content_type() or "").lower()
            data = r.read(limit + 1)
    except (HTTPError, URLError, TimeoutError) as e:
        raise HTTPException(502, f"Couldn't download the {noun} ({getattr(e, 'code', None) or 'no response'}).") from None
    if mime == "application/octet-stream" and data[:5] == b"%PDF-":
        mime = "application/pdf"  # some document portals don't say what they're sending
    if not mime.startswith(types):
        raise HTTPException(422, "That link isn't an image." if noun == "photo" else "That link isn't a PDF or an image.")
    if len(data) > limit:
        raise HTTPException(413, f"That {noun} is over {limit // (1024 * 1024)} MB.")
    return data, mime


def save_photo(property_id: UUID, person, url: str, caption: str | None, kind: str = "photo") -> dict:
    """Keep a copy (listings come down after the sale), once: the same photo twice is one attachment, and a
    link already kept isn't downloaded again."""
    with tx() as conn:
        kept = conn.execute("SELECT id FROM attachment WHERE property_id = %s AND source_url = %s", (property_id, url)).fetchone()
    if kept:
        return {"id": kept["id"], "existing": True}
    data, mime = download_image(url)
    sha = blobs.store(data)
    blobs.image_facts(data, sha)  # also writes the thumbnail
    name = url.split("?")[0].rstrip("/").rsplit("/", 1)[-1][:200] or "listing-photo"
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        same = conn.execute("SELECT id FROM attachment WHERE property_id = %s AND sha256 = %s", (property_id, sha)).fetchone()
        if same:
            conn.execute("UPDATE attachment SET source_url = %s WHERE id = %s AND source_url IS NULL", (url, same["id"]))
            return {"id": same["id"], "existing": True}
        row = conn.execute(
            # A stored file, so no url: an attachment is a file or a link, never both. source_url is where it came from.
            """INSERT INTO attachment (property_id, kind, sha256, mime_type, byte_size, original_name, caption, source_url)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (property_id, kind, sha, mime, len(data), name, caption, url)).fetchone()
    return {"id": row["id"], "existing": False}


def save_photos_later(property_id: UUID, person, urls: list[str], floorplans: list[str] = ()) -> None:
    """A listing's photos (and floor plans) take a while to download, so the house is saved first and these follow,
    in the listing's order (the first becomes the cover). Each gets a second try after a pause: image servers
    sometimes refuse a burst of downloads."""
    import logging
    import threading
    import time
    log = logging.getLogger("house_track.photos")
    jobs = [(u, "From the listing", "photo") for u in urls[:30]] + [(u, "Floor plan (from the listing)", "floorplan") for u in floorplans[:5]]

    def run() -> None:
        failed = []
        for url, caption, kind in jobs:
            try:
                save_photo(property_id, person, url, caption, kind)
            except Exception:  # noqa: BLE001  one bad photo shouldn't stop the rest
                failed.append((url, caption, kind))
        if failed:
            time.sleep(5)
        for url, caption, kind in failed:
            try:
                save_photo(property_id, person, url, caption, kind)
            except Exception as e:  # noqa: BLE001
                log.warning("Couldn't save %s %s for %s: %s", kind, url, property_id, getattr(e, "detail", e))
    threading.Thread(target=run, name="listing-photos", daemon=True).start()


@router.post("/properties/{property_id}/listing-update")
def listing_update(property_id: UUID, body: ListingUpdateIn, person: Person, preview: bool = False) -> dict:
    """A tracked house captured again with the bookmarklet: add what's new (guide, dates, inspections, agents,
    Statement of Information, tags, rooms and areas, photos). Safe to repeat. With ?preview=true it does the
    same work and rolls it back, so the panel shows exactly what Update will do."""
    from .. import listing_apply
    with tx(person) as conn:
        if conn.execute("SELECT 1 FROM property WHERE id = %s", (property_id,)).fetchone() is None:
            raise not_found("Property")
        with conn.transaction(force_rollback=preview):
            added = listing_apply.refresh(conn, property_id, body)
    if preview:
        added["photos"], added["floorplans"] = len(body.photos), len(body.floorplans)
        return added
    from .. import push
    push.listing_changed(property_id, added["changes"], person)
    if body.photos or body.floorplans:
        save_photos_later(property_id, person, body.photos, body.floorplans)
    added["photos"], added["floorplans"] = len(body.photos), len(body.floorplans)
    return added


@router.post("/properties/{property_id}/attachments/from-url", status_code=201)
def photo_from_url(property_id: UUID, body: PhotoFromUrl, person: Person) -> dict:
    return save_photo(property_id, person, body.url, body.caption)


@router.post("/properties/{property_id}/listing-photo", status_code=201)
def listing_photo(property_id: UUID, person: Person) -> dict:
    """Read the house's listing link, find its main photo and keep a copy. Portals often block servers;
    the bookmarklet on the listing page is the fallback."""
    from .. import listing_parse
    from .decide import fetch_page
    with tx() as conn:
        link = conn.execute("""SELECT l.url FROM campaign_link l JOIN campaign c ON c.id = l.campaign_id
                               WHERE c.property_id = %s ORDER BY (c.outcome IS NULL) DESC, c.created_at DESC, l.created_at DESC LIMIT 1""",
                            (property_id,)).fetchone()
    if link is None:
        raise HTTPException(422, "This house has no listing link yet.")
    image = listing_parse.main_image(fetch_page(link["url"]))
    if not image:
        raise HTTPException(422, "Couldn't find a photo on the listing page.")
    return save_photo(property_id, person, image, "From the listing")


@router.post("/attachments/{attachment_id}/keep-copy")
def keep_copy(attachment_id: UUID, person: Person) -> dict:
    """A document saved as a link (say the Statement of Information from a listing): download it into House Track,
    so it opens in the app's viewer, works offline, and survives the link going dead."""
    with tx() as conn:
        row = conn.execute("SELECT url FROM attachment WHERE id = %s", (attachment_id,)).fetchone()
    if row is None:
        raise not_found("Attachment")
    if not row["url"]:
        raise HTTPException(422, "This one is already kept in House Track.")
    data, mime = download_file(row["url"])
    sha = blobs.store(data)
    if mime.startswith("image/"):
        blobs.image_facts(data, sha)
    name = row["url"].split("?")[0].rstrip("/").rsplit("/", 1)[-1][:200] or "document"
    with tx(person) as conn:
        conn.execute("""UPDATE attachment SET sha256 = %s, mime_type = %s, byte_size = %s, original_name = %s,
                               url = NULL, source_url = %s
                        WHERE id = %s""", (sha, mime, len(data), name, row["url"], attachment_id))
    return {"id": attachment_id, "mime_type": mime, "byte_size": len(data)}


class AttachmentPatch(BaseModel):
    kind: AttachmentKind | None = None
    caption: str | None = None


@router.patch("/attachments/{attachment_id}")
def update_attachment(attachment_id: UUID, body: AttachmentPatch, person: Person) -> dict:
    with tx(person) as conn:
        if update_columns(conn, "attachment", attachment_id, body.model_dump(exclude_unset=True)) is None:
            raise not_found("Attachment")
    return {"id": attachment_id}


class CoverIn(BaseModel):
    attachment_id: UUID | None = None  # none: back to the listing's main photo


@router.put("/properties/{property_id}/cover")
def set_cover(property_id: UUID, body: CoverIn, person: Person) -> dict:
    """Choose the house's cover photo (see migration 0006 for the one used when nobody has)."""
    with tx(person) as conn:
        if body.attachment_id is not None and conn.execute(
                "SELECT 1 FROM attachment WHERE id = %s AND property_id = %s AND sha256 IS NOT NULL AND mime_type LIKE 'image/%%'",
                (body.attachment_id, property_id)).fetchone() is None:
            raise HTTPException(422, "That isn't one of this house's photos.")
        if conn.execute("UPDATE property SET cover_photo_id = %s WHERE id = %s RETURNING id",
                        (body.attachment_id, property_id)).fetchone() is None:
            raise not_found("Property")
        cover = conn.execute("SELECT attachment_id FROM property_cover WHERE property_id = %s", (property_id,)).fetchone()
    return {"cover_id": cover and cover["attachment_id"]}


@router.delete("/attachments/{attachment_id}", status_code=204)
def remove_attachment(attachment_id: UUID, person: Person) -> None:
    """Removes the record (audited). The file itself stays in the blob store and in backups."""
    with tx(person) as conn:
        conn.execute("DELETE FROM attachment WHERE id = %s", (attachment_id,))


def _file(attachment_id: UUID) -> dict:
    with tx() as conn:
        row = conn.execute("SELECT sha256, mime_type, original_name FROM attachment WHERE id = %s", (attachment_id,)).fetchone()
    if row is None or row["sha256"] is None:
        raise not_found("File")
    return row


@router.get("/attachments/{attachment_id}/file")
def download(attachment_id: UUID) -> FileResponse:
    row = _file(attachment_id)
    # Immutable content: cache hard, so viewed photos keep working offline.
    return FileResponse(blobs.path_for(row["sha256"]), media_type=row["mime_type"], filename=row["original_name"],
                        content_disposition_type="inline", headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.get("/attachments/{attachment_id}/thumb")
def thumbnail(attachment_id: UUID) -> FileResponse:
    row = _file(attachment_id)
    path = blobs.thumb_path(row["sha256"])
    if not path.exists():
        raise not_found("Thumbnail")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "private, max-age=31536000, immutable"})
