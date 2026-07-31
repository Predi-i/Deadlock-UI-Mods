"use strict";

// Regression guards for the release-audit UI fixes. The FIFO check executes the
// real mg_net.js with a tiny Panorama fake; controller checks keep the relevant
// call sites on that shared lane and ensure pending online actions park timers.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function source(name) {
    return fs.readFileSync(path.join(ROOT, "panorama", "scripts", name), "utf8");
}
function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const scheduled = [];
const startedUrls = [];
const context = makePanel("Panel", null, "context");

function makePanel(type, parent, id) {
    const panel = {
        type: type,
        id: id,
        parent: parent || null,
        children: [],
        style: {},
        actuallayoutwidth: 0,
        actuallayoutheight: 0,
        valid: true,
        IsValid() { return this.valid; },
        SetAttributeString() {},
        SetImage(url) {
            this.url = url;
            if (url) startedUrls.push(url);
        },
        SetParent(next) {
            if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
            this.parent = next;
            next.children.push(this);
        },
        DeleteAsync() { this.valid = false; }
    };
    if (parent) parent.children.push(panel);
    return panel;
}

const $ = {
    MG: {},
    GetContextPanel() { return context; },
    CreatePanel(type, parent, id) { return makePanel(type, parent, id); },
    Schedule(delay, callback) { scheduled.push({ delay: delay, callback: callback }); },
    Msg() {},
    Warning() {}
};

new Function("$", source("mg_net.js"))($);

assert($.MG.Net.pollDelay(0) === 0.5 && $.MG.Net.pollDelay(5) === 0.5 &&
    $.MG.Net.pollDelay(6) === 0.9 && $.MG.Net.pollDelay(17) === 0.9 &&
    $.MG.Net.pollDelay(18) === 1.5,
    "active-game polling must use the bounded 0.5s/0.9s/1.5s VPS cadence");
assert($.MG.Net.waitDelay(0) === 1.5 && $.MG.Net.waitDelay(99) === 5,
    "waiting-room polling must retain its separate conservative cadence");

let firstLoaded = null;
let secondLoaded = null;
const display = makePanel("Panel", context, "display");
$.MG.Net.loadImage("https://example.test/marker.png", function (image) {
    firstLoaded = image;
    image.SetParent(display);
    // Real callbacks frequently enqueue protocol traffic synchronously. It must
    // still wait for the release frame and the older pxview job. An uncalibrated
    // request first queues /api/probe, which is enough to prove both job kinds
    // really share this lane.
    $.MG.Net.request("/api/status", { code: 1 }, function () {});
});
$.MG.Net.loadImage("https://example.test/pxview.png", function (image) {
    secondLoaded = image;
    image.SetParent(display);
});

assert(startedUrls.length === 1 && startedUrls[0].includes("marker.png"),
    "the second external image must wait behind the first");

function runScheduled() {
    assert(scheduled.length > 0, "expected a scheduled Panorama callback");
    scheduled.shift().callback();
}
function findPanel(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const found = findPanel(child, predicate);
        if (found) return found;
    }
    return null;
}

const markerPanel = findPanel(context, panel => panel.url && panel.url.includes("marker.png"));
assert(markerPanel, "marker panel was not created");
markerPanel.actuallayoutwidth = 64;
markerPanel.actuallayoutheight = 64;
runScheduled(); // marker dimension poll completes and synchronously enqueues followup
assert(firstLoaded === markerPanel, "loaded marker ownership must pass to the caller");
assert(startedUrls.length === 1, "the next image must wait for the FIFO release frame");
runScheduled(); // FIFO release frame starts pxview
assert(startedUrls.length === 2 && startedUrls[1].includes("pxview.png"),
    "the next image must start only after the first completed");

const pxPanel = findPanel(context, panel => panel.url && panel.url.includes("pxview.png"));
assert(pxPanel, "Pixel Battle frame panel was not created");
pxPanel.actuallayoutwidth = 800;
pxPanel.actuallayoutheight = 400;
runScheduled();
assert(secondLoaded === pxPanel, "loaded Pixel Battle panel ownership must pass to the caller");
assert(startedUrls.length === 2, "protocol work must still wait while pxview completion is releasing");
runScheduled(); // FIFO release frame starts the calibration probe queued by MG.Net.request
assert(startedUrls.length === 3 && startedUrls[2].includes("/api/probe.png"),
    "dimension-encoded protocol traffic must share the external-image FIFO");
