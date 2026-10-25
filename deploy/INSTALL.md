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

### 0.4.22

- **Floor plans: edit the pieces you place.** A selected piece has square handles to resize it on the plan (from its side, its front or its corner, in 5 cm steps; hold Alt for any size), its own colour (or back to its usual one), and **Mirror** (M) for pieces that aren't the same both ways. The options row under the tools shows these while a piece is selected; the panel has a colour picker too.
- **Custom pieces:** a box and a round item at the top of the list, to name and size as anything that isn't in it (they always show their name).
- **New pieces:** a metal lathe and a benchtop mini lathe (Workshop), and an **Animals** group with a giant panda and a brown bear, sitting down, seen from above at life size.
- No database changes.

### 0.4.21

- **Floor plans: a Door tool.** Click a wall to put a door or window in it: it sits on the wall's centre line, turns with it, takes its thickness and cuts its opening, so the plan shows through. Drag it along the wall to move it, or away from the wall to free it; click anywhere off a wall for one on its own (with a handle to turn it). Kinds: hinged door, double doors, sliding door, cavity slider, barn door, bifold doors, garage door (with the space a panel-lift door swings up into), a plain opening, and a window, each in common widths or any width in mm. **F** flips the hinge, **Shift+F** the swing.
- **Edit mode, tidied:** the tools in groups (Select · Walls, rooms and doors · Areas and notes · Scale and measure) with undo, redo, snapping and fit at the end, and a slim row under them with only what the tool in hand needs: wall thickness, the door's kind, width, hinge and swing, or a colour. The furniture list has a search box; the old fixed door and window pieces are gone from it (plans that use them still show them).
- **Cars:** a small SUV (Mazda CX-30).
- No database changes.

### 0.4.20

- **Floor plans: walls with real thickness.** The **Wall** tool draws walls at a chosen thickness (Internal 110 mm, Brick veneer 250 mm, Double brick 270 mm, or a thin line as before), solid and hatched, with corners mitred and walls that meet joined cleanly. Click the first corner to close a room. While drawing, **type a length** (3.6 or 3600) and press Enter to place the next corner exactly that far, square to the last side or toward the pointer.
- **Room tool:** drag a box to draw four joined walls, with the outside and inside sizes shown as you drag.
- **Better snapping** while drawing: onto existing walls and edges (not just their corners), onto the point where a square line meets a wall, and level with other corners across or down (with a guide to the corner it lined up with).
- A selected wall can be made thicker or thinner (any size in mm), or closed or opened, from the panel; the thickness is in the top bar too while drawing. Older plain lines are unchanged.
- **New furniture groups:**
  - **Workshop:** workbenches, woodwork bench, assembly/outfeed table, tool chest, shelving, table saw with rails, jobsite saw, mitre saw station, bandsaw, drill press, jointer, thicknesser, lathe, dust extractor, compressor.
  - **3D printing & CNC:** open-frame, enclosed and large 3D printers, resin printer with wash/cure, enclosed desktop CNC, 1 m open CNC router, diode and CO₂ lasers.
  - **Pottery studio:** wheel with stool, top- and front-loading kilns, wedging table, slab roller, glaze buckets, ware rack, clay sink with trap, pug mill, spray booth.
- **Cars:** a group of its own, with a small hatch, small car, mid SUV, people mover, ute, full-size ute, van, box trailer, motorbike and bicycle alongside the existing car and large SUV.
- No database changes.

### 0.4.19

- **The walk to the station on a street map**, coloured by its climbs and drops on the way there (warm for climbing, cool for dropping, darker for steeper), with the height profile above it. Pointing at either marks the same spot on the other, with the height and slope there.
- **Ways with less climbing**: other walking routes to the station, including the routing engine's "avoid hills" route, are measured too. Any with at least 3 m less climbing, and not much further, are offered beside the usual way ("12 m less climbing, 110 m further"); picking one shows its profile, map and ratings.
- **Database:** one new column for the other ways (added automatically). Walks already measured are measured again in the background to find them.

### 0.4.18

- Fixed "e.trim is not a function" when adding a house from a listing (sold listings among them) that gives the street number or postcode as a number.
- No database changes.

### 0.4.17

