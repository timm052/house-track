# Installing House Track from a release bundle

A release bundle is a folder with everything the server needs. Nothing is downloaded from a registry.

```
housetrack-<version>/
  housetrack-<version>-images.tar.gz   the app images: api, web and setup
  compose.yaml                         the stack
  deploy/serve.json                    Tailscale's HTTPS settings
  .env.example                         settings to copy to .env
  INSTALL.md                           this file
```

The database, Tailscale, rclone and (optionally) Valhalla images are public. The server pulls them itself the first time.

## What you need

- An x86-64 server with Docker and Docker Compose v2. On Unraid, install the **Docker Compose Manager** plugin from Community Applications, which provides `docker compose`.
- A Tailscale account (free). In the admin console:
  - turn on **MagicDNS** and **HTTPS certificates**;
  - create a **reusable auth key**.
- About 4 GB of disk for the data after setup, on a fast disk. On Unraid, use the cache pool.

## First install

The commands below are for the Unraid terminal (or SSH). Adjust the paths for another server.

1. **Copy the bundle to the server**, for example to `/mnt/user/appdata/housetrack-stack/`. Using the SMB share `\\tower\appdata` from Windows is fine.

2. **Load the images:**

   ```bash
   cd /mnt/user/appdata/housetrack-stack
   docker load -i housetrack-0.3.0-images.tar.gz
   ```

   It prints three `Loaded image: ghcr.io/housetrack/housetrack-…:0.3.0` lines.

3. **Create the settings file:**

   ```bash
   cp .env.example .env
   nano .env
   ```

   Set these:

   | Setting | Value |
   |---|---|
   | `DATA_DIR` | `/mnt/cache/appdata/housetrack` (the cache pool; `/mnt/user/...` is slow for the database) |
   | `BACKUP_DIR` | a folder on the array, e.g. `/mnt/user/backups/housetrack` |
   | `DB_PASSWORD` | a long random password (only used inside the stack) |
   | `TS_AUTHKEY` | the reusable key from Tailscale |
   | `TS_HOSTNAME` | the app's name on your tailnet, e.g. `house` |
   | `VERSION` | `0.3.0` (remove the `#` in front of it) |

   Leave `IMAGE_OWNER` commented out. The images are named `ghcr.io/housetrack/...`.

4. **Start it.** `--no-build` uses the loaded images:

   ```bash
   docker compose up -d --no-build
   ```

   The API creates the database tables on first start. Check with `docker compose ps`: `db`, `api`, `web` and `tailscale` should all be running.

5. **Load the region data** once. This fetches Victoria's addresses (G-NAF, a 1.9 GB download, about 15 minutes), the train stations, and the school zones and locations:

   ```bash
   docker compose --profile setup run --rm setup
   ```

6. **Open the app** on any device signed in to your tailnet: `https://house.<your-tailnet>.ts.net`, using your `TS_HOSTNAME`. The first visit may take a minute while Tailscale issues the certificate. Name the household's members, then go to **Settings → Choose stations and places**.

7. **Set up backups** with the **User Scripts** plugin, running nightly:

   ```bash
   cd /mnt/user/appdata/housetrack-stack && docker compose --profile ops run --rm backup
   ```

   The backup writes a database dump (kept 60 days) and a copy of the photos to `BACKUP_DIR`. For an off-site copy as well, see "Backups" in the README.

## Upgrading to a new bundle

1. Take a backup first:

   ```bash
   docker compose --profile ops run --rm backup
   ```

2. Copy the new bundle's files over the old ones. Keep your `.env`.
3. Load the images and set the new version:

   ```bash
   docker load -i housetrack-<version>-images.tar.gz
   ```

   Then change `VERSION=` in `.env` to the new version.
4. Restart:

   ```bash
   docker compose up -d --no-build
   ```

   Database changes apply automatically when the API starts. A `pre-migrate-*.dump` is written to `BACKUP_DIR/db` first.
5. Follow any extra step in the release notes below.

## Release notes

### 0.3.0

- **Extra step when upgrading:** load the school locations, which give travel times to the zoned schools:

  ```bash
  docker compose --profile setup run --rm setup schools
  ```

- Statements of Information are read automatically. Their comparable sales appear on the map while their house is selected.
- Travel times:
  - drives are peak-hour estimates;
  - public transport arrives by 9 and leaves at 5, with a time on each leg;
  - times to the zoned schools are included.
- The map has a house side panel. Capture keeps photos in listing order and floor plans separately. The weekly refresh can fill in missing details. There's a light/dark switch.

## Useful commands

```bash
docker compose logs -f api          # what the server is doing (routing, statements, errors)
docker compose restart api          # restart the app
docker compose down                 # stop everything (data stays in DATA_DIR)
```

Restore a backup: stop the API, restore the dump, start it again.

```bash
docker compose stop api && docker compose --profile ops run --rm restore <file>.dump && docker compose start api
```
