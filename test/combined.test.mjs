// The combined method on a synthetic city map: outlined blocks with street
// names printed in the streets (touching the block edges), a red grid line,
// and a coloured harbour. The block edges come out whole and square, the
// lettering doesn't, the shore comes from the water colour, and the red grid
// stays its own layer.
import assert from 'node:assert/strict';
import { extractCombined } from '../src/core/combined.js';

const W = 1200, H = 900;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 232; rgba[i + 1] = 226; rgba[i + 2] = 212; rgba[i + 3] = 255; }
const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; };
const ink = [40, 48, 94], red = [205, 80, 70], water = [170, 200, 192];
// Harbour on the right, with a drawn shoreline.
for (let y = 0; y < H; y++) for (let x = 960; x < W; x++) put(x, y, water);
for (let y = 0; y < H; y++) for (let d = 0; d < 2; d++) put(959 + d, y, ink);
// Blocks: 140 x 90 outlines, 2 px lines, streets 30 px wide.
const blocks = [];
for (let by = 0; by < 6; by++) for (let bx = 0; bx < 6; bx++) {
  const x0 = 60 + bx * 150, y0 = 60 + by * 120;
  if (x0 + 120 > 940) continue;
  blocks.push([x0, y0, x0 + 120, y0 + 90]);
  for (let x = x0; x <= x0 + 120; x++) for (let d = 0; d < 2; d++) { put(x, y0 + d, ink); put(x, y0 + 90 - d, ink); }
  for (let y = y0; y <= y0 + 90; y++) for (let d = 0; d < 2; d++) { put(x0 + d, y, ink); put(x0 + 120 - d, y, ink); }
}
// Street names: letter shapes 11 px tall sitting on the bottom edge of the
// block above, in each horizontal street.
const letters = [];
for (let by = 0; by < 5; by++) for (let bx = 0; bx < 6; bx++) {
  const x0 = 70 + bx * 150, y0 = 60 + by * 120 + 91;
  if (x0 + 100 > 940) continue;
  letters.push([x0, y0 + 3, x0 + 100, y0 + 11]);
  for (let n = 0; n < 9; n++) {
    const lx = x0 + n * 11;
    for (let y = y0; y < y0 + 11; y++) { put(lx, y, ink); put(lx + 7, y, ink); }
    for (let x = lx; x <= lx + 7; x++) { put(x, y0 + 5, ink); if (n % 2) put(x, y0 + 10, ink); }
  }
}
// Two piers sticking out into the harbour with a narrow slip between them.
for (const [y0, y1] of [[300, 312], [320, 332]]) {
  for (let y = y0; y <= y1; y++) for (let x = 960; x <= 1100; x++) put(x, y, y === y0 || y === y1 || x === 1100 ? ink : [232, 226, 212]);
}
// A railway (a heavy band with cross ticks) and a dashed path below the blocks.
for (let x = 60; x < 900; x++) {
  for (let d = -2; d <= 2; d++) put(x, 790 + d, ink);
  if (x % 4 === 0) for (let d = -4; d <= 4; d++) put(x, 790 + d, ink);
}
for (let x = 60; x < 900; x += 12) for (let t = 0; t < 7; t++) put(x + t, 830, ink);
// A red tram route printed right over one block's left edge, from street to
// street, hiding the blue line under it.
const routed = blocks[8];
for (let y = routed[1] - 14; y <= routed[3] + 14; y++) for (let d = -1; d <= 2; d++) put(routed[0] + d, y, red);
// A red grid line across everything.
for (let x = 0; x < 960; x++) for (let d = 0; d < 2; d++) put(x, 500 + d, red);

