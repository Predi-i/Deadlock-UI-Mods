"use strict";

// Minimal Mapbox Vector Tile (protobuf) reader. Dev-only, never shipped in the VPK.
//
// Why hand-rolled: this repo has exactly one devDependency (eslint) and the worker runs on a
// 2 GiB VPS with no build step, so pulling @mapbox/vector-tile + pbf just to run an offline
// sweep is not worth the supply-chain surface. The MVT spec is small enough to implement.
//
// Only the subset the GeoGuesser pool builder needs: layer names, feature geometry types,
// decoded point/line coordinates in tile-local units, and scalar tag values.
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

// ── protobuf primitives ────────────────────────────────────────────────────────────────────
class Reader {
    constructor(buffer, end) {
        this.buf = buffer;
        this.pos = 0;
        this.end = end === undefined ? buffer.length : end;
    }

    varint() {
        let result = 0, shift = 0, byte;
        do {
            if (this.pos >= this.end) throw new Error("varint overrun");
            byte = this.buf[this.pos++];
            // Bit 7 is the continuation flag; the low 7 bits are payload, little-endian.
            result += (byte & 0x7f) * Math.pow(2, shift);
            shift += 7;
        } while (byte >= 0x80);
        return result;
    }

    // Protobuf tag = (fieldNumber << 3) | wireType.
    field() {
        const tag = this.varint();
        return { no: tag >> 3, wire: tag & 0x07 };
    }

    bytes() {
        const length = this.varint();
        const start = this.pos;
        this.pos += length;
        if (this.pos > this.end) throw new Error("length-delimited overrun");
        return this.buf.subarray(start, this.pos);
    }

    string() {
        return Buffer.from(this.bytes()).toString("utf8");
    }

    double() {
        const value = this.buf.readDoubleLE(this.pos);
        this.pos += 8;
        return value;
    }

    float() {
        const value = this.buf.readFloatLE(this.pos);
        this.pos += 4;
        return value;
    }

    fixed64() {
        const lo = this.buf.readUInt32LE(this.pos);
        const hi = this.buf.readUInt32LE(this.pos + 4);
        this.pos += 8;
        return hi * 4294967296 + lo;
    }

    fixed32() {
        const value = this.buf.readUInt32LE(this.pos);
        this.pos += 4;
        return value;
    }

    // Skip a field whose contents we do not care about, so unknown fields never desync the parse.
    skip(wire) {
        if (wire === 0) { this.varint(); return; }
        if (wire === 1) { this.pos += 8; return; }
        if (wire === 2) { this.bytes(); return; }
        if (wire === 5) { this.pos += 4; return; }
        throw new Error(`unsupported wire type ${wire}`);
    }
}

function zigzag(value) {
    // MVT geometry deltas are zigzag encoded so small negatives stay in one byte.
    return (value >> 1) ^ (-(value & 1));
}

// ── MVT messages ───────────────────────────────────────────────────────────────────────────
function readValue(buffer) {
    const reader = new Reader(buffer);
    let value = null;
    while (reader.pos < reader.end) {
        const f = reader.field();
        if (f.no === 1) value = reader.string();
        else if (f.no === 2) value = reader.float();
        else if (f.no === 3) value = reader.double();
        else if (f.no === 4) value = reader.varint();          // int64
        else if (f.no === 5) value = reader.varint();          // uint64
        else if (f.no === 6) value = zigzag(reader.varint());  // sint64
        else if (f.no === 7) value = reader.varint() !== 0;    // bool
        else reader.skip(f.wire);
    }
    return value;
}

