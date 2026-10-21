// Node helpers so a Claude session can run the same pipeline as the browser app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadTopo(detail = 'medium') {
  return JSON.parse(fs.readFileSync(path.join(root, 'public/data', `ne-${detail}.topojson`), 'utf8'));
}

export function loadStyle(id) {
  return JSON.parse(fs.readFileSync(path.join(root, 'src/styles', `${id}.json`), 'utf8'));
}
