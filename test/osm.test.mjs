// City-scale pipeline with synthetic vector tiles in the OpenMapTiles schema:
// decode tiles, place OSM roads and water on a fake rotated city map, render SVG.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { geoMercator } from 'd3-geo';
import { loadOsm, tilesForBbox } from '../src/core/osm.js';
import { fitModel } from '../src/core/georef.js';
import { buildReference } from '../src/core/reference.js';
import { buildPixelLayers } from '../src/core/render.js';
import { buildSvg } from '../src/core/svg.js';
import { loadTopo, loadStyle } from '../tools/lib.mjs';

// A small grid town on a coast near Halifax.
const lon0 = -63.60, lat0 = 44.64, d = 0.004;
const roads = [], names = [];
for (let i = 0; i <= 8; i++) {
  const cls = i % 4 === 0 ? 'primary' : i % 2 === 0 ? 'secondary' : 'minor';
  const ns = [[lon0 + i * d, lat0], [lon0 + i * d, lat0 + 8 * d]];
  const ew = [[lon0, lat0 + i * d], [lon0 + 8 * d, lat0 + i * d]];
  roads.push({ type: 'Feature', properties: { class: cls }, geometry: { type: 'LineString', coordinates: ns } });
  roads.push({ type: 'Feature', properties: { class: cls }, geometry: { type: 'LineString', coordinates: ew } });
  names.push({ type: 'Feature', properties: { class: cls, name: `North ${i} Street` }, geometry: { type: 'LineString', coordinates: ns } });
  names.push({ type: 'Feature', properties: { class: cls, name: `${i} Avenue` }, geometry: { type: 'LineString', coordinates: ew } });
}
roads.push({ type: 'Feature', properties: { class: 'rail' }, geometry: { type: 'LineString', coordinates: [[lon0, lat0 + 3.5 * d], [lon0 + 8 * d, lat0 + 6.5 * d]] } });
// Ocean wound clockwise in lon/lat on purpose: the decoder must cope with either direction.
const water = [{ type: 'Feature', properties: { class: 'ocean' }, geometry: { type: 'Polygon', coordinates: [[[lon0 - 0.05, lat0 - 0.05], [lon0 - 0.05, lat0 + 0.1 * d], [lon0 + 0.06, lat0 + 0.1 * d], [lon0 + 0.06, lat0 - 0.05], [lon0 - 0.05, lat0 - 0.05]]] } }];
const park = [{ type: 'Feature', properties: { class: 'park' }, geometry: { type: 'Polygon', coordinates: [[[lon0 + d, lat0 + d], [lon0 + 3 * d, lat0 + d], [lon0 + 3 * d, lat0 + 3 * d], [lon0 + d, lat0 + 3 * d], [lon0 + d, lat0 + d]]] } }];
const place = [{ type: 'Feature', properties: { class: 'neighbourhood', name: 'Testville' }, geometry: { type: 'Point', coordinates: [lon0 + 5 * d, lat0 + 5 * d] } }];
const index = Object.fromEntries(Object.entries({ transportation: roads, transportation_name: names, water, park, place })
  .map(([k, fs]) => [k, new geojsonvt({ type: 'FeatureCollection', features: fs }, { maxZoom: 14, indexMaxZoom: 14, tolerance: 0, buffer: 64 })]));
const fetchTile = async (z, x, y) => {
  const layers = {};
  for (const [k, ix] of Object.entries(index)) { const t = ix.getTile(z, x, y); if (t) layers[k] = t; }
  return Object.keys(layers).length ? vtpbf.fromGeojsonVt(layers, { version: 2 }) : null;
};

const bbox = [lon0 - 0.005, lat0 - 0.005, lon0 + 9 * d, lat0 + 9 * d];
console.log('tiles', tilesForBbox(bbox).tiles.length, 'at zoom', tilesForBbox(bbox).z);
const osm = await loadOsm(bbox, fetchTile);
console.log('decoded', { roads: osm.roads.length, names: osm.names.length, water: osm.water.length, parks: osm.parks.length, places: osm.places.length });
assert.ok(osm.roads.length >= 19 && osm.water.length >= 1 && osm.places.length === 1);

// The "scan": Mercator, rotated 60 degrees like an old city map with north to the right.
const W = 2400, H = 1800;
const merc = geoMercator().center([lon0 + 4 * d, lat0 + 4 * d]).scale(2_000_000).translate([0, 0]);
const a = 60 * Math.PI / 180;
const toScan = (ll) => { const [x, y] = merc(ll); return [W / 2 + x * Math.cos(a) - y * Math.sin(a), H / 2 + x * Math.sin(a) + y * Math.cos(a)]; };
const gcps = [[0, 0], [8, 0], [0, 8], [8, 8], [4, 4], [2, 6]].map(([i, j], k) => {
  const ll = [lon0 + i * d, lat0 + j * d];
  return { id: String(k), lonlat: ll, pixel: toScan(ll) };
});
const model = fitModel({ gcps, projection: 'mercator', transform: 'polynomial' });
console.log('fit rmse', model.rmse.toFixed(3));
assert.ok(model.rmse < 0.5);
const layers = buildPixelLayers(buildReference(loadTopo('medium')), model, W, H, { osm });
assert.ok(layers.osm.roads.major.length > 100 && layers.osm.water.length > 20);
assert.ok(layers.osm.streetNames.length >= 10);
fs.mkdirSync('test/out', { recursive: true });
for (const id of ['clean-explainer', 'vintage-atlas', 'neon', 'minimal']) {
  fs.writeFileSync(`test/out/city-${id}.svg`, buildSvg(layers, loadStyle(id), { outHeight: 1440, outWidth: 1920 }));
}
console.log('city svgs written');
