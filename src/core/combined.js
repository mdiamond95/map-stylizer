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
import { measureYardsticks } from './measure.js';
import { inferLines } from './infer.js';
import { LINEWORK_DEFAULTS, extractLinework, thin, traceSkeleton, prune, simplify, colourName, toPath, lineLength } from './linework.js';

// Sizes below are tuned on a city map (Halifax, 1940s, a 3,500-pixel scan
// whose lines are 1.6 pixels thick) and scaled from there by each map's own
// line weight: k is 1 for lines LINE_WEIGHT_PER_K pixels thick. `scale` sets
// k by hand instead.
export const COMBINED_DEFAULTS = { ...LINEWORK_DEFAULTS, scale: 0 };
const LINE_WEIGHT_PER_K = 1.6 / (3500 / 3000);

// rgba: image pixels; returns { layers: [{ name, colour, d, count, length, show }] }.
export function extractCombined(rgba, w, h, options = {}, onProgress) {
  const o = { ...COMBINED_DEFAULTS, ...options };
  // With debug on, each method's own lines come back too, for comparing them.
  const dbg = o.debug ? {} : null;
  const out = o.outScale;
  const n = w * h;

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
  // Every size below was tuned on a city map with lines 1.6 pixels thick
  // (a 3,500-pixel scan) and is scaled by this map's own line weight, so a
  // bigger scan or a boldly drawn map gets the same treatment. Without a
  // clear line weight, sizes go by the image size instead.
  const yard = measureYardsticks(inkImg.gray, (i) => { const x = i % w; return paperAt(inkImg, x, (i - x) / w); }, ink, ink.map((v) => 1 - v), w, h);
  const k = o.scale || (yard.sure ? Math.min(8, Math.max(0.3, yard.lineWeight / LINE_WEIGHT_PER_K)) : Math.max(w, h) / 3000);
  const r = (px) => Math.max(1, Math.round(px * k));
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
  // Pictures on the water (ships, sailboats, the compass rose) are drawings,
  // not map. Ships are mostly ink and already count as water; a sailboat's
  // paper sails leave a hole in the water with lines drawn inside it, which
  // an island doesn't have.
  sailsToWater(fill, ink, w, h, k);
  // Thin lines drawn out on the water (the compass rose, rigging) are water
  // too: anything dry there narrower than a pier.
  {
    const dry = new Uint8Array(n);
    for (let i = 0; i < n; i++) dry[i] = fill[i] ? 0 : 1;
    // Piers are narrow too, but they're joined to the land.
    const land = open(dry, w, h, 2), landNear = dilate(land, w, h, 2);
    const wet = dilate(fill, w, h, 3);
    const thin = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (dry[i] && !land[i] && wet[i]) thin[i] = 1;
    const tc = components(thin, w, h, true);
    const joined = new Uint8Array(tc.count + 1);
    for (let i = 0; i < n; i++) if (tc.label[i] && landNear[i] && hasLandNeighbour(land, i, w, h)) joined[tc.label[i]] = 1;
    for (let i = 0; i < n; i++) if (tc.label[i] && !joined[tc.label[i]]) fill[i] = 1;
  }
  // Lines well out on the water belong to such pictures.
  const deepWater = erode(fill, w, h, r(3));

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
  const symbolNear = dilate(colourInk, w, h, 2), hulls = [];
  if (dbg) dbg.narrow = [];
  for (let l = 1; l <= pc.count; l++) {
    const a = pc.area[l], bw = pc.x1[l] - pc.x0[l] + 1, bh = pc.y1[l] - pc.y0[l] + 1;
    if (a < 40 * k * k) continue;
    // A street is a narrow patch (often cut short by its lettering) or the
    // big connected network; a block is wide enough and fairly compact.
    if (a > 0.02 * n) { kind[l] = 2; continue; }
    if (maxw[l] >= 6 * k && a / (bw * bh) >= 0.3) { if (a >= 150 * k * k) kind[l] = 1; continue; }
    // Narrower than a usual block, or loose in the box round it: a street
    // cut off by its lettering, or a block no wider than the streets round
    // it, or a long block turned at an angle. A block fills the rectangle
    // round it (turned its own way); a street's cut-off ends follow its
    // letters, so it doesn't. Not a sliver between two lines printed close
    // together (a double frame, a railway band), though.
    kind[l] = 2;
    if (a >= 150 * k * k) {
      const j = blockLike(pc, l, w, symbolNear);
      // It's drawn as its hull, so lettering or a symbol biting into an edge
      // doesn't put a notch in its outline.
      if (j.fillRect >= 0.8 && j.wid >= 2.5 * yard.inkWidth && j.len <= 12 * j.wid) { kind[l] = 1; hulls.push(j.hull()); }
      if (dbg) dbg.narrow.push({ l, a, maxw: maxw[l], block: kind[l] === 1, ...j });
    }
  }
  // The map's border and the framed boxes on it (the title, legends) are
  // found from their long straight sides; nothing in them is map.
  const frame = framesAndBoxes(ink, w, h, k, (i) => kind[pc.label[i]] === 1);
  for (let i = 0; i < n; i++) if (frame.crop[i]) crop[i] = 1;
  if (dbg) Object.assign(dbg, { paperLabel: pc.label, kind, crop: crop.slice() });
  if (dbg) dbg.boxes = frame.boxes.map(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
  for (let i = 0; i < n; i++) {
    if (crop[i]) continue;
    const t = kind[pc.label[i]];
    if (t === 1) blocks[i] = 1; else if (t === 2) streets[i] = 1;
  }
  for (const ring of hulls) {
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys)), bw = Math.ceil(Math.max(...xs)) - x0 + 1, bh = Math.ceil(Math.max(...ys)) - y0 + 1;
    // Pixel centres are on the hull's corners; half a pixel round them is in.
    const m = fillPolygon(ring.map(([x, y]) => [x + 0.5 + Math.sign(x - (x0 + bw / 2)) * 0.5, y + 0.5 + Math.sign(y - (y0 + bh / 2)) * 0.5]), x0, y0, bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const i = (y + y0) * w + x + x0; if (m[y * bw + x] && !crop[i]) blocks[i] = 1; }
  }
  // Grow each block back over half its outline, and smooth off the bumps.
  let blockMask = open(dilate(blocks, w, h, 1), w, h, r(2));
  // Hill shading and tree drawings enclose patches of paper too. A patch
  // is dropped when two separate tests agree it isn't a block: it sits in
  // hatching (many short arcs scattered in every direction, unlike lettering,
  // which runs in a row, or dashes, which are straight) and its outline is
  // jagged, many short turns instead of a few straight sides.
  const { texture, longInk } = hatching(ink, w, h, k);
  const shapes = [];
  for (const p of blockOutlines(blockMask, w, h, 150 * k * k)) {
    const t = meanAlong(p, texture, w, h), turns = turnsPer100(p);
    if ((t > 0.3 && turns > 8) || (t > 0.1 && turns > 12)) continue;
    // Small scribbles drawn by loose marks rather than by a long printed line.
    if (lineLength(p) < 250 * k && turns > 10 && meanAlong(p, longInk, w, h) < 0.4) continue;
    // A big open area can have one side running along hatching: that side is cut off.
    shapes.push(...cutJagged(p, texture, w, h, k));
  }
  if (dbg) Object.assign(dbg, { texture, ink: ink.slice(), fill: fill.slice(), colourInk });

  onProgress?.('Finding the streets');
  const blockNear = dilate(blockMask, w, h, 1);
  let space = new Uint8Array(n);
  for (let i = 0; i < n; i++) space[i] = (streets[i] || ink[i]) && !blockNear[i] ? 1 : 0;
  space = close(space, w, h, r(3));
  // Open ground (a park, a common, the paper round the map) isn't street:
  // paper far from any line, and the paper round it, is left out.
  const deep = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (depth[i] > 25 * k) deep[i] = 1;
  const openGround = dilate(deep, w, h, r(25));
  for (let i = 0; i < n; i++) if (blockNear[i] || fill[i] || crop[i] || openGround[i]) space[i] = 0;
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
  const centres = streetCentres(space, w, h, k);

  const sub = { ...o, outScale: 1, keepLines: true, unit: 3000 * k, lineWeight: yard.lineWeight };
  onProgress?.('Tracing the ink');
  const plain = extractLinework(rgba, w, h, sub);
  onProgress?.('Tracing without street names');
  const masked = extractLinework(painted, w, h, sub);
  const isColour = (l) => meanAlong(l, colourInk, w, h) > 0.5;
  const plainLines = plain.lines.filter((l) => !isColour(l));
  const maskedLines = masked.lines.filter((l) => !isColour(l));
  const fillEdges = edgeLines(fill, crop, w, h, yard.lineWeight || 1.6 * k, ink);
  const margin = 0.03 * Math.max(w, h);
  const inMargin = ([x, y]) => x < margin || y < margin || x > w - margin || y > h - margin;
  const rails = railLines(ink, fill, crop, w, h, k, inMargin);
  for (const l of tickedLines(ink, crop, w, h, k, yard.lineWeight, inMargin)) if (meanAlong(l, dilate(rasterise(rails, w, h), w, h, r(4)), w, h) < 0.5) rails.push(l);
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
  const kept = { edges: [], fill: [] };
  let unsure = [];
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
          if (frac(crop) > 0.5 || frac(near) >= 0.6 || frac(railBand) >= 0.6 || frac(deepWater) >= 0.6) { keep = false; }
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
    if (dbg) dbg['kept ' + src] = add;
  }
  // Long straight lines only one tracer found are real lines far more often
  // than lettering, which is short and twisty, when they join up with lines
  // already kept (hillside hatching doesn't). Twice, so a road can grow out
  // along a chain of them. Not in the margin (the map's frame), round boxes
  // of print or along grid lines.
  unsure = unsure.filter((l) => meanAlong(l, deepWater, w, h) < 0.6);
  let unsureLeft = unsure.filter((l) => {
    const len = lineLength(l);
    const straight = Math.hypot(l[l.length - 1][0] - l[0][0], l[l.length - 1][1] - l[0][1]) / (len || 1);
    return len > 25 * k && straight > 0.85 && l.filter(inMargin).length < l.length / 2 && meanAlong(l, cropNear, w, h) < 0.5 && meanAlong(l, colourNear, w, h) < 0.5;
  });
  const others = unsure.filter((l) => !unsureLeft.includes(l));
  if (dbg) dbg['kept unsure'] = [];
  for (let round = 0; round < 2; round++) {
    const joined = dilate(accepted, w, h, r(6));
    const touches = (l) => joined[idx(l[0][0], l[0][1], w, h)] || joined[idx(l[l.length - 1][0], l[l.length - 1][1], w, h)];
    unsureLeft = unsureLeft.filter((l) => { if (!touches(l)) return true; kept.edges.push(l); dbg?.['kept unsure']?.push(l); drawLine(accepted, l, w, h); return false; });
  }
  unsureLeft = unsureLeft.concat(others);
  const gaps = closeGaps(kept.edges, 10 * k);

  onProgress?.('Evening out');
  const even = evenOut([kept.edges.concat(gaps)], spaceDepth, centres, w, h, k, yard.lineWeight || 1.6 * k, ink);
  unsureLeft = unsureLeft.concat(even.dropped);

  // Lines in a second ink colour: the reference grid printed over the map,
  // dead straight lines from edge to edge, found by methods that must agree
  // and drawn exactly straight, shown where the map shows it (not across the
  // title and legend boxes).
  const grid = gridLines(colourInk, w, h, k, frame.neat);
  const gridShown = grid.flatMap((l) => splitOff(l, crop, w, h, 20 * k));
  const gridBand = dilate(rasterise(grid, w, h), w, h, r(4));
  // Tram routes: the coloured ink left once the grid is out, with the
  // route-number badges and arrows closed into the line so one joined line
  // runs through them, across the gaps where a street crosses.
  const routes = routeLines(colourInk, A, B, gridBand, crop, deepWater, w, h, k).map((l) => trimHooks(flattenBumps(l, even.width), even.width));
  const stretches = routeSides(routes, strongInk(inkImg, ink, w, h), even.groups[0].concat(kept.fill), even.width, w, h, k);

  onProgress?.('Filling in missing lines');
  // Not along railways or dashed lines, which have layers of their own.
  const avoid = dilate(rasterise(rails.concat(dashed), w, h), w, h, R + r(3));
  const filled = fillIn({ inkImg, ink, colourInk, gridBand, hints: sideLines(stretches), fill, crop, blockMask, avoid, edges: even.groups[0], shore: kept.fill, w, h, k });
  unsureLeft = unsureLeft.concat(filled.creases);

  // The street edges the routes hide.
  const under = routeEdges({ stretches, strong: filled.strong, blocks: filled.blocks, edges: filled.edges, known: filled.edges.concat(filled.inferred, kept.fill), w, h, k });
  filled.edges = under.edges;
  filled.inferred.push(...under.lines);
  // Dashed street edges traced as solid go to the dashed lines.
  const dashRuns = dashedRuns(filled.edges, inkImg, w, h, k);
  filled.edges = dashRuns.solid;
  dashed.push(...dashRuns.dashed);
  if (dbg) dbg['dashed runs'] = dashRuns.dashed;
  if (dbg) Object.assign(dbg, { 'route edges': under.lines, 'route junk': under.junk, 'route sides': sideLines(stretches), routes, strong: filled.strong, blocks: filled.blocks, 'known': filled.edges.concat(filled.inferred, kept.fill), streetWidth: new Float32Array([even.width]) });

  onProgress?.('Sorting layers');
  const scaled = (ls) => ls.filter((l) => l.length > 1).map((l) => l.map(([x, y]) => [x * out, y * out]));
  const layer = (name, colour, lines, show = true) => {
    const ls = scaled(lines);
    return { name, colour, count: ls.length, length: ls.reduce((s, l) => s + lineLength(l), 0), d: toPath(ls), show };
  };
  const main = plain.layers[0];
  const layers = [layer('Street and block edges', main?.colour || '#2b2f3a', filled.edges)];
  if (frame.neat) {
    const [x0, y0, x1, y1] = frame.neat;
    layers.push({ ...layer('Map border', main?.colour || '#2b2f3a', [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]), show: false });
  }
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
  if (gridShown.length) layers.push(layer('Grid lines', hex(inkColourAlong(grid[0], rgba, colourInk, w, h)), gridShown));
  if (routes.length) layers.push(layer('Tram routes', hex(inkColourAlong(routes[0], rgba, colourInk, w, h)), routes));
  layers.push(layer('Railways', main?.colour || '#2b2f3a', rails.concat(closeGaps(rails, 30 * k))));
  layers.push(layer('Dashed lines', main?.colour || '#2b2f3a', dashed));
  layers.push(layer('Paths through woods', main?.colour || '#2b2f3a', lightPaths(ink, fill, crop, rails, w, h, yard.lineWeight || 1.6 * k)));
  layers.push(layer('Street centres', '#b07a2a', centres, false));
  layers.push(layer('Unsure lines', '#e07b00', unsureLeft, false));
  if (dbg) Object.assign(dbg, { shapes, plain: plainLines, masked: maskedLines, fillEdges, gaps, inferred: filled.inferred });
  return { layers: layers.filter((l) => l.count), debug: dbg, yard: { ...yard, k } };
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
// How fully a patch of paper fills the rectangle round it (turned to the
// patch's own direction), and that rectangle's length and width.
function blockLike(pc, l, w, colourNear) {
  const { label } = pc, X0 = pc.x0[l], X1 = pc.x1[l], Y0 = pc.y0[l], Y1 = pc.y1[l];
  let sx = 0, sy = 0, m = 0;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (label[y * w + x] === l) { sx += x; sy += y; m++; }
  const cx = sx / m, cy = sy / m;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (label[y * w + x] === l) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (label[y * w + x] === l) {
    const a = (x - cx) * ux + (y - cy) * uy, b = -(x - cx) * uy + (y - cy) * ux;
    if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  // A symbol or a number printed inside the block is a hole in the patch,
  // not a bite out of it.
  const bw = X1 - X0 + 1, bh = Y1 - Y0 + 1, out = new Uint8Array(bw * bh), stack = [];
  const push = (x, y) => { const q = (y - Y0) * bw + x - X0; if (!out[q] && label[y * w + x] !== l) { out[q] = 1; stack.push(x, y); } };
  for (let x = X0; x <= X1; x++) { push(x, Y0); push(x, Y1); }
  for (let y = Y0; y <= Y1; y++) { push(X0, y); push(X1, y); }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x > X0) push(x - 1, y); if (x < X1) push(x + 1, y); if (y > Y0) push(x, y - 1); if (y < Y1) push(x, y + 1);
  }
  // So is a coloured symbol printed over its edge (with the soft rim round
  // it, which reads as ink).
  let filled = 0;
  const pts = [];
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
    const q = (y - Y0) * bw + x - X0;
    if (!out[q]) { filled++; pts.push([x, y]); continue; }
    if (!colourNear?.[y * w + x]) continue;
    const a = (x - cx) * ux + (y - cy) * uy, b = -(x - cx) * uy + (y - cy) * ux;
    if (a >= a0 && a <= a1 && b >= b0 && b <= b1) { filled++; pts.push([x, y]); }
  }
  return { fillRect: filled / ((a1 - a0 + 1) * (b1 - b0 + 1)), len: a1 - a0 + 1, wid: b1 - b0 + 1, cx, cy, hull: () => convexHull(pts) };
}

