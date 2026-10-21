import './app.css';
import { PROJECTIONS } from './core/projections.js';
import { TRANSFORMS, fitModel, minPoints, optimiseParams } from './core/georef.js';
import { buildReference, searchPlaces, DETAIL_LEVELS } from './core/reference.js';
import { makePixelPath, buildPixelLayers } from './core/render.js';
import { loadOsm, makeTileFetcher, OSM_ATTRIBUTION } from './core/osm.js';
import { buildSvg, buildLineworkSvg } from './core/svg.js';
import { makeInkImage, matchSettings } from './core/match.js';
import { parsePath, toPathData, lineLength, eraseCircle, nearestLine } from './core/linesedit.js';
import { STYLES } from './styles/index.js';
import { ImageViewer } from './ui/viewer.js';
import { RefMap } from './ui/refmap.js';
import { sampleColour, traceColour } from './ui/trace.js';
import { download, pickFile, readAsDataUrl, loadImage, svgToPng, autosave, restore } from './ui/files.js';
import { pdfToImage } from './ui/pdf.js';

const $ = (s) => document.querySelector(s);
const BASE = import.meta.env.BASE_URL;

const LAYERS = [
  { id: 'land', name: 'Countries' },
  { id: 'borders', name: 'Borders' },
  { id: 'coastline', name: 'Coastline' },
  { id: 'provinceLines', name: 'Provinces and states' },
  { id: 'rivers', name: 'Rivers' },
  { id: 'lakes', name: 'Lakes' },
  { id: 'places', name: 'Cities' },
  { id: 'countryLabels', name: 'Country labels' },
  { id: 'placeLabels', name: 'City labels' },
  { id: 'graticule', name: 'Lat/lon grid' },
  { id: 'buildings', name: 'Buildings (streets detail)' },
  { id: 'traced', name: 'Traced shapes' }
];

function newProject() {
  return {
    version: 1,
    name: 'Untitled map',
    image: null,
    gcps: [],
    georef: { projection: 'equirectangular', params: null, transform: 'polynomial' },
    detail: 'medium',
    detailAuto: true,
    basemap: 'streets',
    options: { riverRank: 6, placeLimit: 40, placeRank: 4, matchImage: true, matchStrictness: 0.4 },
    show: { land: true, borders: true, coastline: true, provinceLines: true, rivers: true, lakes: true, places: true, countryLabels: true, placeLabels: true, graticule: false, buildings: false, traced: true },
    highlight: [], fade: [], names: {}, labelHide: [],
    traced: [],
    linework: null,
    draw: 'reference',
    style: 'clean-explainer',
    frame: { preset: 'image', zoom: 1, cx: 0.5, cy: 0.5 },
    exportHeight: 1440
  };
}

let project = newProject();
let imageEl = null;
let model = null;
const refs = {};
let pending = null;        // id of a pin waiting for its second half
let selectedPin = null;
let selectedCountry = null;
let picking = false;
let pickedColour = null;
let layersCache = null;
let nextId = 1;

// ---------- reference data ----------
// The streets detail level still uses Natural Earth for anything outside OSM tiles.
async function getRef(detail) {
  if (detail === 'streets') detail = 'medium';
  if (!refs[detail]) {
    const file = DETAIL_LEVELS.find((d) => d.id === detail).file;
    refs[detail] = fetch(`${BASE}data/${file}`).then((r) => r.json()).then(buildReference);
  }
  return refs[detail];
}

// ---------- views ----------
const pinViewer = new ImageViewer($('#pin-image'), { onTap: onPinImageTap, onPinMove: (id, xy) => updatePin(id, { pixel: xy }) });
// Hand tidying state for the scan lines (see "tidying the scan lines").
const tidy = { on: false, lines: null, undo: [], before: null, frame: 0 };
const checkViewer = new ImageViewer($('#check-image'), { onTap: onCheckTap, onDraw: onLinesDraw });
const refMap = new RefMap($('#pin-map'), {
  onTap: onMapTap,
  onBasemap: (mode, problem) => { if (problem) toast(problem); syncBasemap(); },
  onPinMove: (id, ll) => updatePin(id, { lonlat: ll })
});
getRef('medium').then((ref) => refMap.setReference(ref));

let view = 'pin';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  if (v !== 'pin' && !project.image) { toast('Open a map image first.'); return; }
  // Lines pulled from the scan need no points; the map data does.
  if (v === 'style' && !model && !hasLines()) { toast(`Place at least ${minPoints(project.georef.transform)} matching points, or use “Pull lines from scan” in Check.`, 5000); return; }
  view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'pin') { refMap.resize(); pinViewer.fit(); }
  if (v === 'check') { checkViewer.fit(); refreshCheck(); }
  if (v === 'style') refreshPreview();
}

// ---------- image ----------
$('#open-image').addEventListener('click', async () => {
  const file = await pickFile('image/*,application/pdf,.pdf');
  if (!file) return;
  let image;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    toast('Opening the PDF…', 4000);
    try {
      const pdf = await pdfToImage(file);
      if (pdf.pages > 1) toast(`This PDF has ${pdf.pages} pages. Using the first.`, 4000);
      image = { name: file.name, width: pdf.width, height: pdf.height, dataUrl: pdf.dataUrl };
    } catch (err) {
      toast(`Couldn't open that PDF: ${err.message || err}`, 6000);
      return;
    }
  } else {
    const dataUrl = await readAsDataUrl(file);
    const img = await loadImage(dataUrl);
    image = { name: file.name, width: img.naturalWidth, height: img.naturalHeight, dataUrl };
  }
  const keepPins = project.gcps.length && confirm('Keep the points from the current map?');
  project = { ...(keepPins ? project : newProject()), image };
  if (!keepPins) project.name = file.name.replace(/\.[^.]+$/, '');
  await loadProject(project);
  save();
});

