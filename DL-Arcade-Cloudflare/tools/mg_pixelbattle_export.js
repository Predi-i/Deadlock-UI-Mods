"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const zlib = require("zlib");
const { DatabaseSync } = require("node:sqlite");

function usage() {
    console.error("Usage: node tools/mg_pixelbattle_export.js <minigames.sqlite[.gz]> <output.json>");
    process.exit(2);
}

function sha256(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function base64Url(bytes) {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) return value;
    if (value instanceof Uint16Array) {
        const bytes = Buffer.alloc(value.length * 2);
        for (let i = 0; i < value.length; i++) bytes.writeUInt16LE(value[i], i * 2);
        return { $typed: "u16", base64: base64Url(bytes) };
    }
    if (value instanceof Uint8Array) {
        return { $typed: "u8", base64: base64Url(
            Buffer.from(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (Array.isArray(value)) return value.map(encodeValue);
    if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value)) out[key] = encodeValue(value[key]);
        return out;
    }
    throw new Error(`Unsupported stored value type: ${typeof value}`);
}

function tilePixels(records) {
    const canvas = Buffer.alloc(512 * 256);
    let painted = 0;
    for (const record of records) {
        const match = /^px:t:(\d+)$/.exec(record.key);
        if (!match || record.value?.$typed !== "u8") continue;
        const index = Number(match[1]);
        const tile = Buffer.from(record.value.base64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (index < 0 || index >= 128 || tile.length !== 32 * 32) {
            throw new Error(`Invalid Pixel Battle tile ${record.key}`);
        }
        const tileX = index % 16, tileY = Math.floor(index / 16);
        for (let y = 0; y < 32; y++) {
            tile.copy(canvas, (tileY * 32 + y) * 512 + tileX * 32, y * 32, y * 32 + 32);
        }
        for (const color of tile) if (color !== 0) painted++;
    }
    return { sha256: sha256(canvas), painted };
}

const inputArg = process.argv[2], outputArg = process.argv[3];
if (!inputArg || !outputArg) usage();
const input = path.resolve(inputArg), output = path.resolve(outputArg);
if (!fs.existsSync(input)) throw new Error(`Backup not found: ${input}`);

const archive = fs.readFileSync(input);
const archiveSha256 = sha256(archive);
let databaseBytes = archive, tempDir = "", databasePath = input;
if (/\.gz$/i.test(input)) {
    databaseBytes = zlib.gunzipSync(archive);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-arcade-pixel-export-"));
    databasePath = path.join(tempDir, "minigames.sqlite");
    fs.writeFileSync(databasePath, databaseBytes, { flag: "wx", mode: 0o600 });
}

let database;
try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("SQLite integrity_check failed");
    const rows = database.prepare(
        "SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key ASC"
    ).all("px:", "px:\uffff");
    const records = rows.map((row) => ({ key: String(row.key), value: encodeValue(v8.deserialize(row.value)) }));
    if (!records.length) throw new Error("Backup contains no Pixel Battle records");
    const canonical = JSON.stringify(records);
    const id = sha256(Buffer.from(canonical));
    const canvas = tilePixels(records);
    const versionRecord = records.find((record) => record.key === "px:version");
    const manifest = {
        format: "dl-arcade-pixelbattle-v1",
        id,
        exportedAt: new Date().toISOString(),
        source: {
            filename: path.basename(input),
            archiveSha256,
            databaseSha256: sha256(databaseBytes)
        },
        canvas: {
            width: 512,
            height: 256,
            painted: canvas.painted,
            sha256: canvas.sha256,
            version: Number(versionRecord?.value || 0)
        },
        total: records.length,
        records
    };
    fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(`Pixel Battle export: ${records.length} records, ${canvas.painted} painted pixels`);
    console.log(`Migration id: ${id}`);
    console.log(`Canvas SHA-256: ${canvas.sha256}`);
    console.log(`Manifest: ${output}`);
} finally {
    if (database) database.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}
