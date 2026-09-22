# House Track

A self-hosted app for a household buying a house: every candidate property, each person's opinions, campaign and price history, and relists. [PLAN.md](PLAN.md) has the design, the domain model and the decision log.

**Status: all planned milestones (1–6) are built.** What it does:

- **Houses (phone):** every candidate as a card, with quick filters (this week, sale method, your verdict, hide your excluded, suburb), sorting, and the same saved views as Overview.
- **Overview (desktop):** an Excel-like grid of every house and every field. Edit in place, paste ranges, fill down, undo, filter and sort each column, save shared views, export CSV. If both of you edit the same field at once, the second save is stopped and you choose whose value to keep.
- **Per-person verdicts** before and after inspecting, with history, and a **"We disagree"** list of houses where your verdicts differ.
- **Campaigns and money:** price guides over time (with a chart), joint reserve estimate, expected sale and walk-away limit, agents, outcomes and relists, comparable sales, a due-diligence checklist, and all-in costs including Victorian stamp duty and the most you can afford to bid.
- **Auction day:** your limit shown large, one-tap bid increments, a bid log, and a hard stop before recording a bid of ours over the limit.
- **Map:** every house on a locally served basemap, areas each person draws (yours grey houses out for you only; your partner sees a "flagged by" badge), and school zones and planning overlays (flood, bushfire, heritage, vegetation, residential zones) as layers.
- **Pins and travel:** address autocomplete and automatic pins from G-NAF, with free OpenStreetMap search as a fallback and a manual pin always available. Walking time to your chosen stations, and walking and driving time to places like work (favourite up to five).
- **Driveway mode (phone):** GPS finds the house you're standing at; three big buttons record a verdict with a dictated note; the camera uploads photos. With no signal, verdicts and notes wait on the phone and send when you're back online.
- **Inspections and calendar:** inspection times with each person's notes, and a calendar feed your phone subscribes to (inspections, auctions, EOI closings, with a reminder).
- **Scores:** each of you scores houses 1–5 against your own weighted criteria; see totals, compare 2–4 houses side by side.
- **Listing import:** paste a listing link, or use the bookmarklet from Settings, and the Add form fills itself in for you to check. ⚠ This reads the listing sites' pages, so it can break whenever they change.
- **Photos and documents:** photos (thumbnails, dates from the camera) and documents such as the Section 32 and building report, or links to them.

## Run it

You need Docker with Compose, and a Tailscale account (free). The app is only reachable over your tailnet.

1. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS certificates**, then create a reusable auth key.
2. Copy `.env.example` to `.env` and fill it in.
3. Start it:

   ```bash
   docker compose up -d --build
   ```

4. Load the region data for all of Victoria. By default this loads G-NAF addresses (1.9 GB download, about 15 minutes), the station list from OpenStreetMap, and the school zones:

   ```bash
   docker compose --profile setup run --rm setup
   ```

   Everything else streams from free public services: the basemap (OpenFreeMap), planning overlays (Vicmap WMS for the map, plus a one-off WFS lookup per house that is saved), and walking and driving times (the FOSSGIS Valhalla server, one request per second). Re-run setup about once a quarter to pick up new addresses. Steps can be run on their own, for example `... run --rm setup gnaf`.

   Optional, for offline use: `... run --rm setup tiles osm` downloads a basemap extract and the OpenStreetMap network (about 1 GB more). Then start local routing with `docker compose --profile local-routing up -d` and set `VALHALLA_URL=http://valhalla:8002` in `.env`. The local basemap is only used if it covers all of Victoria, or when the device is offline.

5. Open `https://house.<your-tailnet>.ts.net` (use your `TS_HOSTNAME`) on any device signed in to your tailnet, and name the household's members. Then go to **Settings → Choose stations and places**.

Database migrations run automatically when the API starts. If the database already has data, a `pre-migrate-*.dump` is written to `BACKUP_DIR/db` first.

## Backups

Nightly (on Unraid, schedule this with the User Scripts plugin):

```bash
docker compose --profile ops run --rm backup && docker compose --profile ops run --rm offsite
```

`backup` writes a timestamped `pg_dump` to `BACKUP_DIR/db` (kept for 60 days) and mirrors photos to `BACKUP_DIR/blobs`. `offsite` copies the backup folder to `OFFSITE_TARGET` with rclone over the tailnet. Configure the rclone remote in `DATA_DIR/rclone/rclone.conf`.

Restore (stops the API, replaces the database, restarts):

