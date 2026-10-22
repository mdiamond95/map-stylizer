// Pulls clean lines off a scan by running several methods that make
// different mistakes, then keeping only what they agree on:
//   - ink tracing (the scan-lines pipeline in linework.js), as is
//   - ink tracing again after the lettering inside the streets is painted
//     out, using the map's own streets: the white space between blocks
//   - city blocks, found as enclosed patches of paper and squared up
//   - coloured fills (water), whose edges give the shoreline and the piers
// Every line is cut into short pieces and each kind of method votes on each
// piece. Lettering never gets two kinds of vote, so it drops out.
// Two kinds of line no vote can find get their own finders: railways, drawn
// as heavy hatched bands, and dashed lines, whose dashes are as small as
// letters. Last, gaps the vote left (a line under a street name or a tram
// route, a block missing a side) are filled in where the ink backs it up, as
// a layer of their own to check.
import { makeInkImage } from './match.js';
import { inferLines } from './infer.js';
import { LINEWORK_DEFAULTS, extractLinework, thin, traceSkeleton, prune, simplify, colourName, toPath, lineLength } from './linework.js';

// Sizes below are tuned on a 3,000-pixel-wide city map and scaled from there.
export const COMBINED_DEFAULTS = { ...LINEWORK_DEFAULTS };

