// The pull on two made-up test sheets of known content (testsheet.js), one
// blue at the Halifax scan's size and one black at 1.6 times it: each kind of
// line has to come out where it belongs, and the pull has to size itself by
// the line weight it measures. tools/testsheets.mjs runs all six.
import assert from 'node:assert/strict';
import { makeTestSheet } from '../src/core/testsheet.js';
import { scoreSheet } from '../src/core/scorecard.js';
import { extractCombined } from '../src/core/combined.js';
import { SHEETS } from '../tools/sheetlist.mjs';

const FLOORS = {
  A: { block: 0.85, narrow: 0.68, dashed: 0.68, rail: 0.93, shore: 0.93, grid: 0.95 },
  D: { block: 0.93, narrow: 0.95, dashed: 0.58, rail: 0.93, shore: 0.95 }
};
for (const [name, floor] of Object.entries(FLOORS)) {
  const sheet = makeTestSheet(SHEETS[name]);
  const t = Date.now();
  const { layers, yard } = extractCombined(sheet.rgba, sheet.w, sheet.h);
  const score = scoreSheet(layers, sheet.truth, sheet.yard);
  console.log(`sheet ${name} (${Date.now() - t} ms): line weight ${yard.lineWeight} (drawn ${sheet.yard.lineWeight}),`, JSON.stringify(score.found), `stray ${score.extra}, in empty box ${score.inEmpty}`);
  assert.ok(Math.abs(yard.lineWeight / sheet.yard.lineWeight - 1) < 0.25, `sheet ${name}: line weight measured ${yard.lineWeight}, drawn ${sheet.yard.lineWeight}`);
  for (const [kind, min] of Object.entries(floor)) assert.ok(score.found[kind] >= min, `sheet ${name}: ${kind} found ${score.found[kind]}, want ${min}`);
  assert.ok(score.extra <= 0.05, `sheet ${name}: stray lines ${score.extra}`);
  assert.ok(score.inEmpty <= 50, `sheet ${name}: ${score.inEmpty} px of lines in the title box`);
}
console.log('test sheets: blocks, narrow blocks, dashes, railways, shore and grid found; line weight measured');
