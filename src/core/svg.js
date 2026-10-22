// Turns pixel-space layers plus a style into a layered SVG, one named group
// per layer and one named path per country, ready for Illustrator or After Effects.

const LAYER_ORDER = ['ocean', 'graticule', 'land', 'lakes', 'rivers', 'provinceLines', 'borders', 'coastline', 'traced', 'places', 'labels'];

// frame: the part of the image to export, in image pixels.
// outWidth/outHeight: the export size. Style widths are pixels at that size.
export function buildSvg(layers, style, opts = {}) {
  const frame = opts.frame || { x: 0, y: 0, w: layers.width, h: layers.height };
  const outWidth = opts.outWidth || Math.round(frame.w);
  const outHeight = opts.outHeight || Math.round(frame.h);
  // Style sizes are pixels in a 1440-tall export; scaling by the frame keeps
  // the same visual weight at any export size or crop.
  const s = (v) => fmt(v * (frame.h / 1440));
  const show = { graticule: style.graticule?.show ?? false, provinceLines: true, rivers: true, lakes: true, places: true, labels: true, countryLabels: true, placeLabels: true, traced: true, ...(opts.show || {}) };
  if (style.rivers?.show === false) show.rivers = false;
  if (style.provinceLines?.show === false) show.provinceLines = false;
  const highlight = new Set(opts.highlight || []);
  const fade = new Set(opts.fade || []);
  const L = style.labels || {};
  const parts = [];
  const defs = [];

  // Filter regions are pinned to the frame: a region sized to a world-wide
  // path's bounds would be huge and browsers silently skip drawing it.
  const region = `filterUnits="userSpaceOnUse" x="${fmt(frame.x - frame.w * 0.05)}" y="${fmt(frame.y - frame.h * 0.05)}" width="${fmt(frame.w * 1.1)}" height="${fmt(frame.h * 1.1)}"`;
  if (style.effects?.landShadow) {
    const e = style.effects.landShadow;
    defs.push(`<filter id="land-shadow" ${region}><feDropShadow dx="${s(e.dx)}" dy="${s(e.dy)}" stdDeviation="${s(e.blur)}" flood-color="${hex(e.colour)}" flood-opacity="${alpha(e.colour)}"/></filter>`);
  }
  if (style.effects?.glow) {
    const e = style.effects.glow;
    defs.push(`<filter id="glow" ${region}><feGaussianBlur stdDeviation="${s(e.blur)}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`);
  }
  if (style.effects?.paper) {
    const op = style.effects.paper.opacity ?? 0.2;
    defs.push(`<filter id="paper" ${region}><feTurbulence type="fractalNoise" baseFrequency="${fmt(0.9 / (frame.h / 1440))}" numOctaves="3" seed="7"/><feColorMatrix type="luminanceToAlpha" result="n"/><feComponentTransfer in="n" result="grain"><feFuncA type="linear" slope="${fmt(op * 2)}"/></feComponentTransfer><feFlood flood-color="${style.effects.paper.colour}"/><feComposite in2="grain" operator="in"/></filter>`);
  }
  const glow = style.effects?.glow ? ' filter="url(#glow)"' : '';

  const line = (id, d, st, extra = '') => {
    if (!d || !st || st.width === 0 || st.stroke === 'none') return '';
    let out = '';
    if (st.halo) out += `<path id="${id}-halo" d="${d}" fill="none" stroke="${st.halo.stroke}" stroke-width="${s(st.halo.width)}" stroke-opacity="${st.halo.opacity ?? 1}" stroke-linejoin="round" stroke-linecap="round"/>`;
    out += `<path id="${id}-line" d="${d}" fill="none" stroke="${st.stroke}" stroke-width="${s(st.width)}"${st.opacity != null ? ` stroke-opacity="${st.opacity}"` : ''}${st.dash ? ` stroke-dasharray="${st.dash.split(/\s+/).map((v) => s(+v)).join(' ')}"` : ''} stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
    return out;
  };

  if (layers.osm) parts.push(cityParts(layers, style, { s, frame, show, opts, line, L }));
  for (const layer of layers.osm ? [] : LAYER_ORDER) {
    if (layer === 'ocean') {
      parts.push(group('ocean', `<rect x="${fmt(frame.x - frame.w)}" y="${fmt(frame.y - frame.h)}" width="${fmt(frame.w * 3)}" height="${fmt(frame.h * 3)}" fill="${style.ocean}"/>`));
    } else if (layer === 'graticule' && show.graticule) {
      parts.push(group('graticule', line('graticule', layers.graticule, style.graticule)));
    } else if (layer === 'land') {
      const paths = layers.countries.map((c) => {
        const fill = highlight.has(c.id) ? style.land.highlight : fade.has(c.id) ? style.land.fade : (style.land.palette ? style.land.palette[(c.colour - 1) % style.land.palette.length] : style.land.fill);
        return `<path id="country-${safeId(c.id)}" data-name="${esc(c.name)}" d="${c.d}" fill="${fill}"/>`;
      }).join('');
      const shadow = style.effects?.landShadow ? ' filter="url(#land-shadow)"' : '';
      parts.push(group('land', paths, shadow));
      if (style.effects?.paper) parts.push(group('paper-texture', `<rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}" fill="#fff" filter="url(#paper)"/>`));
    } else if (layer === 'lakes' && show.lakes) {
      const st = style.lakes;
      parts.push(group('lakes', layers.lakes.map((l, i) => `<path id="lake-${i}" data-name="${esc(l.name || '')}" d="${l.d}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${s(st.width)}"/>`).join('')));
    } else if (layer === 'rivers' && show.rivers) {
      const st = style.rivers;
      parts.push(group('rivers', layers.rivers.map((r, i) => `<path id="river-${i}" data-name="${esc(r.name || '')}" d="${r.d}" fill="none" stroke="${st.stroke}" stroke-width="${s(st.width * riverScale(r.rank))}"${st.opacity != null ? ` stroke-opacity="${st.opacity}"` : ''} stroke-linecap="round" stroke-linejoin="round"/>`).join(''), glow));
    } else if (layer === 'provinceLines' && show.provinceLines) {
      parts.push(group('province-borders', line('province-borders', layers.provinceLines, style.provinceLines), glow));
    } else if (layer === 'borders') {
      parts.push(group('country-borders', line('country-borders', layers.borders, style.borders), glow));
    } else if (layer === 'coastline') {
      parts.push(group('coastline', line('coastline', layers.coastline, style.coastline), glow));
    } else if (layer === 'traced' && show.traced && opts.traced?.length) {
      parts.push(group('traced', opts.traced.map((t, i) => `<g id="traced-${i}" data-name="${esc(t.name)}">${t.paths.map((d) => `<path d="${d}" fill="${t.mode === 'line' ? 'none' : t.fill}" stroke="${t.mode === 'line' ? t.fill : 'none'}" stroke-width="${t.mode === 'line' ? s(4) : 0}"/>`).join('')}</g>`).join('')));
    } else if (layer === 'places' && show.places) {
      const st = style.places;
      parts.push(group('places', layers.places.map((p, i) => marker(`place-${i}`, p, st, s)).join('')));
    } else if (layer === 'labels' && show.labels) {
      const textAttrs = (size, weight, fontStyle) => `font-family="${esc(L.font)}" font-size="${s(size)}" font-weight="${weight}"${fontStyle && fontStyle !== 'normal' ? ` font-style="${fontStyle}"` : ''} fill="${L.fill}" stroke="${L.halo}" stroke-width="${s(L.haloWidth)}" stroke-linejoin="round" paint-order="stroke"`;
      const caseFn = (t) => (L.countryCase === 'upper' ? t.toUpperCase() : t);
      const placed = [];
      const unit = frame.h / 1440;
      const countryLabels = show.countryLabels ? placeCountryLabels(layers.countries, { L, unit, frame, fade, placed, names: opts.names || {}, force: new Set(opts.labelForce || []), hide: new Set(opts.labelHide || []) })
        .map((c) => `<text id="label-${safeId(c.id)}" x="${fmt(c.x)}" y="${fmt(c.y)}" text-anchor="middle" dominant-baseline="middle" letter-spacing="${s(L.letterSpacing || 0)}" ${textAttrs(L.countrySize, L.countryWeight, L.countryStyle)}>${esc(caseFn(c.text))}</text>`).join('') : '';
      const placeLabels = show.placeLabels && show.places ? placePlaceLabels(layers.places, { L, unit, frame, placed, gap: (style.places.radius + 4) * unit })
        .map((p) => `<text id="place-label-${p.i}" x="${fmt(p.x)}" y="${fmt(p.y)}" text-anchor="${p.anchor}" dominant-baseline="middle" ${textAttrs(L.placeSize, L.placeWeight, L.placeStyle)}>${esc(p.name)}</text>`).join('') : '';
      parts.push(group('labels', group('country-labels', countryLabels) + group('place-labels', placeLabels)));
    }
  }

  if (opts.linework) parts.push(lineworkGroup(opts.linework, s));

  const source = layers.osm ? '© OpenMapTiles © OpenStreetMap contributors (ODbL)' : 'Natural Earth (public domain)';
  const credit = opts.credit !== false ? `<desc>Made with Map Stylizer. Reference data: ${source}.</desc>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="${fmt(frame.x)} ${fmt(frame.y)} ${fmt(frame.w)} ${fmt(frame.h)}">${credit}<defs>${defs.join('')}<clipPath id="frame"><rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}"/></clipPath></defs><g id="map" clip-path="url(#frame)">${parts.join('')}</g></svg>`;
}

