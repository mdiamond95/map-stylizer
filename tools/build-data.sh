#!/usr/bin/env bash
# Rebuilds public/data/*.topojson from Natural Earth (public domain).
# Countries and provinces are simplified together so their shared edges stay identical.
set -euo pipefail
SRC=${1:-ne-src}
OUT=$(dirname "$0")/../public/data
MS="npx mapshaper"
B=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
mkdir -p "$SRC" "$OUT"
for f in ne_10m_admin_0_countries ne_10m_admin_1_states_provinces ne_50m_lakes ne_50m_rivers_lake_centerlines \
         ne_50m_populated_places_simple ne_10m_lakes ne_10m_rivers_lake_centerlines ne_10m_populated_places_simple; do
  [ -f "$SRC/$f.geojson" ] || curl -sSf -o "$SRC/$f.geojson" "$B/$f.geojson"
done
build() { # name simplify lakes rivers places
  $MS -i combine-files "$SRC/ne_10m_admin_0_countries.geojson" "$SRC/ne_10m_admin_1_states_provinces.geojson" \
    -rename-layers countries,provinces \
    -filter-fields target=countries NAME,ADM0_A3,ISO_A2,LABEL_X,LABEL_Y,MAPCOLOR7,CONTINENT \
    -filter-fields target=provinces name,adm0_a3,iso_3166_2,latitude,longitude \
    -simplify "$2" keep-shapes target=countries,provinces \
    -i "$SRC/$3.geojson" name=lakes -filter-fields name,scalerank \
    -i "$SRC/$4.geojson" name=rivers -filter-fields name,scalerank \
    -i "$SRC/$5.geojson" name=places -filter-fields name,adm0name,pop_max,scalerank,featurecla \
    -o "$OUT/$1.topojson" format=topojson target=* quantization=200000
}
build ne-medium 6% ne_50m_lakes ne_50m_rivers_lake_centerlines ne_50m_populated_places_simple
build ne-high 25% ne_10m_lakes ne_10m_rivers_lake_centerlines ne_10m_populated_places_simple
