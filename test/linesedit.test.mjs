// Hand tidying of scan lines: the eraser cuts a line in two, tapping finds
// the nearest line, and path data round-trips.
import assert from 'node:assert/strict';
import { parsePath, toPathData, eraseCircle, nearestLine, lineLength } from '../src/core/linesedit.js';

const lines = parsePath('M0,0L100,0M0,50L40,50L40,90');
assert.equal(lines.length, 2);
assert.equal(toPathData(lines), 'M0,0L100,0M0,50L40,50L40,90');

// Rubbing out the middle of the first line leaves two pieces, 45 px each.
const cut = eraseCircle(lines, [50, 0], 5);
assert.equal(cut.length, 3);
assert.deepEqual(cut.slice(0, 2).map((l) => Math.round(lineLength(l))), [45, 45]);
// Erasing nowhere near a line changes nothing.
assert.equal(eraseCircle(lines, [80, 80], 5), lines);
// Erasing a whole short piece removes it.
assert.equal(eraseCircle(parsePath('M10,10L12,10'), [11, 10], 4).length, 0);
// The corner of the second line: the eraser cuts both legs.
const corner = eraseCircle(lines, [40, 50], 6);
assert.deepEqual(corner.slice(1).map((l) => Math.round(lineLength(l))), [34, 34]);

assert.deepEqual(nearestLine([lines], [38, 70], 5), { layer: 0, index: 1 });
assert.equal(nearestLine([lines], [70, 70], 5), null);
console.log('lines tidy: erase and tap ok');