// The convex hull of points, as a closed ring (Andrew's monotone chain).
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const ring = lower.slice(0, -1).concat(upper.slice(0, -1));
  ring.push(ring[0]);
  return ring;
}

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
function streetCentres(space, w, h, k) {
  const m = space.slice();
  thin(m, w, h);
  const unit = 3000 * k;
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
// The edge of a coloured area (a shore) is a natural curve, so it is
// smoothed rather than squared: squaring the pixel steps of a slanting shore
// leaves a staircase. Where it wobbles along a straight printed shore, it
// takes the printed line. lw: the map's line weight.
function edgeLines(fill, crop, w, h, lw, ink) {
  const inner = erode(fill, w, h, 1);
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (fill[i] && !inner[i] && !crop[i]) edge[i] = 1; }
  thin(edge, w, h);
  return prune(traceSkeleton(edge, w, h), 4, 12).map((l) => straightenTeeth(keepFarthest(smoothLine(l, 1.5 * lw), 0.6), lw, ink, w, h)).filter((l) => lineLength(l) > 10);
}

// A line smoothed along its length (a Gaussian of width sigma pixels); the
// ends of an open line stay where they are.
function smoothLine(l, sigma) {
  const pts = [l[0]];
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i], m = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
    for (let t = 1; t <= m; t++) pts.push([ax + (bx - ax) * t / m, ay + (by - ay) * t / m]);
  }
  const n = pts.length, R = Math.ceil(3 * sigma);
  const closed = n > 2 * R && Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 1.5;
  const wt = [];
  for (let d = 0; d <= R; d++) wt.push(Math.exp(-(d * d) / (2 * sigma * sigma)));
  const m = closed ? n - 1 : n;
  const out = pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return p;
    const r = closed ? R : Math.min(R, i, n - 1 - i);
    let sx = 0, sy = 0, sw = 0;
    for (let d = -r; d <= r; d++) { const q = pts[closed ? (((i + d) % m) + m) % m : i + d], c = wt[Math.abs(d)]; sx += q[0] * c; sy += q[1] * c; sw += c; }
    return [sx / sw, sy / sw];
  });
  if (closed) out[n - 1] = out[0];
  return out;
}

