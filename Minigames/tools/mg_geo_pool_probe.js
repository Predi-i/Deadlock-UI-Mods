"use strict";

// Throwaway diagnostic (not wired into `npm test`): replays the deployed pool builder's exact
// sub-cell query list against the live Panoramax catalog and reports how many DISTINCT sequences
// and coordinates each region actually yields.
//
// Why it exists: a wide bbox per region silently collapsed the pool onto one densely-mapped route
// (all of Europe = 1 sequence even at limit=1000), which looked like "Panoramax has no coverage
// there". Only a spread measurement can tell the difference between thin coverage and a bad query,
// so re-run this whenever GEO_REGIONS changes.

const fs = require("fs");
const path = require("path");

const CATALOG = "https://api.panoramax.xyz/api/search";
const source = fs.readFileSync(
    path.join(__dirname, "..", "server", "worker.core.js"), "utf8");
const match = source.match(/const GEO_REGIONS = \[[\s\S]*?\n\];/);
if (!match) throw new Error("GEO_REGIONS not found in worker.core.js");
// eslint-disable-next-line no-eval
const REGIONS = eval(match[0].replace("const GEO_REGIONS =", "").replace(/;\s*$/, ""));

async function cell(bbox) {
    const url = CATALOG + "?limit=40&filter=" +
        encodeURIComponent("field_of_view = 360") + "&bbox=" + encodeURIComponent(bbox);
    try {
        const response = await fetch(url, { headers: { Accept: "application/geo+json" } });
        if (!response.ok) return [];
        const body = await response.json();
        return Array.isArray(body.features) ? body.features : [];
    } catch (e) {
        return [];
    }
}

(async function main() {
    let poolTotal = 0, placeTotal = 0;
    for (const region of REGIONS) {
        const batches = await Promise.all(region.cells.map(cell));
        const sequences = new Set();
        // Distinct sequences OVERSTATES the spread: several separately-uploaded collections can
        // sit on the same street corner (Asia returns many at 36.1,36.2 in Antakya). Bucketing the
        // coordinates to ~0.5deg is the honest "how many different places" number.
        const places = new Set();
        const points = [];
        for (const features of batches) {
            for (const feature of features) {
                const id = feature.collection || "";
                if (!id || sequences.has(id)) continue;
                sequences.add(id);
                const c = (feature.geometry || {}).coordinates || [];
                const lon = Number(c[0]), lat = Number(c[1]);
                if (!isFinite(lon) || !isFinite(lat)) continue;
                const bucket = Math.round(lon * 2) + "/" + Math.round(lat * 2);
                if (places.has(bucket)) continue;
                places.add(bucket);
                points.push(lon.toFixed(1) + "," + lat.toFixed(1));
            }
        }
        // The builder keeps one frame per sequence, so distinct sequences IS the pool contribution.
        poolTotal += sequences.size;
        placeTotal += places.size;
        console.log(region.name.padEnd(15) + " cells=" + String(region.cells.length).padStart(2) +
            "  sequences=" + String(sequences.size).padStart(3) +
            "  places=" + String(places.size).padStart(3) +
            "  e.g. " + points.slice(0, 6).join(" | "));
    }
    console.log("\npool = " + poolTotal + " locations across " + placeTotal + " distinct places");
})();
