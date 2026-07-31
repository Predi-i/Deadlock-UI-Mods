"use strict";

// One-off: turn Natural Earth II's 10800x5400 natural-colour GeoTIFF into the committed
// 2048x1024 asset that tools/build_geoguesser_map.js samples for land colour.
//
//   node tools/build_ne_raster.js [path/to/NE2_50M_SR.tif]
//
// Why an intermediate asset rather than reading the TIFF at map-build time: the source is a
// 40 MiB download (167 MiB unpacked) that nobody should need in a clone, and the map builder must
// stay runnable offline. The downsample is deterministic, so committing its output loses nothing.
//
// The TIFF is uncompressed RGB, one strip per row, so no decoder library is needed - the rows are
// read straight out of the file. Both images are plate carree (equirectangular) with identical
// bounds, so downsampling is a plain box average with no reprojection.
//
// Only LAND colour is taken from this raster. NE2_50M_SR renders the ocean flat white; the map
// builder paints water itself and masks the raster to the land polygons.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const SOURCE = process.argv[2] ||
    path.join(__dirname, "assets", ".cache", "NE2_50M_SR", "NE2_50M_SR.tif");
const OUT = path.join(__dirname, "assets", "ne2_natural_2048.png");

const OUT_W = 2048;
const OUT_H = 1024;

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

if (!fs.existsSync(SOURCE)) {
    console.error("missing " + SOURCE + "\n" +
        "Download https://naciscdn.org/naturalearth/50m/raster/NE2_50M_SR.zip (public domain),\n" +
        "unzip it, and pass the .tif path as argv[2]. The committed PNG this writes is what the\n" +
        "map builder actually reads, so this only needs re-running to change the source raster.");
    process.exit(1);
}

const fd = fs.openSync(SOURCE, "r");
const header = Buffer.alloc(8);
fs.readSync(fd, header, 0, 8, 0);
const little = header[0] === 0x49;
if (!little && header[0] !== 0x4d) { console.error("not a TIFF"); process.exit(1); }

function read(offset, length) {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    return buffer;
}
const u16 = (b, o) => little ? b.readUInt16LE(o) : b.readUInt16BE(o);
const u32 = (b, o) => little ? b.readUInt32LE(o) : b.readUInt32BE(o);

const ifdOffset = u32(header, 4);
const count = u16(read(ifdOffset, 2), 0);
const entries = read(ifdOffset + 2, count * 12);

let width = 0, height = 0, samples = 0, compression = 0;
let stripTableOffset = 0, stripCount = 0, stripType = 0;
for (let i = 0; i < count; i++) {
    const e = i * 12;
    const tag = u16(entries, e), type = u16(entries, e + 2), n = u32(entries, e + 4);
    const inlineValue = type === 3 ? u16(entries, e + 8) : u32(entries, e + 8);
    if (tag === 256) width = inlineValue;
    else if (tag === 257) height = inlineValue;
    else if (tag === 259) compression = inlineValue;
    else if (tag === 277) samples = inlineValue;
    else if (tag === 273) { stripTableOffset = u32(entries, e + 8); stripCount = n; stripType = type; }
}
if (compression !== 1 || samples !== 3) {
    console.error("expected uncompressed RGB, got compression=" + compression +
        " samples=" + samples);
    process.exit(1);
}
if (stripCount !== height) {
    console.error(`expected one strip per row, got ${stripCount} for ${height} rows`);
    process.exit(1);
}

const offsetSize = stripType === 3 ? 2 : 4;
const stripTable = read(stripTableOffset, stripCount * offsetSize);
const rowOffset = (row) => stripType === 3
    ? stripTable.readUInt16LE(row * 2)
    : (little ? stripTable.readUInt32LE(row * 4) : stripTable.readUInt32BE(row * 4));

console.log(`source ${width}x${height} -> ${OUT_W}x${OUT_H}`);

// Box average. Accumulate one source row at a time so the 167 MiB image never sits in memory.
const sums = new Float64Array(OUT_W * OUT_H * 3);
const hits = new Uint32Array(OUT_W * OUT_H);
const columnBucket = new Uint16Array(width);
for (let x = 0; x < width; x++) columnBucket[x] = Math.min(OUT_W - 1, Math.floor(x * OUT_W / width));

for (let y = 0; y < height; y++) {
    const targetY = Math.min(OUT_H - 1, Math.floor(y * OUT_H / height));
    const row = read(rowOffset(y), width * 3);
    for (let x = 0; x < width; x++) {
        const target = (targetY * OUT_W + columnBucket[x]) * 3;
        const source = x * 3;
        sums[target] += row[source];
        sums[target + 1] += row[source + 1];
        sums[target + 2] += row[source + 2];
        hits[targetY * OUT_W + columnBucket[x]]++;
    }
    if (y % 500 === 0) process.stdout.write(`\r  row ${y}/${height}   `);
}
process.stdout.write(`\r  row ${height}/${height}   \n`);
fs.closeSync(fd);

const raw = Buffer.alloc((OUT_W * 3 + 1) * OUT_H);
for (let y = 0; y < OUT_H; y++) {
    const rowStart = y * (OUT_W * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < OUT_W; x++) {
        const i = y * OUT_W + x;
        const n = hits[i] || 1;
        raw[rowStart + 1 + x * 3] = Math.round(sums[i * 3] / n);
        raw[rowStart + 2 + x * 3] = Math.round(sums[i * 3 + 1] / n);
        raw[rowStart + 3 + x * 3] = Math.round(sums[i * 3 + 2] / n);
    }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT_W, 0);
ihdr.writeUInt32BE(OUT_H, 4);
ihdr[8] = 8;
ihdr[9] = 2;                     // colour type 2 = RGB, no alpha
const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
]);
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(ROOT, OUT)} (${(png.length / 1024).toFixed(0)} KiB)`);