function readFeature(buffer) {
    const reader = new Reader(buffer);
    const feature = { id: null, type: 0, tags: [], geometry: [] };
    while (reader.pos < reader.end) {
        const f = reader.field();
        if (f.no === 1) feature.id = reader.varint();
        else if (f.no === 2) {
            // Packed tag list: alternating key index / value index.
            const packed = new Reader(reader.bytes());
            while (packed.pos < packed.end) feature.tags.push(packed.varint());
        } else if (f.no === 3) feature.type = reader.varint();
        else if (f.no === 4) {
            const packed = new Reader(reader.bytes());
            while (packed.pos < packed.end) feature.geometry.push(packed.varint());
        } else reader.skip(f.wire);
    }
    return feature;
}

function readLayer(buffer) {
    const reader = new Reader(buffer);
    const layer = { name: "", extent: 4096, features: [], keys: [], values: [] };
    while (reader.pos < reader.end) {
        const f = reader.field();
        if (f.no === 1) layer.name = reader.string();
        else if (f.no === 2) layer.features.push(readFeature(reader.bytes()));
        else if (f.no === 3) layer.keys.push(reader.string());
        else if (f.no === 4) layer.values.push(readValue(reader.bytes()));
        else if (f.no === 5) layer.extent = reader.varint();
        else reader.skip(f.wire);
    }
    return layer;
}

function readTile(buffer) {
    const reader = new Reader(buffer);
    const layers = [];
    while (reader.pos < reader.end) {
        const f = reader.field();
        if (f.no === 3) layers.push(readLayer(reader.bytes()));
        else reader.skip(f.wire);
    }
    return layers;
}

// ── geometry ───────────────────────────────────────────────────────────────────────────────
// Decode the command/parameter stream into rings of tile-local points. A MoveTo starts a new
// ring, so a LineString sequence and a multipoint both come back as an array of arrays.
function decodeGeometry(commands) {
    const rings = [];
    let current = [];
    let x = 0, y = 0, i = 0;
    while (i < commands.length) {
        const header = commands[i++];
        const id = header & 0x07;
        const count = header >> 3;
        if (id === 7) {                       // ClosePath carries no parameters
            if (current.length) { rings.push(current); current = []; }
            continue;
        }
        for (let n = 0; n < count; n++) {
            x += zigzag(commands[i++]);
            y += zigzag(commands[i++]);
            if (id === 1) {                   // MoveTo begins a new ring
                if (current.length) rings.push(current);
                current = [[x, y]];
            } else {                          // LineTo extends the current ring
                current.push([x, y]);
            }
        }
    }
    if (current.length) rings.push(current);
    return rings;
}

// Tile-local units -> WGS84. Web Mercator inverse; y is flipped because tile rows count down.
function tileToLonLat(z, tileX, tileY, px, py, extent) {
    const scale = extent * Math.pow(2, z);
    const worldX = tileX * extent + px;
    const worldY = tileY * extent + py;
    const lon = worldX / scale * 360 - 180;
    const n = Math.PI - 2 * Math.PI * worldY / scale;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return [lon, lat];
}

// One convenience entry point: buffer -> features with real coordinates and named properties.
function parse(buffer, z, tileX, tileY) {
    const out = [];
    for (const layer of readTile(buffer)) {
        for (const feature of layer.features) {
            const properties = {};
            for (let i = 0; i + 1 < feature.tags.length; i += 2) {
                const key = layer.keys[feature.tags[i]];
                if (key !== undefined) properties[key] = layer.values[feature.tags[i + 1]];
            }
            const rings = decodeGeometry(feature.geometry).map((ring) => {
                return ring.map((point) => {
                    return tileToLonLat(z, tileX, tileY, point[0], point[1], layer.extent);
                });
            });
            out.push({
                layer: layer.name,
                id: feature.id,
                type: feature.type,      // 1 point, 2 linestring, 3 polygon
                properties: properties,
                rings: rings
            });
        }
    }
    return out;
}

// Web Mercator tile index for a coordinate, so a sweep can aim tiles at a bbox.
function lonLatToTile(z, lon, lat) {
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180) / 360 * n);
    const rad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
    return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

module.exports = { parse, readTile, decodeGeometry, tileToLonLat, lonLatToTile };
