"use strict";

// Live check against a DEPLOYED relay: which panorama source actually serves a round, how long
// forming a lobby takes now that the pool is prebuilt, and whether the credit line names the right
// project. The smoke test proves a panorama arrives; this proves WHICH source produced it, which is
// the part that silently regresses when a token goes missing.
//
//   node tools/mg_geo_source_live.js [origin] [rounds]
//
// Read-only: it forms solo lobbies and reads reveal data. Safe against production.

const origin = String(process.argv[2] || "https://178.236.246.13").replace(/\/+$/, "");
const rounds = Number(process.argv[3] || 6);
const ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.";
const REGIONS = ["Europe", "North America", "South America", "Africa", "Asia", "Oceania"];

// ⚠ Dimensions are LEVEL-QUANTISED on the wire: physical = level * 9 + 15. Reading the raw PNG
// width as the value is wrong and decodes into nonsense (it made an earlier version of this tool
// loop forever waiting for credit characters that never arrived). Same codec as
// tools/mg_geo_live_smoke.js and MG.Net on the client.
function levels(bytes, name) {
    if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80) {
        throw new Error(name + " did not return a PNG protocol message");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const physicalWidth = view.getUint32(16), physicalHeight = view.getUint32(20);
    if ((physicalWidth - 15) % 9 || (physicalHeight - 15) % 9) {
        throw new Error(name + " returned invalid dimensions " +
            physicalWidth + "x" + physicalHeight);
    }
    return { w: (physicalWidth - 15) / 9, h: (physicalHeight - 15) / 9 };
}

let nonce = Date.now();

async function get(path, params, name) {
    const url = new URL(path + ".png", origin);
    const query = Object.assign({}, params, { rnd: nonce++ });
    for (const key of Object.keys(query)) url.searchParams.set(key, query[key]);
    const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = String(response.headers.get("content-type") || "");
    // A real panorama is a normal JPEG and has no level encoding to read.
    const size = name === null ? { w: 0, h: 0 } : levels(bytes, name || path);
    return { bytes: bytes, type: type, size: size };
}

async function credit(code, tok) {
    const head = await get("/api/geocredit", { code: code, tok: tok, i: 0 }, "credit head");
    let text = "";
    for (let part = 1; text.length < head.size.w && part < 64; part++) {
        const chunk = await get("/api/geocredit", { code: code, tok: tok, i: part }, "credit");
        text += ALPHABET.charAt(chunk.size.w);
        if (text.length < head.size.w) text += ALPHABET.charAt(chunk.size.h);
    }
    return text;
}

(async function main() {
    const sources = { Mapillary: 0, Panoramax: 0, unknown: 0 };
    const regionsSeen = {};
    let slowestCreate = 0, failed = 0;

    for (let i = 0; i < rounds; i++) {
        const tok = "srcLive" + i + "x" + Date.now().toString(36).slice(-4);
        const started = Date.now();
        const created = await get("/api/create", { game: 9, tok: tok, solo: 1 }, "create");
        const createMs = Date.now() - started;
        slowestCreate = Math.max(slowestCreate, createMs);
        // Create answers in a role band: w carries the high half of the code, h the low half.
        const code = String((created.size.w - 24) * 64 + created.size.h).padStart(4, "0");

        const view = await get("/api/geoview", { code: code, tok: tok }, null);
        const isImage = view.type.indexOf("image/jpeg") === 0 || view.type.indexOf("image/png") === 0;
        // A sentinel reply is a tiny level-encoded PNG; a real panorama is tens of KiB.
        const gotPanorama = isImage && view.bytes.length > 20000;

        await get("/api/geoguess", { code: code, tok: tok, cell: 0 }, "guess");
        const line = await credit(code, tok);
        const region = await get("/api/geoinfo", { code: code, tok: tok }, "region");
        const regionName = REGIONS[region.size.w - 1] || "?";
        regionsSeen[regionName] = (regionsSeen[regionName] || 0) + 1;

        const source = line.indexOf("Mapillary") !== -1 ? "Mapillary"
            : line.indexOf("Panoramax") !== -1 ? "Panoramax" : "unknown";
        sources[source]++;
        if (!gotPanorama) failed++;

        console.log("  " + (gotPanorama ? "ok  " : "FAIL") + " create=" + String(createMs) + "ms" +
            "  " + String(Math.round(view.bytes.length / 1024)).padStart(4) + "KiB" +
            "  " + regionName.padEnd(14) + "  " + line);
    }

    console.log("\nsources: mapillary=" + sources.Mapillary + " panoramax=" + sources.Panoramax +
        " unknown=" + sources.unknown);
    console.log("regions: " + Object.keys(regionsSeen).map(function (name) {
        return name + "x" + regionsSeen[name];
    }).join(", "));
    console.log("slowest lobby create: " + slowestCreate + "ms (prebuilt pool means no catalog call)");

    if (failed) {
        console.log("\n" + failed + "/" + rounds + " rounds served no panorama");
        process.exit(1);
    }
    if (!sources.Mapillary) {
        console.log("\nNo round came from Mapillary. If MG_MAPILLARY_TOKEN is set on the server, " +
            "check that it can reach *.fbcdn.net (tools/mg_geo_source_check.js).");
        process.exit(1);
    }
    console.log("\nboth the pool and the Mapillary path are live");
})();