const t = Date.now();
const { layers } = extractCombined(rgba, W, H);
console.log(`combined (${Date.now() - t} ms):`, layers.map((l) => `${l.name} ${Math.round(l.length)} px${l.show ? '' : ' (hidden)'}`).join(', '));
const byName = (re) => layers.find((l) => re.test(l.name));
const pts = (l) => (l?.d.match(/-?[\d.]+,-?[\d.]+/g) || []).map((p) => p.split(',').map(Number));
const edges = byName(/^Street and block edges$/), filledIn = byName(/^Filled-in lines$/), shore = byName(/^Water edge$/), grid = byName(/^Grid lines$/), routes = byName(/^Tram routes$/);
const rail = byName(/^Railways$/), dashes = byName(/^Dashed lines$/);
assert.ok(edges, 'street and block edges layer');
assert.ok(shore, 'water edge from the harbour colour');
assert.ok(grid && pts(grid).every(([, y]) => Math.abs(y - 500.5) < 3), 'red grid as its own straight layer');
assert.ok(routes && pts(routes).every(([x]) => Math.abs(x - routed[0] - 0.5) < 3) && routes.length > 100, `tram route as one line (${Math.round(routes?.length || 0)} px)`);
assert.equal(byName(/^Unsure lines$/)?.show ?? false, false, 'unsure lines start hidden');

// Every block's four corners are in the edges layer, square; the block
// under the tram route gets its hidden side filled in.
const e = pts(edges).concat(pts(filledIn));
let corners = 0;
for (const [x0, y0, x1, y1] of blocks) for (const [cx, cy] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) if (Math.min(...e.map(([x, y]) => Math.hypot(x - cx, y - cy))) < 4) corners++;
assert.ok(corners >= blocks.length * 4 * 0.9, `block corners kept (${corners} of ${blocks.length * 4})`);
// Total edge length is close to the drawn outlines (lettering would add lots).
const drawn = blocks.length * 2 * (120 + 90);
assert.ok(edges.length > drawn * 0.9 && edges.length < drawn * 1.15, `edge length ${Math.round(edges.length)} vs ${drawn} drawn`);
// No line runs through the lettering, away from the block edge it sits on.
const near = (list, [cx, cy]) => list.some(([x, y]) => Math.hypot(x - cx, y - cy) < 4);
assert.ok(filledIn && near(pts(filledIn), [routed[0], routed[1]]) && near(pts(filledIn), [routed[0], routed[3]]), 'edge under the tram route filled in');
// Filled-in lines are straight runs, never wiggly.
for (const l of (filledIn?.d || '').split('M').filter(Boolean)) assert.ok(l.split('L').length <= 6, `filled-in line has few corners (${l.split('L').length})`);
const inLetters = e.filter(([x, y]) => letters.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1)).length;
assert.equal(inLetters, 0, 'lettering left out');
// The shoreline runs down the harbour edge, and the piers' outlines into the slip.
const s = pts(shore);
const atPiers = ([, y]) => y > 290 && y < 342;
assert.ok(s.length && s.filter((p) => !atPiers(p)).every(([x]) => Math.abs(x - 960) < 6), 'shore follows the water edge');
// (A pier drawn as an outlined patch of paper may come out as a block instead.)
assert.ok(s.concat(e).filter(([x, y]) => x > 1090 && y > 308 && y < 324).length >= 2, 'outline runs into the slip between the piers');
// The harbour is also a solid shape, with the piers left out of it.
const waterArea = layers.find((l) => l.area);
assert.ok(waterArea && waterArea.name === 'Water' && layers.indexOf(waterArea) === 0, 'water area layer, drawn first');
const wa = pts(waterArea);
assert.ok(wa.length && wa.every(([x]) => x > 950), 'water area stays in the harbour');
// The railway is one line down the band, not in the street edges.
const rl = pts(rail);
assert.ok(rail && rl.every(([, y]) => Math.abs(y - 790) < 4) && rail.length > 840 * 0.8, `railway found (${Math.round(rail?.length || 0)} px)`);
assert.ok(!e.some(([x, y]) => x > 100 && x < 860 && Math.abs(y - 790) < 8), 'railway kept out of the street edges');
// The dashes are joined into one dashed line.
assert.ok(dashes && pts(dashes).every(([, y]) => Math.abs(y - 830) < 3) && dashes.length > 840 * 0.8, `dashed line found (${Math.round(dashes?.length || 0)} px)`);
console.log('combined: blocks square, edge under a tram route filled in, lettering out, shore, piers, railway, dashes and grid kept');
