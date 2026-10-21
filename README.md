# Map Stylizer

Turn any map image into clean, named vector layers, then restyle it for video.
Runs entirely in the browser, including Safari on iPad. Nothing to install.

**App:** https://mdiamond95.github.io/map-stylizer/ (add it to the Home Screen from Safari's share menu to use it like an app, offline too).

## How it works

Instead of guessing lines from pixels, the tool works out where on Earth your map is,
then pulls the matching geometry from clean reference data (Natural Earth). Only things the
reference data does not have, like a shaded empire or a drawn route, are traced from the image.

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

Pushing to `main` builds the site and publishes it to the `gh-pages` branch.
Styles are small JSON files in `src/styles/`; reference data is rebuilt with `tools/build-data.sh`.

## Built on

- [Allmaps](https://allmaps.org) `@allmaps/transform` for the control point maths (MIT)
- [d3-geo](https://d3js.org/d3-geo) and d3-geo-projection for projections (ISC)
- [MapLibre GL JS](https://maplibre.org) for the reference map (BSD-3-Clause)
- [VTracer](https://github.com/visioncortex/vtracer) via `vtracer-wasm` for colour tracing (MIT)
- [TopoJSON](https://github.com/topojson/topojson-client) (ISC), and mapshaper (MPL-2.0, build time only)
- [Natural Earth](https://www.naturalearthdata.com) vector data (public domain)

No GPL code is included.
