// Synthetic end-to-end check: fake a Robinson world map, georeference it from
// nine cities, then render every style to SVG.
import fs from 'node:fs';
import { geoRobinson } from 'd3-geo-projection';
import { fitModel, rankProjections } from '../src/core/georef.js';
import { buildReference } from '../src/core/reference.js';
import { buildPixelLayers } from '../src/core/render.js';
import { buildSvg } from '../src/core/svg.js';
import { loadTopo, loadStyle } from '../tools/lib.mjs';

const W = 1920, H = 1000;
const truth = geoRobinson().scale(310).translate([W / 2, H / 2]).rotate([-10, 0]);
const cities = [[-113.5, 53.5], [2.35, 48.85], [139.7, 35.7], [-46.6, -23.5], [151.2, -33.9], [28, -26.2], [37.6, 55.75], [-74, 40.7], [77.2, 28.6]];
const gcps = cities.map((ll, i) => ({ id: String(i), lonlat: ll, pixel: truth(ll) }));
const best = rankProjections(gcps)[0];
console.log('best projection', best.id, best.rmse.toFixed(3));
if (best.id !== 'robinson') throw new Error('projection detection failed');
const model = fitModel({ gcps, projection: best.id, params: best.params, transform: 'polynomial' });
const ref = buildReference(loadTopo('medium'));
const t0 = Date.now();
const layers = buildPixelLayers(ref, model, W, H, { provinces: false });
console.log('layers built in', Date.now() - t0, 'ms;', layers.countries.length, 'countries,', layers.places.length, 'places');
fs.mkdirSync('test/out', { recursive: true });
for (const id of ['clean-explainer', 'vintage-atlas', 'neon', 'minimal']) {
  const svg = buildSvg(layers, loadStyle(id), { highlight: ['CAN'], fade: ['RUS'] });
  fs.writeFileSync(`test/out/${id}.svg`, svg);
  console.log(id, (svg.length / 1024).toFixed(0), 'KB');
}
// Regional map: Canada at high detail with provinces, Lambert conic.
const conic = (await import('d3-geo')).geoConicConformal().parallels([49, 77]).rotate([96, 0]).center([0, 62]).scale(1400).translate([1280, 720]);
const caPts = [[-123.1, 49.3], [-113.5, 53.5], [-79.4, 43.7], [-63.6, 44.6], [-135.05, 60.7], [-68.5, 63.75], [-97.1, 49.9], [-52.7, 47.6]];
const caGcps = caPts.map((ll, i) => ({ id: String(i), lonlat: ll, pixel: conic(ll) }));
const ranked = rankProjections(caGcps);
console.log('canada ranking', ranked.slice(0, 3).map((r) => `${r.id} ${r.rmse.toFixed(2)}`).join(', '));
const caModel = fitModel({ gcps: caGcps, projection: ranked[0].id, params: ranked[0].params, transform: 'polynomial' });
const hi = buildReference(loadTopo('high'));
const caLayers = buildPixelLayers(hi, caModel, 2560, 1440, { provinces: true, placeRank: 2 });
fs.writeFileSync('test/out/canada.svg', buildSvg(caLayers, loadStyle('clean-explainer'), { highlight: ['CAN'] }));
console.log('canada provinces', caLayers.provinces.length);
