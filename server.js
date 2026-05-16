import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTiles, fetchYears, fetchImage, getPreview } from './lib/thueringen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

function parseBbox(raw) {
  const bbox = String(raw || '')
    .split(',')
    .map(Number);
  return bbox.length === 4 && !bbox.some(Number.isNaN) ? bbox : null;
}

// Distinct acquisition years actually available for the current viewport, so
// the timeline only offers years that have imagery here.
app.get('/api/years', async (req, res) => {
  try {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) return res.status(400).json({ error: 'bbox required' });
    const type = req.query.type === 'lb' ? 'lb' : 'op';
    const years = await fetchYears({ bboxWgs: bbox, type });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ type, years });
  } catch (err) {
    res.status(502).json({ error: 'upstream failed', detail: String(err.message || err) });
  }
});

// Place search, biased to Thüringen (the only region with imagery). Proxied
// so we can set the User-Agent Nominatim requires and cache politely.
const geoCache = new Map();
app.get('/api/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const key = q.toLowerCase();
  if (geoCache.has(key)) return res.json({ results: geoCache.get(key) });
  try {
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('q', q);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '6');
    u.searchParams.set('countrycodes', 'de');
    // Thüringen envelope (lon/lat), restrict results to it
    u.searchParams.set('viewbox', '9.85,51.70,12.70,50.15');
    u.searchParams.set('bounded', '1');
    const r = await fetch(u, {
      headers: {
        'User-Agent': 'LuftbilderZeitstrahl/1.0 (local historical-imagery viewer)',
        'Accept-Language': 'de',
      },
    });
    if (!r.ok) throw new Error('geocoder HTTP ' + r.status);
    const arr = await r.json();
    const results = arr.map((o) => ({
      name: o.display_name,
      lat: +o.lat,
      lon: +o.lon,
      // Nominatim boundingbox = [south, north, west, east]
      bbox: Array.isArray(o.boundingbox) ? o.boundingbox.map(Number) : null,
    }));
    geoCache.set(key, results);
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err), results: [] });
  }
});

app.get('/api/tiles', async (req, res) => {
  try {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox) {
      return res.status(400).json({ error: 'bbox=minLon,minLat,maxLon,maxLat required' });
    }
    const type = req.query.type === 'lb' ? 'lb' : 'op';
    const from = req.query.from ? parseInt(req.query.from, 10) : undefined;
    const to = req.query.to ? parseInt(req.query.to, 10) : undefined;
    const cover = req.query.cover === '1';

    const fc = await fetchTiles({ bboxWgs: bbox, type, from, to, cover });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(fc);
  } catch (err) {
    res.status(502).json({ error: 'upstream failed', detail: String(err.message || err) });
  }
});

app.get('/api/preview', async (req, res) => {
  try {
    const { type, id } = req.query;
    const out = await getPreview(type, id);
    if (out.status !== 200) return res.status(502).end();
    res.set('Content-Type', out.contentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(out.buffer);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { type, id } = req.query;
    const up = await fetchImage('download', type, id);
    if (up.status !== 200) return res.status(502).end();
    res.set('Content-Type', up.headers['content-type'] || 'application/zip');
    if (up.headers['content-disposition'])
      res.set('Content-Disposition', up.headers['content-disposition']);
    res.send(up.body);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Luftbilder-Zeitstrahl running:  http://localhost:${PORT}`);
});
