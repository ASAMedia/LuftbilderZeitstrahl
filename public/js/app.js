'use strict';

// Below this zoom the viewport covers too many ~2 MP tiles to merge
// responsibly; we ask the user to zoom in instead.
const MIN_ZOOM = 13;
const PLAY_INTERVAL_MS = 1800;

const map = L.map('map', { zoomControl: true, minZoom: 7 }).setView(
  [50.91, 11.03],
  9
);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap',
}).addTo(map);

// Live statewide "current" orthophoto mosaic (reference / comparison layer).
const currentDop = L.tileLayer.wms(
  'https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP',
  {
    layers: 'th_dop',
    format: 'image/png',
    version: '1.3.0',
    transparent: false,
    maxZoom: 21,
    attribution: '© GDI-Th',
  }
);

const imageryLayer = L.layerGroup().addTo(map);
const outlineLayer = L.layerGroup();

const state = {
  type: 'op',
  years: [], // [{ year, count }]
  features: [],
  idx: 0,
  opacity: 1,
  cover: true,
  showOutlines: false,
  playing: false,
  playTimer: null,
  tileToken: 0,
  yearsToken: 0,
};

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const slider = el('epochSlider');
const label = el('epochLabel');

function setStatus(msg, loading) {
  if (!msg) return statusEl.classList.add('hidden');
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
  statusEl.classList.toggle('loading', !!loading);
}

const progressEl = el('progress');
const progressBar = el('progressBar');
let progTimer = null;

// v: 'hidden' | 'indeterminate' | a number 0..100
function showBar(v) {
  if (v === 'hidden') {
    progressEl.classList.add('hidden');
    progressEl.classList.remove('indeterminate');
    progressBar.style.width = '0';
    return;
  }
  progressEl.classList.remove('hidden');
  if (v === 'indeterminate') {
    progressEl.classList.add('indeterminate');
    progressBar.style.width = '';
  } else {
    progressEl.classList.remove('indeterminate');
    progressBar.style.width = Math.max(0, Math.min(100, v)) + '%';
  }
}

// Poll the actual <img> elements of the current overlays so the user sees
// real progress while the server is still trimming/feathering frames (the
// status text otherwise jumped to "done" the moment overlays were added).
function trackImageProgress(token, layers, finalMsg) {
  if (progTimer) {
    clearInterval(progTimer);
    progTimer = null;
  }
  const total = layers.length;
  if (!total) {
    showBar('hidden');
    setStatus(finalMsg);
    return;
  }
  const tick = () => {
    if (token !== state.tileToken) {
      clearInterval(progTimer);
      progTimer = null;
      return; // a newer load now owns the bar
    }
    let settled = 0;
    let failed = 0;
    for (const l of layers) {
      // Rotated overlays put the loading <img> in `_rawImage`; getElement()
      // there is just the placement DIV. Plain ImageOverlay → getElement().
      const e = l._rawImage || (l.getElement && l.getElement());
      if (e && e.tagName === 'IMG' && e.complete) {
        settled++;
        if (e.naturalWidth === 0) failed++;
      }
    }
    const pct = Math.round((settled / total) * 100);
    if (settled < total) {
      showBar(pct);
      setStatus(`Verarbeite Bilder … ${pct}% (${settled}/${total})`, true);
    } else {
      clearInterval(progTimer);
      progTimer = null;
      showBar(100);
      setTimeout(() => {
        if (token === state.tileToken) showBar('hidden');
      }, 450);
      setStatus(finalMsg + (failed ? ` · ${failed} fehlgeschlagen` : ''));
    }
  };
  tick();
  progTimer = setInterval(tick, 300);
}

const productName = () => (state.type === 'op' ? 'Orthophotos' : 'Luftbilder');
const currentYear = () =>
  state.years.length ? state.years[state.idx].year : null;

function updateLabel() {
  const y = currentYear();
  label.textContent = y ? String(y) : '–';
  // max must be set before value, or the browser clamps value to the old max.
  slider.max = Math.max(0, state.years.length - 1);
  slider.value = state.idx;
  slider.disabled = state.years.length === 0;
}

