// Pulls the drawn lines straight off a scanned map as clean centre-line
// strokes: ink is separated from the paper, lettering and specks are dropped
// by size, what is left is thinned to one-pixel lines and traced into paths,
// grouped by ink colour so each colour can be styled on its own.
import { makeInkImage } from './match.js';

// outScale: multiplies the output coordinates, for a scan analysed at reduced size.
export const LINEWORK_DEFAULTS = { contrast: 0.18, minSize: 0.012, colours: 4, simplify: 0.8, outScale: 1 };

// rgba: image pixels; returns { layers: [{ name, colour, d, count, length }], width, height }.
export function extractLinework(rgba, width, height, options = {}, onProgress) {
  const o = { ...LINEWORK_DEFAULTS, ...options };
  const ink = makeInkImage(rgba, width, height);
  const n = width * height;
  onProgress?.('Finding ink');
  const mask = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const paper = paperAt(ink, x, y);
      // Colour lines (a red grid, a blue route) can be lighter than black ink
      // yet clearly not paper, so strong colour also counts.
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (ink.gray[i] < paper * (1 - o.contrast) || (chroma > 70 && ink.gray[i] < paper * 0.92)) mask[i] = 1;
    }
  }
  onProgress?.('Removing lettering');
  dropSmallPieces(mask, width, height, Math.max(8, o.minSize * Math.max(width, height)));
  onProgress?.('Thinning lines');
  thin(mask, width, height);
  onProgress?.('Tracing lines');
  const unit = Math.max(width, height);
  const lines = prune(traceSkeleton(mask, width, height), unit * 0.005, unit * 0.012)
    .map((l) => simplify(l, o.simplify).map((p) => [p[0] * o.outScale, p[1] * o.outScale]));
  onProgress?.('Sorting by colour');
  return { layers: groupByColour(lines, rgba, width, o.colours, o.outScale) };
}

function paperAt(img, x, y) {
  const bx = Math.min(img.bw - 1, Math.floor(x / img.block)), by = Math.min(img.bh - 1, Math.floor(y / img.block));
  return img.paper[by * img.bw + bx];
}

// Connected pieces of ink smaller than `size` across are lettering, numbers,
// stipple and specks; the street network is one big connected piece.
function dropSmallPieces(mask, w, h, size) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    let top = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, count = 0;
    stack[top++] = start; label[start] = next;
    const members = [];
    while (top) {
      const i = stack[--top];
      members.push(i);
      count++;
      const x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) { label[j] = next; stack[top++] = j; }
        }
      }
    }
    // Solid blobs (filled symbols, dense shading) are not lines either.
    const span = Math.max(x1 - x0, y1 - y0) + 1;
    const solid = count > 0.5 * (x1 - x0 + 1) * (y1 - y0 + 1) && Math.min(x1 - x0, y1 - y0) > 6;
    if (span < size || solid) for (const i of members) mask[i] = 0;
    next++;
  }
}

// Zhang-Suen thinning: peels ink from both sides until every line is one
// pixel wide, keeping its connections.
function thin(mask, w, h) {
  let candidates = [];
  for (let i = 0; i < mask.length; i++) {
    const x = i % w, y = (i - x) / w;
    if (mask[i] && x > 0 && y > 0 && x < w - 1 && y < h - 1) candidates.push(i);
    else if (mask[i]) mask[i] = 0;
  }
  let changed = true;
  const remove = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      remove.length = 0;
      for (const i of candidates) {
        if (!mask[i]) continue;
        const p2 = mask[i - w], p3 = mask[i - w + 1], p4 = mask[i + 1], p5 = mask[i + w + 1];
        const p6 = mask[i + w], p7 = mask[i + w - 1], p8 = mask[i - 1], p9 = mask[i - w - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
        if (a !== 1) continue;
        if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
        remove.push(i);
      }
      for (const i of remove) mask[i] = 0;
      if (remove.length) changed = true;
    }
    candidates = candidates.filter((i) => mask[i]);
  }
}

const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const NB4FIRST = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