```bash
docker compose stop api && docker compose --profile ops run --rm restore house-20260922T020000.dump && docker compose start api
```

## Unraid

Put `DATA_DIR` on a cache-pool path such as `/mnt/cache/appdata/housetrack`; PostgreSQL is slow through `/mnt/user`. Put `BACKUP_DIR` on an array share. Run the stack with the Compose Manager plugin. The stack brings its own Tailscale sidecar, so Unraid's built-in Tailscale integration isn't needed for this app. Plan for about 4 GB in `DATA_DIR` after setup (downloads cache and G-NAF); add about 2 GB, plus 2 GB of RAM, if you run local tiles and Valhalla.

## Develop

Run a local stack without Tailscale on `http://localhost:8080`:

```bash
docker compose -p housetrack-dev -f compose.yaml -f compose.dev.yaml --env-file .env.dev up -d --build
```

Offline mode and GPS need HTTPS, so test those on the real deployment. The dev stack doesn't call public Nominatim (`NOMINATIM_URL` is empty in `.env.dev`).

To try the map, routing and station list without the multi-gigabyte downloads, load a synthetic street grid near Box Hill (`MSYS_NO_PATHCONV=1` is only needed in Git Bash on Windows):

```bash
cd api && uv run python -m tests.osm_fixture ../.dev-data/downloads/fixture.osm && cd ..
```

```bash
docker compose -p housetrack-dev -f compose.yaml -f compose.dev.yaml --env-file .env.dev --profile setup run --rm --entrypoint osmium setup cat --overwrite -o /downloads/fixture.osm.pbf /downloads/fixture.osm
```

```bash
docker compose -p housetrack-dev -f compose.yaml -f compose.dev.yaml --env-file .env.dev --profile setup run --rm -e OSM_EXTRACT_URL=file:///downloads/fixture.osm.pbf -e BBOX=145.10,-37.84,145.14,-37.80 setup osm tiles
```

API tests run against a scratch PostGIS server:

```bash
docker run -d --name housetrack-testdb -e POSTGRES_USER=house -e POSTGRES_PASSWORD=house -p 55432:5432 postgis/postgis:18-3.6
```

```bash
cd api && TEST_ADMIN_URL=postgresql://house:house@localhost:55432/postgres uv run pytest
```

Frontend: `cd web && npm install && npm run dev` (proxies `/api` to `localhost:8000`; run the API with `uv run uvicorn app.main:app --reload` and `DATABASE_URL` set).

### Layout

| Path | What |
|---|---|
| `api/migrations/` | Forward-only SQL migrations. `0001_schema_v1.sql` is the signed-off domain model. |
| `api/app/` | FastAPI app: `migrate.py` (runner + pre-migration dump), `address.py` (normaliser, the fallback property key), `gnaf.py` (address lookups), `worker.py` (background geocoding and routing), `routes/`. |
| `api/app/setup/` | Region data setup: G-NAF loader, OSM clip and station list, basemap extract, school zones and planning overlays; `regions.py` is the region pack list. |
| `api/tests/` | Unit tests, plus integration tests that exercise the schema's own rules. |
| `web/src/` | React SPA (installable phone app): houses, Overview grid, map, driveway, auction, calendar, compare; `outbox.ts` is the offline queue. |
| `compose.yaml` | Production stack; `compose.dev.yaml` overrides it for local use. |
| `.github/workflows/images.yml` | Tests, then publishes multi-arch images to GitHub's container registry on a `v*` tag. |
| `deploy/serve.json` | Tailscale HTTPS front-end config. |

## Publishing

When the repo goes public (planned after milestone 2): push it to GitHub, then tag a release (`git tag v0.2.0 && git push --tags`). The workflow runs the tests and publishes `ghcr.io/<owner>/housetrack-{api,setup,web}`. Make the packages public in GitHub's package settings. Other households then set `IMAGE_OWNER` and `VERSION` in `.env` and skip `--build`.

## Data sources

G-NAF © Geoscape Australia (Open G-NAF EULA). Map data © OpenStreetMap contributors (ODbL); basemap tiles by OpenFreeMap (or Protomaps when installed locally); stations via the Overpass API; routing by Valhalla on the FOSSGIS server. School zones © State of Victoria (Department of Education), and Vicmap Planning © State of Victoria, both via DataVic (CC BY 4.0). Geocoding fallback by Nominatim/OpenStreetMap (usage policy: at most one request per second, which the worker respects).

## Licence

MIT.
