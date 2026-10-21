// Pulls the drawn lines straight off a scanned map as clean centre-line
// strokes: ink is separated from the paper, lettering and specks are dropped
// by size, what is left is thinned to one-pixel lines and traced into paths,
// grouped by ink colour so each colour can be styled on its own.
import { makeInkImage } from './match.js';

// outScale: multiplies the output coordinates, for a scan analysed at reduced size.
// peel and straighten: auto-clean lettering that touches lines.
export const LINEWORK_DEFAULTS = { contrast: 0.18, minSize: 0.012, colours: 4, simplify: 0.8, outScale: 1, straighten: true, peel: true };

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
  const textSize = Math.max(8, o.minSize * Math.max(width, height));
  // A stretch of line cut off by the lettering removed around it is still
  // line, however short.
  const lineInk = o.peel ? peelLettering(mask, width, height, Math.max(14, textSize * 0.7), textSize) : null;
  dropSmallPieces(mask, width, height, textSize, lineInk);
  onProgress?.('Thinning lines');
  thin(mask, width, height);
  onProgress?.('Tracing lines');
  const unit = Math.max(width, height);
  const sk = traceSkeleton(mask, width, height);
  const lines = prune(sk, unit * 0.005, unit * 0.012)
    .map((l) => (o.straighten ? straighten(l, o.simplify, textSize) : simplify(l, o.simplify)))
    // Short zigzags with a sharp turn every few pixels are the tops of
    // letters touching a line, not something drawn as a line.
    .filter((l) => { const len = lineLength(l); if (len > unit * 0.03) return true; const sharp = sharpTurns(l); return !(sharp >= 3 && sharp * 12 > len); })
    .map((l) => l.map((p) => [p[0] * o.outScale, p[1] * o.outScale]));
  onProgress?.('Sorting by colour');
  return { layers: groupByColour(lines, rgba, width, o.colours, o.outScale) };
}

function paperAt(img, x, y) {
  const bx = Math.min(img.bw - 1, Math.floor(x / img.block)), by = Math.min(img.bh - 1, Math.floor(y / img.block));
  return img.paper[by * img.bw + bx];
}

// Connected pieces of ink smaller than `size` across are lettering, numbers,
// stipple and specks; the street network is one big connected piece.
function dropSmallPieces(mask, w, h, size, keep = null) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    let top = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, count = 0, kept = false;
    stack[top++] = start; label[start] = next;
    const members = [];
    while (top) {
      const i = stack[--top];
      members.push(i);
      count++;
      if (keep?.[i]) kept = true;
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
    if ((span < size && !kept) || solid) for (const i of members) mask[i] = 0;
    next++;
  }
}

