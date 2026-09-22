"""Downloads with a local cache.

A cached file is reused when the source still resolves to the same place and size. Sources that
redirect to a dated file (Geofabrik's `-latest`) are tracked by where they redirect; sources that
don't report a size (GitHub's generated zips) are refreshed after a week.
"""

import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

USER_AGENT = "HouseTrack-setup/0.2 (self-hosted house-hunting app)"
UNSIZED_MAX_AGE_S = 7 * 24 * 3600


def probe(url: str) -> tuple[str, int | None]:
    """(final URL after redirects, total size or None), fetching at most one byte."""
    if not url.startswith(("http://", "https://")):
        return url, None
    req = Request(url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"})
    with urlopen(req, timeout=60) as r:
        final = r.geturl()
        total = re.search(r"/(\d+)$", r.headers.get("Content-Range", ""))
        if total:
            return final, int(total.group(1))
        length = r.headers.get("Content-Length")
        return final, int(length) if r.status == 200 and length else None


def download(url: str, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / Path(urlsplit(url).path).name
    stamp = target.with_name(target.name + ".source")
    final, size = probe(url)
    if target.exists():
        same_source = stamp.exists() and stamp.read_text().strip() == f"{final} {size}"
        fresh_unsized = size is None and time.time() - target.stat().st_mtime < UNSIZED_MAX_AGE_S
        if (size is not None and same_source and target.stat().st_size == size) or fresh_unsized \
                or not url.startswith(("http://", "https://")):
            print(f"fetch: using cached {target.name}", flush=True)
            return target
    print(f"fetch: downloading {final}" + (f" ({size / 1e6:,.0f} MB)" if size else ""), flush=True)
    partial = target.with_name(target.name + ".part")
    with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=120) as r, partial.open("wb") as f:
        shutil.copyfileobj(r, f, length=1 << 22)
    partial.replace(target)
    stamp.write_text(f"{final} {size}")
    return target