// rgba: image pixels; returns { layers: [{ name, colour, d, count, length, show }] }.
export function extractCombined(rgba, w, h, options = {}, onProgress) {
  const o = { ...COMBINED_DEFAULTS, ...options };
  const out = o.outScale;
  const n = w * h;
  const k = Math.max(w, h) / 3000;
  const r = (px) => Math.max(1, Math.round(px * k));

  onProgress?.('Reading colours');
  const inkImg = makeInkImage(rgba, w, h);
  const { L, A, B } = toLab(rgba, n);
  const paperAB = commonColour(A, B, n, (i) => { const x = i % w; return inkImg.gray[i] >= paperAt(inkImg, x, (i - x) / w) * 0.97; });
  const chroma = new Float32Array(n);
  for (let i = 0; i < n; i++) chroma[i] = Math.hypot(A[i] - paperAB[0], B[i] - paperAB[1]);
  // Ink is dark against its local paper. Ink of a second colour (a red grid,
  // red tram routes) is kept out of the block finder, since it runs across
  // or along blocks rather than outlining them; it still gets traced as its
  // own layer.
  const dark = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; dark[i] = inkImg.gray[i] < paperAt(inkImg, x, y) * (1 - o.contrast) ? 1 : 0; }
  const mainAB = commonColour(A, B, n, (i) => dark[i]);
  const ink = new Uint8Array(n), colourInk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const other = chroma[i] > 22 && Math.hypot(A[i] - mainAB[0], B[i] - mainAB[1]) > 25;
    if (other && (dark[i] || L[i] < 75)) colourInk[i] = 1;
    else if (dark[i]) ink[i] = 1;
  }
  // Coloured fills: large areas a different colour from the paper that aren't ink.
  // Only a light opening, so the narrow water between piers stays; grid lines
  // printed over the water and lettering in it are filled back in.
  let fill = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!ink[i] && chroma[i] > 7 && L[i] > 55) fill[i] = 1;
  fill = open(fill, w, h, 1);
  keepFills(fill, A, B, w, h, 0.002 * n, 1500 * k * k);
  // Water beside a bright fold or in a narrow lake tip can read darker than
  // the paper round it and be taken for ink; its colour says it's water.
  growByColour(fill, ink, L, A, B, w, h, 10, r(12));
  const fillNear = dilate(fill, w, h, r(3));
  for (let i = 0; i < n; i++) if (colourInk[i] && fillNear[i]) fill[i] = 1;
  fillHoles(fill, w, h, 1500 * k * k);
  // Ships and longer names drawn on the water are holes that are mostly ink;
  // islands are mostly paper and stay.
  fillHoles(fill, w, h, 0.002 * n, (cnt, inked) => inked > 0.35 * cnt, ink);
  // Lettering printed on the water ("Maynards Lake") is water too, even
  // where it touches the shore: small pieces of ink with water nearly all
  // round them.
  inkOnFill(ink, fill, w, h, 30 * k);
  // Letters joined to the shore line are one big piece of ink, so they are
  // taken in by closing the water over ink narrower than a letter instead.
  const closed = close(fill, w, h, r(5));
  for (let i = 0; i < n; i++) if (closed[i] && ink[i]) fill[i] = 1;
  fill = open(fill, w, h, 1);

  onProgress?.('Finding blocks');
  const inkWide = dilate(ink, w, h, 1);
  const paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = !inkWide[i] && !fill[i] ? 1 : 0;
  const pc = components(paper, w, h, false);
  const depth = chamfer(paper, w, h);
  const maxw = new Float32Array(pc.count + 1);
  for (let i = 0; i < n; i++) { const l = pc.label[i]; if (l && depth[i] > maxw[l]) maxw[l] = depth[i]; }
  const crop = boxesOfPrint(ink, pc, w, h);
  const blocks = new Uint8Array(n), streets = new Uint8Array(n);
  const kind = new Uint8Array(pc.count + 1); // 1 block, 2 street
  for (let l = 1; l <= pc.count; l++) {
    const a = pc.area[l], bw = pc.x1[l] - pc.x0[l] + 1, bh = pc.y1[l] - pc.y0[l] + 1;
    if (a < 40 * k * k) continue;
    // A street is a narrow patch (often cut short by its lettering) or the
    // big connected network; a block is wide enough and fairly compact.
    if (maxw[l] < 6 * k || a > 0.02 * n || a / (bw * bh) < 0.3) kind[l] = 2;
    else if (a >= 150 * k * k) kind[l] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (crop[i]) continue;
    const t = kind[pc.label[i]];
    if (t === 1) blocks[i] = 1; else if (t === 2) streets[i] = 1;
  }
  // Grow each block back over half its outline, and smooth off the bumps.
  let blockMask = open(dilate(blocks, w, h, 1), w, h, r(2));
  const shapes = blockOutlines(blockMask, w, h, 150 * k * k);

  onProgress?.('Finding the streets');
  const blockNear = dilate(blockMask, w, h, 1);
  let space = new Uint8Array(n);
  for (let i = 0; i < n; i++) space[i] = (streets[i] || ink[i]) && !blockNear[i] ? 1 : 0;
  space = close(space, w, h, r(3));
  for (let i = 0; i < n; i++) if (blockNear[i] || fill[i] || crop[i]) space[i] = 0;
  fillHoles(space, w, h, 400 * k * k);
  space = open(space, w, h, 1);
  // Lettering inside a street, away from its edges, is painted out with the
  // paper tone, then the ink is traced again.
  const spaceDepth = chamfer(space, w, h);
  const painted = new Uint8ClampedArray(rgba);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if ((ink[i] || colourInk[i]) && spaceDepth[i] > 2.5 * k + 0.5) { const p = paperAt(inkImg, x, y); painted[i * 4] = painted[i * 4 + 1] = painted[i * 4 + 2] = p; }
  }
  const centres = streetCentres(space, w, h);

  const sub = { ...o, outScale: 1, keepLines: true };
  onProgress?.('Tracing the ink');
  const plain = extractLinework(rgba, w, h, sub);
  onProgress?.('Tracing without street names');
  const masked = extractLinework(painted, w, h, sub);
  const isColour = (l) => meanAlong(l, colourInk, w, h) > 0.5;
  const plainLines = plain.lines.filter((l) => !isColour(l));
  const maskedLines = masked.lines.filter((l) => !isColour(l));
  const fillEdges = edgeLines(fill, crop, w, h);
  const margin = 0.03 * Math.max(w, h);
  const inMargin = ([x, y]) => x < margin || y < margin || x > w - margin || y > h - margin;
  const rails = railLines(ink, fill, crop, w, h, k, inMargin);
  // Grid lines and boxes of print are no place for dashes.
  const colourNear = dilate(colourInk, w, h, r(2));
  const cropNear = dilate(crop, w, h, r(15));
  const dashed = dashedLines(ink, (i) => colourNear[i] || cropNear[i], w, h, k, inMargin);

  onProgress?.('Comparing methods');
  // Printed lines are a few pixels wide whatever the image size.
  const R = Math.max(3, r(3));
  const support = {
    plain: dilate(rasterise(plainLines, w, h), w, h, R),
    masked: dilate(rasterise(maskedLines, w, h), w, h, R),
    shape: dilate(rasterise(shapes, w, h), w, h, R),
    colour: dilate(rasterise(fillEdges, w, h), w, h, R)
  };
  const inkNear = dilate(ink, w, h, R);
  // Lines along a railway are the edges of its band; the railway layer has it.
  const railBand = dilate(rasterise(rails, w, h), w, h, R + r(3));
  const piece = 8 * k, longRun = 60 * k;
  const accepted = new Uint8Array(n);
  const kept = { edges: [], fill: [] }, unsure = [];
  // Most trustworthy geometry first; later sources only fill in what is left.
  const sources = [['shape', shapes], ['colour', fillEdges], ['masked', maskedLines], ['plain', plainLines]];
  const doubted = new Uint8Array(n);
  for (const [src, lines] of sources) {
    const near = dilate(accepted, w, h, R), nearDoubt = dilate(doubted, w, h, R);
    const add = [];
    for (const line of lines) {
      const total = lineLength(line);
      if (total < 2) continue;
      const pieces = Math.max(1, Math.round(total / piece));
      let runStart = -1, unsureStart = -1;
      const flush = (from, to, list) => { if (from >= 0 && to > from) list.push(subPath(line, from * total / pieces, to * total / pieces)); };
      for (let p = 0; p <= pieces; p++) {
        let keep = false, doubt = false;
        if (p < pieces) {
          const pts = samplePath(line, p * total / pieces, (p + 1) * total / pieces, 2);
          const frac = (m) => pts.reduce((s, [x, y]) => s + m[idx(x, y, w, h)], 0) / pts.length;
          if (frac(crop) > 0.5 || frac(near) >= 0.6 || frac(railBand) >= 0.6) { keep = false; }
          else {
            const vInk = ((frac(support.plain) >= 0.6) + (frac(support.masked) >= 0.6)) / 2;
            const vShape = frac(support.shape) >= 0.6 ? 1 : 0, vColour = frac(support.colour) >= 0.6 ? 1 : 0;
            // Block and shore outlines are drawn along printed ink by
            // construction; check the ink really is there.
            if ((src === 'shape' || src === 'colour') && frac(inkNear) >= 0.6) keep = true;
            else if (vInk + vShape + vColour >= 1.5) keep = true;
            else if (vInk === 1 && total > longRun) keep = true;
            else doubt = vInk > 0 && (src === 'masked' || src === 'plain') && frac(nearDoubt) < 0.6;
          }
        }
        if (keep && runStart < 0) runStart = p;
        if (!keep && runStart >= 0) { flush(runStart, p, add); runStart = -1; }
        if (doubt && unsureStart < 0) unsureStart = p;
        if (!doubt && unsureStart >= 0) { const u = []; flush(unsureStart, p, u); for (const l of u) { unsure.push(l); drawLine(doubted, l, w, h); } unsureStart = -1; }
      }
    }
    for (const l of add) { drawLine(accepted, l, w, h); (src === 'colour' ? kept.fill : kept.edges).push(l); }
  }
  // Long straight lines only one tracer found are real lines far more often
  // than lettering, which is short and twisty, when they join up with lines
  // already kept (hillside hatching doesn't). Twice, so a road can grow out
  // along a chain of them. Not in the margin (the map's frame), round boxes
  // of print or along grid lines.
  let unsureLeft = unsure.filter((l) => {
    const len = lineLength(l);
    const straight = Math.hypot(l[l.length - 1][0] - l[0][0], l[l.length - 1][1] - l[0][1]) / (len || 1);
    return len > 25 * k && straight > 0.85 && l.filter(inMargin).length < l.length / 2 && meanAlong(l, cropNear, w, h) < 0.5 && meanAlong(l, colourNear, w, h) < 0.5;
  });
  const others = unsure.filter((l) => !unsureLeft.includes(l));
  for (let round = 0; round < 2; round++) {
    const joined = dilate(accepted, w, h, r(6));
    const touches = (l) => joined[idx(l[0][0], l[0][1], w, h)] || joined[idx(l[l.length - 1][0], l[l.length - 1][1], w, h)];
    unsureLeft = unsureLeft.filter((l) => { if (!touches(l)) return true; kept.edges.push(l); drawLine(accepted, l, w, h); return false; });
  }
  unsureLeft = unsureLeft.concat(others);
  const gaps = closeGaps(kept.edges, 10 * k);

  onProgress?.('Evening out');
  const even = evenOut([kept.edges.concat(gaps)], spaceDepth, centres, w, h, k);
  unsureLeft = unsureLeft.concat(even.dropped);

  onProgress?.('Filling in missing lines');
  // Not along railways or dashed lines, which have layers of their own.
  const avoid = dilate(rasterise(rails.concat(dashed), w, h), w, h, R + r(3));
  const filled = fillIn({ inkImg, ink, colourInk, fill, crop, blockMask, avoid, edges: even.groups[0], shore: kept.fill, w, h, k });
  unsureLeft = unsureLeft.concat(filled.creases);

  onProgress?.('Sorting layers');
  const scaled = (ls) => ls.filter((l) => l.length > 1).map((l) => l.map(([x, y]) => [x * out, y * out]));
  const layer = (name, colour, lines, show = true) => {
    const ls = scaled(lines);
    return { name, colour, count: ls.length, length: ls.reduce((s, l) => s + lineLength(l), 0), d: toPath(ls), show };
  };
  const main = plain.layers[0];
  const layers = [layer('Street and block edges', main?.colour || '#2b2f3a', filled.edges)];
  // Filled-in lines are guesses, so they get a colour of their own to check
  // them by; recolour the layer to match once happy.
  layers.push(layer('Filled-in lines', '#8a3ffc', filled.inferred));
  if (kept.fill.length) {
    const c = meanColour(rgba, fill, n);
    let fa = 0, fb = 0, m = 0;
    for (let i = 0; i < n; i += 7) if (fill[i]) { fa += A[i]; fb += B[i]; m++; }
    // Greener or bluer than the paper reads as water.
    const water = fa / m < paperAB[0] - 3 || fb / m < paperAB[1] - 6;
    layers.push(layer(water ? 'Water edge' : `${colourName(c)} area edges`, hex(c.map((v) => v * 0.55)), kept.fill));
    // The same areas as solid shapes, to colour in, drawn under the lines.
    const areas = layer(water ? 'Water' : `${colourName(c)} areas`, hex(c), fillRings(fill, w, h, 1500 * k * k));
    if (areas.count) layers.unshift({ ...areas, area: true });
  }
  // Lines in a second ink colour (a red grid, tram routes) pass through as
  // their own layers, one per colour.
  const byColour = new Map();
  for (const l of plain.lines.filter(isColour)) {
    const c = inkColourAlong(l, rgba, colourInk, w, h);
    const name = `${colourName(c).replace(/^Dark (.)/, (_, ch) => ch.toUpperCase())} lines`;
    if (!byColour.has(name)) byColour.set(name, { lines: [], sum: [0, 0, 0], n: 0 });
    const g = byColour.get(name);
    g.lines.push(l); g.sum = g.sum.map((v, i) => v + c[i]); g.n++;
  }
  // Scraps of colour (a symbol, the edge of the water) aren't worth a layer.
  const edgeLength = layers[0].length / out;
  for (const [name, g] of [...byColour].sort((a, b) => b[1].lines.length - a[1].lines.length)) {
    if (g.lines.reduce((t, l) => t + lineLength(l), 0) < edgeLength * 0.02) continue;
    layers.push(layer(name, hex(g.sum.map((v) => v / g.n)), g.lines));
  }
  layers.push(layer('Railways', main?.colour || '#2b2f3a', rails.concat(closeGaps(rails, 30 * k))));
  layers.push(layer('Dashed lines', main?.colour || '#2b2f3a', dashed));
  layers.push(layer('Street centres', '#b07a2a', centres, false));
  layers.push(layer('Unsure lines', '#e07b00', unsureLeft, false));
  return { layers: layers.filter((l) => l.count) };
}