// Lettering that touches a line joins the line's piece of ink, so the size
// filter can't see it. Line ink is ink lying on an unbroken straight run,
// longer than a letter is tall, that is also thin across. Whatever is left
// and touches a line is lettering when it is letter-sized or encloses the
// small holes words have; a thin bridge between two bits of line, or a long
// curve (a wiggly coast), stays. Returns the line ink.
export function peelLettering(mask, w, h, runLen, textSize, debug) {
  const thickV = runsAcross(mask, w, h, 0, 1), thickH = runsAcross(mask, w, h, 1, 0);
  const onLine = new Uint8Array(w * h);
  const maxThick = 6, D = 32;
  // Ink pixels listed column by column and row by row, so each direction
  // only visits ink, in order along its lines.
  let nInk = 0;
  for (let i = 0; i < mask.length; i++) nInk += mask[i];
  const byRow = new Int32Array(nInk), byCol = new Int32Array(nInk);
  for (let i = 0, n = 0; i < mask.length; i++) if (mask[i]) byRow[n++] = i;
  for (let x = 0, n = 0; x < w; x++) for (let y = 0; y < h; y++) if (mask[y * w + x]) byCol[n++] = y * w + x;
  for (let k = 0; k < D; k++) {
    const a = (k * Math.PI) / D, c = Math.cos(a), sn = Math.sin(a);
    const alongX = Math.abs(c) >= Math.abs(sn);
    const slope = alongX ? sn / c : c / sn;
    const len = alongX ? w : h, across = alongX ? h : w;
    const need = Math.ceil(runLen * Math.max(Math.abs(c), Math.abs(sn)));
    const T = alongX ? thickV : thickH;
    const reach = Math.ceil(Math.abs(slope) * len);
    // Pixel (t, q) along this direction lies on line s0 = q - off[t]; each
    // line keeps the run it is in the middle of.
    const off = new Int32Array(len);
    for (let t = 0; t < len; t++) off[t] = Math.round(t * slope);
    const lines = across + 2 * reach;
    const start = new Int32Array(lines).fill(-2), last = new Int32Array(lines).fill(-2), nThin = new Int32Array(lines);
    const flush = (L) => {
      const s0 = L - reach, n = last[L] + 1 - start[L];
      if (n >= need && nThin[L] >= n * 0.45) for (let u = start[L]; u <= last[L]; u++) { const q = s0 + off[u]; onLine[alongX ? q * w + u : u * w + q] = 1; }
    };
    const list = alongX ? byCol : byRow;
    for (let n = 0; n < list.length; n++) {
      const i = list[n], x = i % w, y = (i - x) / w;
      const t = alongX ? x : y, L = (alongX ? y : x) - off[t] + reach;
      if (last[L] !== t - 1) { if (start[L] >= 0) flush(L); start[L] = t; nThin[L] = 0; }
      last[L] = t;
      if (T[i] <= maxThick) nThin[L]++;
    }
    for (let L = 0; L < lines; L++) if (start[L] >= 0) flush(L);
  }
  grow(onLine, mask, w, h, 2);
  // Label the line ink, then judge each leftover piece by what it touches.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let next = 1;
  const flood = (seed, inSet, visit) => {
    let top = 0;
    stack[top++] = seed; label[seed] = next;
    while (top) {
      const i = stack[--top];
      visit?.(i);
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (inSet(j) && !label[j]) { label[j] = next; stack[top++] = j; }
      }
    }
    return next++;
  };
  for (let i = 0; i < onLine.length; i++) if (onLine[i] && !label[i]) flood(i, (j) => onLine[j]);
  const lastLine = next;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    const members = [], contacts = [], touches = new Set();
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    flood(i, (j) => mask[j] && !onLine[j], (m) => {
      members.push(m);
      const x = m % w, y = (m - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      let touching = false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const l = label[yy * w + xx];
        if (l && l < lastLine && onLine[yy * w + xx]) { touches.add(l); touching = true; }
      }
      if (touching) contacts.push(m);
    });
    const span = Math.max(x1 - x0, y1 - y0) + 1;
    // A faint one-pixel line breaks into short runs; the bits between them
    // lie flat between two contacts and are part of the line.
    if (bridges(members, contacts, w, span)) continue;
    // Small, or a run of letters: words enclose holes (o, a, e, r, and the
    // gaps letters close against the line); a curve that is part of the
    // drawing has none.
    let lettering = touches.size >= 1 && span < textSize;
    if (!lettering && touches.size >= 1 && span < textSize * 10) {
      const hl = holes(members, w, x0, y0, x1, y1, (textSize * 0.5) ** 2);
      lettering = hl.small >= 2 && hl.large === 0;
    }
    if (lettering) for (const m of members) mask[m] = 0;
    else if (debug) for (const m of members) debug[m] = 2;
  }
  if (debug) for (let i = 0; i < onLine.length; i++) if (onLine[i]) debug[i] = 1;
  return onLine;
}

// True when the piece is a thin straight stroke running from one contact
// with line ink to another, rather than something hanging off the line.
function bridges(members, contacts, w, span) {
  if (contacts.length < 2) return false;
  const xy = (m) => [m % w, Math.floor(m / w)];
  const far = (from) => { let best = contacts[0], bd = -1; for (const c of contacts) { const [x, y] = xy(c); const d = (x - from[0]) ** 2 + (y - from[1]) ** 2; if (d > bd) { bd = d; best = c; } } return xy(best); };
  const a = far(xy(contacts[0])), b = far(a);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 4 || len < span * 0.7) return false;
  for (const m of members) {
    const [x, y] = xy(m);
    if (Math.abs((b[0] - a[0]) * (a[1] - y) - (a[0] - x) * (b[1] - a[1])) / len > 2.5) return false;
  }
  return true;
}

