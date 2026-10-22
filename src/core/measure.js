// Measures a map's own yardsticks, so the pull can size every step from the
// map instead of from the image's pixel count: the same map scanned at twice
// the resolution, or a map drawn with bolder lines and wider streets, then
// gets the same treatment.
//
//   lineWeight:  how thick the printed lines are, in pixels
//   streetWidth: the usual distance between the two edges of a street,
//                centre of line to centre of line, in pixels (a rough guide)
//
// Both come from chords: for each pixel, the shortest straight run through it
// (across, down or along either diagonal) that stays on ink, or on paper.
// Every pixel of a line sees the same chord, the line's thickness, so the
// most common ink chord is the line weight. On paper, every pixel across a
// street sees the street's width; counted by length rather than area (so a
// big block doesn't outvote the streets round it), the most common paper
// chord wider than the lines is the street width.

// gray: the image in grey; paperOf(i): the paper tone at pixel i; ink: the
// ink mask; paper: the paper mask (no ink, no coloured fill).
export function measureYardsticks(gray, paperOf, ink, paper, w, h) {
  const lineWeight = measureLineWeight(gray, paperOf, ink, w, h);
  const street = lineWeight.value ? measureStreetWidth(paper, w, h, lineWeight.value) : { value: 0, share: 0 };
  // The same on the pull's own ink mask, soft edges and all: how thick a
  // line looks to the steps that work on that mask.
  const inkWidth = peak(ink, chords(ink, w, h), 0.25, 0.75, 40, () => 1);
  return {
    lineWeight: round(lineWeight.value),
    inkWidth: round(inkWidth.value),
    streetWidth: round(street.value),
    // How much of what was counted sits in the peak: a clear single line
    // weight is what the pull sizes itself by.
    sure: lineWeight.share > 0.3,
    shares: [round(lineWeight.share), round(street.share)]
  };
}

// Line weight: the most common ink chord, measured on the ink darker than
// halfway between the paper and the ink, so the soft edge of a line (which
// the pull's own ink mask takes in, more of it the darker the ink) doesn't
// count.
export function measureLineWeight(gray, paperOf, ink, w, h) {
  const tones = new Uint32Array(256);
  let m = 0;
  for (let i = 0; i < ink.length; i++) if (ink[i]) { tones[gray[i]]++; m++; }
  if (!m) return { value: 0, share: 0 };
  // The ink's own tone: the darker end of what was taken for ink.
  let tone = 0;
  for (let acc = 0; tone < 255; tone++) { acc += tones[tone]; if (acc >= m * 0.2) break; }
  const core = new Uint8Array(w * h);
  for (let i = 0; i < core.length; i++) if (ink[i] && gray[i] < (paperOf(i) + tone) / 2) core[i] = 1;
  return peak(core, chords(core, w, h), 0.25, 0.75, 40, () => 1);
}

// Street width: paper chords wider than a couple of line weights (gaps in
// lettering and hatching are narrower), each pixel weighted by 1/chord so a
// corridor counts by its length, plus one line weight (centre of line to
// centre of line). Only a rough guide: streets with a line down the middle
// (tram tracks) or many widths on one map blur it.
export function measureStreetWidth(paper, w, h, lineWeight) {
  const minGap = Math.max(3, 1.5 * lineWeight);
  const p = peak(paper, chords(paper, w, h), 0.5, minGap, Math.max(w, h) / 8, (c) => 1 / c);
  return { value: p.value ? p.value + lineWeight : 0, share: p.share };
}

function round(v) { return Math.round(v * 100) / 100; }

// The most common value of chord[i] over mask[i], in bins of `bin` pixels
// between lo and hi, weighted by weight(chord); then the weighted mean of
// the values within 20% of it, and the share of the weight they hold.
function peak(mask, chord, bin, lo, hi, weight) {
  const nb = Math.ceil(hi / bin) + 1, hist = new Float64Array(nb);
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const c = chord[i] / 4;
    if (c < lo || c > hi) continue;
    const wt = weight(c);
    hist[Math.round(c / bin)] += wt;
    total += wt;
  }
  if (!total) return { value: 0, share: 0 };
  // Smooth over a few bins so a peak split across two bins still wins.
  let best = 0, bestV = -1;
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let d = -2; d <= 2; d++) if (b + d >= 0 && b + d < nb) s += hist[b + d] * (3 - Math.abs(d));
    if (s > bestV) { bestV = s; best = b; }
  }
  const mode = best * bin;
  let sw = 0, sv = 0;
  for (let b = 0; b < nb; b++) {
    const v = b * bin;
    if (Math.abs(v - mode) <= 0.2 * mode + bin) { sw += hist[b]; sv += hist[b] * v; }
  }
  return { value: sw ? sv / sw : mode, share: sw / total };
}

// Shortest straight run through each pixel of the mask, in quarter pixels.
function chords(mask, w, h) {
  const out = new Uint16Array(w * h).fill(65535);
  const run = (start, step, count, len) => {
    let i = start, from = -1;
    for (let t = 0; t <= count; t++, i += step) {
      const on = t < count && mask[i];
      if (on && from < 0) from = t;
      if (!on && from >= 0) {
        const v = Math.min(65535, Math.round((t - from) * len * 4));
        for (let j = start + from * step, u = from; u < t; u++, j += step) if (v < out[j]) out[j] = v;
        from = -1;
      }
    }
  };
  for (let y = 0; y < h; y++) run(y * w, 1, w, 1);
  for (let x = 0; x < w; x++) run(x, w, h, 1);
  const D = Math.SQRT2;
  // Diagonals down-right, starting along the top row and the left column.
  for (let x = 0; x < w; x++) run(x, w + 1, Math.min(w - x, h), D);
  for (let y = 1; y < h; y++) run(y * w, w + 1, Math.min(h - y, w), D);
  // Diagonals down-left, starting along the top row and the right column.
  for (let x = 0; x < w; x++) run(x, w - 1, Math.min(x + 1, h), D);
  for (let y = 1; y < h; y++) run(y * w + w - 1, w - 1, Math.min(h - y, w), D);
  return out;
}
