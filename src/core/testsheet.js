// Made-up map sheets with known answers, for checking "Pull lines from scan"
// on more than one map. Each sheet is drawn like a printed city map (block
// outlines, street names in the streets, red symbols, tree-lined avenues,
// dashed streets and paths, railways, a harbour with a pier) at any size and
// in a few ink styles, and comes with the lines that should come out of it.
//
// The drawing size (`scale`) and the sheet size in pixels are separate, so
// the same map can be drawn small on a big sheet or big on a small one: a
// pull that sizes its steps from the map's own lines gives the same answer
// either way.
//
// makeTestSheet(options) -> { rgba, w, h, truth: { lines, zones }, yard }
//   lines: [{ kind, pts, narrow? }], kind one of block, tree, dashed, path, rail,
//          shore, grid, frame
//   zones: [{ kind: 'lettering' | 'empty', pts }] areas where no line belongs
//   yard:  the line weight and street width it was drawn with, in pixels

const STYLES = {
  blue: { paper: [232, 226, 212], ink: [40, 48, 94], red: [205, 80, 70], water: [170, 200, 192] },
  black: { paper: [240, 236, 225], ink: [32, 30, 30], red: [190, 60, 50], water: [180, 205, 220] },
  brown: { paper: [236, 224, 196], ink: [92, 62, 42], red: [200, 92, 60], water: [178, 202, 186] }
};

export const SHEET_DEFAULTS = { scale: 1, style: 'blue', seed: 1, colour: true, rotate: true, width: null, lineWeight: 2, streetWidth: 13 };