// Lines pulled straight off the scan, one group per ink colour, as strokes
// so an editor can change their colour and weight or draw them on.
export function lineworkGroup(linework, s) {
  const layers = (linework?.layers || []).filter((l) => l.show !== false && l.d);
  // Area layers (water) are solid shapes, with islands as holes.
  return group('scan-lines', layers.map((l, i) => `<g id="scan-lines-${i + 1}" data-name="${esc(l.name)}">${l.area
    ? `<path d="${l.d}" fill="${l.colour}" fill-rule="evenodd" stroke="none"/>`
    : `<path d="${l.d}" fill="none" stroke="${l.colour}" stroke-width="${s(linework.strokeWidth ?? 1.4)}" stroke-linecap="round" stroke-linejoin="miter" stroke-miterlimit="4"/>`}</g>`).join(''));
}

// Only the scan's own lines on a plain background: no reference data, so no
// pins are needed.
export function buildLineworkSvg(linework, style, opts = {}) {
  const frame = opts.frame || { x: 0, y: 0, w: linework.imageWidth, h: linework.imageHeight };
  const outWidth = opts.outWidth || Math.round(frame.w);
  const outHeight = opts.outHeight || Math.round(frame.h);
  const s = (v) => fmt(v * (frame.h / 1440));
  const c = { ...cityDefaults(style), ...(style.city || {}) };
  const bg = group('background', `<rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}" fill="${c.land}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="${fmt(frame.x)} ${fmt(frame.y)} ${fmt(frame.w)} ${fmt(frame.h)}"><desc>Made with Map Stylizer. Lines traced from the scanned map.</desc><defs><clipPath id="frame"><rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}"/></clipPath></defs><g id="map" clip-path="url(#frame)">${bg}${lineworkGroup(linework, s)}</g></svg>`;
}

// City and town maps: OpenStreetMap water, parks, roads and street names.
// Each road class is one path with a casing underneath, which keeps the SVG
// small and makes "draw on" animations per class easy.
function cityParts(layers, style, { s, frame, show, opts, line, L }) {
  const c = { ...cityDefaults(style), ...(style.city || {}) };
  const o = layers.osm;
  const out = [];
  out.push(group('land', `<rect x="${fmt(frame.x - frame.w)}" y="${fmt(frame.y - frame.h)}" width="${fmt(frame.w * 3)}" height="${fmt(frame.h * 3)}" fill="${c.land}"/>`));
  if (style.effects?.paper) out.push(group('paper-texture', `<rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}" fill="#fff" filter="url(#paper)"/>`));
  if (o.parks) out.push(group('parks', `<path d="${o.parks}" fill="${c.parks}"/>`));
  if (o.water) out.push(group('water', `<path d="${o.water}" fill="${style.ocean}"/>`));
  if (show.rivers && o.waterways) out.push(group('waterways', line('waterways', o.waterways, { stroke: style.ocean, width: c.waterwayWidth })));
  if (show.buildings && o.buildings) out.push(group('buildings', `<path d="${o.buildings}" fill="${c.buildings}"/>`));
  const glow = style.effects?.glow ? ' filter="url(#glow)"' : '';
  const roads = [];
  for (const cls of ['minor', 'medium', 'major']) {
    const r = c.roads[cls];
    const d = o.roads[cls];
    if (!d || !r || r.width === 0) continue;
    roads.push(group(`roads-${cls}`, (r.casing ? line(`roads-${cls}-casing`, d, { stroke: r.casing, width: r.width + 2 * (r.casingWidth ?? 1) }) : '') + line(`roads-${cls}`, d, r)));
  }
  if (o.roads.rail && c.rail) roads.push(group('railways', line('railways', o.roads.rail, c.rail)));
  if (o.roads.ferry && c.ferry) roads.push(group('ferries', line('ferries', o.roads.ferry, c.ferry)));
  out.push(group('roads', roads.join(''), glow));
  if (show.traced && opts.traced?.length) {
    out.push(group('traced', opts.traced.map((t, i) => `<g id="traced-${i}" data-name="${esc(t.name)}">${t.paths.map((d) => `<path d="${d}" fill="${t.fill}"/>`).join('')}</g>`).join('')));
  }
  if (show.labels) {
    const unit = frame.h / 1440;
    const placed = [];
    const attrs = (size, weight, fontStyle) => `font-family="${esc(L.font)}" font-size="${s(size)}" font-weight="${weight}"${fontStyle && fontStyle !== 'normal' ? ` font-style="${fontStyle}"` : ''} fill="${L.fill}" stroke="${L.halo}" stroke-width="${s(L.haloWidth)}" stroke-linejoin="round" paint-order="stroke"`;
    // Area names first so street names give way to them.
    let areas = '';
    if (show.countryLabels !== false) {
      for (const p of o.places) {
        const size = p.class === 'city' || p.class === 'town' ? L.countrySize : c.areaLabelSize;
        const text = L.countryCase === 'upper' ? p.name.toUpperCase() : p.name;
        const w = textWidth(text, size, L.letterSpacing) * unit;
        const box = [p.x - w / 2, p.y - size * unit / 2, p.x + w / 2, p.y + size * unit / 2];
        if (!inside([box[0], box[1]], frame) || !inside([box[2], box[3]], frame) || placed.some((b) => overlaps(b, box))) continue;
        placed.push(box);
        areas += `<text data-name="${esc(p.name)}" x="${fmt(p.x)}" y="${fmt(p.y)}" text-anchor="middle" dominant-baseline="middle" letter-spacing="${s(L.letterSpacing || 0)}" ${attrs(size, L.countryWeight, L.countryStyle)}>${esc(text)}</text>`;
      }
    }
    let streets = '';
    if (show.placeLabels !== false) {
      const size = c.streetLabelSize;
      const defsOut = [];
      o.streetNames.slice(0, c.streetLabelLimit).forEach((n, i) => {
        const w = textWidth(n.name, size, 0) * unit;
        if (n.length < w * 1.15) return;
        // Only the stretch the text sits on matters: it must be fairly
        // straight, inside the frame, clear of other labels, and run left to
        // right so the name reads the right way up.
        let pts = stretch(n.points, n.length / 2 - w / 2 - size * unit, n.length / 2 + w / 2 + size * unit);
        if (pts.length < 2 || turning(pts) > Math.PI / 4) return;
        if (pts[pts.length - 1][0] < pts[0][0]) pts = pts.reverse();
        const r = size * unit * 0.75;
        const boxes = alongEvery(pts, size * unit).map((p) => [p[0] - r, p[1] - r, p[0] + r, p[1] + r]);
        if (!boxes.every((b) => inside([b[0], b[1]], frame) && inside([b[2], b[3]], frame))) return;
        if (boxes.some((b) => placed.some((q) => overlaps(q, b)))) return;
        placed.push(...boxes);
        defsOut.push(`<path id="street-path-${i}" d="M${pts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join('L')}"/>`);
        streets += `<text id="street-${i}" data-name="${esc(n.name)}" dominant-baseline="middle" ${attrs(size, c.streetLabelWeight)}><textPath href="#street-path-${i}" startOffset="50%" text-anchor="middle">${esc(n.name)}</textPath></text>`;
      });
      streets = defsOut.length ? `<defs>${defsOut.join('')}</defs>${streets}` : '';
    }
    out.push(group('labels', group('area-labels', areas) + group('street-labels', streets)));
  }
  return out.join('');
}

// Street colours derived from a style's own palette, so a preset without a
// "city" block still gives a sensible street map.
function cityDefaults(style) {
  return {
    land: style.land.palette?.[0] || style.land.fill,
    parks: style.land.palette?.[1] || style.land.fade,
    buildings: style.land.fade,
    waterwayWidth: 3,
    roads: {
      minor: { stroke: style.land.fill, width: 2.5, casing: style.provinceLines.stroke, casingWidth: 0.6 },
      medium: { stroke: '#ffffff', width: 4.5, casing: style.borders.stroke, casingWidth: 0.8 },
      major: { stroke: style.land.highlight, width: 6, casing: style.borders.stroke, casingWidth: 1 }
    },
    rail: { stroke: style.borders.stroke, width: 2, dash: '8 5' },
    ferry: { stroke: style.coastline.stroke, width: 1.5, dash: '6 6' },
    streetLabelSize: 15,
    streetLabelWeight: 600,
    streetLabelLimit: 120,
    areaLabelSize: 20
  };
}

// Labels biggest countries first and skips any label that would not fit
// inside its country or would collide with one already placed.
function placeCountryLabels(countries, { L, unit, frame, fade, placed, names, force, hide }) {
  const h = L.countrySize * unit;
  const out = [];
  const sorted = countries.filter((c) => c.label && !fade.has(c.id) && !hide.has(c.id) && inside(c.label, frame))
    .sort((a, b) => (force.has(b.id) - force.has(a.id)) || b.area - a.area);
  for (const c of sorted) {
    const text = names[c.id] || c.name;
    const w = textWidth(text, L.countrySize, L.letterSpacing) * unit;
    const box = [c.label[0] - w / 2, c.label[1] - h / 2, c.label[0] + w / 2, c.label[1] + h / 2];
    const fits = c.area > w * h * 1.6 && (c.box[2] - c.box[0]) > w * 0.9;
    if (!force.has(c.id) && (!fits || placed.some((p) => overlaps(p, box)))) continue;
    placed.push(box);
    out.push({ id: c.id, text, x: c.label[0], y: c.label[1] });
  }
  return out;
}

function placePlaceLabels(places, { L, unit, frame, placed, gap }) {
  const h = L.placeSize * unit;
  const out = [];
  places.forEach((p, i) => {
    if (!inside([p.x, p.y], frame)) return;
    const w = textWidth(p.name, L.placeSize, 0) * unit;
    for (const anchor of ['start', 'end']) {
      const x = anchor === 'start' ? p.x + gap : p.x - gap;
      const box = anchor === 'start' ? [x, p.y - h / 2, x + w, p.y + h / 2] : [x - w, p.y - h / 2, x, p.y + h / 2];
      if (box[0] < frame.x || box[2] > frame.x + frame.w || placed.some((b) => overlaps(b, box))) continue;
      placed.push(box);
      out.push({ i, name: p.name, x, y: p.y, anchor });
      return;
    }
  });
  return out;
}

// The part of a polyline between two distances along it.
function stretch(pts, a, b) {
  const out = [];
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const at = (t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    if (len && d + len >= a && d <= b) {
      if (!out.length) out.push(at(Math.max(0, (a - d) / len)));
      out.push(at(Math.min(1, (b - d) / len)));
    }
    d += len;
  }
  return out;
}

// Total bending along a polyline, in radians, ignoring tiny wiggles.
function turning(pts) {
  let total = 0, prev = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    if (Math.hypot(dx, dy) < 2) continue;
    const a = Math.atan2(dy, dx);
    if (prev != null) { let t = Math.abs(a - prev); if (t > Math.PI) t = 2 * Math.PI - t; total += t; }
    prev = a;
  }
  return total;
}

