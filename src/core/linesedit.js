// Hand tidying of the lines pulled from a scan: tap a leftover squiggle to
// delete it, or rub out bits of line with a round eraser. Lines are SVG path
// data in image pixels ("M x,y L x,y ..."), one subpath per line.

export function parsePath(d) {
  return d.split('M').filter(Boolean).map((s) => s.split('L').map((p) => p.split(',').map(Number)));
}

export function toPathData(lines) {
  return lines.map((l) => 'M' + l.map((p) => `${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`).join('L')).join('');
}

export function lineLength(l) {
  let s = 0;
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}

function distToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function distToLine(pt, l) {
  if (l.length === 1) return Math.hypot(pt[0] - l[0][0], pt[1] - l[0][1]);
  let best = Infinity;
  for (let i = 1; i < l.length; i++) best = Math.min(best, distToSegment(pt, l[i - 1], l[i]));
  return best;
}

// The line nearest the point within tol, as { layer, index }, or null.
// layers: [[line, ...], ...]
export function nearestLine(layers, pt, tol) {
  let best = null, bd = tol;
  layers.forEach((lines, layer) => lines.forEach((l, index) => {
    const d = distToLine(pt, l);
    if (d <= bd) { bd = d; best = { layer, index }; }
  }));
  return best;
}

// Cuts away every part of the lines inside the circle; what is left either
// side carries on as separate lines. Bits shorter than minLen are dropped.
export function eraseCircle(lines, [cx, cy], r, minLen = 2) {
  const out = [];
  let changed = false;
  for (const l of lines) {
    if (!nearCircle(l, cx, cy, r)) { out.push(l); continue; }
    changed = true;
    let run = [l[0]];
    const insideStart = Math.hypot(l[0][0] - cx, l[0][1] - cy) < r;
    if (insideStart) run = null;
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1], b = l[i];
      const [t1, t2] = segmentInCircle(a, b, cx, cy, r);
      const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (t1 === null) { if (run) run.push(b); continue; }
      // Outside up to t1, inside t1..t2, outside again after t2.
      if (run && t1 > 0) run.push(at(t1));
      if (run) { out.push(run); run = null; }
      if (t2 < 1) run = [at(t2), b];
    }
    if (run) out.push(run);
  }
  if (!changed) return lines;
  return out.filter((l) => l.length > 1 && lineLength(l) >= minLen);
}

function nearCircle(l, cx, cy, r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of l) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (cx < x0 - r || cx > x1 + r || cy < y0 - r || cy > y1 + r) return false;
  return distToLine([cx, cy], l) < r;
}

// Where segment a-b is inside the circle, as [t1, t2] in 0..1, or [null].
function segmentInCircle(a, b, cx, cy, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - cx, fy = a[1] - cy;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  if (!A) return C < 0 ? [0, 1] : [null];
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [null];
  const s = Math.sqrt(disc);
  const t1 = Math.max(0, (-B - s) / (2 * A)), t2 = Math.min(1, (-B + s) / (2 * A));
  return t1 < t2 ? [t1, t2] : [null];
}
