"use strict";

// Keeps the terrain and paint colours objectively separated in CIE L*a*b*.
// Delta-E 76 is intentionally simple and deterministic: the thresholds prevent
// accidental near-duplicates while leaving room for familiar r/place hues.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "assets", "pixelbattle_palette.json");
const palette = JSON.parse(fs.readFileSync(file, "utf8"));

function rgb(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("invalid colour " + hex);
    return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
}

function lab(hex) {
    const linear = rgb(hex).map(value =>
        value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    const r = linear[0], g = linear[1], b = linear[2];
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const curve = value => value > 0.008856 ?
        Math.pow(value, 1 / 3) : 7.787 * value + 16 / 116;
    x = curve(x); y = curve(y); z = curve(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function delta(a, b) {
    const aa = lab(a), bb = lab(b);
    return Math.hypot(aa[0] - bb[0], aa[1] - bb[1], aa[2] - bb[2]);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(palette.paint.length === 18, "palette must contain 16 paint colours plus ocean/land");
assert(palette.paint.some(entry => entry.name === "brown"), "palette must retain brown");

const regularPaint = palette.paint.filter(entry => !entry.matchesTerrain);
const terrainPaint = palette.paint.filter(entry => entry.matchesTerrain);
const paint = regularPaint.map(entry => entry.hex.toLowerCase());
assert(regularPaint.length === 16, "palette must retain 16 non-terrain colours");
assert(new Set(paint).size === paint.length, "regular paint colours must be unique");
assert(!paint.includes(palette.ocean.toLowerCase()), "regular paint cannot equal ocean");
assert(!paint.includes(palette.land.toLowerCase()), "regular paint cannot equal land");
assert(terrainPaint.length === 2, "palette must expose ocean and land swatches");
for (const entry of terrainPaint) {
    assert(entry.hex.toLowerCase() === palette[entry.matchesTerrain].toLowerCase(),
        entry.name + " swatch must exactly match its terrain");
}

let nearestTerrain = { distance: Infinity, paint: "", terrain: "" };
for (const entry of regularPaint) {
    for (const terrain of ["ocean", "land"]) {
        const distance = delta(entry.hex, palette[terrain]);
        if (distance < nearestTerrain.distance) {
            nearestTerrain = { distance: distance, paint: entry.name, terrain: terrain };
        }
    }
}
assert(nearestTerrain.distance >= 19,
    "paint too close to terrain: " + nearestTerrain.paint + "/" + nearestTerrain.terrain);

let nearestPair = { distance: Infinity, a: "", b: "" };
for (let i = 0; i < regularPaint.length; i++) {
    for (let j = 0; j < i; j++) {
        const distance = delta(regularPaint[i].hex, regularPaint[j].hex);
        if (distance < nearestPair.distance) {
            nearestPair = {
                distance: distance,
                a: regularPaint[i].name,
                b: regularPaint[j].name
            };
        }
    }
}
assert(nearestPair.distance >= 16,
    "paint colours too close: " + nearestPair.a + "/" + nearestPair.b);

console.log("Pixel Battle palette passed: nearest terrain ΔE=" +
    nearestTerrain.distance.toFixed(1) + ", nearest paint pair ΔE=" +
    nearestPair.distance.toFixed(1));