async function setImage() {
  if (!project.image) { imageEl = null; pinViewer.setImage('', 0, 0); checkViewer.setImage('', 0, 0); return; }
  imageEl = await loadImage(project.image.dataUrl);
  pinViewer.setImage(project.image.dataUrl, project.image.width, project.image.height);
  checkViewer.setImage(project.image.dataUrl, project.image.width, project.image.height);
}

// ---------- pins ----------
function onPinImageTap(xy, info) {
  if (info?.pinId) { selectPin(info.pinId); return; }
  if (!project.image || !xy) return;
  const p = pending && project.gcps.find((g) => g.id === pending);
  if (p && !p.pixel) { p.pixel = xy; pending = null; afterPinChange(); return; }
  const g = { id: String(nextId++), pixel: xy, lonlat: null };
  project.gcps.push(g);
  pending = g.id;
  selectedPin = g.id;
  // With a fit already in place, jump the reference map to where this point
  // probably is, so only a small correction is needed.
  if (model) { const ll = model.pixelToLonlat(xy); if (ll && isFinite(ll[0])) refMap.flyTo(ll, 4); }
  afterPinChange();
}

function onMapTap(lonlat, placeName, pinId) {
  if (pinId) { selectPin(pinId); return; }
  if (!project.image) { toast('Open a map image first.'); return; }
  completeWithLonlat(lonlat, placeName);
}

function completeWithLonlat(lonlat, placeName) {
  const p = pending && project.gcps.find((g) => g.id === pending);
  if (p && !p.lonlat) {
    p.lonlat = lonlat; p.place = placeName || null; pending = null;
  } else {
    const g = { id: String(nextId++), pixel: null, lonlat, place: placeName || null };
    project.gcps.push(g);
    pending = g.id; selectedPin = g.id;
  }
  afterPinChange();
}

function updatePin(id, patch) {
  const g = project.gcps.find((q) => q.id === String(id));
  if (!g) return;
  Object.assign(g, patch);
  if (patch.lonlat) g.place = null;
  afterPinChange();
}

function selectPin(id) { selectedPin = String(id); renderPins(); }

function deletePin(id) {
  project.gcps = project.gcps.filter((g) => g.id !== id);
  if (pending === id) pending = null;
  afterPinChange();
}

function afterPinChange() {
  refit();
  renderPins();
  save();
}

function pinState(g) {
  if (!g.pixel || !g.lonlat) return 'pending';
  const r = model?.residuals.find((q) => q.id === g.id);
  if (!r) return '';
  const diag = Math.hypot(project.image.width, project.image.height);
  return r.error < diag * 0.0025 ? 'good' : r.error < diag * 0.01 ? 'check' : 'bad';
}

function renderPins() {
  const list = project.gcps.map((g, i) => ({ ...g, label: i + 1, state: pinState(g), selected: g.id === selectedPin }));
  pinViewer.setPins(list.filter((g) => g.pixel).map((g) => ({ ...g, x: g.pixel[0], y: g.pixel[1] })));
  refMap.setPins(list);
  const ol = $('#pin-list');
  ol.innerHTML = '';
  list.forEach((g) => {
    const r = model?.residuals.find((q) => q.id === g.id);
    const li = document.createElement('li');
    li.className = `${g.state} ${g.selected ? 'selected' : ''}`;
    const where = g.lonlat ? (g.place || `${fmtLat(g.lonlat[1])}, ${fmtLon(g.lonlat[0])}`) : 'tap the reference map';
    const onImage = g.pixel ? '' : ' · tap the map image';
    li.innerHTML = `<span class="dot">${g.label}</span><span class="where">${esc(where)}${onImage}</span><span class="err">${r ? `${r.error.toFixed(1)} px` : ''}</span><button class="del" aria-label="Delete point ${g.label}">✕</button>`;
    li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deletePin(g.id); });
    li.addEventListener('click', () => { selectPin(g.id); if (g.lonlat) refMap.flyTo(g.lonlat, 3); });
    ol.appendChild(li);
  });
  const n = project.gcps.filter((g) => g.pixel && g.lonlat).length;
  const hint = $('#pin-hint');
  if (!project.image) hint.textContent = 'Open a map image, then tap a spot on it and the same spot on the reference map. Cities snap exactly.';
  else if (pending) hint.textContent = project.gcps.find((g) => g.id === pending)?.pixel ? 'Now tap the same place on the reference map, or search for it.' : 'Now tap that place on your map image.';
  else if (n < 4) hint.textContent = `Pin ${4 - n} more point${4 - n === 1 ? '' : 's'}. Spread them out: corners and edges work best.`;
  else if (model && model.rmse > Math.hypot(project.image.width, project.image.height) * 0.01) hint.textContent = project.georef.transform === 'thinPlateSpline' ? 'Some points disagree. Check the red ones are on exactly the same spot in both maps.' : 'Some points disagree. Check the red ones, or for an old or hand-drawn map set Fit to Rubber sheet.';
  else hint.textContent = 'Looking good. Add points where lines drift, or go to Check.';
}

// ---------- fitting ----------
function populateSelects() {
  $('#projection').innerHTML = PROJECTIONS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#transform').innerHTML = TRANSFORMS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  $('#detail').innerHTML = [...DETAIL_LEVELS, { id: 'streets', name: 'Streets (OpenStreetMap, for city maps)' }].map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
}
populateSelects();

