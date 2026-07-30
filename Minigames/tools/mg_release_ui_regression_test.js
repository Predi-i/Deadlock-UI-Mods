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

const ui = source("mg_ui.js");
const pixel = source("mg_pixelbattle.js");
const durak = source("mg_durak.js");
const poker = source("mg_poker.js");
const geo = source("mg_geoguesser.js");
const games = source("mg_games.js");
const baseHud = fs.readFileSync(path.join(ROOT, "panorama", "layout", "base_hud.xml"), "utf8");

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
assert(/RegisterEventHandler\("DragStart"[\s\S]*?RegisterEventHandler\("DragEnd"/.test(geo) &&
    /MG\.Widgets\.winPos\(dragGhost\)/.test(geo),
    "GeoGuesser must reuse the proven chess/checkers native drag position channel");
assert(/\$\.CreatePanel\("Slider"[\s\S]*?onvaluechanged[\s\S]*?yaw = nextYaw/.test(geo) &&
    /\$\.CreatePanel\("Slider"[\s\S]*?onvaluechanged[\s\S]*?pitch = nextPitch/.test(geo),
    "GeoGuesser must keep a continuous native-slider camera path when image drag updates only on release");
assert(/revealReadsPending = 6;[\s\S]*?setAction\("LOADING RESULT…", false/.test(geo) &&
    /revealReadsPending === 0[\s\S]*?setAction\(currentRound/.test(geo),
    "GeoGuesser must not allow next/finish before every authoritative reveal read completes");
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