- **The hills on the walk to the station.** Each house's walk to its nearest station is measured from Vicmap's 1 m contours (10 m contours outside Melbourne and the towns, marked as rough): the climbing there and back, the steepest 100 m each way, and how it feels on the flat. Each way is rated like a running route: Flat, Gentle, Rolling, Hilly or Steep. A house's Location tab draws the walk's profile, coloured by how steep each stretch is; the map's house panel and the grid (Getting around) show the rating and the climbing.
- **Walk benchmarks** (Settings): walks you know, to compare with. It starts with 12 Example Street to Testvale station; add more from any address and pick the station. Houses are compared with the main one ("less hilly than…", and a % in the grid).
- **Database:** new tables for walk profiles and benchmarks (added automatically on start-up).

### 0.4.16

- **Blocks on a phone:** the incline and "which way it may fall" choices wrap onto more lines instead of running off the side of the screen, and the size boxes and unit-lots tick fit narrow screens. Checked at Pixel 7 and iPhone SE widths, on the map's Blocks panel, a block's card and Settings → Blocks.
- **Adding a suburb suggests Victoria's suburbs as you type** (from the address data, with postcodes), on the map and in Settings. Enter adds the first match.
- On very small phones (under 375 px wide, like an iPhone SE) the top bar's icons tighten up so every page fits the screen; it used to stretch pages wider than the screen.
- No database changes.

### 0.4.15

- **Map → Blocks, coloured by Fits your preferences**, now shows the near misses in their own colours instead of greying them out: **blue** for a block whose slope and fall suit but is under your smallest size, and **purple** for a block in your size range that's too steep or falls a way you don't want. Fits (green) and slope unknown (amber) are unchanged; everything else stays faint grey.
- No database changes.

### 0.4.14

- **Ruled-out houses stay in the weekly refresh, for prices only.** Their price guide changes, sale method and date, and what they sell for are still picked up (marked **prices only** on the Refresh page), so you learn what they went for. Their inspections, agents, documents, photos and room counts aren't. They're checked after the houses you're still considering.
- **Fixed: an auction recorded as a plain sale.** When a listing turned to Sold, Domain's page often says "private treaty", and the refresh switched the house to private sale before recording the sale: an auction then showed as plain "Sold" instead of sold at auction or sold prior, and lost its auction date. A sold listing no longer changes the sale method or dates.
- **Fixed: the Blocks Areas view could time out** with several suburbs spread across Melbourne (the hexagon grid covered the whole area between them). It's now worked out block by block: 81 s down to under a second in testing.
- **Fixed: a suburb could wait for analysis indefinitely** while the planning-layer service was failing; block analysis now runs on its own.
- Units and apartments no longer show their strata block's size and slope on the Houses list and Grid.
- Links to a section of Settings (Settings → Blocks, the browser buttons) now scroll to it. Re-adding a suburb works at the 25-suburb limit. Blocks show a pointer on the map.
- No database changes.

### 0.4.13