export function makeTestSheet(options = {}) {
  const o = { ...SHEET_DEFAULTS, ...options };
  const st = STYLES[o.style] || STYLES.blue;
  const rnd = mulberry(o.seed);
  const s = o.scale;
  const LW = o.lineWeight * s, SW = o.streetWidth * s;
  // Base layout is 1100 x 850 at scale 1; `width` pads the sheet out.
  const w = Math.max(Math.round(1100 * s), o.width || 0), h = Math.round(w * 850 / 1100);
  const ox = (w - 1100 * s) / 2, oy = (h - 850 * s) / 2;
  const cv = new Sheet(w, h);
  const lines = [], zones = [];
  const P = (x, y) => [ox + x * s, oy + y * s];
  const water = cv.fillLayer(st.water), ink = cv.layer(st.ink), red = o.colour ? cv.layer(st.red) : null;
  const truth = (kind, pts, extra) => lines.push({ kind, pts, ...extra });

  // The frame round the map, and a title box.
  const fr = [P(12, 12), P(1088, 12), P(1088, 838), P(12, 838)];
  ink.stroke(closeRing(fr), LW * 1.5);
  truth('frame', closeRing(fr));
  const tb = [P(30, 26), P(330, 26), P(330, 104), P(30, 104)];
  ink.stroke(closeRing(tb), LW);
  truth('frame', closeRing(tb));
  zones.push({ kind: 'empty', pts: tb });
  text(ink, 'TEST CITY', P(48, 80), 34 * s, 0, LW * 1.4);
  text(ink, 'SCALE ' + s, P(240, 96), 9 * s, 0, LW * 0.8);

  // Downtown: rows of blocks as separate rounded outlines, many of them no
  // wider than the streets between them, turned like Halifax's.
  const down = panel(P, [30, 125, 560, 480], o.rotate ? -15 : 0);
  const rowsDown = [];
  let y = 160;
  const narrowPattern = [0, 1, 1, 0, 1, 1, 0, 1, 0, 1];
  for (let r = 0; y < 470; r++) {
    const narrow = narrowPattern[r % narrowPattern.length] === 1;
    const bh = (narrow ? 0.85 + rnd() * 0.45 : 2.6 + rnd() * 1.6) * o.streetWidth;
    if (y + bh > 445) break;
    rowsDown.push([y, y + bh, narrow]);
    y += bh + o.streetWidth;
  }
  const colsDown = [];
  for (let x = 70; x < 500;) {
    const bw = (4 + rnd() * 5) * o.streetWidth;
    if (x + bw > 505) break;
    colsDown.push([x, x + bw]);
    x += bw + o.streetWidth;
  }
  for (const [y0, y1, narrow] of rowsDown) for (const [x0, x1] of colsDown) {
    const ring = roundRect(x0, y0, x1, y1, Math.min(0.35 * o.streetWidth, (y1 - y0) / 3)).map(down);
    ink.stroke(ring, LW);
    truth('block', ring, { narrow });
  }
  // Street names in the streets between rows, as tall as the street, so
  // they touch the block edges either side; some down the cross streets.
  const words = ['MARKET ST', 'GRANVILLE', 'HOLLIS', 'BARRINGTON', 'ARGYLE ST', 'GEORGE', 'DUKE ST', 'PRINCE', 'SACKVILLE', 'BLOWERS'];
  rowsDown.slice(0, -1).forEach(([, y1], i) => {
    const word = words[i % words.length], hgt = o.streetWidth * 0.82;
    const x = 80 + rnd() * 150, base = y1 + o.streetWidth / 2 + hgt / 2;
    zones.push({ kind: 'lettering', pts: [[x - 2, base - hgt - 1], [x + textWidth(word, hgt) + 2, base - hgt - 1], [x + textWidth(word, hgt) + 2, base + 1], [x - 2, base + 1]].map(down) });
    text(ink, word, down([x, base]), hgt * s, -15 * (o.rotate ? 1 : 0), LW * 0.75, 0.25);
  });
  colsDown.slice(0, -1).forEach(([, x1], i) => {
    if (i % 2) return;
    const word = words[(i + 3) % words.length], hgt = o.streetWidth * 0.8;
    const cx = x1 + o.streetWidth / 2, y0 = 175 + rnd() * 80;
    const tl = textWidth(word, hgt);
    zones.push({ kind: 'lettering', pts: [[cx - hgt / 2 - 1, y0 - 2], [cx + hgt / 2 + 1, y0 - 2], [cx + hgt / 2 + 1, y0 + tl + 2], [cx - hgt / 2 - 1, y0 + tl + 2]].map(down) });
    text(ink, word, down([cx - hgt / 2, y0]), hgt * s, 90 - 15 * (o.rotate ? 1 : 0), LW * 0.75, 0.25);
  });
  // Red symbols: diamonds with a letter in them, on block corners and in streets.
  const paperInk = red ? cv.layer(st.paper) : null;
  if (red) for (let i = 0; i < 7; i++) {
    const [y0, y1] = rowsDown[Math.floor(rnd() * rowsDown.length)], [x0, x1] = colsDown[Math.floor(rnd() * colsDown.length)];
    const cx = rnd() < 0.5 ? x0 : x1, cy = rnd() < 0.5 ? y0 : y1, d = 0.8 * o.streetWidth;
    const dia = [[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]].map(down);
    red.fill(dia);
    zones.push({ kind: 'lettering', pts: dia });
    text(paperInk, 'ABDEHKMPRT'[i], down([cx - d * 0.3, cy + d * 0.35]), d * 0.7 * s, o.rotate ? -15 : 0, LW * 0.7);
  }

  // Houses: ordinary blocks, one row of them drawn with dashed outlines
  // (streets laid out but not built yet), turned a little the other way.
  const res = panel(P, [590, 125, 1070, 480], o.rotate ? 8 : 0);
  let yy = 140, rowNo = 0;
  while (yy < 460) {
    const bh = (3 + rnd() * 2) * o.streetWidth;
    if (yy + bh > 470) break;
    let xx = 600;
    while (xx < 1060) {
      const bw = (5 + rnd() * 3) * o.streetWidth;
      if (xx + bw > 1060) break;
      const dashed = rowNo === 1;
      const ring = roundRect(xx, yy, xx + bw, yy + bh, 0.2 * o.streetWidth).map(res);
      if (dashed) ink.dashed(ring, LW, SW * 0.9, SW * 0.45);
      else ink.stroke(ring, LW);
      truth(dashed ? 'dashed' : 'block', ring);
      xx += bw + o.streetWidth * 1.2;
    }
    if (rowNo !== 1) {
      const word = words[(rowNo + 5) % words.length], hgt = o.streetWidth * 0.8;
      const x = 620 + rnd() * 200, base = yy + bh + o.streetWidth * 0.6 + hgt / 2;
      if (base < 470) {
        zones.push({ kind: 'lettering', pts: [[x - 2, base - hgt - 1], [x + textWidth(word, hgt) + 2, base - hgt - 1], [x + textWidth(word, hgt) + 2, base + 1], [x - 2, base + 1]].map(res) });
        text(ink, word, res([x, base]), hgt * s, o.rotate ? 8 : 0, LW * 0.75, 0.25);
      }
    }
    yy += bh + o.streetWidth * 1.2;
    rowNo++;
  }

  // A park: a frame of streets round open ground, avenues lined with rows
  // of trees across it, and dashed footpaths.
  const park = [[40, 505], [560, 505], [560, 820], [40, 820]];
  ink.stroke(closeRing(park.map((p) => P(...p))), LW);
  truth('block', closeRing(park.map((p) => P(...p))));
  for (const [a, b] of [[[70, 540], [530, 790]], [[70, 780], [400, 560]]]) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
    for (const side of [-1, 1]) {
      const off = side * o.streetWidth * 0.8;
      const pa = [a[0] + nx * off, a[1] + ny * off], pb = [b[0] + nx * off, b[1] + ny * off];
      treeRow(ink, P(...pa), P(...pb), SW * 0.55, LW, rnd);
      truth('tree', [P(...pa), P(...pb)]);
    }
  }
  const path = [[90, 640], [180, 610], [260, 650], [330, 700], [420, 690], [520, 720]].map((p) => P(...p));
  ink.dashed(path, LW * 0.8, SW * 0.5, SW * 0.4);
  truth('dashed', path);
  text(ink, 'PARK', P(400, 640), 14 * s, 0, LW * 0.8, 0.25);
  zones.push({ kind: 'lettering', pts: [P(398, 624), P(448, 624), P(448, 642), P(398, 642)] });

  // Woods drawn as close hatching, with paths left as paper winding
  // through them.
  const trails = [[[358, 38], [420, 68], [480, 58], [552, 94]], [[420, 68], [446, 106]]];
  const clear = 1.5 * o.lineWeight + o.lineWeight / 2;
  const nearTrail = (x, y) => trails.some((t) => t.some((q, i) => {
    if (!i) return false;
    const [ax, ay] = t[i - 1], [bx, by] = q, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    return Math.hypot(x - ax - u * dx, y - ay - u * dy) < clear;
  }));
  const stroke = 0.6 * o.streetWidth;
  for (let y = 26; y <= 106; y += 1.5 * o.lineWeight) {
    for (let x = 352 + rnd() * stroke; x + stroke <= 558; x += stroke + 0.15 * o.streetWidth) {
      const bend = (rnd() - 0.5) * o.lineWeight, a = [x, y], m = [x + stroke / 2, y + bend], b = [x + stroke, y + (rnd() - 0.5) * o.lineWeight * 0.5];
      if ([a, m, b].some(([px, py]) => nearTrail(px, py))) continue;
      ink.stroke([a, m, b].map((q) => P(...q)), LW);
    }
  }
  for (const t of trails) truth('path', t.map((q) => P(...q)));

  // Railways (a heavy hatched band, and a line with cross ticks), a few
  // blocks, and the harbour with a pier.
  const rail1 = [[590, 525], [750, 520], [900, 540], [1070, 585]].map((p) => P(...p));
  hatchedBand(ink, rail1, SW * 0.38, LW, SW * 0.45);
  truth('rail', rail1);
  const rail2 = [[590, 600], [1070, 640]].map((p) => P(...p));
  ink.stroke(rail2, LW);
  ticks(ink, rail2, SW * 0.5, SW * 0.55, LW * 0.8);
  truth('rail', rail2);
  for (let i = 0; i < 4; i++) {
    const x0 = 610 + i * 110, y0 = 665 - i * 3;
    const ring = roundRect(x0, y0, x0 + 85, y0 + 45, 3).map((p) => P(...p));
    ink.stroke(ring, LW);
    truth('block', ring);
  }
  const shore = [[590, 760], [700, 750], [800, 770], [880, 740], [1000, 755], [1088, 735]];
  const pier = [[820, 763], [820, 815], [836, 815], [836, 761]];
  const shoreline = [...shore.slice(0, 3), ...pier.map(([x, y], i) => i === 0 ? [x, y] : [x, y]), ...shore.slice(3)].map((p) => P(...p));
  water.fill([...shoreline, P(1088, 838), P(590, 838)]);
  ink.stroke(shoreline, LW);
  truth('shore', shoreline);
  // The frame closes the water off at the bottom; that edge is the frame's.

  // A red reference grid line, edge to edge.
  if (red) {
    const g = [P(575, 12), P(575, 838)];
    red.stroke(g, LW * 0.9);
    truth('grid', g);
  }

  const rgba = cv.render(st.paper, rnd);
  return { rgba, w, h, truth: { lines, zones }, yard: { lineWeight: LW, streetWidth: SW, scale: s } };
}