$('#projection').addEventListener('change', (e) => {
  project.georef.projection = e.target.value;
  project.georef.params = null;
  const usable = project.gcps.filter((g) => g.pixel && g.lonlat);
  if (usable.length >= 4) project.georef.params = optimiseParams(usable, e.target.value);
  afterPinChange();
});
$('#transform').addEventListener('change', (e) => { project.georef.transform = e.target.value; afterPinChange(); });

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let detectId = 0;
$('#detect').addEventListener('click', () => {
  const usable = project.gcps.filter((g) => g.pixel && g.lonlat);
  if (usable.length < 4) { toast('Detecting the projection needs at least 4 points, ideally 6 or more spread across the map.'); return; }
  $('#detect').disabled = true;
  $('#detect').textContent = 'Detecting…';
  const id = ++detectId;
  worker.onmessage = (e) => {
    if (e.data.id !== id) return;
    $('#detect').disabled = false;
    $('#detect').textContent = 'Detect projection';
    if (e.data.error) { toast(`Detection failed: ${e.data.error}`); return; }
    const top = e.data.ranking.slice(0, 4);
    if (!top.length) { toast('No projection fitted these points.'); return; }
    applyProjection(top[0]);
    const diag = Math.hypot(project.image.width, project.image.height);
    $('#detect-results').innerHTML = top.map((r, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}">${r.name} <small>${r.rmse.toFixed(1)} px${r.rmse < diag * 0.003 ? ' ✓' : ''}</small></button>`).join('');
    $('#detect-results').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      applyProjection(top[+b.dataset.i]);
      $('#detect-results').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    }));
  };
  worker.postMessage({ id, gcps: usable.map(({ id, pixel, lonlat }) => ({ id, pixel, lonlat })) });
});

function applyProjection(r) {
  project.georef.projection = r.id;
  project.georef.params = r.params;
  $('#projection').value = r.id;
  afterPinChange();
}

function refit() {
  layersCache = null;
  try {
    model = project.image ? fitModel({ gcps: project.gcps, ...project.georef }) : null;
  } catch (err) {
    model = null;
    console.warn(err);
  }
  syncDrawMode();
  const st = $('#fit-status');
  if (!model) {
    const need = minPoints(project.georef.transform);
    const have = project.gcps.filter((g) => g.pixel && g.lonlat).length;
    st.textContent = project.image ? `${have} of ${need} points needed for this fit.` : '';
    pinViewer.setOverlay('');
    return;
  }
  const diag = Math.hypot(project.image.width, project.image.height);
  const pct = (v) => `${(v / diag * 100).toFixed(2)}%`;
  const exact = project.georef.transform === 'thinPlateSpline';
  st.innerHTML = exact
    ? (model.looRmse != null ? `Rubber sheet passes through every point. Check error: <b>${model.looRmse.toFixed(1)} px</b> (${pct(model.looRmse)} of the image), predicting each point from the others.` : 'Rubber sheet passes through every point. Add 5 or more for an error check.')
    : `Average error <b>${model.rmse.toFixed(1)} px</b> (${pct(model.rmse)} of the image)${model.looRmse != null ? `; check error ${model.looRmse.toFixed(1)} px` : ''}.`;
  if (project.detailAuto) {
    const km = extentKm();
    project.detail = km < 60 ? 'streets' : km < 2500 ? 'high' : 'medium';
    $('#detail').value = project.detail;
    $('#match-box').hidden = project.detail !== 'streets';
  }
  drawPinOverlay();
}

// Rough width of the map in kilometres, from its corners.
function imageBbox() {
  const W = project.image.width, H = project.image.height;
  const pts = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push([t * W, 0], [t * W, H], [0, t * H], [W, t * H]); }
  const ll = pts.map((p) => model.pixelToLonlat(p)).filter((q) => q && isFinite(q[0]) && isFinite(q[1]));
  if (!ll.length) return null;
  const lons = ll.map((q) => q[0]), lats = ll.map((q) => q[1]);
  return [Math.min(...lons), Math.max(-85, Math.min(...lats)), Math.max(...lons), Math.min(85, Math.max(...lats))];
}
function extentKm() {
  const b = imageBbox();
  if (!b) return Infinity;
  const midLat = (b[1] + b[3]) / 2 * Math.PI / 180;
  return Math.hypot((b[2] - b[0]) * 111.32 * Math.cos(midLat), (b[3] - b[1]) * 110.57);
}

// OpenStreetMap tiles for the map's area, cached per area so refits that
// barely move the map don't download again.
const osmCache = new Map();
const fetchTile = makeTileFetcher();
function getOsm() {
  const b = imageBbox();
  if (!b) return Promise.resolve(null);
  const pad = 0.05 * Math.max(b[2] - b[0], b[3] - b[1]);
  const box = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad].map((v) => Math.round(v * 200) / 200);
  const key = box.join(',');
  if (!osmCache.has(key)) {
    const p = loadOsm(box, fetchTile, { onProgress: (n, t) => { if (t > 4) toast(`Loading OpenStreetMap… ${n} of ${t} tiles`, 1500); } });
    p.catch(() => osmCache.delete(key));
    osmCache.set(key, p);
  }
  return osmCache.get(key);
}

let overlayTimer = null;
async function drawPinOverlay() {
  if (!model) return;
  const { path } = makePixelPath(model, project.image.width, project.image.height);
  if (project.detail === 'streets') {
    // City maps: preview main roads and shorelines once there are enough
    // points for the fit to be roughly right, debounced while pins move.
    pinViewer.setOverlay('');
    if (project.gcps.filter((g) => g.pixel && g.lonlat).length < 4) return;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(async () => {
      try {
        const osm = await getOsm();
        if (!osm || !model || project.detail !== 'streets') return;
        const { path: p } = makePixelPath(model, project.image.width, project.image.height);
        const fc = (features) => ({ type: 'FeatureCollection', features });
        const roads = osm.roads.filter((r) => r.properties.class === 'major' || r.properties.class === 'medium');
        pinViewer.setOverlay(`<path class="ov-water" d="${p(fc(osm.water)) || ''}"/><path class="ov-border" d="${p(fc(roads)) || ''}"/>`);
      } catch (err) { toast(`Couldn't load OpenStreetMap: ${err.message || err}`); }
    }, 800);
    return;
  }
  const ref = await getRef('medium');
  pinViewer.setOverlay(`<path class="ov-coast" d="${path(ref.coastline) || ''}"/><path class="ov-border" d="${path(ref.borders) || ''}"/>`);
}

