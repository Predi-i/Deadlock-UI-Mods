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
const REGIONS = ["Europe", "North America", "South America", "Africa", "Asia", "Oceania"];

// The reveal sends INDICES into tables that ship with the mod, so this tool has to read the same
// tables to name what came back. Reading the generated file directly (rather than re-deriving from
// geo_pool.json) is deliberate: if the deployed relay and these tables disagree, that IS the bug
// this tool should surface.
const tables = require("fs").readFileSync(
    require("path").join(__dirname, "..", "server", "geo_credit_tables.generated.js"), "utf8");
const COUNTRY_NAMES = JSON.parse(/const GEO_COUNTRY_NAMES = (\[[\s\S]*?\]);/.exec(tables)[1]);
const CREDIT_KEYS = JSON.parse(/const GEO_CREDIT_KEYS = (\[[\s\S]*?\]);/.exec(tables)[1]);

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

// One request each now: both reveal labels are an index into a shipped table. h=63 is the error
// sentinel, matching the score codec.
async function creditKey(code, tok) {
    const reply = await get("/api/geocredit", { code: code, tok: tok }, "credit");
    if (reply.size.h === 63) return null;
    return CREDIT_KEYS[reply.size.h * 63 + reply.size.w] || null;
}

// 0..5 is a bare region; at 6 and above, (place - 6) packs country * 6 + continent.
async function placeName(code, tok) {
    const reply = await get("/api/geoinfo", { code: code, tok: tok }, "place");
    if (reply.size.h === 63) return "?";
    const place = reply.size.h * 63 + reply.size.w;
    if (place < 6) return REGIONS[place] || "?";
    const packed = place - 6;
    const country = COUNTRY_NAMES[Math.floor(packed / 6)];
    const region = REGIONS[packed % 6];
    if (!country) return region || "?";
    return region ? region + " · " + country : country;
}

(async function main() {
    const sources = { Mapillary: 0, Panoramax: 0, unknown: 0 };
    const regionsSeen = {};
    let slowestCreate = 0, failed = 0;

    for (let i = 0; i < rounds; i++) {
        const tok = `srcLive${i}x${Date.now().toString(36).slice(-4)}`;
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
        const key = await creditKey(code, tok);
        const place = await placeName(code, tok);
        regionsSeen[place] = (regionsSeen[place] || 0) + 1;

        // The key's leading digit IS the source (0 = Panoramax, 1 = Mapillary), so this no longer
        // depends on matching a project name inside a rendered string.
        const source = key === null ? "unknown"
            : key.charAt(0) === "1" ? "Mapillary" : "Panoramax";
        sources[source]++;
        if (!gotPanorama) failed++;

        console.log("  " + (gotPanorama ? "ok  " : "FAIL") + " create=" + String(createMs) + "ms" +
            "  " + String(Math.round(view.bytes.length / 1024)).padStart(4) + "KiB" +
            "  " + place.padEnd(30) + "  " + (key === null ? "(no credit)" : key.slice(2) +
            " · " + source));
    }

    console.log("\nsources: mapillary=" + sources.Mapillary + " panoramax=" + sources.Panoramax +
        " unknown=" + sources.unknown);
    console.log("places: " + Object.keys(regionsSeen).map((name) => {
        return name + "x" + regionsSeen[name];
    }).join(", "));
    console.log(`slowest lobby create: ${slowestCreate}ms (prebuilt pool means no catalog call)`);

    if (failed) {
        console.log(`\n${failed}/${rounds} rounds served no panorama`);
        process.exit(1);
    }
    if (!sources.Mapillary) {
        console.log("\nNo round came from Mapillary. If MG_MAPILLARY_TOKEN is set on the server, " +
            "check that it can reach *.fbcdn.net (tools/mg_geo_source_check.js).");
        process.exit(1);
    }
    console.log("\nboth the pool and the Mapillary path are live");
})();
