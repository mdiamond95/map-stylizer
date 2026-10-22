# Map Stylizer

Turn any map image into clean, named vector layers, then restyle it for video.
Runs entirely in the browser, including Safari on iPad. Nothing to install.

**App:** https://mdiamond95.github.io/map-stylizer/ (add it to the Home Screen from Safari's share menu to use it like an app, offline too).

## How it works

Instead of guessing lines from pixels, the tool works out where on Earth your map is,
then pulls the matching geometry from clean reference data: Natural Earth for world and country
maps, OpenStreetMap for city and town maps. Only things the reference data does not have, like a
shaded empire or a drawn route, are traced from the image.

1. **Pin.** Open a map image. Tap a spot on it, then the same spot on the reference map
   (or search a city; cities snap to their exact position). Four or more points spread
   across the map is enough. **Detect projection** tries 19 projections, tunes each one's
   centre and standard parallels to your points, and picks the one that fits.
   Each point turns green, amber or red by how well it agrees with the others.
2. **Check.** Reference borders, coasts, provinces, rivers, lakes and cities are drawn over your
   map. Tap a country to highlight it, fade it, or rename its label. **Trace a colour** turns
   any colour on the map into vector shapes (VTracer).
3. **Style and export.** Pick a style (Clean explainer, Vintage atlas, Blueprint/neon, Minimal),
   frame it as the whole image or a 16:9 video frame, and export:
   - **Layered SVG** with one group per layer and one named path per country (`country-CAN`, `label-CAN`…), for After Effects or Illustrator
   - **PNG** at 1440p or 4K
   - **GeoJSON** of the countries in view, with highlight/fade state and the control points

Projects autosave in the browser. **Save project** writes a `.mapstyle.json` file (image included)
that you can keep in this repo or the Files app and open again on any device.

## Lines straight from the scan

To keep the map's own drawing rather than redraw it from map data, open the image, go to **Check**
and tap **Pull lines from scan**. No points are needed. The drawn lines come out as clean strokes,
with lettering, colour fills and the paper left out, and each ink colour becomes its own layer (for
example the street drawing and a red reference grid). Untick a colour to leave it out. In **Style &
export**, **Draw** picks the scan lines, the map data, or both. The Layered SVG has one group per
ink colour (`scan-lines-1`, `scan-lines-2`…), as strokes you can recolour or draw on in your editor.

**Clean lettering off lines** (on by default) strips words, numbers and route shields that touch
the lines before they are traced, so streets don't zigzag up through the letters. Where lettering
fills a street completely, a stretch of the street's edge can go with it; untick the box and pull
again if you'd rather keep those and tidy by hand.

The **Combined** method also fills in gaps on its own: a street edge hidden under a name or a
tram route, a corner left open, a block missing a side, or a whole block that only closes up once
the coloured route over its edge counts as edge. It only fills a gap where ink runs under it, so
a street crossing stays open. Its guesses go in **Filled-in lines**, purple so they're easy to
check; tap away any that are wrong, then recolour the layer to match the streets. Filled-in lines
are always straight. It also evens out the edges using the usual width of the roads as a yardstick:
small jogs where lettering touched an edge are straightened, hooked line ends are trimmed, and
short stubs poking into a road are moved to Unsure lines.

Water is found by its colour as well as its outline. **Water** is a solid layer of filled shapes
(harbour, lakes, with islands and piers left as holes) that you can recolour in your editor, while
**Water edge** keeps the shoreline as strokes. Lettering printed on the water, a fold or a grid line
across it, and a lake tip that reads darker than the paper around it all count as water, so a lake
comes out as one clean shape.

**Tidy by hand** (under the colour list) cleans up whatever is left: tap a leftover squiggle to
delete that line, or drag one finger to rub out bits of line with the eraser. Two fingers still
move and zoom, and **Undo** steps back. Edits are saved with the project and go into the export.

## City and town maps

When the pinned map covers less than about 60 km, the **Streets** detail level is chosen
automatically: roads (by class), railways, water, parks, buildings, neighbourhood names and
street names come from OpenStreetMap via [OpenFreeMap](https://openfreemap.org)'s free vector
tiles. The reference map shows streets too, and the search box finds streets, landmarks and
addresses (OpenStreetMap Nominatim), so you can pin street corners. Both need a connection;
the **Simple** reference map works offline. Exports credit © OpenStreetMap contributors.

For old maps, **Only streets drawn on this map** (on by default in the Check step) compares each
OpenStreetMap street with the ink on your scan and leaves out the ones the map doesn't show, such as
modern highways, bridges and suburbs. Left-out streets show dashed in the Check view; raise
**Strictness** to drop more, lower it to keep more. Street and neighbourhood names follow the kept streets.

Old city maps are rarely true to scale. If the points disagree, set **Fit** to **Rubber sheet**
and add more points, especially near the edges.

## Fit options

| Fit | Use it for |
| --- | --- |
| Affine | Most printed or digital maps once the right projection is chosen |
| Shift, scale, rotate | Quick start with only 2 points |
| Perspective | A photo of a map taken at an angle |
| Gentle curve | Slight paper curl or scanner warp |
| Rubber sheet | Old or hand-drawn maps that fit no projection; shows a check error from leave-one-out |

## Running it in a Claude session

The same pipeline runs in Node, so a Claude session can render saved projects:

```sh
npm install
node tools/render.mjs my-map.mapstyle.json --style vintage-atlas --height 2160
```

## Development

```sh
npm install
npm run dev      # local server
npm test         # georeferencing and rendering checks
npm run build    # static site in dist/
```

Pushing to `main` runs the tests, builds the site and deploys it to GitHub Pages (Settings → Pages → Source: GitHub Actions).
Styles are small JSON files in `src/styles/`; reference data is rebuilt with `tools/build-data.sh`.

## Built on

- [Allmaps](https://allmaps.org) `@allmaps/transform` for the control point maths (MIT)
- [d3-geo](https://d3js.org/d3-geo) and d3-geo-projection for projections (ISC)
- [MapLibre GL JS](https://maplibre.org) for the reference map (BSD-3-Clause)
- [VTracer](https://github.com/visioncortex/vtracer) via `vtracer-wasm` for colour tracing (MIT)
- [TopoJSON](https://github.com/topojson/topojson-client) (ISC), and mapshaper (MPL-2.0, build time only)
- [Natural Earth](https://www.naturalearthdata.com) vector data (public domain)
- [OpenStreetMap](https://www.openstreetmap.org/copyright) data (ODbL) via [OpenFreeMap](https://openfreemap.org) tiles and Nominatim search
- `@mapbox/vector-tile` and `pbf` for reading tiles (BSD-3-Clause)

No GPL code is included.
