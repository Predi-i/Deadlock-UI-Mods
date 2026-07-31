"use strict";

// Offline builder: produce server/geo_pool.json, a prebuilt worldwide list of 360-degree
// panorama locations from BOTH Mapillary and Panoramax. Committed to the repo, loaded by the
// worker at startup, so **starting a lobby makes zero catalog requests**.
//
//   MLY_TOKEN='MLY|...' node tools/build_geo_pool.js
//   MLY_TOKEN='MLY|...' node tools/build_geo_pool.js --resolve-only
//   MLY_TOKEN='MLY|...' node tools/build_geo_pool.js --verify-images
//   node tools/build_geo_pool.js --country-only
//
// `--country-only` re-stamps `country`/`continent` on the pool already on disk and writes it back.
// It is pure local geometry against the vendored Natural Earth set, so it needs no token and makes
// no network requests - use it after changing lib/country.js.
//
// `--verify-images` measures the DELIVERED image for every pooled row and drops anything that is
// not a 2:1 equirectangular strip. This is not paranoia: Panoramax's `field_of_view = 360` filter
// describes the CAMERA, not the derivative it serves, and 11 of 58 pooled Panoramax rows came back
// as partial panoramas (measured 2026-08-01: ratios from 0.87 to 7.67, e.g. 2048x267). The engine
// wraps a 2:1 strip, so those rounds render as a smeared mess. Must be run somewhere that can
// reach *.fbcdn.net - see tools/mg_geo_source_check.js.
//
// `--resolve-only` skips both sweeps and re-resolves the ids already in geo_pool.json. Use it to
// correct coordinates without re-harvesting, and when the tile CDN is unreachable: some networks
// intercept tiles.mapillary.com and answer with an HTML login page (a 200 with content-type
// text/html), while graph.mapillary.com keeps working. Verified reachable from the VPS, so a full
// sweep can always be run there.
//
// ── Why tiles, not a bbox grid ──────────────────────────────────────────────────────────────
// The obvious approach - sweep the world in bbox queries - is arithmetically impossible.
// Mapillary caps a bbox at 0.010 square degrees EVERYWHERE (even over empty desert), so the
// largest legal box is ~0.09 deg. Covering the inhabited world needs ~2.5 MILLION cells, i.e.
// ~5M requests across both providers: measured ~105 hours at 8 concurrent. Dead end.
//
// Mapillary's vector tiles solve it outright. One z=6 coverage tile over Norway returned 15506
// sequences, 2783 of them `is_pano`, spread over 2454 distinct 0.01-deg spots - more than this
// builder's whole target, from a SINGLE request.
// Tiles over ocean/desert cost 38 bytes or less, so scanning all 4096 z=6 tiles is cheap.
//
// ── Why the tile coordinate is NOT the answer ───────────────────────────────────────────────
// A z6 tile feature is a whole SEQUENCE (a LineString of many frames) carrying ONE `image_id`.
// That id is a single frame, but the geometry spans the entire drive, so any point taken off the
// line is the wrong place for that frame. Measured over 24 pooled rows: the sequence midpoint sat
// a median 427m and up to 18.9km from where `image_id` was actually shot. In a guessing game that
// is not a rounding error - the panorama would show one town and the reveal would mark another.
// So every harvested id is RESOLVED against /images/{id} (see resolveRow) and the pool stores the
// frame's own `computed_geometry`. That call also returns the creator name for the credit line and
// weeds out dead ids (~4% of tile ids 404), neither of which the tile can provide.
//
// ── Even distribution ───────────────────────────────────────────────────────────────────────
// Raw harvest is wildly unbalanced (a Dutch tile can outweigh a continent). Two mechanisms fix
// that: a hard PER_TILE_CEILING while harvesting, and a round-robin quota across regions when
// assembling the final pool. Both are load-bearing - without them the pool is ~90% Europe.
//
// ── Country, and why `region` is not it ─────────────────────────────────────────────────────
// Each row also carries a `country` + `continent`, resolved offline from Natural Earth by
// lib/country.js. `region` is NOT a substitute: it is a coarse bbox used to balance the harvest,
// and the boxes overlap reality badly (the Canaries fall in the Africa box, Istanbul in the
// Europe box, Vladivostok in the Asia box). The reveal shows "continent · country" from these
// fields, so the label is right even where the harvest bbox is not.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mvt = require("./lib/mvt.js");
const country = require("./lib/country.js");