// ---------- drawing ----------

class Sheet {
  constructor(w, h) { this.w = w; this.h = h; this.layers = []; }
  layer(colour) { const l = new Layer(this, colour, false); this.layers.push(l); return l; }
  fillLayer(colour) { const l = new Layer(this, colour, true); this.layers.push(l); return l; }
  render(paper, rnd) {
    const { w, h } = this, n = w * h;
    const rgb = new Float32Array(n * 3);
    // Paper with a little mottling and grain, like a scan of old paper.
    const fx = 0.004 + rnd() * 0.004, fy = 0.003 + rnd() * 0.004, ph = rnd() * 6;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const m = 4 * Math.sin(x * fx + ph) * Math.cos(y * fy) + (rnd() - 0.5) * 6;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = paper[c] + m;
    }
    for (const l of this.layers) {
      if (!l.alpha) continue;
      for (let i = 0; i < n; i++) {
        let a = l.alpha[i];
        if (!a) continue;
        if (!l.isFill) a *= 0.82 + rnd() * 0.18;
        for (let c = 0; c < 3; c++) rgb[i * 3 + c] += (l.colour[c] - rgb[i * 3 + c]) * a;
      }
    }
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = 255; }
    return out;
  }
}

class Layer {
  constructor(sheet, colour, isFill) { this.sheet = sheet; this.colour = colour; this.isFill = isFill; this.alpha = null; }
  get a() { return this.alpha || (this.alpha = new Float32Array(this.sheet.w * this.sheet.h)); }
  // A line `width` wide along the points, with soft (anti-aliased) edges.
  stroke(pts, width) {
    const a = this.a, { w, h } = this.sheet, r = width / 2;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
        const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
        const c = Math.min(1, Math.max(0, r + 0.5 - d));
        const j = y * w + x;
        if (c > a[j]) a[j] = c;
      }
    }
  }
  dashed(pts, width, on, off) { for (const p of dashes(pts, on, off)) this.stroke(p, width); }
  // A filled polygon (even-odd), sampled at four points a pixel for soft edges.
  fill(pts) {
    const a = this.a, { w, h } = this.sheet;
    const ys = pts.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const row = new Float32Array(w);
    for (let y = y0; y <= y1; y++) {
      row.fill(0);
      for (const sy of [0.25, 0.75]) {
        const yc = y + sy, xs = [];
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
          if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) for (const sx of [0.25, 0.75]) {
          const from = Math.max(0, Math.ceil(xs[i] - sx)), to = Math.min(w - 1, Math.floor(xs[i + 1] - sx));
          for (let x = from; x <= to; x++) row[x] += 0.25;
        }
      }
      for (let x = 0; x < w; x++) if (row[x] > a[y * w + x]) a[y * w + x] = row[x];
    }
  }
}