// ---------- place search ----------
// Cities come from the bundled data instantly; streets, landmarks and
// addresses come from OpenStreetMap's Nominatim, favouring what's on screen.
let searchSeq = 0, searchTimer = null;
$('#place-search').addEventListener('input', (e) => runSearch(e.target.value, false));
$('#place-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value, true); });
async function runSearch(q, now) {
  const seq = ++searchSeq;
  const ref = await getRef('medium');
  const local = searchPlaces(ref, q).map((h) => ({ ...h, zoom: 6 }));
  showResults(local, q.trim().length >= 3 ? 'Searching streets and landmarks…' : '');
  clearTimeout(searchTimer);
  if (q.trim().length < 3) return;
  searchTimer = setTimeout(async () => {
    try {
      const [w, s, e2, n] = refMap.bounds();
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(q)}&viewbox=${w},${n},${e2},${s}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const found = (await res.json()).map((r) => ({ name: r.name || r.display_name.split(',')[0], detail: r.display_name.split(',').slice(1, 3).join(',').trim(), lonlat: [+r.lon, +r.lat], zoom: 16 }));
      if (seq === searchSeq) showResults([...local, ...found], found.length || local.length ? '' : 'No matches.');
    } catch {
      if (seq === searchSeq) showResults(local, local.length ? '' : 'Street search needs a connection.');
    }
  }, now ? 0 : 700);
}
function showResults(hits, note) {
  const ul = $('#place-results');
  ul.innerHTML = hits.map((h, i) => `<li data-i="${i}">${esc(h.name)} <small>${esc(h.detail || '')}</small></li>`).join('') + (note ? `<li class="note">${esc(note)}</li>` : '');
  ul.querySelectorAll('li[data-i]').forEach((li) => li.addEventListener('click', () => {
    const h = hits[+li.dataset.i];
    refMap.flyTo(h.lonlat, h.zoom);
    if (project.image) completeWithLonlat(h.lonlat, h.name);
    ul.innerHTML = '';
    $('#place-search').value = '';
    searchSeq++;
  }));
}

// ---------- basemap ----------
document.querySelectorAll('#basemap button').forEach((b) => b.addEventListener('click', () => {
  refMap.setBasemap(b.dataset.mode);
  project.basemap = b.dataset.mode; syncBasemap(); save();
}));
function syncBasemap() {
  document.querySelectorAll('#basemap button').forEach((b) => b.classList.toggle('active', b.dataset.mode === refMap.basemap));
}

// ---------- check view ----------
function buildToggles() {
  const box = $('#layer-toggles');
  box.innerHTML = LAYERS.map((l) => `<label><input type="checkbox" data-layer="${l.id}"> ${l.name}</label>`).join('');
  box.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => {
    project.show[i.dataset.layer] = i.checked;
    refreshCheck(); save();
  }));
}
buildToggles();

function syncControls() {
  $('#project-name').value = project.name;
  $('#projection').value = project.georef.projection;
  $('#transform').value = project.georef.transform;
  $('#detail').value = project.detail;
  if (project.basemap) refMap.setBasemap(project.basemap);
  syncBasemap();
  $('#river-rank').value = project.options.riverRank;
  $('#match-image').checked = project.options.matchImage !== false;
  $('#match-strict').value = project.options.matchStrictness ?? 0.4;
  $('#match-box').hidden = project.detail !== 'streets';
  $('#place-limit').value = project.options.placeLimit;
  document.querySelectorAll('#layer-toggles input').forEach((i) => { i.checked = !!project.show[i.dataset.layer]; });
  $('#frame-preset').value = project.frame.preset;
  $('#frame-zoom').value = project.frame.zoom;
  $('#frame-x').value = project.frame.cx;
  $('#frame-y').value = project.frame.cy;
  $('#export-size').value = String(project.exportHeight);
  $('#frame-controls').hidden = project.frame.preset !== '16:9';
  renderStyleList();
  renderTraced();
  $('#lines-contrast').value = project.linework?.options?.contrast ?? 0.18;
  $('#lines-size').value = project.linework?.options?.minSize ?? 0.012;
  $('#lines-peel').checked = project.linework?.options?.peel ?? true;
  $('#lines-method').value = project.linework?.options?.method ?? 'combined';
  syncLinesMethod();
  resetTidy();
  renderLines();
  syncDrawMode();
}

$('#project-name').addEventListener('change', (e) => { project.name = e.target.value.trim() || 'Untitled map'; save(); });
$('#detail').addEventListener('change', (e) => { project.detail = e.target.value; project.detailAuto = false; $('#match-box').hidden = project.detail !== 'streets'; layersCache = null; drawPinOverlay(); refreshCheck(); save(); });
$('#match-image').addEventListener('change', (e) => { project.options.matchImage = e.target.checked; layersCache = null; refreshCheck(); save(); });
$('#match-strict').addEventListener('change', (e) => { project.options.matchStrictness = +e.target.value; layersCache = null; refreshCheck(); save(); });
$('#river-rank').addEventListener('change', (e) => { project.options.riverRank = +e.target.value; layersCache = null; refreshCheck(); save(); });
$('#place-limit').addEventListener('change', (e) => { project.options.placeLimit = +e.target.value; layersCache = null; refreshCheck(); save(); });
$('#image-opacity').addEventListener('input', (e) => checkViewer.setImageOpacity(e.target.value));
$('#vector-opacity').addEventListener('input', (e) => checkViewer.setOverlayOpacity(e.target.value));

async function getLayers() {
  if (layersCache) return layersCache;
  const ref = await getRef(project.detail);
  if (!model) return null;
  let osm = null;
  if (project.detail === 'streets') {
    try { osm = await getOsm(); } catch (err) {
      toast(`Couldn't load OpenStreetMap, so showing Natural Earth instead. ${err.message || err}`, 5000);
    }
  }
  toast('Drawing layers…', 800);
  layersCache = buildPixelLayers(ref, model, project.image.width, project.image.height, {
    riverRank: project.options.riverRank,
    placeRank: project.options.placeRank,
    placeLimit: project.options.placeLimit,
    provinces: true,
    osm,
    match: osm && project.options.matchImage !== false ? getMatch() : null
  });
  layersCache.osmRaw = osm;
  return layersCache;
}

