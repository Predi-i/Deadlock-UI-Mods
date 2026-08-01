"use strict";

// Resolve a lon/lat to a Natural Earth country, OFFLINE. Used by tools/build_geo_pool.js to stamp
// every pooled location with a country at build time, so the reveal can name it without spending a
// single request: the old attribution transport read the credit line two characters per request
// (up to 26 chained round-trips for one label), which is what made "LOADING RESULT…" hang.
//
// Data is tools/assets/ne_50m_admin_0_countries.geojson - Natural Earth 1:50m, PUBLIC DOMAIN, no
// attribution required (see tools/assets/NATURAL_EARTH_LICENSE.md). It is already vendored for the
// guess map, so this adds no new dependency and no download.
//
// ── Why a snap distance, and why 60km ───────────────────────────────────────────────────────
// A 1:50m coastline is generalized: it cuts corners, drops small islands, and leaves genuine
// street-level panoramas sitting in the sea as far as point-in-polygon is concerned. Measured over
// the committed 2334-row pool: 2126 rows land inside a polygon directly and 208 do not, almost all
// of them coastal. Snapping a miss to the nearest polygon EDGE recovers them by distance:
//
//   cap  5km -> 175/208      cap 25km -> 197/208
//   cap 10km -> 196/208      cap 60km -> 204/208
//
// The tail is real islands the 1:50m set generalizes away or places coarsely - Madeira (~48km),
// Macao (~11km), Bonin Islands (~41km). 60km takes all of them while staying far below the width
// of any country, so a snap cannot silently relabel an inland point as a neighbour. The 4 rows
// beyond it are open-ocean panoramas (one 352km into the South China Sea); they keep a null
// country and the reveal falls back to the region name alone.
//
// CONTINENT comes from the same feature, NOT from the pool's own six region bboxes. Those bboxes
// exist to balance the harvest and they overlap awkwardly - the Canary Islands and Madeira sit in
// the Africa bbox, so pairing them with their country would render "Africa · Spain". Natural
// Earth's own CONTINENT field is authoritative and uses the same six names, so the reveal reads
// "Europe · Spain".
//
// ── Transcontinental countries ──────────────────────────────────────────────────────────────
// Natural Earth stores ONE continent per country, which is visibly wrong for the countries that
// straddle a divide. Measured on the committed pool: 37 of 95 Russian rows sit east of the Urals
// (out to 142E, Vladivostok) and would read "Europe · Russia", while 27 of 32 Turkish rows are in
// Anatolia yet NE labels all of Turkey "Asia", so Istanbul would read "Asia · Turkey". DIVIDES
// below overrides those per point. Only countries with pooled rows on both sides are listed -
// Spain and Portugal are deliberately absent: the Canaries and Madeira are geographically African
// but politically European, and "Europe · Spain" is the label a player expects.

const fs = require("fs");
const path = require("path");

const COUNTRIES = path.join(__dirname, "..", "assets", "ne_50m_admin_0_countries.geojson");

// Beyond this, a miss is treated as open ocean rather than snapped to a coast.
const SNAP_CAP_KM = 60;

// Same six names (and therefore the same meaning) as REGIONS in build_geo_pool.js and
// mg_geoguesser.js. "Seven seas (open ocean)" and "Antarctica" also appear in the data; a row
// resolving to either keeps no country, since neither is a useful reveal label.
const CONTINENTS = ["Europe", "North America", "South America", "Africa", "Asia", "Oceania"];

// Per-point continent overrides for countries Natural Earth files under a single continent.
// `test` gets (lon, lat) and returns the CONTINENTS index for that point. Conventional divides:
// Russia/Kazakhstan on the Urals (60E), Turkey on the Bosphorus (29E, with Anatolia south of 41N),
// Egypt on Suez (34E), Indonesia on the Wallace/Lydekker line (Papua from 131E is Oceania).
const DIVIDES = {
    "Russia": function (lon) { return lon >= 60 ? 4 : 0; },
    "Kazakhstan": function (lon) { return lon >= 60 ? 4 : 0; },
    "Turkey": function (lon, lat) { return lon >= 29 && lat <= 41.2 ? 4 : lon >= 31 ? 4 : 0; },
    "Egypt": function (lon) { return lon >= 34 ? 4 : 3; },
    "Indonesia": function (lon) { return lon >= 131 ? 5 : 4; },
    "Timor Leste": function () { return 5; },
};

let features = null;