function dashes(pts, on, off) {
  const out = [];
  let cur = [pts[0]], left = on, drawing = true;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg > left) {
      const t = left / seg;
      const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
      if (drawing) { cur.push([mx, my]); out.push(cur); } else cur = [[mx, my]];
      drawing = !drawing;
      seg -= left; ax = mx; ay = my;
      left = drawing ? on : off;
    }
    left -= seg;
    if (drawing) cur.push([bx, by]);
  }
  if (drawing && cur.length > 1) out.push(cur);
  return out;
}

// Rows of trees drawn the old way: a chain of small scalloped crowns.
function treeRow(layer, a, b, size, LW, rnd) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const step = size * 0.8;
  for (let t = size / 2; t < L - size / 2; t += step * (0.85 + rnd() * 0.3)) {
    const cx = a[0] + ux * t + (rnd() - 0.5) * size * 0.15, cy = a[1] + uy * t + (rnd() - 0.5) * size * 0.15;
    const rr = size / 2 * (0.85 + rnd() * 0.3), ring = [];
    for (let k = 0; k <= 16; k++) {
      const ang = k / 16 * Math.PI * 2, bump = 1 + 0.12 * Math.cos(ang * 5 + rnd());
      ring.push([cx + Math.cos(ang) * rr * bump, cy + Math.sin(ang) * rr * bump]);
    }
    layer.stroke(ring, LW * 0.8);
    if (rnd() < 0.6) layer.stroke([[cx - rr * 0.3, cy], [cx + rr * 0.2, cy + rr * 0.2]], LW * 0.7);
  }
}