// Greyscale copy of the scanned map for checking which streets it shows.
// Capped at about 8 MP; built once per image.
let inkCache = null;
function getMatch() {
  if (!imageEl) return null;
  const W = project.image.width, H = project.image.height;
  if (inkCache?.src !== project.image.dataUrl) {
    const scale = Math.min(1, Math.sqrt(8e6 / (W * H)));
    const c = document.createElement('canvas');
    c.width = Math.round(W * scale); c.height = Math.round(H * scale);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(imageEl, 0, 0, c.width, c.height);
    inkCache = { src: project.image.dataUrl, scale, img: makeInkImage(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height) };
  }
  // Search across each street by more when the points disagree more.
  const err = model.looRmse ?? model.rmse ?? 0;
  const tolerance = Math.hypot(W, H) * 0.003 + err * 0.5;
  return { img: inkCache.img, scale: inkCache.scale, settings: matchSettings(project.options.matchStrictness ?? 0.4, tolerance) };
}

function hasLines() { return !!project.linework?.layers?.length; }
function linesOverlay() {
  if (!hasLines()) return '';
  return project.linework.layers.filter((l) => l.show !== false).map((l) => `<path class="ck-lines" d="${l.d}" stroke="${l.colour}"/>`).join('');
}

async function refreshCheck() {
  if (view !== 'check') return;
  const L = model ? await getLayers() : null;
  if (!L) { checkViewer.setOverlay(linesOverlay()); renderSelection({ countries: [] }); return; }
  const sh = project.show;
  const hi = new Set(project.highlight), fa = new Set(project.fade);
  let out = '';
  if (L.osm) {
    const o = L.osm;
    out += `<path class="ck-park" d="${o.parks}"/><path class="ck-water" d="${o.water}"/>`;
    if (sh.buildings) out += `<path class="ck-building" d="${o.buildings}"/>`;
    if (sh.rivers) out += `<path class="ck-river" d="${o.waterways}"/>`;
    if (o.dropped) out += `<path class="ck-dropped" d="${o.dropped}"/>`;
    out += `<path class="ck-road-minor" d="${o.roads.minor}"/><path class="ck-road" d="${o.roads.medium}"/><path class="ck-road-major" d="${o.roads.major}"/><path class="ck-rail" d="${o.roads.rail}"/>`;
    if (sh.traced) out += project.traced.map((t) => `<g class="ck-traced">${t.paths.map((d) => `<path d="${d}" fill="${t.fill}"/>`).join('')}</g>`).join('');
    checkViewer.setOverlay(out + linesOverlay());
    renderSelection({ countries: [] });
    return;
  }
  if (sh.land) out += `<g class="ck-land">${L.countries.map((c) => `<path data-id="${c.id}" class="${hi.has(c.id) ? 'hi' : fa.has(c.id) ? 'fa' : ''} ${c.id === selectedCountry ? 'sel' : ''}" d="${c.d}"/>`).join('')}</g>`;
  if (sh.graticule) out += `<path class="ck-grat" d="${L.graticule}"/>`;
  if (sh.lakes) out += L.lakes.map((l) => `<path class="ck-lake" d="${l.d}"/>`).join('');
  if (sh.rivers) out += L.rivers.map((r) => `<path class="ck-river" d="${r.d}"/>`).join('');
  if (sh.provinceLines) out += `<path class="ck-prov" d="${L.provinceLines}"/>`;
  if (sh.borders) out += `<path class="ck-border" d="${L.borders}"/>`;
  if (sh.coastline) out += `<path class="ck-coast" d="${L.coastline}"/>`;
  if (sh.traced) out += project.traced.map((t) => `<g class="ck-traced">${t.paths.map((d) => `<path d="${d}" fill="${t.fill}"/>`).join('')}</g>`).join('');
  if (sh.places) out += L.places.map((p) => `<circle class="ck-place" cx="${p.x}" cy="${p.y}" r="${Math.max(2, project.image.width / 600)}"/>`).join('');
  checkViewer.setOverlay(out + linesOverlay());
  renderSelection(L);
}

function onCheckTap(xy, info) {
  if (tidy.on) { if (xy) tidyTap(xy); return; }
  if (picking && xy && imageEl) {
    pickedColour = sampleColour(imageEl, xy[0], xy[1]);
    picking = false;
    $('#pick-colour').classList.remove('active');
    $('#picked').style.background = `rgb(${pickedColour.join(',')})`;
    $('#trace').disabled = false;
    return;
  }
  const id = info?.target?.closest?.('[data-id]')?.dataset.id;
  selectedCountry = id || null;
  refreshCheck();
}