// ---------- reference grid ----------

// Two ways to find the grid: (a) long runs of coloured ink lined up along
// one row or column, (b) a vote over every near-level and near-upright line
// position and angle (a Hough transform). A grid line is kept where both
// put one, then fitted through the coloured ink along it.
export function gridLines(colour, w, h, k, neat) {
  const out = [];
  for (const across of [true, false]) {
    const [len, size] = across ? [w, h] : [h, w];
    const at = across ? (a, b) => colour[b * w + a] : (a, b) => colour[a * w + b];
    // (a) Hough votes for lines within 2 degrees of level/upright.
    const angles = [];
    for (let t = -2; t <= 2.0001; t += 0.1) angles.push(t * Math.PI / 180);
    const acc = angles.map(() => new Float32Array(size + 200));
    for (let a = 0; a < len; a += 2) for (let b = 0; b < size; b++) {
      if (!at(a, b)) continue;
      angles.forEach((t, j) => { const rho = Math.round(b - (a - len / 2) * Math.tan(t)) + 100; if (rho >= 0 && rho < size + 200) acc[j][rho] += 2; });
    }
    const cand = [];
    acc.forEach((row, j) => {
      for (let i = 1; i < row.length - 1; i++) if (row[i] >= 0.08 * len && row[i] >= row[i - 1] && row[i] >= row[i + 1]) cand.push({ pos: i - 100, t: angles[j], votes: row[i] });
    });
    cand.sort((p, q) => q.votes - p.votes);
    const peaks = [];
    for (const c of cand) if (!peaks.some((p) => Math.abs(p.pos - c.pos) <= 20 * k)) peaks.push(c);
    // (b) Long straight runs of coloured ink (gaps where a street crosses
    // are bridged) lying along the line over at least half the sheet; a tram
    // route turns corners and doesn't.
    const runs = straightRuns(colour, w, h, Math.round(60 * k), across, Math.round(14 * k)).filter((s) => s[3] <= 8 * k + 3);
    const lined = peaks.filter((p) => {
      let lo = len, hi = 0, cover = 0;
      for (const [a0, a1, mid] of runs) {
        const am = (a0 + a1) / 2, c = p.pos + (am - len / 2) * Math.tan(p.t);
        if (Math.abs(mid - c) > 4 * k) continue;
        cover += a1 - a0; lo = Math.min(lo, a0); hi = Math.max(hi, a1);
      }
      return cover > 0.12 * len && hi - lo > 0.2 * len;
    });
    // (c) Grid lines are evenly spaced. The spacing comes from lines both
    // (a) and (b) are sure of; a line is kept when two of the three agree.
    const voted = (p) => p.votes >= 0.25 * len;
    const sure = peaks.filter((p) => voted(p) && lined.includes(p)).map((p) => p.pos).sort((p, q) => p - q);
    const gaps = [];
    for (let i = 1; i < sure.length; i++) gaps.push(sure[i] - sure[i - 1]);
    let step = 0, best = 0;
    for (const g of gaps) { const m = gaps.filter((q) => Math.abs(q / g - Math.round(q / g)) * g <= 10 * k).length; if (m > best && g > 50 * k) { best = m; step = g; } }
    const even = (p) => step > 0 && sure.length >= 2 && sure.some((q) => Math.abs(q - p.pos) > step / 2 && Math.abs(Math.abs(q - p.pos) / step - Math.round(Math.abs(q - p.pos) / step)) * step <= 8 * k);
    const fits = [];
    const nearBorder = (pos) => neat && (across ? pos < neat[1] + 15 * k || pos > neat[3] - 15 * k : pos < neat[0] + 15 * k || pos > neat[2] - 15 * k);
    for (const b of peaks) {
      if (voted(b) + lined.includes(b) + even(b) < 2 || nearBorder(b.pos)) continue;
      // Fit position and slope through the coloured ink near the agreed line.
      let sa = 0, sb = 0, saa = 0, sab = 0, m = 0, lo = len, hi = 0;
      for (let a = 0; a < len; a++) {
        const centre = b.pos + (a - len / 2) * Math.tan(b.t);
        for (let d = -Math.round(5 * k); d <= Math.round(5 * k); d++) {
          const bb = Math.round(centre + d);
          if (bb < 0 || bb >= size || !at(a, bb)) continue;
          sa += a; sb += bb; saa += a * a; sab += a * bb; m++; lo = Math.min(lo, a); hi = Math.max(hi, a);
        }
      }
      if (m < 10) continue;
      const slope = (m * sab - sa * sb) / (m * saa - sa * sa || 1), icpt = (sb - slope * sa) / m;
      fits.push({ slope, icpt, lo, hi });
    }
    // All grid lines run (nearly) the same way: drop any at odds with the rest.
    const slopes = fits.map((f) => f.slope).sort((p, q) => p - q), mid = slopes[Math.floor(slopes.length / 2)];
    for (const { slope, icpt, lo, hi } of fits) {
      if (Math.abs(slope - mid) > 0.006) continue;
      // Run it across the map inside the border, or over the ink it covers.
      const a0 = neat ? (across ? neat[0] : neat[1]) : lo, a1 = neat ? (across ? neat[2] : neat[3]) : hi;
      const p0 = [a0, icpt + slope * a0], p1 = [a1, icpt + slope * a1];
      out.push(across ? [p0, p1] : [[p0[1], p0[0]], [p1[1], p1[0]]]);
    }
  }
  return out;
}

// Dashed street edges the tracers followed as if solid. Each line is split
// into straight runs, and each run's ink is read along it: a dashed line
// dips to paper briefly and evenly (short gaps between ink at least as
// long), where a solid line stays dark, and a line just off its ink fades
// for long stretches instead. A run is taken as dashed when it dips like
// that and either does so many times, evenly, or has another such run close
// by (dashed streets come in families; a lettering stroke that happens to
// dip is usually alone). Dashed runs leave the line as straight lines of
// their own. Returns { solid, dashed }.
function dashedRuns(lines, img, w, h, k) {
  const dark = (x, y) => { const i = idx(x, y, w, h), xi = i % w; return 1 - img.gray[i] / Math.max(1, paperAt(img, xi, (i - xi) / w)); };
  const runsOf = (l) => {
    const out = [];
    let from = 0;
    for (let i = 1; i < l.length - 1; i++) if (bend(l[i - 1], l[i], l[i + 1]) > Math.PI / 6) { out.push([from, i]); from = i; }
    out.push([from, l.length - 1]);
    return out;
  };
  const dips = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let best = null, bestMean = -1;
    for (let off = -3; off <= 3; off += 0.5) {
      const prof = [];
      for (let t = 0; t <= len; t++) {
        let m = 0;
        for (let o = off - 1; o <= off + 1; o += 0.5) m = Math.max(m, dark(a[0] + ux * t - uy * o, a[1] + uy * t + ux * o));
        prof.push(m);
      }
      const mean = prof.reduce((s, v) => s + v, 0) / prof.length;
      if (mean > bestMean) { bestMean = mean; best = prof; }
    }
    const runs = [];
    for (let i = 0; i < best.length; ) { let j = i; const on = best[i] > 0.25; while (j < best.length && (best[j] > 0.25) === on) j++; runs.push([on, i, j]); i = j; }
    const at = [];
    for (let q = 1; q < runs.length - 1; q++) { const [on, i, j] = runs[q]; if (!on && j - i <= 5 && runs[q - 1][2] - runs[q - 1][1] >= 3 && runs[q + 1][2] - runs[q + 1][1] >= 3) at.push((i + j) / 2); }
    const gaps = at.slice(1).map((v, i) => v - at[i]), mean = gaps.reduce((s, v) => s + v, 0) / (gaps.length || 1);
    const spread = gaps.length > 1 ? Math.sqrt(gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length) / mean : 9;
    return { count: at.length, per100: (100 * at.length) / len, spread };
  };
  const cand = [];
  lines.forEach((l, li) => {
    for (const [i, j] of runsOf(l)) {
      const a = l[i], b = l[j];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 25 * k) continue;
      const d = dips(a, b);
      if (d.count >= 2 && d.per100 >= 3.5 && (d.count < 3 || d.spread < 0.5)) cand.push({ li, i, j, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ends: [a, b], strong: d.count >= 4 && d.spread < 0.3 });
    }
  });
  const near = (p, q) => q.ends.some((e) => p.ends.some((f) => Math.hypot(e[0] - f[0], e[1] - f[1]) < 30 * k)) || Math.hypot(p.mid[0] - q.mid[0], p.mid[1] - q.mid[1]) < 30 * k;
  const chosen = cand.filter((p) => p.strong || cand.some((q) => q !== p && near(p, q)));
  const cut = new Map();
  for (const c of chosen) { if (!cut.has(c.li)) cut.set(c.li, []); cut.get(c.li).push([c.i, c.j]); }
  const solid = [], dashed = chosen.map((c) => c.ends);
  lines.forEach((l, li) => {
    const cs = cut.get(li);
    if (!cs) { solid.push(l); return; }
    cs.sort((p, q) => p[0] - q[0]);
    let from = 0;
    for (const [i, j] of cs) { if (i > from) solid.push(l.slice(from, i + 1)); from = j; }
    if (from < l.length - 1) solid.push(l.slice(from));
  });
  return { solid, dashed };
}

