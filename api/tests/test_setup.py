import zipfile

from app.setup import fetch, regions, tiles


def test_assets_keeps_only_the_fonts_and_sprites_the_style_uses(tmp_path, monkeypatch):
    archive = tmp_path / "main.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for name in ("fonts/Noto Sans Regular/0-255.pbf", "fonts/Noto Sans Medium/0-255.pbf",
                     "fonts/Noto Sans Devanagari Regular/0-255.pbf", "sprites/v4/light.json",
                     "sprites/v4/light@2x.png", "sprites/v4/dark.json", "README.md"):
            zf.writestr(f"basemaps-assets-main/{name}", "x")
    monkeypatch.setattr(tiles, "download", lambda url, directory: archive)

    out = tiles.assets(tmp_path / "tiles", tmp_path)
    files = sorted(str(p.relative_to(out)).replace("\\", "/") for p in out.rglob("*") if p.is_file())
    assert files == ["fonts/Noto Sans Medium/0-255.pbf", "fonts/Noto Sans Regular/0-255.pbf",
                     "sprites/v4/light.json", "sprites/v4/light@2x.png"]


def test_cached_download_is_reused_when_source_unchanged(tmp_path, monkeypatch):
    target = tmp_path / "australia-latest.osm.pbf"
    target.write_bytes(b"12345")
    (tmp_path / "australia-latest.osm.pbf.source").write_text("https://x/australia-260921.osm.pbf 5")
    monkeypatch.setattr(fetch, "probe", lambda url: ("https://x/australia-260921.osm.pbf", 5))
    assert fetch.download("https://x/australia-latest.osm.pbf", tmp_path) == target

    # A new dated release behind the same -latest URL means downloading again.
    calls = []
    monkeypatch.setattr(fetch, "probe", lambda url: ("https://x/australia-261221.osm.pbf", 6))
    monkeypatch.setattr(fetch, "urlopen", lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(RuntimeError("fetch")))
    try:
        fetch.download("https://x/australia-latest.osm.pbf", tmp_path)
    except RuntimeError:
        pass
    assert calls, "expected a re-download"


def test_bbox_parsing():
    vic = regions.get("vic")
    assert regions.parse_bbox("", vic) == vic.default_bbox
    assert regions.parse_bbox("145.1,-37.9,145.2,-37.8", vic) == (145.1, -37.9, 145.2, -37.8)
