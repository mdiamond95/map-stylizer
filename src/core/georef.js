// Georeferencing: fits a transformation between image pixels and a planar
// projection using ground control points (GCPs), with Allmaps doing the maths.
import { GeneralGcpTransformer } from '@allmaps/transform';
import { PROJECTIONS, makeProjection, defaultParams, projectionInfo } from './projections.js';

export const TRANSFORMS = [
  { id: 'helmert', name: 'Shift, scale, rotate', min: 2 },
  { id: 'polynomial', name: 'Affine (straight lines stay straight)', min: 3 },
  { id: 'projective', name: 'Perspective (photo of a page)', min: 4 },
  { id: 'polynomial2', name: 'Gentle curve (2nd order)', min: 6 },
  { id: 'thinPlateSpline', name: 'Rubber sheet (hand-drawn, old maps)', min: 3 }
];

export function minPoints(transform) {
  return (TRANSFORMS.find((t) => t.id === transform) || TRANSFORMS[1]).min;
}

// gcps: [{ id, pixel: [x, y], lonlat: [lon, lat] }]
// Returns null when there are too few points for the chosen transform.
export function fitModel({ gcps, projection = 'equirectangular', params, transform = 'polynomial', loo = true }) {
  const usable = gcps.filter((g) => g.pixel && g.lonlat);
  if (usable.length < minPoints(transform)) return null;
  const proj = makeProjection(projection, params || defaultParams(projection, usable.map((g) => g.lonlat)));
  const pairs = usable.map((g) => ({ g, planar: proj(g.lonlat) })).filter((p) => p.planar && isFinite(p.planar[0]));
  if (pairs.length < minPoints(transform)) return null;

  // Source is planar map space, destination is image pixels, so "forward"
  // carries reference data onto the scan.
  const toPixelT = new GeneralGcpTransformer(
    pairs.map((p) => ({ source: p.planar, destination: p.g.pixel })), transform
  );
  const toPlanarT = new GeneralGcpTransformer(
    pairs.map((p) => ({ source: p.g.pixel, destination: p.planar })), transform
  );
  const toPixel = (xy) => toPixelT.transformForward(xy);
  const toPlanar = (px) => toPlanarT.transformForward(px);

  const residuals = pairs.map((p) => {
    const q = toPixel(p.planar);
    return { id: p.g.id, dx: q[0] - p.g.pixel[0], dy: q[1] - p.g.pixel[1], error: Math.hypot(q[0] - p.g.pixel[0], q[1] - p.g.pixel[1]) };
  });
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r.error ** 2, 0) / residuals.length);

  return {
    projection, transform, proj,
    params: params || defaultParams(projection, usable.map((g) => g.lonlat)),
    toPixel, toPlanar,
    lonlatToPixel: (ll) => { const xy = proj(ll); return xy ? toPixel(xy) : null; },
    pixelToLonlat: (px) => proj.invert(toPlanar(px)),
    residuals, rmse,
    // Exact-fit transforms (rubber sheet) always have zero residuals, so the
    // honest accuracy figure is how well each point is predicted by the others.
    looRmse: loo ? leaveOneOut(pairs, transform) : null
  };
}

function leaveOneOut(pairs, transform) {
  const need = minPoints(transform) + 1;
  if (pairs.length < Math.max(need, 4)) return null;
  let sum = 0;
  for (let i = 0; i < pairs.length; i++) {
    const rest = pairs.filter((_, j) => j !== i);
    try {
      const t = new GeneralGcpTransformer(rest.map((p) => ({ source: p.planar, destination: p.g.pixel })), transform);
      const q = t.transformForward(pairs[i].planar);
      sum += (q[0] - pairs[i].g.pixel[0]) ** 2 + (q[1] - pairs[i].g.pixel[1]) ** 2;
    } catch { return null; }
  }
  return Math.sqrt(sum / pairs.length);
}

// Tries every projection with an affine fit and ranks them by error.
// The right projection makes an affine fit near-perfect; wrong ones leave
// a curved, systematic error. Each projection's centre and standard
// parallels are tuned to the points first, so a map centred on the
// Pacific or drawn on custom parallels is still recognised.
export function rankProjections(gcps) {
  const usable = gcps.filter((g) => g.pixel && g.lonlat);
  if (usable.length < 4) return [];
  const out = [];
  for (const p of PROJECTIONS) {
    try {
      const params = optimiseParams(usable, p.id);
      const m = fitModel({ gcps: usable, projection: p.id, params, transform: 'polynomial' });
      if (m && isFinite(m.rmse)) out.push({ id: p.id, name: p.name, rmse: m.rmse, looRmse: m.looRmse, params });
    } catch { /* projection can't place one of the points */ }
  }
  return out.sort((a, b) => a.rmse - b.rmse);
}

export function optimiseParams(gcps, projection) {
  const info = projectionInfo(projection);
  const start = defaultParams(projection, gcps.map((g) => g.lonlat));
  const keys = info.centred === 'conic' ? ['lon0', 'p0', 'p1'] : info.centred === 'point' ? ['lon0', 'lat0'] : ['lon0'];
  const toParams = (v) => {
    const o = { ...start, lon0: wrapLon(v.lon0) };
    if ('lat0' in v) o.lat0 = clamp(v.lat0, -89, 89);
    if ('p0' in v) o.parallels = [clamp(v.p0, -89, 89), clamp(v.p1, -89, 89)];
    return o;
  };
  const cost = (v) => {
    try {
      const m = fitModel({ gcps, projection, params: toParams(v), transform: 'polynomial', loo: false });
      return m && isFinite(m.rmse) ? m.rmse : Infinity;
    } catch { return Infinity; }
  };
  let v = { lon0: start.lon0 };
  if (keys.includes('lat0')) v.lat0 = start.lat0;
  if (keys.includes('p0')) { v.p0 = start.parallels[0]; v.p1 = start.parallels[1]; }
  // A coarse sweep of the central meridian avoids settling on a wrong local minimum.
  let best = cost(v);
  for (let lon = -180; lon < 180; lon += 30) {
    const c = cost({ ...v, lon0: lon });
    if (c < best) { best = c; v = { ...v, lon0: lon }; }
  }
  const steps = { lon0: 15, lat0: 10, p0: 10, p1: 10 };
  for (let iter = 0; iter < 60; iter++) {
    let improved = false;
    for (const key of keys) {
      for (const dir of [1, -1]) {
        const trial = { ...v, [key]: v[key] + dir * steps[key] };
        const c = cost(trial);
        if (c < best - 1e-9) { best = c; v = trial; improved = true; break; }
      }
    }
    if (!improved) {
      for (const key of keys) steps[key] /= 2;
      if (Math.max(...keys.map((k) => steps[k])) < 0.02) break;
    }
  }
  const out = toParams(v);
  out.lon0 = round(out.lon0);
  if (out.lat0 != null) out.lat0 = round(out.lat0);
  if (out.parallels) out.parallels = out.parallels.map(round);
  return out;
}

function wrapLon(l) { return ((l + 540) % 360) - 180; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round(v) { return Math.round(v * 100) / 100; }