// The street edges a tram route hides. A route runs down the middle of its
// street, so the street's edges are the route moved about half a street
// width to either side. routeSides splits each route into straight
// stretches and finds, for each side, how far out the edge is: where the
// edge's ink and the lines found line up best, within reason of half a
// street width ("sure" when they line up along a good part of it).
function routeSides(routes, strong, known, W, w, h, k) {
  const strongNear = dilate(strong, w, h, 1), knownNear = dilate(rasterise(known, w, h), w, h, 2), step = 2;
  const stretches = [];
  for (const route of routes) {
    const runs = simplify(route, 2 * k);
    for (let s = 1; s < runs.length; s++) {
      const a = runs[s - 1], b = runs[s], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 15 * k) continue;
      const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len, ts = [];
      for (let t = 0; t <= len; t += step) ts.push(t);
      const st = { a, ux, uy, ts, sides: [] };
      for (const sg of [1, -1]) {
        const at = (t, d) => idx(a[0] + ux * t - sg * uy * d, a[1] + uy * t + sg * ux * d, w, h);
        const count = (m, d) => ts.reduce((c, t) => c + m[at(t, d)], 0);
        let d = W / 2, best = 0;
        for (let dd = Math.max(2, 0.3 * W); dd <= 0.75 * W; dd += 0.5) { const c = count(strongNear, dd) + count(knownNear, dd); if (c > best) { best = c; d = dd; } }
        const sure = best >= 0.4 * ts.length;
        st.sides.push({ sg, at, d: sure ? d : W / 2, sure, lined: count(knownNear, d) >= 0.2 * ts.length ? 1 : 0 });
      }
      stretches.push(st);
    }
  }
  return stretches;
}

// Where each sure side's edge would run, the whole stretch long.
function sideLines(stretches) {
  const out = [];
  for (const { a, ux, uy, ts, sides } of stretches) for (const { sg, d, sure } of sides) {
    if (!sure) continue;
    const t1 = ts[ts.length - 1];
    out.push([[a[0] - sg * uy * d, a[1] + sg * ux * d], [a[0] + ux * t1 - sg * uy * d, a[1] + uy * t1 + sg * ux * d]]);
  }
  return out;
}

// Three judges then look along each side of each stretch: the edge's ink
// peeking out past the route, a block on the far side, and lines already
// found lying on that offset. A stretch is drawn where two agree and no line
// runs yet, as a straight run. Lines found in the street between a
// stretch's two edges (scraps of the route's badges and arrows) are taken
// out first. Returns { edges, lines, junk }.
function routeEdges({ stretches, strong, blocks, edges, known, w, h, k }) {
  const strongNear = dilate(strong, w, h, 1), r2 = Math.max(2, Math.round(2 * k));
  let knownMask = rasterise(known, w, h);
  // Scraps in the street: found lines lying between a stretch's two edges
  // (pieces of the route's badges and arrows, or lettering).
  const band = new Uint8Array(w * h);
  for (const { a, ux, uy, ts, sides } of stretches) {
    if (!sides.every((sd) => sd.sure)) continue;
    const t1 = ts[ts.length - 1];
    for (let o = -(sides[1].d - 1.5); o <= sides[0].d - 1.5; o += 0.5) drawLine(band, [[a[0] - uy * o, a[1] + ux * o], [a[0] + ux * t1 - uy * o, a[1] + uy * t1 + ux * o]], w, h);
  }
  const piece = 4 * k, kept = [], junk = [];
  for (const line of edges) {
    const total = lineLength(line), pieces = Math.max(1, Math.round(total / piece));
    let start = 0, bad = null;
    for (let p = 0; p <= pieces; p++) {
      let isJunk = false;
      if (p < pieces) {
        const pts = samplePath(line, (p * total) / pieces, ((p + 1) * total) / pieces, 1);
        isJunk = pts.reduce((c, [x, y]) => c + band[idx(x, y, w, h)], 0) >= 0.8 * pts.length;
      }
      if (p === pieces || isJunk !== bad) {
        if (bad !== null && p > start) (bad ? junk : kept).push(subPath(line, (start * total) / pieces, (p * total) / pieces));
        start = p; bad = isJunk;
      }
    }
  }
  if (junk.length) knownMask = rasterise(kept.concat(known.filter((l) => !edges.includes(l))), w, h);
  const knownHere = dilate(knownMask, w, h, r2);
  // Each side: the edge's ink peeking out past the route, a block on the far
  // side, and found lines on the same offset. Drawn where two agree.
  const lines = [];
  for (const { a, ux, uy, ts, sides } of stretches) for (const { sg, at, d, lined } of sides) {
    const vote = ts.map((t) => !knownHere[at(t, d)] && strongNear[at(t, d)] + (blocks[at(t, d + 4 * k)] && blocks[at(t, d + 8 * k)]) + lined >= 2);
    for (let i = 0; i < vote.length; ) {
      if (!vote[i]) { i++; continue; }
      let j = i;
      while (j + 1 < vote.length && (vote[j + 1] || (j + 2 < vote.length && vote[j + 2]))) j++;
      if (ts[j] - ts[i] >= 6 * k) {
        const p = (t) => [a[0] + ux * t - sg * uy * d, a[1] + uy * t + sg * ux * d];
        lines.push([p(ts[i]), p(ts[j])]);
      }
      i = j + 1;
    }
  }
  return { edges: kept.filter((l) => lineLength(l) > 1), lines, junk };
}

// Coloured lines other than the grid, traced as joined lines.
function routeLines(colour, A, B, gridBand, crop, water, w, h, k) {
  const n = w * h;
  // Routes are printed in the grid's ink; other second-colour ink (specks
  // of darker water) is a different hue.
  const ga = [], gb = [];
  for (let i = 0; i < n; i += 3) if (colour[i] && gridBand[i] && !water[i]) { ga.push(A[i]); gb.push(B[i]); }
  const med = (v) => v.sort((x, y) => x - y)[v.length >> 1] ?? 0, gA = med(ga), gB = med(gb);
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = colour[i] && !gridBand[i] && !crop[i] && (!ga.length || Math.hypot(A[i] - gA, B[i] - gB) < 30) ? 1 : 0;
  // Route stroke: what's left once solid symbols (red diamonds, number
  // badges, both solid once their lettering is closed over) are taken out.
  const stroke = m.slice(), r2 = Math.max(1, Math.round(2 * k));
  const solid = dilate(open(close(m, w, h, r2), w, h, Math.max(2, Math.round(4 * k))), w, h, r2);
  for (let i = 0; i < n; i++) if (solid[i]) stroke[i] = 0;
  // Close badges (a ring round a number) and a crossing street's gap, then
  // keep only pieces with a good length of route stroke in them, so a run of
  // badges stays but a cluster of diamonds goes.
  m = close(m, w, h, Math.max(2, Math.round(5 * k)));
  const c = components(m, w, h, true), strokePx = new Float64Array(c.count + 1);
  for (let i = 0; i < n; i++) if (stroke[i] && c.label[i]) strokePx[c.label[i]]++;
  for (let i = 0; i < n; i++) { const l = c.label[i]; if (l && (strokePx[l] < 80 * k || Math.max(c.x1[l] - c.x0[l], c.y1[l] - c.y0[l]) < 60 * k)) m[i] = 0; }
  thin(m, w, h);
  let lines = prune(traceSkeleton(m, w, h), 12 * k, 30 * k).map((l) => simplify(l, 1.2)).filter((l) => lineLength(l) > 25 * k && meanAlong(l, water, w, h) < 0.5);
  lines = lines.concat(closeGaps(lines, 30 * k));
  return joinEnds(lines);
}

