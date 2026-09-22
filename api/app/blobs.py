"""Content-addressed file storage (PLAN.md decision 12): blobs/ab/cd/<sha256>, never modified, so
backups are a copy that skips files already there. Image uploads also get a small WebP thumbnail
under blobs/thumbs/<sha256>.webp."""

import hashlib
import io
import os
from datetime import datetime
from pathlib import Path

from PIL import ExifTags, Image, ImageOps

THUMB_PX = 480


def root() -> Path:
    return Path(os.environ.get("BLOB_DIR", "/data/blobs"))


def path_for(sha256: str) -> Path:
    return root() / sha256[:2] / sha256[2:4] / sha256


def thumb_path(sha256: str) -> Path:
    return root() / "thumbs" / f"{sha256}.webp"


def store(data: bytes) -> str:
    sha = hashlib.sha256(data).hexdigest()
    target = path_for(sha)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(target)
    return sha


def image_facts(data: bytes, sha: str) -> dict:
    """Thumbnail plus the photo's own time and GPS position, when the camera recorded them."""
    try:
        img = Image.open(io.BytesIO(data))
    except Exception:
        return {}
    facts: dict = {}
    exif = img.getexif()
    taken = exif.get_ifd(ExifTags.IFD.Exif).get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
    if taken:
        try:
            facts["taken_at"] = datetime.strptime(str(taken), "%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    if gps and 2 in gps and 4 in gps:
        def deg(v) -> float:
            d, m, s = (float(x) for x in v)
            return d + m / 60 + s / 3600
        lat, lon = deg(gps[2]), deg(gps[4])
        facts["lat"] = -lat if gps.get(1) == "S" else lat
        facts["lon"] = -lon if gps.get(3) == "W" else lon
    target = thumb_path(sha)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        thumb = ImageOps.exif_transpose(img)
        thumb.thumbnail((THUMB_PX, THUMB_PX))
        thumb.convert("RGB").save(target, "WEBP", quality=80)
    return facts
