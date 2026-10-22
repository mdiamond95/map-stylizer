// Runs "Pull lines from scan" on the made-up test sheets and prints how
// much of each kind of line it found. Every fix to the pull should hold up
// on all of them, not just on one real map.
//
//   node tools/testsheets.mjs                  all sheets
//   node tools/testsheets.mjs A C              some of them
//   node tools/testsheets.mjs --out dir        also save each sheet (.rgba + .json) and its pull
import fs from 'node:fs';
import { makeTestSheet } from '../src/core/testsheet.js';
import { scoreSheet } from '../src/core/scorecard.js';
import { extractCombined } from '../src/core/combined.js';
import { SHEETS } from './sheetlist.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const outDir = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
const names = args.length ? args : Object.keys(SHEETS);
if (outDir) fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const name of names) {
  const sheet = makeTestSheet(SHEETS[name]);
  const t = Date.now();
  const { layers, yard } = extractCombined(sheet.rgba, sheet.w, sheet.h);
  const secs = (Date.now() - t) / 1000;
  const score = scoreSheet(layers, sheet.truth, sheet.yard);
  rows.push({ name, size: `${sheet.w}x${sheet.h}`, secs, k: Math.round(yard.k * 100) / 100, ...score.found, extra: score.extra, onLettering: score.onLettering, inEmpty: score.inEmpty });
  if (outDir) {
    fs.writeFileSync(`${outDir}/${name}.rgba`, sheet.rgba);
    fs.writeFileSync(`${outDir}/${name}.json`, JSON.stringify({ w: sheet.w, h: sheet.h, truth: sheet.truth, yard: sheet.yard, score, layers: layers.map(({ name, colour, d, show, area }) => ({ name, colour, d, show, area })) }));
  }
  console.error(name, JSON.stringify(rows[rows.length - 1]));
}
console.table(rows);
