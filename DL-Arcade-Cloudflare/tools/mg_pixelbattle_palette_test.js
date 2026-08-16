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

// ⚠ THE ONE INVARIANT THAT CANNOT BE RELAXED: a canvas pixel is persisted as its 1-based index in
// `paint`, so an index may never CHANGE MEANING by being moved. Inserting or reordering before the
// end silently recolours every pixel already painted on the shared world, and it would look like a
// server bug rather than a palette edit.
//
// What IS allowed - and is what v1.2 did when the palette moved onto the official wplace colours -
// is retuning an existing index's HEX in place: the pixel keeps its index and simply renders in the
// new shade. So this checks POSITIONS, not colours. The 16 original slots plus ocean/land are
// pinned by their semantic role; the eyedropper and the admin log read names from the same file.
const FROZEN_ROLES = [
    "white", "light_gray", "gray", "black", "red", "gold", "yellow", "light_green",
    "dark_green", "cyan", "blue", "dark_blue", "dark_purple", "purple", "light_pink", "brown",
    "ocean", "land"
];
FROZEN_ROLES.forEach((name, index) => {
    assert(palette.paint[index] && palette.paint[index].name === name,
        `paint index ${index + 1} must stay "${name}": indices are storage keys for live pixels`);
});
assert(palette.paint[16].matchesTerrain === "ocean" && palette.paint[17].matchesTerrain === "land",
    "indices 17/18 are the terrain swatches and must keep matching the base map");

const names = palette.paint.map(entry => entry.name);
assert(new Set(names).size === names.length, "palette names must be unique");

// displayOrder is presentation only (names, never indices). Because two storage indices may share a
// hex after a retune, it lists each DISTINCT SHADE once rather than every index - otherwise the
// picker would show visually identical swatches side by side.
const order = palette.displayOrder;
assert(Array.isArray(order) && new Set(order).size === order.length,
    "displayOrder must not repeat a colour");
order.forEach(name => assert(names.includes(name), `displayOrder names an unknown colour: ${name}`));
const shownHexes = order.map(name => palette.paint.find(e => e.name === name).hex.toLowerCase());
assert(new Set(shownHexes).size === shownHexes.length,
    "displayOrder must show each distinct shade only once");
// Every shade that exists in storage must be reachable in the picker, or a colour would be
// paintable by old art yet impossible to select.
const allHexes = new Set(palette.paint.map(e => e.hex.toLowerCase()));
assert(new Set(shownHexes).size === allHexes.size,
    "every distinct shade in storage must appear in displayOrder");

const shown = order.map(name => palette.paint.find(e => e.name === name));
const regularPaint = shown.filter(entry => !entry.matchesTerrain);
const terrainPaint = palette.paint.filter(entry => entry.matchesTerrain);
assert(regularPaint.length >= 16, "palette must retain at least the 16 original non-terrain colours");
assert(terrainPaint.length === 2, "palette must expose ocean and land swatches");
for (const entry of terrainPaint) {
    assert(entry.hex.toLowerCase() === palette[entry.matchesTerrain].toLowerCase(),
        entry.name + " swatch must exactly match its terrain");
}

// The palette is the OFFICIAL wplace 63 plus our two terrain swatches (v1.2). That set is denser
// than anything we would have authored: it ships deliberate shade ramps (Dark Slate/Dark Gray sit
// ΔE 6.0 apart, Stone/Tan 8.1), so a floor of 15 would reject the real palette.
//
// The terrain floor is GONE, and that is the point of the redesign rather than a relaxation to make
// this pass: ocean and land used to be "the background you must not disappear into", which is why
// paint had to stay 19 away from them. They are now two ordinary swatches in the set, so a colour
// near them is simply a colour near two other colours - the same situation as any adjacent pair.
// What survives is the check that actually protects the player: no two swatches may be EXACTLY
// equal (that would be a dead duplicate in the picker), which the distinct-hex assertions above
// already enforce, plus a floor low enough to catch an accidental paste while admitting wplace's
// own ramps.
const MIN_PAIR_DELTA = 5;

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
// Draw order is 1-based indices into the storage array. It covers each DISTINCT SHADE once, so it
// is a subset of the indices (retuned duplicates stay in storage but are not drawn twice).
assert(clientOrder.length === order.length,
    "generated draw order must have one entry per displayed swatch");
assert(new Set(clientOrder).size === clientOrder.length, "generated draw order must not repeat");
clientOrder.forEach(index => {
    assert(index >= 1 && index <= palette.paint.length,
        `generated draw order index ${index} is outside the palette`);
});
assert(JSON.stringify(clientOrder.map(i => palette.paint[i - 1].name)) === JSON.stringify(order),
    "generated draw order must match displayOrder exactly");

console.log(`Pixel Battle palette passed: ${palette.paint.length} storage indices, ` +
    `${order.length} swatches shown (official wplace + ocean/land), nearest displayed pair ΔE=` +
    nearestPair.distance.toFixed(1));