function renderSelection(L) {
  const box = $('#selection');
  const c = L.countries.find((q) => q.id === selectedCountry);
  if (!c) { box.innerHTML = '<p class="hint">Tap a country on the map.</p>'; return; }
  const state = project.highlight.includes(c.id) ? 'highlight' : project.fade.includes(c.id) ? 'fade' : 'normal';
  box.innerHTML = `
    <div class="sel-name">${esc(c.name)}</div>
    <div class="seg">${['normal', 'highlight', 'fade'].map((s) => `<button data-s="${s}" class="${s === state ? 'active' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <label class="row">Label <input id="sel-label" value="${esc(project.names[c.id] || c.name)}"></label>
    <label class="row"><input type="checkbox" id="sel-hide" ${project.labelHide.includes(c.id) ? 'checked' : ''}> Hide label</label>`;
  box.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    project.highlight = project.highlight.filter((x) => x !== c.id);
    project.fade = project.fade.filter((x) => x !== c.id);
    if (b.dataset.s === 'highlight') project.highlight.push(c.id);
    if (b.dataset.s === 'fade') project.fade.push(c.id);
    refreshCheck(); save();
  }));
  box.querySelector('#sel-label').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (!v || v === c.name) delete project.names[c.id]; else project.names[c.id] = v;
    save();
  });
  box.querySelector('#sel-hide').addEventListener('change', (e) => {
    project.labelHide = project.labelHide.filter((x) => x !== c.id);
    if (e.target.checked) project.labelHide.push(c.id);
    save();
  });
}

// ---------- tracing ----------
$('#pick-colour').addEventListener('click', () => {
  picking = !picking;
  $('#pick-colour').classList.toggle('active', picking);
  if (picking) toast('Tap the colour on your map.');
});
$('#trace').addEventListener('click', async () => {
  if (!pickedColour || !imageEl) return;
  const btn = $('#trace');
  btn.disabled = true; btn.textContent = 'Tracing…';
  try {
    const { paths, coverage } = await traceColour(imageEl, project.image.width, project.image.height, pickedColour, +$('#tolerance').value);
    if (!paths.length) { toast('Nothing matched that colour. Try a higher tolerance.'); return; }
    if (coverage > 0.3) toast(`That colour covers ${Math.round(coverage * 100)}% of the map, so it is probably the paper or background. The streets, water and parks already come from OpenStreetMap; tracing is for things like a shaded area or a drawn route. You can delete it with ✕ below.`, 9000);
    const hex = '#' + pickedColour.map((v) => v.toString(16).padStart(2, '0')).join('');
    project.traced.push({ name: $('#trace-name').value.trim() || `Traced ${project.traced.length + 1}`, fill: hex, paths });
    $('#trace-name').value = '';
    renderTraced(); refreshCheck(); save();
  } catch (err) {
    toast(`Tracing failed: ${err.message || err}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Trace';
  }
});
function renderTraced() {
  const ul = $('#traced-list');
  ul.innerHTML = project.traced.map((t, i) => `<li><input type="color" value="${t.fill}" data-i="${i}"><span>${esc(t.name)} <small>${t.paths.length} shapes</small></span><button data-del="${i}" aria-label="Delete">✕</button></li>`).join('');
  ul.querySelectorAll('input[type=color]').forEach((inp) => inp.addEventListener('change', () => { project.traced[+inp.dataset.i].fill = inp.value; refreshCheck(); save(); }));
  ul.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { project.traced.splice(+b.dataset.del, 1); renderTraced(); refreshCheck(); save(); }));
}