// The parts of a line outside a mask, as lines of at least minLen.
function splitOff(l, mask, w, h, minLen) {
  const total = lineLength(l), step = 2, out = [];
  const pts = samplePath(l, 0, total, step);
  let start = -1;
  for (let i = 0; i <= pts.length; i++) {
    const inside = i === pts.length || mask[idx(pts[i][0], pts[i][1], w, h)];
    if (!inside && start < 0) start = i;
    if (inside && start >= 0) { const piece = subPath(l, start * step, Math.min(total, i * step)); if (lineLength(piece) >= minLen) out.push(piece); start = -1; }
  }
  return out;
}

// ---------- pictures on the water ----------

function hasLandNeighbour(land, i, w, h) {
  const x = i % w, y = (i - x) / w;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx >= 0 && yy >= 0 && xx < w && yy < h && land[yy * w + xx]) return true;
  }
  return false;
}

// Holes in the water that are drawings (sails with rigging drawn on them)
// become water. An island's paper is plain inside its shoreline.
function sailsToWater(fill, ink, w, h, k) {
  const dry = new Uint8Array(w * h);
  for (let i = 0; i < dry.length; i++) dry[i] = fill[i] ? 0 : 1;
  const c = components(dry, w, h, false);
  const inner = erode(dry, w, h, 3);
  const inkN = new Uint32Array(c.count + 1), innerInk = new Uint32Array(c.count + 1);
  for (let i = 0; i < dry.length; i++) { const l = c.label[i]; if (l && ink[i]) { inkN[l]++; if (inner[i]) innerInk[l]++; } }
  for (let l = 1; l <= c.count; l++) {
    if (!c.x0[l] || !c.y0[l] || c.x1[l] === w - 1 || c.y1[l] === h - 1) continue;
    if (c.area[l] < 300 * k * k || c.area[l] > 0.003 * w * h) continue;
    if (inkN[l] / c.area[l] < 0.15 || innerInk[l] / (inkN[l] || 1) < 0.3) continue;
    for (let y = c.y0[l]; y <= c.y1[l]; y++) for (let x = c.x0[l]; x <= c.x1[l]; x++) if (c.label[y * w + x] === l) fill[y * w + x] = 1;
  }
}

// ---------- border and boxes ----------

// Long straight lines, found as runs of ink (a pixel either side counts, so
// a line a little off level still runs on), joined across rows into lines.
export function straightRuns(ink, w, h, minLen, across, maxGap = 0) {
  const [len, lines] = across ? [w, h] : [h, w];
  const at = across ? (a, b) => ink[b * w + a] : (a, b) => ink[a * w + b];
  const segs = [], open = new Map();
  for (let b = 0; b < lines; b++) {
    const runs = [];
    let start = -1, last = -1;
    for (let a = 0; a <= len; a++) {
      const on = a < len && (at(a, b) || (b > 0 && at(a, b - 1)) || (b < lines - 1 && at(a, b + 1)));
      if (on) { if (start < 0) start = a; last = a; }
      // A gap up to maxGap (a street crossing over the line) doesn't end the run.
      else if (start >= 0 && (a - last > maxGap || a === len)) { if (last - start + 1 >= minLen) runs.push([start, last]); start = -1; }
    }
    const next = new Map();
    for (const [a0, a1] of runs) {
      let seg = null;
      for (const [key, s] of open) if (s.a0 < a1 && a0 < s.a1 && !seg) { seg = s; open.delete(key); }
      if (!seg) { seg = { a0, a1, b0: b, b1: b }; segs.push(seg); }
      seg.a0 = Math.min(seg.a0, a0); seg.a1 = Math.max(seg.a1, a1); seg.b1 = b;
      next.set(seg, seg);
    }
    open.clear();
    for (const s of next.values()) open.set(s, s);
  }
  // [start, end, middle across, thickness]
  return segs.map((s) => [s.a0, s.a1, (s.b0 + s.b1) / 2, s.b1 - s.b0 + 1]);
}

// The map's border (the innermost long line near each edge of the sheet)
// and boxes drawn with four straight sides and little ink inside (a title, a
// legend): many small marks of print inside, and not in among city blocks,
// which are boxes of four straight sides too. Returns a mask of what's
// outside the border or in a box.
export function framesAndBoxes(ink, w, h, k, isBlock) {
  const minLen = Math.round(100 * k), tol = 10 * k;
  const c = components(ink, w, h, true);
  const H = straightRuns(ink, w, h, minLen, true).filter((s) => s[3] <= 40 * k);
  // Box sides are as short as the box is tall.
  const V = straightRuns(ink, w, h, Math.round(30 * k), false).filter((s) => s[3] <= 40 * k);
  const edge = 0.08;
  // The border is often a band of lines; its inner edge counts.
  const pick = (segs, size, along, near) => segs.filter((s) => s[1] - s[0] > 0.5 * along && (near ? s[2] < edge * size : s[2] > (1 - edge) * size)).map((s) => s[2] + (near ? 1 : -1) * s[3] / 2);
  const top = pick(H, h, w, true), bottom = pick(H, h, w, false), left = pick(V, w, h, true), right = pick(V, w, h, false);
  const neat = top.length && bottom.length && left.length && right.length ? [Math.max(...left), Math.max(...top), Math.min(...right), Math.min(...bottom)] : null;
  const boxes = [];
  for (const [ax0, ax1, ay] of H) for (const [bx0, bx1, by] of H) {
    if (by <= ay + 30 * k) continue;
    const x0 = Math.max(ax0, bx0), x1 = Math.min(ax1, bx1);
    if (x1 - x0 < 0.8 * Math.max(ax1 - ax0, bx1 - bx0)) continue;
    const l = Math.min(ax0, bx0), r = Math.max(ax1, bx1);
    // A side may be in several pieces where lettering touches it.
    const side = (x) => {
      const span = V.filter(([vy0, vy1, vx]) => Math.abs(vx - x) <= 1.5 * tol && vy1 > ay && vy0 < by).map(([vy0, vy1]) => [Math.max(ay, vy0), Math.min(by, vy1)]).sort((p, q) => p[0] - q[0]);
      let covered = 0, end = ay;
      for (const [a, b] of span) { if (b > end) { covered += b - Math.max(a, end); end = b; } }
      return covered >= 0.9 * (by - ay);
    };
    if (!side(l) || !side(r)) continue;
    const area = (r - l) * (by - ay);
    if (area < 2000 * k * k || area > 0.2 * w * h) continue;
    if (neat && l <= neat[0] + tol && r >= neat[2] - tol) continue;
    // Dense woods also have straight edges; a box is mostly paper inside.
    let inkIn = 0, m = 0;
    for (let y = Math.round(ay); y < by; y += 3) for (let x = l; x < r; x += 3) { inkIn += ink[y * w + x]; m++; }
    if (inkIn / m > 0.4) continue;
    let marks = 0;
    for (let q = 1; q <= c.count; q++) {
      const cx = (c.x0[q] + c.x1[q]) / 2, cy = (c.y0[q] + c.y1[q]) / 2;
      if (cx > l && cx < r && cy > ay && cy < by && c.area[q] >= 4 && Math.max(c.x1[q] - c.x0[q], c.y1[q] - c.y0[q]) < 30 * k) marks++;
    }
    if (area / marks > 3500 * k * k) continue;
    let around = 0, ring = 0;
    const d = Math.round(25 * k);
    for (let y = Math.max(0, Math.round(ay) - d); y < Math.min(h, by + d); y += 2) for (let x = Math.max(0, l - d); x < Math.min(w, r + d); x += 2) {
      if (x >= l - 8 * k && x <= r + 8 * k && y >= ay - 8 * k && y <= by + 8 * k) continue;
      ring++; if (isBlock(y * w + x)) around++;
    }
    if (around / (ring || 1) > 0.15) continue;
    if (!boxes.some((b) => Math.abs(b[0] - l) < 20 * k && Math.abs(b[1] - ay) < 20 * k && Math.abs(b[2] - r) < 20 * k && Math.abs(b[3] - by) < 20 * k)) boxes.push([l, Math.round(ay), r, Math.round(by)]);
  }
  const crop = new Uint8Array(w * h), pad = Math.round(6 * k);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const out = neat && (x < neat[0] + pad || y < neat[1] + pad || x > neat[2] - pad || y > neat[3] - pad);
    const inBox = boxes.some(([x0, y0, x1, y1]) => x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad);
    if (out || inBox) crop[y * w + x] = 1;
  }
  return { crop, neat, boxes };
}

// ---------- hill shading ----------