// ---------- colour ----------

const LIN = new Float32Array(256).map((_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
function toLab(rgba, n) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < n; i++) {
    const r = LIN[rgba[i * 4]], g = LIN[rgba[i * 4 + 1]], b = LIN[rgba[i * 4 + 2]];
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[i] = 116 * y - 16; A[i] = 500 * (x - y); B[i] = 200 * (y - z);
  }
  return { L, A, B };
}

// The most common colour (a*, b*) among the pixels picked: the paper's tint
// among the brightest pixels, the main ink's among the dark ones.
function commonColour(A, B, n, pick) {
  const bins = new Uint32Array(128 * 128);
  for (let i = 0; i < n; i += 3) {
    if (!pick(i)) continue;
    const a = Math.round(A[i] / 2 + 64), b = Math.round(B[i] / 2 + 64);
    if (a >= 0 && a < 128 && b >= 0 && b < 128) bins[a * 128 + b]++;
  }
  let best = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[best]) best = i;
  return [(Math.floor(best / 128) - 64) * 2, ((best % 128) - 64) * 2];
}

function paperAt(img, x, y) {
  const bx = Math.min(img.bw - 1, Math.floor(x / img.block)), by = Math.min(img.bh - 1, Math.floor(y / img.block));
  return img.paper[by * img.bw + bx];
}

// Average colour of the coloured-ink pixels a line runs over.
function inkColourAlong(l, rgba, mask, w, h) {
  const s = [0, 0, 0];
  let m = 0;
  for (const [x, y] of samplePath(l, 0, lineLength(l), 2)) { const i = idx(x, y, w, h); if (!mask[i]) continue; s[0] += rgba[i * 4]; s[1] += rgba[i * 4 + 1]; s[2] += rgba[i * 4 + 2]; m++; }
  return s.map((v) => v / (m || 1));
}

function meanColour(rgba, mask, n) {
  const s = [0, 0, 0];
  let m = 0;
  for (let i = 0; i < n; i += 7) if (mask[i]) { s[0] += rgba[i * 4]; s[1] += rgba[i * 4 + 1]; s[2] += rgba[i * 4 + 2]; m++; }
  return s.map((v) => v / (m || 1));
}

function hex(c) { return '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join(''); }

// ---------- masks ----------

function idx(x, y, w, h) { return Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x))); }

// Square dilation by radius r, done as a row pass then a column pass.
export function dilate(mask, w, h, r) { return morph(mask, w, h, r, 1); }
export function erode(mask, w, h, r) { return morph(mask, w, h, r, 0); }
function open(mask, w, h, r) { return dilate(erode(mask, w, h, r), w, h, r); }
function close(mask, w, h, r) { return erode(dilate(mask, w, h, r), w, h, r); }
function morph(mask, w, h, r, grow) {
  const tmp = new Uint8Array(w * h), outm = new Uint8Array(w * h);
  // Count of set pixels in a sliding window: any (grow) or all (shrink).
  // Along each row, then down the columns, keeping a running count per
  // column so the image is read in order.
  for (let y = 0, base = 0; y < h; y++, base += w) {
    let c = 0;
    for (let x = 0; x < Math.min(r, w); x++) c += mask[base + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) c += mask[base + x + r];
      if (x > r) c -= mask[base + x - r - 1];
      tmp[base + x] = grow ? +(c > 0) : +(c === Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
    }
  }
  const cnt = new Int32Array(w);
  for (let y = 0; y < Math.min(r, h); y++) for (let x = 0, i = y * w; x < w; x++, i++) cnt[x] += tmp[i];
  for (let y = 0; y < h; y++) {
    const add = y + r < h ? (y + r) * w : -1, sub = y > r ? (y - r - 1) * w : -1;
    const span = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    if (add >= 0) for (let x = 0; x < w; x++) cnt[x] += tmp[add + x];
    if (sub >= 0) for (let x = 0; x < w; x++) cnt[x] -= tmp[sub + x];
    const row = y * w;
    if (grow) for (let x = 0; x < w; x++) outm[row + x] = +(cnt[x] > 0);
    else for (let x = 0; x < w; x++) outm[row + x] = +(cnt[x] === span);
  }
  return outm;
}

// Approximate distance to the nearest unset pixel (3-4 chamfer), in pixels.
function chamfer(mask, w, h) {
  const d = new Float32Array(w * h);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= BIG ? 1e4 : d[i] / 3;
  return d;
}

// Connected pieces with their area and bounding box.
function components(mask, w, h, diagonal) {
  const label = new Int32Array(w * h), stack = new Int32Array(w * h);
  const area = [0], x0 = [0], y0 = [0], x1 = [0], y1 = [0];
  let count = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    const l = ++count;
    let top = 0, a = 0, ax = w, ay = h, bx = 0, by = 0;
    stack[top++] = s; label[s] = l;
    while (top) {
      const i = stack[--top];
      a++;
      const x = i % w, y = (i - x) / w;
      if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!diagonal && dx && dy)) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (mask[j] && !label[j]) { label[j] = l; stack[top++] = j; }
      }
    }
    area.push(a); x0.push(ax); y0.push(ay); x1.push(bx); y1.push(by);
  }
  return { label, count, area, x0, y0, x1, y1 };
}

// Keeps the big coloured areas, and smaller ones (a lake, a pond) the same
// colour as the big ones.
function keepFills(mask, A, B, w, h, bigArea, minArea) {
  const c = components(mask, w, h, true);
  const sa = new Float64Array(c.count + 1), sb = new Float64Array(c.count + 1);
  for (let i = 0; i < mask.length; i++) { const l = c.label[i]; if (l) { sa[l] += A[i]; sb[l] += B[i]; } }
  let ba = 0, bb = 0, bn = 0;
  for (let l = 1; l <= c.count; l++) if (c.area[l] >= bigArea) { ba += sa[l]; bb += sb[l]; bn += c.area[l]; }
  const keep = new Uint8Array(c.count + 1);
  for (let l = 1; l <= c.count; l++) {
    const a = c.area[l];
    keep[l] = a >= bigArea || (bn && a >= minArea && Math.hypot(sa[l] / a - ba / bn, sb[l] / a - bb / bn) < 5) ? 1 : 0;
  }
  for (let i = 0; i < mask.length; i++) if (mask[i] && !keep[c.label[i]]) mask[i] = 0;
}

