"use strict";

// Builds the dedicated GeoGuesser guessing map from Natural Earth's public-domain vectors.
// No canvas/native dependency is needed: the small rasterizer below writes an RGBA PNG with
// Node's built-in zlib. (sharp/canvas/resvg are all absent, and adding a native dep for a
// once-per-asset build is not worth it.)
//
// Layer order is bottom -> top and deliberate: ocean, graticule, land, urban blush, lakes,
// rivers, state lines, country borders, coastline, city dots. The palette stays dark and
// low-contrast on purpose - the guess markers and reveal dots are drawn ON TOP of this in
// Panorama, so a bright or busy map would swallow them.
//
// City NAMES are not rasterised here (this encoder has no font renderer). The builder instead
// emits a manifest that mg_geoguesser.js turns into real Panorama Labels, which stay crisp at
// every zoom level. See panorama/scripts/mg_geoguesser_cities.generated.js.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(__dirname, "assets");
const OUTPUT = path.join(ROOT, "panorama", "images", "geoguesser", "world_map.png");
const CITIES_OUT = path.join(ROOT, "panorama", "scripts", "mg_geoguesser_cities.generated.js");

// 2048x1024 keeps the map readable at the client's 8x zoom: the 500px window then shows
// 2048/8 = 256 source px, a 2x upscale. At the old 1024x512 it was a 4x blur.
const W = 2048;
const H = 1024;
const pixels = Buffer.alloc(W * H * 4);

const OCEAN_TOP = [17, 28, 39];
const OCEAN_BOTTOM = [12, 22, 31];
const GRID = [67, 83, 96, 46];
const BORDERS = [114, 125, 132, 210];
const STATE_LINES = [104, 114, 120, 105];
const COAST = [159, 166, 163, 235];
const LAKE = [38, 58, 76, 255];
const RIVER = [70, 96, 116, 150];
const URBAN = [122, 126, 116, 130];
const CITY_CORE = [226, 232, 226, 255];
const CITY_RING = [40, 48, 52, 220];
const FRAME = [79, 96, 112, 255];
const LAND = [
    [79, 91, 91, 255],
    [84, 96, 92, 255],
    [75, 89, 91, 255],
    [89, 99, 91, 255],
    [78, 92, 96, 255],
    [91, 100, 95, 255],
    [82, 94, 88, 255]
];

function readLayer(name) {
    return JSON.parse(fs.readFileSync(path.join(ASSETS, name + ".geojson"), "utf8"));
}

function setPixel(x, y, color) {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    const a = color.length > 3 ? color[3] / 255 : 1;
    pixels[i] = Math.round(pixels[i] * (1 - a) + color[0] * a);
    pixels[i + 1] = Math.round(pixels[i + 1] * (1 - a) + color[1] * a);
    pixels[i + 2] = Math.round(pixels[i + 2] * (1 - a) + color[2] * a);
    pixels[i + 3] = 255;
}

function project(point) {
    return [
        (Number(point[0]) + 180) * W / 360,
        (90 - Number(point[1])) * H / 180
    ];
}

function drawLine(a, b, color) {
    let x0 = Math.round(a[0]), y0 = Math.round(a[1]);
    const x1 = Math.round(b[0]), y1 = Math.round(b[1]);
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
        setPixel(x0, y0, color);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

function polygonRings(rawRings) {
    return rawRings.map(ring => ring.map(project));
}

function fillPolygon(rings, color) {
    let minY = H - 1, maxY = 0;
    for (const ring of rings) {
        for (const point of ring) {
            minY = Math.min(minY, Math.floor(point[1]));
            maxY = Math.max(maxY, Math.ceil(point[1]));
        }
    }
    minY = Math.max(0, minY);
    maxY = Math.min(H - 1, maxY);
    for (let y = minY; y <= maxY; y++) {
        const scan = y + 0.5;
        const hits = [];
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const a = ring[j], b = ring[i];
                if ((a[1] > scan) === (b[1] > scan)) continue;
                hits.push(a[0] + (scan - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
            }
        }
        hits.sort((a, b) => a - b);
        for (let i = 0; i + 1 < hits.length; i += 2) {
            const from = Math.max(0, Math.ceil(hits[i]));
            const to = Math.min(W - 1, Math.floor(hits[i + 1]));
            for (let x = from; x <= to; x++) setPixel(x, y, color);
        }
    }
}

function drawRings(rings, color) {
    for (const ring of rings) {
        for (let i = 1; i < ring.length; i++) drawLine(ring[i - 1], ring[i], color);
    }
}

function geometries(feature) {
    const geometry = feature.geometry || {};
    if (geometry.type === "Polygon") return [geometry.coordinates];
    if (geometry.type === "MultiPolygon") return geometry.coordinates;
    return [];
}

// Rivers and the state-province layer are line geometries, not polygons.
function lineStrings(feature) {
    const geometry = feature.geometry || {};
    if (geometry.type === "LineString") return [geometry.coordinates];
    if (geometry.type === "MultiLineString") return geometry.coordinates;
    return [];
}

function drawLines(layer, color) {
    for (const feature of layer.features) {
        for (const line of lineStrings(feature)) {
            const points = line.map(project);
            for (let i = 1; i < points.length; i++) drawLine(points[i - 1], points[i], color);
        }
    }
}

function fillLayer(layer, color) {
    for (const feature of layer.features) {
        for (const polygon of geometries(feature)) fillPolygon(polygonRings(polygon), color);
    }
}

function drawDisc(cx, cy, radius, color) {
    const r2 = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= r2) setPixel(cx + dx, cy + dy, color);
        }
    }
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const name = Buffer.from(type, "ascii");
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    name.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
    return out;
}