const probePanel = findPanel(context, panel => panel.url && panel.url.includes("/api/probe.png"));
assert(probePanel, "calibration probe panel was not created");
probePanel.actuallayoutwidth = 600;
probePanel.actuallayoutheight = 1000;
runScheduled(); // finish calibration before exercising its ordinary-image discriminator
assert($.MG.Net.isLevelEncodedSize(69, 582),
    "ordinary-image consumers must recognize a calibrated Worker error sentinel");
assert(!$.MG.Net.isLevelEncodedSize(640, 960),
    "an ordinary host-clamped panorama must not be mistaken for a protocol image");
assert(!$.MG.Net.isLevelEncodedSize(640, 1440),
    "the 2880x1440 GeoGuesser source must survive a 640px request-host clamp");

const ui = source("mg_ui.js");
const pixel = source("mg_pixelbattle.js");
const durak = source("mg_durak.js");
const poker = source("mg_poker.js");
const geo = source("mg_geoguesser.js");
const games = source("mg_games.js");
const worker = fs.readFileSync(path.join(ROOT, "server", "worker.core.js"), "utf8");
const baseHud = fs.readFileSync(path.join(ROOT, "panorama", "layout", "base_hud.xml"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "panorama", "styles", "mg.css"), "utf8");

assert(/var MULTI_GAME_IDS = \[1, 2, 3, 4, 5\];/.test(ui),
    "multi-quick tick set must include heads-up Durak");
assert(/function waitForMultiMatch[\s\S]*?isDurakOnlineGame\(st\.game\)[\s\S]*?renderRoom\(code, isHost, true, ctx\)/.test(ui),
    "a multi-quick Durak result must enter its two-seat dealer room");
assert(/function renderRoom[\s\S]*?autoStartOnly:\s*true/.test(ui),
    "a matched heads-up Durak room must rely on server auto-start");
assert(/function mountOnlineGame[\s\S]*?function retryMatch[\s\S]*?MG\.Api\.match[\s\S]*?m\.gone[\s\S]*?m\.variant/.test(ui) &&
    !/function mountOnlineGame[\s\S]{0,1400}opts\.variant\s*=\s*"russian"/.test(ui),
    "online checkers must retry authoritative match metadata instead of guessing Russian");
