// Client for the Thüringen "Download Luftbilder und Orthophotos" backend.
//
// The official portal (dl-lbop) exposes an undocumented JSON endpoint that the
// reverse-engineered map app uses:
//
//   GET _ajax/overview.php?crs=EPSG:25832&bbox=minE,minN,maxE,maxN&type=op|lb
//                          [&minDate=ISO&maxDate=ISO]
//     -> GeoJSON FeatureCollection of image-tile footprints. Each feature has
//        properties: gid, type (op|lb), datum, bildflugnr, bildnr.
//     -> Hard limit: 200 features, otherwise {success:false,reason:"tooManyObjects"}.
//
//   GET preview.php?type=op|lb&id=<gid>  -> georeferenced JPEG (~2 MP)
//   GET download.php?type=op|lb&id=<gid> -> original GeoTIFF as ZIP (tens of MB)
//
// op = Orthophoto (rectified, axis-aligned footprint -> exact image overlay)
// lb = Luftbild / raw aerial photograph (rotated quadrilateral footprint)
//
// EPSG:4326 output from overview.php is rounded to whole degrees (unusable), so
// we always query in EPSG:25832 (UTM 32N, metre precision) and reproject here.

import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proj4 from 'proj4';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://www.geoportal.geoportal-th.de/gaialight-th/_apps/dladownload';

// The download host serves a certificate whose SAN does not match the
// hostname. The data is public open government data (Datenlizenz DE 2.0) and
// the request carries no credentials, so we deliberately skip verification for
// this host only.
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

proj4.defs(
  'EPSG:25832',
  '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs'
);
const toWgs = proj4('EPSG:25832', 'EPSG:4326');
const toUtm = proj4('EPSG:4326', 'EPSG:25832');

// CACHE_DIR can point at a mounted volume in container deployments.
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
fs.mkdirSync(CACHE_DIR, { recursive: true });

function rawGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      u,
      { method: 'GET', agent: insecureAgent, timeout: 45000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}

function cacheKey(parts) {
  return parts.join('_').replace(/[^a-zA-Z0-9._-]/g, '');
}

function readCache(key) {
  try {
    const f = path.join(CACHE_DIR, key + '.json');
    const stat = fs.statSync(f);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify(value));
  } catch {
    /* cache is best-effort */
  }
}

// --- projection helpers -----------------------------------------------------

export function lonLatBboxToUtm([minLon, minLat, maxLon, maxLat]) {
  // Project all four corners and take the axis-aligned envelope so the UTM box
  // safely covers the WGS84 viewport despite grid convergence.
  const corners = [
    toUtm.forward([minLon, minLat]),
    toUtm.forward([maxLon, minLat]),
    toUtm.forward([maxLon, maxLat]),
    toUtm.forward([minLon, maxLat]),
  ];
  const es = corners.map((c) => c[0]);
  const ns = corners.map((c) => c[1]);
  return [Math.min(...es), Math.min(...ns), Math.max(...es), Math.max(...ns)];
}

function ringUtmToLonLat(ring) {
  return ring.map(([e, n]) => {
    const [lon, lat] = toWgs.forward([e, n]);
    return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
  });
}

// --- overview.php with recursive quad subdivision ---------------------------

async function overviewRaw({ bbox, type, minDate, maxDate }) {
  const key = cacheKey([
    'ov',
    type,
    ...bbox.map((v) => Math.round(v)),
    minDate || 'x',
    maxDate || 'x',
  ]);
  const cached = readCache(key);
  if (cached) return cached;

  const qs = new URLSearchParams({
    crs: 'EPSG:25832',
    bbox: bbox.join(','),
    type,
  });
  if (minDate) qs.set('minDate', minDate);
  if (maxDate) qs.set('maxDate', maxDate);

  const { status, body } = await rawGet(`${BASE}/_ajax/overview.php?${qs}`);
  if (status !== 200) throw new Error(`overview.php HTTP ${status}`);
  let json;
  try {
    json = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('overview.php: invalid JSON response');
  }
  writeCache(key, json);
  return json;
}

const MIN_CELL_M = 200; // stop subdividing below this UTM box size
const MAX_DEPTH = 7;

