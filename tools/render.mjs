#!/usr/bin/env node
// Renders a saved Map Stylizer project to a layered SVG without a browser,
// so a Claude session can run the same pipeline as the iPad app.
//
//   node tools/render.mjs project.mapstyle.json [--style vintage-atlas] [--height 2160] [--out map.svg]
import fs from 'node:fs';
import { fitModel } from '../src/core/georef.js';
import { buildReference } from '../src/core/reference.js';
import { buildPixelLayers } from '../src/core/render.js';
import { buildSvg } from '../src/core/svg.js';
import { loadTopo, loadStyle } from './lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
if (!file) { console.error('Usage: node tools/render.mjs project.mapstyle.json [--style id] [--height 1440] [--out file.svg]'); process.exit(1); }

const project = JSON.parse(fs.readFileSync(file, 'utf8'));
const { width, height } = project.image;
const model = fitModel({ gcps: project.gcps, ...project.georef });
if (!model) { console.error('Not enough control points to georeference this project.'); process.exit(1); }
console.error(`Fit: ${project.georef.projection} / ${project.georef.transform}, error ${model.rmse.toFixed(2)} px`);

const ref = buildReference(loadTopo(project.detail || 'medium'));
const layers = buildPixelLayers(ref, model, width, height, { ...project.options, provinces: true });
const style = loadStyle(flag('style', project.style || 'clean-explainer'));

let frame = { x: 0, y: 0, w: width, h: height };
if (project.frame?.preset === '16:9') {
  let w = width, h = width * 9 / 16;
  if (h > height) { h = height; w = height * 16 / 9; }
  w /= project.frame.zoom || 1; h /= project.frame.zoom || 1;
  frame = { x: (width - w) * (project.frame.cx ?? 0.5), y: (height - h) * (project.frame.cy ?? 0.5), w, h };
}
const outHeight = +flag('height', project.exportHeight || 1440);
const svg = buildSvg(layers, style, {
  frame, outHeight, outWidth: Math.round(frame.w / frame.h * outHeight),
  show: { ...project.show, labels: project.show?.countryLabels !== false || project.show?.placeLabels !== false },
  highlight: project.highlight, fade: project.fade, names: project.names, labelHide: project.labelHide, traced: project.traced
});
const out = flag('out', file.replace(/(\.mapstyle)?\.json$/, `-${style.id}.svg`));
fs.writeFileSync(out, svg);
console.error(`Wrote ${out}`);
