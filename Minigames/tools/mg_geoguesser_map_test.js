"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const pngPath = path.join(ROOT, "panorama", "images", "geoguesser", "world_map.png");
const assetDir = path.join(__dirname, "assets");
const controller = fs.readFileSync(
    path.join(ROOT, "panorama", "scripts", "mg_geoguesser.js"), "utf8");
const ui = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");
const citiesSrc = fs.readFileSync(
    path.join(ROOT, "panorama", "scripts", "mg_geoguesser_cities.generated.js"), "utf8");
const baseHud = fs.readFileSync(
    path.join(ROOT, "panorama", "layout", "base_hud.xml"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const png = fs.readFileSync(pngPath);
assert(png.length > 24 && png[0] === 137 && png[1] === 80, "GeoGuesser map must be a PNG");
// 2:1 is load-bearing: the server projects lon/lat linearly onto this image (geoLonX/geoLatY),
// so any other aspect silently skews every guess. 2048x1024 keeps the 8x zoom readable.
const mapW = png.readUInt32BE(16), mapH = png.readUInt32BE(20);
assert(mapW === 2048 && mapH === 1024,
    `GeoGuesser map must be 2048x1024 (2:1 equirectangular), got ${mapW}x${mapH}`);

// Every layer the builder draws must be committed, or a rebuild silently loses detail.
// ne_50m_urban_areas is deliberately NOT here any more: the natural-colour raster already carries
// settlement tone, and the grey wash on top only muddied the land colour it exists to show.
["ne_50m_admin_0_countries", "ne_50m_lakes", "ne_50m_rivers_lake_centerlines",
    "ne_110m_admin_1_states_provinces_lines",
    "ne_110m_populated_places"].forEach((layer) => {
    const file = path.join(assetDir, layer + ".geojson");
    assert(fs.existsSync(file), `missing Natural Earth layer: ${layer}`);
});
const countries = JSON.parse(
    fs.readFileSync(path.join(assetDir, "ne_50m_admin_0_countries.geojson"), "utf8"));
assert(countries.type === "FeatureCollection" && countries.features.length >= 170,
    "GeoGuesser map source must contain Natural Earth country boundaries");

// Land colour comes from the natural-colour raster, not a flat fill. Two flat palettes (grey, then
// dark brown) were both rejected as monotone: one fill cannot show a continent's variety, whatever
// its hue. The committed downsample is what the map builder reads, so a clone never needs the
// 207 MiB source.
const rasterPath = path.join(assetDir, "ne2_natural_2048.png");
assert(fs.existsSync(rasterPath), "missing the natural-colour land raster (tools/build_ne_raster.js)");
const rasterPng = fs.readFileSync(rasterPath);
assert(rasterPng.readUInt32BE(16) === 2048 && rasterPng.readUInt32BE(20) === 1024,
    "the land raster must be 2048x1024 so it samples 1:1 against the map");
const builder = fs.readFileSync(path.join(__dirname, "build_geoguesser_map.js"), "utf8");
assert(/fillPolygon\(polygonRings\(polygon\), landColor\)/.test(builder),
    "country polygons must MASK the natural-colour raster, not take a flat fill");

assert(/images\/geoguesser\/world_map\.vtex/.test(controller),
    "the game board must use the dedicated GeoGuesser map");
// The picker card takes the SAME cards/<key>.vtex path as every other game. It used to
// special-case id 9 onto world_map.vtex because no card art existed; a map is not card art.
// Accept either the concatenated or the template-literal spelling; the PATH is the invariant.
assert((/"s2r:\/\/panorama\/images\/cards\/" \+ g\.key \+ "\.vtex"/.test(ui) ||
    /`s2r:\/\/panorama\/images\/cards\/\$\{g\.key\}\.vtex`/.test(ui)) &&
    !/g\.id === 9/.test(ui),
    "the picker card must use cards/<key>.vtex, with no GeoGuesser special case");

// City names are Panorama Labels, not baked pixels (the PNG encoder has no font renderer), so
// the generated manifest must exist, be loaded BEFORE the controller, and carry usable records.
assert(/MG\.GeoCities = \[/.test(citiesSrc), "city manifest must publish MG.GeoCities");
const cityCount = (citiesSrc.match(/"n":/g) || []).length;
assert(cityCount >= 200, `expected the full populated-places set, got ${cityCount}`);
assert(/"x":[\d.]+,"y":[\d.]+,"r":\d/.test(citiesSrc),
    "city records must carry map fractions plus a SCALERANK for the zoom threshold");
const citiesInclude = baseHud.indexOf("mg_geoguesser_cities.generated");
const controllerInclude = baseHud.indexOf("mg_geoguesser.vjs_c");
assert(citiesInclude > 0 && controllerInclude > 0 && citiesInclude < controllerInclude,
    "base_hud.xml must load the city manifest before mg_geoguesser");

// Label decluttering. Two independent gates, and BOTH have to stay: rank alone left 68 names on a
// 500px world view (the Balkans became an unreadable pile), and no rank threshold can ever
// separate two cities 30px apart, so the overlap test is what actually fixes clusters.
assert(/function cityRankLimit\(\)[\s\S]{0,220}return 0;/.test(controller),
    "1x must show only rank-0 capitals (rank<=1 put 68 labels on the world view)");
assert(/placed\.push\(\[left, top, right, bottom\]\)/.test(controller) &&
    /left - CITY_PAD_X < other\[2\] && right \+ CITY_PAD_X > other\[0\]/.test(controller),
    "city labels must reject a box overlapping one already placed");
// An off-screen label must be culled BEFORE the overlap test, or at zoom it silently wins a slot
// from a name the player can actually see.
assert(/viewLeft = panX \* MAP_W \* mapZoomLevel/.test(controller) &&
    /right < viewLeft \|\| left > viewRight/.test(controller),
    "city labels outside the map window must be culled before the overlap test");

// Round timer: 60s, not the shared 25s default, and it must be released on destroy or its
// $.Schedule chain keeps firing at a deleted panel.
assert(/\b(?:var|let|const) ROUND_SECS = 60;/.test(controller) &&
    /roundTimer\.start\(onRoundTimeout, ROUND_SECS\)/.test(controller),
    "GeoGuesser must run a 60s per-round timer");
assert(/if \(selectedCell < 0\) selectedCell = 0;[\s\S]{0,120}submitGuess\(\);/.test(controller),
    "a timeout must submit a guess rather than stall the opponent's reveal");
assert(/if \(roundTimer\) roundTimer\.destroy\(\);/.test(controller),
    "the round timer must be destroyed with the controller");

// The map is now a light natural-colour raster, so the label ink and the markers must be the
// light-background set. Pale text on a black shadow was invisible over desert and ice.
const css = fs.readFileSync(path.join(ROOT, "panorama", "styles", "mg.css"), "utf8");
assert(/\.mg-geo-city\s*\{[^}]*color:\s*#26282b/.test(css) &&
    /\.mg-geo-city\s*\{[^}]*text-shadow:[^;]*#ffffff/.test(css),
    "city labels must be dark ink with a light halo for the light map");
assert(/\.mg-geo-marker\s*\{[^}]*border:\s*1px solid #ffffff/.test(css),
    "guess markers need a white ring to separate from the light map");

// The hit grid stays 64x32 PANELS; zoom is what makes a guess finer. FULL_W/H is the
// authoritative space and must equal GRID * MAP_ZOOM_MAX, and match the worker.
// These assertions pin the VALUES, not the declaration keyword: `(?:var|let|const)` so the
// ES6 pass (and any later one) cannot break a check that is really about 64x32 / 512x256.
assert(/\b(?:var|let|const) GRID_W = 64, GRID_H = 32/.test(controller),
    "GeoGuesser hit grid must stay 64x32 panels");
const mapDecl = /\b(?:var|let|const) MAP_W = (\d+), MAP_H = (\d+), MAP_ZOOM_MAX = (\d+);/.exec(controller);
assert(/\b(?:var|let|const) FULL_W = 512, FULL_H = 256;/.test(controller) && mapDecl,
    "authoritative guess space must be GRID * MAP_ZOOM_MAX = 512x256");
const winW = Number(mapDecl[1]), winH = Number(mapDecl[2]), zoomMax = Number(mapDecl[3]);
assert(64 * zoomMax === 512 && 32 * zoomMax === 256,
    "MAP_ZOOM_MAX must take the 64x32 grid exactly to the authoritative 512x256");
// ⚠ The REAL constraint on the window size, and the one that shipped broken: a hit cell is
// MAP_W / GRID_W px, and Panorama lays panels out on whole pixels. At the old 500x250 that was
// 7.8125px, which the engine rounded to 8 — so the painted cells and the click arithmetic
// addressed different pixels, drifting from x=47 and reaching two cells at the right edge (the
// "always selects one cell to the left" report). Pin divisibility, not a magic number, so any
// future resize is free as long as it stays exact.
assert(winW % 64 === 0 && winH % 32 === 0,
    `map window ${winW}x${winH} must divide evenly by the 64x32 hit grid, or a laid-out cell ` +
    "rounds to a different pixel than the click maths and the selection drifts left");
// The CSS window must agree with the JS constant, or the same drift returns from the other side.
assert(new RegExp(`\\.mg-geo-map\\s*\\{[^}]*width:\\s*${winW}px[^}]*height:\\s*${winH}px`).test(css),
    ".mg-geo-map must match MAP_W/MAP_H in the controller");
const worker = fs.readFileSync(path.join(ROOT, "server", "worker.core.js"), "utf8");
assert(/const GEO_GRID_W = 512;/.test(worker) && /const GEO_GRID_H = 256;/.test(worker),
    "worker GEO_GRID_W/H must match the client's FULL_W/H");

// ── reveal + camera row ──────────────────────────────────────────────────────────────────────
// The target marker must survive an accurate guess. Panorama paints siblings in creation order
// and showReveal reads the target FIRST, so a same-size guess dot created later covered it: at 1x
// the world is one map wide, a good guess is sub-pixel away, and the answer vanished entirely.
// BOTH halves are load-bearing - the size difference alone leaves a dead-on guess ambiguous, and
// the z-order alone is invisible when the dots coincide exactly.
assert(/\b(?:var|let|const) TARGET_SZ = (\d+);/.test(controller),
    "the reveal target needs its own marker size");
const targetSz = Number(/\b(?:var|let|const) TARGET_SZ = (\d+);/.exec(controller)[1]);
const markerSz = Number(/\b(?:var|let|const) MARKER_SZ = (\d+);/.exec(controller)[1]);
assert(targetSz > markerSz,
    "the reveal target must be LARGER than a guess dot or an accurate guess hides it");
assert(/function raiseTargetMarkers\(\)/.test(controller) &&
    /raiseTargetMarkers\(\);/.test(controller),
    "the reveal target must be raised above the guess dots");
assert(new RegExp(`\\.mg-geo-target\\s*\\{[^}]*width:\\s*${targetSz}px`).test(css),
    ".mg-geo-target CSS size must match TARGET_SZ");

// The reveal auto-advances. Without it a player who looked away simply stopped playing. Every
// path that ends a reveal must cancel the countdown, or a stale $.Schedule tick fires readyNext
// during the NEXT round (the createTurnTimer `gen` lesson).
assert(/\b(?:var|let|const) AUTO_NEXT_SECS = \d+;/.test(controller) &&
    /function startAutoNext\(\)/.test(controller),
    "the reveal must count down to the next round on its own");
["function beginRound", "function finishGame", "function readyNext"].forEach((fn) => {
    const at = controller.indexOf(fn);
    assert(at > 0 && /stopAutoNext\(\);/.test(controller.slice(at, at + 700)),
        `${fn} must cancel the auto-advance countdown`);
});

// The LOOK/TILT camera row is hidden, and the timer takes its slot as a horizontal bar. The
// controls are kept (not deleted) as the working reference for the next slider, including the
// de-glow specificity fight in trap 22 - so both facts are pinned.
assert(/cameraControls\.visible = false;/.test(controller),
    "the camera slider row must be hidden");
assert(/createTurnTimer\(root, \{ horizontal: true \}\)/.test(controller),
    "GeoGuesser's round timer must be the horizontal variant, parented into its own column");
const games = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_games.js"), "utf8");
const trackW = Number(/\b(?:var|let|const) TRACK_W = (\d+);/.exec(games)[1]);
// Same class of coupling as TRACK_H: the fill slides by exactly this many px, so a CSS-only
// change would drain the bar to the wrong place with nothing failing.
assert(new RegExp(`\\.mg-tt-horiz \\.mg-tt-track\\s*\\{[^}]*width:\\s*${trackW}px`).test(css),
    "the horizontal track's CSS width must match TRACK_W in createTurnTimer");
// The horizontal fill must slide by NEGATIVE TRACK_W: the remaining time is anchored at the LEFT
// edge, so it has to leave through the left. A positive slide drained the wrong way in-game.
assert(new RegExp(`horizontal[\\s\\S]{0,120}translate3d\\(-\\$\\{TRACK_W\\}px`).test(games),
    "the horizontal timer must drain right-to-left (negative TRACK_W slide)");
// Two digits must fit beside the bar. At 26px the engine ellipsised "60" to "6…" while a single
// digit was fine, so this pins headroom rather than an exact width.
const numW = Number(/\.mg-tt-horiz \.mg-tt-num\s*\{[^}]*width:\s*(\d+)px/.exec(css)[1]);
assert(numW >= 34,
    `the horizontal timer's seconds label is ${numW}px; two 17px bold digits need >= 34px or ` +
    "Panorama truncates them to an ellipsis");

// Images must NOT be hidden while loading, and must be styled BEFORE they are re-parented.
// Both halves are scars: `opacity: 0` on the loading <Image> stopped the engine loading it at all
// (dims stayed 0 for the full 8s timeout, GeoGuesser hung on "Loading panorama…"), and parenting
// before styling flashed a full-size frame at the visible layer's top-left.
const net = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_net.js"), "utf8");
const imageReq = net.slice(net.indexOf("function imageRequestNow"),
    net.indexOf("function rawRequestNow"));
assert(!/img\.style\.opacity/.test(imageReq),
    "the loading <Image> must not be given an opacity - a zero-opacity panel is never loaded");
assert(!/showLoadedImage/.test(net),
    "the opacity-based reveal helper broke all image loading and must stay removed");
function parentedLast(source, fn, parentCall) {
    const at = source.indexOf(fn);
    if (at < 0) return false;
    // Wide enough to reach the parent call in refreshCrispView (~3.3k in), which sits behind a
    // long aspect-sanity guard. Bounded at the call itself so a later unrelated .style.* write
    // cannot make the check pass or fail by accident.
    const body = source.slice(at, at + 6000);
    const parent = body.indexOf(parentCall);
    if (parent < 0) return false;
    const before = body.slice(0, parent);
    const lastStyle = Math.max(before.lastIndexOf(".style.width"), before.lastIndexOf(".style.height"),
        before.lastIndexOf(".style.transform"));
    return lastStyle > 0;
}
assert(parentedLast(controller, "function configurePanoImage", "SetParent(stage)"),
    "GeoGuesser must size each panorama copy before parenting it into the stage");
const pixel = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_pixelbattle.js"), "utf8");
assert(parentedLast(pixel, "function refreshCrispView", "SetParent(crispLayer)"),
    "Pixel Battle must size its viewport image before parenting it into the visible layer");

console.log("GeoGuesser map passed: Natural Earth layers, 2048x1024, " +
    cityCount + " cities, 512x256 guess space");
