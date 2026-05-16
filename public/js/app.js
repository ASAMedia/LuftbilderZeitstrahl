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
  clearTimeout(yearsTimer);
  yearsTimer = setTimeout(refreshYears, 350);
}

async function refreshYears() {
  if (map.getZoom() < MIN_ZOOM) {
    imageryLayer.clearLayers();
    outlineLayer.clearLayers();
    state.years = [];
    updateLabel();
    setStatus('Zum Laden der Bilder näher heranzoomen (Stadt-/Ortsebene).');
    return;
  }

  const token = ++state.yearsToken;
  const prevYear = currentYear();
  setStatus(`Suche ${productName()} …`, true);

  let data;
  try {
    data = await fetch(
      `/api/years?bbox=${viewportBbox()}&type=${state.type}`
    ).then((r) => r.json());
  } catch {
    if (token === state.yearsToken) setStatus('Fehler beim Laden der Daten.');
    return;
  }
  if (token !== state.yearsToken) return; // superseded by a newer viewport

  state.years = (data && data.years) || [];
  if (!state.years.length) {
    imageryLayer.clearLayers();
    outlineLayer.clearLayers();
    updateLabel();
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

async function loadTiles() {
  const y = currentYear();
  if (y == null) return;

  const token = ++state.tileToken;
  setStatus(`Lade ${y} …`, true);

  const useCover = state.type === 'lb' && state.cover;
  let fc;
  try {
    fc = await fetch(
      `/api/tiles?bbox=${viewportBbox()}&type=${state.type}&from=${y}&to=${y}` +
        (useCover ? '&cover=1' : '')
    ).then((r) => r.json());
  } catch {
    if (token === state.tileToken) setStatus('Fehler beim Laden der Bilder.');
    return;
  }
  if (token !== state.tileToken) return;

  imageryLayer.clearLayers();
  outlineLayer.clearLayers();

  const feats = (fc && fc.features) || [];
  state.features = feats;
  if (!feats.length) {
    setStatus(`Keine ${productName()} für ${y} in diesem Bereich.`);
    updateSpotlight();
    return;
  }

  // Draw the least-dominant frames first so the most-central (sharpest) frame
  // for each spot ends up on top — opaque, no cross-dissolve blur.
  const ordered = feats
    .slice()
    .sort((a, b) => (a.properties.quality || 0) - (b.properties.quality || 0));

  for (const f of ordered) {
    const p = f.properties;
    // `v` busts the browser cache when the lb processing pipeline changes.
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
          { opacity: state.opacity, interactive: true }
        );
      }
    }
    if (!layer) {
      layer = L.imageOverlay(src, p.bounds, {
        opacity: state.opacity,
        interactive: true,
      });
    }

    layer.bindPopup(
      `<div class="tile-popup">
         <b>${p.type === 'op' ? 'Orthophoto' : 'Luftbild'} · ${y}</b><br>
         Bildflug: ${p.bildflugnr || '–'} · Bild: ${p.bildnr || '–'}<br>
         Aufnahme: ${p.datum ? p.datum.slice(0, 10) : '–'}<br>
         <a class="dl" href="/api/download?type=${p.type}&id=${p.gid}">Original (ZIP) herunterladen</a>
       </div>`
    );
    imageryLayer.addLayer(layer);
    if (p.quality != null && layer.setZIndex) layer.setZIndex(Math.round(p.quality));

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

  if (useCover && fc.total > feats.length) {
    setStatus(
      `${y} · ${feats.length} schärfste Bilder (von ${fc.total}) – Fläche abgedeckt`
    );
  } else {
    setStatus(`${y} · ${feats.length} ${productName()}-Kacheln zusammengesetzt`);
  }
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
  // Only meaningful for the overlapping aerial frames.
  if (state.type !== 'lb' || !state.features || !state.features.length) {
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
  state.idx = Math.max(0, Math.min(state.years.length - 1, i));
  updateLabel();
  loadTiles();
}

function togglePlay() {
  if (!state.years.length) return;
  state.playing = !state.playing;
  el('playBtn').textContent = state.playing ? '⏸' : '▶';
  if (state.playing) {
    state.playTimer = setInterval(() => {
      const next = state.idx + 1 > state.years.length - 1 ? 0 : state.idx + 1;
      setIdx(next);
    }, PLAY_INTERVAL_MS);
  } else {
    clearInterval(state.playTimer);
  }
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

map.on('moveend zoomend', scheduleRefresh);
// Recompute the centre spotlight immediately on pan (cheap; reuses the
// already-loaded features until the debounced reload catches up).
map.on('moveend', updateSpotlight);

syncCoverUI();
refreshYears();