// ---------- lines from the scan ----------
const linesWorker = new Worker(new URL('./linework-worker.js', import.meta.url), { type: 'module' });
let linesJob = 0;
$('#lines-run').addEventListener('click', () => {
  if (!imageEl) return;
  const btn = $('#lines-run');
  const W = project.image.width, H = project.image.height;
  const method = $('#lines-method').value;
  // Up to about 9 MP (12 MP for the combined method, which gains most from
  // detail) is read at full detail; bigger scans are read smaller.
  const scale = Math.min(1, Math.sqrt((method === 'ink' ? 9e6 : 12e6) / (W * H)));
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale); c.height = Math.round(H * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(imageEl, 0, 0, c.width, c.height);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const id = ++linesJob;
  const options = { method, contrast: +$('#lines-contrast').value, minSize: +$('#lines-size').value, peel: $('#lines-peel').checked, outScale: 1 / scale };
  btn.disabled = true; btn.textContent = 'Pulling lines…';
  linesWorker.onmessage = (e) => {
    if (e.data.id !== linesJob) return;
    if (e.data.progress) { btn.textContent = `${e.data.progress}…`; return; }
    btn.disabled = false; btn.textContent = 'Pull lines from scan';
    if (e.data.error) { toast(`Couldn't pull lines: ${e.data.error}`); return; }
    const old = new Map((project.linework?.layers || []).map((l) => [l.name, l]));
    project.linework = {
      options, imageWidth: W, imageHeight: H, strokeWidth: 1.4,
      layers: e.data.result.layers.map((l) => ({ ...l, show: old.get(l.name)?.show ?? l.show ?? true }))
    };
    if (!model) project.draw = 'scan';
    else if (project.draw === 'reference') project.draw = 'both';
    resetTidy();
    syncDrawMode(); renderLines(); refreshCheck(); save();
    const found = project.linework.layers.length;
    if (!found) toast('No lines found. Move “Faint lines” to the left and try again.', 5000);
    else if (method === 'ink') toast(`Found ${found} line ${found === 1 ? 'colour' : 'colours'}. Slide “Map image” down to see them, and untick any you don't want.`, 5000);
    else toast(`Found ${found} layers. Street centres and Unsure lines start hidden: tick them to see them. Slide “Map image” down to compare with the scan.`, 6000);
  };
  linesWorker.postMessage({ id, rgba: data.buffer, width: c.width, height: c.height, options }, [data.buffer]);
});
function syncLinesMethod() {
  const ink = $('#lines-method').value === 'ink';
  $('#lines-method-hint').textContent = ink
    ? 'Ink only follows the printed ink. Each ink colour becomes its own layer. Quicker, but lettering that touches lines can stay.'
    : 'Combined runs several methods and keeps the lines they agree on: block outlines, the shoreline from the water colour, and the ink with street names painted out. Lines only one method found go in “Unsure lines”, hidden at first. Takes about half a minute.';
}
$('#lines-method').addEventListener('change', syncLinesMethod);
function renderLines() {
  const ul = $('#lines-list');
  const layers = project.linework?.layers || [];
  ul.innerHTML = layers.map((l, i) => `<li><input type="color" value="${l.colour}" data-i="${i}"><label><input type="checkbox" data-show="${i}" ${l.show !== false ? 'checked' : ''}> ${esc(l.name)} <small>${Math.round(l.length).toLocaleString()} px</small></label><button data-del="${i}" aria-label="Delete">✕</button></li>`).join('');
  ul.querySelectorAll('input[type=color]').forEach((inp) => inp.addEventListener('change', () => { project.linework.layers[+inp.dataset.i].colour = inp.value; refreshCheck(); save(); }));
  ul.querySelectorAll('[data-show]').forEach((inp) => inp.addEventListener('change', () => { project.linework.layers[+inp.dataset.show].show = inp.checked; refreshCheck(); save(); }));
  $('#lines-tidy-box').hidden = !layers.length;
  if (!layers.length && tidy.on) setTidy(false);
  ul.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    project.linework.layers.splice(+b.dataset.del, 1);
    resetTidy();
    if (!project.linework.layers.length) { project.linework = null; if (project.draw !== 'reference') project.draw = 'reference'; syncDrawMode(); }
    renderLines(); refreshCheck(); save();
  }));
}
// ---------- tidying the scan lines by hand ----------
// Tap a leftover squiggle to delete that line; drag to rub out bits of line.
// Edits work on the lines parsed once per session and are written back to
// the layers' path data, with an undo history.
function resetTidy() { tidy.lines = null; tidy.undo = []; $('#lines-undo').disabled = true; }
function tidyLines() {
  if (!tidy.lines) tidy.lines = project.linework.layers.map((l) => parsePath(l.d));
  return tidy.lines;
}
function setTidy(on) {
  tidy.on = on;
  $('#lines-tidy').classList.toggle('active', on);
  $('#lines-tidy').textContent = on ? 'Done' : 'Tidy by hand';
  $('#lines-tidy-help').hidden = !on;
  $('#check-image').classList.toggle('drawing', on);
  checkViewer.setDrawMode(on, +$('#lines-eraser').value);
  if (on && imageEl && +$('#image-opacity').value > 0.6) { $('#image-opacity').value = 0.35; checkViewer.setImageOpacity(0.35); }
}
// Screen pixels to image pixels at the current zoom.
function screenToImage(px) { return px / checkViewer.t.k; }
function writeBack(layerIndexes) {
  for (const i of layerIndexes) {
    const l = project.linework.layers[i], lines = tidy.lines[i];
    l.d = toPathData(lines);
    l.count = lines.length;
    l.length = lines.reduce((s, q) => s + lineLength(q), 0);
  }
}
function snapshot() { return tidyLines().map((ls) => ls.slice()); }
function pushUndo(before) {
  tidy.undo.push(before);
  if (tidy.undo.length > 30) tidy.undo.shift();
  $('#lines-undo').disabled = false;
}
function visibleLayers() { return tidyLines().map((ls, i) => (project.linework.layers[i].show === false ? [] : ls)); }
function tidyTap(xy) {
  const hit = nearestLine(visibleLayers(), xy, screenToImage(14));
  if (!hit) { toast('No line there. Zoom in and tap right on the squiggle.'); return; }
  pushUndo(snapshot());
  tidy.lines[hit.layer] = tidy.lines[hit.layer].filter((_, i) => i !== hit.index);
  writeBack([hit.layer]);
  renderLines(); refreshCheck(); save();
}
function onLinesDraw(phase, xy) {
  if (!tidy.on || !hasLines()) return;
  if (phase === 'start') { tidy.before = snapshot(); tidy.last = null; }
  if ((phase === 'start' || phase === 'move') && tidy.before) {
    const r = screenToImage(+$('#lines-eraser').value / 2);
    // Fill in between pointer events so a quick stroke leaves no gaps.
    const from = tidy.last || xy;
    const steps = Math.max(1, Math.ceil(Math.hypot(xy[0] - from[0], xy[1] - from[1]) / (r * 0.5)));
    for (let k = 1; k <= steps; k++) {
      const p = [from[0] + (xy[0] - from[0]) * k / steps, from[1] + (xy[1] - from[1]) * k / steps];
      tidy.lines.forEach((ls, i) => { if (project.linework.layers[i].show !== false) tidy.lines[i] = eraseCircle(ls, p, r, screenToImage(3)); });
    }
    tidy.last = xy;
    if (!tidy.frame) tidy.frame = requestAnimationFrame(() => { tidy.frame = 0; writeBack(tidy.lines.map((_, i) => i)); refreshCheck(); });
  }
  if (phase === 'cancel' && tidy.before) {
    tidy.lines = tidy.before; tidy.before = null;
    writeBack(tidy.lines.map((_, i) => i)); refreshCheck();
  }
  if (phase === 'end' && tidy.before) {
    const changed = tidy.before.some((ls, i) => ls.length !== tidy.lines[i].length || ls.some((l, j) => l !== tidy.lines[i][j]));
    if (changed) pushUndo(tidy.before);
    tidy.before = null;
    writeBack(tidy.lines.map((_, i) => i)); renderLines(); refreshCheck(); save();
  }
}
$('#lines-tidy').addEventListener('click', () => setTidy(!tidy.on));
$('#lines-eraser').addEventListener('input', (e) => checkViewer.setDrawMode(tidy.on, +e.target.value));
$('#lines-undo').addEventListener('click', () => {
  const prev = tidy.undo.pop();
  if (!prev) return;
  tidy.lines = prev;
  writeBack(prev.map((_, i) => i));
  $('#lines-undo').disabled = !tidy.undo.length;
  renderLines(); refreshCheck(); save();
});

function syncDrawMode() {
  if (!model && hasLines()) project.draw = 'scan';
  if (!hasLines()) project.draw = 'reference';
  document.querySelectorAll('#draw-mode button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === project.draw);
    b.disabled = b.dataset.mode === 'reference' || b.dataset.mode === 'both' ? !model : !hasLines();
  });
}
document.querySelectorAll('#draw-mode button').forEach((b) => b.addEventListener('click', () => { project.draw = b.dataset.mode; syncDrawMode(); refreshPreview(); save(); }));

// ---------- style and export ----------
function renderStyleList() {
  const box = $('#style-list');
  box.innerHTML = STYLES.map((s) => `<button data-id="${s.id}" class="${s.id === project.style ? 'active' : ''}"><span class="sw" style="background:${s.ocean}"><i style="background:${s.land.palette?.[0] || s.land.fill};border-color:${s.borders.stroke}"></i></span><span><b>${s.name}</b><small>${s.note}</small></span></button>`).join('');
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { project.style = b.dataset.id; renderStyleList(); refreshPreview(); save(); }));
}

