// Map projections the georeferencer can fit against.
// Every projection is built at a fixed scale with no translation, so its
// output is a stable planar space that the GCP transformation maps to pixels.
import {
  geoEquirectangular, geoMercator, geoTransverseMercator, geoEqualEarth,
  geoNaturalEarth1, geoConicConformal, geoConicEqualArea, geoOrthographic,
  geoAzimuthalEquidistant, geoStereographic
} from 'd3-geo';
import {
  geoRobinson, geoWinkel3, geoMollweide, geoMiller, geoEckert4,
  geoKavrayskiy7, geoVanDerGrinten, geoTimes, geoPatterson
} from 'd3-geo-projection';

export const PLANAR_SCALE = 1000;

// `centred` projections take their centre or standard parallels from the
// control points; the others are world projections that only need a central meridian.
export const PROJECTIONS = [
  { id: 'equirectangular', name: 'Plate carrée (lat/lon grid)', make: geoEquirectangular },
  { id: 'mercator', name: 'Mercator', make: geoMercator },
  { id: 'miller', name: 'Miller cylindrical', make: geoMiller },
  { id: 'robinson', name: 'Robinson', make: geoRobinson },
  { id: 'winkel3', name: 'Winkel tripel', make: geoWinkel3 },
  { id: 'naturalEarth1', name: 'Natural Earth', make: geoNaturalEarth1 },
  { id: 'equalEarth', name: 'Equal Earth', make: geoEqualEarth },
  { id: 'mollweide', name: 'Mollweide', make: geoMollweide },
  { id: 'eckert4', name: 'Eckert IV', make: geoEckert4 },
  { id: 'kavrayskiy7', name: 'Kavrayskiy VII', make: geoKavrayskiy7 },
  { id: 'vanDerGrinten', name: 'Van der Grinten', make: geoVanDerGrinten },
  { id: 'times', name: 'Times', make: geoTimes },
  { id: 'patterson', name: 'Patterson', make: geoPatterson },
  { id: 'lambertConic', name: 'Lambert conformal conic', make: geoConicConformal, centred: 'conic' },
  { id: 'albers', name: 'Albers equal-area conic', make: geoConicEqualArea, centred: 'conic' },
  { id: 'transverseMercator', name: 'Transverse Mercator', make: geoTransverseMercator, centred: 'point' },
  { id: 'orthographic', name: 'Orthographic (globe)', make: geoOrthographic, centred: 'point' },
  { id: 'azimuthalEquidistant', name: 'Azimuthal equidistant', make: geoAzimuthalEquidistant, centred: 'point' },
  { id: 'stereographic', name: 'Stereographic', make: geoStereographic, centred: 'point' }
];

export function projectionInfo(id) {
  return PROJECTIONS.find((p) => p.id === id) || PROJECTIONS[0];
}

// Choose centre and parallels from the control points' geographic spread.
export function defaultParams(id, lonLats) {
  const info = projectionInfo(id);
  if (!lonLats.length) return { lon0: 0 };
  const lons = lonLats.map((p) => p[0]);
  const lats = lonLats.map((p) => p[1]);
  const lon0 = round2(circularMeanLon(lons));
  const lat0 = round2((Math.min(...lats) + Math.max(...lats)) / 2);
  if (info.centred === 'conic') {
    const span = Math.max(...lats) - Math.min(...lats);
    return { lon0, lat0, parallels: [round2(lat0 - span / 3), round2(lat0 + span / 3)] };
  }
  if (info.centred === 'point') return { lon0, lat0 };
  // Most world maps are centred on Greenwich or the Pacific; snap to those
  // when the points are spread widely, otherwise keep the data's centre.
  const span = Math.max(...lons) - Math.min(...lons);
  return { lon0: span > 200 ? 0 : lon0 };
}

export function makeProjection(id, params = {}) {
  const info = projectionInfo(id);
  const p = info.make().scale(PLANAR_SCALE).translate([0, 0]).precision(0.05);
  const lon0 = params.lon0 || 0;
  if (info.centred === 'conic') {
    p.rotate([-lon0, 0]).center([0, params.lat0 || 0]);
    if (params.parallels) p.parallels(params.parallels);
  } else if (info.centred === 'point') {
    p.rotate([-lon0, -(params.lat0 || 0)]);
    if (p.clipAngle && id !== 'transverseMercator') p.clipAngle(id === 'orthographic' ? 90 : 170);
  } else {
    p.rotate([-lon0, 0]);
  }
  return p;
}

function circularMeanLon(lons) {
  let x = 0, y = 0;
  for (const l of lons) { x += Math.cos(l * Math.PI / 180); y += Math.sin(l * Math.PI / 180); }
  return Math.atan2(y, x) * 180 / Math.PI;
}

function round2(v) { return Math.round(v * 100) / 100; }