const MLY_TOKEN = process.env.MLY_TOKEN || "";
const MLY_TILE = "https://tiles.mapillary.com/maps/vtp/mly1_public/2";
const MLY_GRAPH = "https://graph.mapillary.com";
const PANO_CATALOG = "https://api.panoramax.xyz/api/search";
const OUT = path.join(__dirname, "..", "server", "geo_pool.json");

const TILE_Z = 6;              // sequence layer lives at z6-14; z6 is the cheapest useful level
const PER_REGION_QUOTA = 400;  // EQUAL per region: 6 x 400 = 2400. This is the balance guarantee.
// Deliberately over-harvest. A single tile can hold thousands of panoramas (one Oceania tile:
// 2476 is_pano over 1371 distinct spots), so a low ceiling starves thin regions just as hard as
// dense ones and the first build came out 670 Asia vs 209 Oceania. Harvest wide, balance later.
const PER_TILE_CEILING = 40;
const MIN_SEPARATION_M = 500;  // two rounds 500m apart would be indistinguishable to a player
const CONCURRENCY = 6;
const TILE_TIMEOUT_MS = 45000;

// Same order and names as REGIONS in panorama/scripts/mg_geoguesser.js: the client shows
// `/api/geoinfo`'s index as a label, so these must not be reordered.
const REGIONS = [
    { name: "Europe", bounds: [-10, 36, 30, 60] },
    { name: "North America", bounds: [-125, 25, -60, 55] },
    { name: "South America", bounds: [-80, -55, -35, 10] },
    { name: "Africa", bounds: [-18, -35, 50, 35] },
    { name: "Asia", bounds: [30, 5, 150, 60] },
    { name: "Oceania", bounds: [113, -47, 180, 0] }
];

function regionOf(lon, lat) {
    for (let i = 0; i < REGIONS.length; i++) {
        const b = REGIONS[i].bounds;
        if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return i;
    }
    return -1;
}

function shuffle(values) {
    for (let i = values.length - 1; i > 0; i--) {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        const j = buf[0] % (i + 1);
        const tmp = values[i]; values[i] = values[j]; values[j] = tmp;
    }
    return values;
}

function metres(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// NOTE the trailing trim: slicing to 24 characters can land mid-word and leave a trailing space
// ("Planungsgesellschaft RV "), and that space then survived into the pool while every downstream
// consumer trimmed it independently. Once the credit line became a table lookup, the mismatch
// meant the reveal could not find its own provider's index. Trim AFTER the slice, always.
function safeName(value) {
    return String(value || "Contributor").replace(/[^ A-Za-z0-9.]/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 24).trim() || "Contributor";
}

// ── Mapillary: one coverage tile ────────────────────────────────────────────────────────────
let tileIntercepted = 0;

async function harvestTile(z, x, y) {
    const url = MLY_TILE + "/" + z + "/" + x + "/" + y + "?access_token=" + MLY_TOKEN;
    let buffer;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TILE_TIMEOUT_MS) });
        if (!response.ok) return [];
        // ⚠ A captive portal / DNS filter answers 200 with an HTML login page instead of the tile.
        // Treat that as a hard failure, not an empty tile: swallowing it made a whole sweep return
        // zero Mapillary rows and quietly write a degraded pool over a good one.
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (type.includes("html") || type.includes("json")) {
            tileIntercepted++;
            return [];
        }
        buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
        return [];
    }
    if (buffer.length < 64) return [];            // ocean/empty tiles are ~38 bytes

    let features;
    try {
        features = mvt.parse(buffer, z, x, y);
    } catch (error) {
        return [];                                 // a malformed tile must not kill the sweep
    }

    const candidates = [];
    for (const feature of features) {
        const p = feature.properties || {};
        if (p.is_pano !== true) continue;
        if (!p.image_id || !/^[0-9]{5,25}$/.test(String(p.image_id))) continue;
        // A sequence is a LineString of many frames. Take its MIDPOINT: endpoints are often a
        // parking spot or the moment the camera was switched on.
        const ring = (feature.rings || [])[0];
        if (!ring || !ring.length) continue;
        const point = ring[Math.floor(ring.length / 2)];
        const lon = Number(point[0]), lat = Number(point[1]);
        if (!isFinite(lon) || !isFinite(lat)) continue;
        const region = regionOf(lon, lat);
        if (region < 0) continue;                   // outside the six labelled regions
        // No `provider` for Mapillary rows: the tile only carries a numeric `creator_id`, and a
        // literal "Mapillary user" would be a worthless credit. The real username comes back with
        // the image URL at reveal time, which is a request the worker has to make anyway.
        candidates.push({
            source: 1,                              // 1 = Mapillary (0 = Panoramax)
            id: String(p.image_id),
            lat: Number(lat.toFixed(6)),
            lon: Number(lon.toFixed(6)),
            region: region
        });
    }
    // Ceiling applied per tile, before any global assembly, so one dense city cannot flood.
    return shuffle(candidates).slice(0, PER_TILE_CEILING);
}

