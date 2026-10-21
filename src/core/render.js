// Carries reference geometry onto the scanned map: lon/lat -> projection ->
// fitted transformation -> image pixels, as SVG path data.
import { geoPath, geoClipRectangle } from 'd3-geo';
import { makeProjection } from './projections.js';
import { matchLines, linesToPath, lineLength } from './match.js';

export function makePixelPath(model, width, height, margin = 0.15) {
  const proj = makeProjection(model.projection, model.params);
  const box = planarBox(model, width, height, margin);
  if (box) proj.postclip(geoClipRectangle(box[0], box[1], box[2], box[3]));
  const toPixel = model.toPixel;
  const pixelProjection = {
    stream(s) {
      return proj.stream({
        point(x, y) { const p = toPixel([x, y]); s.point(p[0], p[1]); },
        lineStart() { s.lineStart(); },
        lineEnd() { s.lineEnd(); },
        polygonStart() { s.polygonStart(); },
        polygonEnd() { s.polygonEnd(); },
        sphere() { s.sphere?.(); }
      });
    }
  };
  const path = geoPath(pixelProjection).digits(1);
  const inFrame = (f) => {
    const b = path.bounds(f);
    return isFinite(b[0][0]) && b[1][0] >= -width * margin && b[0][0] <= width * (1 + margin) &&
      b[1][1] >= -height * margin && b[0][1] <= height * (1 + margin);
  };
  const point = (ll) => {
    const xy = proj(ll);
    return xy ? toPixel(xy) : null;
  };
  // The same geometry as polylines, for tests against the image.
  const lines = (f) => {
    const out = [];
    let cur = null;
    geoPath(pixelProjection, {
      moveTo(x, y) { cur = [[x, y]]; out.push(cur); },
      lineTo(x, y) { cur.push([x, y]); },
      closePath() {}, arc() {}
    })(f);
    return out.filter((l) => l.length > 1);
  };
  return { path, inFrame, point, lines };
}

// The image outline, sampled along its edges and taken back into planar
// space, gives the area of the world worth drawing.
function planarBox(model, w, h, margin) {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([t * w, 0], [t * w, h], [0, t * h], [w, t * h]);
  }
  const planar = pts.map((p) => model.toPlanar(p)).filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
  if (planar.length < 4) return null;
  const xs = planar.map((p) => p[0]), ys = planar.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
  return [x0 - mx, y0 - my, x1 + mx, y1 + my];
}

// Builds every layer in image pixel space. `options` decides how much detail
// to keep; the style decides how it looks.
export function buildPixelLayers(ref, model, width, height, options = {}) {
  const { path, inFrame, point, lines } = makePixelPath(model, width, height);
  const o = { riverRank: 6, placeRank: 3, placeLimit: 40, provinces: true, ...options };
  const onImage = (p) => p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;

  const countries = ref.countries.filter(inFrame).map((f) => {
    const label = point(f.properties.label);
    const b = path.bounds(f);
    return { id: f.properties.code, name: f.properties.name, colour: f.properties.colour, d: path(f) || '', label: onImage(label) ? label : null, area: path.area(f), box: [b[0][0], b[0][1], b[1][0], b[1][1]] };
  }).filter((c) => c.d);

  const shownCountries = new Set(countries.map((c) => c.id));
  const provinces = o.provinces
    ? ref.provinces.filter((f) => shownCountries.has(f.properties.country) && inFrame(f)).map((f) => {
        const label = point(f.properties.label);
        return { id: f.properties.code, name: f.properties.name, country: f.properties.country, d: path(f) || '', label: onImage(label) ? label : null };
      }).filter((p) => p.d)
    : [];

  const lakes = ref.lakes.filter(inFrame).map((f) => ({ name: f.properties.name, d: path(f) || '' })).filter((l) => l.d);
  const rivers = ref.rivers
    .filter((f) => (f.properties.scalerank ?? 0) <= o.riverRank && inFrame(f))
    .map((f) => ({ name: f.properties.name, rank: f.properties.scalerank, d: path(f) || '' }))
    .filter((r) => r.d);

  const places = ref.places
    .filter((f) => f.properties.rank <= o.placeRank || f.properties.capital)
    .map((f) => ({ ...f.properties, xy: point(f.geometry.coordinates) }))
    .filter((p) => onImage(p.xy))
    .sort((a, b) => (b.capital - a.capital) || (b.population - a.population))
    .slice(0, o.placeLimit)
    .map((p) => ({ name: p.name, x: p.xy[0], y: p.xy[1], capital: p.capital, population: p.population }));

  return {
    width, height,
    osm: o.osm ? buildOsmLayers(o.osm, { path, point, lines }, width, height, o.match) : null,
    countries,
    provinces,
    borders: path(ref.borders) || '',
    coastline: path(ref.coastline) || '',
    provinceLines: o.provinces ? (path(ref.provinceLines) || '') : '',
    lakes, rivers, places,
    graticule: path(ref.graticule) || ''
  };
}

