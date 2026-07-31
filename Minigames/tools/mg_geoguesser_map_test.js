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
["ne_50m_admin_0_countries", "ne_50m_lakes", "ne_50m_rivers_lake_centerlines",
    "ne_50m_urban_areas", "ne_110m_admin_1_states_provinces_lines",
    "ne_110m_populated_places"].forEach(function (layer) {
    const file = path.join(assetDir, layer + ".geojson");
    assert(fs.existsSync(file), "missing Natural Earth layer: " + layer);
});
const countries = JSON.parse(
    fs.readFileSync(path.join(assetDir, "ne_50m_admin_0_countries.geojson"), "utf8"));
assert(countries.type === "FeatureCollection" && countries.features.length >= 170,
    "GeoGuesser map source must contain Natural Earth country boundaries");

assert(/images\/geoguesser\/world_map\.vtex/.test(controller) &&
    /images\/geoguesser\/world_map\.vtex/.test(ui),
    "game and picker card must use the dedicated GeoGuesser map");

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