// Pixels within `tol` (Lab) of the fill's colour, joined to the fill, are fill
// and not ink.
function growByColour(fill, ink, L, A, B, w, h, tol, gap) {
  const n = w * h;
  let sl = 0, sa = 0, sb = 0, m = 0;
  for (let i = 0; i < n; i++) if (fill[i]) { sl += L[i]; sa += A[i]; sb += B[i]; m++; }
  if (!m) return;
  sl /= m; sa /= m; sb /= m;
  const like = new Uint8Array(n);
  for (let i = 0; i < n; i++) like[i] = fill[i] || Math.hypot(L[i] - sl, A[i] - sa, B[i] - sb) < tol ? 1 : 0;
  const c = components(like, w, h, true);
  // Joined across a fold or a grid line, too.
  const near = dilate(fill, w, h, gap);
  const wet = new Uint8Array(c.count + 1);
  for (let i = 0; i < n; i++) if (near[i]) wet[c.label[i]] = 1;
  for (let i = 0; i < n; i++) if (like[i] && !fill[i] && wet[c.label[i]]) { fill[i] = 1; ink[i] = 0; }
}

// Small pieces of ink (lettering, up to `size` across) that are at least 70%
// surrounded by the fill become part of it.
function inkOnFill(ink, fill, w, h, size) {
  const c = components(ink, w, h, true);
  const wet = new Uint32Array(c.count + 1), dry = new Uint32Array(c.count + 1);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (ink[i]) continue;
    // A paper or water pixel next to a piece of ink counts for that piece.
    for (const j of [i - 1, i + 1, i - w, i + w]) {
      const l = c.label[j];
      if (!l) continue;
      if (fill[i]) wet[l]++; else dry[l]++;
    }
  }
  for (let i = 0; i < ink.length; i++) {
    const l = c.label[i];
    if (!l || c.x1[l] - c.x0[l] > size || c.y1[l] - c.y0[l] > size) continue;
    if (wet[l] >= 0.7 * (wet[l] + dry[l])) fill[i] = 1;
  }
}

// Fill holes in the mask smaller than maxArea (lettering left as holes in a
// street). With a test, only holes it passes, given their area and how many
// of their pixels are set in `ink`.
function fillHoles(mask, w, h, maxArea, test, ink) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const c = components(inv, w, h, false);
  let ok = null;
  if (test) {
    const inked = new Uint32Array(c.count + 1);
    for (let i = 0; i < mask.length; i++) if (ink[i]) inked[c.label[i]]++;
    ok = new Uint8Array(c.count + 1);
    for (let l = 1; l <= c.count; l++) ok[l] = test(c.area[l], inked[l]) ? 1 : 0;
  }
  for (let i = 0; i < mask.length; i++) {
    const l = c.label[i];
    if (!l || c.area[l] >= maxArea || (ok && !ok[l])) continue;
    if (c.x0[l] === 0 || c.y0[l] === 0 || c.x1[l] === w - 1 || c.y1[l] === h - 1) continue;
    mask[i] = 1;
  }
}

// Framed boxes full of small print (a title cartouche, a legend, a street
// index): big, box-shaped patches of paper with lots of small ink pieces in
// them. They are left out of every method.
function boxesOfPrint(ink, pc, w, h) {
  const n = w * h;
  const crop = new Uint8Array(n);
  const ic = components(ink, w, h, true);
  const small = new Uint8Array(ic.count + 1);
  for (let l = 1; l <= ic.count; l++) small[l] = ic.x1[l] - ic.x0[l] < 30 && ic.y1[l] - ic.y0[l] < 30 ? 1 : 0;
  for (let l = 1; l <= pc.count; l++) {
    const bx0 = pc.x0[l], by0 = pc.y0[l], bw = pc.x1[l] - bx0 + 1, bh = pc.y1[l] - by0 + 1;
    if (bw * bh < 0.004 * n || bw * bh > 0.15 * n) continue;
    // Everything the patch encloses, by flooding in from the box's edge.
    const outside = new Uint8Array(bw * bh), stack = [];
    const at = (x, y) => (y + by0) * w + x + bx0;
    for (let x = 0; x < bw; x++) for (const y of [0, bh - 1]) if (pc.label[at(x, y)] !== l) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    for (let y = 0; y < bh; y++) for (const x of [0, bw - 1]) if (pc.label[at(x, y)] !== l && !outside[y * bw + x]) { outside[y * bw + x] = 1; stack.push(y * bw + x); }
    while (stack.length) {
      const i = stack.pop(), x = i % bw, y = (i - x) / bw;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const j = yy * bw + xx;
        if (!outside[j] && pc.label[at(xx, yy)] !== l) { outside[j] = 1; stack.push(j); }
      }
    }
    let inside = 0, print = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!outside[y * bw + x]) { inside++; const i = at(x, y); if (ink[i] && small[ic.label[i]]) print++; }
    if (inside / (bw * bh) < 0.85 || pc.area[l] / inside < 0.6 || print / inside < 0.04) continue;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!outside[y * bw + x]) crop[at(x, y)] = 1;
  }
  return dilate(crop, w, h, 7);
}

// ---------- shapes ----------

// Outline of each block, simplified, then squared up where that keeps the shape.
// With minEdge, only straight-sided outlines: every edge at least that long
// (a bump of lettering on a side is cut off) and still the block's shape, or
// none at all; never a wiggly one.
function blockOutlines(mask, w, h, minArea, minEdge = 0) {
  const c = components(mask, w, h, true);
  const outs = [];
  for (let l = 1; l <= c.count; l++) {
    if (c.area[l] < minArea) continue;
    const ring = traceOutline(c.label, l, w, h, c.y0[l] * w + firstX(c.label, l, w, c.y0[l], c.x0[l], c.x1[l]));
    if (ring.length < 8) continue;
    const coarse = simplify(ring.concat([ring[0]]), 1.5);
    const rough = simplify(ring.concat([ring[0]]), 2.5);
    if (minEdge) {
      const sides = dropShortEdges(simplify(ring.concat([ring[0]]), 3), minEdge);
      const sq = sides && squareUp(sides);
      const best = sq && overlap(sq, coarse) > 0.85 ? sq : sides;
      if (best && overlap(best, coarse) > 0.85 && !hasSpike(best)) outs.push(best);
      continue;
    }
    // Squared only where the block really is square: a rounded end (a
    // running track, a crescent) keeps its curve.
    const sq = squareUp(rough);
    outs.push(sq && overlap(sq, coarse) > 0.9 && farthest(coarse, sq) <= 2.5 ? sq : coarse);
  }
  return outs;
}

