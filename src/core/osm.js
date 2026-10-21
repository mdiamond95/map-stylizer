// Street-level reference data from OpenStreetMap, read from OpenFreeMap's free
// vector tiles (OpenMapTiles schema, no API key). Used for city and town maps,
// where Natural Earth is far too coarse.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fixWinding } from './reference.js';

export const OSM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OSM_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';
const MAX_ZOOM = 14;

const ROAD_CLASS = {
  motorway: 'major', trunk: 'major', primary: 'major',
  secondary: 'medium', tertiary: 'medium',
  minor: 'minor', service: 'minor', track: 'minor', raceway: 'minor', busway: 'minor',
  rail: 'rail', transit: 'rail',
  ferry: 'ferry'
};
const PARK_LANDUSE = new Set(['cemetery', 'stadium', 'pitch', 'playground']);
const PARK_LANDCOVER = new Set(['grass', 'wood']);
const PLACE_CLASS = new Set(['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood', 'hamlet', 'island']);

// Picks the most detailed zoom that keeps the download to a sensible number of tiles.
export function tilesForBbox([w, s, e, n], maxTiles = 64) {
  for (let z = MAX_ZOOM; z >= 0; z--) {
    const [x0, y0] = tileXY(w, n, z);
    const [x1, y1] = tileXY(e, s, z);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= maxTiles || z === 0) {
      const tiles = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([z, x, y]);
      return { z, tiles };
    }
  }
}

function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return [clampInt(x, 0, n - 1), clampInt(y, 0, n - 1)];
}

function clampInt(v, a, b) { return Math.max(a, Math.min(b, v)); }

// fetchTile(z, x, y) -> ArrayBuffer | null. Injected so the browser, Node and
// tests can each supply their own.
export async function loadOsm(bbox, fetchTile, { maxTiles = 64, onProgress } = {}) {
  const { z, tiles } = tilesForBbox(bbox, maxTiles);
  const out = { zoom: z, water: [], waterways: [], roads: [], parks: [], buildings: [], names: [], places: [] };
  let done = 0;
  // A few requests at a time is polite to the free tile service and fast enough.
  const queue = tiles.slice();
  const worker = async () => {
    while (queue.length) {
      const [tz, tx, ty] = queue.shift();
      const buf = await fetchTile(tz, tx, ty);
      if (buf) addTile(out, new VectorTile(new PbfReader(new Uint8Array(buf))), tx, ty, tz);
      onProgress?.(++done, tiles.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

function addTile(out, tile, x, y, z) {
  const each = (name, fn) => {
    const layer = tile.layers[name];
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      fn(f.properties, () => f.toGeoJSON(x, y, z));
    }
  };
  each('water', (p, g) => out.water.push(fixWinding(g())));
  each('waterway', (p, g) => { if (p.class === 'river' || p.class === 'canal' || p.class === 'stream') out.waterways.push(tag(g(), { class: p.class })); });
  each('transportation', (p, g) => {
    const cls = ROAD_CLASS[p.class];
    if (cls && p.brunnel !== 'tunnel') out.roads.push(tag(g(), { class: cls, kind: p.class }));
  });
  each('transportation_name', (p, g) => {
    const cls = ROAD_CLASS[p.class];
    if (p.name && (cls === 'major' || cls === 'medium' || cls === 'minor')) out.names.push(tag(g(), { name: p.name, class: cls }));
  });
  each('park', (p, g) => out.parks.push(fixWinding(g())));
  each('landuse', (p, g) => { if (PARK_LANDUSE.has(p.class)) out.parks.push(fixWinding(g())); });
  each('landcover', (p, g) => { if (PARK_LANDCOVER.has(p.class)) out.parks.push(fixWinding(g())); });
  each('building', (p, g) => out.buildings.push(fixWinding(g())));
  each('place', (p, g) => { if (p.name && PLACE_CLASS.has(p.class)) out.places.push(tag(g(), { name: p.name, class: p.class })); });
}

function tag(f, properties) { return { type: 'Feature', geometry: f.geometry, properties }; }

// Browser and Node both have fetch; this resolves the current tile URL once.
export function makeTileFetcher(fetchFn = fetch) {
  let template = null;
  return async (z, x, y) => {
    template ||= fetchFn(OSM_TILEJSON).then((r) => r.json()).then((j) => j.tiles[0]);
    const url = (await template).replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const res = await fetchFn(url);
    return res.ok ? res.arrayBuffer() : null;
  };
}
