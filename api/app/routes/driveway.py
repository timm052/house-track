"""Milestone 3: inspections, photos and documents, and the calendar feed."""

from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import blobs
from ..address import Address, display
from ..db import tx
from ..deps import Person, not_found, update_columns

router = APIRouter(prefix="/api")

InspectionKind = Literal["open", "private", "second_look", "building_pest", "display_suite", "pre_settlement", "other"]
InspectionState = Literal["planned", "attended", "skipped", "cancelled"]
AttachmentKind = Literal["photo", "floorplan", "price_statement", "vendor_statement", "contract", "building_report",
                         "pest_report", "strata_report", "strata_certificate", "plans_specs", "other"]
MAX_UPLOAD = 50 * 1024 * 1024


# ─── inspections ──────────────────────────────────────────────────────
class InspectionIn(BaseModel):
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
            """INSERT INTO inspection (property_id, campaign_id, kind, starts_at, ends_at, state, inspector, notes)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (property_id, live and live["id"], body.kind, body.starts_at, ends, body.state, body.inspector, body.notes),
        ).fetchone()
    return {"id": row["id"]}


@router.patch("/inspections/{inspection_id}")
def update_inspection(inspection_id: UUID, body: InspectionPatch, person: Person) -> dict:
    with tx(person) as conn:
        if update_columns(conn, "inspection", inspection_id, body.model_dump(exclude_unset=True)) is None:
            raise not_found("Inspection")
    return {"id": inspection_id}


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
    rows = conn.execute(
        """SELECT 'inspection' AS type, i.id, i.kind, i.state, i.starts_at, i.ends_at, p.id AS property_id,
                  p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number
           FROM inspection i JOIN property p ON p.id = i.property_id
           WHERE i.starts_at >= now() - interval '1 day' AND i.starts_at < now() + %(days)s * interval '1 day'
             AND i.state <> 'cancelled'
           UNION ALL
           SELECT c.sale_method, c.id, c.sale_method, 'planned', coalesce(c.auction_at, c.eoi_closes_at),
                  coalesce(c.auction_at, c.eoi_closes_at) + interval '30 minutes', p.id,
                  p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number
           FROM campaign c JOIN property p ON p.id = c.property_id
           WHERE c.outcome IS NULL AND coalesce(c.auction_at, c.eoi_closes_at) >= now() - interval '1 day'
             AND coalesce(c.auction_at, c.eoi_closes_at) < now() + %(days)s * interval '1 day'
           ORDER BY starts_at""",
        {"days": days},
    ).fetchall()
    for r in rows:
        r["address"] = display(Address(**{k: r.pop(k) for k in ("unit", "street_number", "street", "suburb", "postcode",
                                                                   "plan_number", "lot_number")}))
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
                              original_name, url, caption, taken_at, created_at, created_by FROM attachment"""


def attachments_for(conn, property_id: UUID) -> list[dict]:
    return conn.execute(ATTACHMENT_SELECT + " WHERE property_id = %s ORDER BY coalesce(taken_at, created_at) DESC",
                        (property_id,)).fetchall()


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


class AttachmentPatch(BaseModel):
    kind: AttachmentKind | None = None
    caption: str | None = None


@router.patch("/attachments/{attachment_id}")
def update_attachment(attachment_id: UUID, body: AttachmentPatch, person: Person) -> dict:
    with tx(person) as conn:
        if update_columns(conn, "attachment", attachment_id, body.model_dump(exclude_unset=True)) is None:
            raise not_found("Attachment")
    return {"id": attachment_id}


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