// How far the farthest point of one line is from another.
function farthest(from, to) {
  let worst = 0;
  for (const p of from) {
    let best = Infinity;
    for (let i = 1; i < to.length; i++) {
      const a = to[i - 1], b = to[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

// A corner sharper than 30 degrees on a closed outline: a spike, not a block.
function hasSpike(p) {
  const m = p.length - 1;
  for (let i = 0; i < m; i++) {
    const a = p[(i - 1 + m) % m], b = p[i], c = p[(i + 1) % m];
    const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    if (cos > Math.cos(Math.PI / 6)) return true;
  }
  return false;
}

// A closed outline with every edge at least minEdge long: the shortest edge
// goes, its neighbours carried on to meet, until none is too short. Null
// if fewer than three edges are left.
function dropShortEdges(p, minEdge) {
  let pts = p.slice(0, -1);
  const len = (i) => { const a = pts[i], b = pts[(i + 1) % pts.length]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  while (pts.length > 3) {
    let s = 0;
    for (let i = 1; i < pts.length; i++) if (len(i) < len(s)) s = i;
    if (len(s) >= minEdge) break;
    const m = pts.length, a = pts[(s - 1 + m) % m], b = pts[s], c = pts[(s + 1) % m], d = pts[(s + 2) % m];
    // Where the edges before and after meet, if near; else the short edge's middle.
    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    let q = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    if (Math.abs(den) > 1e-6) {
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
      const x = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      if (Math.hypot(x[0] - q[0], x[1] - q[1]) < 2 * minEdge) q = x;
    }
    pts = s === m - 1 ? [q, ...pts.slice(1, s)] : [...pts.slice(0, s), q, ...pts.slice(s + 2)];
  }
  return pts.length >= 3 ? pts.concat([pts[0]]) : null;
}

function firstX(label, l, w, y, x0, x1) { for (let x = x0; x <= x1; x++) if (label[y * w + x] === l) return x; return x0; }

// Moore-neighbour walk round the outside of one labelled piece.
function traceOutline(label, l, w, h, start) {
  const D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === l;
  const sx = start % w, sy = (start - sx) / w;
  const ring = [[sx, sy]];
  let x = sx, y = sy, dir = 7;
  for (let guard = 0; guard < 4 * (w + h) * 8; guard++) {
    let found = false;
    for (let t = 0; t < 8; t++) {
      const d = (dir + 6 + t) % 8;
      const nx = x + D[d][0], ny = y + D[d][1];
      if (inside(nx, ny)) { x = nx; y = ny; dir = d; found = true; break; }
    }
    if (!found || (x === sx && y === sy)) break;
    ring.push([x, y]);
  }
  return ring;
}

// Snap each edge to the block's main direction or its right angle when it's
// within 12 degrees, then rebuild the corners where edges meet.
function squareUp(p) {
  const pts = p.slice(0, -1);
  if (pts.length < 4) return null;
  // Main direction: the longest edges, weighted by length, folded to 90 degrees.
  let sx = 0, sy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const th = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    sx += Math.cos(th) * len; sy += Math.sin(th) * len;
  }
  const base = Math.atan2(sy, sx) / 4;
  const edges = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let th = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const q = base + Math.round((th - base) / (Math.PI / 2)) * (Math.PI / 2);
    let diff = Math.abs(th - q) % (2 * Math.PI); if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (len > 6 && diff < (12 * Math.PI) / 180) th = q;
    edges.push({ m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: [Math.cos(th), Math.sin(th)] });
  }
  const same = (e, f) => Math.abs(e.d[0] * f.d[1] - e.d[1] * f.d[0]) < 1e-3 && Math.abs(e.d[0] * (f.m[1] - e.m[1]) - e.d[1] * (f.m[0] - e.m[0])) < 2;
  const merged = [];
  for (const e of edges) if (!merged.length || !same(merged[merged.length - 1], e)) merged.push(e);
  if (merged.length > 2 && same(merged[0], merged[merged.length - 1])) merged.pop();
  if (merged.length < 3) return null;
  const outPts = [];
  for (let i = 0; i < merged.length; i++) {
    const e = merged[(i + merged.length - 1) % merged.length], f = merged[i];
    const den = e.d[0] * f.d[1] - e.d[1] * f.d[0];
    let q;
    if (Math.abs(den) < 1e-6) q = [(e.m[0] + f.m[0]) / 2, (e.m[1] + f.m[1]) / 2];
    else {
      const t = ((f.m[0] - e.m[0]) * f.d[1] - (f.m[1] - e.m[1]) * f.d[0]) / den;
      q = [e.m[0] + t * e.d[0], e.m[1] + t * e.d[1]];
      if (Math.hypot(q[0] - f.m[0], q[1] - f.m[1]) > 40) q = [(e.m[0] + f.m[0]) / 2, (e.m[1] + f.m[1]) / 2];
    }
    outPts.push(q);
  }
  outPts.push(outPts[0]);
  return outPts;
}

// Area overlap of two closed outlines (intersection over union), by filling both.
function overlap(p, q) {
  const xs = p.concat(q).map((v) => v[0]), ys = p.concat(q).map((v) => v[1]);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  const w = Math.ceil(Math.max(...xs)) - x0 + 2, h = Math.ceil(Math.max(...ys)) - y0 + 2;
  const a = fillPolygon(p, x0, y0, w, h), b = fillPolygon(q, x0, y0, w, h);
  let both = 0, any = 0;
  for (let i = 0; i < a.length; i++) { both += a[i] & b[i]; any += a[i] | b[i]; }
  return any ? both / any : 0;
}

function fillPolygon(pts, x0, y0, w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = y + y0 + 0.5, xs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - x0 - 0.5)); x < Math.min(w, xs[i + 1] - x0 - 0.5); x++) m[y * w + x] = 1;
  }
  return m;
}

// One line down the middle of each street.
function streetCentres(space, w, h) {
  const m = space.slice();
  thin(m, w, h);
  const unit = Math.max(w, h);
  return prune(traceSkeleton(m, w, h), unit * 0.005, unit * 0.012).map((l) => simplify(l, 1.2)).filter((l) => lineLength(l) > unit * 0.004);
}

// The outline of each coloured area, and of each island in it, as closed
// rings; filled even-odd, the islands come out as holes.
function fillRings(fill, w, h, minArea) {
  const rings = [];
  const add = (c, l) => {
    const ring = traceOutline(c.label, l, w, h, c.y0[l] * w + firstX(c.label, l, w, c.y0[l], c.x0[l], c.x1[l]));
    if (ring.length >= 8) rings.push(simplify(ring.concat([ring[0]]), 1.2));
  };
  const wet = components(fill, w, h, true);
  for (let l = 1; l <= wet.count; l++) if (wet.area[l] >= minArea) add(wet, l);
  // Dry patches not touching the edge of the image are surrounded by water.
  const dry = new Uint8Array(w * h);
  for (let i = 0; i < dry.length; i++) dry[i] = fill[i] ? 0 : 1;
  const land = components(dry, w, h, false);
  for (let l = 1; l <= land.count; l++) {
    if (land.area[l] < minArea || !land.x0[l] || !land.y0[l] || land.x1[l] === w - 1 || land.y1[l] === h - 1) continue;
    add(land, l);
  }
  return rings;
}

// The edge of each coloured fill, as lines.
function edgeLines(fill, crop, w, h) {
  const inner = erode(fill, w, h, 1);
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (fill[i] && !inner[i] && !crop[i]) edge[i] = 1; }
  thin(edge, w, h);
  return prune(traceSkeleton(edge, w, h), 4, 12).map((l) => simplify(l, 1.2)).filter((l) => lineLength(l) > 10);
}

// ---------- railways and dashes ----------