// --- viewport bbox helper ---------------------------------------------------

function viewportBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
}

// --- data-driven year axis --------------------------------------------------

let yearsTimer = null;
function scheduleRefresh() {
  if (state.playing || exporting) return; // viewport frozen during render/export
  clearTimeout(yearsTimer);
  yearsTimer = setTimeout(refreshYears, 350);
}

async function refreshYears() {
  if (map.getZoom() < MIN_ZOOM) {
    imageryLayer.clearLayers();
    outlineLayer.clearLayers();
    state.years = [];
    updateLabel();
    showBar('hidden');
    setStatus('Zum Laden der Bilder näher heranzoomen (Stadt-/Ortsebene).');
    return;
  }

  const token = ++state.yearsToken;
  const prevYear = currentYear();
  setStatus(`Suche ${productName()} …`, true);
  showBar('indeterminate');

  let data;
  try {
    data = await fetch(
      `/api/years?bbox=${viewportBbox()}&type=${state.type}`
    ).then((r) => r.json());
  } catch {
    if (token === state.yearsToken) {
      showBar('hidden');
      setStatus('Fehler beim Laden der Daten.');
    }
    return;
  }
  if (token !== state.yearsToken) return; // superseded by a newer viewport

  state.years = (data && data.years) || [];
  if (!state.years.length) {
    imageryLayer.clearLayers();
    outlineLayer.clearLayers();
    updateLabel();
    showBar('hidden');
    setStatus(`Keine ${productName()} in diesem Bereich.`);
    return;
  }

  // Keep the user on the same year across pans when still available,
  // otherwise jump to the most recent year here.
  const keep = state.years.findIndex((y) => y.year === prevYear);
  state.idx = keep >= 0 ? keep : state.years.length - 1;
  updateLabel();
  loadTiles();
}

// --- corner mapping for rotated (Luftbild) overlays ------------------------

// The source footprint ring is ordered to the photo's own corners:
// corners[0..3] = image top-left, top-right, bottom-right, bottom-left
// (verified against axis-aligned frames; rotated campaigns keep the same order,
// which is why their footprints look "turned" — that is the true flight
// orientation). L.imageOverlay.rotated wants topleft, topright, bottomleft.
// A compass-quadrant guess (the previous approach) mis-assigned corners on any
// rotated frame, e.g. around Großschwabhausen.
function imageCorners(corners) {
  if (!corners || corners.length < 4) return null;
  const tl = corners[0];
  const tr = corners[1];
  const bl = corners[3];
  // reject degenerate footprints (avoids a NaN/zero-area overlay)
  const area = Math.abs(
    (tr[1] - tl[1]) * (bl[0] - tl[0]) - (tr[0] - tl[0]) * (bl[1] - tl[1])
  );
  return area > 1e-9 ? [tl, tr, bl] : null;
}

// --- per-year tile mosaic ---------------------------------------------------

// Build a single tile overlay (rotated for lb, axis-aligned for op) — shared
// by the normal load path and the cinematic playback.
function createTileLayer(p, opacity, interactive) {
  const src = `/api/preview?type=${p.type}&id=${p.gid}${p.type === 'lb' ? '&v=5' : ''}`;
  let layer;
  if (p.type === 'lb' && L.imageOverlay.rotated) {
    const rc = imageCorners(p.corners);
    if (rc) {
      layer = L.imageOverlay.rotated(
        src,
        L.latLng(rc[0]),
        L.latLng(rc[1]),
        L.latLng(rc[2]),
        { opacity, interactive }
      );
    }
  }
  if (!layer) layer = L.imageOverlay(src, p.bounds, { opacity, interactive });
  if (p.quality != null && layer.setZIndex) layer.setZIndex(Math.round(p.quality));
  return layer;
}

