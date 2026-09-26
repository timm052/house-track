"""The setup command's arguments: none means everything (the region-data job runs it bare)."""

import pytest

from app.setup import __main__ as setup


@pytest.mark.parametrize("argv, expected", [([], setup.DEFAULT_STEPS), (["all"], setup.DEFAULT_STEPS), (["schools"], {"schools"}),
                                            (["gnaf", "schools"], {"gnaf", "schools"})])
def test_steps(monkeypatch, argv, expected):
    seen = {}

    class Stop(Exception):
        pass

    def stop(*args, **kwargs):  # stop before touching a database, having read the steps
        raise Stop
    monkeypatch.setattr("sys.argv", ["setup", *argv])
    monkeypatch.setenv("DATABASE_URL", "postgresql://nowhere/none")
    monkeypatch.setattr(setup, "migrate", stop)
    monkeypatch.setattr("builtins.print", lambda *a, **k: seen.setdefault("line", a[0]))
    with pytest.raises(Stop):
        setup.main()
    assert seen["line"].endswith(f"steps {sorted(expected)}")


def test_a_failed_step_does_not_stop_the_others(monkeypatch, capsys):
    done = []
    monkeypatch.setattr("sys.argv", ["setup", "stations", "schools"])
    monkeypatch.setenv("DATABASE_URL", "postgresql://nowhere/none")
    monkeypatch.setattr(setup, "migrate", lambda url: None)

    def busy(bbox):
        raise RuntimeError("no Overpass server answered")
    monkeypatch.setattr(setup.osm, "overpass_stations", busy)
    monkeypatch.setattr(setup.overlays, "load_schools", lambda *a, **k: done.append("schools"))
    with pytest.raises(SystemExit) as stopped:
        setup.main()
    assert stopped.value.code == 1 and done == ["schools"]
    assert "run --rm setup stations" in capsys.readouterr().out


def test_overpass_falls_back_to_another_server(monkeypatch):
    import io
    import json
    from urllib.error import HTTPError
    from app.setup import osm
    asked = []

    def fake_urlopen(req, timeout):
        asked.append(req.full_url)
        if "overpass-api.de" in req.full_url:
            raise HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
        return io.BytesIO(json.dumps({"elements": [{"type": "node", "id": 1, "lon": 145.0, "lat": -37.8,
                                                     "tags": {"name": "Box Hill", "railway": "station"}}]}).encode())
    monkeypatch.setattr(osm, "urlopen", fake_urlopen)
    monkeypatch.delenv("OVERPASS_URL", raising=False)
    got = osm.overpass_stations((144.0, -39.0, 146.0, -37.0))
    # Every piece: refused by the first server, answered by the next; the station on every piece is one station.
    assert [s["name"] for s in got] == ["Box Hill"] and len(asked) == 2 * osm.TILES[0] * osm.TILES[1]


def test_steps_given_the_old_way(monkeypatch):
    """`setup python -m app.setup schools`, as scripts written for images without an entrypoint say it."""
    seen = {}

    class Stop(Exception):
        pass

    def stop(*args, **kwargs):
        raise Stop
    monkeypatch.setattr("sys.argv", ["setup", "python", "-m", "app.setup", "schools"])
    monkeypatch.setenv("DATABASE_URL", "postgresql://nowhere/none")
    monkeypatch.setattr(setup, "migrate", stop)
    monkeypatch.setattr("builtins.print", lambda *a, **k: seen.setdefault("line", a[0]))
    with pytest.raises(Stop):
        setup.main()
    assert seen["line"].endswith("steps ['schools']")