// ── Panoramax: its search accepts multi-degree boxes, so a coarse grid is enough ────────────
async function harvestPanoramax(bbox) {
    const url = PANO_CATALOG + "?limit=20&filter=" +
        encodeURIComponent("field_of_view = 360") + "&bbox=" + encodeURIComponent(bbox.join(","));
    let body;
    try {
        const response = await fetch(url, {
            headers: { Accept: "application/geo+json", "User-Agent": "Deadlock-Minigames/1.0" },
            signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) return [];
        body = await response.json();
    } catch (error) {
        return [];
    }
    const features = Array.isArray(body && body.features) ? body.features : [];
    const bySequence = new Map();
    for (const feature of features) {
        if (!/^[0-9a-f-]{36}$/i.test(String(feature.id || ""))) continue;
        const props = feature.properties || {};
        const orientation = props["pers:interior_orientation"];
        if (!orientation || Number(orientation.field_of_view) !== 360) continue;
        if (String(props.license || "") !== "CC-BY-SA-4.0") continue;
        const coords = (feature.geometry || {}).coordinates || [];
        const lon = Number(coords[0]), lat = Number(coords[1]);
        if (!isFinite(lon) || !isFinite(lat)) continue;
        const region = regionOf(lon, lat);
        if (region < 0) continue;
        const sequence = String(feature.collection || feature.id);
        if (bySequence.has(sequence)) continue;     // one frame per sequence, as the worker did
        const providers = Array.isArray(feature.providers) ? feature.providers : [];
        bySequence.set(sequence, {
            source: 0,
            id: String(feature.id),
            lat: Number(lat.toFixed(6)),
            lon: Number(lon.toFixed(6)),
            region: region,
            provider: safeName(providers[0] && providers[0].name)
        });
    }
    // No ceiling here: the one-frame-per-sequence rule above is already the anti-clustering
    // measure, and Panoramax returns far fewer rows per cell than a Mapillary tile does.
    return shuffle(Array.from(bySequence.values()));
}

// ── Resolve one harvested row to the frame's own position ───────────────────────────────────
// Returns a corrected row, or null if the id is dead / not actually a 360 frame / has drifted
// outside the six labelled regions. Panoramax rows are already point geometry, so they pass
// through untouched.
async function resolveRow(row) {
    if (row.source === 0) return row;
    const url = MLY_GRAPH + "/" + row.id +
        "?fields=id,camera_type,is_pano,computed_geometry,geometry,creator" +
        "&access_token=" + encodeURIComponent(MLY_TOKEN);
    let body;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) return null;
        body = await response.json();
    } catch (error) {
        return null;
    }
    if (!body || body.error) return null;
    if (body.is_pano !== true) return null;
    // Both spellings mean a true 2:1 strip. Filtering on "equirectangular" alone reported zero
    // panoramas worldwide in an earlier probe - the API mostly says "spherical".
    const camera = String(body.camera_type || "");
    if (camera !== "spherical" && camera !== "equirectangular") return null;
    // computed_geometry is the photogrammetrically refined position; it beats raw GPS by ~10m.
    const coords = ((body.computed_geometry || body.geometry || {}).coordinates) || [];
    const lon = Number(coords[0]), lat = Number(coords[1]);
    if (!isFinite(lon) || !isFinite(lat)) return null;
    // Re-derive the region from the TRUE position: a frame up to 18km from the tile midpoint can
    // land in another region (or the sea), and a mislabelled row would corrupt both the quota and
    // the region hint the client shows at reveal.
    const region = regionOf(lon, lat);
    if (region < 0) return null;
    return {
        source: 1,
        id: row.id,
        lat: Number(lat.toFixed(6)),
        lon: Number(lon.toFixed(6)),
        region: region,
        provider: safeName((body.creator || {}).username)
    };
}