async function loadTiles() {
  const y = currentYear();
  if (y == null) return;

  const token = ++state.tileToken;
  if (progTimer) {
    clearInterval(progTimer);
    progTimer = null;
  }
  setStatus(`Lade ${y} …`, true);
  showBar('indeterminate');

  const useCover = state.type === 'lb' && state.cover;
  let fc;
  try {
    fc = await fetch(
      `/api/tiles?bbox=${viewportBbox()}&type=${state.type}&from=${y}&to=${y}` +
        (useCover ? '&cover=1' : '')
    ).then((r) => r.json());
  } catch {
    if (token === state.tileToken) {
      showBar('hidden');
      setStatus('Fehler beim Laden der Bilder.');
    }
    return;
  }
  if (token !== state.tileToken) return;

  imageryLayer.clearLayers();
  outlineLayer.clearLayers();

  const feats = (fc && fc.features) || [];
  state.features = feats;
  if (!feats.length) {
    showBar('hidden');
    setStatus(`Keine ${productName()} für ${y} in diesem Bereich.`);
    updateSpotlight();
    return;
  }

  // Draw the least-dominant frames first so the most-central (sharpest) frame
  // for each spot ends up on top — opaque, no cross-dissolve blur.
  const ordered = feats
    .slice()
    .sort((a, b) => (a.properties.quality || 0) - (b.properties.quality || 0));

  const layers = [];
  for (const f of ordered) {
    const p = f.properties;
    const layer = createTileLayer(p, state.opacity, true);

    layer.bindPopup(
      `<div class="tile-popup">
         <b>${p.type === 'op' ? 'Orthophoto' : 'Luftbild'} · ${y}</b><br>
         Bildflug: ${p.bildflugnr || '–'} · Bild: ${p.bildnr || '–'}<br>
         Aufnahme: ${p.datum ? p.datum.slice(0, 10) : '–'}<br>
         <a class="dl" href="/api/download?type=${p.type}&id=${p.gid}">Original (ZIP) herunterladen</a>
       </div>`
    );
    imageryLayer.addLayer(layer);
    layers.push(layer);

    if (state.showOutlines) {
      outlineLayer.addLayer(
        L.polygon(
          f.geometry.coordinates[0].map(([lo, la]) => [la, lo]),
          {
            color: p.type === 'op' ? '#a51ff0' : '#f0a51f',
            weight: 1,
            fill: false,
          }
        )
      );
    }
  }

  const finalMsg =
    useCover && fc.total > feats.length
      ? `${y} · ${feats.length} schärfste Bilder (von ${fc.total}) – Fläche abgedeckt`
      : `${y} · ${feats.length} ${productName()}-Kacheln zusammengesetzt`;

  // Keep the bar/percent live until the frames have actually loaded
  // (server-side processing can lag well behind overlay creation).
  trackImageProgress(token, layers, finalMsg);
  updateSpotlight();
}

// --- "sharpest image for the screen centre" spotlight ----------------------

function pointInRing(lat, lon, ring) {
  // ring = [[lon,lat], …]
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

const spotEl = el('spotlight');
let spotGid = null;

function updateSpotlight() {
  // Hidden during a cinematic render; only meaningful for aerial frames.
  if (state.playing || state.type !== 'lb' || !state.features || !state.features.length) {
    spotEl.classList.add('hidden');
    spotGid = null;
    return;
  }
  const c = map.getCenter();
  let best = null;
  let bestScore = -Infinity;
  for (const f of state.features) {
    const ring = f.geometry.coordinates[0];
    if (!pointInRing(c.lat, c.lng, ring)) continue;
    const p = f.properties;
    // Prefer measured sharpness; fall back to how centrally this frame sees
    // the screen centre (nadir = sharpest, least relief-displaced).
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 4; i++) {
      cx += ring[i][0];
      cy += ring[i][1];
    }
    cx /= 4;
    cy /= 4;
    const d = Math.hypot(c.lng - cx, c.lat - cy);
    const score = (p.sharp != null ? p.sharp * 1000 : 0) - d;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best) {
    spotEl.classList.add('hidden');
    spotGid = null;
    return;
  }
  if (best.gid !== spotGid) {
    spotGid = best.gid;
    el('spotImg').src = `/api/preview?type=lb&id=${best.gid}&v=5`;
    el('spotMeta').innerHTML =
      `<b>${best.year || '–'}</b> · Bildflug ${best.bildflugnr || '–'}` +
      `<br>Bild ${best.bildnr || '–'}` +
      (best.sharp != null ? ` · Schärfe ${Math.round(best.sharp)}` : '');
    el('spotDl').href = `/api/download?type=lb&id=${best.gid}`;
  }
  spotEl.classList.remove('hidden');
}