function writePng() {
    const raw = Buffer.alloc((W * 4 + 1) * H);
    for (let y = 0; y < H; y++) {
        const row = y * (W * 4 + 1);
        raw[row] = 0;
        pixels.copy(raw, row + 1, y * W * 4, (y + 1) * W * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, png);
    return png.length;
}

// ── ocean + graticule ─────────────────────────────────────────────────────────────────
for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const shade = OCEAN_TOP.map((value, i) => Math.round(value * (1 - t) + OCEAN_BOTTOM[i] * t));
    for (let x = 0; x < W; x++) setPixel(x, y, shade);
}
for (let lon = -150; lon <= 150; lon += 30) {
    const x = Math.round((lon + 180) * W / 360);
    for (let y = 0; y < H; y++) setPixel(x, y, GRID);
}
for (let lat = -60; lat <= 60; lat += 30) {
    const y = Math.round((90 - lat) * H / 180);
    for (let x = 0; x < W; x++) setPixel(x, y, GRID);
}

// ── land, then the detail layers on top of it ─────────────────────────────────────────
const countries = readLayer("ne_50m_admin_0_countries");
for (const feature of countries.features) {
    const mapColor = Math.max(1, Math.min(7, Number(feature.properties.MAPCOLOR7) || 1));
    for (const polygon of geometries(feature)) fillPolygon(polygonRings(polygon), LAND[mapColor - 1]);
}

fillLayer(readLayer("ne_50m_urban_areas"), URBAN);
fillLayer(readLayer("ne_50m_lakes"), LAKE);
drawLines(readLayer("ne_50m_rivers_lake_centerlines"), RIVER);
drawLines(readLayer("ne_110m_admin_1_states_provinces_lines"), STATE_LINES);

for (const feature of countries.features) {
    for (const polygon of geometries(feature)) {
        const rings = polygonRings(polygon);
        drawRings(rings, BORDERS);
        if (rings[0]) drawRings([rings[0]], COAST);
    }
}

// ── cities: dots here, names emitted for the client to draw as Labels ─────────────────
const places = readLayer("ne_110m_populated_places");
const cities = [];
for (const feature of places.features) {
    const geometry = feature.geometry || {};
    if (geometry.type !== "Point") continue;
    const properties = feature.properties || {};
    const name = String(properties.NAME || "").trim();
    if (!name) continue;
    const rank = Math.max(0, Math.min(9, Number(properties.SCALERANK)));
    const lon = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const [px, py] = project([lon, lat]);
    // Bigger dot for a more prominent place, and a dark ring so it reads against pale land.
    const radius = rank <= 1 ? 3 : (rank <= 3 ? 2 : 1);
    drawDisc(Math.round(px), Math.round(py), radius + 1, CITY_RING);
    drawDisc(Math.round(px), Math.round(py), radius, CITY_CORE);
    cities.push({
        n: name,
        // Fractions of the map, so the client is independent of this file's pixel size.
        x: Number(((lon + 180) / 360).toFixed(5)),
        y: Number(((90 - lat) / 180).toFixed(5)),
        r: rank
    });
}
cities.sort((a, b) => (a.r - b.r) || (a.n < b.n ? -1 : 1));

for (let x = 0; x < W; x++) {
    setPixel(x, 0, FRAME);
    setPixel(x, H - 1, FRAME);
}
for (let y = 0; y < H; y++) {
    setPixel(0, y, FRAME);
    setPixel(W - 1, y, FRAME);
}

const bytes = writePng();

const generated = '"use strict";\n\n' +
    "// GENERATED by tools/build_geoguesser_map.js - do not edit by hand.\n" +
    "// Natural Earth 1:110m populated places (public domain). x/y are fractions of the world\n" +
    "// map (0..1, x from -180deg, y from +90deg); r is SCALERANK, lower = more prominent.\n" +
    "// mg_geoguesser.js draws these as Panorama Labels over the map so the text stays crisp at\n" +
    "// every zoom level - this project's PNG encoder has no font renderer.\n" +
    "(function () {\n" +
    "    var MG = $.MG = $.MG || {};\n" +
    "    if (MG.GeoCities) return;\n" +
    "    MG.GeoCities = " + JSON.stringify(cities) + ";\n" +
    "})();\n";
fs.writeFileSync(CITIES_OUT, generated);

console.log(path.relative(ROOT, OUTPUT) + " " + W + "x" + H + " " + Math.round(bytes / 1024) + " KiB");
console.log(path.relative(ROOT, CITIES_OUT) + " " + cities.length + " cities");