// Railways are drawn as heavy bands (a line with cross ticks), several times
// wider than a street line. Keep only the ink that survives shrinking by two
// pixels, trace what's left, and keep the long smooth runs. Shorelines drawn
// heavy are left to the water edge, and frames round boxes of print are skipped.
function railLines(ink, fill, crop, w, h, k, inMargin) {
  const n = w * h, R = Math.max(2, Math.round(2 * k));
  const depth = chamfer(ink, w, h);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = depth[i] >= R ? 0 : 1;
  const back = chamfer(outside, w, h);
  const cropNear = dilate(crop, w, h, Math.round(15 * k)), shore = dilate(fill, w, h, Math.round(4 * k));
  const thick = new Uint8Array(n);
  for (let i = 0; i < n; i++) thick[i] = back[i] <= R + 0.5 && !cropNear[i] ? 1 : 0;
  thin(thick, w, h);
  const out = [];
  for (const l of prune(traceSkeleton(thick, w, h), 10 * k, 30 * k).map((p) => simplify(p, 1.5))) {
    const len = lineLength(l);
    if (len < 60 * k || l.filter(inMargin).length > l.length / 2 || meanAlong(l, shore, w, h) > 0.5) continue;
    let turn = 0;
    for (let i = 2; i < l.length; i++) {
      const a = Math.atan2(l[i - 1][1] - l[i - 2][1], l[i - 1][0] - l[i - 2][0]), b = Math.atan2(l[i][1] - l[i - 1][1], l[i][0] - l[i - 1][0]);
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
      turn += d;
    }
    if (turn / len <= 0.02 / k) out.push(l);
  }
  return out;
}

// Dashed lines (paths, boundaries, planned streets) are rows of short
// straight dashes, each as small as a letter, so every other method throws
// them away. Find the dash-shaped bits of ink and chain the ones that line up
// end to end; four or more in a row make a dashed line.
function dashedLines(ink, skip, w, h, k, inMargin) {
  const n = w * h;
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  const dashes = [];
  for (let s = 0; s < n; s++) {
    if (!ink[s] || seen[s]) continue;
    let top = 0, m = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      m++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (ink[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
      }
    }
    const ext = Math.max(x1 - x0, y1 - y0) + 1;
    if (m < 3 || ext < 3 || ext > 22 * k) continue;
    // Length and width from the spread of the dash's pixels.
    const mx = sx / m, my = sy / m, cxx = sxx / m - mx * mx, cyy = syy / m - my * my, cxy = sxy / m - mx * my;
    const disc = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy * cxy));
    const len = Math.sqrt(12 * ((cxx + cyy) / 2 + disc)), wid = Math.sqrt(12 * Math.max(0, (cxx + cyy) / 2 - disc)) || 1;
    if (len < 2.5 * wid || wid > Math.max(2.5, 3.5 * k) || skip(Math.round(my) * w + Math.round(mx)) || inMargin([mx, my])) continue;
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), d = [Math.cos(th), Math.sin(th)];
    dashes.push({ d, len, ends: [[mx - (d[0] * len) / 2, my - (d[1] * len) / 2], [mx + (d[0] * len) / 2, my + (d[1] * len) / 2]] });
  }
  // Pair up dash ends that face each other across a short gap, closest first.
  const cell = 16 * k, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  dashes.forEach((q, i) => q.ends.forEach((e, s) => { const kk = key(e[0], e[1]); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push([i, s]); }));
  const cos = (a, b) => a[0] * b[0] + a[1] * b[1], c20 = Math.cos(Math.PI / 9), c25 = Math.cos((25 * Math.PI) / 180);
  const pairs = [];
  dashes.forEach((q, i) => q.ends.forEach((e, s) => {
    const outward = s ? q.d : [-q.d[0], -q.d[1]];
    const cx = Math.floor(e[0] / cell), cy = Math.floor(e[1] / cell);
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) for (const [j, t] of grid.get(`${gx},${gy}`) || []) {
      if (j <= i) continue;
      const p = dashes[j], f = p.ends[t];
      const vx = f[0] - e[0], vy = f[1] - e[1], dist = Math.hypot(vx, vy);
      if (dist < 0.5 || dist > Math.max(3, Math.min(14 * k, 1.5 * Math.max(q.len, p.len)))) continue;
      const inward = t ? [-p.d[0], -p.d[1]] : p.d;
      if (Math.abs(cos(q.d, p.d)) < c20 || cos([vx / dist, vy / dist], outward) < c25 || cos(outward, inward) < c20) continue;
      pairs.push({ dist, a: [i, s], b: [j, t] });
    }
  }));
  pairs.sort((p, q) => p.dist - q.dist);
  const link = dashes.map(() => [null, null]);
  for (const { a, b } of pairs) {
    if (link[a[0]][a[1]] || link[b[0]][b[1]]) continue;
    link[a[0]][a[1]] = b; link[b[0]][b[1]] = a;
  }
  // Walk each chain from one end.
  const used = new Uint8Array(dashes.length), out = [];
  for (let i = 0; i < dashes.length; i++) {
    if (used[i]) continue;
    let cur = i, side = 0;
    for (let guard = 0; link[cur][side] && guard < dashes.length; guard++) { const [j, t] = link[cur][side]; if (j === i) break; cur = j; side = 1 - t; }
    const chain = [];
    for (let guard = 0; cur != null && !used[cur] && guard < dashes.length; guard++) {
      used[cur] = 1;
      chain.push(dashes[cur].ends[side], dashes[cur].ends[1 - side]);
      const next = link[cur][1 - side];
      if (!next) break;
      [cur, side] = next;
    }
    if (chain.length >= 8) out.push(chain);
  }
  return out;
}

// ---------- lines ----------

function rasterise(lines, w, h) {
  const m = new Uint8Array(w * h);
  for (const l of lines) drawLine(m, l, w, h);
  return m;
}

function drawLine(m, l, w, h) {
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    for (let s = 0; s <= steps; s++) m[idx(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps, w, h)] = 1;
  }
}

function meanAlong(l, values, w, h) {
  const pts = samplePath(l, 0, lineLength(l), 3);
  return pts.reduce((s, [x, y]) => s + values[idx(x, y, w, h)], 0) / (pts.length || 1);
}

// Points every `step` px along a polyline between two distances along it.
function samplePath(l, from, to, step) {
  const pts = [];
  let acc = 0;
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i];
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = Math.max(from, acc); s <= Math.min(to, acc + len); s += step) { const t = len ? (s - acc) / len : 0; pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]); }
    acc += len;
    if (acc > to) break;
  }
  return pts.length ? pts : [l[0]];
}

// The stretch of a polyline between two distances along it, keeping its corners.
function subPath(l, from, to) {
  const out = [];
  let acc = 0;
  const at = (i, s) => { const [ax, ay] = l[i - 1], [bx, by] = l[i]; const len = Math.hypot(bx - ax, by - ay) || 1; const t = (s - acc) / len; return [ax + (bx - ax) * t, ay + (by - ay) * t]; };
  for (let i = 1; i < l.length; i++) {
    const len = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    if (acc + len >= from && !out.length) out.push(at(i, from));
    if (out.length && acc + len < to) out.push(l[i]);
    if (acc + len >= to) { out.push(at(i, to)); break; }
    acc += len;
  }
  return out;
}