function applyOpacity() {
  imageryLayer.eachLayer((l) => l.setOpacity && l.setOpacity(state.opacity));
}

// --- step / play ------------------------------------------------------------

function setIdx(i) {
  if (!state.years.length) return;
  if (state.playing) stopPlayback(false); // manual step cancels the render
  state.idx = Math.max(0, Math.min(state.years.length - 1, i));
  updateLabel();
  loadTiles();
}

// --- cinematic timeline render ---------------------------------------------
// Plays through every year available for the CURRENT viewport, cross-fading
// between mosaics (preloading the next year while the current one shows) with
// a big center-bottom year that animates on each change.

const PLAY_DWELL_MS = 1600; // how long each year stays fully visible
const PLAY_FADE_MS = 650; // cross-fade duration
const PLAY_LOAD_TIMEOUT = 12000; // don't stall a slow dense year forever

let playToken = 0;
const pbGroups = new Set();

const sleepCancellable = (ms, cancelled) =>
  new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cancelled() || Date.now() - t0 >= ms) {
        clearInterval(iv);
        res();
      }
    }, 80);
  });

const tween = (ms, step) =>
  new Promise((res) => {
    const t0 = performance.now();
    const fr = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      step(k);
      k < 1 ? requestAnimationFrame(fr) : res();
    };
    requestAnimationFrame(fr);
  });

function setGroupOpacity(group, v) {
  group.eachLayer((l) => l.setOpacity && l.setOpacity(v));
}

function whenSettled(layers, timeoutMs, onProgress) {
  return new Promise((res) => {
    if (!layers.length) return res();
    const t0 = Date.now();
    const iv = setInterval(() => {
      let s = 0;
      for (const l of layers) {
        const e = l._rawImage || (l.getElement && l.getElement());
        if (e && e.tagName === 'IMG' && e.complete) s++;
      }
      if (onProgress) onProgress(s / layers.length);
      if (s >= layers.length || Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        res();
      }
    }, 200);
  });
}

// Build one year's overlay group for a fixed bbox and add it to the map at
// opacity 0 (adding is what makes Leaflet start downloading the images).
async function buildYearGroup(bbox, type, cover, year, isValid) {
  let feats = [];
  try {
    const fc = await fetch(
      `/api/tiles?bbox=${bbox}&type=${type}&from=${year}&to=${year}` +
        (cover ? '&cover=1' : '')
    ).then((r) => r.json());
    feats = (fc && fc.features) || [];
  } catch {
    /* treated as an empty year */
  }
  // Playback was stopped while this (possibly pre-)load was in flight — don't
  // attach an orphan group to the map.
  if (isValid && !isValid()) return { group: null, layers: [] };
  const group = L.layerGroup();
  const layers = [];
  feats
    .slice()
    .sort((a, b) => (a.properties.quality || 0) - (b.properties.quality || 0))
    .forEach((f) => {
      const layer = createTileLayer(f.properties, 0, false);
      group.addLayer(layer);
      layers.push(layer);
    });
  group.addTo(map);
  pbGroups.add(group);
  setGroupOpacity(group, 0);
  return { group, layers };
}

function setBigYear(y) {
  const e = el('bigYear');
  e.textContent = y;
  e.classList.remove('hidden', 'anim');
  void e.offsetWidth; // restart the pop animation
  e.classList.add('anim');
}

function dropGroup(g) {
  if (g) {
    map.removeLayer(g);
    pbGroups.delete(g);
  }
}