// Flat worker pool: a nested Promise.all over a bash-style loop is what made earlier attempts
// unpredictable. One queue, N workers, no nesting.
async function runPool(tasks, worker, label) {
    const results = [];
    let next = 0, done = 0;
    async function drain() {
        for (;;) {
            const index = next++;
            if (index >= tasks.length) return;
            const rows = await worker(tasks[index]);
            for (const row of rows) results.push(row);
            done++;
            if (done % 200 === 0 || done === tasks.length) {
                process.stdout.write("\r  " + label + ": " + done + "/" + tasks.length +
                    " · " + results.length + " locations   ");
            }
        }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, tasks.length); i++) workers.push(drain());
    await Promise.all(workers);
    process.stdout.write("\n");
    return results;
}

// Fill each region to the SAME quota independently. An earlier version round-robinned until a
// global target was hit, which silently let whichever region had the most candidates win
// (670 Asia vs 209 Oceania). Per-region quotas make "evenly distributed" a property of the
// algorithm rather than a hope about the harvest.
//
// Resolution happens HERE, lazily, in batches - not over the whole harvest. The sweep yields far
// more candidates than the quota needs, and resolving all of them would cost one request each for
// rows that get thrown away anyway.
async function assemble(harvest) {
    const byRegion = REGIONS.map(() => { return []; });
    for (const row of harvest) byRegion[row.region].push(row);

    const pool = [];
    const shortfalls = [];
    let resolveCalls = 0, resolveDropped = 0;
    for (let r = 0; r < byRegion.length; r++) {
        const candidates = shuffle(byRegion[r]);
        const accepted = [];
        const seenIds = new Set();
        let cursor = 0;
        while (accepted.length < PER_REGION_QUOTA && cursor < candidates.length) {
            // Resolve a batch concurrently, then apply the gates in a fixed order so the result
            // does not depend on which request happened to finish first.
            const batch = [];
            while (batch.length < CONCURRENCY && cursor < candidates.length) {
                const next = candidates[cursor++];
                const key = next.source + ":" + next.id;
                if (seenIds.has(key)) continue;
                seenIds.add(key);
                batch.push(next);
            }
            if (!batch.length) break;
            const resolved = await Promise.all(batch.map(resolveRow));
            resolveCalls += batch.filter((row) => { return row.source === 1; }).length;
        for (const candidate of resolved) {
            if (accepted.length >= PER_REGION_QUOTA) break;
            if (!candidate) { resolveDropped++; continue; }
            // A resolved frame can land in a different region than its tile suggested; keep the
            // per-region books honest by pushing it aside rather than into this region's quota.
            if (candidate.region !== r) { resolveDropped++; continue; }
            // Reject anything too close to a location already accepted: two rounds 500m apart are
            // the same place as far as a guess is concerned. Only same-region rows can collide,
            // so this stays O(quota^2) per region instead of over the whole pool.
            let tooClose = false;
            for (let i = 0; i < accepted.length; i++) {
                if (metres(accepted[i].lat, accepted[i].lon, candidate.lat, candidate.lon) < MIN_SEPARATION_M) {
                    tooClose = true; break;
                }
            }
            if (tooClose) continue;
            accepted.push(candidate);
        }
        }
        if (accepted.length < PER_REGION_QUOTA) {
            shortfalls.push(REGIONS[r].name + " " + accepted.length + "/" + PER_REGION_QUOTA);
        }
        for (const row of accepted) pool.push(row);
    }
    if (shortfalls.length) {
        console.log("\n  ! under quota: " + shortfalls.join(", ") +
            "  (raise PER_TILE_CEILING or widen that region's bounds)");
    }
    console.log("  resolved " + resolveCalls + " mapillary ids, dropped " + resolveDropped +
        " (404 / wrong region / not a true panorama)");
    return shuffle(pool);
}

// ── Verify the DELIVERED image is a 2:1 equirectangular strip ────────────────────────────────
// Dimensions are read straight from the JPEG/PNG header, so only the first few KiB matter in
// principle (the fetch still pulls the whole body; these are ~200 KiB).
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