// Join line ends that face each other across a short gap.
function closeGaps(lines, maxGap) {
  const ends = [];
  for (const l of lines) {
    if (l.length < 2 || lineLength(l) < 6) continue;
    for (const [a, b] of [[l[0], l[1]], [l[l.length - 1], l[l.length - 2]]]) {
      const dx = a[0] - b[0], dy = a[1] - b[1], len = Math.hypot(dx, dy);
      if (len > 0) ends.push({ p: a, d: [dx / len, dy / len] });
    }
  }
  // Bucket ends on a grid so each only looks at its neighbours.
  const cell = Math.max(4, maxGap), grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  ends.forEach((e, i) => { const kk = key(e.p[0], e.p[1]); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(i); });
  const used = new Uint8Array(ends.length), joins = [];
  ends.forEach((e, i) => {
    if (used[i]) return;
    let best = -1, bd = maxGap;
    const cx = Math.floor(e.p[0] / cell), cy = Math.floor(e.p[1] / cell);
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) for (const j of grid.get(`${gx},${gy}`) || []) {
      if (j === i || used[j]) continue;
      const f = ends[j], vx = f.p[0] - e.p[0], vy = f.p[1] - e.p[1], dist = Math.hypot(vx, vy);
      if (dist < 0.5 || dist >= bd) continue;
      if ((vx * e.d[0] + vy * e.d[1]) / dist > 0.92 && -(vx * f.d[0] + vy * f.d[1]) / dist > 0.92) { best = j; bd = dist; }
    }
    if (best >= 0) { used[i] = used[best] = 1; joins.push([e.p, ends[best].p]); }
  });
  return joins;
}

function scalePath(d, s) {
  if (s === 1) return d;
  return d.replace(/-?[\d.]+/g, (v) => String(Math.round(+v * s * 10) / 10));
}

// ---------- filling in ----------

// Lines the vote left broken or never found, guessed from the lines round
// them and checked against the ink (loose ends in infer.js, whole blocks in
// moreBlocks). Also takes out paper fold creases, which read as long faint
// straight lines. avoid: where no loose end should be carried on (railways,
// dashed lines). Returns { edges, inferred, creases }.
function fillIn({ inkImg, ink, colourInk, fill, crop, blockMask, avoid, edges, shore, w, h, k }) {
  const n = w * h;
  const strong = strongInk(inkImg, ink, w, h);
  const strongNear = dilate(strong, w, h, 2);
  const kept = [], creases = [];
  for (const l of edges) splitFaint(l, strongNear, 40 * k, w, h, kept, creases);
  const evidence = new Uint8Array(n), skip = new Uint8Array(n);
  // Not in the water, boxes of print, or the margin (the map's frame).
  const water = erode(fill, w, h, 2), margin = Math.round(0.03 * Math.max(w, h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    evidence[i] = strong[i] || colourInk[i] ? 1 : 0;
    skip[i] = water[i] || crop[i] || x < margin || y < margin || x >= w - margin || y >= h - margin ? 1 : 0;
  }
  const skipLines = avoid ? skip.map((v, i) => v || avoid[i]) : skip;
  const loose = inferLines(kept.concat(shore), evidence, skipLines, w, h, k).lines;
  // Blocks keep further from boxes of print, whose frames make good fake blocks.
  const cropNear = dilate(crop, w, h, Math.round(15 * k));
  for (let i = 0; i < n; i++) if (cropNear[i]) skip[i] = 1;
  const blocks = moreBlocks(strong, colourInk, skip, blockMask, kept.concat(shore, loose), w, h, k);
  return { edges: kept, inferred: loose.concat(blocks), creases };
}

// Printed ink is much darker than a crease's shadow or a stain: halfway
// between the paper and the typical ink.
function strongInk(img, ink, w, h) {
  const n = w * h, hist = new Uint32Array(101);
  let m = 0;
  for (let i = 0; i < n; i += 5) if (ink[i]) { const x = i % w; hist[Math.min(100, Math.round((100 * img.gray[i]) / Math.max(1, paperAt(img, x, (i - x) / w))))]++; m++; }
  let med = 0;
  for (let acc = 0; med < 100; med++) { acc += hist[med]; if (acc >= m / 2) break; }
  const cut = Math.min(0.9, Math.max(0.5, (1 + med / 100) / 2));
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (ink[i] && img.gray[i] < paperAt(img, x, y) * cut) out[i] = 1; }
  return out;
}

// Splits off long straight stretches with almost no strong ink under them.
function splitFaint(l, strongNear, minLen, w, h, kept, faint) {
  let run = [l[0]];
  for (let i = 1; i < l.length; i++) {
    const seg = [l[i - 1], l[i]];
    if (lineLength(seg) > minLen && meanAlong(seg, strongNear, w, h) < 0.3) {
      if (run.length > 1) kept.push(run);
      faint.push(seg);
      run = [l[i]];
    } else run.push(l[i]);
  }
  if (run.length > 1) kept.push(run);
}

// Blocks the first pass missed: patches of paper that are fully enclosed
// once coloured ink (a tram route printed over a block's edge) and the lines
// already found count as edges too, with faint creases not counting. Returns
// the new blocks' outlines where no line runs yet.
function moreBlocks(strong, colourInk, skip, blockMask, known, w, h, k) {
  const n = w * h;
  const r = (px) => Math.max(1, Math.round(px * k));
  const knownMask = rasterise(known, w, h);
  let wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) wall[i] = strong[i] || colourInk[i] || knownMask[i] ? 1 : 0;
  wall = dilate(wall, w, h, 1);
  const paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = !wall[i] ? 1 : 0;
  const pc = components(paper, w, h, false);
  const depth = chamfer(paper, w, h);
  const maxw = new Float32Array(pc.count + 1), clear = new Uint8Array(pc.count + 1).fill(1), had = new Uint32Array(pc.count + 1);
  for (let i = 0; i < n; i++) { const l = pc.label[i]; if (!l) continue; if (depth[i] > maxw[l]) maxw[l] = depth[i]; if (blockMask[i]) had[l]++; if (skip[i]) clear[l] = 0; }
  // Block-sized, wide enough not to be a street, compact, clear of water,
  // print and the margin, and not one the first pass already has.
  const keep = new Uint8Array(pc.count + 1);
  let any = 0;
  for (let l = 1; l <= pc.count; l++) {
    const a = pc.area[l], bw = pc.x1[l] - pc.x0[l] + 1, bh = pc.y1[l] - pc.y0[l] + 1;
    if (a < 150 * k * k || a > 0.01 * n || maxw[l] < 6 * k || !clear[l] || had[l] > 0.8 * a || a / (bw * bh) < 0.4) continue;
    keep[l] = 1; any++;
  }
  if (!any) return [];
  const found = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (keep[pc.label[i]]) found[i] = 1;
  const mask = open(dilate(found, w, h, 2), w, h, r(2));
  const shapes = blockOutlines(mask, w, h, 150 * k * k, 12 * k);
  // A block mostly outlined already adds nothing. An edge along coloured ink
  // with block on both sides is a grid line cutting a block in two, not a
  // street edge under a tram route.
  const R = Math.max(3, r(3)), near = dilate(knownMask, w, h, R), colourNear = dilate(colourInk, w, h, r(2)), piece = 8 * k, out = [];
  const side = 6 * k;
  const isBlock = (x, y) => { const i = idx(x, y, w, h); return blockMask[i] || mask[i]; };
  const cut = (pts) => {
    let both = 0;
    for (let j = 1; j < pts.length; j++) {
      const [ax, ay] = pts[j - 1], [bx, by] = pts[j], l = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (-(by - ay) / l) * side, ny = ((bx - ax) / l) * side;
      if (isBlock(bx + nx, by + ny) && isBlock(bx - nx, by - ny)) both++;
    }
    return both > 0.5 * (pts.length - 1);
  };
  // Its edge must be printed nearly all the way round: an open area fenced
  // by dotted paths or hatching isn't a block.
  const printed = new Uint8Array(n);
  for (let i = 0; i < n; i++) printed[i] = strong[i] || colourInk[i] ? 1 : 0;
  const printedNear = dilate(printed, w, h, r(2) + 1);
  for (const line of shapes) {
    if (meanAlong(line, near, w, h) > 0.95 || meanAlong(line, printedNear, w, h) < 0.9) continue;
    const total = lineLength(line), pieces = Math.max(1, Math.round(total / piece));
    let start = -1;
    for (let p = 0; p <= pieces; p++) {
      let fresh = false;
      if (p < pieces) {
        const pts = samplePath(line, (p * total) / pieces, ((p + 1) * total) / pieces, 2);
        const frac = (m) => pts.reduce((s, [x, y]) => s + m[idx(x, y, w, h)], 0) / pts.length;
        fresh = frac(near) < 0.6 && !(frac(colourNear) >= 0.5 && cut(pts));
      }
      if (fresh && start < 0) start = p;
      if (!fresh && start >= 0) { out.push(subPath(line, (start * total) / pieces, (p * total) / pieces)); start = -1; }
    }
  }
  return out;
}