async function fetchQuad({ bbox, type, minDate, maxDate, depth = 0 }, acc) {
  const json = await overviewRaw({ bbox, type, minDate, maxDate });

  if (json && json.success && json.result) {
    for (const f of json.result.features || []) acc.set(f.properties.gid, f);
    return;
  }

  const tooMany = json && json.reason === 'tooManyObjects';
  const [minE, minN, maxE, maxN] = bbox;
  const w = maxE - minE;
  const h = maxN - minN;

  if (tooMany && depth < MAX_DEPTH && w > MIN_CELL_M && h > MIN_CELL_M) {
    const midE = (minE + maxE) / 2;
    const midN = (minN + maxN) / 2;
    const quads = [
      [minE, minN, midE, midN],
      [midE, minN, maxE, midN],
      [minE, midN, midE, maxN],
      [midE, midN, maxE, maxN],
    ];
    await Promise.all(
      quads.map((q) =>
        fetchQuad({ bbox: q, type, minDate, maxDate, depth: depth + 1 }, acc)
      )
    );
    return;
  }
  // Either an unexpected payload or we hit the subdivision floor: nothing more
  // we can retrieve for this cell. Caller still gets whatever siblings found.
}

function yearOf(props) {
  if (props.datum) {
    const m = /^(\d{4})/.exec(props.datum);
    if (m) return Number(m[1]);
  }
  if (props.bildflugnr) {
    const m = /^(\d{4})/.exec(props.bildflugnr);
    if (m) return Number(m[1]);
  }
  return null;
}

function pointInPoly(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function readSharpness(gid) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(IMG_CACHE_DIR, `lb_${gid}.${CACHE_VER}.json`),
        'utf8'
      )
    ).s;
  } catch {
    return null;
  }
}

// Pick the fewest frames that still cover the viewport, preferring, for every
// ground point, the frame that imaged it most centrally — the centre of an
// aerial photo is the sharpest, least relief-displaced part (nadir). When a
// frame's measured sharpness is known (cached from processing) it breaks ties
// between near-equally-central candidates. Net effect: a clean covering mosaic
// built from the sharpest available view of each spot, not 200 stacked frames.
function selectCoverage(features, [minLon, minLat, maxLon, maxLat]) {
  if (features.length <= 4) return features;

  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const dist2 = (ax, ay, bx, by) => {
    const dx = (ax - bx) * kx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  };

  const prepped = features.map((f) => {
    const ring = f.geometry.coordinates[0];
    const pts = ring.slice(0, 4);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { f, ring, cx, cy, wins: 0 };
  });

  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  const cols = 140;
  const rows = Math.max(
    20,
    Math.min(220, Math.round((cols * latSpan) / (lonSpan * kx || 1)))
  );

  // For every ground sample, the owner is the frame whose CENTRE is nearest
  // (the photo centre = nadir = sharpest, least relief-displaced). Counting how
  // many samples each frame owns gives a "dominance" the client uses to stack
  // the sharpest frame on top, so every spot shows a single crisp photo
  // instead of a soft blend of several overlapping ones.
  for (let r = 0; r < rows; r++) {
    const lat = minLat + ((r + 0.5) / rows) * latSpan;
    for (let c = 0; c < cols; c++) {
      const lon = minLon + ((c + 0.5) / cols) * lonSpan;
      let best = null;
      let bestD = Infinity;
      for (const pr of prepped) {
        if (!pointInPoly(lon, lat, pr.ring)) continue;
        const d = dist2(lon, lat, pr.cx, pr.cy);
        if (d < bestD) {
          bestD = d;
          best = pr;
        }
      }
      if (best) best.wins++;
    }
  }

  const sel = prepped.filter((pr) => pr.wins > 0);
  if (!sel.length) return features;
  for (const pr of sel) pr.f.properties.quality = pr.wins;
  return sel.map((pr) => pr.f);
}

/**
 * Fetch all image-tile footprints for a WGS84 viewport, optionally limited to a
 * single calendar year, reprojected to lon/lat GeoJSON for the browser. With
 * `cover`, returns only the sharpest covering subset (see selectCoverage).
 */
export async function fetchTiles({ bboxWgs, type, from, to, cover }) {
  const bbox = lonLatBboxToUtm(bboxWgs);
  let minDate, maxDate;
  if (from) minDate = `${from}-01-01T00:00:00.000Z`;
  if (to) maxDate = `${to}-12-31T23:59:59.000Z`;
  const acc = new Map();
  await fetchQuad({ bbox, type, minDate, maxDate }, acc);

  const features = [];
  for (const f of acc.values()) {
    const ringUtm = f.geometry?.coordinates?.[0];
    if (!ringUtm || ringUtm.length < 4) continue;
    const ring = ringUtmToLonLat(ringUtm);
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        gid: f.properties.gid,
        type: f.properties.type,
        datum: f.properties.datum || null,
        year: yearOf(f.properties),
        bildflugnr: f.properties.bildflugnr || null,
        bildnr: f.properties.bildnr || null,
        // cached focus score (null until the frame has been processed once)
        sharp: type === 'lb' ? readSharpness(f.properties.gid) : null,
        // axis-aligned envelope (Leaflet L.imageOverlay bounds)
        bounds: [
          [Math.min(...lats), Math.min(...lons)],
          [Math.max(...lats), Math.max(...lons)],
        ],
        // first 4 polygon corners for rotated (lb) overlays: [lat,lon]
        corners: ring.slice(0, 4).map(([lo, la]) => [la, lo]),
      },
    });
  }

  const total = features.length;
  const out =
    cover && type === 'lb' ? selectCoverage(features, bboxWgs) : features;
  return { type: 'FeatureCollection', features: out, total };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

