// Lines from a synthetic scan: a dark street grid and a red grid line are
// traced as strokes in two colour layers, and scattered lettering is dropped.
import assert from 'node:assert/strict';
import { extractLinework } from '../src/core/linework.js';

const W = 800, H = 600;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 232; rgba[i + 1] = 226; rgba[i + 2] = 212; rgba[i + 3] = 255; }
const dot = (x, y, c) => { const i = (y * W + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; };
const ink = [60, 62, 110], red = [200, 70, 80];
// Street grid, lines 2 px wide.
for (let k = 100; k <= 700; k += 100) for (let t = 50; t < 550; t++) for (let d = 0; d < 2; d++) { dot(k + d, t, ink); if (k < 600) dot(t + 150, k + d - 50 + 0, ink); }
// A red grid line across the top.
for (let x = 20; x < 780; x++) dot(x, 20, red), dot(x, 21, red);
// Lettering: small marks well away from the lines.
for (let n = 0; n < 40; n++) { const x = 115 + (n % 8) * 80, y = 570 + (n % 3) * 8; for (let j = 0; j < 6; j++) dot(x + j, y, ink), dot(x, y - j, ink); }

const { layers } = extractLinework(rgba, W, H);
const summary = layers.map((l) => `${l.name} ${Math.round(l.length)} px`);
console.log('linework:', summary.join(', '));
const dark = layers.find((l) => !/Red/.test(l.name)), redLayer = layers.find((l) => /Red/.test(l.name));
assert.ok(dark && redLayer, 'two colour layers');
// 7 vertical lines of 500 px and 5 horizontal of 500 px.
assert.ok(dark.length > 5000 && dark.length < 6600, `street lines traced (${Math.round(dark.length)} px)`);
assert.ok(redLayer.length > 650 && redLayer.length < 800, `red line traced (${Math.round(redLayer.length)} px)`);
const below = (dark.d.match(/[\d.]+,[\d.]+/g) || []).filter((p) => +p.split(',')[1] > 560).length;
assert.equal(below, 0, 'lettering dropped');

// A drawn block with square corners keeps them: the traced outline has a
// vertex within 2 px of each corner, not a cut-off diagonal.
{
  const W2 = 300, H2 = 240;
  const img = new Uint8ClampedArray(W2 * H2 * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 232; img[i + 1] = 226; img[i + 2] = 212; img[i + 3] = 255; }
  const put = (x, y) => { const i = (y * W2 + x) * 4; img[i] = 60; img[i + 1] = 62; img[i + 2] = 110; };
  for (let x = 50; x <= 250; x++) for (let d = -1; d <= 1; d++) { put(x, 50 + d); put(x, 190 + d); }
  for (let y = 50; y <= 190; y++) for (let d = -1; d <= 1; d++) { put(50 + d, y); put(250 + d, y); }
  const pts = (extractLinework(img, W2, H2).layers[0].d.match(/[\d.]+,[\d.]+/g) || []).map((p) => p.split(',').map(Number));
  for (const [cx, cy] of [[50, 50], [250, 50], [250, 190], [50, 190]]) {
    const near = Math.min(...pts.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    assert.ok(near < 2, `corner ${cx},${cy} kept square (nearest vertex ${near.toFixed(1)} px)`);
  }
  console.log('square corners kept');
}
