"""Milestone 6: weighted scoring and listing pre-fill."""

from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import listing_parse
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
    html: str = Field(max_length=3_000_000)


BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/140.0 Safari/537.36")


@router.post("/listing/prefill")
def prefill(body: PrefillIn, _: Person) -> dict:
    """Fetch the listing from the server. Often blocked by the portals; the bookmarklet is the fallback."""
    try:
        req = Request(body.url, headers={"User-Agent": BROWSER_UA, "Accept": "text/html", "Accept-Language": "en-AU"})
        with urlopen(req, timeout=15) as r:
            page = r.read(3_000_000).decode("utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError) as e:
        raise HTTPException(502, f"Couldn't read that page ({getattr(e, 'code', None) or 'no response'}). "
                                 "Try the bookmarklet from Settings, or fill the form in.") from None
    return listing_parse.parse(page, body.url)


@router.post("/listing/parse")
def parse_capture(body: CaptureIn, _: Person) -> dict:
    return listing_parse.parse(body.html, body.url)