function currentFrame() {
  const W = project.image.width, H = project.image.height;
  if (project.frame.preset !== '16:9') return { x: 0, y: 0, w: W, h: H };
  let w = W, h = W * 9 / 16;
  if (h > H) { h = H; w = H * 16 / 9; }
  w /= project.frame.zoom; h /= project.frame.zoom;
  return { x: (W - w) * project.frame.cx, y: (H - h) * project.frame.cy, w, h };
}

for (const id of ['frame-preset', 'frame-zoom', 'frame-x', 'frame-y', 'export-size']) {
  $(`#${id}`).addEventListener('input', () => {
    project.frame = { preset: $('#frame-preset').value, zoom: +$('#frame-zoom').value, cx: +$('#frame-x').value, cy: +$('#frame-y').value };
    project.exportHeight = +$('#export-size').value;
    $('#frame-controls').hidden = project.frame.preset !== '16:9';
    schedulePreview(); save();
  });
}

let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 120); }

async function styledSvg() {
  const style = STYLES.find((s) => s.id === project.style) || STYLES[0];
  const frame = currentFrame();
  const outHeight = project.exportHeight;
  const outWidth = Math.round(frame.w / frame.h * outHeight);
  if (project.draw === 'scan' || !model) return { svg: buildLineworkSvg(project.linework, style, { frame, outWidth, outHeight }), outWidth, outHeight };
  const L = await getLayers();
  return {
    svg: buildSvg(L, style, {
      linework: project.draw === 'both' ? project.linework : null,
      frame, outWidth, outHeight,
      show: { ...project.show, labels: project.show.countryLabels || project.show.placeLabels },
      highlight: project.highlight, fade: project.fade, names: project.names, labelHide: project.labelHide,
      traced: project.traced
    }),
    outWidth, outHeight
  };
}

let previewUrl = null;
async function refreshPreview() {
  if (view !== 'style' || (!model && !hasLines())) return;
  const { svg } = await styledSvg();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  $('#preview').innerHTML = `<img src="${previewUrl}" alt="Styled map preview">`;
}

const fileBase = () => (project.name || 'map').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'map';
$('#export-svg').addEventListener('click', async () => {
  const { svg } = await styledSvg();
  download(`${fileBase()}-${project.style}.svg`, svg, 'image/svg+xml');
});
$('#export-png').addEventListener('click', async () => {
  const { svg, outWidth, outHeight } = await styledSvg();
  toast('Rendering PNG…');
  const png = await svgToPng(svg, outWidth, outHeight);
  download(`${fileBase()}-${project.style}-${outHeight}p.png`, png, 'image/png');
});
$('#export-geojson').addEventListener('click', async () => {
  if (!model) { toast('GeoJSON needs matching points, so it knows where on Earth the lines are. Use Layered SVG for scan lines.', 5000); return; }
  const L = await getLayers();
  const ref = await getRef(project.detail);
  const ids = new Set(L.countries.map((c) => c.id));
  const features = ref.countries.filter((c) => ids.has(c.id)).map((c) => ({
    type: 'Feature', id: c.id, geometry: c.geometry,
    properties: { layer: 'countries', name: project.names[c.id] || c.properties.name, code: c.id, state: project.highlight.includes(c.id) ? 'highlight' : project.fade.includes(c.id) ? 'fade' : 'normal' }
  }));
  for (const g of project.gcps.filter((q) => q.pixel && q.lonlat)) {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: g.lonlat }, properties: { layer: 'control-points', pixel: g.pixel, place: g.place || null } });
  }
  const osm = L.osmRaw;
  if (osm) {
    const add = (layer, list) => list.forEach((f) => features.push({ type: 'Feature', geometry: f.geometry, properties: { layer, ...(f.properties || {}) } }));
    // With matching on, export only the streets kept, taken back to lon/lat.
    const matched = L.osm?.matched;
    if (matched) {
      for (const [cls, lines] of Object.entries(matched)) {
        const coords = lines.map((l) => l.map((p) => model.pixelToLonlat(p)).filter((q) => q && isFinite(q[0])));
        if (coords.length) features.push({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: coords }, properties: { layer: 'roads', class: cls, matched: true } });
      }
    } else add('roads', osm.roads);
    add('water', osm.water); add('waterways', osm.waterways); add('parks', osm.parks); add('places', osm.places);
  }
  const source = osm ? `Natural Earth (public domain); ${OSM_ATTRIBUTION} (ODbL)` : 'Natural Earth (public domain)';
  const fc = { type: 'FeatureCollection', properties: { source, georef: project.georef }, features };
  download(`${fileBase()}.geojson`, JSON.stringify(fc), 'application/geo+json');
});

// ---------- projects ----------
$('#save-project').addEventListener('click', () => {
  download(`${fileBase()}.mapstyle.json`, JSON.stringify(project), 'application/json');
});
$('#open-project').addEventListener('click', async () => {
  const file = await pickFile('.json,application/json');
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    if (!p.version || !Array.isArray(p.gcps)) throw new Error('not a Map Stylizer project');
    await loadProject({ ...newProject(), ...p });
    save();
  } catch (err) { toast(`Could not open that file: ${err.message}`); }
});

async function loadProject(p) {
  project = p;
  nextId = Math.max(0, ...project.gcps.map((g) => +g.id || 0)) + 1;
  pending = null; selectedPin = null; selectedCountry = null; layersCache = null;
  await setImage();
  syncControls();
  refit();
  renderPins();
  showView('pin');
}

let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => autosave(project), 400); }

// ---------- helpers ----------
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function fmtLat(v) { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`; }
function fmtLon(v) { return `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`; }

// ---------- start ----------
$('#build').textContent = __BUILD__;
restore().then((p) => (p ? loadProject({ ...newProject(), ...p }) : (syncControls(), renderPins())));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${BASE}sw.js`).catch(() => {});
}
