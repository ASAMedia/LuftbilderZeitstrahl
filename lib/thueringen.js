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

// Pick the fewest frames that still cover the viewport, preferring, for every
// ground point, the frame that imaged it most centrally — the centre of an
// aerial photo is the sharpest, least relief-displaced part (nadir). Net
// effect: a clean covering mosaic built from the most central view of each
// spot, not 200 stacked frames.
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

// --- preview proxy ----------------------------------------------------------
//
// The server does NO image processing: it just caches and serves the source
// preview bytes. (We used to trim the dark scan border + feather + re-encode
// to WebP with sharp, but measurements showed the source previews are already
// cropped — border ≈ 0 on 2020/1953/1945 samples — and the feather had been
// reduced to ~2 px, so the processed output was visually ≈ the raw image while
// costing most of the server's CPU. Trade-off: the rare 1940s recon scans that
// genuinely have a black border now show it.) Disk cache keeps us off the
// upstream and fast; sniffing the type costs nothing.

const RAW_CACHE_DIR = path.join(CACHE_DIR, 'preview');
fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });

// --- preview cache size budget --------------------------------------------
// The preview cache (RAW_CACHE_DIR) is the dominant disk consumer: each
// preview is a few hundred KB and a heavy browser easily caches thousands of
// frames, so on a small disk it grows without a cap until it fills the host.
// We track the current byte total in memory (incremented on every write,
// decremented on every evict) and, when a write puts us over CACHE_MAX_BYTES,
// delete the oldest files (by mtime — close enough to LRU since each preview
// is written once and never overwritten) until we're back under
// CACHE_TRIM_TARGET (90 %). The small JSON overview cache in CACHE_DIR/*.json
// isn't budgeted: entries are a few KB each and bounded by the number of
// distinct viewport queries. Default budget: 1024 MiB. CACHE_MAX_MB=0 disables
// the cap (let the cache grow unbounded — only safe with manual cleanup or
// host-level quotas).
const _rawCap = process.env.CACHE_MAX_MB;
const CACHE_MAX_MB =
  _rawCap === undefined || _rawCap === ''
    ? 1024
    : Math.max(0, Number(_rawCap) || 0);
const CACHE_MAX_BYTES = CACHE_MAX_MB * 1024 * 1024;
const CACHE_TRIM_TARGET = Math.floor(CACHE_MAX_BYTES * 0.9);

let cacheBytes = 0;
let trimming = false;

function initCacheBudget() {
  try {
    let n = 0;
    for (const name of fs.readdirSync(RAW_CACHE_DIR)) {
      try {
        const stat = fs.statSync(path.join(RAW_CACHE_DIR, name));
        if (stat.isFile()) n += stat.size;
      } catch {
        /* file vanished between readdir and stat — skip */
      }
    }
    cacheBytes = n;
    if (CACHE_MAX_BYTES > 0) {
      console.log(
        `cache: ${(n / 1048576).toFixed(1)} MB present, ` +
          `budget ${CACHE_MAX_MB} MB`
      );
      if (cacheBytes > CACHE_MAX_BYTES) trimCacheToTarget();
    } else {
      console.log(
        `cache: ${(n / 1048576).toFixed(1)} MB present, no budget (CACHE_MAX_MB=0)`
      );
    }
  } catch {
    /* RAW_CACHE_DIR unreadable — leave counter at 0 */
  }
}

function trimCacheToTarget() {
  if (CACHE_MAX_BYTES <= 0) return;
  if (trimming) return; // re-entrancy guard
  trimming = true;
  try {
    const files = [];
    for (const name of fs.readdirSync(RAW_CACHE_DIR)) {
      try {
        const stat = fs.statSync(path.join(RAW_CACHE_DIR, name));
        if (stat.isFile()) {
          files.push({ name, mtime: stat.mtimeMs, size: stat.size });
        }
      } catch {
        /* skip race */
      }
    }
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    let nEv = 0;
    let bEv = 0;
    for (const f of files) {
      if (cacheBytes <= CACHE_TRIM_TARGET) break;
      try {
        fs.unlinkSync(path.join(RAW_CACHE_DIR, f.name));
        cacheBytes = Math.max(0, cacheBytes - f.size);
        nEv++;
        bEv += f.size;
      } catch {
        /* already gone */
      }
    }
    console.log(
      `cache: trimmed ${nEv} file(s) / ${(bEv / 1048576).toFixed(1)} MB → ` +
        `${(cacheBytes / 1048576).toFixed(1)} MB / ${CACHE_MAX_MB} MB`
    );
  } finally {
    trimming = false;
  }
}

function noteCacheWrite(bytes) {
  cacheBytes += bytes;
  if (CACHE_MAX_BYTES > 0 && cacheBytes > CACHE_MAX_BYTES) trimCacheToTarget();
}

initCacheBudget();

function sniffImageType(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

const inFlight = new Map();

/**
 * Preview image for the map: the cached source preview, byte-for-byte.
 * No server-side image processing (see the note above).
 */
export async function getPreview(type, id) {
  if (!['op', 'lb'].includes(type)) throw new Error('bad type');
  if (!/^\d+$/.test(String(id))) throw new Error('bad id');

  const cacheFile = path.join(RAW_CACHE_DIR, type + '_' + id);
  try {
    const buf = fs.readFileSync(cacheFile);
    return { status: 200, buffer: buf, contentType: sniffImageType(buf) };
  } catch {
    /* not cached yet */
  }

  // De-duplicate concurrent upstream fetches for the same frame.
  if (inFlight.has(cacheFile)) return inFlight.get(cacheFile);

  const work = (async () => {
    const up = await fetchImage('preview', type, id);
    if (up.status !== 200) return { status: up.status, buffer: up.body };
    try {
      fs.writeFileSync(cacheFile, up.body);
      noteCacheWrite(up.body.length);
    } catch {
      /* cache is best-effort */
    }
    return {
      status: 200,
      buffer: up.body,
      contentType: up.headers['content-type'] || sniffImageType(up.body),
    };
  })();

  inFlight.set(cacheFile, work);
  try {
    return await work;
  } finally {
    inFlight.delete(cacheFile);
  }
}