async function startPlayback() {
  if (state.playing || !state.years.length) return;
  state.playing = true;
  el('playBtn').textContent = '⏸';
  el('playBtn').title = 'Zeitraffer stoppen';

  const token = ++playToken;
  const bbox = viewportBbox();
  const type = state.type;
  const cover = type === 'lb' && state.cover;
  const alive = () => state.playing && token === playToken;

  imageryLayer.clearLayers();
  outlineLayer.clearLayers();
  spotEl.classList.add('hidden');
  setStatus('');

  let prev = null;
  let idx = state.idx;
  let preload = null; // { idx, promise }

  const buildAt = (i) =>
    buildYearGroup(bbox, type, cover, state.years[i].year, alive);

  while (alive()) {
    const yr = state.years[idx].year;
    const built =
      preload && preload.idx === idx ? await preload.promise : await buildAt(idx);
    if (!alive() || !built.group) {
      dropGroup(built.group);
      break;
    }

    if (!built.layers.length) {
      dropGroup(built.group);
      idx = idx + 1 > state.years.length - 1 ? 0 : idx + 1;
      continue; // skip years with no imagery here
    }

    showBar('indeterminate');
    await whenSettled(built.layers, PLAY_LOAD_TIMEOUT, (f) =>
      showBar(Math.round(f * 100))
    );
    if (!alive()) {
      dropGroup(built.group);
      break;
    }
    showBar('hidden');

    setBigYear(yr);
    await tween(PLAY_FADE_MS, (k) => {
      if (prev) setGroupOpacity(prev, (1 - k) * state.opacity);
      setGroupOpacity(built.group, k * state.opacity);
    });
    dropGroup(prev);
    prev = built.group;

    state.idx = idx;
    updateLabel();

    const nextIdx = idx + 1 > state.years.length - 1 ? 0 : idx + 1;
    preload = { idx: nextIdx, promise: buildAt(nextIdx) };

    await sleepCancellable(PLAY_DWELL_MS, () => !alive());
    idx = nextIdx;
  }
}

function stopPlayback(restore) {
  if (!state.playing) return;
  state.playing = false;
  playToken++;
  el('playBtn').textContent = '▶';
  el('playBtn').title = 'Zeitraffer automatisch abspielen';
  pbGroups.forEach((g) => map.removeLayer(g));
  pbGroups.clear();
  el('bigYear').classList.add('hidden');
  showBar('hidden');
  if (restore !== false) loadTiles(); // back to the normal interactive view
}

function togglePlay() {
  if (state.playing) stopPlayback(true);
  else startPlayback();
}

// --- video export (in-browser recorder) ------------------------------------
// Renders every year for the CURRENT viewport onto an off-screen canvas,
// cross-fades between them with the big year baked in, and records the canvas
// stream to a downloadable file. Same-origin previews keep the canvas
// un-tainted; no OSM basemap is drawn (it would taint it) so gaps are dark.

const EXPORT_FPS = 30;
const EXPORT_FADE_MS = 850;
const EXPORT_HOLD_MS = 1750;
let exporting = false;
let exportCancel = false;

function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.640028',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  if (!window.MediaRecorder) return '';
  return cands.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

const loadImage = (src) =>
  new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });

