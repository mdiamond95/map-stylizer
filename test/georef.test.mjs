// Projection detection and fit accuracy on a synthetic Robinson world map.
import assert from 'node:assert/strict';
import { geoRobinson } from 'd3-geo-projection';
import { fitModel, rankProjections } from '../src/core/georef.js';

const truth = geoRobinson().scale(310).translate([960, 500]);
const pts = [[-113.5, 53.5], [2.35, 48.85], [139.7, 35.7], [-46.6, -23.5], [151.2, -33.9], [28, -26.2], [37.6, 55.75], [-74, 40.7], [77.2, 28.6]];
// Up to ±1 px of hand-placement wobble.
const gcps = pts.map((ll, i) => { const p = truth(ll); return { id: String(i), lonlat: ll, pixel: [p[0] + Math.sin(i * 7) , p[1] + Math.cos(i * 3)] }; });

const ranking = rankProjections(gcps);
assert.equal(ranking[0].id, 'robinson');
console.log('ranking:', ranking.slice(0, 3).map((r) => `${r.id} ${r.rmse.toFixed(2)} px`).join(', '));

for (const t of ['helmert', 'polynomial', 'projective', 'polynomial2', 'thinPlateSpline']) {
  const m = fitModel({ gcps, projection: 'robinson', params: ranking[0].params, transform: t });
  const toronto = m.pixelToLonlat(truth([-79.4, 43.7]));
  const off = Math.hypot(toronto[0] + 79.4, toronto[1] - 43.7);
  assert.ok(off < 0.5, `${t} placed Toronto ${off.toFixed(2)}° off`);
  console.log(`${t}: rmse ${m.rmse.toFixed(2)} px, Toronto within ${off.toFixed(2)}°`);
}
