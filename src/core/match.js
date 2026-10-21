// Keeps only the reference streets that are actually drawn on the scanned map,
// so an old map is not covered in today's highways and suburbs. Each street is
// walked in short pieces; a piece stays when the image has ink running along it.

// Luminance at up to maxPixels, plus a local "paper" brightness per block so
// faded corners and blue water are judged against their own background.
export function makeInkImage(rgba, width, height, { block = 32 } = {}) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  const bw = Math.ceil(width / block), bh = Math.ceil(height / block);
  const paper = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      const x1 = Math.min(width, (bx + 1) * block), y1 = Math.min(height, (by + 1) * block);
      for (let y = by * block; y < y1; y++) for (let x = bx * block; x < x1; x++) { hist[gray[y * width + x]]++; n++; }
      // The 80th percentile is the paper (or water) tone even in busy blocks.
      let acc = 0, v = 255;
      for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= n * 0.8) { v = k; break; } }
      paper[by * bw + bx] = v;
    }
  }
  return { gray, paper, width, height, block, bw, bh };
}

function paperAt(img, x, y) {
  const fx = Math.min(img.bw - 1, Math.max(0, x / img.block - 0.5));
  const fy = Math.min(img.bh - 1, Math.max(0, y / img.block - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(img.bw - 1, x0 + 1), y1 = Math.min(img.bh - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const p = img.paper, w = img.bw;
  return (p[y0 * w + x0] * (1 - tx) + p[y0 * w + x1] * tx) * (1 - ty) + (p[y1 * w + x0] * (1 - tx) + p[y1 * w + x1] * tx) * ty;
}

// strictness 0..1: how dark the ink must be and how much of each piece must have it.
export function matchSettings(strictness = 0.5, tolerancePx = 6) {
  const k = Math.max(0, Math.min(1, strictness));
  return {
    contrast: 0.07 + 0.12 * k,
    keep: 0.3 + 0.4 * k,
    radius: Math.max(4, Math.min(30, tolerancePx)),
    step: 3,
    run: 5,
    piece: 45
  };
}

// lines: polylines in image pixels; scale: ink image pixels per image pixel.
// Returns kept and dropped polylines, in image pixels.
export function matchLines(lines, img, scale, settings) {
  const kept = [], dropped = [];
  let keptLength = 0, totalLength = 0;
  for (const line of lines) {
    const samples = sampleLine(line, settings.step);
    if (samples.length < 2) continue;
    const flags = inkFlags(samples, img, scale, settings);
    const per = Math.max(2, Math.round(settings.piece / settings.step));
    const pieces = [];
    for (let i = 0; i < samples.length - 1; i += per) {
      const end = Math.min(samples.length - 1, i + per);
      let hit = 0;
      for (let j = i; j <= end; j++) hit += flags[j];
      pieces.push({ from: i, to: end, ok: hit / (end - i + 1) >= settings.keep });
    }
    // A single weak piece between two good ones is usually a label or a
    // crossing drawn over the street, not a missing street.
    for (let p = 1; p < pieces.length - 1; p++) if (!pieces[p].ok && pieces[p - 1].ok && pieces[p + 1].ok) pieces[p].fill = true;
    // A lone good piece in a long street is more likely block outlines or
    // lettering beside it than a surviving bit of street.
    if (pieces.length > 2) {
      const good = (q) => q >= 0 && q < pieces.length && (pieces[q].ok || pieces[q].fill);
      const lone = pieces.map((piece, p) => piece.ok && !good(p - 1) && !good(p + 1));
      lone.forEach((l, p) => { if (l) pieces[p].ok = false; });
    }
    let run = null;
    const flush = () => { if (run) { (run.ok ? kept : dropped).push(samples.slice(run.from, run.to + 1).map((s) => [s[0], s[1]])); run = null; } };
    for (const p of pieces) {
      const ok = p.ok || !!p.fill;
      const len = (p.to - p.from) * settings.step;
      totalLength += len;
      if (ok) keptLength += len;
      if (run && run.ok === ok) run.to = p.to;
      else { flush(); run = { from: p.from, to: p.to, ok }; }
    }
    flush();
  }
  return { kept, dropped, keptLength, totalLength };
}

// Evenly spaced points with the local direction, so the ink test can look
// across the street at each one.
function sampleLine(line, step) {
  const out = [];
  let t = 0;
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1], [x1, y1] = line[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!len) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    for (; t < len; t += step) out.push([x0 + ux * t, y0 + uy * t, ux, uy]);
    t -= len;
  }
  const last = line[line.length - 1], prev = out[out.length - 1];
  if (prev) out.push([last[0], last[1], prev[2], prev[3]]);
  return out;
}

// 1 where the image has a line running along the street at this point: a dark
// pixel across the street at an offset that carries on, give or take a pixel,
// for several samples in a row. Text and solid dark areas rarely do that.
function inkFlags(samples, img, scale, st) {
  const r = Math.max(2, Math.round(st.radius * scale));
  const dark = samples.map(([x, y, ux, uy]) => {
    const sx = x * scale, sy = y * scale;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) return null;
    const limit = paperAt(img, sx, sy) * (1 - st.contrast);
    const offs = [];
    for (let o = -r; o <= r; o++) {
      const px = Math.round(sx - uy * o), py = Math.round(sy + ux * o);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      if (img.gray[py * img.width + px] < limit) offs.push(o);
    }
    return offs.length > (2 * r + 1) * 0.6 ? null : offs;
  });
  // run[i][k]: how many samples in a row end at dark offset k of sample i.
  const flags = new Uint8Array(samples.length);
  let prev = null, prevRun = null;
  for (let i = 0; i < dark.length; i++) {
    const d = dark[i];
    const run = d ? d.map((o) => {
      let best = 0;
      if (prev) for (let j = 0; j < prev.length; j++) if (Math.abs(prev[j] - o) <= 1 && prevRun[j] > best) best = prevRun[j];
      return best + 1;
    }) : null;
    if (run && Math.max(...run) >= st.run) for (let j = Math.max(0, i - st.run + 1); j <= i; j++) flags[j] = 1;
    prev = d; prevRun = run;
  }
  return flags;
}

export function linesToPath(lines) {
  return lines.map((l) => 'M' + l.map((p) => `${Math.round(p[0] * 10) / 10},${Math.round(p[1] * 10) / 10}`).join('L')).join('');
}

export function lineLength(l) {
  let s = 0;
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}