async function imageIsEquirect(row) {
    let url = "https://api.panoramax.xyz/api/pictures/" + row.id + "/sd.jpg";
    try {
        if (row.source === 1) {
            const meta = await fetch(MLY_GRAPH + "/" + row.id + "?fields=thumb_2048_url" +
                "&access_token=" + encodeURIComponent(MLY_TOKEN),
                { signal: AbortSignal.timeout(20000) });
            const body = await meta.json();
            url = String(body && body.thumb_2048_url || "");
            if (!url) return false;
        }
        const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!response.ok) return false;
        const size = imageSize(new Uint8Array(await response.arrayBuffer()));
        if (!size.h) return false;
        const ratio = size.w / size.h;
        return ratio > 1.98 && ratio < 2.02;
    } catch (error) {
        return false;
    }
}

async function verifyImages(pool) {
    console.log("verifying the delivered image for " + pool.length + " rows is a 2:1 strip");
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < pool.length; i += CONCURRENCY) {
        const batch = pool.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(imageIsEquirect));
        for (let j = 0; j < batch.length; j++) {
            if (results[j]) kept.push(batch[j]); else dropped++;
        }
        process.stdout.write("\r  checked " + Math.min(i + CONCURRENCY, pool.length) + "/" +
            pool.length + " · kept " + kept.length + " · dropped " + dropped + "   ");
    }
    process.stdout.write("\n");
    console.log("  dropped " + dropped + " rows whose image is not equirectangular");
    return kept;
}

// Re-resolve the ids already in geo_pool.json without touching either catalog sweep. Panoramax
// rows pass through; Mapillary rows get their true frame coordinate, creator and region.
async function resolveExisting() {
    let existing;
    try {
        existing = JSON.parse(fs.readFileSync(OUT, "utf8"));
    } catch (error) {
        console.error("--resolve-only needs an existing " + path.basename(OUT) + ": " + error.message);
        process.exit(1);
    }
    if (!Array.isArray(existing) || !existing.length) {
        console.error("--resolve-only: pool file is empty");
        process.exit(1);
    }
    console.log("re-resolving " + existing.length + " pooled ids against graph.mapillary.com");

    const out = [];
    let dropped = 0, moved = 0, shifts = [];
    for (let i = 0; i < existing.length; i += CONCURRENCY) {
        const batch = existing.slice(i, i + CONCURRENCY);
        const resolved = await Promise.all(batch.map(resolveRow));
        for (let j = 0; j < resolved.length; j++) {
            const before = batch[j], after = resolved[j];
            if (!after) { dropped++; continue; }
            if (after.source === 1) {
                shifts.push(metres(before.lat, before.lon, after.lat, after.lon));
                if (after.region !== before.region) moved++;
            }
            out.push(after);
        }
        process.stdout.write("\r  resolved " + Math.min(i + CONCURRENCY, existing.length) + "/" +
            existing.length + " · kept " + out.length + " · dropped " + dropped + "   ");
    }
    process.stdout.write("\n");
    shifts.sort((a, b) => { return a - b; });
    if (shifts.length) {
        console.log("  coordinate correction: median " +
            Math.round(shifts[Math.floor(shifts.length / 2)]) + "m, max " +
            Math.round(shifts[shifts.length - 1]) + "m, " + moved + " changed region");
    }
    return out;
}

