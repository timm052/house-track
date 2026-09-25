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
