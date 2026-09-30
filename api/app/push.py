"""Phone notifications (web push): new price guides, inspection times, sales, and houses someone else shortlists.

Each device that turns notifications on gets a subscription from its browser's push service (Apple's or Google's),
kept in push_subscription with the kinds it wants. Sending is signed with this server's own VAPID key, made on
first use and kept next to the blob store. Nothing here needs an account or costs anything. Sending happens on a
background thread, so a slow push service never holds up a request; a subscription the push service says is gone
(404 or 410) is dropped.
"""

import base64
import json
import logging
import os
import threading
from pathlib import Path
from uuid import UUID

from .db import tx

log = logging.getLogger(__name__)

# What a device can ask to hear about.
KINDS = ("guide", "inspections", "sale", "shortlist")
_lock = threading.Lock()


def _key_file() -> Path:
    blobs = Path(os.environ.get("BLOB_DIR", "/data/blobs"))
    return Path(os.environ.get("VAPID_KEY_FILE", str(blobs.parent / "vapid_private.pem")))


def vapid():
    """This server's signing key, made the first time it's needed."""
    from py_vapid import Vapid02
    path = _key_file()
    with _lock:
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            v = Vapid02()
            v.generate_keys()
            v.save_key(str(path))
        return Vapid02.from_file(str(path))


def public_key() -> str:
    """The key a browser needs to subscribe (base64url, uncompressed point)."""
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    raw = vapid().public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _send_one(sub: dict, payload: dict, key) -> bool:
    """Deliver to one device. False when the push service says the subscription is gone."""
    from pywebpush import WebPushException, webpush
    try:
        webpush({"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                json.dumps(payload), vapid_private_key=key,
                vapid_claims={"sub": os.environ.get("VAPID_SUBJECT", "mailto:house-track@example.com")},
                ttl=24 * 3600, timeout=10)
        return True
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            return False
        log.warning("Push to %s failed: %s", sub["endpoint"][:60], status or e)
        return True
    except Exception as e:  # a network hiccup: try again next time
        log.warning("Push to %s failed: %s", sub["endpoint"][:60], e)
        return True


def send(kind: str | None, title: str, body: str, url: str, *, exclude: UUID | None = None, only: UUID | None = None) -> None:
    """Tell every device that wants this kind (not the person who caused it), in the background. No kind: every
    device (a test)."""
    with tx() as conn:
        subs = conn.execute(
            """SELECT id, endpoint, p256dh, auth FROM push_subscription
               WHERE (%s::text IS NULL OR %s = ANY(kinds)) AND (%s::uuid IS NULL OR person_id <> %s) AND (%s::uuid IS NULL OR person_id = %s)""",
            (kind, kind, exclude, exclude, only, only)).fetchall()
    if not subs:
        return
    payload = {"title": title, "body": body, "url": url, "tag": f"{kind}:{url}"}

    def run():
        key = vapid()
        gone = [s["id"] for s in subs if not _send_one(s, payload, key)]
        if gone:
            with tx() as conn:
                conn.execute("DELETE FROM push_subscription WHERE id = ANY(%s)", (gone,))
    threading.Thread(target=run, name="push", daemon=True).start()


# The listing changes worth a notification, by the sentence listing_apply writes for them.
CHANGE_KINDS = (("New price guide", "guide"), ("Sold price", "sale"), ("Sold", "sale"), ("Now under offer", "sale"),
                ("new inspection time", "inspections"))


def listing_changed(property_id: UUID, changes: list[str], actor: UUID | None) -> None:
    """After a listing update: one notification per kind of news, for a house still in play."""
    from .address import Address, display
    with tx() as conn:
        p = conn.execute("""SELECT p.unit, p.street_number, p.street, p.suburb, p.postcode, p.plan_number, p.lot_number, s.status
                            FROM property p JOIN property_status s ON s.property_id = p.id WHERE p.id = %s""",
                         (property_id,)).fetchone()
    if not p or p.pop("status") == "ruled_out":
        return
    where = display(Address(**p)).split(",")[0] + f", {p['suburb']}"
    news: dict[str, list[str]] = {}
    for line in changes:
        kind = next((k for words, k in CHANGE_KINDS if words in line), None)
        if kind:
            news.setdefault(kind, []).append(line.removesuffix(": recorded"))
    for kind, lines in news.items():
        send(kind, where, " · ".join(lines), f"/p/{property_id}", exclude=actor)
