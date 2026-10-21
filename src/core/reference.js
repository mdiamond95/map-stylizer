// Natural Earth reference layers, built from a bundled TopoJSON file.
// Shared topology means borders, coasts and provinces line up exactly.
import { feature, mesh } from 'topojson-client';
import { geoGraticule10, geoArea } from 'd3-geo';

export const DETAIL_LEVELS = [
  { id: 'medium', name: 'Medium (world and continent maps)', file: 'ne-medium.topojson' },
  { id: 'high', name: 'High (country and region maps)', file: 'ne-high.topojson' }
];

export function buildReference(topo) {
  const o = topo.objects;
  const countries = feature(topo, o.countries).features.map(fixWinding).map((f) => ({
    ...f,
    id: f.properties.ADM0_A3,
    properties: {
      name: f.properties.NAME,
      code: f.properties.ADM0_A3,
      iso2: f.properties.ISO_A2,
      colour: f.properties.MAPCOLOR7,
      continent: f.properties.CONTINENT,
      label: [f.properties.LABEL_X, f.properties.LABEL_Y]
    }
  }));
  const provinces = feature(topo, o.provinces).features.map(fixWinding).map((f) => ({
    ...f,
    id: f.properties.iso_3166_2,
    properties: {
      name: f.properties.name,
      country: f.properties.adm0_a3,
      code: f.properties.iso_3166_2,
      label: [f.properties.longitude, f.properties.latitude]
    }
  }));
  // Interior lines only: a border is an arc shared by two different countries,
  // a coastline is an arc used by just one.
  const borders = mesh(topo, o.countries, (a, b) => a !== b);
  const coastline = mesh(topo, o.countries, (a, b) => a === b);
  const provinceLines = mesh(topo, o.provinces, (a, b) => a !== b && a.properties.adm0_a3 === b.properties.adm0_a3);
  const lakes = feature(topo, o.lakes).features.map(fixWinding);
  const rivers = feature(topo, o.rivers).features;
  const places = feature(topo, o.places).features.map((f) => ({
    ...f,
    properties: {
      name: f.properties.name,
      country: f.properties.adm0name,
      population: f.properties.pop_max,
      rank: f.properties.scalerank,
      capital: /capital/i.test(f.properties.featurecla || '')
    }
  }));
  return { countries, provinces, borders, coastline, provinceLines, lakes, rivers, places, graticule: geoGraticule10() };
}

export function searchPlaces(ref, query, limit = 8) {
  const q = normalise(query);
  if (!q) return [];
  const hits = [];
  for (const p of ref.places) {
    const n = normalise(p.properties.name);
    if (n.startsWith(q)) hits.push({ p, score: 0 });
    else if (n.includes(q)) hits.push({ p, score: 1 });
  }
  for (const c of ref.countries) {
    if (normalise(c.properties.name).startsWith(q)) hits.push({ p: { properties: { name: c.properties.name, country: 'country centre' }, geometry: { coordinates: c.properties.label } }, score: 2 });
  }
  return hits
    .sort((a, b) => a.score - b.score || (b.p.properties.population || 0) - (a.p.properties.population || 0))
    .slice(0, limit)
    .map(({ p }) => ({ name: p.properties.name, detail: p.properties.country, lonlat: p.geometry.coordinates }));
}

// d3 reads ring direction to tell inside from outside; a ring wound the
// wrong way becomes "the whole world except this lake" and floods the map.
export function fixWinding(f) {
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return f;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const fixed = polys.map((rings) => (geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings));
  return { ...f, geometry: { type: g.type, coordinates: g.type === 'Polygon' ? fixed[0] : fixed } };
}

function normalise(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