// ---------- evening out ----------

// Streets keep much the same width, so the usual width is the yardstick for
// what a real line can do: an edge doesn't jut a little way into the road and
// come back (lettering touching it), a line end doesn't hook off into the
// road, and a short stub sticking off a line into the road is a scrap of
// lettering, not a street. groups: lists of lines, checked together.
// Returns { groups, dropped }.
function evenOut(groups, spaceDepth, centres, w, h, k) {
  // Usual street width: twice the distance from a street's centre line to its edges.
  const widths = [];
  for (const l of centres) for (const [x, y] of samplePath(l, 0, lineLength(l), 6)) { const d = spaceDepth[idx(x, y, w, h)]; if (d > 1 && d < 100 * k) widths.push(2 * d); }
  widths.sort((a, b) => a - b);
  const W = widths.length > 50 ? widths[widths.length >> 1] : 20 * k;
  const dropped = [];
  // Pieces that meet end to end are joined first, so a jog that straddles
  // two pieces shows up as one.
  let kept = [];
  groups.forEach((ls, g) => { for (const l of joinEnds(ls)) { const t = trimHooks(flattenBumps(l, W), W); if (t.length > 1) kept.push(Object.assign(t, { g })); } });
  // Stubs: short lines with a free end. A few rounds, as a zigzag of
  // lettering comes off one stub at a time.
  for (let round = 0; round < 3; round++) {
    const owner = new Int32Array(w * h);
    kept.forEach((l, i) => { for (const [x, y] of samplePath(l, 0, lineLength(l), 0.7)) owner[idx(x, y, w, h)] = i + 1; });
    const free = (p, id) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const o = owner[idx(p[0] + dx, p[1] + dy, w, h)]; if (o && o !== id) return false; }
      return true;
    };
    const before = kept.length;
    kept = kept.filter((l, i) => {
      if (lineLength(l) >= 1.5 * W || Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 0.5) return true;
      if (!free(l[0], i + 1) && !free(l[l.length - 1], i + 1)) return true;
      dropped.push(l);
      return false;
    });
    if (kept.length === before) break;
  }
  return { groups: groups.map((_, g) => kept.filter((l) => l.g === g)), dropped };
}

// Joins lines whose ends meet where no third line ends too.
function joinEnds(lines) {
  const ls = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const key = (p) => `${Math.round(p[0] / 2)},${Math.round(p[1] / 2)}`;
  const at = new Map();
  ls.forEach((l, i) => [0, 1].forEach((s) => { const kk = key(s ? l[l.length - 1] : l[0]); if (!at.has(kk)) at.set(kk, []); at.get(kk).push([i, s]); }));
  const alive = ls.map(() => true), into = ls.map((_, i) => i);
  const find = (i) => { while (into[i] !== i) i = into[i] = into[into[i]]; return i; };
  for (const ends of at.values()) {
    if (ends.length !== 2) continue;
    let [[i, si], [j, sj]] = ends;
    i = find(i); j = find(j);
    if (i === j) continue;
    // Each end has to still be an end of the joined line it now belongs to.
    const a = ls[i], b = ls[j], pa = key(si ? a[a.length - 1] : a[0]), pb = key(sj ? b[b.length - 1] : b[0]);
    const aEnd = key(a[a.length - 1]) === pa ? 1 : key(a[0]) === pa ? 0 : -1, bEnd = key(b[b.length - 1]) === pb ? 1 : key(b[0]) === pb ? 0 : -1;
    if (aEnd < 0 || bEnd < 0) continue;
    const left = aEnd ? a : a.slice().reverse(), right = bEnd ? b.slice().reverse() : b;
    ls[i] = left.concat(right.slice(1));
    alive[j] = false; into[j] = i;
  }
  return ls.filter((_, i) => alive[i]);
}

// How far a line turns at b, in radians.
function bend(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(...u) * Math.hypot(...v)) || 1))));
}

// Takes out short detours off a straight run: points between two others
// that are less than two street widths apart, with the line coming in and
// going on in that same direction, turning sharply off it and back, and
// nothing between straying more than half a street width. A curve turns
// gently all along, so it stays.
function flattenBumps(l, W) {
  const closed = l.length > 3 && Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 0.5;
  let pts = closed ? l.slice(0, -1) : l.slice();
  // A closed outline is walked from the start of its longest side, so no
  // detour straddles the join.
  if (closed) {
    let best = 0, bl = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (d > bl) { bl = d; best = i; } }
    pts = pts.slice(best).concat(pts.slice(0, best), [pts[best]]);
  }
  const unit = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
  const c20 = Math.cos(Math.PI / 9);
  for (let i = 1; i < pts.length - 2; i++) {
    for (let j = Math.min(pts.length - 2, i + 8); j >= i + 2; j--) {
      const a = pts[i], b = pts[j], base = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (base < 1 || base > 2 * W) continue;
      if (bend(pts[i - 1], a, pts[i + 1]) < Math.PI / 4 || bend(pts[j - 1], b, pts[j + 1]) < Math.PI / 4) continue;
      const u = unit(a, b);
      if (u[0] * unit(pts[i - 1], a)[0] + u[1] * unit(pts[i - 1], a)[1] < c20) continue;
      if (u[0] * unit(b, pts[j + 1])[0] + u[1] * unit(b, pts[j + 1])[1] < c20) continue;
      let far = 0;
      for (let m = i + 1; m < j; m++) far = Math.max(far, Math.abs((pts[m][0] - a[0]) * u[1] - (pts[m][1] - a[1]) * u[0]));
      if (far > 0.5 * W) continue;
      pts.splice(i + 1, j - i - 1);
      break;
    }
  }
  // Points left in a straight row merge.
  return simplify(pts, 0.75);
}

// A line end that turns sharply off for less than half a street width is a
// hook into the road (a letter's stroke), not part of the line.
function trimHooks(l, W) {
  const turn = (a, b, c) => { const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]]; return (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(...u) * Math.hypot(...v)) || 1); };
  let pts = l;
  for (let pass = 0; pass < 2 && pts.length > 2; pass++) {
    const n = pts.length;
    if (Math.hypot(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]) < 0.5 * W && turn(pts[n - 3], pts[n - 2], pts[n - 1]) < Math.cos(Math.PI / 4)) pts = pts.slice(0, -1);
    if (pts.length > 2 && Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) < 0.5 * W && turn(pts[2], pts[1], pts[0]) < Math.cos(Math.PI / 4)) pts = pts.slice(1);
  }
  return pts;
}
