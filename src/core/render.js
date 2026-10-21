// Carries reference geometry onto the scanned map: lon/lat -> projection ->
// fitted transformation -> image pixels, as SVG path data.
import { geoPath, geoClipRectangle } from 'd3-geo';
import { makeProjection } from './projections.js';

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
  return { path, inFrame, point };
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
  const { path, inFrame, point } = makePixelPath(model, width, height);
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
    countries,
    provinces,
    borders: path(ref.borders) || '',
    coastline: path(ref.coastline) || '',
    provinceLines: o.provinces ? (path(ref.provinceLines) || '') : '',
    lakes, rivers, places,
    graticule: path(ref.graticule) || ''
  };
}
