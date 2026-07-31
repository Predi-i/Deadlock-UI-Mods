# Natural Earth map source

Natural Earth raster and vector map data are in the **public domain** — no attribution
is required and redistribution is unrestricted:
https://www.naturalearthdata.com/about/terms-of-use/

## Pixel Battle base

`ne_110m_land.geojson` is the Natural Earth 1:110m land polygon dataset, converted to
GeoJSON by `martynafford/natural-earth-geojson`:
https://github.com/martynafford/natural-earth-geojson/blob/master/110m/physical/ne_110m_land.json

## GeoGuesser guess map

Built by `tools/build_geoguesser_map.js` into a 2048×1024 equirectangular PNG plus the
generated city manifest. All layers come from `nvkelso/natural-earth-vector`
(https://github.com/nvkelso/natural-earth-vector/tree/master/geojson):

| File | Drawn as |
|---|---|
| `ne_50m_admin_0_countries.geojson` | land fill, country borders, coastline |
| `ne_50m_land.geojson` | reference land outline |
| `ne_50m_lakes.geojson` | lakes |
| `ne_50m_rivers_lake_centerlines.geojson` | rivers |
| `ne_50m_urban_areas.geojson` | urban blush |
| `ne_110m_admin_1_states_provinces_lines.geojson` | state / province lines |
| `ne_110m_populated_places.geojson` | city dots + the label manifest |
| `ne_110m_admin_0_countries.geojson` | retained from the earlier 1:110m map build |

Note on what was NOT used: OpenStreetMap. Its data is ODbL and the tile usage policy
forbids proxying tiles or embedding them in an application, so it cannot ship in the VPK.
Natural Earth is public domain and carries no such restriction.
