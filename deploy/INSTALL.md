# Installing House Track on the server

The code lives in a private GitHub repo, [timm052/house-track](https://github.com/timm052/house-track). Tagging a version there (`git tag v0.3.2 && git push --tags`) builds the app images and publishes them to GitHub's container registry, `ghcr.io/timm052/housetrack-{api,web,setup}`. The server pulls them from there. `deploy/update.sh` does the pulling, both for the first install and for every update after it.

## What you need

- An x86-64 server with Docker and Docker Compose v2. On Unraid, install the **Docker Compose Manager** plugin from Community Applications; it provides `docker compose`.
- A Tailscale account (free). In the admin console:
  - turn on **MagicDNS** and **HTTPS certificates**;
  - create a **reusable auth key**.
- A GitHub token so the server can read the private repo and its images. On GitHub:
  1. Go to **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.
  2. Tick the scopes **`repo`** and **`read:packages`**.
  3. Set an expiry, e.g. a year.
- About 4 GB of disk for the data after setup, on a fast disk. On Unraid, use the cache pool.

## First install

The commands are for the Unraid terminal (or SSH).

1. **Make the stack folder and save the token:**

   ```bash
   mkdir -p /mnt/user/appdata/housetrack-stack && cd /mnt/user/appdata/housetrack-stack
   nano .github-token          # paste the token, save
   chmod 600 .github-token
   ```

2. **Fetch the installer and run it:**

   ```bash
   curl -fsSL -H "Authorization: token $(cat .github-token)" \
     https://raw.githubusercontent.com/timm052/house-track/v0.3.1/deploy/update.sh -o update.sh
   chmod +x update.sh
   ./update.sh 0.3.1
   ```

   The first run fetches the stack files, creates `.env` and stops.

3. **Fill in `.env`** with `nano .env`:

   | Setting | Value |
   |---|---|
   | `DATA_DIR` | `/mnt/cache/appdata/housetrack` (the cache pool; `/mnt/user/...` is slow for the database) |
   | `BACKUP_DIR` | a folder on the array, e.g. `/mnt/user/backups/housetrack` |
   | `DB_PASSWORD` | a long random password (only used inside the stack) |
   | `TS_AUTHKEY` | the reusable key from Tailscale |
   | `TS_HOSTNAME` | the app's name on your tailnet, e.g. `house` |

   `update.sh` adds `VERSION` and `IMAGE_OWNER` itself.

4. **Start it:**

   ```bash
   ./update.sh 0.3.1
   ```

   It signs in to GitHub's registry, pulls the images and starts the stack. The API creates the database tables on first start. Check with `docker compose ps`: `db`, `api`, `web` and `tailscale` should all be running.

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

## Updating

When a new version is tagged on GitHub and its build has finished (green under the repo's **Actions** tab), run:

```bash
cd /mnt/user/appdata/housetrack-stack && ./update.sh 0.3.2
```

The script does the whole update:
1. takes a backup;
2. fetches that version's stack files;
3. pulls its images and restarts.

Database changes apply automatically when the API starts. A `pre-migrate-*.dump` is written to `BACKUP_DIR/db` first. Then follow any extra step in the release notes below.

If the token expires, make a new one and replace `.github-token`.

## Release notes

### 0.3.1

- **Extra step when upgrading an existing install:** load the school locations, which give travel times to the zoned schools:

  ```bash
  docker compose --profile setup run --rm setup schools
  ```

- Statements of Information are read automatically. Their comparable sales appear on the map while their house is selected.
- Travel times:
  - drives are peak-hour estimates;
  - public transport arrives by 9 and leaves at 5, with a time on each leg;
  - times to the zoned schools are included.
- The map has a house side panel. Capture keeps photos in listing order and floor plans separately. The weekly refresh can fill in missing details. There's a light/dark switch.

## Without GitHub access

A release bundle (`release/housetrack-<version>.tar.gz`, built on a dev machine with `docker save`) works too:

1. Copy it to the server and unpack it.
2. Load the images:

   ```bash
   docker load -i housetrack-<version>-images.tar.gz
   ```

3. Set `VERSION=<version>` in `.env` and leave `IMAGE_OWNER` unset.
4. Start it:

   ```bash
   docker compose up -d --no-build
   ```

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
