"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function usage() {
    console.error("Usage: PIXEL_MIGRATION_SECRET=<secret> node tools/mg_pixelbattle_import.js <export.json> <https://worker-host>");
    process.exit(2);
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function unfilterIndexedPng(bytes) {
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Not a PNG");
    let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9];
        } else if (type === "IDAT") idat.push(data);
        else if (type === "IEND") break;
        offset += 12 + length;
    }
    if (width !== 512 || height !== 256 || bitDepth !== 8 || colorType !== 3) {
        throw new Error(`Unexpected canvas PNG format ${width}x${height}, depth ${bitDepth}, type ${colorType}`);
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(width * height), previous = Buffer.alloc(width);
    let source = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[source++], row = Buffer.alloc(width);
        for (let x = 0; x < width; x++) {
            const encoded = raw[source++], left = x ? row[x - 1] : 0, up = previous[x];
            const upLeft = x ? previous[x - 1] : 0;
            if (filter === 0) row[x] = encoded;
            else if (filter === 1) row[x] = (encoded + left) & 255;
            else if (filter === 2) row[x] = (encoded + up) & 255;
            else if (filter === 3) row[x] = (encoded + Math.floor((left + up) / 2)) & 255;
            else if (filter === 4) {
                const p = left + up - upLeft, pa = Math.abs(p - left);
                const pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
                row[x] = (encoded + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
            } else throw new Error(`Unsupported PNG filter ${filter}`);
        }
        row.copy(pixels, y * width); row.copy(previous);
    }
    return pixels;
}

const manifestArg = process.argv[2], originArg = process.argv[3];
if (!manifestArg || !originArg) usage();
const secret = String(process.env.PIXEL_MIGRATION_SECRET || "");
if (secret.length < 32) throw new Error("PIXEL_MIGRATION_SECRET must contain at least 32 characters");
const origin = String(originArg).replace(/\/$/, "");
if (!/^https:\/\/[^/]+$/i.test(origin) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error("Worker origin must be one HTTPS host (or local 127.0.0.1)");
}
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestArg), "utf8"));
if (manifest.format !== "dl-arcade-pixelbattle-v1" || !Array.isArray(manifest.records) ||
    manifest.total !== manifest.records.length) throw new Error("Invalid Pixel Battle export manifest");
const id = sha256(Buffer.from(JSON.stringify(manifest.records)));
if (id !== manifest.id) throw new Error("Manifest record hash does not match its migration id");

async function call(body) {
    const response = await fetch(origin + "/internal/pixel-migration", {
        method: "POST",
        headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Migration HTTP ${response.status}: ${result.error || "unknown error"}`);
    return result;
}

(async () => {
    let status = await call({ action: "begin", id, total: manifest.total });
    const chunkSize = 64;
    for (let start = status.next; start < manifest.records.length; start += chunkSize) {
        const records = manifest.records.slice(start, start + chunkSize);
        status = await call({ action: "chunk", id, start, records });
        console.log(`Imported ${status.next}/${manifest.total} Pixel Battle records`);
    }
    status = await call({ action: "finish", id });
    if (status.status !== "complete" || status.next !== manifest.total) throw new Error("Migration did not complete");

    const canvasResponse = await fetch(origin + `/api/pxcanvas.png?migration=${Date.now()}`);
    if (!canvasResponse.ok) throw new Error(`Canvas verification HTTP ${canvasResponse.status}`);
    const canvas = unfilterIndexedPng(Buffer.from(await canvasResponse.arrayBuffer()));
    const canvasHash = sha256(canvas);
    if (canvasHash !== manifest.canvas.sha256) {
        throw new Error(`Canvas hash mismatch: expected ${manifest.canvas.sha256}, got ${canvasHash}`);
    }
    console.log(`Migration complete: ${manifest.total} records`);
    console.log(`Canvas verified: ${manifest.canvas.painted} painted pixels, SHA-256 ${canvasHash}`);
})().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