function alongEvery(pts, step) {
  const out = [pts[0]];
  let t = step;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (; t <= len; t += step) out.push([p[0] + (q[0] - p[0]) * t / len, p[1] + (q[1] - p[1]) * t / len]);
    t -= len;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function textWidth(text, size, spacing = 0) { return text.length * (size * 0.6 + spacing); }
function overlaps(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }

function marker(id, p, st, s) {
  const r = s(p.capital ? st.radius * 1.15 : st.radius);
  const common = `fill="${st.fill}" stroke="${st.stroke}" stroke-width="${s(2)}"`;
  if (p.capital && st.capitalShape === 'square') return `<rect id="${id}" data-name="${esc(p.name)}" x="${fmt(p.x - r)}" y="${fmt(p.y - r)}" width="${fmt(2 * r)}" height="${fmt(2 * r)}" ${common}/>`;
  if (p.capital && st.capitalShape === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rr = i % 2 ? r * 0.5 : r * 1.3; pts.push(`${fmt(p.x + rr * Math.cos(a))},${fmt(p.y + rr * Math.sin(a))}`); }
    return `<polygon id="${id}" data-name="${esc(p.name)}" points="${pts.join(' ')}" ${common}/>`;
  }
  return `<circle id="${id}" data-name="${esc(p.name)}" cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="${fmt(r)}" ${common}/>`;
}

function riverScale(rank) { return rank <= 2 ? 1.4 : rank <= 4 ? 1 : 0.7; }
function inside(p, f) { return p[0] >= f.x && p[0] <= f.x + f.w && p[1] >= f.y && p[1] <= f.y + f.h; }
function group(id, inner, attrs = '') { return inner ? `<g id="${id}"${attrs}>${inner}</g>` : ''; }
function fmt(v) { return Math.round(v * 100) / 100; }
function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function hex(c) { return c.length === 9 ? c.slice(0, 7) : c; }
function alpha(c) { return c.length === 9 ? Math.round(parseInt(c.slice(7), 16) / 2.55) / 100 : 1; }
