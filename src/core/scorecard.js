// Grades a pull against the known answers of a test sheet (testsheet.js):
// how much of each kind of line came out in the layer it belongs in, and how
// much came out that isn't on the map at all (lettering, symbols, trees
// traced as wiggles).
//
// scoreSheet(layers, truth, { streetWidth }) -> {
//   found: { block, narrow, tree, dashed, dashedAnywhere, path, rail, shore, grid }  fraction of each kind's length found
//   extra: length of shown lines not near any real line, as a fraction of the real lines' length
//   onLettering: length of shown lines over street names and symbols, in pixels
// }

// Which layers each kind of line should come out in.
const HOMES = {
  block: /^(Street and block edges|Filled-in lines)$/,
  tree: /^(Street and block edges|Filled-in lines)$/,
  dashed: /^Dashed lines$/,
  dashedAnywhere: /^(Street and block edges|Filled-in lines|Dashed lines)$/,
  path: /^Paths through woods$/,
  rail: /^Railways$/,
  shore: /^(Water edge|Street and block edges)$/,
  grid: /^Grid lines$/
};

export function pathLines(d) {
  return (d || '').split('M').slice(1).map((seg) => seg.split('L').map((p) => p.split(',').map(Number)));
}

export function scoreSheet(layers, truth, { streetWidth = 13 } = {}) {
  const tol = Math.max(2.5, 0.3 * streetWidth);
  const shown = layers.filter((l) => !l.area && (l.show !== false || l.name === 'Map border'));
  const near = (re) => new NearIndex(shown.filter((l) => re.test(l.name)).flatMap((l) => pathLines(l.d)), tol);
  const found = {};
  const total = {};
  for (const [kind, re] of Object.entries(HOMES)) {
    const idx = near(re);
    const lines = truth.lines.filter((l) => l.kind === (kind === 'dashedAnywhere' ? 'dashed' : kind));
    const pts = lines.flatMap((l) => sample(l.pts, 1));
    if (pts.length) { found[kind] = round(pts.filter((p) => idx.has(p)).length / pts.length); total[kind] = pts.length; }
    if (kind === 'block') {
      const np = truth.lines.filter((l) => l.kind === 'block' && l.narrow).flatMap((l) => sample(l.pts, 1));
      if (np.length) found.narrow = round(np.filter((p) => idx.has(p)).length / np.length);
    }
  }
  // Lines that aren't on the map: nowhere near any real line.
  const real = new NearIndex(truth.lines.map((l) => l.pts), tol);
  const out = shown.flatMap((l) => pathLines(l.d).flatMap((pl) => sample(pl, 1)));
  const stray = out.filter((p) => !real.has(p));
  const realLength = truth.lines.reduce((s, l) => s + sample(l.pts, 1).length, 0);
  const inZone = (kind) => stray.filter((p) => truth.zones.some((z) => z.kind === kind && inside(p, z.pts))).length;
  return { found, extra: round(stray.length / realLength), extraPx: stray.length, onLettering: inZone('lettering'), inEmpty: inZone('empty'), tol };
}

function round(v) { return Math.round(v * 1000) / 1000; }

function sample(pts, step) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
    for (let t = 0; t < L; t += step) out.push([ax + (bx - ax) * t / L, ay + (by - ay) * t / L]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

function inside([x, y], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Points along lines in a grid of cells, to ask "is any line within tol?".
class NearIndex {
  constructor(lines, tol) {
    this.tol = tol; this.cells = new Map();
    for (const l of lines) for (const p of sample(l, Math.max(0.5, tol / 3))) {
      const key = this.key(Math.floor(p[0] / tol), Math.floor(p[1] / tol));
      let c = this.cells.get(key);
      if (!c) this.cells.set(key, (c = []));
      c.push(p);
    }
  }
  key(cx, cy) { return cx * 100003 + cy; }
  has([x, y]) {
    const cx = Math.floor(x / this.tol), cy = Math.floor(y / this.tol), t2 = this.tol * this.tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [px, py] of this.cells.get(this.key(cx + dx, cy + dy)) || []) if ((px - x) ** 2 + (py - y) ** 2 <= t2) return true;
    }
    return false;
  }
}
