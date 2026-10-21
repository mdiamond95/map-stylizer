// Colour tracing with VTracer (WebAssembly): picks out every pixel close to a
// chosen colour and turns that mask into smooth vector shapes. Used for the
// things reference data does not have, such as a shaded empire or a drawn route.
import init, { to_svg } from 'vtracer-wasm';
import wasmUrl from 'vtracer-wasm/vtracer.wasm?url';

let ready = null;
const MAX_PIXELS = 4_000_000;

export function sampleColour(img, x, y, radius = 2) {
  const c = document.createElement('canvas');
  c.width = c.height = radius * 2 + 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, x - radius, y - radius, c.width, c.height, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
  return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
}

// Returns pixel-space path strings for the original image size.
export async function traceColour(img, width, height, rgb, tolerance = 40, { smooth = true } = {}) {
  ready ||= init({ module_or_path: wasmUrl });
  await ready;
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  const w = Math.round(width * s), h = Math.round(height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;
  const px = new Uint8Array(w * h * 4);
  const t2 = tolerance * tolerance;
  let hits = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - rgb[0], dg = data[i + 1] - rgb[1], db = data[i + 2] - rgb[2];
    const on = dr * dr + dg * dg + db * db <= t2;
    if (on) hits++;
    const v = on ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  if (!hits) return { paths: [], coverage: 0 };
  const svg = to_svg(px, w, h, {
    binary: true, mode: smooth ? 'spline' : 'polygon', hierarchical: 'cutout',
    cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45,
    filterSpeckle: Math.max(4, Math.round(8 * s)), colorPrecision: 6, layerDifference: 16, pathPrecision: 2
  });
  const paths = [];
  const re = /<path d="([^"]+)"[^>]*fill="#000000"[^>]*transform="translate\(([-\d.]+),([-\d.]+)\)"/g;
  let m;
  while ((m = re.exec(svg))) paths.push(bake(m[1], +m[2], +m[3], 1 / s));
  return { paths, coverage: hits / (w * h) };
}

// VTracer writes each shape relative to a translate(); fold that offset and
// the downscale back into absolute image coordinates.
function bake(d, tx, ty, k) {
  let i = 0;
  return d.replace(/-?\d+(\.\d+)?/g, (n) => {
    const v = (i++ % 2 === 0 ? +n + tx : +n + ty) * k;
    return String(Math.round(v * 10) / 10);
  });
}
