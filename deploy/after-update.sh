#!/bin/bash
# Steps a version needs beyond the database changes (those apply by themselves when the API starts). update.sh runs
# this after every update, with the version it came from and the one it went to. Each step checks whether it's
# needed, so running it again does no harm, and an install that skipped versions still gets every step.
set -euo pipefail
cd "$(dirname "$0")/.."

sql() {  # a single value from the database
  docker compose exec -T db psql -U house -d house -At -c "$1"
}

# The API migrates the database before it starts answering: wait for it to answer.
for _ in $(seq 90); do
  docker compose exec -T api python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/persons', timeout=3)"     > /dev/null 2>&1 && break
  sleep 2
done

# 0.3.1: travel times to the zoned schools need the school locations. Only once the region data has been loaded
# (a fresh install gets them from the full setup run).
if [ "$(sql "SELECT to_regclass('school') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM school)
                  AND EXISTS (SELECT 1 FROM overlay_layer WHERE code = 'vic_school_primary')" 2>/dev/null)" = t ]; then
  echo "Loading the school locations (new in 0.3.1)…"
  docker compose --profile setup run --rm setup schools
fi