// Walks the one-pixel lines into polylines, breaking them at ends and
// junctions so each stretch between crossings is one path. Branches are
// counted by on/off changes around a pixel, so the staircase corners of a
// diagonal line don't read as junctions.
function traceSkeleton(mask, w, h) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  const branches = (i) => {
    const x = i % w, y = (i - x) / w;
    let a = 0;
    for (let k = 0; k < 8; k++) {
      const [dx, dy] = NB[k], [ex, ey] = NB[(k + 1) % 8];
      if (!at(x + dx, y + dy) && at(x + ex, y + ey)) a++;
    }
    return a;
  };
  const isNode = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (mask[i] && branches(i) !== 2) isNode[i] = 1;
  const visited = new Uint8Array(mask.length);
  const neighbours = (i) => {
    const x = i % w, y = (i - x) / w, out = [];
    for (const [dx, dy] of NB4FIRST) if (at(x + dx, y + dy)) out.push((y + dy) * w + x + dx);
    return out;
  };
  const lines = [];
  const walk = (start, first) => {
    const line = [start, first];
    if (isNode[first]) return line;
    visited[first] = 1;
    let prev = start, cur = first;
    for (;;) {
      const nb = neighbours(cur).filter((j) => j !== prev && j !== start);
      const node = nb.find((j) => isNode[j]);
      if (node != null && line.length > 2) { line.push(node); break; }
      const next = nb.find((j) => !visited[j] && !isNode[j]);
      if (next == null) { if (nb.includes(line[0]) || neighbours(cur).includes(start)) line.push(start); break; }
      visited[next] = 1;
      line.push(next);
      prev = cur; cur = next;
    }
    return line;
  };
  const done = new Set();
  for (let i = 0; i < mask.length; i++) {
    if (!isNode[i]) continue;
    for (const j of neighbours(i)) {
      if (isNode[j]) { const key = Math.min(i, j) * 1e8 + Math.max(i, j); if (done.has(key)) continue; done.add(key); lines.push([i, j]); continue; }
      if (!visited[j]) lines.push(walk(i, j));
    }
  }
  // Whatever is left is closed loops (a building outline, a roundabout).
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i] || isNode[i]) continue;
    visited[i] = 1;
    const nb = neighbours(i).filter((j) => !visited[j]);
    if (nb.length) lines.push(walk(i, nb[0]));
  }
  return lines.map((l) => l.map((i) => [i % w, Math.floor(i / w)]));
}

// Lettering that touches a line survives the size filter as a tangle of
// short spurs and tiny loops hanging off it. Trimming short dead ends a few
// times over, and dropping small closed loops, clears most of it.
function prune(lines, spur, loop) {
  const key = (p) => p[1] * 1e6 + p[0];
  let alive = lines.map((l) => ({ l, len: lineLength(l), a: key(l[0]), b: key(l[l.length - 1]) }))
    .filter((s) => s.len >= 2 && !(s.a === s.b && s.len < loop));
  for (let round = 0; round < 3; round++) {
    const ends = new Map();
    for (const s of alive) { ends.set(s.a, (ends.get(s.a) || 0) + 1); ends.set(s.b, (ends.get(s.b) || 0) + 1); }
    const before = alive.length;
    alive = alive.filter((s) => !(s.len < spur && s.a !== s.b && (ends.get(s.a) === 1 || ends.get(s.b) === 1)));
    if (alive.length === before) break;
  }
  return alive.map((s) => s.l);
}

// Douglas-Peucker, then a light smoothing pass so pixel steps don't show.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, dist = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > dist) { dist = d; worst = i; }
    }
    if (dist > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.map((p, i) => (i === 0 || i === out.length - 1 ? p : [(out[i - 1][0] + 2 * p[0] + out[i + 1][0]) / 4, (out[i - 1][1] + 2 * p[1] + out[i + 1][1]) / 4]));
}

