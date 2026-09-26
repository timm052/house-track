# Installing House Track on the server

The code lives in a private GitHub repo, [timm052/house-track](https://github.com/timm052/house-track). Tagging a version there (`git tag v0.3.4 && git push --tags`) builds the app images and publishes them to GitHub's container registry, `ghcr.io/timm052/housetrack-{api,web,setup}`. The server pulls them from there. The server never needs the code: the stack's files (`docker-compose.yml`, `.env.example` and the scripts in `deploy/`) travel inside the setup image.

On Unraid, most of the running is done from the GUI:
- **Docker Compose Manager** runs the stack. It has start and stop, logs, settings (the `.env` file) and autostart, and the containers also show on the Docker tab.
- **User Scripts** runs the jobs: the region data, the backup, and the updates to new versions.

## What you need

- Unraid, with two plugins from **Apps**: **Docker Compose Manager** and **User Scripts**.
- A Tailscale account (free). In the admin console:
  - turn on **MagicDNS** and **HTTPS certificates**;
  - create a **reusable auth key**.
- A GitHub token that can read the images. GitHub's registry only accepts **classic** tokens; fine-grained ones don't work with it. To make one on GitHub:
  1. Go to **Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token**.
  2. Tick **only `read:packages`**. That scope can pull your images and nothing else: no access to code, no writes.
  3. Set a long expiry, or none.
- About 4 GB of disk for the data after setup, on a fast disk: use the cache pool.

## 1. Fetch the stack (terminal, once)

This part is typed once in the Unraid terminal (the **>_** icon at the top right of the web UI). It saves the token and unpacks the stack's files into a folder.

```bash
mkdir -p /mnt/user/appdata/housetrack-stack && cd /mnt/user/appdata/housetrack-stack
nano .github-token          # paste the token, then Ctrl+O, Enter, Ctrl+X
chmod 600 .github-token
docker login ghcr.io -u timm052 --password-stdin < .github-token
docker run --rm --entrypoint cat ghcr.io/timm052/housetrack-setup:latest /stack/deploy/update.sh > update.sh
chmod +x update.sh && ./update.sh latest
```

The last command fetches the newest version's files, creates `.env` (with the version already set), and stops there. The folder now holds `docker-compose.yml`, `.env`, `update.sh` and `deploy/`.

## 2. Add the stack in Compose Manager

1. Go to **Docker** and scroll to **Compose**. Click **Add New Stack**.
2. Enter **`housetrack`** as the name. It must be exactly this: it's the stack's name inside the compose file, so the GUI and the scripts manage the same stack.
3. Open **Advanced** and set the path to `/mnt/user/appdata/housetrack-stack`. Click OK.
4. Click the stack's **⚙ → Edit Stack → Env File** and fill in:

   | Setting | Value |
   |---|---|
   | `DATA_DIR` | `/mnt/cache/appdata/housetrack` (the cache pool; `/mnt/user/...` is slow for the database) |
   | `BACKUP_DIR` | a folder on the array, e.g. `/mnt/user/backups/housetrack` |
   | `DB_PASSWORD` | a long random password (only used inside the stack) |
   | `TS_AUTHKEY` | the reusable key from Tailscale |
   | `TS_HOSTNAME` | the app's name on your tailnet, e.g. `house` |

   `VERSION` and `IMAGE_OWNER` are already set at the bottom. Leave them. Save. Don't edit the compose file itself: updates replace it.
5. Click **Compose Up**. The first time, it downloads the images (a few minutes). The API creates the database tables as it starts.
6. Tick **Autostart**, so the stack starts with the array.

The stack's containers (`housetrack-db-1`, `-api-1`, `-web-1`, `-tailscale-1`) now also show on the Docker tab. Their logs are under the stack's **⚙ → Logs**.

## 3. Add the jobs in User Scripts

Go to **Settings → User Scripts → Add New Script**. Give each a name, then use **⚙ → Edit Script** to paste the commands (keep the `#!/bin/bash` line at the top), and set the schedule in the dropdown. For a set time, choose *Custom* and enter the cron line. Any of them can be run from the GUI at any time with **Run Script**, or **Run in background** for the long one.

**housetrack-region-data.** Schedule: *Schedule Disabled*. Run it once now with **Run in background**, then again about once a quarter for new addresses. It loads Victoria's addresses (G-NAF, a 1.9 GB download, about 15–20 minutes), the train stations, and the school zones and locations:

```bash
#!/bin/bash
cd /mnt/user/appdata/housetrack-stack && docker compose --profile setup run --rm setup
```

**housetrack-backup.** Schedule: *Custom* `30 3 * * *`. It writes a database dump (kept 60 days) and a copy of the photos to `BACKUP_DIR`:

```bash
#!/bin/bash
cd /mnt/user/appdata/housetrack-stack && docker compose --profile ops run --rm backup
```

**housetrack-update.** Schedule: *Custom* `0 4 * * *`, to update automatically each night. Choose *Schedule Disabled* instead to update only when you click **Run Script**:

```bash
#!/bin/bash
cd /mnt/user/appdata/housetrack-stack && ./update.sh latest 2>&1 | tee -a update.log
```

It asks the registry for the newest version whose images are all published. If that's newer than what's running, it:
1. takes a backup;
2. fetches the new version's files and sets `VERSION` in `.env`;
3. pulls the images and restarts;
4. runs any one-off steps the new version needs (`deploy/after-update.sh`).

Database changes apply by themselves when the API starts, after a `pre-migrate-*.dump` is written to `BACKUP_DIR/db`. It never moves to an older version. Unraid shows a notification when it updates or when an update fails. The script's log, and `update.log`, have the details.

Compose Manager's own **Update Stack** button only pulls fresh copies of the version already in `.env`. Moving to a new version is this script's job.

## 4. Open the app

On any device signed in to your tailnet, open `https://house.<your-tailnet>.ts.net`, using your `TS_HOSTNAME`. The tailnet name is on the admin console's DNS page. The first visit may take a minute while Tailscale issues the certificate. Name the household's members, then go to **Settings → Choose stations and places**.

If the token expires, make a new one (`read:packages`), put it in `/mnt/user/appdata/housetrack-stack/.github-token`, and run **housetrack-update**.

## Release notes

### 0.4.1

- Fix: Settings and Places could show one person's old copy of the household settings, and save it over someone else's change. The walking limit did this just by clicking in and out of it. These pages now get the latest values each time they open, and changes wait until those arrive.
- Fix: on a house page, tags and **Method and dates** could put back an older copy. They now send only what you changed.
- Sold houses show the sale price on their card, house page and map panel. Beside it: how far over or under the first guide it went, and how it compared with your estimate.
- **Open the full map** on a house page opens the map on that house, with its walking route to the station. **Move pin** opens zoomed in on the house.
- The map colours houses by price, light to dark, with the ranges in the key. The key can switch back to colouring by status.

### 0.4.0

- Floor plans: open a house's floor plan with the **Floor plan** button on its About tab. Look through the saved versions and measure rooms. Press **Edit** to set the scale, draw walls and areas, and try furniture at real size. Everyone in the household sees every version.
- A floor plan can be an image or a PDF, from the listing or uploaded under **Photos & docs**. **Mark up** there opens it ready to edit.

### 0.3.10

- Fix: updating a house from its listing added another copy of the Statement of Information each time. The update merges the copies already added into one. The app backs up the database before it does.
- The Statement of Information is always kept, since agents take it down after the sale.
- Days listed comes from the listing. The weekly refresh fills in the date for houses added from a shared link. Until then it's blank, rather than counted from the day you added the house.
- Shorter, plainer help text and tooltips throughout.

### 0.3.9

- Settings has iPhone steps for both shortcuts:
  - **Add in the background** adds the house with just a notification;
  - **Check it first** opens the filled-in Add form in the browser.

### 0.3.8

- iPhone: share a listing to House Track with no browser. A shortcut sends it in the background and a notification says what happened.
  - A Domain listing becomes a house straight away.
  - A link without an address waits in **Shared from a phone** at the top of the Houses page.
  - The new steps are in the app under **Settings → Adding houses from your phone**. Each person uses their own ID.
- Region data: the stations are downloaded a piece of Victoria at a time, because a busy map server turns away a whole-state request.
- `docker compose --profile setup run --rm setup stations` (naming the steps) now works. Before, the step name was taken as a command.

### 0.3.7

- Region data setup copes with a busy OpenStreetMap server: the stations are asked for again after a pause, and from two other public servers.
- A step that fails no longer stops the rest. Setup names the failed steps at the end, so you can run just those again.

### 0.3.6

- Fix: loading the region data with no steps named (`docker compose --profile setup run --rm setup`, as the region-data job does) stopped with "invalid choice: ['all']".

### 0.3.5

- Add houses from a phone's Share menu: on Android once House Track is installed to the home screen, or on iPhone through a shortcut. Setup steps are in the app under **Settings → Adding houses from your phone**.
  - A shared Domain link fills in the address.
  - The weekly refresh then brings in the rooms, price guide, photos and floor plan.

### 0.3.4

- Fix: a database password with characters such as `#`, `%`, `@` or `/` stopped the API from starting. Any characters work now.

### 0.3.3

- Set up with Unraid's Compose Manager: the stack's compose file is now `docker-compose.yml`, with no build sections. If you installed 0.3.2 from the command line, `update.sh` replaces `compose.yaml` with it.

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

## Useful commands (terminal, from the stack folder)

```bash
docker compose logs -f api          # what the server is doing (routing, statements, errors)
docker compose restart api          # restart the app
docker compose down                 # stop everything (data stays in DATA_DIR)
```

Restore a backup: stop the API, restore the dump, start it again.

```bash
docker compose stop api && docker compose --profile ops run --rm restore <file>.dump && docker compose start api
```