// Cheapest possible "is there imagery for this year here" test: one
// date-filtered, non-recursive overview call. Enumerating every footprint is
// infeasible for raw aerial frames (Luftbilder), which overlap heavily across
// all decades and saturate the 200-feature cap on every cell; the cap itself
// ("tooManyObjects") is a reliable positive signal that data exists.
async function probeYear(bbox, type, year) {
  const json = await overviewRaw({
    bbox,
    type,
    minDate: `${year}-01-01T00:00:00.000Z`,
    maxDate: `${year}-12-31T23:59:59.000Z`,
  });
  if (json && json.reason === 'tooManyObjects') {
    return { year, count: 200, capped: true };
  }
  if (json && json.success && json.result) {
    const n = (json.result.features || []).length;
    return n > 0 ? { year, count: n, capped: false } : null;
  }
  return null;
}

const FIRST_YEAR = 1943; // earliest campaign the source advertises

/**
 * Acquisition years that actually have imagery for a WGS84 viewport and
 * product type. Drives the data-aware timeline.
 */
export async function fetchYears({ bboxWgs, type }) {
  const bbox = lonLatBboxToUtm(bboxWgs);
  const nowYear = new Date().getFullYear();
  const candidates = [];
  for (let y = FIRST_YEAR; y <= nowYear; y++) candidates.push(y);

  const results = await mapLimit(candidates, 8, (y) =>
    probeYear(bbox, type, y).catch(() => null)
  );
  return results
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);
}

export async function fetchImage(kind, type, id) {
  if (!['op', 'lb'].includes(type)) throw new Error('bad type');
  if (!/^\d+$/.test(String(id))) throw new Error('bad id');
  const file = kind === 'download' ? 'download.php' : 'preview.php';
  return rawGet(`${BASE}/${file}?type=${type}&id=${id}`);
}

// --- preview cosmetics ------------------------------------------------------
//
// Raw aerial-photo scans (lb) have a wide near-black frame plus an annotation
// strip, and a year's frames overlap heavily. Drawn as-is they stack into a
// mess of black rectangles. We detect the photo content by trimming the dark
// border, then build a soft-edged alpha mask *at the original pixel size* so
// the footprint geo-registration is untouched: the border becomes fully
// transparent and the remaining edge feathers, so overlapping frames blend
// into one smooth composite. Orthophotos (op) are already clean rectified
// mosaics and are passed through untouched.

const IMG_CACHE_DIR = path.join(CACHE_DIR, 'img');
fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

// Cap the working resolution just below the source preview (scans are up to
// ~3000–4400 px). 1100 px was too aggressive — frames looked pixelated as soon
// as you zoomed in. 3000 keeps nearly all source detail; "Beste Abdeckung"
// (default) and the concurrency cap keep processing time bounded, and results
// are cached. Bump CACHE_VER whenever this (or the pipeline) changes so old
// lower-res cache entries are regenerated instead of served stale.
const PREVIEW_MAX_PX = 3000;
const CACHE_VER = 'v5';

