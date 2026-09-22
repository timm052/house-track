"""Forward-only SQL migrations.

Each file in migrations/ is applied once, in filename order, inside its own transaction.
Before applying anything to a database that already has migrations, a pg_dump is written
to BACKUP_DIR so a failed or unwanted migration is rolled back by restoring that dump.
"""

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def pending(conn: psycopg.Connection) -> tuple[list[Path], bool]:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    )
    applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    return [f for f in files if f.stem not in applied], bool(applied)


def dump_before_migrating(database_url: str, backup_dir: str, first_pending: str) -> None:
    Path(backup_dir).mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    target = Path(backup_dir) / f"pre-migrate-{first_pending}-{stamp}.dump"
    subprocess.run(["pg_dump", "-Fc", "-f", str(target), database_url], check=True)
    print(f"migrate: wrote {target}")


def migrate(database_url: str, backup_dir: str | None = None) -> list[str]:
    with psycopg.connect(database_url, autocommit=True) as conn:
        todo, has_history = pending(conn)
        if not todo:
            return []
        if has_history and backup_dir:
            dump_before_migrating(database_url, backup_dir, todo[0].stem)
        for f in todo:
            with conn.transaction():
                conn.execute(f.read_text(encoding="utf-8"))
                conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (f.stem,))
            print(f"migrate: applied {f.stem}")
        return [f.stem for f in todo]


if __name__ == "__main__":
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL is not set")
    migrate(url, os.environ.get("BACKUP_DIR"))