(async function main() {
    const resolveOnly = process.argv.includes("--resolve-only");
    const verifyOnly = process.argv.includes("--verify-images");
    const countryOnly = process.argv.includes("--country-only");
    // --country-only is pure local geometry against a vendored dataset: no catalog, no token.
    if (!MLY_TOKEN && !countryOnly) {
        console.error("set MLY_TOKEN (never hardcode it - this repo is public)");
        process.exit(1);
    }
    const previousCount = fs.existsSync(OUT)
        ? (JSON.parse(fs.readFileSync(OUT, "utf8")) || []).length : 0;

    let pool;
    if (verifyOnly) {
        pool = await verifyImages(JSON.parse(fs.readFileSync(OUT, "utf8")));
    } else if (countryOnly) {
        pool = JSON.parse(fs.readFileSync(OUT, "utf8"));
        console.log("re-stamping country on " + pool.length + " existing rows (no catalog calls)");
    } else if (resolveOnly) {
        pool = await resolveExisting();
    } else {
        console.log("Building server/geo_pool.json");
        console.log("  tiles z=" + TILE_Z + " · per-tile ceiling " + PER_TILE_CEILING +
            " · min separation " + MIN_SEPARATION_M + "m · quota " + PER_REGION_QUOTA + "/region");

        // Every z6 tile on Earth. Ocean tiles are ~38 bytes, so enumerating all of them is cheaper
        // than maintaining a land mask, and it guarantees nothing inhabited is missed.
        const side = Math.pow(2, TILE_Z);
        const tiles = [];
        for (let x = 0; x < side; x++) {
            for (let y = 0; y < side; y++) tiles.push([TILE_Z, x, y]);
        }
        shuffle(tiles);   // spread load over the CDN instead of hammering one row

        const mapillary = await runPool(tiles, (t) => { return harvestTile(t[0], t[1], t[2]); },
            "mapillary tiles");
        if (tileIntercepted) {
            console.error("\n" + tileIntercepted + " tile requests were answered with HTML/JSON " +
                "instead of a protobuf tile.\nSomething on this network is intercepting " +
                "tiles.mapillary.com (graph.mapillary.com may still work).\nRun the sweep from the " +
                "VPS, or use --resolve-only. Refusing to overwrite the pool with a partial sweep.");
            process.exit(1);
        }

        // 4-degree cells: Panoramax has no bbox cap, and this is dense enough to reach every
        // sub-region without the 50-cell hand-written list.
        const panoCells = [];
        for (const region of REGIONS) {
            const [w, s, e, n] = region.bounds;
            for (let lat = s; lat < n; lat += 4) {
                for (let lon = w; lon < e; lon += 4) {
                    panoCells.push([lon, lat, Math.min(lon + 4, e), Math.min(lat + 4, n)]);
                }
            }
        }
        shuffle(panoCells);
        const panoramax = await runPool(panoCells, harvestPanoramax, "panoramax cells");

        const harvest = mapillary.concat(panoramax);
        console.log("\nharvest: " + harvest.length + " (mapillary " + mapillary.length +
            ", panoramax " + panoramax.length + ")");
        pool = await assemble(harvest);
    }

    // Stamp every row with its country + display continent, OFFLINE (Natural Earth, public
    // domain). Done here rather than in resolveRow so Panoramax rows and --resolve-only runs get
    // it too. A row that resolves to nothing keeps country "" and the reveal shows its region
    // name alone: on the committed pool that is 6 of 2334 (4 South Georgia, which Natural Earth
    // files under "Seven seas", plus 2 genuinely at-sea panoramas).
    let located = 0;
    for (const row of pool) {
        const place = country.resolve(row.lon, row.lat);
        row.country = place && place.continent >= 0 ? place.country : "";
        row.continent = place && place.continent >= 0 ? place.continent : -1;
        if (row.country) located++;
    }
    console.log("\ncountry: " + located + "/" + pool.length + " located (" +
        (pool.length - located) + " at sea or outside the six continents)");

    const byRegion = REGIONS.map(() => { return { total: 0, mly: 0, pano: 0 }; });
    for (const row of pool) {
        byRegion[row.region].total++;
        if (row.source === 1) byRegion[row.region].mly++; else byRegion[row.region].pano++;
    }
    console.log("\nfinal pool: " + pool.length + " locations");
    console.log("region            total   mapillary  panoramax");
    REGIONS.forEach((region, i) => {
        console.log("  " + region.name.padEnd(16) + String(byRegion[i].total).padStart(5) +
            String(byRegion[i].mly).padStart(11) + String(byRegion[i].pano).padStart(11));
    });

    // A sweep that lost most of the pool means the run was broken, not that the world shrank.
    // Writing it would silently degrade the game, so make the operator look at it first.
    if (previousCount && pool.length < previousCount * 0.6) {
        console.error("\nrefusing to write: " + pool.length + " locations is far below the " +
            previousCount + " already on disk. Re-run, or pass --force if this is intended.");
        if (!process.argv.includes("--force")) process.exit(1);
    }

    fs.writeFileSync(OUT, JSON.stringify(pool));
    console.log("\nwrote " + path.relative(path.join(__dirname, ".."), OUT) +
        " (" + (fs.statSync(OUT).size / 1024).toFixed(1) + " KiB)");
})();
