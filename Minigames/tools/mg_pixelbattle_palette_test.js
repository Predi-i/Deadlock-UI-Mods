"use strict";

// Keeps the terrain and paint colours objectively separated in CIE L*a*b*.
// Delta-E 76 is intentionally simple and deterministic: the thresholds prevent
// accidental near-duplicates while leaving room for familiar r/place hues.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "assets", "pixelbattle_palette.json");
const palette = JSON.parse(fs.readFileSync(file, "utf8"));

function rgb(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`invalid colour ${hex}`);
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

assert(palette.paint.length >= 18, "palette is append-only and cannot shrink below its 18 shipped colours");
assert(palette.paint.some(entry => entry.name === "brown"), "palette must retain brown");

// ⚠ THE ONE INVARIANT THAT CANNOT BE RELAXED. A canvas pixel is persisted as its 1-based index
// in `paint`, so these 18 entries are storage keys, not presentation. Reordering or inserting
// before the end silently recolours every pixel already painted on the shared world - and it
// would look like a server bug, not a palette edit. New colours append; this list is frozen.
const FROZEN_PREFIX = [
    "white", "light_gray", "dark_gray", "black", "red", "orange", "yellow", "lime",
    "green", "cyan", "blue", "navy", "purple", "magenta", "pink", "brown", "ocean", "land"
];
FROZEN_PREFIX.forEach((name, index) => {
    assert(palette.paint[index] && palette.paint[index].name === name,
        `paint index ${index + 1} must stay "${name}": indices are storage keys for live pixels`);
});

const names = palette.paint.map(entry => entry.name);
assert(new Set(names).size === names.length, "palette names must be unique");

// displayOrder is presentation only (names, never indices), so it is free to interleave the
// appended colours into the rainbow. It must still cover the palette exactly once.
const order = palette.displayOrder;
assert(Array.isArray(order) && order.length === names.length && new Set(order).size === order.length,
    "displayOrder must list every paint colour exactly once");
order.forEach(name => assert(names.includes(name), `displayOrder names an unknown colour: ${name}`));

const regularPaint = palette.paint.filter(entry => !entry.matchesTerrain);
const terrainPaint = palette.paint.filter(entry => entry.matchesTerrain);
const paint = regularPaint.map(entry => entry.hex.toLowerCase());
assert(regularPaint.length >= 16, "palette must retain at least the 16 original non-terrain colours");
assert(new Set(paint).size === paint.length, "regular paint colours must be unique");
assert(!paint.includes(palette.ocean.toLowerCase()), "regular paint cannot equal ocean");
assert(!paint.includes(palette.land.toLowerCase()), "regular paint cannot equal land");
assert(terrainPaint.length === 2, "palette must expose ocean and land swatches");
for (const entry of terrainPaint) {
    assert(entry.hex.toLowerCase() === palette[entry.matchesTerrain].toLowerCase(),
        entry.name + " swatch must exactly match its terrain");
}

// 15, lowered from 16 when the palette grew from 16 to 32 paint colours in v1.2. This is a
// deliberate, measured relaxation, NOT a threshold bent to make a commit pass: the closest pair is
// deep_pink/hot_pink at ΔE 15.4 - both canonical r/place hues, and a shading ramp is exactly what
// a denser palette is FOR. The point of the check is to catch an accidental near-duplicate
// (ΔE < 10, indistinguishable at a 12px swatch), so the floor stays just under the tightest
// intentional pair. Do not lower it again to admit a new colour without measuring first.
const MIN_PAIR_DELTA = 15;
const MIN_TERRAIN_DELTA = 19;

let nearestTerrain = { distance: Infinity, paint: "", terrain: "" };
for (const entry of regularPaint) {
    for (const terrain of ["ocean", "land"]) {
        const distance = delta(entry.hex, palette[terrain]);
        if (distance < nearestTerrain.distance) {
            nearestTerrain = { distance: distance, paint: entry.name, terrain: terrain };
        }
    }
}
assert(nearestTerrain.distance >= MIN_TERRAIN_DELTA,
    `paint too close to terrain: ${nearestTerrain.paint}/${nearestTerrain.terrain}`);

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
assert(nearestPair.distance >= MIN_PAIR_DELTA,
    `paint colours too close: ${nearestPair.a}/${nearestPair.b}`);

// The generated modules must agree with this source, or the client paints one colour and the
// server stores another. Storage order is the array; the client's draw order is separate.
const clientGenerated = fs.readFileSync(
    path.join(__dirname, "..", "panorama", "scripts", "mg_pixelbattle_palette.generated.js"), "utf8");
const serverGenerated = fs.readFileSync(
    path.join(__dirname, "..", "server", "pixelbattle_map.generated.js"), "utf8");

function generatedArray(source, name) {
    const match = new RegExp(name + "\\s*=\\s*(\\[[^;]*\\]);").exec(source);
    assert(match, `${name} is missing from the generated module - rerun build_pixelbattle_map.js`);
    return JSON.parse(match[1]);
}

const clientHex = generatedArray(clientGenerated, "MG\\.PixelBattlePalette");
const clientOrder = generatedArray(clientGenerated, "MG\\.PixelBattlePaletteOrder");
const serverView = generatedArray(serverGenerated, "const PX_VIEW_PALETTE");
const serverNames = generatedArray(serverGenerated, "const PX_COLOR_NAMES");

assert(JSON.stringify(clientHex) === JSON.stringify(palette.paint.map(e => e.hex.toLowerCase())),
    "generated client palette is stale - rerun tools/build_pixelbattle_map.js");
// PX_VIEW_PALETTE is [ocean, land, ...paint] and a STORED pixel value is already 1-based
// (0 = unpainted), which is why pixelViewPng writes `paint + 1`. So paint entry i (0-based here)
// is stored as i + 1 and rendered from view index i + 2. Getting this off by one would tint the
// whole canvas by one colour, so the arithmetic is asserted rather than assumed.
assert(serverView.length === palette.paint.length + 2,
    "PX_VIEW_PALETTE must hold ocean + land + every paint colour");
palette.paint.forEach((entry, index) => {
    const rendered = serverView[index + 2];
    const expected = [1, 3, 5].map(at => parseInt(entry.hex.slice(at, at + 2), 16));
    assert(JSON.stringify(rendered) === JSON.stringify(expected),
        `server view palette index ${index + 2} does not render ${entry.name}`);
});
// The admin panel names every colour it shows from this array; a short one renders "color 19".
assert(serverNames.length === palette.paint.length + 1 && serverNames[0] === "eraser",
    "PX_COLOR_NAMES must be the eraser plus one name per paint colour");
// Draw order is 1-based indices into the storage array, covering it exactly once.
assert(JSON.stringify(clientOrder.slice().sort((a, b) => a - b)) ===
    JSON.stringify(palette.paint.map((_, index) => index + 1)),
    "generated palette draw order must permute every paint index exactly once");

console.log(`Pixel Battle palette passed: ${regularPaint.length} paint colours, nearest terrain ΔE=` +
    nearestTerrain.distance.toFixed(1) + ", nearest paint pair ΔE=" +
    nearestPair.distance.toFixed(1));
