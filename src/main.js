import './app.css';
import { PROJECTIONS } from './core/projections.js';
import { TRANSFORMS, fitModel, minPoints, optimiseParams } from './core/georef.js';
import { buildReference, searchPlaces, DETAIL_LEVELS } from './core/reference.js';
import { makePixelPath, buildPixelLayers } from './core/render.js';
import { buildSvg } from './core/svg.js';
import { STYLES } from './styles/index.js';
import { ImageViewer } from './ui/viewer.js';
import { RefMap } from './ui/refmap.js';
import { sampleColour, traceColour } from './ui/trace.js';
import { download, pickFile, readAsDataUrl, loadImage, svgToPng, autosave, restore } from './ui/files.js';

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
    options: { riverRank: 6, placeLimit: 40, placeRank: 4 },
    show: { land: true, borders: true, coastline: true, provinceLines: true, rivers: true, lakes: true, places: true, countryLabels: true, placeLabels: true, graticule: false, traced: true },
    highlight: [], fade: [], names: {}, labelHide: [],
    traced: [],
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
async function getRef(detail) {
  if (!refs[detail]) {
    const file = DETAIL_LEVELS.find((d) => d.id === detail).file;
    refs[detail] = fetch(`${BASE}data/${file}`).then((r) => r.json()).then(buildReference);
  }
  return refs[detail];
}

// ---------- views ----------
const pinViewer = new ImageViewer($('#pin-image'), { onTap: onPinImageTap, onPinMove: (id, xy) => updatePin(id, { pixel: xy }) });
const checkViewer = new ImageViewer($('#check-image'), { onTap: onCheckTap });
const refMap = new RefMap($('#pin-map'), {
  onTap: onMapTap,
  onPinMove: (id, ll) => updatePin(id, { lonlat: ll })
});
getRef('medium').then((ref) => refMap.setReference(ref));

let view = 'pin';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  if (v !== 'pin' && !model) { toast(project.image ? `Place at least ${minPoints(project.georef.transform)} matching points first.` : 'Open a map image first.'); return; }
  view = v;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'pin') { refMap.resize(); pinViewer.fit(); }
  if (v === 'check') { checkViewer.fit(); refreshCheck(); }
  if (v === 'style') refreshPreview();
}

// ---------- image ----------
$('#open-image').addEventListener('click', async () => {
  const file = await pickFile('image/*');
  if (!file) return;
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const keepPins = project.gcps.length && confirm('Keep the points from the current map?');
  project = { ...(keepPins ? project : newProject()), image: { name: file.name, width: img.naturalWidth, height: img.naturalHeight, dataUrl } };
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
  else hint.textContent = 'Looking good. Add points where lines drift, or go to Check.';
}

// ---------- fitting ----------
function populateSelects() {
  $('#projection').innerHTML = PROJECTIONS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#transform').innerHTML = TRANSFORMS.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  $('#detail').innerHTML = DETAIL_LEVELS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
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
  drawPinOverlay();
}

async function drawPinOverlay() {
  if (!model) return;
  const ref = await getRef('medium');
  const { path } = makePixelPath(model, project.image.width, project.image.height);
  pinViewer.setOverlay(`<path class="ov-coast" d="${path(ref.coastline) || ''}"/><path class="ov-border" d="${path(ref.borders) || ''}"/>`);
}

// ---------- place search ----------
$('#place-search').addEventListener('input', async (e) => {
  const ref = await getRef('medium');
  const hits = searchPlaces(ref, e.target.value);
  const ul = $('#place-results');
  ul.innerHTML = hits.map((h, i) => `<li data-i="${i}">${esc(h.name)} <small>${esc(h.detail || '')}</small></li>`).join('');
  ul.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    const h = hits[+li.dataset.i];
    refMap.flyTo(h.lonlat, 4);
    if (project.image) completeWithLonlat(h.lonlat, h.name);
    ul.innerHTML = '';
    e.target.value = '';
  }));
});

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
  $('#river-rank').value = project.options.riverRank;
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
}

$('#project-name').addEventListener('change', (e) => { project.name = e.target.value.trim() || 'Untitled map'; save(); });
$('#detail').addEventListener('change', (e) => { project.detail = e.target.value; layersCache = null; refreshCheck(); save(); });
$('#river-rank').addEventListener('change', (e) => { project.options.riverRank = +e.target.value; layersCache = null; refreshCheck(); save(); });
$('#place-limit').addEventListener('change', (e) => { project.options.placeLimit = +e.target.value; layersCache = null; refreshCheck(); save(); });
$('#image-opacity').addEventListener('input', (e) => checkViewer.setImageOpacity(e.target.value));
$('#vector-opacity').addEventListener('input', (e) => checkViewer.setOverlayOpacity(e.target.value));

async function getLayers() {
  if (layersCache) return layersCache;
  const ref = await getRef(project.detail);
  if (!model) return null;
  toast('Drawing layers…', 800);
  layersCache = buildPixelLayers(ref, model, project.image.width, project.image.height, {
    riverRank: project.options.riverRank,
    placeRank: project.options.placeRank,
    placeLimit: project.options.placeLimit,
    provinces: true
  });
  return layersCache;
}

async function refreshCheck() {
  if (view !== 'check') return;
  const L = await getLayers();
  if (!L) return;
  const sh = project.show;
  const hi = new Set(project.highlight), fa = new Set(project.fade);
  let out = '';
  if (sh.land) out += `<g class="ck-land">${L.countries.map((c) => `<path data-id="${c.id}" class="${hi.has(c.id) ? 'hi' : fa.has(c.id) ? 'fa' : ''} ${c.id === selectedCountry ? 'sel' : ''}" d="${c.d}"/>`).join('')}</g>`;
  if (sh.graticule) out += `<path class="ck-grat" d="${L.graticule}"/>`;
  if (sh.lakes) out += L.lakes.map((l) => `<path class="ck-lake" d="${l.d}"/>`).join('');
  if (sh.rivers) out += L.rivers.map((r) => `<path class="ck-river" d="${r.d}"/>`).join('');
  if (sh.provinceLines) out += `<path class="ck-prov" d="${L.provinceLines}"/>`;
  if (sh.borders) out += `<path class="ck-border" d="${L.borders}"/>`;
  if (sh.coastline) out += `<path class="ck-coast" d="${L.coastline}"/>`;
  if (sh.traced) out += project.traced.map((t) => `<g class="ck-traced">${t.paths.map((d) => `<path d="${d}" fill="${t.fill}"/>`).join('')}</g>`).join('');
  if (sh.places) out += L.places.map((p) => `<circle class="ck-place" cx="${p.x}" cy="${p.y}" r="${Math.max(2, project.image.width / 600)}"/>`).join('');
  checkViewer.setOverlay(out);
  renderSelection(L);
}

function onCheckTap(xy, info) {
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
    if (coverage > 0.6) toast('That colour covers most of the map; try a lower tolerance.');
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
  const L = await getLayers();
  const style = STYLES.find((s) => s.id === project.style) || STYLES[0];
  const frame = currentFrame();
  const outHeight = project.exportHeight;
  const outWidth = Math.round(frame.w / frame.h * outHeight);
  return {
    svg: buildSvg(L, style, {
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
  if (view !== 'style' || !model) return;
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
  const fc = { type: 'FeatureCollection', properties: { source: 'Natural Earth (public domain)', georef: project.georef }, features };
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
restore().then((p) => (p ? loadProject({ ...newProject(), ...p }) : (syncControls(), renderPins())));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register(`${BASE}sw.js`).catch(() => {});
}