// Country names ship in a generated table, NOT over the side channel, so they are not restricted
// to the downlink's 63-character alphabet the way provider nicknames are. Only the packed pool's
// own separators (| and newline) and the quote/backslash that would break the emitted JS literal
// have to go. Reusing build_geo_pool.js's safeName() here was wrong and visibly lossy: it turned
// "Côte d'Ivoire" into "C te d Ivoire" and "Timor-Leste" into "Timor Leste".
//
// Two normalisations are deliberate. The apostrophe becomes a right single quote (U+2019) because
// Panorama treats a raw ' in a label as safe but the surrounding tooling quotes with it; and the
// name is capped at 34 characters, which is longer than every Natural Earth NAME in the set.
function safeCountry(value) {
    return String(value || "")
        .replace(/'/g, "’")
        .replace(/[|\n\r"\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 34);
}

function load() {
    if (features) return features;
    const geo = JSON.parse(fs.readFileSync(COUNTRIES, "utf8"));
    features = [];
    for (const feature of geo.features || []) {
        const props = feature.properties || {};
        const geometry = feature.geometry || {};
        const polys = geometry.type === "Polygon" ? [geometry.coordinates]
            : geometry.type === "MultiPolygon" ? geometry.coordinates : null;
        if (!polys) continue;
        // NAME is the everyday form and the right answer to show a player ("Russia", "South
        // Korea", "United States of America"). But it is also the MAP-LABEL form, so it
        // abbreviates where a label had to be short: "Dem. Rep. Congo", "S. Sudan", "Solomon
        // Is.". NAME_LONG spells those out. So: prefer NAME, and only fall back to NAME_LONG
        // when NAME is visibly abbreviated - which is exactly when it contains a period. Taking
        // NAME_LONG unconditionally gives "Russian Federation" and "Republic of Korea".
        const short = String(props.NAME || props.ADMIN || "");
        const name = safeCountry(short.indexOf(".") !== -1 ? (props.NAME_LONG || short) : short);
        if (!name) continue;
        const continent = CONTINENTS.indexOf(String(props.CONTINENT || ""));
        // A bounding box per feature turns the point test from "walk 242 countries' worth of
        // rings" into "walk the handful whose box contains the point".
        let w = 180, s = 90, e = -180, n = -90;
        for (const poly of polys) {
            for (const pt of poly[0]) {
                if (pt[0] < w) w = pt[0];
                if (pt[0] > e) e = pt[0];
                if (pt[1] < s) s = pt[1];
                if (pt[1] > n) n = pt[1];
            }
        }
        features.push({ name: name, continent: continent, polys: polys, box: [w, s, e, n] });
    }
    return features;
}

// Standard ray casting. Ring winding does not matter; only crossing parity does.
function ringContains(ring, lon, lat) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

// GeoJSON polygon: ring 0 is the outer boundary, any further rings are holes (e.g. Lesotho
// inside South Africa), so a point in a hole is NOT in this polygon.
function polygonContains(poly, lon, lat) {
    if (!ringContains(poly[0], lon, lat)) return false;
    for (let i = 1; i < poly.length; i++) {
        if (ringContains(poly[i], lon, lat)) return false;
    }
    return true;
}

// Kilometres from the point to segment a-b, in a flat projection centred on the point. Over the
// tens of kilometres this is used for, the error is far below the snap cap.
function segmentKm(lon, lat, a, b) {
    const kx = Math.cos(lat * Math.PI / 180) * 111.32, ky = 110.57;
    const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky;
    const bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? -(ax * dx + ay * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt(cx * cx + cy * cy);
}

function nearestFeature(lon, lat, capKm) {
    let best = capKm, found = null;
    for (const feature of load()) {
        const box = feature.box;
        // Cheap reject: a feature whose box is already further than the current best in either
        // axis cannot own a closer edge. Degrees-to-km uses the same factors as segmentKm.
        const dLon = lon < box[0] ? box[0] - lon : lon > box[2] ? lon - box[2] : 0;
        const dLat = lat < box[1] ? box[1] - lat : lat > box[3] ? lat - box[3] : 0;
        if (dLon * Math.cos(lat * Math.PI / 180) * 111.32 > best || dLat * 110.57 > best) continue;
        for (const poly of feature.polys) {
            for (const ring of poly) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const km = segmentKm(lon, lat, ring[j], ring[i]);
                    if (km < best) { best = km; found = feature; }
                }
            }
        }
    }
    return found;
}

// Returns { country, continent } - continent is an index into CONTINENTS, or -1 when the feature
// is Antarctica / open ocean. Returns null when the point is further than the snap cap from every
// country, i.e. genuinely at sea.
function continentFor(feature, lon, lat) {
    const divide = DIVIDES[feature.name];
    return divide ? divide(lon, lat) : feature.continent;
}

function resolve(lon, lat) {
    if (!isFinite(lon) || !isFinite(lat)) return null;
    for (const feature of load()) {
        const box = feature.box;
        if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) continue;
        for (const poly of feature.polys) {
            if (polygonContains(poly, lon, lat)) {
                return { country: feature.name, continent: continentFor(feature, lon, lat) };
            }
        }
    }
    const near = nearestFeature(lon, lat, SNAP_CAP_KM);
    return near ? { country: near.name, continent: continentFor(near, lon, lat) } : null;
}

module.exports = {
    resolve: resolve,
    safeCountry: safeCountry,
    CONTINENTS: CONTINENTS,
    SNAP_CAP_KM: SNAP_CAP_KM,
};
