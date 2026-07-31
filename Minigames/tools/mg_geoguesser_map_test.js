"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pngPath = path.join(ROOT, "panorama", "images", "geoguesser", "world_map.png");
const assetDir = path.join(__dirname, "assets");
const controller = fs.readFileSync(
    path.join(ROOT, "panorama", "scripts", "mg_geoguesser.js"), "utf8");
const ui = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");
const citiesSrc = fs.readFileSync(
    path.join(ROOT, "panorama", "scripts", "mg_geoguesser_cities.generated.js"), "utf8");
const baseHud = fs.readFileSync(
    path.join(ROOT, "panorama", "layout", "base_hud.xml"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const png = fs.readFileSync(pngPath);
assert(png.length > 24 && png[0] === 137 && png[1] === 80, "GeoGuesser map must be a PNG");
// 2:1 is load-bearing: the server projects lon/lat linearly onto this image (geoLonX/geoLatY),
// so any other aspect silently skews every guess. 2048x1024 keeps the 8x zoom readable.
const mapW = png.readUInt32BE(16), mapH = png.readUInt32BE(20);
assert(mapW === 2048 && mapH === 1024,
    "GeoGuesser map must be 2048x1024 (2:1 equirectangular), got " + mapW + "x" + mapH);

// Every layer the builder draws must be committed, or a rebuild silently loses detail.
// ne_50m_urban_areas is deliberately NOT here any more: the natural-colour raster already carries
// settlement tone, and the grey wash on top only muddied the land colour it exists to show.
["ne_50m_admin_0_countries", "ne_50m_lakes", "ne_50m_rivers_lake_centerlines",
    "ne_110m_admin_1_states_provinces_lines",
    "ne_110m_populated_places"].forEach(function (layer) {
    const file = path.join(assetDir, layer + ".geojson");
    assert(fs.existsSync(file), "missing Natural Earth layer: " + layer);
});
const countries = JSON.parse(
    fs.readFileSync(path.join(assetDir, "ne_50m_admin_0_countries.geojson"), "utf8"));
assert(countries.type === "FeatureCollection" && countries.features.length >= 170,
    "GeoGuesser map source must contain Natural Earth country boundaries");

// Land colour comes from the natural-colour raster, not a flat fill. Two flat palettes (grey, then
// dark brown) were both rejected as monotone: one fill cannot show a continent's variety, whatever
// its hue. The committed downsample is what the map builder reads, so a clone never needs the
// 207 MiB source.
const rasterPath = path.join(assetDir, "ne2_natural_2048.png");
assert(fs.existsSync(rasterPath), "missing the natural-colour land raster (tools/build_ne_raster.js)");
const rasterPng = fs.readFileSync(rasterPath);
assert(rasterPng.readUInt32BE(16) === 2048 && rasterPng.readUInt32BE(20) === 1024,
    "the land raster must be 2048x1024 so it samples 1:1 against the map");
const builder = fs.readFileSync(path.join(__dirname, "build_geoguesser_map.js"), "utf8");
assert(/fillPolygon\(polygonRings\(polygon\), landColor\)/.test(builder),
    "country polygons must MASK the natural-colour raster, not take a flat fill");

assert(/images\/geoguesser\/world_map\.vtex/.test(controller),
    "the game board must use the dedicated GeoGuesser map");
// The picker card takes the SAME cards/<key>.vtex path as every other game. It used to
// special-case id 9 onto world_map.vtex because no card art existed; a map is not card art.
assert(/"s2r:\/\/panorama\/images\/cards\/" \+ g\.key \+ "\.vtex"/.test(ui) &&
    !/g\.id === 9/.test(ui),
    "the picker card must use cards/<key>.vtex, with no GeoGuesser special case");

// City names are Panorama Labels, not baked pixels (the PNG encoder has no font renderer), so
// the generated manifest must exist, be loaded BEFORE the controller, and carry usable records.
assert(/MG\.GeoCities = \[/.test(citiesSrc), "city manifest must publish MG.GeoCities");
const cityCount = (citiesSrc.match(/"n":/g) || []).length;
assert(cityCount >= 200, "expected the full populated-places set, got " + cityCount);
assert(/"x":[\d.]+,"y":[\d.]+,"r":\d/.test(citiesSrc),
    "city records must carry map fractions plus a SCALERANK for the zoom threshold");
const citiesInclude = baseHud.indexOf("mg_geoguesser_cities.generated");
const controllerInclude = baseHud.indexOf("mg_geoguesser.vjs_c");
assert(citiesInclude > 0 && controllerInclude > 0 && citiesInclude < controllerInclude,
    "base_hud.xml must load the city manifest before mg_geoguesser");

// Label decluttering. Two independent gates, and BOTH have to stay: rank alone left 68 names on a
// 500px world view (the Balkans became an unreadable pile), and no rank threshold can ever
// separate two cities 30px apart, so the overlap test is what actually fixes clusters.
assert(/function cityRankLimit\(\)[\s\S]{0,220}return 0;/.test(controller),
    "1x must show only rank-0 capitals (rank<=1 put 68 labels on the world view)");
assert(/placed\.push\(\[left, top, right, bottom\]\)/.test(controller) &&
    /left - CITY_PAD_X < other\[2\] && right \+ CITY_PAD_X > other\[0\]/.test(controller),
    "city labels must reject a box overlapping one already placed");
// An off-screen label must be culled BEFORE the overlap test, or at zoom it silently wins a slot
// from a name the player can actually see.
assert(/viewLeft = panX \* MAP_W \* mapZoomLevel/.test(controller) &&
    /right < viewLeft \|\| left > viewRight/.test(controller),
    "city labels outside the map window must be culled before the overlap test");

// Round timer: 60s, not the shared 25s default, and it must be released on destroy or its
// $.Schedule chain keeps firing at a deleted panel.
assert(/var ROUND_SECS = 60;/.test(controller) &&
    /roundTimer\.start\(onRoundTimeout, ROUND_SECS\)/.test(controller),
    "GeoGuesser must run a 60s per-round timer");
assert(/if \(selectedCell < 0\) selectedCell = 0;[\s\S]{0,120}submitGuess\(\);/.test(controller),
    "a timeout must submit a guess rather than stall the opponent's reveal");
assert(/if \(roundTimer\) roundTimer\.destroy\(\);/.test(controller),
    "the round timer must be destroyed with the controller");

// The map is now a light natural-colour raster, so the label ink and the markers must be the
// light-background set. Pale text on a black shadow was invisible over desert and ice.
const css = fs.readFileSync(path.join(ROOT, "panorama", "styles", "mg.css"), "utf8");
assert(/\.mg-geo-city\s*\{[^}]*color:\s*#26282b/.test(css) &&
    /\.mg-geo-city\s*\{[^}]*text-shadow:[^;]*#ffffff/.test(css),
    "city labels must be dark ink with a light halo for the light map");
assert(/\.mg-geo-marker\s*\{[^}]*border:\s*1px solid #ffffff/.test(css),
    "guess markers need a white ring to separate from the light map");

// The hit grid stays 64x32 PANELS; zoom is what makes a guess finer. FULL_W/H is the
// authoritative space and must equal GRID * MAP_ZOOM_MAX, and match the worker.
assert(/var GRID_W = 64, GRID_H = 32/.test(controller),
    "GeoGuesser hit grid must stay 64x32 panels");
assert(/var FULL_W = 512, FULL_H = 256;/.test(controller) &&
    /var MAP_W = 500, MAP_H = 250, MAP_ZOOM_MAX = 8;/.test(controller),
    "authoritative guess space must be GRID * MAP_ZOOM_MAX = 512x256");
const worker = fs.readFileSync(path.join(ROOT, "server", "worker.core.js"), "utf8");
assert(/const GEO_GRID_W = 512;/.test(worker) && /const GEO_GRID_H = 256;/.test(worker),
    "worker GEO_GRID_W/H must match the client's FULL_W/H");

console.log("GeoGuesser map passed: Natural Earth layers, 2048x1024, " +
    cityCount + " cities, 512x256 guess space");
