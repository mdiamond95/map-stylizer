// The street matcher on a synthetic scan: a street drawn as two thin lines is
// kept, a street over blank paper and one over a block of text are dropped.
import assert from 'node:assert/strict';
import { makeInkImage, matchLines, matchSettings } from '../src/core/match.js';

const W = 600, H = 400;
const rgba = new Uint8ClampedArray(W * H * 4).fill(228);
const ink = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) { const i = (y * W + x) * 4; rgba[i] = 70; rgba[i + 1] = 80; rgba[i + 2] = 120; } };
// A drawn street along y = 100, edges 6 px either side.
for (let x = 20; x < 580; x++) { ink(x, 94); ink(x, 106); }
// A block of "text": short random strokes.
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 900; k++) {
  const x = 40 + Math.floor(rnd() * 520), y = 300 + Math.floor(rnd() * 60);
  for (let j = 0; j < 3; j++) rnd() < 0.5 ? ink(x + j, y) : ink(x, y + j);
}
const img = makeInkImage(rgba, W, H);
const st = matchSettings(0.5, 10);
const len = (r) => Math.round(r.keptLength / r.totalLength * 100);

const drawn = matchLines([[[30, 103], [570, 99]]], img, 1, st);
const blank = matchLines([[[30, 200], [570, 210]]], img, 1, st);
const text = matchLines([[[50, 330], [550, 330]]], img, 1, st);
console.log('kept: drawn', len(drawn) + '%', 'blank', len(blank) + '%', 'text', len(text) + '%');
assert.ok(len(drawn) > 90, 'drawn street kept');
assert.ok(len(blank) < 10, 'street on blank paper dropped');
assert.ok(len(text) < 40, 'street through text mostly dropped');