// Each line takes the average colour of the ink under it; lines are then
// grouped into a few ink colours with k-means, merging colours that are close.
function groupByColour(lines, rgba, w, k, outScale) {
  const rgb = lines.map((l) => {
    let r = 0, g = 0, b = 0;
    for (const [x, y] of l) { const i = (Math.round(y / outScale) * w + Math.round(x / outScale)) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
    return [r / l.length, g / l.length, b / l.length];
  });
  // Hue matters more than darkness: one ink drawn heavier or lighter is
  // still one ink.
  const colours = rgb.map(([r, g, b]) => [r - g, (r + g) / 2 - b, (r + g + b) / 3 * 0.35]);
  const weights = lines.map(lineLength);
  let centres = [];
  // Spread the starting colours: darkest, then each next one farthest away.
  const order = colours.map((c, i) => i).sort((a, b) => sum(colours[a]) - sum(colours[b]));
  if (order.length) centres.push(colours[order[0]].slice());
  while (centres.length < k && centres.length < colours.length) {
    let best = -1, bestD = -1;
    for (let i = 0; i < colours.length; i++) {
      const d = Math.min(...centres.map((c) => dist2(c, colours[i]))) * weights[i];
      if (d > bestD) { bestD = d; best = i; }
    }
    centres.push(colours[best].slice());
  }
  let assign = new Int32Array(colours.length);
  for (let iter = 0; iter < 12; iter++) {
    assign = assign.map((_, i) => nearest(centres, colours[i]));
    centres = centres.map((c, ci) => {
      let tw = 0; const m = [0, 0, 0];
      for (let i = 0; i < colours.length; i++) if (assign[i] === ci) { tw += weights[i]; for (let j = 0; j < 3; j++) m[j] += colours[i][j] * weights[i]; }
      return tw ? m.map((v) => v / tw) : c;
    });
  }
  // Merge colours closer than a just-visible difference.
  const groups = centres.map((c, i) => ({ colour: c, members: [i] }));
  for (let a = 0; a < groups.length; a++) {
    for (let b = groups.length - 1; b > a; b--) {
      if (dist2(groups[a].colour, groups[b].colour) < 36 * 36) { groups[a].members.push(...groups[b].members); groups.splice(b, 1); }
    }
  }
  const layers = groups.map((g) => {
    const members = new Set(g.members);
    const own = lines.filter((_, i) => members.has(assign[i]));
    const length = own.reduce((s, l) => s + lineLength(l), 0);
    const mean = [0, 0, 0];
    let tw = 0;
    lines.forEach((l, i) => { if (members.has(assign[i])) { tw += weights[i]; for (let j = 0; j < 3; j++) mean[j] += rgb[i][j] * weights[i]; } });
    const c = mean.map((v) => v / (tw || 1));
    const hex = '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    return { name: `${colourName(c)} lines`, colour: hex, count: own.length, length, d: toPath(own) };
  }).filter((l) => l.count).sort((a, b) => b.length - a.length);
  const seen = new Map();
  for (const l of layers) { const n = seen.get(l.name) || 0; seen.set(l.name, n + 1); if (n) l.name = `${l.name} ${n + 1}`; }
  return layers;
}

function colourName([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max - min < 30) return l < 90 ? 'Black' : l < 170 ? 'Grey' : 'Light grey';
  let hue = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  const name = hue < 20 || hue >= 330 ? 'Red' : hue < 45 ? 'Orange' : hue < 70 ? 'Yellow' : hue < 160 ? 'Green' : hue < 200 ? 'Teal' : hue < 260 ? 'Blue' : 'Purple';
  return (l < 110 ? 'Dark ' + name.toLowerCase() : name).replace(/^./, (c) => c.toUpperCase());
}

function toPath(lines) {
  return lines.map((l) => 'M' + l.map((p) => `${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`).join('L')).join('');
}
function lineLength(l) { let s = 0; for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]); return s; }
function sum(c) { return c[0] + c[1] + c[2]; }
function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function nearest(cs, c) { let best = 0, bd = Infinity; cs.forEach((q, i) => { const d = dist2(q, c); if (d < bd) { bd = d; best = i; } }); return best; }