// A railway as a heavy band: two lines with cross hatching between them.
function hatchedBand(layer, pts, width, LW, gap) {
  for (const side of [-0.5, 0.5]) layer.stroke(offset(pts, side * width), LW);
  for (const [p, nx, ny] of along(pts, gap)) layer.stroke([[p[0] - nx * width / 2, p[1] - ny * width / 2], [p[0] + nx * width / 2, p[1] + ny * width / 2]], LW * 0.9);
}
function ticks(layer, pts, gap, len, LW) {
  for (const [p, nx, ny] of along(pts, gap)) layer.stroke([[p[0] - nx * len / 2, p[1] - ny * len / 2], [p[0] + nx * len / 2, p[1] + ny * len / 2]], LW);
}
function* along(pts, gap) {
  let carry = gap / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let t = carry; t < L; t += gap) { yield [[ax + ux * t, ay + uy * t], -uy, ux]; carry = t + gap - L; }
  }
}
function offset(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] - (b[1] - a[1]) / L * d, p[1] + (b[0] - a[0]) / L * d];
  });
}

function roundRect(x0, y0, x1, y1, r) {
  const pts = [];
  const arc = (cx, cy, from) => { for (let k = 0; k <= 4; k++) { const t = (from + k * 22.5) * Math.PI / 180; pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]); } };
  arc(x1 - r, y0 + r, 270); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, 90); arc(x0 + r, y0 + r, 180);
  pts.push(pts[0]);
  return pts;
}
function closeRing(p) { return [...p, p[0]]; }

// Places a panel's layout (in scale-1 units) on the sheet, turned about its centre.
function panel(P, [x0, y0, x1, y1], deg) {
  const [cx, cy] = P((x0 + x1) / 2, (y0 + y1) / 2), c = Math.cos(deg * Math.PI / 180), sn = Math.sin(deg * Math.PI / 180);
  return (p) => { const [x, y] = P(p[0], p[1]), dx = x - cx, dy = y - cy; return [cx + dx * c - dy * sn, cy + dx * sn + dy * c]; };
}

// ---------- lettering ----------

// A plain stroke alphabet on a 4 x 6 grid (y down), enough for street names.
const GLYPHS = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 3.5], [3, 3.5]]],
  B: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [0, 6]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 1], [3, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[2, 0], [2, 6]], [[1, 0], [3, 0]], [[1, 6], [3, 6]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1.5, 2.5], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  '.': [[[2, 5.5], [2, 6]]]
};
function textWidth(str, height) { return str.length * height / 6 * 5.5; }
// Text with its baseline starting at `at`, `height` tall, turned `deg`
// degrees, slanted like map italics by `slant`.
function text(layer, str, at, height, deg, weight, slant = 0) {
  const u = height / 6, c = Math.cos(deg * Math.PI / 180), sn = Math.sin(deg * Math.PI / 180);
  [...str].forEach((ch, i) => {
    for (const stroke of GLYPHS[ch] || []) {
      layer.stroke(stroke.map(([gx, gy]) => {
        const lx = (i * 5.5 + gx + slant * (6 - gy)) * u, ly = (gy - 6) * u;
        return [at[0] + lx * c - ly * sn, at[1] + lx * sn + ly * c];
      }), weight);
    }
  });
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