// City-scale layers from OpenStreetMap, merged into one path per class so the
// SVG stays light enough for After Effects. With `match`, only the streets
// drawn on the scanned map are kept (see match.js).
function buildOsmLayers(osm, { path, point, lines }, width, height, match) {
  const fc = (features) => ({ type: 'FeatureCollection', features });
  const onImage = (p) => p && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height;
  const roads = {};
  const matched = match ? {} : null;
  let dropped = '';
  const density = match ? new Density(width, height) : null;
  for (const cls of ['major', 'medium', 'minor', 'rail', 'ferry']) {
    const features = osm.roads.filter((r) => r.properties.class === cls);
    if (!match || cls === 'ferry') { roads[cls] = path(fc(features)) || ''; continue; }
    // Service roads and tracks are almost never on old maps, and sit close
    // enough to block outlines to fool the ink test.
    const keepable = features.filter((r) => !MINOR_EXTRAS.has(r.properties.kind));
    const all = keepable.flatMap(lines);
    const r = matchLines(all, match.img, match.scale, match.settings);
    roads[cls] = linesToPath(r.kept);
    matched[cls] = r.kept;
    dropped += linesToPath(r.dropped) + path(fc(features.filter((f) => MINOR_EXTRAS.has(f.properties.kind))));
    if (cls !== 'rail') { density.add(r.kept, true); density.add(r.dropped, false); }
  }
  const places = [];
  const seen = new Set();
  for (const f of osm.places) {
    const xy = point(f.geometry.coordinates);
    if (!onImage(xy) || seen.has(f.properties.name)) continue;
    // A neighbourhood whose streets are nearly all missing from the map
    // did not exist yet, or was not drawn.
    if (density && f.properties.class !== 'city' && f.properties.class !== 'town' && density.share(xy) < 0.3) continue;
    seen.add(f.properties.name);
    places.push({ name: f.properties.name, class: f.properties.class, x: xy[0], y: xy[1] });
  }
  return {
    water: path(fc(osm.water)) || '',
    waterways: path(fc(osm.waterways)) || '',
    parks: path(fc(osm.parks)) || '',
    buildings: path(fc(osm.buildings)) || '',
    roads,
    matched,
    dropped,
    streetNames: streetNameCandidates(osm.names, point, onImage, match),
    places
  };
}

const MINOR_EXTRAS = new Set(['service', 'track', 'raceway', 'busway']);

// Kept and total street length on a coarse grid, to judge an area as a whole.
class Density {
  constructor(w, h) { this.cell = Math.max(w, h) / 12; this.cols = Math.ceil(w / this.cell) + 1; this.kept = new Map(); this.all = new Map(); }
  add(lines, kept) {
    for (const l of lines) {
      const len = lineLength(l), m = l[Math.floor(l.length / 2)];
      const k = Math.floor(m[1] / this.cell) * this.cols + Math.floor(m[0] / this.cell);
      this.all.set(k, (this.all.get(k) || 0) + len);
      if (kept) this.kept.set(k, (this.kept.get(k) || 0) + len);
    }
  }
  share([x, y]) {
    let kept = 0, all = 0;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = (cy + dy) * this.cols + cx + dx;
      kept += this.kept.get(k) || 0; all += this.all.get(k) || 0;
    }
    return all ? kept / all : 1;
  }
}

// The longest on-image piece of each named street (with `match`, the longest
// piece drawn on the map). svg.js turns it the right way up.
function streetNameCandidates(names, point, onImage, match) {
  const best = new Map();
  for (const f of names) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    for (const line of lines) {
      const raw = line.map(point).filter(Boolean);
      if (raw.length < 2 || !raw.every(onImage)) continue;
      const pieces = match ? matchLines([raw], match.img, match.scale, match.settings).kept : [raw];
      for (const pts of pieces) {
        const length = lineLength(pts);
        const prev = best.get(f.properties.name);
        if (!prev || prev.length < length) best.set(f.properties.name, { name: f.properties.name, class: f.properties.class, length, points: pts });
      }
    }
  }
  const rank = { major: 0, medium: 1, minor: 2 };
  return [...best.values()]
    .sort((a, b) => rank[a.class] - rank[b.class] || b.length - a.length)
    .map((c) => ({ ...c, d: 'M' + c.points.map((p) => `${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`).join('L') }));
}
