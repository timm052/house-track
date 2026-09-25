# Installing House Track on the server

The code lives in a private GitHub repo, [timm052/house-track](https://github.com/timm052/house-track). Tagging a version there (`git tag v0.3.3 && git push --tags`) builds the app images and publishes them to GitHub's container registry, `ghcr.io/timm052/housetrack-{api,web,setup}`. The server pulls them from there, using `update.sh`:
- it installs the first time and updates after that;
- it can run nightly to keep the app up to date on its own.

The server never needs the code. The stack's files (`compose.yaml`, `.env.example` and the scripts in `deploy/`) travel inside the setup image.

## What you need

- An x86-64 server with Docker and Docker Compose v2. On Unraid, install the **Docker Compose Manager** plugin (it provides `docker compose`) and the **User Scripts** plugin, both from Community Applications.
- A Tailscale account (free). In the admin console:
  - turn on **MagicDNS** and **HTTPS certificates**;
  - create a **reusable auth key**.
- A GitHub token that can read the images. GitHub's registry only accepts **classic** tokens; fine-grained ones don't work with it. To make one on GitHub:
  1. Go to **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.
  2. Tick **only `read:packages`**. That scope can pull your images and nothing else: no access to code, no writes.
  3. Set a long expiry, or none.
- About 4 GB of disk for the data after setup, on a fast disk. On Unraid, use the cache pool.

## First install

The commands are for the Unraid terminal (or SSH).

1. **Make the stack folder and save the token:**

   ```bash
   mkdir -p /mnt/user/appdata/housetrack-stack && cd /mnt/user/appdata/housetrack-stack
   nano .github-token          # paste the token, save
   chmod 600 .github-token
   ```

2. **Get the updater out of the newest image and run it:**

   ```bash
   docker login ghcr.io -u timm052 --password-stdin < .github-token
   docker run --rm --entrypoint cat ghcr.io/timm052/housetrack-setup:latest /stack/deploy/update.sh > update.sh
   chmod +x update.sh
   ./update.sh latest
   ```

   The first run unpacks the stack files, creates `.env` and stops.

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
   ./update.sh latest
   ```

   It pulls the images and starts the stack. The API creates the database tables on first start. Check with `docker compose ps`: `db`, `api`, `web` and `tailscale` should all be running.

5. **Load the region data** once. This fetches Victoria's addresses (G-NAF, a 1.9 GB download, about 15 minutes), the train stations, and the school zones and locations:

   ```bash
   docker compose --profile setup run --rm setup
   ```

6. **Open the app** on any device signed in to your tailnet: `https://house.<your-tailnet>.ts.net`, using your `TS_HOSTNAME`. The first visit may take a minute while Tailscale issues the certificate. Name the household's members, then go to **Settings → Choose stations and places**.

7. **Schedule the nightly jobs** (below): the backup, and automatic updates if you want them.

## Nightly jobs (User Scripts plugin)

Go to **Settings → User Scripts → Add New Script**. For each script, paste the commands in with **Edit Script**, then choose a schedule. For a set time, pick *Custom* and enter the cron line.

**Backup**, daily. It writes a database dump (kept 60 days) and a copy of the photos to `BACKUP_DIR`:

```bash
cd /mnt/user/appdata/housetrack-stack && docker compose --profile ops run --rm backup
```

**Automatic updates**, e.g. at 4am with the custom schedule `0 4 * * *`:

```bash
cd /mnt/user/appdata/housetrack-stack && ./update.sh latest >> update.log 2>&1
```

Each night this asks the registry for the newest version whose images are all published. If that's newer than what's running, it does the whole update:
1. takes a backup;
2. pulls the new images and restarts;
3. runs any one-off steps the new version needs (`deploy/after-update.sh`).

Database changes apply by themselves when the API starts, after a `pre-migrate-*.dump` is written to `BACKUP_DIR/db`. It never moves to an older version. Unraid shows a notification when it updates or when an update fails; `update.log` has the details.

To stay on a version instead, don't schedule it. Run `./update.sh <version>` by hand when you want to update.

## Updating by hand

```bash
cd /mnt/user/appdata/housetrack-stack && ./update.sh latest      # or a specific version: ./update.sh 0.3.3
```

If the token expires, make a new one (`read:packages`) and replace `.github-token`.

## Release notes

### 0.3.2

- Updates come from the images alone: the token only needs `read:packages`, and `./update.sh latest` can run nightly to update automatically.
- A version's one-off steps run by themselves after an update (`deploy/after-update.sh`), so there's nothing extra to do by hand.

### 0.3.1

- Travel times to the zoned schools need the school locations. From 0.3.2 the updater loads them itself; on 0.3.1 run `docker compose --profile setup run --rm setup schools` once.

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