const net = source("mg_net.js");
assert(/clocks:\s*function[\s\S]*?w === 9 && h === 8/.test(net) &&
    /if \(w === 9\) \{ fail\(/.test(net) &&
    /request\("\/api\/clocks"[\s\S]{0,1000}\}, fail\);/.test(net),
    "clock transport/server failures must reach createClock's retry callback");
assert(/function resyncTick[\s\S]*?function \(\) \{ if \(!stopped\) \$\.Schedule/.test(games),
    "createClock must retain a retry path for transient authoritative-clock failures");
assert(/var RESYNC_S = 8;/.test(games),
    "authoritative clock resync must stay infrequent so it cannot crowd out move traffic");
assert(/status:\s*function \(code, tok, cb, err\)[\s\S]{0,150}tok:\s*tok \|\| ""/.test(net) &&
    /room:\s*function \(code, tok, cb, err\)/.test(net) &&
    /droom:\s*function \(code, tok, cb, err\)/.test(net) &&
    /proom:\s*function \(code, tok, cb, err\)/.test(net) &&
    /cfg\.roomApi\(code, ctx \? ctx\.tok : currentTok/.test(ui),
    "authenticated waiting-room polls must carry their seat token for sparse TTL refresh");
const statusSource = net.match(/status:\s*function[\s\S]*?\r?\n        },\r?\n\r?\n        \/\/ Resolved-options/);
const matchSource = net.match(/match:\s*function[\s\S]*?\r?\n        },\r?\n\r?\n        \/\/ The seat token/);
assert(statusSource && /w === 9 && h === 1/.test(statusSource[0]) &&
    /err\("transient"\)/.test(statusSource[0]) &&
    matchSource && /w === 9 && h === 1/.test(matchSource[0]) &&
    /err\("transient"\)/.test(matchSource[0]),
    "status/match must retry non-gone server sentinels instead of closing a live lobby");
assert(/function checkUpdates[\s\S]*?MG\.Net\.loadImage\(url,/.test(ui),
    "update marker must load through the shared MG.Net FIFO");
assert(!/function checkUpdates[\s\S]*?img\.SetImage\(url\)/.test(ui),
    "update marker must not start a direct Image.SetImage request");
assert(/function refreshCrispView[\s\S]*?MG\.Net\.loadImage\(url,/.test(pixel),
    "Pixel Battle viewport must load through the shared MG.Net FIFO");
assert(!/crispImage\.SetImage\(MG\.Net\.getBaseUrl\(\)/.test(pixel),
    "Pixel Battle must not bypass the FIFO with a direct remote SetImage");
assert(/function loadPanorama[\s\S]*?MG\.Net\.loadImage\(url,/.test(geo),
    "GeoGuesser's cold panorama load must use the shared MG.Net FIFO");
assert(/MG\.Net\.isLevelEncodedSize\(loadedW, loadedH\)/.test(geo) &&
    !/var aspect = shortSide > 0/.test(geo),
    "GeoGuesser must not validate intrinsic panorama aspect from host-clamped layout dimensions");
// An <Image> `scaling` token the engine doesn't know is NOT an error — it silently falls back to
// the native-size default, which letterboxes the bitmap inside the panel. That is what made the
// GeoGuesser panorama paint 2048x1024 centred in its 2880x1440 strip (416px of black each side,
// 208px top/bottom) and limited the usable heading to roughly 95°..270° in-game. Whitelist taken
// from every scaling= token that appears on an <Image> in G:\GameTracking-Deadlock.
(function () {
    var VALID = ["stretch-to-fit-preserve-aspect", "stretch-to-fit-y-preserve-aspect",
        "stretch-to-fit-x-preserve-aspect", "stretch-to-cover-preserve-aspect",
        "cover", "contain", "none"];
    var files = { "mg_geoguesser.js": geo, "mg_ui.js": ui, "mg_pixelbattle.js": pixel, "mg_net.js": net };
    var bad = [];
    Object.keys(files).forEach(function (name) {
        var re = /scaling:\s*"([a-z-]+)"/g, m;
        while ((m = re.exec(files[name]))) {
            if (VALID.indexOf(m[1]) === -1) bad.push(name + ': "' + m[1] + '"');
        }
    });
    assert(bad.length === 0,
        "unknown <Image> scaling token (silently falls back to native size):\n  " + bad.join("\n  "));
})();
assert(/var PANO_SCALING = "cover"/.test(geo) &&
    !/scaling: *"stretch-to-fit"/.test(geo),
    "GeoGuesser panorama strips must use a scaling token that fills the whole 2880x1440 box");
assert(/PANO_W = 2880, PANO_H = 1440, PANO_STEP = PANO_W - 2/.test(geo) &&
    /configurePanoImage\(image, PANO_STEP\)/.test(geo) &&
    /addCachedCopy\(url, PANO_STEP \* 2, myGen/.test(geo),
    "GeoGuesser's three panorama strips must share one exact, slightly-overlapped step");
// The side copies must ride the shared FIFO. A direct `copy.SetImage(url)` overlaps the centre
// load and the running polls, which wedges Panorama's image loader: both neighbours stall at
// dims 0 and never paint, leaving a mostly BLACK viewport (and an empty frame once heading walks
// onto the missing copy). Also assert the reveal is CHAINED off the second copy rather than
// fired by a fixed timer that can't know whether the loads finished.
assert(/function addCachedCopy\(url, offset, myGen, done\)[\s\S]{0,600}MG\.Net\.loadImage\(url,/.test(geo) &&
    !/\$\.CreatePanel\("Image", stage[\s\S]{0,200}SetImage\(url\)/.test(geo) &&
    /addCachedCopy\(url, 0, myGen, function \(\)[\s\S]{0,400}addCachedCopy\(url, PANO_STEP \* 2, myGen, function \(\)[\s\S]{0,300}panoramaReady = true/.test(geo),
    "GeoGuesser's side panorama copies must load through the shared FIFO and gate panoramaReady");
// The 359°→0° wrap re-centres the strip by a whole PANO_STEP. With the transition on the BASE
// class the engine animates that 2878px jump and it reads as a super-fast full spin, so the
// transition must live on a toggled class that applyCamera drops for the wrap frame.
assert(/\.mg-geo-stage\s*\{[^}]*\}/.test(css) &&
    !/\.mg-geo-stage\s*\{[^}]*transition-property/.test(css) &&
    /\.mg-geo-stage\.mg-geo-anim\s*\{[^}]*transition-property:\s*transform;/.test(css) &&
    /Math\.abs\(x - lastStageX\) > PANO_STEP \/ 2/.test(geo) &&
    /if \(wrapped\) stage\.RemoveClass\("mg-geo-anim"\)/.test(geo),
    "GeoGuesser must not animate the yaw-wrap re-centre (fast-spin artifact at the 359/0 seam)");
// All four stacked rows share one width, or the panorama sits inset above a wider map row and the
// panel reads as ragged/cut off. VIEW_W/VIEW_H in the controller must match the CSS viewport.
(function () {
    var want = ["\\.mg-geo\\s*\\{", "\\.mg-geo-stats\\s*\\{", "\\.mg-geo-viewport\\s*\\{",
        "\\.mg-geo-camera-controls\\s*\\{", "\\.mg-geo-lower\\s*\\{"];
    want.forEach(function (sel) {
        var block = new RegExp(sel + "[^}]*width:\\s*860px;").test(css);
        assert(block, "GeoGuesser row " + sel.replace(/\\\\|\\s\*\\\{/g, "") + " must be 860px wide");
    });
    assert(/var VIEW_W = 860, VIEW_H = 360;/.test(geo) &&
        /\.mg-geo-viewport\s*\{[^}]*height:\s*360px;/.test(css),
        "GeoGuesser VIEW_W/VIEW_H must match the CSS viewport box");
})();
// Pitch is 8px per degree (1440px strip / 180°). The old hard-coded 4 moved at half rate. And the
// constant must be declared AFTER PANO_H — `var` hoists the name, not the value, so reading it a
// line early silently yields NaN and breaks tilt while every syntax check still passes.
assert(/var PANO_W = 2880, PANO_H = 1440[\s\S]{0,600}var PITCH_PX_PER_DEG = PANO_H \/ 180;/.test(geo) &&
    /pitch \* PITCH_PX_PER_DEG/.test(geo),
    "GeoGuesser pitch must use PITCH_PX_PER_DEG, declared after PANO_H");
// Map zoom: engine has no ondblclick, so the run is timestamp-keyed, and a new round must reset to
// the whole world (a leftover 8x zoom would strand the player in an unrelated region).
assert(/var MULTI_CLICK_MS = 400;/.test(geo) &&
    /clickRun = \(now - lastClickAt < MULTI_CLICK_MS\) \? clickRun \+ 1 : 1;/.test(geo) &&
    /if \(clickRun === 2\) setMapZoom\(mapZoomLevel \* 2, f\.x, f\.y\);/.test(geo) &&
    /else if \(clickRun >= 3\) setMapZoom\(1, null, null\);/.test(geo) &&
    /clearMapMarkers\(\);[\s\S]{0,400}setMapZoom\(1, null, null\);/.test(geo),
    "GeoGuesser map must zoom on double-click, reset on triple-click, and reset each round");
// Precision comes from the hit grid NOT scaling with the map: it is a sibling of the zoom
// wrapper, pinned over the window, so at zoom Z its 64x32 panels address 64Z x 32Z cells. If it
// were created inside mapZoom again, zooming would just enlarge the same coarse cells.
assert(/var grid = \$\.CreatePanel\("Panel", map, ""\);/.test(geo) &&
    !/\$\.CreatePanel\("Panel", mapZoom, ""\);\s*\n\s*grid\.AddClass/.test(geo) &&
    /x: panX \+ \(col \+ 0\.5\) \/ \(GRID_W \* mapZoomLevel\)/.test(geo),
    "GeoGuesser hit grid must stay fixed over the window so zoom buys precision");
// Reveal points are world-anchored panels, not tinted grid buttons: a grid button points
// somewhere else the moment the window pans. Labels/markers must not eat the grid's clicks.
assert(/labelLayer\.SetAttributeString\("hittest", "false"\)/.test(geo) &&
    /markerLayer\.SetAttributeString\("hittest", "false"\)/.test(geo) &&
    /function addMarker\(cell, cls\)/.test(geo) &&
    !/function markPoint\(/.test(geo),
    "GeoGuesser reveal markers must be world-anchored and input-transparent");
// A 512x256 point overflows the two-level base-63 reply, so each axis is its own request and the
// marker may only be placed once BOTH halves are in.
assert(/MG\.Api\.geoTarget\(code, tok, axis, ok, fail\)/.test(geo) &&
    /function readPoint\(fetch, cls\)[\s\S]{0,400}fetch\(0, ok, fail\)[\s\S]{0,300}fetch\(1, ok2, fail2\)/.test(geo) &&
    /revealReadsPending = solo \? 7 : 10;/.test(geo),
    "GeoGuesser reveal must read each point axis-by-axis and wait for both halves");
assert(/images\/geoguesser\/world_map\.vtex/.test(geo) &&
    /var GRID_W = 64, GRID_H = 32/.test(geo),
    "GeoGuesser must use its dedicated map and fine 64x32 authoritative guess grid");
// The de-glow overrides only bind if they out-specify the GAME's own `Slider.HorizontalSlider
// #SliderThumb` (111) — a bare `.mg-geo-camera-controls #SliderThumb` is 110 and loses, which is
// why the green glow survived the first pass (trap 22). Assert the winning prefix on all three
// sub-panels plus the hover/active states, and that `none` is used rather than a transparent
// zero shadow (which does not clear the game's `fill`-keyword glow).
assert(/\.mg-geo-camera-controls Slider\.HorizontalSlider #SliderThumb\s*\{[\s\S]{0,400}background-image:\s*none;[\s\S]{0,400}box-shadow:\s*none;/.test(css) &&
    /\.mg-geo-camera-controls Slider\.HorizontalSlider #SliderTrackProgress\s*\{[\s\S]{0,300}box-shadow:\s*none;/.test(css) &&
    /\.mg-geo-camera-controls Slider\.HorizontalSlider #SliderThumb:hover\s*\{[\s\S]{0,300}box-shadow:\s*none;/.test(css) &&
    /#SliderThumb:active\s*\{[\s\S]{0,300}box-shadow:\s*none;/.test(css) &&
    !/\.mg-geo-camera-controls[\s\S]{0,2000}#62f28c/.test(css),
    "GeoGuesser camera controls must out-specify and suppress the native slider glow (trap 22)");
// House style has no outer glow anywhere: no rule may carry a zero-offset blurred box-shadow.
// A hard ring (`0px 0px 0px 3px`, zero blur) and offset drop shadows are both still fine.
(function () {
    // Blank out /* … */ comments, PRESERVING newlines so reported line numbers stay accurate.
    // Needed because the trap-22 note and the .mg-pk-active note both QUOTE the removed glow
    // declarations verbatim, and a naive scan flags its own documentation.
    var live = css.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, " "); });
    var glow = [];
    live.split(/\r?\n/).forEach(function (line, i) {
        var decl = /box-shadow:\s*([^;}]+)/.exec(line);
        if (!decl) return;
        // Tokenise instead of pattern-matching the whole value: `fill`/`inset` keywords and colours
        // (#rrggbbaa, brandGreen&11, rgba(...)) may precede OR follow the lengths, and a single
        // regex with an optional prefix can silently absorb the first 0px and mistake the SPREAD
        // for the blur — which is what made `0px 0px 0px 3px` (a hard ring) read as a glow.
        var lengths = decl[1].split(/\s+/)
            .filter(function (t) { return /^-?[\d.]+px$/.test(t); })
            .map(parseFloat);
        // Glow = no offset in either axis AND a non-zero blur radius. Offset drop shadows and
        // zero-blur spread rings are both legitimate house style.
        if (lengths.length >= 3 && lengths[0] === 0 && lengths[1] === 0 && lengths[2] > 0) {
            glow.push((i + 1) + ": " + line.trim());
        }
    });
    assert(glow.length === 0, "no outer glow allowed in mg.css, found:\n  " + glow.join("\n  "));
})();
assert(/\.mg-geo-cell\s*\{[\s\S]{0,250}width:\s*fill-parent-flow\(1\);[\s\S]{0,250}border-radius:\s*50%;/.test(css),
    "GeoGuesser map selection must render as fine circular markers, not coarse squares");
assert(/RegisterEventHandler\("DragStart"[\s\S]*?RegisterEventHandler\("DragEnd"/.test(geo) &&
    /MG\.Widgets\.winPos\(dragGhost\)/.test(geo),
    "GeoGuesser must reuse the proven chess/checkers native drag position channel");
assert(/\$\.CreatePanel\("Slider"[\s\S]*?onvaluechanged[\s\S]*?yaw = nextYaw/.test(geo) &&
    /\$\.CreatePanel\("Slider"[\s\S]*?onvaluechanged[\s\S]*?pitch = nextPitch/.test(geo),
    "GeoGuesser must keep a continuous native-slider camera path when image drag updates only on release");
assert(/revealReadsPending = solo \? 7 : 10;[\s\S]*?setAction\("LOADING RESULT…", false/.test(geo) &&
    /revealReadsPending === 0[\s\S]*?setAction\(currentRound/.test(geo),
    "GeoGuesser must not allow next/finish before every authoritative reveal read completes");
// The pool is PREBUILT (server/geo_pool.generated.js) rather than swept live, so this no longer
// looks for a catalog URL. What still matters: the pool is large and two-source, the reveal credits
// whichever project the location came from, and nobody has quietly gone back to a handful of
// hard-coded places.
assert(/geoCredit:\s*function[\s\S]*?\/api\/geocredit/.test(net) &&
    /MG\.Api\.geoCredit\(code, tok/.test(geo) &&
    /Mapillary  CC BY SA 4\.0/.test(worker) && /Panoramax  CC BY SA 4\.0/.test(worker) &&
    !/const GEO_LOCATIONS =/.test(worker),
    "GeoGuesser must credit both panorama sources and keep its locations out of a hard-coded list");
(function () {
    // The pool lives in the GENERATED artifact, not the authored core, so read that one here.
    const built = fs.readFileSync(path.join(ROOT, "server", "worker.js"), "utf8");
    const packed = /const GEO_POOL_PACKED = "([^"]*)"/.exec(built);
    assert(packed, "the generated worker must carry the prebuilt GeoGuesser pool");
    const rows = packed[1].split("\\n").filter(Boolean);
    assert(rows.length >= 1000,
        "the GeoGuesser pool must stay large (found " + rows.length + " locations, want 1000+)");
    // Even coverage is the whole point of the offline build: a pool that is 90% Europe makes five
    // rounds feel like one country. Every labelled region must be represented.
    const perRegion = [0, 0, 0, 0, 0, 0];
    for (const row of rows) {
        const region = Number(row.split("|")[4]);
        if (region >= 0 && region < 6) perRegion[region]++;
    }
    assert(perRegion.every(function (count) { return count >= 50; }),
        "every GeoGuesser region needs 50+ pooled locations, got " + perRegion.join("/"));
})();
assert(/bl\.text = selectedGameId === 9 \? "PLAY SOLO" : "PLAY VS BOT"/.test(ui) &&
    /function startGeoSolo\(\)[\s\S]*?MG\.Api\.create\(9,[\s\S]*?\{ solo: true \}/.test(ui) &&
    /if \(access\.lobby\.solo\) st\.ready\[1\] = 1/.test(worker) &&
    /code === null \|\| code === undefined \|\| !tok/.test(geo),
    "GeoGuesser Play Solo must create a server-backed session and advance without a second client");
assert(/MG\.Games\.register\(\{ id: 9,[\s\S]*?enabled: true \}\)/.test(geo) &&
    /mg_geoguesser\.vjs_c/.test(baseHud),
    "GeoGuesser controller must be registered and loaded before the menu shell");
assert(/var aspect = shortSide > 0 \? longSide \/ shortSide : 0;[\s\S]{0,350}Map server is busy/.test(pixel),
    "Pixel Battle must reject and retry the Worker's viewport-throttle image sentinel");
assert(/lastOuterStatus === "Map server is busy\. Retrying…"[\s\S]{0,100}Shared world loaded/.test(pixel),
    "Pixel Battle must clear the busy status after a successful viewport retry");
assert(/if \(!crispReady\)[\s\S]{0,200}Map view is still loading/.test(pixel) &&
    /function scheduleCrispView[\s\S]{0,250}crispReady = false/.test(pixel),
    "Pixel Battle must block grid clicks while the matching viewport frame is loading");

for (const entry of [{ name: "Durak", text: durak }, { name: "Poker", text: poker }]) {
    assert(/pendingAct = true;\s*refreshTimer\(\);/.test(entry.text),
        entry.name + " must park its timer before starting the action request");
    assert(/function onTimerExpire[\s\S]{0,500}pendingAct/.test(entry.text),
        entry.name + " expiry must ignore a pending authoritative action");
    const send = entry.text.match(/function sendAct[\s\S]*?\n        }\n/);
    assert(send && (send[0].match(/refreshTimer\(\)/g) || []).length >= 3,
        entry.name + " must re-arm after both rejection and transport failure");
}

console.log("release UI regression tests passed (shared image FIFO, timers, multi-quick)");