// Draw one year's tiles onto its own full-size canvas using the (frozen)
// current map projection — same ordering/placement as the live mosaic.
async function renderYearCanvas(feats, cw, ch, sc) {
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const x = c.getContext('2d');
  x.fillStyle = '#1a1d23';
  x.fillRect(0, 0, cw, ch);
  const ordered = feats
    .slice()
    .sort((a, b) => (a.properties.quality || 0) - (b.properties.quality || 0));
  for (const f of ordered) {
    if (exportCancel) break;
    const p = f.properties;
    const src = `/api/preview?type=${p.type}&id=${p.gid}${p.type === 'lb' ? '&v=5' : ''}`;
    const img = await loadImage(src);
    if (!img) continue;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (p.type === 'lb' && p.corners && p.corners.length >= 4) {
      const rc = imageCorners(p.corners);
      if (!rc) continue;
      const P0 = map.latLngToContainerPoint(L.latLng(rc[0]));
      const P1 = map.latLngToContainerPoint(L.latLng(rc[1]));
      const P2 = map.latLngToContainerPoint(L.latLng(rc[2]));
      x.save();
      x.setTransform(
        ((P1.x - P0.x) * sc) / W,
        ((P1.y - P0.y) * sc) / W,
        ((P2.x - P0.x) * sc) / H,
        ((P2.y - P0.y) * sc) / H,
        P0.x * sc,
        P0.y * sc
      );
      x.drawImage(img, 0, 0);
      x.restore();
    } else {
      const b = p.bounds; // [[s,w],[n,e]]
      const tl = map.latLngToContainerPoint(L.latLng(b[1][0], b[0][1]));
      const br = map.latLngToContainerPoint(L.latLng(b[0][0], b[1][1]));
      x.drawImage(
        img,
        tl.x * sc,
        tl.y * sc,
        (br.x - tl.x) * sc,
        (br.y - tl.y) * sc
      );
    }
  }
  return c;
}

