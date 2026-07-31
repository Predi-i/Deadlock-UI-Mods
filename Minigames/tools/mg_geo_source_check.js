"use strict";

// Check that a machine can actually FETCH the panoramas GeoGuesser serves. Run it on the VPS:
//
//   MLY_TOKEN='MLY|...' node tools/mg_geo_source_check.js
//
// Why this exists as its own tool: Mapillary's images come from *.fbcdn.net, and some networks
// (ISP filters, captive portals, DNS blocklists) do not resolve that host or intercept it with an
// HTML login page. On such a machine graph.mapillary.com keeps answering while every panorama
// silently fails, and in the game that looks like a black round rather than a network problem.
// The maintainer's own workstation is one of these networks - measured 2026-07-31, fbcdn.net
// resolved to 127.0.0.1 there while the VPS fetched the same image fine - so "it works here" is
// not evidence and this has to be run where the server runs.
//
// It samples the REAL pool, so it also catches a pool that has gone stale or half-dead.
// Read-only: no writes, no deploy, safe to run against production at any time.

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.MLY_TOKEN || "";
const POOL = path.join(__dirname, "..", "server", "geo_pool.json");
const SAMPLE_PER_SOURCE = 3;

function sample(rows, count) {
    if (rows.length <= count) return rows.slice();
    const out = [], step = Math.floor(rows.length / count);
    for (let i = 0; out.length < count && i < rows.length; i += step) out.push(rows[i]);
    return out;
}

async function mapillaryUrl(id) {
    const response = await fetch("https://graph.mapillary.com/" + id +
        "?fields=thumb_2048_url,camera_type&access_token=" + encodeURIComponent(TOKEN),
        { signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 120));
    return { url: String(body.thumb_2048_url || ""), camera: String(body.camera_type || "") };
}

// Dimensions straight from the JPEG/PNG header. The engine wraps a 2:1 equirectangular strip, so
// a source that quietly starts returning 4:3 flats would break rendering while still being "up".
function imageSize(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        return { w: view.getUint32(16), h: view.getUint32(20) };
    }
    for (let i = 2; i + 9 < bytes.length;) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
        }
        i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
    return { w: 0, h: 0 };
}

(async function main() {
    const pool = JSON.parse(fs.readFileSync(POOL, "utf8"));
    const rows = sample(pool.filter((r) => { return r.source === 1; }), SAMPLE_PER_SOURCE)
        .concat(sample(pool.filter((r) => { return r.source === 0; }), SAMPLE_PER_SOURCE));

    console.log("checking " + rows.length + " panoramas from a pool of " + pool.length);
    if (!TOKEN) console.log("! MLY_TOKEN not set - Mapillary rows will be reported as unreachable");

    let failed = 0;
    for (const row of rows) {
        const name = (row.source === 1 ? "mapillary" : "panoramax") + " " + row.id;
        try {
            let url = "https://api.panoramax.xyz/api/pictures/" + row.id + "/sd.jpg";
            let camera = "";
            if (row.source === 1) {
                if (!TOKEN) throw new Error("no token");
                const resolved = await mapillaryUrl(row.id);
                url = resolved.url;
                camera = resolved.camera;
                if (!url) throw new Error("no thumb_2048_url in the response");
            }
            const started = Date.now();
            const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error("http " + response.status);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const size = imageSize(bytes);
            const ratio = size.h ? size.w / size.h : 0;
            const ok = ratio > 1.98 && ratio < 2.02;
            if (!ok) failed++;
            console.log("  " + (ok ? "ok  " : "BAD ") + name.padEnd(28) +
                String(size.w) + "x" + size.h + " ratio=" + ratio.toFixed(3) +
                " " + (bytes.length / 1024).toFixed(0) + "KiB " + (Date.now() - started) + "ms" +
                (camera ? " " + camera : "") +
                " host=" + new URL(url).hostname);
        } catch (error) {
            failed++;
            console.log("  FAIL " + name.padEnd(28) + error.message);
        }
    }

    if (failed) {
        console.log("\n" + failed + "/" + rows.length + " unreachable. If only the Mapillary rows " +
            "failed, this machine cannot reach *.fbcdn.net;\nthe game will show black rounds for " +
            "every Mapillary location until that is fixed.");
        process.exit(1);
    }
    console.log("\nall sources reachable and 2:1 equirectangular");
})();