// Hatching is drawn as short arcs, wider than tall, scattered over an area.
// Each such mark with at least 8 others round it, spread in both directions
// rather than along a line, marks a disc of hatching.
export function hatching(ink, w, h, k) {
  // Tuned on the 3,500-pixel Halifax scan.
  k *= 3000 / 3500;
  const c = components(ink, w, h, true);
  const n = c.count + 1;
  const sx = new Float64Array(n), sy = new Float64Array(n), sxx = new Float64Array(n), syy = new Float64Array(n), sxy = new Float64Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = c.label[y * w + x];
    if (!l) continue;
    sx[l] += x; sy[l] += y; sxx[l] += x * x; syy[l] += y * y; sxy[l] += x * y;
  }
  // Ink that is part of a long printed line (a street edge, a shore).
  const longInk = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const l = c.label[i]; if (l && Math.max(c.x1[l] - c.x0[l], c.y1[l] - c.y0[l]) + 1 >= 150 * k) longInk[i] = 1; }
  // Loose marks: small, wider than tall. Sure marks also bend (a dash is a
  // straight bar; an arc's pixels spread across its length as well as
  // along it) and aren't tiny.
  const marks = [], sure = [];
  for (let l = 1; l < n; l++) {
    const a = c.area[l], bw = c.x1[l] - c.x0[l] + 1, bh = c.y1[l] - c.y0[l] + 1;
    if (Math.max(bw, bh) < 4 * k || Math.max(bw, bh) >= 45 * k || a < 6 * k * k || bw / bh <= 1.3 || bh > 9 * k || a / (bw * bh) >= 0.7) continue;
    const mx = sx[l] / a, my = sy[l] / a;
    const [lo] = eigen2(sxx[l] / a - mx * mx, syy[l] / a - my * my, sxy[l] / a - mx * my);
    marks.push([mx, my]);
    sure.push(lo > 0.5 * k * k && Math.max(bw, bh) >= 7 * k);
  }
  const R = 40 * k, cell = Math.ceil(R), gw = Math.ceil(w / cell) + 1;
  const grid = new Map();
  marks.forEach(([x, y], i) => { const key = Math.floor(y / cell) * gw + Math.floor(x / cell); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(i); });
  const out = new Uint8Array(w * h), disc = 26 * k;
  marks.forEach(([x, y], i) => {
    if (!sure[i]) return;
    const near = [];
    let sureNear = 0;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get((cy + dy) * gw + cx + dx) || []) {
      if (Math.hypot(marks[j][0] - x, marks[j][1] - y) <= R) { near.push(marks[j]); if (sure[j]) sureNear++; }
    }
    if (near.length < 8 || sureNear < 4) return;
    let mx = 0, my = 0;
    for (const [px, py] of near) { mx += px; my += py; }
    mx /= near.length; my /= near.length;
    let vx = 0, vy = 0, cv = 0;
    for (const [px, py] of near) { vx += (px - mx) ** 2; vy += (py - my) ** 2; cv += (px - mx) * (py - my); }
    const [lo, hi] = eigen2(vx, vy, cv);
    if (lo / (hi || 1) <= 0.25) return;
    for (let yy = Math.max(0, Math.floor(y - disc)); yy <= Math.min(h - 1, y + disc); yy++) for (let xx = Math.max(0, Math.floor(x - disc)); xx <= Math.min(w - 1, x + disc); xx++) {
      if ((xx - x) ** 2 + (yy - y) ** 2 <= disc * disc) out[yy * w + xx] = 1;
    }
  });
  return { texture: out, longInk: dilate(longInk, w, h, 2) };
}

// Splits an outline where it zigzags through hatching (corners closer than
// 8 px apart on average over 40 px), keeping the rest as open lines.
function cutJagged(p, texture, w, h, k) {
  const n = p.length, along = [0];
  for (let i = 1; i < n; i++) along.push(along[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const bad = p.map(([x, y], i) => {
    if (!texture[idx(x, y, w, h)]) return false;
    let m = 0;
    for (let j = 0; j < n; j++) if (Math.abs(along[j] - along[i]) <= 20 * k) m++;
    return m >= 5;
  });
  if (!bad.some(Boolean)) return [p];
  const out = [];
  let run = [];
  for (let i = 0; i < n; i++) {
    if (bad[i]) { if (run.length > 1) out.push(run); run = []; } else run.push(p[i]);
  }
  if (run.length > 1) out.push(run);
  // The outline is closed: join the last run onto the first.
  if (!bad[0] && !bad[n - 1] && out.length > 1) { const last = out.pop(); out[0] = last.concat(out[0].slice(1)); }
  return out.filter((l) => lineLength(l) > 10 * k);
}

// Eigenvalues of [[a, c], [c, b]], smaller first.
function eigen2(a, b, c) {
  const m = (a + b) / 2, d = Math.sqrt(Math.max(0, ((a - b) / 2) ** 2 + c * c));
  return [m - d, m + d];
}

// Corners per 100 px of outline: a few for a block, dozens for a scribble.
function turnsPer100(p) {
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return (p.length / (len || 1)) * 100;
}

// ---------- railways and dashes ----------

// Railways are drawn as heavy bands (a line with cross ticks), several times
// wider than a street line. Keep only the ink that survives shrinking by two
// pixels, trace what's left, and keep the long smooth runs. Shorelines drawn
// heavy are left to the water edge, and frames round boxes of print are skipped.
// Railways drawn as a line with ticks across it, or as a ladder (two rails
// with rungs between): closed up, they make a band a few line weights wide.
// A band is a railway when, along both its sides, the ink comes and goes at
// a steady beat (the ticks) while its middle (the line) or its two edges
// (the rails) run unbroken. Tree rows and lettering close up into bands too,
// but don't have both. lw: the map's line weight.
function tickedLines(ink, crop, w, h, k, lw, inMargin) {
  const n = w * h, gap = Math.max(2, Math.round(1.6 * lw));
  const closed = close(ink, w, h, gap);
  const depth = chamfer(closed, w, h), R = Math.max(1.5, 1.2 * lw);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = depth[i] >= R ? 0 : 1;
  const back = chamfer(outside, w, h), cropNear = dilate(crop, w, h, Math.round(15 * k));
  const band = new Uint8Array(n);
  for (let i = 0; i < n; i++) band[i] = back[i] <= R + 0.5 && !cropNear[i] ? 1 : 0;
  thin(band, w, h);
  const at = (m, x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h ? m[yi * w + xi] : 0; };
  const out = [];
  for (const raw of prune(traceSkeleton(band, w, h), 10 * k, 30 * k)) {
    const l = keepFarthest(raw, 1.5), len = lineLength(l);
    if (len < 40 * lw || l.filter(inMargin).length > l.length / 2) continue;
    // Along the traced pixels, with the way across (from a few pixels
    // either side, so the steps of a slanting line don't jiggle it).
    const pts = raw.map(([x, y], i) => {
      const [ax, ay] = raw[Math.max(0, i - 4)], [bx, by] = raw[Math.min(raw.length - 1, i + 4)], L = Math.hypot(bx - ax, by - ay) || 1;
      return [x, y, -(by - ay) / L, (bx - ax) / L];
    });
    // Across the band at each point: where its middle is (the traced line
    // can sit off to one side) and half its width.
    const across = pts.map(([x, y, nx, ny]) => {
      const walk = (sg) => { let d = 0; while (d < 12 * lw && at(closed, x + sg * nx * (d + 1), y + sg * ny * (d + 1))) d++; return d; };
      const dl = walk(-1), dr = walk(1);
      return [(dr - dl) / 2, (dl + dr + 1) / 2];
    });
    const halves = across.map((c) => c[1]).sort((a, b) => a - b), H = halves[halves.length >> 1];
    if (H < 1.2 * lw) continue;
    // Ink along the band at a fraction f of its half-width out from its
    // middle (plus `off` pixels), going by the band's width at each point.
    const along = (f, off = 0) => pts.map(([x, y, nx, ny], i) => { const o = across[i][0] + f * across[i][1] + off; return at(ink, x + nx * o, y + ny * o); });
    const steady = (p) => {
      const starts = [];
      let on = 0;
      for (let i = 0; i < p.length; i++) { if (p[i]) on++; if (p[i] && (i === 0 || !p[i - 1])) starts.push(i); }
      const share = on / p.length;
      // Ticks are thin next to the gaps between them; letters crowd closer.
      if (starts.length < 6 || share < 0.12 || share > 0.55) return false;
      const gaps = starts.slice(1).map((v, i) => v - starts[i]).sort((a, b) => a - b);
      // The beat: the middle gaps, without the odd skipped or doubled tick.
      const mid = gaps.slice(Math.floor(gaps.length * 0.15), Math.ceil(gaps.length * 0.85));
      const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
      const sd = Math.sqrt(mid.reduce((a, b) => a + (b - mean) ** 2, 0) / mid.length);
      return mean >= 2 && mean <= 12 * lw && sd <= 0.3 * mean && starts.length >= 0.6 * p.length / mean;
    };
    const full = (p) => p.reduce((a, b) => a + b, 0) >= 0.85 * p.length;
    // Ticks across a line: steady beat either side of an unbroken middle.
    // A ladder: an unbroken rail along each edge, steady rungs between.
    const ticks = full(along(0)) && steady(along(0.6)) && steady(along(-0.6));
    const rail = (sg) => [0.4, 0.8, 1.2].some((d) => full(along(sg, -sg * d * lw)));
    const ladder = rail(1) && rail(-1) && steady(along(0));
    if (ticks || ladder) out.push(l);
  }
  return out;
}

// Douglas-Peucker on its own: the points that keep the line within tol of
// the traced pixels, without the corner squaring and smoothing simplify()
// adds (which pulls a gentle bend off the line).
function keepFarthest(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1, dist = 0;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len; if (d > dist) { dist = d; worst = i; } }
    if (dist > tol) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

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
// end to end; four or more in a row make a dashed line. A dashed outline
// turns its corners with a bent dash (an L), which carries the chain round.
function dashedLines(ink, skip, w, h, k, inMargin) {
  const n = w * h;
  const seen = new Uint8Array(n), stack = new Int32Array(n);
  const dashes = [], maxWid = Math.max(2.5, 3.5 * k);
  for (let s = 0; s < n; s++) {
    if (!ink[s] || seen[s]) continue;
    let top = 0, m = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    const px = [];
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const i = stack[--top], x = i % w, y = (i - x) / w;
      m++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (px.length < 2000) px.push(i);
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
    if (skip(Math.round(my) * w + Math.round(mx)) || inMargin([mx, my])) continue;
    const disc = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy * cxy));
    const len = Math.sqrt(12 * ((cxx + cyy) / 2 + disc)), wid = Math.sqrt(12 * Math.max(0, (cxx + cyy) / 2 - disc)) || 1;
    if (len >= 2.5 * wid && wid <= maxWid) {
      const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy), d = [Math.cos(th), Math.sin(th)];
      const ends = [[mx - (d[0] * len) / 2, my - (d[1] * len) / 2], [mx + (d[0] * len) / 2, my + (d[1] * len) / 2]];
      dashes.push({ d, len, ends, out: [[-d[0], -d[1]], d], path: ends });
      continue;
    }
    // A bent dash: two thin arms meeting near a right angle.
    const P = px.map((i) => [i % w, (i - (i % w)) / w]);
    const farFrom = ([ax, ay]) => P.reduce((b, p) => ((p[0] - ax) ** 2 + (p[1] - ay) ** 2 > (b[0] - ax) ** 2 + (b[1] - ay) ** 2 ? p : b), P[0]);
    const e1 = farFrom([mx, my]), e2 = farFrom(e1), L12 = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]) || 1;
    const c = P.reduce((b, p) => {
      const dp = Math.abs((e2[0] - e1[0]) * (e1[1] - p[1]) - (e1[0] - p[0]) * (e2[1] - e1[1])), db = Math.abs((e2[0] - e1[0]) * (e1[1] - b[1]) - (e1[0] - b[0]) * (e2[1] - e1[1]));
      return dp > db ? p : b;
    }, P[0]);
    const a1 = Math.hypot(e1[0] - c[0], e1[1] - c[1]), a2 = Math.hypot(e2[0] - c[0], e2[1] - c[1]);
    const thick = m / (a1 + a2 + 1);
    const turn = ((e1[0] - c[0]) * (e2[0] - c[0]) + (e1[1] - c[1]) * (e2[1] - c[1])) / (a1 * a2 || 1);
    if (thick > maxWid || Math.min(a1, a2) < 2.5 * thick || Math.abs(turn) > 0.5 || L12 < 3 * thick) continue;
    const o1 = [(e1[0] - c[0]) / a1, (e1[1] - c[1]) / a1], o2 = [(e2[0] - c[0]) / a2, (e2[1] - c[1]) / a2];
    dashes.push({ d: null, len: Math.max(a1, a2), ends: [e1, e2], out: [o1, o2], path: [e1, c, e2], bent: true });
  }
  // Pair up dash ends that face each other across a short gap, closest first.
  const cell = 16 * k, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  dashes.forEach((q, i) => q.ends.forEach((e, s) => { const kk = key(e[0], e[1]); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push([i, s]); }));
  const cos = (a, b) => a[0] * b[0] + a[1] * b[1], c20 = Math.cos(Math.PI / 9), c25 = Math.cos((25 * Math.PI) / 180);
  const pairs = [];
  dashes.forEach((q, i) => q.ends.forEach((e, s) => {
    const outward = q.out[s];
    const cx = Math.floor(e[0] / cell), cy = Math.floor(e[1] / cell);
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) for (const [j, t] of grid.get(`${gx},${gy}`) || []) {
      if (j <= i) continue;
      const p = dashes[j], f = p.ends[t];
      const vx = f[0] - e[0], vy = f[1] - e[1], dist = Math.hypot(vx, vy);
      if (dist < 0.5 || dist > Math.max(3, Math.min(14 * k, 1.5 * Math.max(q.len, p.len)))) continue;
      const inward = [-p.out[t][0], -p.out[t][1]];
      if (cos([vx / dist, vy / dist], outward) < c25 || cos(outward, inward) < c20) continue;
      pairs.push({ dist, a: [i, s], b: [j, t] });
    }
  }));
  pairs.sort((p, q) => p.dist - q.dist);
  const link = dashes.map(() => [null, null]);
  for (const { a, b } of pairs) {
    if (link[a[0]][a[1]] || link[b[0]][b[1]]) continue;
    link[a[0]][a[1]] = b; link[b[0]][b[1]] = a;
  }
  // Walk each chain from one end. Four straight dashes in a row make a
  // dashed line, or three turning a corner; bent dashes alone don't, so a
  // few strokes of lettering can't make a chain on their own.
  const used = new Uint8Array(dashes.length), out = [];
  for (let i = 0; i < dashes.length; i++) {
    if (used[i]) continue;
    let cur = i, side = 0;
    for (let guard = 0; link[cur][side] && guard < dashes.length; guard++) { const [j, t] = link[cur][side]; if (j === i) break; cur = j; side = 1 - t; }
    const chain = [];
    let straight = 0, bent = 0;
    for (let guard = 0; cur != null && !used[cur] && guard < dashes.length; guard++) {
      used[cur] = 1;
      const q = dashes[cur];
      if (q.bent) bent++; else straight++;
      chain.push(...(side ? q.path.slice().reverse() : q.path));
      const next = link[cur][1 - side];
      if (!next) break;
      [cur, side] = next;
    }
    if (straight >= 4 || (straight >= 3 && bent)) out.push(chain);
  }
  return out;
}