async function featherLuftbild(buf) {
  const base = await sharp(buf, { failOn: 'none' })
    .resize({ width: PREVIEW_MAX_PX, height: PREVIEW_MAX_PX, fit: 'inside', withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });
  const small = base.data;
  const W = base.info.width;
  const H = base.info.height;
  if (!W || !H) return null;

  let cl = 0;
  let ct = 0;
  let cw = W;
  let ch = H;
  try {
    const t = await sharp(small)
      .trim({ background: '#000000', threshold: 38 })
      .toBuffer({ resolveWithObject: true });
    cw = t.info.width;
    ch = t.info.height;
    cl = -(t.info.trimOffsetLeft || 0);
    ct = -(t.info.trimOffsetTop || 0);
    // Implausible trim (mostly-dark photo, or nothing trimmed): keep full frame
    // and let the feather alone soften the edges.
    if (cw < W * 0.3 || ch < H * 0.3) {
      cl = ct = 0;
      cw = W;
      ch = H;
    }
  } catch {
    /* trim can fail on uniform images; fall back to full frame */
  }

  // Keep frame edges essentially HARD. Feathering makes overlapping frames
  // cross-dissolve, and because raw photos are relief-displaced that blend
  // reads as blur. The source previews are almost always already cropped
  // (border ≈ 0) so we only need ~2 px of anti-alias; the feather still widens
  // automatically to cover a real scan border on the rare frames that have one.
  const minDim = Math.min(cw, ch);
  const borderPx = Math.max(cl, ct, W - cl - cw, H - ct - ch);
  const F = Math.max(
    2,
    Math.min(Math.round(minDim * 0.035), Math.round(borderPx))
  );
  const inset = Math.round(F * 0.5);
  const x = cl + inset;
  const y = ct + inset;
  const rw = Math.max(1, cw - 2 * inset);
  const rh = Math.max(1, ch - 2 * inset);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
       <defs><filter id="b" x="-25%" y="-25%" width="150%" height="150%">
         <feGaussianBlur stdDeviation="${(F / 2).toFixed(1)}"/></filter></defs>
       <rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="${F}" ry="${F}"
             fill="#fff" filter="url(#b)"/>
     </svg>`
  );
  const mask = await sharp(svg).png().toBuffer();

  const webp = await sharp(small)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .webp({ quality: 82, effort: 2, alphaQuality: 90 })
    .toBuffer();

  // Focus measure (std-dev of a Laplacian) over the photo content only — used
  // to prefer genuinely sharper frames when building the covering mosaic.
  let sharpScore = null;
  try {
    const L = Math.max(0, Math.min(W - 2, Math.round(cl)));
    const T = Math.max(0, Math.min(H - 2, Math.round(ct)));
    const RW = Math.max(2, Math.min(W - L, Math.round(cw)));
    const RH = Math.max(2, Math.min(H - T, Math.round(ch)));
    const st = await sharp(small)
      .extract({ left: L, top: T, width: RW, height: RH })
      .resize(360, 360, { fit: 'inside' })
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
      .stats();
    sharpScore = +st.channels[0].stdev.toFixed(2);
  } catch {
    /* sharpness is an optional refinement */
  }

  return { webp, sharp: sharpScore };
}

// Bound concurrent sharp pipelines so a 200-frame year doesn't thrash CPU and
// memory (the browser already caps connections, but this protects the server
// regardless of how requests arrive).
function makeSemaphore(n) {
  let active = 0;
  const q = [];
  const pump = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    Promise.resolve()
      .then(fn)
      .then(res, rej)
      .finally(() => {
        active--;
        pump();
      });
  };
  return (fn) =>
    new Promise((res, rej) => {
      q.push({ fn, res, rej });
      pump();
    });
}
const procLimit = makeSemaphore(4);

const inFlight = new Map();

/**
 * Preview image for the map. lb → border-trimmed + edge-feathered WebP
 * (cached on disk, original dimensions preserved). op → upstream JPEG as-is.
 */
export async function getPreview(type, id) {
  if (!['op', 'lb'].includes(type)) throw new Error('bad type');
  if (!/^\d+$/.test(String(id))) throw new Error('bad id');

  if (type === 'op') {
    const up = await fetchImage('preview', 'op', id);
    return {
      status: up.status,
      buffer: up.body,
      contentType: up.headers['content-type'] || 'image/jpeg',
    };
  }

  const cacheFile = path.join(IMG_CACHE_DIR, `lb_${id}.${CACHE_VER}.webp`);
  try {
    return {
      status: 200,
      buffer: fs.readFileSync(cacheFile),
      contentType: 'image/webp',
    };
  } catch {
    /* not cached yet */
  }

  // De-duplicate concurrent requests for the same frame (a year can request
  // the same tile from several overlapping viewport queries at once).
  if (inFlight.has(id)) return inFlight.get(id);

  const work = (async () => {
    const up = await fetchImage('preview', 'lb', id);
    if (up.status !== 200) return { status: up.status, buffer: up.body };
    let out;
    try {
      out = await procLimit(() => featherLuftbild(up.body));
    } catch {
      out = null;
    }
    if (!out || !out.webp) {
      return {
        status: 200,
        buffer: up.body,
        contentType: up.headers['content-type'] || 'image/jpeg',
      };
    }
    try {
      fs.writeFileSync(cacheFile, out.webp);
      if (out.sharp != null) {
        fs.writeFileSync(
          path.join(IMG_CACHE_DIR, `lb_${id}.${CACHE_VER}.json`),
          JSON.stringify({ s: out.sharp })
        );
      }
    } catch {
      /* cache is best-effort */
    }
    return { status: 200, buffer: out.webp, contentType: 'image/webp' };
  })();

  inFlight.set(id, work);
  try {
    return await work;
  } finally {
    inFlight.delete(id);
  }
}
