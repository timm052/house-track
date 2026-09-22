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