// Paths through woods: in a park drawn as dense hatching, the paths are
// the paper left showing, as lines a few line weights wide winding through
// the ink. Woods are where ink covers most of the ground round about; the
// paper in them, less the specks between strokes, is thinned to its middle,
// and the long runs kept. lw: the map's line weight.
function lightPaths(ink, fill, crop, rails, w, h, lw) {
  const n = w * h, R = Math.max(2, Math.round(6 * lw));
  // Ink cover round each pixel, from a summed-area table.
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += ink[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; }
  }
  const cover = (x, y, r) => {
    x = Math.round(x); y = Math.round(y);
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    if (x1 <= x0 || y1 <= y0) return 0;
    return (S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const woods = new Uint8Array(n);
  let any = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (cover(x, y, R) >= 0.45) { woods[y * w + x] = 1; any++; }
  if (any < 400 * lw * lw) return [];
  const near = dilate(woods, w, h, Math.round(4 * lw));
  const paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = near[i] && !ink[i] && !fill[i] && !crop[i] ? 1 : 0;
  // Less the specks and slivers between strokes: what's left after taking
  // a pixel off every edge (across and down), grown back.
  const core = new Uint8Array(n), open = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; core[i] = paper[i] && paper[i - 1] && paper[i + 1] && paper[i - w] && paper[i + w] ? 1 : 0; }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; open[i] = paper[i] && (core[i] || core[i - 1] || core[i + 1] || core[i - w] || core[i + w]) ? 1 : 0; }
  thin(open, w, h);
  // The paths, less short spurs, joined across the odd stroke that crosses
  // one; then only networks of real length, so gaps between strokes and the
  // letters of a name in the woods drop out.
  const lines = prune(traceSkeleton(open, w, h), 6 * lw, 10 * lw).map((l) => keepFarthest(l, 1)).filter((l) => lineLength(l) >= 3 * lw);
  const all = lines.concat(closeGaps(lines, 6 * lw));
  const key = (p) => `${Math.round(p[0] / 2)},${Math.round(p[1] / 2)}`;
  const parent = new Map();
  const find = (q) => { while (parent.get(q) !== q) { parent.set(q, parent.get(parent.get(q))); q = parent.get(q); } return q; };
  const join = (p, q) => { for (const r of [p, q]) if (!parent.has(r)) parent.set(r, r); parent.set(find(p), find(q)); };
  // Ends a pixel or two apart are one joint.
  const at = new Map();
  for (const l of all) for (const p of [l[0], l[l.length - 1]]) {
    const x = Math.round(p[0] / 2), y = Math.round(p[1] / 2);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = at.get(`${x + dx},${y + dy}`); if (q) join(key(p), q); }
    at.set(`${x},${y}`, key(p));
  }
  for (const l of all) join(key(l[0]), key(l[l.length - 1]));
  const total = new Map();
  for (const l of all) { const r = find(key(l[0])); total.set(r, (total.get(r) || 0) + lineLength(l)); }
  // A path runs through the woods, with woods either side of it, not along
  // their edge or between the lines of a railway.
  const railNear = dilate(rasterise(rails, w, h), w, h, Math.round(5 * lw));
  const r = Math.max(1, Math.round(2 * lw)), out = 4 * lw;
  const wooded = (l) => {
    const pts = samplePath(l, 0, lineLength(l), 2);
    let both = 0;
    pts.forEach(([x, y], i) => {
      const [ax, ay] = pts[Math.max(0, i - 2)], [bx, by] = pts[Math.min(pts.length - 1, i + 2)], L = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / L, ny = (bx - ax) / L;
      if (cover(x + nx * out, y + ny * out, r) >= 0.35 && cover(x - nx * out, y - ny * out, r) >= 0.35) both++;
    });
    return both >= 0.6 * pts.length;
  };
  return all.filter((l) => total.get(find(key(l[0]))) >= 50 * lw && meanAlong(l, railNear, w, h) < 0.3 && wooded(l)).map((l) => keepFarthest(smoothLine(l, 1.5 * lw), 0.6));
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
function fillIn({ inkImg, ink, colourInk, gridBand, hints, fill, crop, blockMask, avoid, edges, shore, w, h, k }) {
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
  let allBlocks = blocks.mask ? blockMask.map((v, i) => v | blocks.mask[i]) : blockMask, more = blocks.lines;
  // The grid sometimes runs along a street, standing in for a hidden edge,
  // and sometimes across a block, cutting it into slivers too thin to pass
  // for blocks. A second look with the grid not counting as a wall finds
  // those.
  // Where a tram route hides a block's edge, the edge found beside the
  // route stands in for it.
  if (gridBand) {
    const walls = colourInk.map((v, i) => v && !gridBand[i]);
    const again = moreBlocks(strong, walls, skip, allBlocks, kept.concat(shore, loose, more), w, h, k, hints && rasterise(hints, w, h));
    if (again.mask) allBlocks = allBlocks.map((v, i) => v | again.mask[i]);
    more = more.concat(again.lines);
  }
  return { edges: kept, inferred: loose.concat(more), creases, strong, blocks: allBlocks };
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
function moreBlocks(strong, colourInk, skip, blockMask, known, w, h, k, extra = null) {
  const n = w * h;
  const r = (px) => Math.max(1, Math.round(px * k));
  const knownMask = rasterise(known, w, h);
  let wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) wall[i] = strong[i] || colourInk[i] || knownMask[i] || extra?.[i] ? 1 : 0;
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
  if (!any) return { lines: [], mask: null };
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
  for (let i = 0; i < n; i++) printed[i] = strong[i] || colourInk[i] || extra?.[i] ? 1 : 0;
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
  return { lines: out, mask };
}