// Holes in one connected piece, split by area: letters enclose small holes
// (o, a, e, and gaps closed against the line); a block outline encloses a
// large one.
function holes(members, w, x0, y0, x1, y1, smallArea) {
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
  const b = new Uint8Array(bw * bh);
  for (const m of members) { const x = m % w, y = (m - x) / w; b[(y - y0 + 1) * bw + x - x0 + 1] = 1; }
  // 0 paper, 1 ink, 2 outside; paper not reached from outside is a hole.
  const stack = [0];
  b[0] = 2;
  const fill = (mark, onPixel) => {
    while (stack.length) {
      const i = stack.pop();
      onPixel?.();
      const x = i % bw, y = (i - x) / bw;
      if (x > 0 && !b[i - 1]) { b[i - 1] = mark; stack.push(i - 1); }
      if (x < bw - 1 && !b[i + 1]) { b[i + 1] = mark; stack.push(i + 1); }
      if (y > 0 && !b[i - bw]) { b[i - bw] = mark; stack.push(i - bw); }
      if (y < bh - 1 && !b[i + bw]) { b[i + bw] = mark; stack.push(i + bw); }
    }
  };
  fill(2);
  let small = 0, large = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i]) continue;
    let area = 0;
    b[i] = 3; stack.push(i);
    fill(3, () => area++);
    // Specks of paper between strokes are not holes.
    if (area < 3) continue;
    if (area <= smallArea) small++; else large++;
  }
  return { small, large };
}

function grow(set, mask, w, h, r) {
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let d = -r; d <= r && !on; d++) { const xx = x + d; if (xx >= 0 && xx < w && set[y * w + xx]) on = 1; }
    tmp[y * w + x] = on;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (set[i] || !mask[i]) continue;
    for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h && tmp[yy * w + x]) { set[i] = 1; break; } }
  }
}

// Length of the unbroken ink run through each pixel along (dx, dy).
function runsAcross(mask, w, h, dx, dy) {
  const t = new Uint8Array(w * h);
  const outer = dx ? h : w, inner = dx ? w : h;
  for (let o = 0; o < outer; o++) {
    let start = -1;
    for (let k = 0; k <= inner; k++) {
      const i = dx ? o * w + k : k * w + o;
      const on = k < inner && mask[i];
      if (on && start < 0) start = k;
      if (!on && start >= 0) {
        const v = Math.min(255, k - start);
        for (let m = start; m < k; m++) t[dx ? o * w + m : m * w + o] = v;
        start = -1;
      }
    }
  }
  return t;
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
    // Start mid-chain: walk both ways from here. A chain can be cut off from
    // its junctions when a neighbouring walk crossed into it.
    visited[i] = 1;
    for (let k = 0; k < 2; k++) {
      const nb = neighbours(i).filter((j) => !visited[j] && !isNode[j]);
      if (nb.length) lines.push(walk(i, nb[0]));
    }
  }
  return lines.map((l) => l.map((i) => [i % w, Math.floor(i / w)]));
}

// Lettering that touches a line survives the size filter as a tangle of
// short spurs and tiny loops hanging off it. The traced pieces are treated as
// a network: short dead ends and small closed loops are trimmed, and pieces
// that meet end to end with nothing else at the joint are rejoined, so a
// street stays one line however many spurs were cut off it.
function prune(lines, spur, loop) {
  // Junctions are often a few touching pixels; ends that touch are one joint.
  const key = (p) => p[1] * 1e6 + p[0];
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { const g = parent.get(parent.get(k)); parent.set(k, g); k = g; } return k; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(a, b); };
  for (const l of lines) for (const p of [l[0], l[l.length - 1]]) parent.set(key(p), key(p));
  for (const k of [...parent.keys()]) {
    const x = k % 1e6, y = (k - x) / 1e6;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = (y + dy) * 1e6 + x + dx; if (n !== k && parent.has(n)) union(k, n); }
  }
  let segs = [];
  for (const l of lines) {
    const a = find(key(l[0])), b = find(key(l[l.length - 1]));
    if (a === b && l.length <= 3) continue;
    segs.push({ l, len: lineLength(l), a, b });
  }
  for (let round = 0; round < 6; round++) {
    const deg = degrees(segs);
    const before = segs.length;
    segs = segs.filter((s) => (s.a === s.b ? s.len >= loop : !(s.len < spur && (deg.get(s.a) === 1 || deg.get(s.b) === 1))));
    segs = joinChains(segs);
    if (segs.length === before) break;
  }
  return segs.map((s) => s.l);
}

function degrees(segs) {
  const deg = new Map();
  for (const s of segs) { deg.set(s.a, (deg.get(s.a) || 0) + 1); deg.set(s.b, (deg.get(s.b) || 0) + 1); }
  return deg;
}

