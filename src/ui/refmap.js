// Reference map (MapLibre). "Streets" shows OpenStreetMap from OpenFreeMap's
// free tiles, for pinning street corners on city maps; "Simple" is drawn from
// the bundled Natural Earth data and works offline. Tapping picks the
// real-world position for a control point; tapping near a city snaps to it.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// MapLibre 6 runs its tile work in a module worker that the bundler has to emit.
maplibregl.setWorkerUrl(workerUrl);

const GLYPHS = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf';
const STREETS_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SIMPLE_STYLE = { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfe6f1' } }] };

export class RefMap {
  constructor(el, { onTap, onPinMove, onBasemap, basemap = 'streets' }) {
    this.onTap = onTap;
    this.onPinMove = onPinMove;
    this.onBasemap = onBasemap;
    this.markers = new Map();
    this.ref = null;
    this.basemap = 'simple';
    // Start on the bundled map, which always works, then switch to streets
    // once their style has actually downloaded.
    this.map = new maplibregl.Map({
      container: el,
      style: SIMPLE_STYLE,
      center: [0, 30], zoom: 1, attributionControl: false, dragRotate: false, pitchWithRotate: false
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.AttributionControl({ customAttribution: 'Natural Earth' }));
    this.ready = new Promise((r) => this.map.once('load', r));
    this.map.on('style.load', () => this.addReferenceLayers());
    this.map.on('click', (e) => {
      const hits = !this.map.getLayer('places-dot') ? [] : this.map.queryRenderedFeatures([[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]], { layers: ['places-dot'] });
      if (hits.length) {
        const f = hits[0];
        this.onTap?.(f.geometry.coordinates.slice(), f.properties.name);
      } else {
        this.onTap?.([e.lngLat.lng, e.lngLat.lat], null);
      }
    });
    if (basemap === 'streets') this.setBasemap('streets');
  }

  async setBasemap(mode) {
    if (mode === this.wanted) return;
    this.wanted = mode;
    if (mode === 'streets') {
      try {
        this.streetsStyle ||= await fetchJson(STREETS_STYLE, 8000);
      } catch {
        this.wanted = this.basemap;
        this.onBasemap?.(this.basemap, 'Street map unavailable (offline?). Showing the simple map.');
        return;
      }
    }
    if (this.wanted !== mode) return;
    this.basemap = mode;
    this.map.setStyle(mode === 'streets' ? this.streetsStyle : SIMPLE_STYLE);
    this.onBasemap?.(mode);
  }

  setReference(ref) {
    this.ref = ref;
    if (this.map.isStyleLoaded()) this.addReferenceLayers();
  }

  addReferenceLayers() {
    const ref = this.ref;
    if (!ref || !this.map.isStyleLoaded() || this.map.getSource('places')) return;
    const m = this.map;
    // Street maps already draw everything; only the city dots are added, so
    // a tap near one still snaps to its exact position.
    if (this.basemap === 'streets') {
      m.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: ref.places } });
      m.addLayer({ id: 'places-dot', type: 'circle', source: 'places', maxzoom: 9, paint: { 'circle-radius': 3, 'circle-color': '#222', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.8 } });
      return;
    }
    const data = {
      countries: { type: 'FeatureCollection', features: ref.countries },
      borders: { type: 'Feature', geometry: ref.borders, properties: {} },
      coast: { type: 'Feature', geometry: ref.coastline, properties: {} },
      lakes: { type: 'FeatureCollection', features: ref.lakes },
      rivers: { type: 'FeatureCollection', features: ref.rivers },
      places: { type: 'FeatureCollection', features: ref.places }
    };
    for (const [id, d] of Object.entries(data)) {
      if (m.getSource(id)) m.getSource(id).setData(d);
      else m.addSource(id, { type: 'geojson', data: d });
    }
    m.addLayer({ id: 'countries-fill', type: 'fill', source: 'countries', paint: { 'fill-color': '#f5f1e8' } });
    m.addLayer({ id: 'lakes', type: 'fill', source: 'lakes', paint: { 'fill-color': '#cfe6f1' } });
    m.addLayer({ id: 'rivers', type: 'line', source: 'rivers', paint: { 'line-color': '#8fc0d6', 'line-width': 0.8 } });
    m.addLayer({ id: 'coast', type: 'line', source: 'coast', paint: { 'line-color': '#5b8aa3', 'line-width': 1 } });
    m.addLayer({ id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': '#555', 'line-width': 1 } });
    m.addLayer({
      id: 'places-dot', type: 'circle', source: 'places',
      filter: ['<=', ['get', 'rank'], ['step', ['zoom'], 2, 3, 4, 4, 6, 5, 10]],
      paint: { 'circle-radius': 3.5, 'circle-color': '#222', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 }
    });
    m.addLayer({
      id: 'places-label', type: 'symbol', source: 'places',
      filter: ['<=', ['get', 'rank'], ['step', ['zoom'], 1, 3, 3, 4, 5, 5, 10]],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'text-offset': [0.6, 0], 'text-anchor': 'left', 'text-optional': true },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 }
    });
  }

  // pins: [{ id, lonlat, label, state, selected }]
  setPins(pins) {
    const keep = new Set();
    for (const p of pins) {
      if (!p.lonlat) continue;
      keep.add(p.id);
      let mk = this.markers.get(p.id);
      if (!mk) {
        const el = document.createElement('div');
        mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(p.lonlat).addTo(this.map);
        mk.on('dragend', () => { const ll = mk.getLngLat(); this.onPinMove?.(p.id, [ll.lng, ll.lat]); });
        el.addEventListener('click', (e) => { e.stopPropagation(); this.onTap?.(null, null, p.id); });
        this.markers.set(p.id, mk);
      }
      mk.setLngLat(p.lonlat);
      const el = mk.getElement();
      el.className = `pin ${p.state || ''} ${p.selected ? 'selected' : ''}`;
      el.textContent = p.label ?? '';
    }
    for (const [id, mk] of this.markers) if (!keep.has(id)) { mk.remove(); this.markers.delete(id); }
  }

  bounds() { const b = this.map.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]; }
  flyTo(lonlat, zoom = 4) { this.map.flyTo({ center: lonlat, zoom: Math.max(this.map.getZoom(), zoom) }); }
  resize() { this.map.resize(); }
}

async function fetchJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