function paintFrame(ctx, cw, ch, prev, cur, curAlpha, year, popK) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#1a1d23';
  ctx.fillRect(0, 0, cw, ch);
  if (prev) {
    ctx.globalAlpha = 1 - curAlpha;
    ctx.drawImage(prev, 0, 0);
  }
  if (cur) {
    ctx.globalAlpha = curAlpha;
    ctx.drawImage(cur, 0, 0);
  }
  ctx.globalAlpha = 1;
  // big year
  const fs = Math.round(ch * 0.075);
  const k = Math.min(1, popK * 1.4);
  ctx.save();
  ctx.globalAlpha = k;
  ctx.translate(cw / 2, ch - ch * 0.06);
  ctx.scale(0.92 + 0.08 * k, 0.92 + 0.08 * k);
  ctx.font = `800 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = ch * 0.02;
  ctx.fillStyle = '#fff';
  ctx.fillText(String(year), 0, 0);
  ctx.restore();
  // attribution baked into the file
  ctx.globalAlpha = 0.7;
  ctx.font = `${Math.round(ch * 0.02)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 4;
  ctx.fillText('© GDI-Th · Luftbilder-Zeitstrahl', ch * 0.02, ch - ch * 0.02);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

const raf = () => new Promise((r) => requestAnimationFrame(r));

async function exportVideo() {
  if (exporting) {
    exportCancel = true;
    return;
  }
  if (!state.years.length || map.getZoom() < MIN_ZOOM) {
    setStatus('Zum Export bitte näher heranzoomen.');
    return;
  }
  const mime = pickMime();
  if (!mime) {
    setStatus('Video-Export wird von diesem Browser nicht unterstützt.');
    return;
  }
  if (state.playing) stopPlayback(false);

  exporting = true;
  exportCancel = false;
  const btn = el('exportBtn');
  btn.classList.add('busy');
  btn.textContent = '■ Stop';
  spotEl.classList.add('hidden');

  const type = state.type;
  const cover = type === 'lb' && state.cover;
  const bbox = viewportBbox();
  const years = state.years.map((y) => y.year);

  const size = map.getSize();
  const sc = Math.min(
    2,
    Math.max(1, Math.floor(2560 / Math.max(1, size.x)))
  ) || 1;
  const cw = Math.round((size.x * sc) / 2) * 2;
  const ch = Math.round((size.y * sc) / 2) * 2;

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  paintFrame(ctx, cw, ch, null, null, 0, '', 0);

  const bitrate = Math.min(
    20_000_000,
    Math.round(cw * ch * EXPORT_FPS * 0.12)
  );
  const stream = canvas.captureStream(EXPORT_FPS);
  const chunks = [];
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bitrate,
  });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();

  let prev = null;
  let done = 0;
  const renderedYears = [];
  for (let i = 0; i < years.length && !exportCancel; i++) {
    const yr = years[i];
    setStatus(`Video: ${yr} wird geladen … (${i + 1}/${years.length})`, true);
    showBar(Math.round((i / years.length) * 100));
    let feats = [];
    try {
      const fc = await fetch(
        `/api/tiles?bbox=${bbox}&type=${type}&from=${yr}&to=${yr}` +
          (cover ? '&cover=1' : '')
      ).then((r) => r.json());
      feats = (fc && fc.features) || [];
    } catch {
      /* skip */
    }
    if (exportCancel) break;
    if (!feats.length) continue; // no imagery here this year
    const cur = await renderYearCanvas(feats, cw, ch, sc);
    if (exportCancel) break;
    renderedYears.push(yr);

    const fadeMs = prev ? EXPORT_FADE_MS : 600;
    const total = fadeMs + EXPORT_HOLD_MS;
    const t0 = performance.now();
    for (;;) {
      if (exportCancel) break;
      const e = performance.now() - t0;
      const a = Math.min(1, e / fadeMs);
      paintFrame(ctx, cw, ch, prev, cur, a, yr, a);
      if (e >= total) break;
      await raf();
    }
    prev = cur;
    done = i + 1;
    setStatus(`Video aufgenommen: ${done}/${years.length} Jahre`, true);
  }

  // brief tail so the last year isn't cut off
  if (!exportCancel && prev) {
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      paintFrame(
        ctx,
        cw,
        ch,
        prev,
        prev,
        1,
        renderedYears[renderedYears.length - 1],
        1
      );
      await raf();
    }
  }

  rec.stop();
  await stopped;
  showBar('hidden');
  btn.classList.remove('busy');
  btn.textContent = '● Video';
  exporting = false;

  if (exportCancel || !chunks.length) {
    exportCancel = false;
    setStatus('Video-Export abgebrochen.');
    updateSpotlight(); // the live map was untouched; just restore the spotlight
    return;
  }
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `luftbilder-zeitstrahl-${type}-${renderedYears[0]}-${
    renderedYears[renderedYears.length - 1]
  }.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStatus(
    `Video gespeichert (${renderedYears.length} Jahre, ${Math.round(
      blob.size / 1048576
    )} MB).`
  );
  updateSpotlight(); // the live map was untouched; just restore the spotlight
}

// --- wiring -----------------------------------------------------------------

// "Beste Abdeckung" only applies to overlapping aerial frames (lb); for
// rectified orthophotos every tile is already unique, so hide it there.
function syncCoverUI() {
  el('coverWrap').style.display = state.type === 'lb' ? '' : 'none';
}

el('productToggle').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-type]');
  if (!btn) return;
  state.type = btn.dataset.type;
  document
    .querySelectorAll('#productToggle button')
    .forEach((b) => b.classList.toggle('active', b === btn));
  syncCoverUI();
  refreshYears();
});

el('toggleCover').addEventListener('change', (e) => {
  state.cover = e.target.checked;
  loadTiles();
});

slider.addEventListener('input', (e) => setIdx(parseInt(e.target.value, 10)));
el('prevBtn').addEventListener('click', () => setIdx(state.idx - 1));
el('nextBtn').addEventListener('click', () => setIdx(state.idx + 1));
el('playBtn').addEventListener('click', togglePlay);
el('exportBtn').addEventListener('click', exportVideo);

el('opacity').addEventListener('input', (e) => {
  state.opacity = parseFloat(e.target.value);
  applyOpacity();
});

el('toggleOutlines').addEventListener('change', (e) => {
  state.showOutlines = e.target.checked;
  if (state.showOutlines) outlineLayer.addTo(map);
  else map.removeLayer(outlineLayer);
  loadTiles();
});

el('toggleCurrent').addEventListener('change', (e) => {
  if (e.target.checked) currentDop.addTo(map);
  else map.removeLayer(currentDop);
});

// --- place search -----------------------------------------------------------

const searchInput = el('searchInput');
const searchResults = el('searchResults');
let searchTimer = null;
let lastResults = [];

function closeSearch() {
  searchResults.classList.add('hidden');
  searchResults.innerHTML = '';
}

function renderResults(items, msg) {
  lastResults = items || [];
  if (msg) {
    searchResults.innerHTML = `<li class="muted">${msg}</li>`;
  } else {
    searchResults.innerHTML = items
      .map(
        (r, i) =>
          `<li data-i="${i}" title="${r.name.replace(/"/g, '&quot;')}">${
            r.name.split(',').slice(0, 3).join(',')
          }</li>`
      )
      .join('');
  }
  searchResults.classList.remove('hidden');
}

function goTo(r) {
  closeSearch();
  searchInput.blur();
  // Imagery only loads at town level (zoom ≥ 13); clamp the target zoom
  // *before* moving — reading it after an animated fitBounds gives a stale
  // value and can strand the user too far out.
  if (
    r.bbox &&
    r.bbox.length === 4 &&
    r.bbox.every((n) => Number.isFinite(n))
  ) {
    const [s, n, w, e] = r.bbox;
    const bounds = L.latLngBounds([
      [s, w],
      [n, e],
    ]);
    const z = Math.max(14, Math.min(16, map.getBoundsZoom(bounds)));
    map.setView(bounds.getCenter(), z);
  } else {
    map.setView([r.lat, r.lon], 15);
  }
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (q.length < 2) {
    closeSearch();
    return;
  }
  renderResults(null, 'Suche …');
  try {
    const { results } = await fetch(
      `/api/geocode?q=${encodeURIComponent(q)}`
    ).then((r) => r.json());
    if (!results || !results.length) {
      renderResults(null, 'Kein Ort in Thüringen gefunden.');
      return;
    }
    renderResults(results);
  } catch {
    renderResults(null, 'Suche fehlgeschlagen.');
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (searchInput.value.trim().length < 3) {
    closeSearch();
    return;
  }
  searchTimer = setTimeout(doSearch, 450);
});

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    clearTimeout(searchTimer);
    const active = searchResults.querySelector('li.active');
    if (active && active.dataset.i != null) goTo(lastResults[+active.dataset.i]);
    else doSearch();
  } else if (ev.key === 'Escape') {
    closeSearch();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const lis = [...searchResults.querySelectorAll('li[data-i]')];
    if (!lis.length) return;
    ev.preventDefault();
    let idx = lis.findIndex((l) => l.classList.contains('active'));
    idx =
      ev.key === 'ArrowDown'
        ? Math.min(lis.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    lis.forEach((l) => l.classList.remove('active'));
    lis[idx].classList.add('active');
  }
});

searchResults.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-i]');
  if (li) goTo(lastResults[+li.dataset.i]);
});

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.search')) closeSearch();
});

// --- info / Impressum modal -------------------------------------------------

const aboutOverlay = el('aboutOverlay');
el('aboutYear').textContent = new Date().getFullYear();

function openAbout() {
  aboutOverlay.classList.remove('hidden');
}
function closeAbout() {
  aboutOverlay.classList.add('hidden');
}

el('aboutBtn').addEventListener('click', openAbout);
el('aboutLink').addEventListener('click', openAbout);
el('aboutClose').addEventListener('click', closeAbout);
aboutOverlay.addEventListener('click', (ev) => {
  if (ev.target === aboutOverlay) closeAbout(); // backdrop click
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!aboutOverlay.classList.contains('hidden')) closeAbout();
  else if (exporting) exportCancel = true;
  else if (state.playing) stopPlayback(true);
});

// A real user pan/zoom ends a render/export (the viewport is otherwise frozen).
map.on('dragstart zoomstart', () => {
  if (exporting) exportCancel = true;
  stopPlayback(true);
});

map.on('moveend zoomend', scheduleRefresh);
// Recompute the centre spotlight immediately on pan (cheap; reuses the
// already-loaded features until the debounced reload catches up).
map.on('moveend', updateSpotlight);

syncCoverUI();
refreshYears();
