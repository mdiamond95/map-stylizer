// Fills in lines the other methods left broken. A street edge that stops
// short usually does so because lettering, a tram-route symbol or a fold
// sits on top of it, so each loose end is tried against a few simple guesses
// at how the line carries on:
//   - straight on, until it meets another line
//   - across to another loose end that faces it
//   - round a missing corner, where two loose ends point across each other
//   - across the open side of a block, where two loose ends point the same way
// A guess is only taken when ink runs along nearly all of it: lettering and
// symbols count, since the line is under them, but a stretch of bare paper
// (a street crossing, an open park edge) means the line really does stop.
import { lineLength } from './linework.js';

// lines: the kept lines (image pixels). ink: any printed ink, of any colour.
// skip: where no line may be guessed (water, boxes of print). k: image scale
// (1 for a 3,000-pixel-wide map). Returns { lines, ends } with the guesses
// and how many loose ends there were.
export function inferLines(lines, ink, skip, w, h, k) {
  const n = w * h;
  const owner = new Int32Array(n);
  const put = (x, y, id) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) owner[y * w + x] = id; };
  const paint = (l, id) => { for (const [x, y] of along(l, 0.7)) put(x, y, id); };
  lines.forEach((l, i) => paint(l, i + 1));
  // Ink near the guess: one pixel of slack, since a guess is straight and the
  // printed line may wobble.
  const evid = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!ink[i]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) evid[yy * w + xx] = 1; }
  }
  const at = (x, y) => Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x)));
  // Whose line is within r pixels of a point, other than `not`.
  const near = (x, y, r, not) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const o = owner[yy * w + xx];
      if (o && o !== not) return o;
    }
    return 0;
  };

  const R = Math.max(2, Math.round(2 * k));
  const reach = 70 * k, maxBlank = 4 * k, back = 10 * k;
  // Loose ends: line ends with no other line touching them.
  const findEnds = () => {
    const ends = [];
    lines.forEach((l, i) => {
      if (l.length < 2) return;
      const len = lineLength(l);
      if (len < 6 * k) return;
      if (Math.hypot(l[0][0] - l[l.length - 1][0], l[0][1] - l[l.length - 1][1]) < 3) return;
      for (const s of [0, 1]) {
        const p = s ? l[l.length - 1] : l[0];
        if (near(p[0], p[1], R, i + 1)) continue;
        // Direction over the last stretch, so a wobble right at the end doesn't throw it.
        const q = pointAt(l, s ? len - Math.min(back, len / 2) : Math.min(back, len / 2));
        const dx = p[0] - q[0], dy = p[1] - q[1], dl = Math.hypot(dx, dy);
        if (dl < 1) continue;
        ends.push({ p, d: [dx / dl, dy / dl], id: i + 1, used: false });
      }
    });
    return ends;
  };

  // How well the printed ink backs a guess: the share of it on ink, and the
  // longest stretch of bare paper. Guesses into water or print are out, as
  // are ones that run along a line already there.
  const score = (path, id) => {
    const pts = along(path, 1);
    let on = 0, blank = 0, run = 0, dup = 0;
    for (let s = 0; s < pts.length; s++) {
      const [x, y] = pts[s], i = at(x, y);
      if (skip[i]) return null;
      if (evid[i]) { on++; run = 0; } else if (++run > blank) blank = run;
      // Away from where it starts and ends, a guess shouldn't sit on a line.
      if (s > R + 1 && s < pts.length - R - 2 && near(x, y, 1, id)) dup++;
    }
    return { on: on / pts.length, blank, dup: dup / pts.length, len: pts.length };
  };

  const out = [];
  let loose = 0;
  for (let round = 0; round < 2; round++) {
    const ends = findEnds();
    if (!round) loose = ends.length;
    const cands = [];
    // Straight on until it meets a line.
    ends.forEach((e, a) => {
      for (let t = 1; t <= reach; t++) {
        const x = e.p[0] + e.d[0] * t, y = e.p[1] + e.d[1] * t;
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const o = near(x, y, 1, t < 4 * R ? e.id : -1);
        if (!o) continue;
        if (t > 1.5) cands.push({ path: [e.p, [x, y]], ends: [a], id: e.id });
        break;
      }
    });
    // Between two loose ends.
    const cell = reach, grid = new Map();
    const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    ends.forEach((e, a) => { const kk = key(...e.p); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(a); });
    ends.forEach((e, a) => {
      const cx = Math.floor(e.p[0] / cell), cy = Math.floor(e.p[1] / cell);
      for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) for (const b of grid.get(`${gx},${gy}`) || []) {
        if (b <= a) continue;
        const f = ends[b];
        const vx = f.p[0] - e.p[0], vy = f.p[1] - e.p[1], dist = Math.hypot(vx, vy);
        if (dist < 1.5 || dist > reach) continue;
        const u = [vx / dist, vy / dist], dd = dot(e.d, f.d);
        if (dot(e.d, u) > 0.94 && -dot(f.d, u) > 0.94) {
          // Facing each other: straight across.
          cands.push({ path: [e.p, f.p], ends: [a, b], id: e.id });
        } else if (Math.abs(dd) < 0.26) {
          // Pointing across each other: meet at a corner ahead of both.
          const den = e.d[0] * f.d[1] - e.d[1] * f.d[0];
          const t = (vx * f.d[1] - vy * f.d[0]) / den, s = (vx * e.d[1] - vy * e.d[0]) / den;
          if (t > -R && s > -R && t < reach && s < reach) cands.push({ path: [e.p, [e.p[0] + e.d[0] * t, e.p[1] + e.d[1] * t], f.p], ends: [a, b], id: e.id });
        } else if (dd > 0.96) {
          // Side by side, pointing the same way: the open side of a block.
          // Bring the one behind level with the other, then go across.
          if (Math.abs(dot(u, e.d)) > 0.45) continue;
          const lead = vx * e.d[0] + vy * e.d[1];
          const q = lead > 0 ? [e.p[0] + e.d[0] * lead, e.p[1] + e.d[1] * lead] : [f.p[0] - f.d[0] * lead, f.p[1] - f.d[1] * lead];
          cands.push({ path: [e.p, q, f.p], ends: [a, b], id: e.id });
        }
      }
    });
    // Best backed and shortest first; each loose end takes one guess.
    const scored = [];
    for (const c of cands) {
      const s = score(c.path, c.id);
      if (!s || s.dup > 0.3) continue;
      const ok = s.len <= 6 * k || (s.blank <= maxBlank && s.on >= 0.85);
      if (ok) scored.push({ ...c, s });
    }
    scored.sort((p, q) => p.s.len - q.s.len);
    let added = 0;
    for (const c of scored) {
      if (c.ends.some((a) => ends[a].used)) continue;
      // Check again against what was added this round.
      const s = score(c.path, c.id);
      if (!s || s.dup > 0.3) continue;
      c.ends.forEach((a) => { ends[a].used = true; });
      lines.push(c.path);
      paint(c.path, lines.length);
      out.push(c.path);
      added++;
    }
    if (!added) break;
  }
  return { lines: out, ends: loose };
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

// Points every `step` pixels along a polyline, ends included.
function along(l, step) {
  const pts = [l[0]];
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i];
    const len = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= m; s++) pts.push([ax + ((bx - ax) * s) / m, ay + ((by - ay) * s) / m]);
  }
  return pts;
}

function pointAt(l, dist) {
  let acc = 0;
  for (let i = 1; i < l.length; i++) {
    const len = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    if (acc + len >= dist) { const t = len ? (dist - acc) / len : 0; return [l[i - 1][0] + (l[i][0] - l[i - 1][0]) * t, l[i - 1][1] + (l[i][1] - l[i - 1][1]) * t]; }
    acc += len;
  }
  return l[l.length - 1];
}
