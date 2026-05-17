# Luftbilder-Zeitstrahl (Thüringen)

An interactive map that **merges Thüringen's historical orthophotos and aerial
photographs per time period into a seamless mosaic**, with a **timeline** to
move through the years.

The official portal
([geoportal.thueringen.de → Download Luftbilder und Orthophotos](https://geoportal.thueringen.de/gdi-th/download-offene-geodaten/download-luftbilder-und-orthophotos))
only lets you download single, separate image tiles. This tool stitches the
tiles of one acquisition year back together and lets you scrub through time —
from current orthophotos all the way back to **1945 WWII-era reconnaissance
photography**.

## Run

```bash
cd LuftbilderZeitstrahl
npm install
npm start
```

Then open <http://localhost:3000> (set `PORT` to change the port).

Requires Node ≥ 18 (developed on Node 23).

## Deploy with Docker (GitHub-built image, self-hosted)

GitHub Actions builds and pushes a multi-arch image to the GitHub Container
Registry on every push to `main`/`master` and on `v*` tags
(`.github/workflows/docker.yml`). The image reference is **always lowercase**
(Docker requires it); the workflow lowercases the repo, so this project ships
as `ghcr.io/asamedia/luftbilderzeitstrahl`.

On your own server:

```bash
cp .env.example .env          # IMAGE already set to the lowercase ghcr path
docker compose pull
docker compose up -d
```

App is then on `http://<server>:${HOST_PORT:-3222}` (host port 3222 by
default — 3000 is assumed taken on the server; the container still listens on
3000 internally). Put it behind your own reverse proxy / TLS as usual.

- **Build locally instead of pulling** (from a full repo checkout, *not* in
  Dockge): `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
  The main compose file is pull-only on purpose so stack managers don't try to
  build from a source-less folder.
- **Cache** (processed frames + upstream responses) persists in the named
  volume `lz-cache` mounted at `/data` (`CACHE_DIR=/data`). It's safe to wipe;
  it just rebuilds on demand. First view of a dense aerial year is slow, then
  instant from the volume.
- **Update:** `docker compose pull && docker compose up -d`.
- If GHCR is private, `docker login ghcr.io` on the server first (PAT with
  `read:packages`), or make the package public in GitHub.
- Outbound HTTPS to `*.geoportal-th.de` and `nominatim.openstreetmap.org`
  must be allowed from the server.

## How to use

1. **Search a place** in the top box (e.g. *Weimar*, *Großschwabhausen*) and
   pick a result to fly there — or pan/zoom manually. Either way, zoom in to
   **town level** (zoom ≥ 13); the tool then scans which years have imagery for
   that exact view.
2. Use the **timeline slider** at the bottom to step through the years that
   actually exist there. Controls: **▶ play** (accent-coloured auto-play, set
   apart by a divider), then **❮ back** left of the slider and **❯ forward**
   right of it. Each year is rebuilt as one mosaic.
3. Toggle **Orthophotos** vs **Luftbilder**, change layer **opacity**, show tile
   **outlines**, or overlay the **current statewide DOP** for comparison.
4. **Beste Abdeckung** (aerial photos only, on by default): instead of stacking
   every overlapping frame, show the fewest, sharpest frames that still cover
   the whole view (see below). Untick it to see all frames.
5. The **spotlight card** (top-right; aerial photos) always shows the single
   sharpest frame covering the screen centre, with its year/flight/sharpness
   and a direct original-download link. It follows the map as you pan.
6. Click any image for its metadata and a link to download the original
   GeoTIFF (ZIP).

## How it works

```
Browser (Leaflet)  ──►  Node/Express  ──►  geoportal.geoportal-th.de (dl-lbop)
  timeline + mosaic       proxy + cache       undocumented JSON backend
```

* **`GET /api/years?bbox=&type=`** — probes each candidate year (1943→now) with
  one date-filtered request and returns only the years that have imagery in the
  current viewport. This is what makes the timeline data-aware.
* **`GET /api/tiles?bbox=&type=&from=&to=[&cover=1]`** — fetches the tile
  footprints for one year. The upstream caps responses at 200 features, so the
  server recursively quad-subdivides the area and de-duplicates. With `cover=1`
  (aerial photos) it returns only the sharpest covering subset.
* **`GET /api/preview?type=&id=`** — proxies the georeferenced preview JPEG
  (served same-origin so the browser can place it as a map overlay).
* **`GET /api/download?type=&id=`** — proxies the original full-resolution
  GeoTIFF (ZIP).
* **`GET /api/geocode?q=`** — place search proxied to OpenStreetMap Nominatim,
  restricted to the Thüringen bounding box and cached, so the search box can
  set the User-Agent Nominatim requires and avoid CORS.

Footprints come back in EPSG:25832 (UTM 32N) and are reprojected to WGS84 with
`proj4`. **The server does no image processing** — `/api/preview` just caches
and serves the source preview bytes as-is (for both `op` and `lb`). We used to
trim the dark scan border + feather + re-encode to WebP with `sharp`, but
measurements showed the source previews are already cropped (border ≈ 0 on
2020/1953/1945 samples) and the feather had been reduced to ~2 px, so the
processed output was visually ≈ the raw image while costing nearly all of the
server's CPU. Removing it made the server light and dropped the native
dependency. *Trade-off:* the rare 1940s recon scans that genuinely have a black
border now show it. Frames are placed as **rotated overlays (lb) / axis-aligned
overlays (op) using the provider's footprint ring order** (`corners[0..3]` =
the photo's top-left, top-right, bottom-right, bottom-left; a compass-quadrant
guess used to mis-place rotated flight lines, e.g. around Großschwabhausen).
Upstream responses and preview bytes are cached on disk under `.cache/`, so
revisiting is instant.

**Beste Abdeckung (sharpest covering subset).** Aerial photos overlap heavily
(60–80 %), so a year can stack 100–230 frames over one town. `selectCoverage`
lays a fine grid over the view and assigns every sample to the frame whose
**centre is nearest** — the centre of an aerial photo is its sharpest, least
relief-displaced part (nadir). Frames that win no samples are dropped (coverage
is preserved; the count typically more than halves), and each kept frame
carries a *dominance* = how many samples it owns. The client draws the frames
**opaque, least-dominant first**, so the most-central (sharpest) frame for
every spot ends up on top — each location shows one crisp photo instead of a
soft blend of several. The **spotlight** card picks the centre frame by
nadir-centrality.

## Things worth knowing

* **First scan of a new area takes a few seconds** (≈80 lightweight year
  probes). It is cached afterwards.
* Opening a dense aerial-photo year just streams the source previews (no
  server processing). With **Beste Abdeckung** on (the default) far fewer
  frames are shown; previews are cached on disk so later visits are instant.
* Orthophotos are true rectified mosaics and merge seamlessly. Aerial photos
  are placed by an affine (3-point) fit of their footprint corners — verified
  to land correctly against the current DOP — and shown as the raw source
  preview with central-coverage selection. It is a clean composite but *not* a
  survey-grade orthomosaic: because the frames are un-rectified, relief and
  tilt mean adjacent strips can still disagree by a building's width, so faint
  seams remain (and rare 1940s scans may show a black border). The spotlight
  card sidesteps this by showing one whole frame for the centre.
* **What you see on the map is the source *preview* image** (a few thousand
  pixels per frame), not the full-resolution original. It is sharp at normal
  zoom but will soften if you zoom right in. The full-resolution data (e.g.
  20 cm/px orthophotos) is the GeoTIFF behind each image's **"Original (ZIP)
  herunterladen"** link — the source offers no larger view image.
* The download host serves a certificate whose SAN does not match its hostname;
  the server deliberately skips TLS verification **for that one host**. The data
  is public open government data and no credentials are sent.
* The `dl-lbop` JSON backend is **undocumented** (reverse-engineered from the
  official viewer) and could change without notice.

## Data & licence

Imagery and data: **© GDI-Th**, Thüringer Landesamt für Bodenmanagement und
Geoinformation (TLBG), under
[Datenlizenz Deutschland – Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0).
This project is an independent viewer and is not affiliated with the TLBG.