- **Blocks.** Add the suburbs you're searching in **Settings → Blocks** (or from the map), and House Track downloads every property boundary there from Victoria's open map data, with the 1 m contours, roads and planning zones around them, and measures each block: size, frontage, depth, shape (including battle-axe blocks), the fall front to back and side to side, how steep it is, whether it slopes up or down from the street or across, which way the back faces, and how many lots it could be split into under your rules for its zone. A suburb takes about a minute; re-run it now and then for new subdivisions.
- **Block preferences** for the household: a size range, the steepest incline (Flat under 3%, Gentle up to 8%, Moderate up to 15%, or your own %), which ways a block may fall, whether unit lots count, and the subdivision rules by zone.
- **Map → Blocks:** every block in those suburbs, including houses that aren't for sale, coloured by whether it fits, size, slope, which way it falls, whether it could be split, or which way the back faces. Your houses' blocks are outlined. Tap a block for its card, with a drop diagram from the street to the back fence. **Areas** shades hexagons by the share of blocks that fit and lists the streets with the most. Preferences can be tried on the map and then **saved for the household**.
- **Houses:** a slope badge on each card (green when the block fits, amber when it doesn't), the block size where the listing has no land size, and a **Fits our block preferences** filter. **Grid:** a Block group of columns (fits, size, incline, falls, rise to back, frontage, depth, shape, back faces, could split into).
- **A house's Location tab** has **The block** card with the drop diagram, or a button to analyse its suburb.
- Database: migration `0021_blocks` (new tables only). Block outlines are sent compressed (the API now gzips large responses).

### 0.4.12

- **A house's Inspections tab, redesigned.** A tag shows where the house stands on the Inspections page (On To inspect, Already inspected, Passed on, In the list) with the button to change it and the **We've been to this house** tick. Times are split into **Coming up** (Calendar, Not going) and **Earlier** (Went, Cancelled, or "Did you go?" with **I went**, **Didn't go** and **Cancelled by the agent**). **Not going** keeps who removed each time, with **Add back**. Adding a time is one row.
- **Every verdict** is gone from the tab; the Opinions card's History has the same list.
- The Inspections tab count, the About tab's next inspection and the timeline leave out times you're not going to or that were cancelled.
- The sidebar button reads **Inspected · add again** for a house you've been to.
- No database changes.

### 0.4.11

- **Houses:** each house card has a **To inspect** button to put it on, or take it off, the Inspections list. Cards also show an **Inspected** badge once someone has been.
- **A house's Inspections tab** now says where it stands on the Inspections page (on the list, already inspected, or passed on) with a button to add or remove it. **Not going** keeps the inspection in a **Not going** list, with who removed it and **Add back**.
- **We've been to this house** shows only the tick itself; recorded inspections still count.
- No database changes.

### 0.4.10

- **Not going** no longer removes an inspection. It's kept in a **Not going** list under each day on the Inspections page, with who removed it and an **Add back** button.
- **We've been to this house**: a tick on each house's page for houses you've seen without a recorded inspection. The house moves to Already inspected and comes off the To inspect list.
- **Database:** one small new table (added automatically on start-up).

### 0.4.9

- **Better imports from realestate.com.au.** + House Track now reads the address, rooms, price, inspections and agents from the page. **property.com.au** works too, as far as its pages give up their data (rooms, areas, price, listed date, agent, estimate and past sales). Re-drag the + House Track button from Settings (it's version 4).
- **Domain comes first when updating a house.** A capture from realestate.com.au or property.com.au on a house that has a Domain listing only fills gaps and adds new things (inspections, agents, sold). It never overwrites what Domain gave.
- **Not in the weekly refresh?** A house added from another site now says so on its About tab, with **Find it on Domain** and a place to paste the Domain link.
- Capturing a house from Domain that you already have from another site is recognised by its address. Update adds the Domain link.
- Shared realestate.com.au links fill in the suburb and kind of property.
- No database changes.

### 0.4.8

- **Updates** replaces This week. Four numbers at the top (houses to rate, what's coming up, price changes, sales), then a feed of what's happened: guides that moved (with the old range), sales and how they compared to the guide, houses going under offer, houses added, status changes and new inspection times. Unseen items are marked, and your own changes are hidden unless you ask. Beside it: what needs you, what's coming up, the houses you both said yes to, where you disagree, and recent sale results.
- **Inspections**, redesigned: pick a day from the week bar and see it as a timeline with each house's photo, price, rooms and what each of you said. The drive between two inspections is shown between them, with a warning when it's long or you'd be late. Stops are numbered to match a route map. Houses you've already been to, or someone said No to, are set aside in their own lists with **Add again** and **Add back**. **Add to your phone's calendar** is a button at the bottom.
- **Plan the route**, redesigned the same way: a start place, minutes at each stop, when to leave and when you'd be done, a Going / Skipped switch on each stop, and **Open in Google Maps** under the map (fixed at the bottom of the screen on a phone).
- **Clear the day** has been removed.
- The weekly refresh now checks up to 150 houses a run (it was 40).
- Tab names no longer wrap onto two lines.
- No database changes.

### 0.4.7

- **Rate** is its own tab, next to Houses, with a count of the houses you haven't rated yet.
- Rate's photos end with the house's floor plans, shown whole.

### 0.4.6

- **Notifications** on your phone or computer: price guide changes, new inspection times, under offer and sold, and houses the other person shortlists. Turn them on in **Settings → Notifications**, on each device. On iPhone, add House Track to the Home Screen and open it from there first.
- **This week** shows the houses you both said yes to, with a button to add each to To inspect.
- The planner starts from your **To inspect** houses, and lists the ones not open that day with their next inspection.
- Houses you've ruled out, or that sold to someone else, drop off the calendar and the phone calendar feed.
- A sold house without a price keeps being checked by the weekly refresh for two weeks, so a price the agent adds later is picked up.
- The **Rate** button is always on the Houses page.
- Optional: a free ArcGIS key for the satellite photos. Add `ARCGIS_API_KEY=` to `.env` (see `.env.example`).
- Updating adds one new table (backed up first, as usual).

### 0.4.5

- **Rate** new houses one at a time from the Houses page: swipe right for yes, left for no, down for maybe, and up to shortlist. Add a comment if you like. It shows only houses you haven't rated yet.
- A new **To inspect** list: houses you shortlist in Rate go on it, or add one from its page. A house leaves the list once someone records going to an inspection there.
- Sales follow the listing: when a listing says sold, the sale and price are recorded automatically. New **Under offer** and **Sold** tabs replace Results, and "Missed out" is now "Sold".
- Sorting works both ways, and **Date added** sorts by when a house went into House Track.
- Grouped by suburb, streets now sit side by side, each with its own heading.
- Delete a verdict, or one entry in its history, from the house page.
- **Clear the day** on the calendar cancels all of that day's inspections.
- Shorter, plainer wording throughout.
- Updating adds one new table (backed up first, as usual).

### 0.4.4

- The map, redesigned:
  - Search for a house at the top.
  - Key, Layers, Planning, Travel time and Mark an area along the bottom, each opening one tidy panel.
  - On phones the house card starts as a small summary you can drag up, so the map stays in view.
  - Contour lines are one Off / Coarse / Fine choice.
- Map colours reworked for light, dark and satellite:
  - The picked house has a ring round it, and its walk to the station is teal.
  - Stations are neutral, comparable sales are orange, and the travel-time area is violet.
  - Planning layers have their own colours and line styles, including the state's own layers.
  - Labels and contours read clearly over the satellite photos.
- The Houses page, rethought:
  - One search box that suggests filters as you type (a suburb, tag, "3 bed", "land over 600", "townhouse", a person's verdicts).
  - **In play / Shortlist / Results / Ruled out / All**.
  - Filters on anyone's verdicts, and an easy filter on any other field.
  - Grouping by suburb, then street.
- New house cards: tidier, with travel as compact chips, school zones, the sale countdown, a photo count and a Floor plan button.

### 0.4.3

- Photos open full screen in a new viewer: swipe between them, pinch or double-tap to zoom, and drag around a zoomed photo. Portrait photos from phones now show the right way up and the right shape. On a phone, Back closes the viewer. Floor plans open in the floor plan viewer.
- On phones, the photo at the top of a house page is taller (4:3).
- Houses can be grouped by street (**Sort: street, grouped**), streets A to Z and houses by number. The sort you choose is remembered on each device.
- **Add a house** keeps its **Add house** button at the top while you scroll the form.

### 0.4.2

- New statuses, about where you're up to with a house: **Watching**, **Interested**, **Shortlisted**, **Offering**, **Bought**, **Missed out** and **Ruled out**. What happened to the sale (sold, passed in, withdrawn) is shown beside the status, not as one. A house you only watched stays Watching when it sells. The app suggests **Missed out** only if you were Offering, and **Bought** if it's yours. Houses whose sale is over fade and move to the bottom of the list.
- Your houses switch over by themselves when the update starts, after the app backs up the database. Inspecting becomes Interested, Bidding becomes Offering and Rejected becomes Ruled out. Lost becomes Missed out if you'd been bidding; otherwise, like Withdrawn, it goes back to the status the house had before. Saved grid views follow.
- The photo at the top of a house page scrolls through every photo and floor plan. Tap one to see it full screen.
- On phones, a **Map** button on the photo opens the map on the house. The Location tab's map has one too.
- Map **Layers**: satellite photos, and height as hill shading with coarse or fine contour lines. The map's house panel shows the house's height above sea level.

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
