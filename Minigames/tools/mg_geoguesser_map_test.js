"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pngPath = path.join(ROOT, "panorama", "images", "geoguesser", "world_map.png");
const geoPath = path.join(__dirname, "assets", "ne_110m_admin_0_countries.geojson");
const controller = fs.readFileSync(
    path.join(ROOT, "panorama", "scripts", "mg_geoguesser.js"), "utf8");
const ui = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const png = fs.readFileSync(pngPath);
assert(png.length > 24 && png[0] === 137 && png[1] === 80, "GeoGuesser map must be a PNG");
assert(png.readUInt32BE(16) === 1024 && png.readUInt32BE(20) === 512,
    "GeoGuesser map must keep the authoritative 2:1 equirectangular alignment");

const countries = JSON.parse(fs.readFileSync(geoPath, "utf8"));
assert(countries.type === "FeatureCollection" && countries.features.length >= 170,
    "GeoGuesser map source must contain Natural Earth country boundaries");
assert(/images\/geoguesser\/world_map\.vtex/.test(controller) &&
    /images\/geoguesser\/world_map\.vtex/.test(ui),
    "game and picker card must use the dedicated GeoGuesser map");
assert(/var GRID_W = 64, GRID_H = 32/.test(controller),
    "GeoGuesser must use the finer 64x32 guess grid");

console.log("GeoGuesser map passed: Natural Earth countries, 1024x512, dedicated asset");