// ---------- evening out ----------

// Streets keep much the same width, so the usual width is the yardstick for
// what a real line can do: an edge doesn't jut a little way into the road and
// come back (lettering touching it), a line end doesn't hook off into the
// road, and a short stub sticking off a line into the road is a scrap of
// lettering, not a street. groups: lists of lines, checked together.
// Returns { groups, dropped }.
function evenOut(groups, spaceDepth, centres, w, h, k, lw, ink) {
  // Usual street width: twice the distance from a street's centre line to its edges.
  const widths = [];
  for (const l of centres) for (const [x, y] of samplePath(l, 0, lineLength(l), 6)) { const d = spaceDepth[idx(x, y, w, h)]; if (d > 1 && d < 100 * k) widths.push(2 * d); }
  widths.sort((a, b) => a - b);
  const W = widths.length > 50 ? widths[widths.length >> 1] : 20 * k;
  const dropped = [];
  // Pieces that meet end to end are joined first, so a jog that straddles
  // two pieces shows up as one.
  let kept = [];
  groups.forEach((ls, g) => { for (const l of joinEnds(ls)) { const t = trimHooks(flattenBumps(straightenTeeth(l, lw, ink, w, h), W), W); if (t.length > 1) kept.push(Object.assign(t, { g })); } });
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
  return { groups: groups.map((_, g) => kept.filter((l) => l.g === g)), dropped, width: W };
}

// Saw teeth: a run that zigzags back and forth across a straight course,
// a little way either side, again and again (an outline traced round a row
// of tree crowns, or round lettering along a street edge), becomes the
// straight line down its course, moved across to where it runs along the
// most ink (the street line the lettering touches, the middle of the row of
// crowns). A real curve or a single jog bends one way, or once, so it
// stays. lw: the map's line weight.
function straightenTeeth(l, lw, ink, w, h) {
  if (l.length < 4) return l;
  // The line at one point per pixel, so the tests go by length, not by
  // how many corners the tracing happened to keep.
  const pts = [l[0]];
  for (let i = 1; i < l.length; i++) {
    const [ax, ay] = l[i - 1], [bx, by] = l[i], L = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.round(L));
    for (let t = 1; t <= m; t++) pts.push([ax + (bx - ax) * t / m, ay + (by - ay) * t / m]);
  }
  const n = pts.length, reach = 4 * lw, minLen = Math.round(20 * lw), step = Math.max(2, Math.round(lw));
  if (n < minLen) return l;
  // Straight line through pts[a..b] (total least squares): a point on it, its way.
  const fit = (a, b) => {
    let sx = 0, sy = 0;
    for (let i = a; i <= b; i++) { sx += pts[i][0]; sy += pts[i][1]; }
    const m = b - a + 1, cx = sx / m, cy = sy / m;
    let xx = 0, yy = 0, xy = 0;
    for (let i = a; i <= b; i++) { const dx = pts[i][0] - cx, dy = pts[i][1] - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
    const t = 0.5 * Math.atan2(2 * xy, xx - yy);
    return { cx, cy, ux: Math.cos(t), uy: Math.sin(t) };
  };
  const off = (f, [x, y]) => (y - f.cy) * f.ux - (x - f.cx) * f.uy;
  const worst = (f, a, b) => { let m = 0; for (let i = a; i <= b; i++) m = Math.max(m, Math.abs(off(f, pts[i]))); return m; };
  const onto = (f, [x, y]) => { const t = (x - f.cx) * f.ux + (y - f.cy) * f.uy; return [f.cx + t * f.ux, f.cy + t * f.uy]; };
  const runs = [];
  for (let a = 0; a + minLen < n;) {
    // The longest run from here that stays within reach of one straight line.
    let b = a + minLen;
    if (worst(fit(a, b), a, b) > reach) { a += step; continue; }
    while (b + step < n && worst(fit(a, b + step), a, b + step) <= reach) b += step;
    const f = fit(a, b);
    // Back and forth across it, counting only swings well clear of the line.
    let swings = 0, side = 0, sq = 0;
    for (let i = a; i <= b; i++) {
      const d = off(f, pts[i]);
      sq += d * d;
      const sg = d > 0.5 * lw ? 1 : d < -0.5 * lw ? -1 : 0;
      if (sg && sg !== side) { if (side) swings++; side = sg; }
    }
    const len = b - a;
    if (swings >= Math.max(4, len / (10 * lw)) && Math.sqrt(sq / (len + 1)) >= 0.4 * lw) {
      const [ax, ay] = onto(f, pts[a]), [bx, by] = onto(f, pts[b]);
      let best = 0, most = -1;
      for (let d = -reach - lw; d <= reach + lw; d += 0.5) {
        let on = 0;
        for (let t = 0; t <= len; t++) on += ink[idx(ax + (bx - ax) * t / len - f.uy * d, ay + (by - ay) * t / len + f.ux * d, w, h)];
        if (on > most || (on === most && Math.abs(d) < Math.abs(best))) { most = on; best = d; }
      }
      // Only where the map has a line to put it on: a zigzag round a
      // badge or a scrap of lettering has none, and is better left alone.
      if (most >= 0.6 * (len + 1)) { runs.push([a, b, { ...f, cx: f.cx - f.uy * best, cy: f.cy + f.ux * best }]); a = b; }
      else a += step;
    }
    else a += step;
  }
  if (!runs.length) return l;
  const out = [];
  let at = 0;
  for (const [a, b, f] of runs) {
    for (let i = at; i < a; i++) out.push(pts[i]);
    out.push(onto(f, pts[a]), onto(f, pts[b]));
    at = b + 1;
  }
  for (let i = at; i < n; i++) out.push(pts[i]);
  // A closed outline is thinned in two halves, split at its far side.
  const [sx, sy] = out[0];
  let far = 0;
  out.forEach(([x, y], i) => { if ((x - sx) ** 2 + (y - sy) ** 2 > (out[far][0] - sx) ** 2 + (out[far][1] - sy) ** 2) far = i; });
  return keepFarthest(out.slice(0, far + 1), 0.5).concat(keepFarthest(out.slice(far), 0.5).slice(1));
}

// Joins lines whose ends meet where no third line ends too.
function joinEnds(lines) {
  const ls = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const key = (p) => `${Math.round(p[0] / 2)},${Math.round(p[1] / 2)}`;
  const at = new Map();
  ls.forEach((l, i) => [0, 1].forEach((s) => { const kk = key(s ? l[l.length - 1] : l[0]); if (!at.has(kk)) at.set(kk, []); at.get(kk).push([i, s]); }));
  const alive = ls.map(() => true), into = ls.map((_, i) => i);
  const find = (i) => { while (into[i] !== i) i = into[i] = into[into[i]]; return i; };
  for (const [kk, ends] of at) {
    if (ends.length !== 2) continue;
    let [[i], [j]] = ends;
    i = find(i); j = find(j);
    if (i === j) continue;
    // Each end has to still be an end of the joined line it now belongs to.
    const a = ls[i], b = ls[j];
    const aEnd = key(a[a.length - 1]) === kk ? 1 : key(a[0]) === kk ? 0 : -1, bEnd = key(b[b.length - 1]) === kk ? 1 : key(b[0]) === kk ? 0 : -1;
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