// Pieces meeting at a joint where only the two of them meet become one line.
function joinChains(segs) {
  const deg = degrees(segs);
  const at = new Map();
  segs.forEach((s, i) => { for (const c of [s.a, s.b]) { if (!at.has(c)) at.set(c, []); at.get(c).push(i); } });
  const used = new Uint8Array(segs.length);
  const other = (c, i) => { const l = at.get(c); return l[0] === i ? l[1] : l[0]; };
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    // Back up to the start of the chain (or once round, for a closed chain).
    let cur = i, end = segs[i].a;
    for (;;) {
      if (deg.get(end) !== 2 || segs[cur].a === segs[cur].b) break;
      const prev = other(end, cur);
      if (prev === i || used[prev]) break;
      end = segs[prev].a === end ? segs[prev].b : segs[prev].a;
      cur = prev;
    }
    // Walk forward from there, joining pieces.
    let from = end, pts = [], len = 0, first = from;
    for (;;) {
      const s = segs[cur];
      used[cur] = 1;
      const fwd = s.a === from ? s.l : s.l.slice().reverse();
      pts = pts.length ? pts.concat(fwd.slice(1)) : fwd.slice();
      len += s.len;
      from = s.a === from ? s.b : s.a;
      if (deg.get(from) !== 2 || s.a === s.b) break;
      const next = other(from, cur);
      if (used[next]) break;
      cur = next;
    }
    out.push({ l: pts, len, a: first, b: from });
  }
  return out;
}

// Douglas-Peucker, then square up corners: thinning cuts a corner off at
// about 45 degrees, so a short cut between two straight runs is replaced by
// the point where those runs meet. Only gentle bends are smoothed, so pixel
// steps don't show and corners stay sharp.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  // A closed loop starts and ends on the same pixel, which gives no base
  // line, so split it at its farthest point first.
  let stack = [[0, pts.length - 1]];
  const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
  if (Math.hypot(ex - sx, ey - sy) < 2) {
    let far = 1, fd = -1;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.hypot(pts[i][0] - sx, pts[i][1] - sy); if (d > fd) { fd = d; far = i; } }
    keep[far] = 1;
    stack = [[0, far], [far, pts.length - 1]];
  }
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
  let out = pts.filter((_, i) => keep[i]);
  out = squareCorners(out, 8);
  return out.map((p, i) => {
    if (i === 0 || i === out.length - 1 || turnAt(out, i) > Math.PI / 7) return p;
    return [(out[i - 1][0] + 2 * p[0] + out[i + 1][0]) / 4, (out[i - 1][1] + 2 * p[1] + out[i + 1][1]) / 4];
  });
}

// Where lettering touches a straight line, the traced line zigzags through
// the letters. If a line with many sharp turns collapses to a few straight
// runs when simplified at about half a letter's height, those runs are what
// was drawn, so they replace the zigzag. Lines that stay detailed at that
// tolerance (a coast, a winding path) are left alone.
function straighten(pts, tol, textSize) {
  const fine = simplify(pts, tol);
  const len = lineLength(fine);
  const sharp = sharpTurns(fine);
  if (len < textSize || sharp < 3 || sharp * textSize * 0.6 < len) return fine;
  const coarse = simplify(pts, textSize * 0.25);
  return coarse.length - 1 <= Math.max(2, Math.ceil(len / (textSize * 3))) ? coarse : fine;
}

function sharpTurns(pts) {
  let n = 0;
  for (let i = 1; i < pts.length - 1; i++) if (turnAt(pts, i) > Math.PI / 3) n++;
  return n;
}

function turnAt(pts, i) {
  const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
  const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
  let t = Math.abs(b - a);
  return t > Math.PI ? 2 * Math.PI - t : t;
}

function squareCorners(pts, maxCut) {
  const out = pts.slice();
  for (let i = 1; i < out.length - 2; i++) {
    const p0 = out[i - 1], p1 = out[i], p2 = out[i + 1], p3 = out[i + 2];
    const cut = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (cut > maxCut || Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < cut || Math.hypot(p3[0] - p2[0], p3[1] - p2[1]) < cut) continue;
    const t1 = turnAt(out, i), t2 = turnAt(out, i + 1);
    const total = t1 + t2;
    if (t1 < 0.25 || t2 < 0.25 || total < Math.PI / 3 || total > Math.PI * 0.75) continue;
    // Both turns must bend the same way.
    const c1 = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]);
    const c2 = (p2[0] - p1[0]) * (p3[1] - p2[1]) - (p2[1] - p1[1]) * (p3[0] - p2[0]);
    if (c1 * c2 <= 0) continue;
    const x = intersect(p0, p1, p2, p3);
    if (!x || Math.hypot(x[0] - (p1[0] + p2[0]) / 2, x[1] - (p1[1] + p2[1]) / 2) > cut * 1.5) continue;
    out.splice(i, 2, x);
  }
  return out;
}

function intersect([x1, y1], [x2, y2], [x3, y3], [x4, y4]) {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 1e-9) return null;
  const a = x1 * y2 - y1 * x2, b = x3 * y4 - y3 * x4;
  return [(a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d];
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
