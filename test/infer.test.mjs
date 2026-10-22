// Filling in missing lines: a loose end is only carried on where ink runs
// under the guess (lettering over a line), never across bare paper (a street
// crossing), and corners and open block sides get closed.
import assert from 'node:assert/strict';
import { inferLines } from '../src/core/infer.js';

const W = 600, H = 420;
const ink = new Uint8Array(W * H), skip = new Uint8Array(W * H);
const draw = (pts) => {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], m = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    for (let s = 0; s <= m; s++) ink[Math.round(ay + ((by - ay) * s) / m) * W + Math.round(ax + ((bx - ax) * s) / m)] = 1;
  }
};
const lines = [
  // A line broken where lettering sits on it, and one broken by a street.
  [[50, 100], [200, 100]], [[232, 100], [400, 100]],
  [[50, 200], [200, 200]], [[240, 200], [400, 200]],
  // A corner left open.
  [[420, 180], [488, 180]], [[500, 50], [500, 168]],
  // A block with its top side hidden.
  [[100, 300], [100, 380], [160, 380], [160, 300]]
];
lines.forEach(draw);
// Lettering in the first gap: blobs of ink along the line.
for (let x = 200; x <= 232; x++) if (x % 7 < 5) for (let y = 95; y <= 104; y++) ink[y * W + x] = 1;
draw([[488, 180], [500, 180], [500, 168]]);
draw([[100, 300], [160, 300]]);

const { lines: guesses } = inferLines(lines.map((l) => l.slice()), ink, skip, W, H, 1);
const covers = (x, y) => guesses.some((g) => g.some((p, i) => i && segDist([x, y], g[i - 1], p) < 2.5));
assert.ok(covers(216, 100), 'gap under lettering bridged');
assert.ok(!covers(220, 200), 'street crossing left open');
assert.ok(covers(500, 180) && covers(494, 180) && covers(500, 174), 'corner closed');
assert.ok(covers(130, 300), 'open block side closed');
assert.equal(guesses.length, 3, `three guesses (${guesses.length})`);
console.log('infer: lettering gap bridged, street left open, corner and block side closed');

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
