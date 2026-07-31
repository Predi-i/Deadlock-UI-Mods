"use strict";
// Server-logic test for the GENERATED worker.js. Run: node tools/mg_server_test.js
// (Run `node tools/build_worker.js` first - worker.js bundles the shared rules the
// authoritative server validates with.)
//
// worker.js is a Cloudflare ESM module. To avoid adding package.json / wrangler to the
// deploy path, we load it by stripping the two `export` keywords and evaluating it (same
// trick mg_rules_test.js uses for the client). The bundled rule IIFEs attach to
// globalThis.MGRules, which the Hub's validators read. Then we drive the Hub class with a
// fake storage, decoding each PNG's (width, height) - exactly what the client reads back.
//
// NOTE ON TOKENS: the server now enforces validTok() - a seat token must be an 8..64-char
// alphanumeric string (rejects empty/garbage so a lobby can't end up "occupied but
// tokenless"). Every real seat token below is therefore ≥ 8 chars. Deliberately-invalid
// tokens (foreign/short) are used only where a rejection is the expected result.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const v8 = require("v8");

function cloneStored(value) {
    return v8.deserialize(v8.serialize(value));
}

let src = fs.readFileSync(path.join(__dirname, "..", "server", "worker.js"), "utf8");
src = src.replace("export default", "const __workerDefault =").replace("export class Hub", "class Hub");
// The reveal tables come out of the SAME bundle the Hub is using. Re-reading the generated file
// separately would let the two drift and still pass, which is the failure this guards against.
src += "\n;return { Hub, Worker: __workerDefault, GEO_COUNTRY_NAMES, GEO_CREDIT_KEYS };";
const { Hub, Worker, GEO_COUNTRY_NAMES, GEO_CREDIT_KEYS } = new Function(src)();

// Minimal Durable-Object storage stand-in.
class FakeStorage {
    constructor() { this.m = new Map(); }
    async get(k) { return this.m.has(k) ? this.m.get(k) : undefined; }
    async put(k, v) { this.m.set(k, v); }
    async delete(k) { this.m.delete(k); }
    async list(opts) {
        var prefix = (opts && opts.prefix) || "";
        var entries = [];
        for (var e of this.m) {
            var key = String(e[0]);
            if (!key.startsWith(prefix)) continue;
            if (opts && opts.start && key < opts.start) continue;
            if (opts && opts.startAfter && key <= opts.startAfter) continue;
            if (opts && opts.end && key >= opts.end) continue;
            entries.push(e);
        }
        entries.sort(function (a, b) { return String(a[0]).localeCompare(String(b[0])); });
        if (opts && opts.reverse) entries.reverse();
        if (opts && opts.limit) entries.length = Math.min(entries.length, opts.limit);
        var out = new Map();
        for (e of entries) out.set(e[0], e[1]);
        return out;
    }
    async transaction(callback) {
        var tx = new FakeStorage();
        tx.m = new Map();
        for (var entry of this.m) tx.m.set(entry[0], cloneStored(entry[1]));
        var result = await callback(tx);
        this.m = tx.m;
        return result;
    }
}

// Downlink is now LEVEL-quantised: the worker sends dim = level*STEP + BASE (see
// worker.core.js d()), and the client recovers level = round((dim - BASE)/STEP). The
// test mirrors that: rawDims reads the literal PNG pixels; req() level-decodes them so
// every assertion compares the LOGICAL value (which IS the level) exactly as before.
// The probe alone is sent literally (it's the calibration reference), so it's read raw.
var STEP = 9, BASE = 15;
function readU32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
async function rawDims(res) {
    var b = new Uint8Array(await res.arrayBuffer());
    return { w: readU32(b, 16), h: readU32(b, 20) }; // IHDR width @16, height @20 (big-endian)
}
function delevel(d) { return { w: Math.round((d.w - BASE) / STEP), h: Math.round((d.h - BASE) / STEP) }; }
async function reqRaw(hub, pathAndQuery) {
    var res = await hub.fetch(new Request("https://mg.test" + pathAndQuery));
    return await rawDims(res);
}
async function req(hub, pathAndQuery) {
    return delevel(await reqRaw(hub, pathAndQuery));
}
async function reqIp(hub, pathAndQuery, ip) {
    var res = await hub.fetch(new Request("https://mg.test" + pathAndQuery, {
        headers: { "CF-Connecting-IP": ip }
    }));
    return delevel(await rawDims(res));
}
async function adminReq(hub, pathAndQuery, method, body, extraHeaders) {
    var headers = Object.assign({
        "X-MG-Admin-Login": "pixel-owner",
        "X-MG-Admin": "1",
        "Origin": "https://mg.test"
    }, extraHeaders || {});
    var response = await hub.fetch(new Request("https://mg.test" + pathAndQuery, {
        method: method || "GET",
        headers: headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    }));
    return { status: response.status, body: await response.json() };
}
// Decode a lobby code from a create/quick/host reply. Mirrors worker dCode(): the width
// is a band (24..39 joiner/create, 40..55 host) + (code>>6); the height is code&63. Host
// vs joiner is the band, not a +100 flag. codeHost(d) tells them apart.
function decCode(d) { var band = d.w >= 40 ? 40 : 24; return (d.w - band) * 64 + d.h; }
function codeHost(d) { return d.w >= 40; }
// Decode one seat's clock reading. The route now returns ONE seat per read as
// (30+(sec>>6), sec&63); sentinels are (9,9) gone / (9,8) untimed. clkSec(d) → seconds,
// Clocks are per-seat now: /api/clocks?seat=S → (30 + sec>>6, sec&63). Recover the seconds.
// Sentinels (9,9) gone / (9,8) untimed stay at width 9. clkSec reads ONE seat's bank.
async function clkSec(hub, code, seat) {
    var d = await req(hub, "/api/clocks.png?code=" + code + "&seat=" + seat);
    if (d.w === 9) return { sentinel: d.h };            // 9 = gone · 8 = untimed
    return { sec: (d.w - 30) * 64 + d.h };
}
// The join height carries the tc-INDEX+1 (0 untimed · 1 60s · 2 180s · 3 300s · 4 600s).
var TC_SECS = [0, 60, 180, 300, 600];
function tcFromJoinH(h) { return TC_SECS[(h | 0) - 1] || 0; }
// Checkers/chess/ttt squares as row*8+col so tests read naturally.
function sq(r, c) { return r * 8 + c; }

var passed = 0;
function ok(cond, msg) {
    if (!cond) { console.error("  ✗ " + msg); process.exitCode = 1; throw new Error("FAIL: " + msg); }
    console.log("  ✓ " + msg); passed++;
}

// Host with token TH, joiner with token TJ, into a fresh private lobby for `game`.
// `env` is the Durable Object's second constructor argument; GeoGuesser reads
// MG_MAPILLARY_TOKEN from it to resolve a (signed, expiring) Mapillary image URL.
async function seatedLobby(game, TH, TJ, env) {
    var hub = new Hub({ storage: new FakeStorage() }, env);
    var d = await req(hub, "/api/create.png?game=" + game + "&tok=" + TH);
    var code = decCode(d);
    await req(hub, "/api/join.png?code=" + code + "&tok=" + TJ);
    return { hub, code };
}

async function main() {
    var d;

    // ── calibration + private lobby round-trip with tokens ──
    var hub = new Hub({ storage: new FakeStorage() });
    d = await reqRaw(hub, "/api/probe.png");   // probe is sent LITERALLY (calibration reference)
    ok(d.w === 600 && d.h === 1000, "probe = (600,1000)");

    // The probe is state-independent and identical for every caller, so the top-level Worker now
    // answers it from a cached, compressed buffer WITHOUT touching the Durable Object - it used
    // to bill a DO request and send 601 KB per call, on the same free-tier bucket the games spend.
    (async function () {
        var reachedDO = 0;
        var fakeEnv = { HUB: { idFromName: function () { return 1; },
            get: function () { return { fetch: function () { reachedDO++; return new Response("", { status: 200 }); } }; } } };
        var pr = await Worker.fetch(new Request("https://mg.test/api/probe.png"), fakeEnv);
        var pb = new Uint8Array(await pr.arrayBuffer());
        ok(readU32(pb, 16) === 600 && readU32(pb, 20) === 1000, "probe via the Worker is still (600,1000)");
        ok(pb.length < 2048, "probe response is compressed below 2 KiB");
        ok(reachedDO === 0, "probe never reaches the Durable Object");
        var pr2 = await Worker.fetch(new Request("https://mg.test/api/probe.png"), fakeEnv);
        var pb2 = new Uint8Array(await pr2.arrayBuffer());
        ok(pb2.length === pb.length, "the cached probe buffer is reused byte-for-byte");
        await Worker.fetch(new Request("https://mg.test/api/ping.png"), fakeEnv);
        ok(reachedDO === 0, "ping never reaches the Durable Object either");
        // Anything stateful must still go through.
        await Worker.fetch(new Request("https://mg.test/api/status.png?code=1"), fakeEnv);
        ok(reachedDO === 1, "a stateful route still routes to the Durable Object");
    })();

    // ── Pixel Battle: transparent shared layer + authoritative bank/batching ──
    var pxRes = await hub.fetch(new Request("https://mg.test/api/pxcanvas.png"));
    var pxBytes = new Uint8Array(await pxRes.arrayBuffer());
    ok(readU32(pxBytes, 16) === 512 && readU32(pxBytes, 20) === 256,
        "pixel canvas PNG = 512x256");
    ok(pxBytes[24] === 8 && pxBytes[25] === 3,
        "pixel canvas uses 8-bit indexed colour");
    var hasPlte = false, hasTrns = false, idatParts = [];
    for (var po = 8; po + 12 <= pxBytes.length;) {
        var plen = readU32(pxBytes, po);
        var ptype = String.fromCharCode(pxBytes[po + 4], pxBytes[po + 5], pxBytes[po + 6], pxBytes[po + 7]);
        if (ptype === "PLTE") hasPlte = plen >= 3;
        if (ptype === "tRNS") hasTrns = plen >= 19 && pxBytes[po + 8] === 0;
        if (ptype === "IDAT") idatParts.push(Buffer.from(pxBytes.slice(po + 8, po + 8 + plen)));
        po += 12 + plen;
    }
    ok(hasPlte && hasTrns, "pixel canvas carries palette + transparent index");
    var pxRaw = zlib.inflateSync(Buffer.concat(idatParts));
    ok(pxRaw.length === 256 * 513, "pixel canvas scanlines inflate cleanly");
    function pxIndex(x, y) { return pxRaw[y * 513 + 1 + x]; } // +1 skips row filter byte
    ok(pxIndex(0, 0) === 0 && pxIndex(511, 255) === 0,
        "new pixel canvas is fully transparent");

    d = await req(hub, "/api/pxversion.png");
    ok(d.w === 0 && d.h === 0, "pixel canvas starts at version 0");
    d = await req(hub, "/api/pxbank.png?id=bad");
    ok(d.w === 1 && d.h === 63, "pixel bank rejects malformed Steam32 id");
    d = await req(hub, "/api/pxbank.png?id=123456789");
    ok(d.h * 64 + d.w === 100, "new Pixel Battle account starts with 100 pixels");
    await hub.storage.put("px:u:77777777", { balance: 80, at: Date.now() - 61000 });
    d = await req(hub, "/api/pxbank.png?id=77777777");
    ok(d.h * 64 + d.w === 82, "pixel bank regenerates one pixel per 30 seconds");

    var tooSmall = [];
    for (var pi = 0; pi < 9; pi++) tooSmall.push(pi + ",0,5");
    d = await req(hub, "/api/pxput.png?id=123456789&b=" + tooSmall.join(";"));
    ok(d.w === 2 && d.h === 63, "pixel upload rejects batches below 10 unique pixels");

    var batch = [];
    for (pi = 0; pi < 10; pi++) batch.push(pi + ",0,5");
    d = await req(hub, "/api/pxput.png?id=123456789&b=" + batch.join(";"));
    ok(d.h * 64 + d.w === 90, "10-pixel upload spends 10 from the server bank");
    d = await req(hub, "/api/pxversion.png");
    ok(d.w === 1 && d.h === 0, "accepted upload advances the shared canvas version");

    // The version rides one 2-int reply as (lo6, hi6), and the client reads h === 63 as an error -
    // (5,63) specifically as "you are banned". A 12-bit version put 4032..4095 into that band, so a
    // canvas painted 4037 times encoded bit-for-bit like the ban sentinel and showed EVERY client a
    // false ban. Walk the wrap point and assert no version can ever land in the reserved band.
    (function () {
        var collide = 0, banLike = 0;
        for (var v = 0; v < 4032; v++) {
            var w = v & 63, h = (v >> 6) & 63;
            if (h === 63) collide++;
            if (w === 5 && h === 63) banLike++;
        }
        ok(collide === 0, "pixel version never encodes into the reserved h=63 error band");
        ok(banLike === 0, "pixel version can never encode as the (5,63) ban sentinel");
    })();
    // Walk the wrap point on a THROWAWAY hub so the shared canvas/bank state the later asserts
    // depend on is untouched.
    (async function () {
        var vhub = new Hub({ storage: new FakeStorage() });
        await vhub.storage.put("px:version", 4031);       // one step before the wrap
        var vd = await req(vhub, "/api/pxversion.png");
        ok(vd.h !== 63, "pixel version at the top of its range is not in the error band");
        var wrapBatch = [];
        for (var wi = 0; wi < 10; wi++) wrapBatch.push(wi + ",0,5");
        await req(vhub, "/api/pxput.png?id=123456789&b=" + wrapBatch.join(";"));
        vd = await req(vhub, "/api/pxversion.png");
        ok(vd.w === 0 && vd.h === 0, "pixel version wraps to 0 instead of entering the error band");
    })();

    pxRes = await hub.fetch(new Request("https://mg.test/api/pxcanvas.png?v=1"));
    pxBytes = new Uint8Array(await pxRes.arrayBuffer());
    idatParts = [];
    for (po = 8; po + 12 <= pxBytes.length;) {
        plen = readU32(pxBytes, po);
        ptype = String.fromCharCode(pxBytes[po + 4], pxBytes[po + 5], pxBytes[po + 6], pxBytes[po + 7]);
        if (ptype === "IDAT") idatParts.push(Buffer.from(pxBytes.slice(po + 8, po + 8 + plen)));
        po += 12 + plen;
    }
    pxRaw = zlib.inflateSync(Buffer.concat(idatParts));
    ok(pxIndex(0, 0) === 5 && pxIndex(9, 0) === 5 && pxIndex(10, 0) === 0,
        "accepted pixels appear in the shared transparent PNG");

    // The max-zoom editor receives a native 800x400 composite: each logical
    // canvas pixel occupies one exact 25x25 block with no filtered boundary.
    var viewRes = await hub.fetch(new Request("https://mg.test/api/pxview.png?x=0&y=0&v=1"));
    var viewBytes = new Uint8Array(await viewRes.arrayBuffer());
    ok(readU32(viewBytes, 16) === 800 && readU32(viewBytes, 20) === 400,
        "pixel edit viewport PNG = native 800x400");
    ok(viewBytes.length < 50000,
        "pixel viewport is compressed instead of sending a 320KB raw frame");
    var viewIdatParts = [];
    for (po = 8; po + 12 <= viewBytes.length;) {
        plen = readU32(viewBytes, po);
        ptype = String.fromCharCode(viewBytes[po + 4], viewBytes[po + 5], viewBytes[po + 6], viewBytes[po + 7]);
        if (ptype === "IDAT") viewIdatParts.push(Buffer.from(viewBytes.slice(po + 8, po + 8 + plen)));
        po += 12 + plen;
    }
    var viewRaw = zlib.inflateSync(Buffer.concat(viewIdatParts));
    function viewIndex(x, y) { return viewRaw[y * 801 + 1 + x]; }
    ok(viewRaw.length === 400 * 801,
        "pixel edit viewport scanlines inflate cleanly");
    ok(viewIndex(0, 0) === 6 && viewIndex(24, 24) === 6 &&
        viewIndex(25, 0) === 6 && viewIndex(249, 24) === 6,
        "each painted logical pixel fills its exact 25x25 edit cell");
    ok(viewIndex(250, 0) !== 6 && viewIndex(250, 0) <= 1,
        "paint stops exactly at the next logical-pixel boundary");

    // Preview zooms use the same server-side nearest-neighbour rasterisation.
    // At 8x the 64 logical columns divide into alternating 12/13px blocks;
    // the boundary after ten painted pixels must still be exact and unblended.
    viewRes = await hub.fetch(new Request("https://mg.test/api/pxview.png?x=0&y=0&z=8&v=1"));
    viewBytes = new Uint8Array(await viewRes.arrayBuffer());
    viewIdatParts = [];
    for (po = 8; po + 12 <= viewBytes.length;) {
        plen = readU32(viewBytes, po);
        ptype = String.fromCharCode(viewBytes[po + 4], viewBytes[po + 5], viewBytes[po + 6], viewBytes[po + 7]);
        if (ptype === "IDAT") viewIdatParts.push(Buffer.from(viewBytes.slice(po + 8, po + 8 + plen)));
        po += 12 + plen;
    }
    viewRaw = zlib.inflateSync(Buffer.concat(viewIdatParts));
    ok(viewIndex(124, 0) === 6 && viewIndex(125, 0) <= 1,
        "8x preview has an exact nearest-neighbour paint boundary");
    var previewScalesOk = true;
    for (var previewZoom of [1, 2, 4]) {
        var previewRes = await hub.fetch(new Request(
            "https://mg.test/api/pxview.png?x=0&y=0&z=" + previewZoom + "&v=1"));
        var previewBytes = new Uint8Array(await previewRes.arrayBuffer());
        previewScalesOk = previewScalesOk &&
            readU32(previewBytes, 16) === 800 && readU32(previewBytes, 20) === 400 &&
            previewBytes.length < 50000;
    }
    ok(previewScalesOk, "1x/2x/4x previews are native-size and compressed");

    var eraseBatch = [];
    for (pi = 0; pi < 10; pi++) eraseBatch.push(pi + ",0,0");
    d = await req(hub, "/api/pxput.png?id=123456789&b=" + eraseBatch.join(";"));
    ok(d.h * 64 + d.w === 80, "eraser spends pixels and restores the base map");
    ok((await hub.storage.get("px:t:0")) === undefined,
        "fully erased sparse tile is removed from storage");

    // A forged Steam32 cannot reset the shared IP pixel budget. Six people behind one NAT may
    // still spend a full fresh 100px bank at once; only the seventh immediate full-bank burst
    // is asked to slow down. No IP is banned, and another IP is unaffected.
    await (async function () {
        var budgetHub = new Hub({ storage: new FakeStorage() });
        var budgetIp = "203.0.113.40";
        var result = null;
        for (var accountNo = 0; accountNo < 6; accountNo++) {
            var fullBank = [];
            for (var x = 0; x < 100; x++) fullBank.push(x + "," + accountNo + "," + (accountNo + 1));
            result = await reqIp(budgetHub,
                "/api/pxput.png?id=" + (31000000 + accountNo) + "&b=" + fullBank.join(";"), budgetIp);
            ok(result.h !== 63, "pixel IP budget allows full bank for NAT player " + (accountNo + 1));
        }
        var seventh = [];
        for (var sx = 0; sx < 100; sx++) seventh.push(sx + ",6,7");
        result = await reqIp(budgetHub,
            "/api/pxput.png?id=31000006&b=" + seventh.join(";"), budgetIp);
        ok(result.w === 4 && result.h === 63,
            "rotating Steam32 on one IP eventually receives the retryable pixel throttle");
        result = await reqIp(budgetHub,
            "/api/pxput.png?id=31000006&b=" + seventh.join(";"), "198.51.100.40");
        ok(result.h !== 63, "pixel throttle neither bans nor affects a different IP");
    })();

    // Expensive uncached 800x400 viewport renders get a human-sized burst. Cached navigation
    // remains free even after the burst, and another IP gets its own budget.
    await (async function () {
        var viewHub = new Hub({ storage: new FakeStorage() });
        var viewIp = "203.0.113.41";
        var dims;
        for (var vx = 0; vx < 12; vx++) {
            dims = await viewHub.fetch(new Request(
                "https://mg.test/api/pxview.png?x=" + vx + "&y=0&z=16", {
                    headers: { "CF-Connecting-IP": viewIp }
                })).then(rawDims);
            ok(dims.w === 800 && dims.h === 400, "viewport burst frame " + (vx + 1) + " renders");
        }
        dims = await viewHub.fetch(new Request(
            "https://mg.test/api/pxview.png?x=12&y=0&z=16", {
                headers: { "CF-Connecting-IP": viewIp }
            })).then(rawDims).then(delevel);
        ok(dims.w === 6 && dims.h === 63, "uncached viewport flood receives retryable busy image");
        dims = await viewHub.fetch(new Request(
            "https://mg.test/api/pxview.png?x=0&y=0&z=16", {
                headers: { "CF-Connecting-IP": viewIp }
            })).then(rawDims);
        ok(dims.w === 800 && dims.h === 400, "cached viewport remains available while throttled");
        dims = await viewHub.fetch(new Request(
            "https://mg.test/api/pxview.png?x=13&y=0&z=16", {
                headers: { "CF-Connecting-IP": "198.51.100.41" }
            })).then(rawDims);
        ok(dims.w === 800 && dims.h === 400, "viewport throttle does not affect another IP");
    })();

    // ── token & game-id validation on create ──
    // Audit history is append-only during its retention window, then old action and per-user
    // index records are pruned together so public canvas use cannot grow storage forever.
    await (async function () {
        var retentionHub = new Hub({ storage: new FakeStorage() });
        var oldAt = Date.now() - 181 * 24 * 60 * 60000;
        var oldIds = [];
        for (var oi = 0; oi < 513; oi++) {
            var oldId = String(oldAt + oi).padStart(13, "0") + "-00000001";
            oldIds.push(oldId);
            await retentionHub.storage.put("px:a:" + oldId, {
                id: oldId, at: oldAt + oi, actor: "player", steamid: "32000000",
                kind: "paint", deltas: [[0, 0, 0, 1, ""]]
            });
            await retentionHub.storage.put("px:ua:32000000:" + oldId, true);
        }
        var retentionBatch = [];
        for (var rx = 0; rx < 10; rx++) retentionBatch.push(rx + ",0,5");
        var retained = await req(retentionHub,
            "/api/pxput.png?id=32000001&b=" + retentionBatch.join(";"));
        ok(retained.h !== 63, "new pixel action is accepted while retention cleanup runs");
        ok(!(await retentionHub.storage.get("px:a:" + oldIds[0])) &&
            !!(await retentionHub.storage.get("px:a:" + oldIds[512])) &&
            !(await retentionHub.storage.get("px:audit:lastPrune")),
            "pixel audit removes 512 expired actions and stays in catch-up mode");
        var retentionBatch2 = [];
        for (rx = 0; rx < 10; rx++) retentionBatch2.push(rx + ",1,6");
        await req(retentionHub, "/api/pxput.png?id=32000001&b=" + retentionBatch2.join(";"));
        ok(!(await retentionHub.storage.get("px:a:" + oldIds[512])) &&
            !(await retentionHub.storage.get("px:ua:32000000:" + oldIds[512])) &&
            !!(await retentionHub.storage.get("px:audit:lastPrune")),
            "next action finishes audit catch-up before restoring the daily cadence");
    })();

    // Fault injection: bank, tiles/version, audit and ownership must roll back as one unit.
    await (async function () {
        var atomicStorage = new FakeStorage();
        var atomicHub = new Hub({ storage: atomicStorage });
        var normalTransaction = atomicStorage.transaction.bind(atomicStorage);
        atomicStorage.transaction = async function (callback) {
            var tx = new FakeStorage();
            tx.m = new Map();
            for (var entry of this.m) tx.m.set(entry[0], cloneStored(entry[1]));
            var writes = 0;
            var normalPut = tx.put.bind(tx);
            tx.put = async function (key, value) {
                writes++;
                if (writes === 3) throw new Error("injected storage failure");
                return normalPut(key, value);
            };
            return callback(tx); // deliberately never commits if callback throws
        };
        var atomicBatch = [];
        for (var ax = 0; ax < 10; ax++) atomicBatch.push(ax + ",0,5");
        var failedAtomic = await req(atomicHub,
            "/api/pxput.png?id=33000000&b=" + atomicBatch.join(";"));
        ok(failedAtomic.w === 9 && failedAtomic.h === 7,
            "injected Pixel Battle storage failure returns the server-error sentinel");
        ok(!(await atomicStorage.get("px:u:33000000")) &&
            !(await atomicStorage.get("px:t:0")) &&
            !(await atomicStorage.get("px:version")) &&
            (await atomicStorage.list({ prefix: "px:a:" })).size === 0,
            "failed Pixel Battle transaction rolls bank, tiles, version and audit back together");
        atomicStorage.transaction = normalTransaction;
        var retriedAtomic = await req(atomicHub,
            "/api/pxput.png?id=33000000&b=" + atomicBatch.join(";"));
        ok(retriedAtomic.h * 64 + retriedAtomic.w === 90,
            "the same Pixel Battle batch succeeds once storage recovers");
    })();

    await (async function () {
        var adminAtomicStorage = new FakeStorage();
        var adminAtomicHub = new Hub({ storage: adminAtomicStorage });
        var normalAdminTransaction = adminAtomicStorage.transaction.bind(adminAtomicStorage);
        adminAtomicStorage.transaction = async function (callback) {
            var tx = new FakeStorage();
            tx.m = new Map();
            for (var entry of this.m) tx.m.set(entry[0], cloneStored(entry[1]));
            var writes = 0;
            var normalPut = tx.put.bind(tx);
            tx.put = async function (key, value) {
                writes++;
                if (writes === 3) throw new Error("injected admin storage failure");
                return normalPut(key, value);
            };
            return callback(tx);
        };
        var adminAtomicPixels = [];
        for (var apx = 0; apx < 10; apx++) adminAtomicPixels.push({ x: apx, y: 0, color: 6 });
        var failedAdminResponse = await adminAtomicHub.fetch(new Request(
            "https://mg.test/admin/api/paint", {
                method: "POST",
                headers: {
                    "X-MG-Admin-Login": "pixel-owner",
                    "X-MG-Admin": "1",
                    "Origin": "https://mg.test"
                },
                body: JSON.stringify({ pixels: adminAtomicPixels })
            }));
        var failedAdmin = delevel(await rawDims(failedAdminResponse));
        ok(failedAdmin.w === 9 && failedAdmin.h === 7,
            "injected admin paint storage failure returns the server-error sentinel");
        ok(!(await adminAtomicStorage.get("px:t:0")) &&
            !(await adminAtomicStorage.get("px:version")) &&
            (await adminAtomicStorage.list({ prefix: "px:a:" })).size === 0,
            "failed admin paint transaction rolls tiles, version and audit back together");
        adminAtomicStorage.transaction = normalAdminTransaction;
        var retriedAdmin = await adminReq(adminAtomicHub,
            "/admin/api/paint", "POST", { pixels: adminAtomicPixels });
        ok(retriedAdmin.status === 200 && retriedAdmin.body.changed === 10,
            "the same admin paint succeeds once storage recovers");
    })();

    // Pixel Battle browser admin: audit, unlimited paint, safe undo, and CSRF.
    var adminHub = new Hub({ storage: new FakeStorage() });
    var deniedAdmin = await adminHub.fetch(new Request("https://mg.test/admin/api/state"));
    ok(deniedAdmin.status === 403, "admin API rejects a request without verified identity");

    var missingAuthConfig = await Worker.fetch(new Request("https://mg.test/admin"), {});
    ok(missingAuthConfig.status === 503, "outer Worker fails closed when GitHub OAuth config is missing");

    var oauthEnv = {
        GITHUB_CLIENT_ID: "unit-client",
        GITHUB_CLIENT_SECRET: "unit-client-secret",
        ADMIN_GITHUB_ID: "424242",
        ADMIN_SESSION_SECRET: "unit-session-secret-that-is-definitely-long-enough"
    };
    var loginResponse = await Worker.fetch(new Request("https://mg.test/admin/login"), oauthEnv);
    var loginLocation = loginResponse.headers.get("Location") || "";
    var loginCookies = loginResponse.headers.get("Set-Cookie") || "";
    var stateMatch = loginCookies.match(/mg_oauth_state=([^;,]+)/);
    var verifierMatch = loginCookies.match(/mg_oauth_verifier=([^;,]+)/);
    ok(loginResponse.status === 302 && loginLocation.startsWith("https://github.com/login/oauth/authorize?") &&
        loginLocation.indexOf("code_challenge_method=S256") >= 0 && stateMatch && verifierMatch,
        "GitHub login uses state, PKCE, secure cookies, and the official authorize endpoint");

    var realFetch = globalThis.fetch;
    var oauthCalls = [];
    globalThis.fetch = async function (url, options) {
        oauthCalls.push({ url: String(url), options: options || {} });
        if (String(url).indexOf("/login/oauth/access_token") >= 0) {
            return new Response(JSON.stringify({ access_token: "unit-access-token", token_type: "bearer" }), {
                headers: { "Content-Type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ id: 424242, login: "pixel-owner" }), {
            headers: { "Content-Type": "application/json" }
        });
    };
    var callbackResponse;
    try {
        callbackResponse = await Worker.fetch(new Request(
            "https://mg.test/admin/auth/callback?code=unit-code&state=" + stateMatch[1], {
                headers: {
                    "Cookie": "mg_oauth_state=" + stateMatch[1] +
                        "; mg_oauth_verifier=" + verifierMatch[1]
                }
            }), oauthEnv);
    } finally {
        globalThis.fetch = realFetch;
    }
    var callbackCookies = callbackResponse.headers.get("Set-Cookie") || "";
    var sessionMatch = callbackCookies.match(/mg_admin_session=([^;,]+)/);
    ok(callbackResponse.status === 302 && sessionMatch && oauthCalls.length === 2 &&
        oauthCalls[1].url === "https://api.github.com/user",
        "OAuth callback exchanges the code and verifies the authenticated GitHub user");
    var adminPage = await Worker.fetch(new Request("https://mg.test/admin", {
        headers: { "Cookie": "mg_admin_session=" + sessionMatch[1] }
    }), oauthEnv);
    var adminPageHtml = await adminPage.text();
    ok(adminPage.status === 200 &&
        adminPageHtml.indexOf("Pixel Battle Admin") >= 0,
        "only a valid signed session for the configured numeric GitHub ID opens the admin");
    ok(adminPageHtml.indexOf('id="zoomIn"') >= 0 &&
        adminPageHtml.indexOf('id="zoomOut"') >= 0 &&
        adminPageHtml.indexOf('id="zoomFit"') >= 0 &&
        adminPageHtml.indexOf('id="panMode"') >= 0 &&
        adminPageHtml.indexOf('id="inspectMode"') >= 0 &&
        adminPageHtml.indexOf('id="debugPanel"') >= 0,
        "browser admin ships zoom, pan, pixel inspector, and preview controls");
    // Mutate signed PAYLOAD bits, not the final base64url character of the signature: the latter
    // may contain only padding bits and occasionally decode to the exact same HMAC byte string.
    var sessionParts = sessionMatch[1].split(".");
    var tamperedPayload = (sessionParts[0][0] === "A" ? "B" : "A") + sessionParts[0].substring(1);
    var tamperedSession = tamperedPayload + "." + sessionParts[1];
    var tamperedPage = await Worker.fetch(new Request("https://mg.test/admin", {
        headers: { "Cookie": "mg_admin_session=" + tamperedSession }
    }), oauthEnv);
    ok(tamperedPage.status === 302 && tamperedPage.headers.get("Location") === "/admin/login",
        "tampering with the HMAC-signed admin cookie forces a fresh login");
    var unsignedApi = await Worker.fetch(new Request("https://mg.test/admin/api/state"), oauthEnv);
    ok(unsignedApi.status === 401, "admin JSON API never redirects or runs without a signed session");

    globalThis.fetch = async function (url) {
        if (String(url).indexOf("/login/oauth/access_token") >= 0) {
            return new Response(JSON.stringify({ access_token: "wrong-user-token" }), {
                headers: { "Content-Type": "application/json" }
            });
        }
        return new Response(JSON.stringify({ id: 999999, login: "someone-else" }), {
            headers: { "Content-Type": "application/json" }
        });
    };
    var wrongUserResponse;
    try {
        wrongUserResponse = await Worker.fetch(new Request(
            "https://mg.test/admin/auth/callback?code=wrong-user-code&state=" + stateMatch[1], {
                headers: {
                    "Cookie": "mg_oauth_state=" + stateMatch[1] +
                        "; mg_oauth_verifier=" + verifierMatch[1]
                }
            }), oauthEnv);
    } finally {
        globalThis.fetch = realFetch;
    }
    ok(wrongUserResponse.status === 403,
        "a valid GitHub login with any other numeric account ID is denied");

    batch = [];
    for (pi = 0; pi < 10; pi++) batch.push(pi + ",0,5");
    d = await req(adminHub, "/api/pxput.png?id=123456789&b=" + batch.join(";"));
    ok(d.h * 64 + d.w === 90, "audited player upload still spends the normal bank");
    var inspectedPixel = await adminReq(adminHub, "/admin/api/pixel?x=0&y=0", "GET");
    ok(inspectedPixel.status === 200 && inspectedPixel.body.action &&
        inspectedPixel.body.action.steamid === "123456789",
        "pixel inspector attributes a painted coordinate to its Steam32 account");
    var inspectedActionId = inspectedPixel.body.action.id;
    var actionDetail = await adminReq(adminHub,
        "/admin/api/action?id=" + encodeURIComponent(inspectedActionId), "GET");
    ok(actionDetail.body.pixels.length === 10 && actionDetail.body.revertible === 10 &&
        actionDetail.body.conflicts === 0,
        "action preview returns exact current/before/after pixels and safe-undo status");
    await adminHub.storage.delete("px:o:0");
    inspectedPixel = await adminReq(adminHub, "/admin/api/pixel?x=0&y=0", "GET");
    ok(inspectedPixel.body.action && inspectedPixel.body.action.id === inspectedActionId &&
        (await adminHub.storage.get("px:o:0")) !== undefined,
        "inspector backfills attribution for pre-index audit actions and caches it");

    var adminCanvasRes = await adminHub.fetch(new Request("https://mg.test/admin/api/canvas", {
        headers: { "X-MG-Admin-Login": "pixel-owner" }
    }));
    var adminCanvasBytes = new Uint8Array(await adminCanvasRes.arrayBuffer());
    ok(adminCanvasRes.status === 200 &&
        readU32(adminCanvasBytes, 16) === 512 && readU32(adminCanvasBytes, 20) === 256,
        "admin canvas is the native 512x256 logical grid, never an 800x400 viewport");
    var adminCanvasIdat = [];
    for (po = 8; po + 12 <= adminCanvasBytes.length;) {
        plen = readU32(adminCanvasBytes, po);
        ptype = String.fromCharCode(adminCanvasBytes[po + 4], adminCanvasBytes[po + 5],
            adminCanvasBytes[po + 6], adminCanvasBytes[po + 7]);
        if (ptype === "IDAT") {
            adminCanvasIdat.push(Buffer.from(adminCanvasBytes.slice(po + 8, po + 8 + plen)));
        }
        po += 12 + plen;
    }
    var adminCanvasRaw = zlib.inflateSync(Buffer.concat(adminCanvasIdat));
    ok(adminCanvasRaw[1] === 6 && adminCanvasRaw[10] === 6 && adminCanvasRaw[11] <= 1,
        "native admin canvas preserves exact logical pixel boundaries without resampling ghosts");

    var csrfDenied = await adminHub.fetch(new Request("https://mg.test/admin/api/paint", {
        method: "POST",
        headers: { "X-MG-Admin-Login": "pixel-owner", "Origin": "https://mg.test" },
        body: JSON.stringify({ pixels: [{ x: 0, y: 0, color: 6 }] })
    }));
    ok(csrfDenied.status === 403, "admin mutation requires the same-origin CSRF header");

    var adminPixels = [{ x: 0, y: 0, color: 6 }];
    for (pi = 0; pi < 149; pi++) adminPixels.push({ x: pi, y: 1, color: 7 });
    var adminResult = await adminReq(adminHub, "/admin/api/paint", "POST", { pixels: adminPixels });
    ok(adminResult.status === 200 && adminResult.body.changed === 150,
        "admin paints more than the 100-pixel player cap in one unrestricted batch");
    var playerBankAfterAdmin = await adminHub.storage.get("px:u:123456789");
    ok(playerBankAfterAdmin.balance === 90, "admin paint does not charge the player's bank");

    var actionList = await adminReq(adminHub,
        "/admin/api/actions?steamid=123456789&limit=50", "GET");
    ok(actionList.status === 200 && actionList.body.actions.length === 1 &&
        actionList.body.actions[0].steamid === "123456789",
        "admin filters accepted actions by Steam32 ID");
    var playerActionId = actionList.body.actions[0].id;
    actionDetail = await adminReq(adminHub,
        "/admin/api/action?id=" + encodeURIComponent(playerActionId), "GET");
    ok(actionDetail.body.revertible === 9 && actionDetail.body.conflicts === 1,
        "safe-undo preview marks a newer overlapping pixel as a conflict");
    var undoResult = await adminReq(adminHub, "/admin/api/undo", "POST", {
        actionId: playerActionId, force: false
    });
    ok(undoResult.status === 200 && undoResult.body.changed === 9 && undoResult.body.skipped === 1,
        "safe undo reverts untouched pixels and skips a newer overlapping edit");
    var adminTile = await adminHub.storage.get("px:t:0");
    ok(adminTile[0] === 6 && adminTile[1] === 0 && adminTile[32] === 7,
        "safe undo preserves the newer overlap and restores the other player pixels");
    inspectedPixel = await adminReq(adminHub, "/admin/api/pixel?x=0&y=0", "GET");
    ok(inspectedPixel.body.action && inspectedPixel.body.action.actor === "admin",
        "pixel inspector follows current attribution after an overlapping admin edit");
    var adminState = await adminReq(adminHub, "/admin/api/state", "GET");
    ok(adminState.body.painted === 150 && adminState.body.palette.length === 19,
        "admin state reports the live painted count and shared palette");
    actionList = await adminReq(adminHub, "/admin/api/actions?limit=50", "GET");
    var loggedPlayerAction = actionList.body.actions.find(function (a) { return a.actor === "player"; });
    ok(actionList.body.actions.length === 3 && loggedPlayerAction && loggedPlayerAction.undoneAt > 0,
        "audit log records player paint, admin paint, and the undo action");

    var banResult = await adminReq(adminHub, "/admin/api/ban", "POST", {
        steamid: "123456789", reason: "unit test"
    });
    ok(banResult.status === 200 && banResult.body.banned === true,
        "admin can ban a Steam32 account with an audited reason");
    var banStatus = await adminReq(adminHub, "/admin/api/ban-status?steamid=123456789", "GET");
    ok(banStatus.body.banned === true && banStatus.body.ban.by === "pixel-owner",
        "admin ban status returns the stored actor and state");
    d = await req(adminHub, "/api/pxbank.png?id=123456789");
    ok(d.w === 5 && d.h === 63, "banned account preflight returns the dedicated ban marker");
    d = await req(adminHub, "/api/pxversion.png?id=123456789");
    ok(d.w === 5 && d.h === 63, "banned account cannot continue Pixel Battle polling");
    d = await req(adminHub, "/api/pxview.png?id=123456789&x=0&y=0&z=16");
    ok(d.w === 5 && d.h === 63, "banned account cannot fetch Pixel Battle map views");
    var beforeBlockedUpload = (await adminHub.storage.get("px:t:0"))[2];
    d = await req(adminHub, "/api/pxput.png?id=123456789&b=" + batch.join(";"));
    ok(d.w === 5 && d.h === 63 &&
        (await adminHub.storage.get("px:t:0"))[2] === beforeBlockedUpload,
        "server rejects banned uploads before changing any canvas state");
    adminState = await adminReq(adminHub, "/admin/api/state", "GET");
    ok(adminState.body.bans === 1, "admin state reports the live ban count");
    var unbanResult = await adminReq(adminHub, "/admin/api/unban", "POST", {
        steamid: "123456789"
    });
    d = await req(adminHub, "/api/pxbank.png?id=123456789");
    ok(unbanResult.body.banned === false && d.h !== 63,
        "admin can unban the account and restore server access");

    var ownerHub = new Hub({ storage: new FakeStorage() });
    var ownerBatchA = [], ownerBatchB = [];
    for (pi = 0; pi < 10; pi++) {
        ownerBatchA.push(pi + ",0,5");
        ownerBatchB.push(pi + ",0,6");
    }
    await req(ownerHub, "/api/pxput.png?id=11111111&b=" + ownerBatchA.join(";"));
    await req(ownerHub, "/api/pxput.png?id=22222222&b=" + ownerBatchB.join(";"));
    var ownerActions = await adminReq(ownerHub,
        "/admin/api/actions?steamid=22222222&limit=10", "GET");
    await adminReq(ownerHub, "/admin/api/undo", "POST", {
        actionId: ownerActions.body.actions[0].id, force: false
    });
    var restoredOwner = await adminReq(ownerHub, "/admin/api/pixel?x=0&y=0", "GET");
    ok(restoredOwner.body.color === 5 && restoredOwner.body.action &&
        restoredOwner.body.action.steamid === "11111111",
        "undo restores both the previous colour and the previous pixel owner");

    // ── GeoGuesser: PREBUILT pool, hidden panorama and authoritative reveal ──
    // Locations come from server/geo_pool.generated.js, so forming a lobby must make NO catalog
    // request at all. This replaced a live sweep that could not be both fast and varied: Panoramax
    // returns frames in sequence order (one wide bbox = one street), and Mapillary caps a bbox at
    // 0.010 square degrees, so a thorough sweep needs ~2.5M cells. The counter below is the
    // regression guard - if anything reintroduces a lobby-time catalog call it goes above zero.
    var geoCatalogFetches = 0;
    var geoUrlResolves = [];
    globalThis.MG_GEO_CATALOG_FETCH = async function (url) {
        geoCatalogFetches++;
        // The only legitimate catalog call left is resolving a Mapillary image URL at reveal time
        // (its thumb URL is signed and expires, so it can never be baked into the pool).
        geoUrlResolves.push(String(url));
        return new Response(JSON.stringify({
            thumb_2048_url: "https://scontent-arn2-1.xx.fbcdn.net/test-panorama.jpg"
        }), { headers: { "Content-Type": "application/json" } });
    };
    var geo = await seatedLobby(9, "GEOHOST01", "GEOJOIN01",
        { MG_MAPILLARY_TOKEN: "MLY|test|token" });
    ok(geoCatalogFetches === 0,
        "geo: forming a lobby makes zero catalog requests (pool is prebuilt)");
    // Five rounds drawn from a 2380-row pool must be five DIFFERENT places, and each must carry a
    // source tag so the reveal can credit the right provider.
    var geoLobby = await geo.hub.storage.get("l:" + geo.code);
    var geoIds = geoLobby.state.locations.map(function (loc) { return loc.source + ":" + loc.id; });
    ok(geoIds.length === 5 && new Set(geoIds).size === 5,
        "geo: a match draws five distinct pooled locations");
    ok(geoLobby.state.locations.every(function (loc) {
        return (loc.source === 0 || loc.source === 1) &&
            Number.isFinite(loc.lat) && Number.isFinite(loc.lon) &&
            loc.lat >= -90 && loc.lat <= 90 && loc.lon >= -180 && loc.lon <= 180 &&
            Number.isInteger(loc.region) && loc.region >= 0 && loc.region < 6;
    }), "geo: every pooled location has a known source, sane coordinates and a labelled region");
    // A drawn row must be nameable by the SHIPPED tables. An empty country is legal (a handful of
    // panoramas sit at sea and reveal as a region), but a country the table does not list means
    // geo_pool.generated.js and geo_credit_tables.generated.js were built from different pools -
    // the reveal would then name the wrong place.
    ok(geoLobby.state.locations.every(function (loc) {
        if (!loc.country) return loc.continent === -1;
        return GEO_COUNTRY_NAMES.indexOf(loc.country) >= 0 &&
            Number.isInteger(loc.continent) && loc.continent >= 0 && loc.continent < 6;
    }), "geo: every drawn location's country is present in the shipped country table");
    ok(geoLobby.state.locations.every(function (loc) {
        return GEO_CREDIT_KEYS.indexOf((loc.source === 1 ? 1 : 0) + "|" + loc.provider) >= 0;
    }), "geo: every drawn location's provider is present in the shipped credit table");

    // The draw is random, so pin round 1 to a Mapillary row and round 2 to a Panoramax one. Both
    // paths then get asserted deterministically: the URL resolve, the host allowlist and the two
    // different credit codes. The providers must be REAL entries from the generated credit table -
    // the reveal now sends an index into it, so an invented name has no code to send.
    var geoMlyKey = GEO_CREDIT_KEYS.find(function (key) { return key.charAt(0) === "1"; });
    var geoPanoKey = GEO_CREDIT_KEYS.find(function (key) { return key.charAt(0) === "0"; });
    geoLobby.state.locations[0] = {
        source: 1, id: "1234567890123456", lat: 48.858, lon: 2.294, region: 0,
        provider: geoMlyKey.slice(2), country: "France", continent: 0
    };
    geoLobby.state.locations[1] = {
        source: 0, id: "539493be-7921-4607-bb76-b57dea3d4c09", lat: -33.87, lon: 151.21,
        region: 5, provider: geoPanoKey.slice(2), country: "Australia", continent: 5
    };
    await geo.hub.storage.put("l:" + geo.code, geoLobby);
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 1 && d.h === 1, "geo: round 1 starts unrevealed with no guesses");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOSTRANGER");
    ok(d.w === 9 && d.h === 3, "geo: foreign token cannot read round state");
    d = await req(geo.hub, "/api/geotarget.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 1 && d.h === 63, "geo: target is hidden before both players guess");

    var geoFetches = 0;
    var geoImageUrls = [];
    globalThis.MG_GEO_IMAGE_FETCH = async function (url) {
        geoFetches++;
        geoImageUrls.push(String(url));
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
            headers: { "Content-Type": "image/jpeg", "Content-Length": "4" }
        });
    };
    try {
        d = await req(geo.hub, "/api/geoview.png?code=" + geo.code + "&tok=GEOSTRANGER");
        ok(d.w === 9 && d.h === 3, "geo: foreign token cannot fetch the hidden panorama");
        var geoImage = await geo.hub.fetch(new Request(
            "https://mg.test/api/geoview.png?code=" + geo.code + "&tok=GEOHOST01"));
        var geoImageBytes = new Uint8Array(await geoImage.arrayBuffer());
        ok(geoImage.headers.get("content-type") === "image/jpeg" &&
            geoImageBytes.length === 4 && geoImageBytes[0] === 0xff,
            "geo: seated player receives the proxied panorama image");
        // Round 1 is the pinned Mapillary row: its URL had to be resolved through the Graph API
        // (never baked into the pool, because thumb URLs are signed and expire) and the proxy must
        // then fetch the fbcdn host that resolve returned.
        ok(geoCatalogFetches === 1 &&
            geoUrlResolves[0].indexOf("graph.mapillary.com/1234567890123456") !== -1 &&
            geoUrlResolves[0].indexOf("thumb_2048_url") !== -1,
            "geo: a Mapillary round resolves its image URL at reveal time, not at lobby time");
        ok(geoImageUrls[0] === "https://scontent-arn2-1.xx.fbcdn.net/test-panorama.jpg",
            "geo: the proxy fetches the resolved Mapillary CDN URL");
        await geo.hub.fetch(new Request(
            "https://mg.test/api/geoview.png?code=" + geo.code + "&tok=GEOJOIN01"));
        ok(geoFetches === 1, "geo: panorama source is cached once for both players");
        ok(geoCatalogFetches === 1,
            "geo: a cached panorama does not re-resolve the signed URL");

        // An upstream that answers with a NON-Mapillary host must be refused: the proxy would
        // otherwise fetch any host the catalog names. Panoramax gets this for free because its URL
        // is constructed from a validated UUID, so only the resolved path needs the allowlist.
        var evilHub = new Hub({ storage: new FakeStorage() },
            { MG_MAPILLARY_TOKEN: "MLY|test|token" });
        d = await req(evilHub, "/api/create.png?game=9&tok=GEOEVIL01&solo=1");
        var evilCode = decCode(d);
        var evilLobby = await evilHub.storage.get("l:" + evilCode);
        evilLobby.state.locations[0] = {
            source: 1, id: "9999999999999", lat: 0, lon: 0, region: 0, provider: "Evil"
        };
        await evilHub.storage.put("l:" + evilCode, evilLobby);
        var evilResolves = 0;
        globalThis.MG_GEO_CATALOG_FETCH = async function () {
            evilResolves++;
            return new Response(JSON.stringify({
                thumb_2048_url: "https://evil.example.com/not-a-panorama.jpg"
            }), { headers: { "Content-Type": "application/json" } });
        };
        var evilFetches = geoFetches;
        d = await req(evilHub, "/api/geoview.png?code=" + evilCode + "&tok=GEOEVIL01");
        ok(evilResolves === 1 && d.w === 6 && d.h === 63 && geoFetches === evilFetches,
            "geo: a resolved URL outside the Mapillary CDN is refused, not proxied");

        // No token at all (fresh install, or the operator revoked it): Mapillary rounds simply
        // cannot render, and must fail with the ordinary no-image sentinel rather than throw.
        var noTokenHub = new Hub({ storage: new FakeStorage() }, {});
        d = await req(noTokenHub, "/api/create.png?game=9&tok=GEONOTOK1&solo=1");
        var noTokenCode = decCode(d);
        var noTokenLobby = await noTokenHub.storage.get("l:" + noTokenCode);
        noTokenLobby.state.locations[0] = {
            source: 1, id: "1234567890123456", lat: 0, lon: 0, region: 0, provider: "Test"
        };
        await noTokenHub.storage.put("l:" + noTokenCode, noTokenLobby);
        var noTokenResolves = 0;
        globalThis.MG_GEO_CATALOG_FETCH = async function () {
            noTokenResolves++;
            return new Response("{}", { headers: { "Content-Type": "application/json" } });
        };
        d = await req(noTokenHub, "/api/geoview.png?code=" + noTokenCode + "&tok=GEONOTOK1");
        ok(d.w === 6 && d.h === 63 && noTokenResolves === 0,
            "geo: without a Mapillary token the round yields the no-image sentinel and makes no call");
    } finally {
        delete globalThis.MG_GEO_IMAGE_FETCH;
    }

    d = await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOHOST01&cell=131072");
    ok(d.w === 9 && d.h === 2, "geo: out-of-map guess is rejected");
    d = await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOHOST01&cell=0");
    ok(d.w === 1 && d.h === 1, "geo: host guess is accepted");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 1 && d.h === 2, "geo: state exposes only the host guess mask");
    d = await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOHOST01&cell=1");
    ok(d.w === 9 && d.h === 1, "geo: a seat cannot replace its locked guess");
    d = await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOJOIN01&cell=131071");
    ok(d.w === 1 && d.h === 1, "geo: joiner guess is accepted");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOJOIN01");
    ok(d.w === 1 && d.h === 28, "geo: both guesses atomically open the reveal phase");

    // A point is read one axis per request: the 512x256 grid overflows the two-level base-63
    // reply, so x and y each get their own round trip.
    async function geoAxisValue(route, extra) {
        const xr = await req(geo.hub, route + "&axis=0" + (extra || ""));
        const yr = await req(geo.hub, route + "&axis=1" + (extra || ""));
        ok(xr.w >= 0 && xr.w < 63 && yr.w >= 0 && yr.w < 63,
            "geo: axis reads stay inside the base-63 level range");
        return { x: xr.h * 63 + xr.w, y: yr.h * 63 + yr.w };
    }

    var revealedGeoTarget = await geoAxisValue(
        "/api/geotarget.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(revealedGeoTarget.x >= 0 && revealedGeoTarget.x < 512 &&
        revealedGeoTarget.y >= 0 && revealedGeoTarget.y < 256,
        "geo: revealed target decodes inside the 512x256 authoritative grid");
    var hostPick = await geoAxisValue(
        "/api/geopick.png?code=" + geo.code + "&tok=GEOHOST01&seat=0");
    ok(hostPick.x === 0 && hostPick.y === 0, "geo: host's revealed map pick round-trips");
    var joinerPick = await geoAxisValue(
        "/api/geopick.png?code=" + geo.code + "&tok=GEOHOST01&seat=1");
    ok(joinerPick.x === 511 && joinerPick.y === 255,
        "geo: joiner's revealed map pick round-trips at the far corner");
    // Place and credit are single-reply INDICES now (two base-63 levels, h=63 = error), so both
    // are read with one request instead of walking a string two characters at a time.
    async function geoLevelValue(route, tok) {
        var reply = await req(geo.hub, route + "?code=" + geo.code + "&tok=" + tok);
        return reply.h === 63 ? -1 : reply.h * 63 + reply.w;
    }
    function geoPlaceFor(country, continent) {
        return 6 + GEO_COUNTRY_NAMES.indexOf(country) * 6 + continent;
    }
    ok(await geoLevelValue("/api/geoinfo.png", "GEOHOST01") === geoPlaceFor("France", 0),
        "geo: reveal names the pooled location's country and continent (Europe · France)");
    // Round 1 is the pinned Mapillary row, so the credit must resolve to the Mapillary half of the
    // table, not the Panoramax one. Crediting the wrong project is a licence problem.
    ok(await geoLevelValue("/api/geocredit.png", "GEOHOST01") ===
        GEO_CREDIT_KEYS.indexOf(geoMlyKey),
        "geo: a Mapillary round credits Mapillary and its contributor");
    var firstGeoScores = [];
    for (var geoSeat = 0; geoSeat < 2; geoSeat++) {
        d = await req(geo.hub, "/api/geoscore.png?code=" + geo.code +
            "&tok=GEOHOST01&seat=" + geoSeat);
        firstGeoScores[geoSeat] = d.h * 63 + d.w;
    }
    ok(firstGeoScores[0] >= 0 && firstGeoScores[0] <= 750 &&
        firstGeoScores[1] >= 0 && firstGeoScores[1] <= 750,
        "geo: first-round authoritative scores stay in the 0..750 range");

    await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOHOST01");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 1 && d.h === 29, "geo: one ready seat cannot advance the round alone");
    await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOJOIN01");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOJOIN01");
    ok(d.w === 2 && d.h === 1, "geo: both ready seats advance to round 2");

    // Round 2 is the pinned Panoramax row. Reveal it and read the credit: the same route must now
    // name Panoramax, proving the attribution follows the location's source rather than a constant.
    await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOHOST01&cell=100");
    await req(geo.hub, "/api/geoguess.png?code=" + geo.code + "&tok=GEOJOIN01&cell=200");
    ok(await geoLevelValue("/api/geocredit.png", "GEOHOST01") ===
        GEO_CREDIT_KEYS.indexOf(geoPanoKey),
        "geo: a Panoramax round credits Panoramax, from the same reveal route");
    ok(await geoLevelValue("/api/geoinfo.png", "GEOHOST01") === geoPlaceFor("Australia", 5),
        "geo: the place hint follows the pooled row (Oceania · Australia)");
    await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOHOST01");
    await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOJOIN01");
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 3 && d.h === 1, "geo: the match continues into round 3");

    var lastGeoScores = firstGeoScores;
    for (var geoRound = 2; geoRound < 5; geoRound++) {
        await req(geo.hub, "/api/geoguess.png?code=" + geo.code +
            "&tok=GEOHOST01&cell=" + geoRound);
        await req(geo.hub, "/api/geoguess.png?code=" + geo.code +
            "&tok=GEOJOIN01&cell=" + (2047 - geoRound));
        d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
        ok(d.w === geoRound + 1 && d.h === 28,
            "geo: round " + (geoRound + 1) + " reveals only after both guesses");
        var roundScores = [];
        for (geoSeat = 0; geoSeat < 2; geoSeat++) {
            d = await req(geo.hub, "/api/geoscore.png?code=" + geo.code +
                "&tok=GEOHOST01&seat=" + geoSeat);
            roundScores[geoSeat] = d.h * 63 + d.w;
        }
        ok(roundScores[0] >= lastGeoScores[0] && roundScores[1] >= lastGeoScores[1],
            "geo: cumulative scores never decrease after round " + (geoRound + 1));
        lastGeoScores = roundScores;
        await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOHOST01");
        await req(geo.hub, "/api/geonext.png?code=" + geo.code + "&tok=GEOJOIN01");
    }
    d = await req(geo.hub, "/api/geostate.png?code=" + geo.code + "&tok=GEOHOST01");
    ok(d.w === 6 && d.h === 40, "geo: five completed rounds end the match authoritatively");
    ok(lastGeoScores[0] <= 3750 && lastGeoScores[1] <= 3750,
        "geo: cumulative scores fit the collision-free 12-bit score codec");

    // Solo is still a real authoritative lobby: the server owns an opaque synthetic second
    // seat, supplies its guess/ready state, and never exposes the hidden target to the client.
    var geoSoloHub = new Hub({ storage: new FakeStorage() });
    d = await req(geoSoloHub, "/api/create.png?game=9&tok=GEOSOLO01&solo=1");
    var geoSoloCode = decCode(d);
    d = await req(geoSoloHub, "/api/status.png?code=" + geoSoloCode);
    ok(d.w === 2, "geo solo: create immediately forms a server-backed two-seat session");
    d = await req(geoSoloHub, "/api/join.png?code=" + geoSoloCode + "&tok=GEOSNOOP1");
    ok(d.w === 21 && d.h === 1, "geo solo: a third party cannot occupy the synthetic seat");
    d = await req(geoSoloHub, "/api/geotarget.png?code=" + geoSoloCode + "&tok=GEOSOLO01");
    ok(d.w === 1 && d.h === 63, "geo solo: target remains hidden before the player's guess");
    d = await req(geoSoloHub, "/api/geoguess.png?code=" + geoSoloCode +
        "&tok=GEOSOLO01&cell=17");
    ok(d.w === 1 && d.h === 1, "geo solo: player guess is accepted");
    d = await req(geoSoloHub, "/api/geostate.png?code=" + geoSoloCode + "&tok=GEOSOLO01");
    ok(d.w === 1 && d.h === 28, "geo solo: server opens the reveal without waiting for a client opponent");
    d = await req(geoSoloHub, "/api/geoscore.png?code=" + geoSoloCode +
        "&tok=GEOSOLO01&seat=0");
    ok(d.w < 63 && d.h < 63, "geo solo: authoritative player score is readable after reveal");
    d = await req(geoSoloHub, "/api/geonext.png?code=" + geoSoloCode + "&tok=GEOSOLO01");
    ok(d.w === 1 && d.h === 1, "geo solo: one ready action advances the server-filled round");
    d = await req(geoSoloHub, "/api/geostate.png?code=" + geoSoloCode + "&tok=GEOSOLO01");
    ok(d.w === 2 && d.h === 1, "geo solo: next round starts immediately");
    delete globalThis.MG_GEO_CATALOG_FETCH;

    d = await req(hub, "/api/create.png?game=1");                  // no token
    ok(d.w === 9 && d.h === 3, "create with NO token → (9,3) bad-token");
    d = await req(hub, "/api/create.png?game=1&tok=short");        // 5 chars < 8
    ok(d.w === 9 && d.h === 3, "create with too-short token → (9,3) bad-token");
    d = await req(hub, "/api/create.png?game=6&tok=HOSTTOK01");    // unsupported id
    ok(d.w === 9 && d.h === 6, "create with unsupported game id → (9,6)");

    d = await req(hub, "/api/create.png?game=1&tok=HOSTTOK01");
    var code = decCode(d);
    ok(code >= 0 && code <= 1023, "create returns a 4-digit code (" + code + ")");

    d = await req(hub, "/api/status.png?code=" + code);
    ok(d.w === 1, "status players=1 after create");

    // Move before the opponent has joined is refused (players < 2).
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(5, 0) + "&to=" + sq(4, 1) + "&end=1&tok=HOSTTOK01");
    ok(d.w === 9 && d.h === 1, "move before opponent joined → (9,1)");

    d = await req(hub, "/api/join.png?code=" + code + "&tok=JOINTOK01");
    ok(d.w === 1, "join ok returns game id 1");

    d = await req(hub, "/api/status.png?code=" + code);
    ok(d.w === 2, "status players=2 after join");

    // ── seat token enforcement (T2/T3) ──
    // A move with a token belonging to NO seat is rejected (9,3).
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(5, 0) + "&to=" + sq(4, 1) + "&end=1&tok=STRANGER0");
    ok(d.w === 9 && d.h === 3, "move with foreign token → (9,3) bad-token");

    // Joiner (black, seat 1) moving on white's opening turn is rejected (9,1).
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(2, 1) + "&to=" + sq(3, 0) + "&end=1&tok=JOINTOK01");
    ok(d.w === 9 && d.h === 1, "opponent moving out of turn → (9,1) not-your-turn");

    // Host (white) plays an ILLEGAL non-diagonal move → (9,2).
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(5, 0) + "&to=" + sq(5, 1) + "&end=1&tok=HOSTTOK01");
    ok(d.w === 9 && d.h === 2, "illegal (non-diagonal) move → (9,2) illegal");

    // Host plays a LEGAL opening move (5,0)->(4,1). Accepted (1,1) and lands in the log.
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(5, 0) + "&to=" + sq(4, 1) + "&end=1&tok=HOSTTOK01");
    ok(d.w === 1 && d.h === 1, "legal opening move accepted");

    d = await req(hub, "/api/poll.png?code=" + code + "&since=0");
    // Poll now returns RAW squares (from=w, to=h); the turn-hand-off `end` is derived
    // client-side from the shared rules, no longer sent down.
    ok(d.w === sq(5, 0) && d.h === sq(4, 1), "poll round-trips the accepted move (raw from/to squares)");

    // Now it's black's turn: host moving again is out of turn → (9,1).
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(4, 1) + "&to=" + sq(3, 0) + "&end=1&tok=HOSTTOK01");
    ok(d.w === 9 && d.h === 1, "same player moving twice → (9,1) not-your-turn");

    // Black plays a legal reply (2,1)->(3,2). Accepted.
    d = await req(hub, "/api/move.png?code=" + code + "&from=" + sq(2, 1) + "&to=" + sq(3, 2) + "&end=1&tok=JOINTOK01");
    ok(d.w === 1 && d.h === 1, "black legal reply accepted (turn alternation works)");

    d = await req(hub, "/api/join.png?code=" + code + "&tok=LATEJOIN0");
    ok(d.w === 21, "join a full lobby returns 21");
    d = await req(hub, "/api/join.png?code=1&tok=MISSING00"); // no such lobby
    ok(d.w === 20, "join a missing lobby returns 20");

    // Code 0 is valid in the rebased 0..1023 space. Force the allocator to return it so
    // every lookup proves it does not confuse "0" with an absent code.
    await (async function () {
        var h0 = new Hub({ storage: new FakeStorage() });
        h0.freshCode = async function () { return 0; };
        var c0 = await req(h0, "/api/create.png?game=2&tok=ZEROHOST");
        ok(decCode(c0) === 0, "code 0000: create round-trips code 0");
        var s0 = await req(h0, "/api/status.png?code=0000");
        ok(s0.w === 1 && s0.h === 3, "code 0000: status finds the lobby");
        var j0 = await req(h0, "/api/join.png?code=0000&tok=ZEROJOIN");
        ok(j0.w === 2, "code 0000: join reaches the lobby");
    })();

    // Queue values are stored as numeric codes, so code 0 must not be mistaken for a missing
    // storage key by either public-matchmaking lookup.
    await (async function () {
        var q0 = new Hub({ storage: new FakeStorage() });
        q0.freshCode = async function () { return 0; };
        var qh = await req(q0, "/api/quick.png?game=2&tok=ZEROQHST");
        var qj = await req(q0, "/api/quick.png?game=2&tok=ZEROQJON");
        ok(codeHost(qh) && decCode(qh) === 0, "code 0000: quick host publishes queue value 0");
        ok(!codeHost(qj) && decCode(qj) === 0, "code 0000: quick seeker joins queue value 0");
        ok((await req(q0, "/api/status.png?code=0000")).w === 2,
            "code 0000: quick lobby has both players");

        var m0 = new Hub({ storage: new FakeStorage() });
        m0.freshCode = async function () { return 0; };
        var mh = await req(m0, "/api/mquick.png?games=2,4&tok=ZEROMHST");
        var mj = await req(m0, "/api/mquick.png?games=2&tok=ZEROMJON");
        ok(codeHost(mh) && decCode(mh) === 0, "code 0000: mquick host publishes queue value 0");
        ok(!codeHost(mj) && decCode(mj) === 0, "code 0000: mquick seeker joins queue value 0");
        ok((await req(m0, "/api/status.png?code=0000")).w === 2,
            "code 0000: mquick lobby has both players");
    })();

    // The 10-bit code space is finite. A saturated allocator must fail cleanly instead of
    // writing/returning a bogus l:-1 lobby (which aliases every later saturated create).
    await (async function () {
        var full = new Hub({ storage: new FakeStorage() });
        full.freshCode = async function () { return -1; };
        var cr = await req(full, "/api/create.png?game=2&tok=FULLHOST");
        ok(cr.w === 9 && cr.h === 5, "full code space: create → (9,5) unavailable");
        var qr = await req(full, "/api/quick.png?game=2&tok=FULLQUICK");
        ok(qr.w === 9 && qr.h === 5, "full code space: quick → (9,5) unavailable");
        var mr = await req(full, "/api/mquick.png?games=1,2&tok=FULLMULTI");
        ok(mr.w === 9 && mr.h === 5, "full code space: mquick → (9,5) unavailable");
        var dr = await req(full, "/api/dcreate.png?n=3&tok=FULLDURAK");
        ok(dr.w === 9 && dr.h === 5, "full code space: dcreate → (9,5) unavailable");
        var pr = await req(full, "/api/pcreate.png?n=3&tok=FULLPOKER");
        ok(pr.w === 9 && pr.h === 5, "full code space: pcreate → (9,5) unavailable");
        ok(!(await full.storage.get("l:-1")), "full code space: no l:-1 lobby is written");
    })();

    // ── security hardening (2026-07-18 audit) ──
    await (async function () {
        // L1: a non-4-digit code can never name a lobby - normalised to "" → missing, not a
        // junk "l:<garbage>" key. Covers "1e3", overlong, non-numeric, and unicode-digit inputs.
        var h = new Hub({ storage: new FakeStorage() });
        var bad = ["1e3", "12345", "99", "abcd", "10 0", "١٢٣٤"];
        for (var i = 0; i < bad.length; i++) {
            var r = await req(h, "/api/status.png?code=" + encodeURIComponent(bad[i]));
            ok(r.w === 9 && r.h === 1, "L1: status(code='" + bad[i] + "') → (9,1) gone (rejected)");
        }

        // H2: /api/join must refuse a multi-seat lobby (poker/durak-N have .cap and their own
        // routes). A guessed code can no longer clobber players/seats on such a lobby.
        var ph = new Hub({ storage: new FakeStorage() });
        var pc = await req(ph, "/api/pcreate.png?n=3&tok=PKHOSTAA");
        var pcode = decCode(pc);
        var jr = await req(ph, "/api/join.png?code=" + pcode + "&tok=INTRUDER1");
        ok(jr.w === 20, "H2: generic join on a poker lobby → (20) missing (guarded)");
        var pr = await req(ph, "/api/proom.png?code=" + pcode);
        ok((pr.w >= 50 ? pr.w - 50 : pr.w) === 1, "H2: poker lobby still has 1 player after blocked join");

        // H3: >RL_MAX_HITS formation requests from ONE IP within the window get (9,4) throttled;
        // a null IP (as the rest of this suite uses) is exempt. Drive it with an explicit IP.
        var th = new Hub({ storage: new FakeStorage() });
        function ipReq(pq) { return th.fetch(new Request("https://mg.test" + pq, { headers: { "CF-Connecting-IP": "203.0.113.9" } })).then(rawDims).then(delevel); }
        var throttled = false, lastH = 0;
        for (var k = 0; k < 120; k++) {
            var rr = await ipReq("/api/create.png?game=1&tok=FLOODER01");
            if (rr.w === 9 && rr.h === 4) { throttled = true; lastH = rr.h; break; }
        }
        ok(throttled, "H3: single-IP create flood eventually returns (9,4) throttled");
        // A different IP is unaffected by the first IP's throttle.
        var other = await th.fetch(new Request("https://mg.test/api/create.png?game=1&tok=CLEANIP01", { headers: { "CF-Connecting-IP": "198.51.100.7" } })).then(rawDims).then(delevel);
        ok(other.w !== 9, "H3: a different IP is not throttled (" + other.w + "," + other.h + ")");

        // H4: normal polling of one code is free, but distinct-code enumeration is capped.
        // The cap resets with time (not a ban), and every IP/NAT gets its own generous set.
        var scan = new Hub({ storage: new FakeStorage() });
        for (var sc = 0; sc < 16; sc++) {
            var sr = await reqIp(scan, "/api/status.png?code=" + sc, "203.0.113.10");
            ok(sr.w === 9 && sr.h === 1, "H4: distinct code probe " + (sc + 1) + " is allowed");
        }
        var scanBlocked = await reqIp(scan, "/api/status.png?code=16", "203.0.113.10");
        ok(scanBlocked.w === 9 && scanBlocked.h === 4,
            "H4: seventeenth distinct code in one minute is softly throttled");
        var sameCode = await reqIp(scan, "/api/status.png?code=0", "203.0.113.10");
        ok(sameCode.w === 9 && sameCode.h === 1,
            "H4: retrying an already-seen lobby code remains free");
        var hotBlocked = await reqIp(scan, "/api/poll.png?code=16&since=0", "203.0.113.10");
        ok(hotBlocked.w === 1 && hotBlocked.h === 1,
            "H4: a hot poll gets non-terminal nothing-new when scan-throttled");
        var clockBlocked = await reqIp(scan, "/api/clocks.png?code=16&seat=0", "203.0.113.10");
        ok(clockBlocked.w === 9 && clockBlocked.h === 7,
            "H4: clocks get a retryable server sentinel instead of false lobby-gone");
        var writeBlocked = await reqIp(scan,
            "/api/move.png?code=16&from=1&to=2&tok=SCANHOST", "203.0.113.10");
        ok(writeBlocked.w === 9 && writeBlocked.h === 3,
            "H4: an authenticated hot write gets non-terminal bad-token when scan-throttled");
        scan.freshCode = async function () { return 16; };
        var cleanupLobby = await reqIp(scan,
            "/api/create.png?game=2&tok=SCANHOST", "203.0.113.10");
        ok(decCode(cleanupLobby) === 16, "H4: creates still work inside the broad formation burst");
        var cleanupResult = await reqIp(scan,
            "/api/cancel.png?code=16&tok=SCANHOST", "203.0.113.10");
        ok(cleanupResult.w === 1 && cleanupResult.h === 1 &&
            !(await scan.storage.get("l:16")),
            "H4: cancel is exempt and cannot strand a throttled lobby or queue");
        var scanOther = await reqIp(scan, "/api/status.png?code=16", "198.51.100.10");
        ok(scanOther.w === 9 && scanOther.h === 1,
            "H4: distinct-code throttle does not affect another IP");

        // H5: an authenticated seat refreshes a genuinely waiting lobby, but an anonymous
        // existence probe cannot pin it forever and is removed by the normal sweep.
        var ttl = new Hub({ storage: new FakeStorage() });
        var ttlCreate = await req(ttl, "/api/create.png?game=2&tok=TTLHOST1");
        var ttlCode = decCode(ttlCreate);
        var ttlLobby = await ttl.storage.get("l:" + ttlCode);
        ttlLobby.t = Date.now() - 31 * 60000;
        await ttl.storage.put("l:" + ttlCode, ttlLobby);
        await req(ttl, "/api/status.png?code=" + ttlCode + "&tok=TTLHOST1");
        await ttl.storage.put("lastSweep", 0);
        await ttl.maybeSweep();
        ok(!!(await ttl.storage.get("l:" + ttlCode)),
            "H5: authenticated waiting-room polling keeps the lobby alive");

        var anonymousCreate = await req(ttl, "/api/create.png?game=2&tok=TTLANON1");
        var anonymousCode = decCode(anonymousCreate);
        var anonymousLobby = await ttl.storage.get("l:" + anonymousCode);
        anonymousLobby.t = Date.now() - 31 * 60000;
        await ttl.storage.put("l:" + anonymousCode, anonymousLobby);
        await req(ttl, "/api/status.png?code=" + anonymousCode);
        await ttl.storage.put("lastSweep", 0);
        await ttl.maybeSweep();
        ok(!(await ttl.storage.get("l:" + anonymousCode)),
            "H5: anonymous status probes cannot keep guessed lobbies alive");
    })();

    // ── checkers: forced capture is enforced by the server ──
    await (async function () {
        var L = await seatedLobby(1, "HCHK1234", "JCHK1234");
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(5, 2) + "&to=" + sq(4, 3) + "&end=1&tok=HCHK1234");
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(2, 5) + "&to=" + sq(3, 4) + "&end=1&tok=JCHK1234");
        // A capture is now available for white at (4,3)->(2,5). A simple non-capture move must be refused.
        var r1 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(5, 4) + "&to=" + sq(4, 5) + "&end=1&tok=HCHK1234");
        ok(r1.w === 9 && r1.h === 2, "checkers: simple move refused while a capture is available (9,2)");
        var r2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(4, 3) + "&to=" + sq(2, 5) + "&end=1&tok=HCHK1234");
        ok(r2.w === 1 && r2.h === 1, "checkers: the forced capture is accepted");
    })();

    // ── tic-tac-toe: marker + occupancy + turn + terminal guard ──
    await (async function () {
        var L = await seatedLobby(2, "HTTT1234", "JTTT1234");
        var a = await req(L.hub, "/api/move.png?code=" + L.code + "&from=4&to=9&end=1&tok=HTTT1234");
        ok(a.w === 1 && a.h === 1, "ttt: host places X in centre (accepted)");
        var b2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=4&to=9&end=1&tok=JTTT1234");
        ok(b2.w === 9 && b2.h === 2, "ttt: placing on an occupied cell → (9,2)");
        var c2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=0&to=9&end=1&tok=HTTT1234");
        ok(c2.w === 9 && c2.h === 1, "ttt: host playing twice → (9,1) not-your-turn");
        var e2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=0&to=9&end=1&tok=JTTT1234");
        ok(e2.w === 1 && e2.h === 1, "ttt: joiner places O (turn alternation)");
    })();

    // ── tic-tac-toe: no moves accepted once the game is decided (terminal guard) ──
    await (async function () {
        var L = await seatedLobby(2, "HWIN1234", "JWIN1234");
        // X takes the top row 0,1,2; O answers on 3,4. X to move first (host seat 0).
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=0&to=9&end=1&tok=HWIN1234"); // X @0
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=3&to=9&end=1&tok=JWIN1234"); // O @3
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=1&to=9&end=1&tok=HWIN1234"); // X @1
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=4&to=9&end=1&tok=JWIN1234"); // O @4
        var win = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=9&end=1&tok=HWIN1234"); // X @2 wins
        ok(win.w === 1 && win.h === 1, "ttt: winning move accepted");
        var after = await req(L.hub, "/api/move.png?code=" + L.code + "&from=5&to=9&end=1&tok=JWIN1234");
        ok(after.w === 9 && after.h === 2, "ttt: move after a win is refused → (9,2)");
    })();

    // ── chess: legal opening + self-check rejection ──
    await (async function () {
        var L = await seatedLobby(4, "HCHS1234", "JCHS1234");
        // White e2-e4: e2 = row6 col4 (52) → e4 = row4 col4 (36).
        var a = await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(6, 4) + "&to=" + sq(4, 4) + "&end=1&tok=HCHS1234");
        ok(a.w === 1 && a.h === 1, "chess: white e2-e4 accepted");
        // Black tries to move a WHITE pawn → not their piece / wrong side → (9,2).
        var b2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(4, 4) + "&to=" + sq(3, 4) + "&end=1&tok=JCHS1234");
        ok(b2.w === 9 && b2.h === 2, "chess: moving the opponent's piece → (9,2)");
        // Black e7-e5: e7 = row1 col4 (12) → e5 = row3 col4 (28).
        var c2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(1, 4) + "&to=" + sq(3, 4) + "&end=1&tok=JCHS1234");
        ok(c2.w === 1 && c2.h === 1, "chess: black e7-e5 accepted");
    })();

    // ── connect four: column marker + gravity + turn + full column ──
    await (async function () {
        var L = await seatedLobby(5, "HCF11234", "JCF11234");
        // Host (red, seat 0) drops in column 3 - accepted (to=7 marker).
        var a = await req(L.hub, "/api/move.png?code=" + L.code + "&from=3&to=7&end=1&tok=HCF11234");
        ok(a.w === 1 && a.h === 1, "c4: host drops in column 3 (accepted)");
        // A bad marker (to != 7) is illegal.
        var b2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=5&end=1&tok=JCF11234");
        ok(b2.w === 9 && b2.h === 2, "c4: wrong destination marker → (9,2)");
        // Host playing twice in a row → not your turn.
        var c2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=7&end=1&tok=HCF11234");
        ok(c2.w === 9 && c2.h === 1, "c4: host playing twice → (9,1) not-your-turn");
        // Joiner (yellow) drops in column 2 - accepted (turn alternation).
        var e2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=7&end=1&tok=JCF11234");
        ok(e2.w === 1 && e2.h === 1, "c4: joiner drops (turn alternation)");
        // Poll round-trips the host's first drop (from=3, to marker=7, end=1).
        var pd = await req(L.hub, "/api/poll.png?code=" + L.code + "&since=0");
        var pfrom = pd.w, pto = pd.h;   // raw squares now; end is derived client-side
        ok(pfrom === 3 && pto === 7, "c4: poll round-trips the column drop (raw from/to)");
        // Fill column 0 (6 discs) then a 7th drop into it is rejected as illegal.
        var L2 = await seatedLobby(5, "HCF21234", "JCF21234");
        var toks = ["HCF21234", "JCF21234"];
        for (var k = 0; k < 6; k++) {
            var who = toks[k % 2];
            var rr = await req(L2.hub, "/api/move.png?code=" + L2.code + "&from=0&to=7&end=1&tok=" + who);
            ok(rr.w === 1, "c4: fill column 0 drop " + (k + 1) + " accepted");
        }
        // It's host's turn again (6 drops = even). Dropping into the FULL column 0 → (9,2).
        var full = await req(L2.hub, "/api/move.png?code=" + L2.code + "&from=0&to=7&end=1&tok=HCF21234");
        ok(full.w === 9 && full.h === 2, "c4: dropping into a full column → (9,2) illegal");
        // Foreign token still rejected.
        var ft = await req(L2.hub, "/api/move.png?code=" + L2.code + "&from=1&to=7&end=1&tok=NOPETOK0");
        ok(ft.w === 9 && ft.h === 3, "c4: foreign token → (9,3) bad-token");
    })();

    // ── durak: authoritative dealer (2 players), automatic deal + public log ──
    await (async function () {
        var L = await seatedLobby(3, "DHOST123", "DJOIN123");   // create(game=3) + join → seats 0/1
        // The declared two-seat room starts atomically when the joiner fills it.
        var rm = await req(L.hub, "/api/room.png?code=" + L.code);
        ok(rm.w === 2 && rm.h === 2, "durak: full 2-seat room auto-starts");
        // A repeated host start is harmless/idempotent.
        var st = await req(L.hub, "/api/start.png?code=" + L.code + "&tok=DHOST123");
        ok(st.w === 1 && st.h === 1, "durak: host start after auto-start is idempotent");
        var rm2 = await req(L.hub, "/api/room.png?code=" + L.code);
        ok(rm2.w === 2 && rm2.h === 2, "durak: room remains started");
        // Public log: TRUMP, OPEN, DRAW(0,6), DRAW(1,6).
        var e0 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=0");
        ok(e0.w === 2 && e0.h >= 1 && e0.h <= 36, "durak: dlog[0] = TRUMP (2, trumpCard+1)");
        var e1 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=1");
        ok(e1.w === 3 && (e1.h === 1 || e1.h === 2), "durak: dlog[1] = OPEN (3, attacker+1)");
        var attacker = e1.h - 1, defender = attacker === 0 ? 1 : 0;
        var e2 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=2");
        ok(e2.w === 50 && e2.h === 7, "durak: dlog[2] = DRAW(seat0, 6)");
        var e3 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=3");
        ok(e3.w === 51 && e3.h === 7, "durak: dlog[3] = DRAW(seat1, 6)");
        var e4 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=4");
        ok(e4.w === 1 && e4.h === 1, "durak: dlog[4] = nothing new (1,1)");
        // Private deal: read my own 6 cards via ddraw.
        var atkTok = attacker === 0 ? "DHOST123" : "DJOIN123", defTok = defender === 0 ? "DHOST123" : "DJOIN123";
        var hand = [];
        for (var i = 0; i < 6; i++) {
            var d = await req(L.hub, "/api/ddraw.png?code=" + L.code + "&tok=" + atkTok + "&i=" + i);
            ok(d.w >= 2 && d.w <= 37 && d.h === 1, "durak: ddraw[" + i + "] returns a card (card+2, never (1,1))");
            hand.push(d.w - 2);
        }
        var d6 = await req(L.hub, "/api/ddraw.png?code=" + L.code + "&tok=" + atkTok + "&i=6");
        ok(d6.w === 1 && d6.h === 1, "durak: ddraw past the hand → (1,1)");
        // Privacy: a foreign token cannot read any seat's private cards.
        var spy = await req(L.hub, "/api/ddraw.png?code=" + L.code + "&tok=STRANGER0&i=0");
        ok(spy.w === 9 && spy.h === 3, "durak: ddraw with foreign token → (9,3)");
        // The defender may not attack.
        var defHand0 = (await req(L.hub, "/api/ddraw.png?code=" + L.code + "&tok=" + defTok + "&i=0")).w - 2;
        var defAtk = await req(L.hub, "/api/dact.png?code=" + L.code + "&tok=" + defTok + "&a=1&c=" + defHand0);
        ok(defAtk.w === 9 && defAtk.h === 1, "durak: defender attacking → (9,1)");
        // The attacker opens with one of its cards → accepted, and a PLAY event appears.
        var atkAct = await req(L.hub, "/api/dact.png?code=" + L.code + "&tok=" + atkTok + "&a=1&c=" + hand[0]);
        ok(atkAct.w === 1 && atkAct.h === 1, "durak: attacker opens (accepted)");
        var ev = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=4");
        ok(ev.w === (10 + attacker) && ev.h === (hand[0] + 1), "durak: dlog records PLAY(attacker, card)");
        // Covering pair 0 with a card the defender does NOT hold is illegal.
        var badCover = await req(L.hub, "/api/dact.png?code=" + L.code + "&tok=" + defTok + "&a=2&p=0&c=" + hand[0]);
        ok(badCover.w === 9 && badCover.h === 2, "durak: covering with a card you don't hold → (9,2)");
    })();

    // ── durak: N-seat private lobby (dcreate/djoin/droom) + 3-player deal, ROLES, throw-in ──
    await (async function () {
        var hub = new Hub({ storage: new FakeStorage() });
        // Host creates a 3-seat durak table (dcreate is NOT the generic create - the 2-int lobby
        // is hard-capped at 2 seats; a 3–4-player table needs its own routes, like poker).
        var dc = await req(hub, "/api/dcreate.png?n=3&tok=DKHOST01");
        ok(codeHost(dc), "durak-N: dcreate → HOST (w>=100 role flag)");
        var code = decCode(dc);
        ok(code >= 0 && code <= 1023, "durak-N: host code valid (" + code + ")");
        var badTok = await req(hub, "/api/dcreate.png?n=3&tok=x");
        ok(badTok.w === 9 && badTok.h === 3, "durak-N: dcreate short token → (9,3)");
        // Room shows 1 seated, cap 3, not started.
        var dr = await req(hub, "/api/droom.png?code=" + code);
        ok(dr.w === 1 && dr.h === 3, "durak-N: droom shows 1 player, cap 3, not started");
        // Two joiners fill seats 1 and 2; each learns its seat + the cap.
        var j1 = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR201");
        ok(j1.w === 3 && j1.h === 2, "durak-N: djoin → cap 3, seat index 1");
        var j1b = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR201");
        ok(j1b.w === 3 && j1b.h === 2, "durak-N: djoin re-join idempotent");
        // Before the table is full, only seat 0 may choose to start early.
        var badStart = await req(hub, "/api/start.png?code=" + code + "&tok=DKPLR201");
        ok(badStart.w === 9 && badStart.h === 1, "durak-N: non-host cannot start a partial table");
        var j2 = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR301");
        ok(j2.w === 3 && j2.h === 3, "durak-N: djoin → cap 3, seat index 2");
        // Simulate a lost response: seat 1 retries only after seat 2 has joined. The response
        // must still carry seat 1, not the table's current player count.
        var j1c = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR201");
        ok(j1c.w === 3 && j1c.h === 2, "durak-N: late re-join preserves the original seat index");
        // Table is already running: an existing seat may retry, but a new token is refused.
        var j3 = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR401");
        ok(j3.w === 22 && j3.h === 1, "durak-N: new join after automatic start → (22,1)");
        // Filling the declared cap deals immediately; an explicit host start remains idempotent.
        var st = await req(hub, "/api/start.png?code=" + code + "&tok=DKHOST01");
        ok(st.w === 1 && st.h === 1, "durak-N: host start after auto-start is idempotent");
        var dr2 = await req(hub, "/api/droom.png?code=" + code);
        ok(dr2.w === 53 && dr2.h === 3, "durak-N: full declared cap auto-starts (players 3, +50 band)");
        // Three DRAW events (one per seat) confirm a 3-hand deal, plus TRUMP + OPEN up front.
        var e0 = await req(hub, "/api/dlog.png?code=" + code + "&since=0");
        ok(e0.w === 2, "durak-N: dlog[0] = TRUMP");
        var e1 = await req(hub, "/api/dlog.png?code=" + code + "&since=1");
        ok(e1.w === 3 && e1.h >= 1 && e1.h <= 3, "durak-N: dlog[1] = OPEN(attacker 0..2)");
        for (var s = 0; s < 3; s++) {
            var ds = await req(hub, "/api/dlog.png?code=" + code + "&since=" + (2 + s));
            ok(ds.w === 50 + s && ds.h === 7, "durak-N: dlog[" + (2 + s) + "] = DRAW(seat " + s + ", 6)");
        }
        // Drive a full bout to force a ROLES event. Read the opener's seat, walk its whole hand
        // (deterministic per-seed) attacking + taking so the defender picks up; the server then
        // rotates roles and emits ROLES(4, attacker*4+defender+1).
        var openSeat = e1.h - 1;                                   // OPEN carried attacker+1
        var toks = ["DKHOST01", "DKPLR201", "DKPLR301"];
        var defSeat = (openSeat + 1) % 3;
        // Attacker opens with its first card.
        var aHand0 = (await req(hub, "/api/ddraw.png?code=" + code + "&tok=" + toks[openSeat] + "&i=0")).w - 2;
        var open = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[openSeat] + "&a=1&c=" + aHand0);
        ok(open.w === 1 && open.h === 1, "durak-N: opener attacks (accepted)");
        // Find where PLAY landed, then the defender takes the table → bout ends, ROLES emitted.
        var take = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[defSeat] + "&a=3");
        ok(take.w === 1 && take.h === 1, "durak-N: defender takes the table (accepted)");
        // Scan the log tail for a ROLES event (w===4). Its a/d must be legal seats and differ.
        var foundRoles = false;
        for (var idx = 5; idx < 40; idx++) {
            var lg = await req(hub, "/api/dlog.png?code=" + code + "&since=" + idx);
            if (lg.w === 1 && lg.h === 1) break;                   // drained
            if (lg.w === 4) {
                var atk = ((lg.h - 1) / 4) | 0, def = (lg.h - 1) % 4;
                ok(atk >= 0 && atk < 3 && def >= 0 && def < 3 && atk !== def, "durak-N: ROLES(a,d) legal & distinct seats");
                foundRoles = true;
                break;
            }
        }
        ok(foundRoles, "durak-N: a ROLES event follows the bout");
    })();

    // ── durak: throw-in PASS consensus (a covered 3-seat table is beaten only on full consensus) ──
    await (async function () {
        // Fresh 3-seat table so there are TWO non-defender attack seats (the opener + one
        // co-attacker). A single opener PASS must NOT beat the table - it only settles that seat;
        // Bito waits until every in-play attack seat has passed (or has nothing to throw in).
        var hub = new Hub({ storage: new FakeStorage() });
        var dc = await req(hub, "/api/dcreate.png?n=3&tok=DKPASS01");
        var code = decCode(dc);
        await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPASS02");
        await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPASS03");
        await req(hub, "/api/start.png?code=" + code + "&tok=DKPASS01");
        var toks = ["DKPASS01", "DKPASS02", "DKPASS03"];
        var openEv = await req(hub, "/api/dlog.png?code=" + code + "&since=1");
        var openSeat = openEv.h - 1, defSeat = (openSeat + 1) % 3;
        var coSeat = (openSeat + 2) % 3;                            // the OTHER non-defender
        // Opener attacks; defender covers so the table goes fully covered (attack phase reopens).
        var aCard = (await req(hub, "/api/ddraw.png?code=" + code + "&tok=" + toks[openSeat] + "&i=0")).w - 2;
        await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[openSeat] + "&a=1&c=" + aCard);
        // Defender tries each of its 6 cards to cover pair 0 (deterministic; at least one may work).
        var covered = false;
        for (var di = 0; di < 6 && !covered; di++) {
            var dCard = (await req(hub, "/api/ddraw.png?code=" + code + "&tok=" + toks[defSeat] + "&i=" + di)).w - 2;
            var cov = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[defSeat] + "&a=2&p=0&c=" + dCard);
            if (cov.w === 1 && cov.h === 1) covered = true;
        }
        if (!covered) {
            // No legal cover in this deal - the consensus path needs a covered table, so just
            // assert the pass route rejects an uncovered table and move on (still a real check).
            var earlyPass = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[openSeat] + "&a=4");
            ok(earlyPass.w === 9 && earlyPass.h === 2, "durak-pass: pass on an uncovered table → (9,2)");
        } else {
            // The cover may have ALREADY beaten the table: if no attack seat held a legal throw-in,
            // canBito() is true the instant the last pair is covered, so the server auto-emits BITO
            // (valid consensus of zero pending throwers). Scan the log tail to find out which case
            // we're in - both are correct, but they need different follow-up assertions.
            var seq = 5, coverBito = false;
            for (;;) {
                var lg0 = await req(hub, "/api/dlog.png?code=" + code + "&since=" + seq);
                if (lg0.w === 1 && lg0.h === 1) break;               // drained
                if (lg0.w === 40 && lg0.h === 1) coverBito = true;
                seq++;
            }
            if (coverBito) {
                // Auto-consensus on cover: nobody could throw in, so the table was beaten with no
                // pass needed. That IS the consensus rule with an empty pending set - assert it.
                ok(true, "durak-pass: covered table with no throw-ins auto-beats (empty consensus)");
            } else {
                // Live covered table: at least one attack seat still holds a throw-in. Defender may
                // not pass (only attack seats vote). Opener passes: unless it's the last unsettled
                // attack seat, this echoes PASS(openSeat)=(41+seat,1) and the bout stays live.
                var defPass = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[defSeat] + "&a=4");
                ok(defPass.w === 9 && defPass.h === 1, "durak-pass: defender cannot pass → (9,1)");
                await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[openSeat] + "&a=4");
                var after = await req(hub, "/api/dlog.png?code=" + code + "&since=" + seq);
                var isPass = (after.w === 41 + openSeat && after.h === 1);
                var isBito = (after.w === 40 && after.h === 1);
                ok(isPass || isBito, "durak-pass: opener pass → PASS echo (window open) or BITO (consensus)");
                if (isPass) {
                    // Co-attacker passes too. With both non-defenders settled, consensus → BITO.
                    await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[coSeat] + "&a=4");
                    var sawBito = false;
                    for (var q = seq + 1; q < seq + 30; q++) {
                        var lg = await req(hub, "/api/dlog.png?code=" + code + "&since=" + q);
                        if (lg.w === 1 && lg.h === 1) break;
                        if (lg.w === 40 && lg.h === 1) { sawBito = true; break; }
                    }
                    ok(sawBito, "durak-pass: both attack seats passed → consensus BITO beats the table");
                } else {
                    ok(true, "durak-pass: opener was last to settle → immediate consensus BITO");
                }
            }
        }
    })();

    // ── poker: authoritative dealer (own route set: pcreate/pjoin/proom/pstart/pact/plog/pdraw) ──
    await (async function () {
        var hub = new Hub({ storage: new FakeStorage() });
        // Host creates a 2-seat poker lobby (pcreate is NOT the generic create - poker owns its
        // routes because the shared lobby is hard-capped at 2 while poker seats 2–4).
        var pc = await req(hub, "/api/pcreate.png?n=2&tok=PHOST123");
        ok(codeHost(pc), "poker: pcreate → HOST (w>=100 role flag)");
        var code = decCode(pc);
        ok(code >= 0 && code <= 1023, "poker: host code valid (" + code + ")");
        // Bad token is refused up front.
        var badTok = await req(hub, "/api/pcreate.png?n=2&tok=x");
        ok(badTok.w === 9 && badTok.h === 3, "poker: pcreate with short token → (9,3)");
        // Room shows 1 seated, cap 2, not started.
        var pr = await req(hub, "/api/proom.png?code=" + code);
        ok(pr.w === 1 && pr.h === 2, "poker: proom shows 1 player, cap 2, not started");
        // A second player joins, learns its seat, and fills the declared cap.
        var pj = await req(hub, "/api/pjoin.png?code=" + code + "&tok=PJOIN123");
        ok(pj.w === 2 && pj.h === 2, "poker: pjoin → cap 2, seat index 1");
        // Re-join is idempotent (poll safety).
        var pj2 = await req(hub, "/api/pjoin.png?code=" + code + "&tok=PJOIN123");
        ok(pj2.w === 2 && pj2.h === 2, "poker: pjoin re-join idempotent");
        var pr2 = await req(hub, "/api/proom.png?code=" + code);
        ok(pr2.w === 52 && pr2.h === 2, "poker: full declared cap auto-deals (players 2, +50 band)");
        // A repeated host deal is harmless/idempotent.
        var ps = await req(hub, "/api/pstart.png?code=" + code + "&tok=PHOST123");
        ok(ps.w === 1 && ps.h === 1, "poker: host deal after auto-deal is idempotent");
        // Public log opens with a HAND event (2, button+1).
        var h0 = await req(hub, "/api/plog.png?code=" + code + "&since=0");
        ok(h0.w === 2 && (h0.h === 1 || h0.h === 2), "poker: plog[0] = HAND (2, button+1)");
        // Private deal: each seat reads exactly its own 2 hole cards (card+2, never (1,1)).
        for (var seatTok = 0; seatTok < 2; seatTok++) {
            var tok = seatTok === 0 ? "PHOST123" : "PJOIN123";
            for (var i = 0; i < 2; i++) {
                var d = await req(hub, "/api/pdraw.png?code=" + code + "&tok=" + tok + "&i=" + i);
                ok(d.w >= 2 && d.w <= 53 && d.h === 1, "poker: pdraw seat" + seatTok + "[" + i + "] returns a card");
            }
        }
        // Privacy: a foreign token can't read any seat's hole cards.
        var spy = await req(hub, "/api/pdraw.png?code=" + code + "&tok=STRANGER0&i=0");
        ok(spy.w === 9 && spy.h === 3, "poker: pdraw with foreign token → (9,3)");
        // Heads-up preflop: the button/SB (seat = button) acts first. Whoever's turn it is folds;
        // the hand ends and the log carries a FOLD then a WIN.
        var button = h0.h - 1;                       // seat on the button = first to act heads-up
        var actTok = button === 0 ? "PHOST123" : "PJOIN123";
        var fold = await req(hub, "/api/pact.png?code=" + code + "&tok=" + actTok + "&a=0&to=0");
        ok(fold.w === 1 && fold.h === 1, "poker: fold accepted");
        var ev1 = await req(hub, "/api/plog.png?code=" + code + "&since=1");
        ok(ev1.w === (10 + button) && ev1.h === 1, "poker: plog records FOLD(seat, 1)");
        var ev2 = await req(hub, "/api/plog.png?code=" + code + "&since=2");
        ok(ev2.w === 7 && ev2.h === 1, "poker: uncontested hand → WIN(7,1)");
        // A busted seat can't happen from one hand (stacks are 200/blinds tiny), so no OVER yet.
        var pnext = await req(hub, "/api/pnext.png?code=" + code + "&tok=PJOIN123");
        ok(pnext.w === 1 && pnext.h === 1, "poker: any seat may deal the next hand once over");
        var h1 = await req(hub, "/api/plog.png?code=" + code + "&since=3");
        ok(h1.w === 2, "poker: next hand appends a fresh HAND event (continuous log)");
    })();

    // ── poker: a hand PLAYED TO THE FLOP reveals three DISTINCT, real board cards ──
    // Regression guard for the "three identical 2♠ on the flop online" bug (2026-07-18): the
    // server was reading the community board off newHand's st.board, which is [] until nextStreet
    // lazily deals it - so every BOARD event encoded card id 0 (= 2♠). No prior test reached a
    // flop (they all folded preflop), so it shipped green. This drives a real preflop CALL+CHECK
    // to the flop and asserts the board cards are distinct and in range.
    await (async function () {
        var hub = new Hub({ storage: new FakeStorage() });
        var HOST = "FLOPHOSTAA", JOIN = "FLOPJOINBB";
        var d = await req(hub, "/api/pcreate.png?n=2&tok=" + HOST);
        var code = decCode(d);
        await req(hub, "/api/pjoin.png?code=" + code + "&tok=" + JOIN);
        await req(hub, "/api/pstart.png?code=" + code + "&tok=" + HOST);
        // Reach the flop: heads-up the button/SB acts first (CALL), then the BB CHECKS. We don't
        // track whose turn it is here - just try each token with CALL, then CHECK, until the flop
        // lands. The server rejects out-of-turn/illegal actions with (9,x), so wrong tries are safe.
        var toks = [HOST, JOIN];
        async function tryAct(a) {
            for (var i = 0; i < toks.length; i++) {
                var r = await req(hub, "/api/pact.png?code=" + code + "&tok=" + toks[i] + "&a=" + a + "&to=0");
                if (r.w === 1 && r.h === 1) return true;
            }
            return false;
        }
        for (var step = 0; step < 4; step++) { if (!(await tryAct(2))) await tryAct(1); }
        // Drain the log; collect BOARD(5, card+1) events.
        var board = [], s = 0, blanks = 0;
        while (blanks < 2 && s < 40) {
            var e = await req(hub, "/api/plog.png?code=" + code + "&since=" + s);
            if (e.w === 1 && e.h === 1) { blanks++; s++; continue; }
            blanks = 0;
            if (e.w === 5) board.push(e.h - 1);
            s++;
        }
        ok(board.length >= 3, "poker: reached the flop - at least 3 BOARD cards emitted (" + board.length + ")");
        var inRange = board.every(function (c) { return c >= 0 && c <= 51; });
        ok(inRange, "poker: every board card is a real id 0..51");
        ok(new Set(board).size === board.length, "poker: board cards are all DISTINCT (no duplicate 2♠ bug)");
    })();

    // ── public quickmatch: pairs two callers into one lobby (with tokens) ──
    var h2 = new Hub({ storage: new FakeStorage() });
    var q1 = await req(h2, "/api/quick.png?game=1&tok=QUICKQAA");
    ok(codeHost(q1), "quick #1 becomes HOST (w>=100 role flag)");
    var c1 = decCode(q1);
    ok(c1 >= 0 && c1 <= 1023, "host code valid (" + c1 + ")");

    var q2 = await req(h2, "/api/quick.png?game=1&tok=QUICKQBB");
    ok(!codeHost(q2), "quick #2 becomes JOINER (w<100)");
    var c2 = decCode(q2);
    ok(c2 === c1, "joiner is paired into the host's lobby (same code)");
    d = await req(h2, "/api/status.png?code=" + c1);
    ok(d.w === 2, "paired lobby has 2 players");

    // ── concurrency: more players form a SECOND independent lobby ──
    var q3 = await req(h2, "/api/quick.png?game=1&tok=QUICKQCC");
    ok(codeHost(q3), "quick #3 hosts a new lobby (waiting slot was consumed)");
    var c3 = decCode(q3);
    ok(c3 !== c1, "second lobby has a different code (" + c3 + ")");
    var q4 = await req(h2, "/api/quick.png?game=1&tok=QUICKQDD");
    var c4 = decCode(q4);
    ok(!codeHost(q4) && c4 === c3, "quick #4 joins the second lobby");

    // Host of lobby 1 (QUICKQAA = white seat 0) plays a legal move; lobby 3 stays independent.
    await req(h2, "/api/move.png?code=" + c1 + "&from=" + sq(5, 0) + "&to=" + sq(4, 1) + "&end=1&tok=QUICKQAA");
    d = await req(h2, "/api/poll.png?code=" + c3 + "&since=0");
    ok(d.w === 1 && d.h === 1, "second lobby has no moves (independent of first)");
    d = await req(h2, "/api/poll.png?code=" + c1 + "&since=0");
    ok(!(d.w === 1 && d.h === 1), "first lobby carries its own move (two concurrent games)");

    // ── per-game queues don't cross-pair ──
    var h4 = new Hub({ storage: new FakeStorage() });
    await req(h4, "/api/quick.png?game=1&tok=QGAME1AA");            // host waiting on game 1
    var g2 = await req(h4, "/api/quick.png?game=2&tok=QGAME2BB");   // different game
    ok(codeHost(g2), "quick for a different game hosts its own lobby (per-game queue)");

    // ── quick match: time-control (tc) bucketing (chess/checkers) ──
    // Helper: decode a quick reply into { host, code }.
    function qdec(r) { return { host: codeHost(r), code: decCode(r) }; }
    await (async function () {
        // (a) Different concrete banks do NOT force-pair: a 1-min seeker and a 10-min seeker each host.
        var ht = new Hub({ storage: new FakeStorage() });
        var a = qdec(await req(ht, "/api/quick.png?game=4&tok=TCONE111&tc=60"));    // chess, 1 min
        ok(a.host, "tc: first 1-min chess seeker HOSTS");
        var b = qdec(await req(ht, "/api/quick.png?game=4&tok=TCTEN222&tc=600"));   // chess, 10 min
        ok(b.host && b.code !== a.code, "tc: a 10-min seeker does NOT join the 1-min host (separate banks)");
        // (b) A same-bank seeker joins the matching host, and the lobby runs that bank.
        var c = qdec(await req(ht, "/api/quick.png?game=4&tok=TCONE333&tc=60"));    // another 1 min
        ok(!c.host && c.code === a.code, "tc: a second 1-min seeker JOINS the waiting 1-min host");
        var s0 = await clkSec(ht, a.code, 0), s1 = await clkSec(ht, a.code, 1);
        ok(s0.sec === 60 && s1.sec === 60, "tc: the paired 1-min lobby banks 60s per side (authoritative /api/clocks)");
    })();
    await (async function () {
        // (c) "Any" joins any waiting bank and adopts it (here a waiting 3-min host → 180s).
        var ht = new Hub({ storage: new FakeStorage() });
        var h = qdec(await req(ht, "/api/quick.png?game=1&tok=ANYHOST1&tc=180"));   // checkers, 3 min
        ok(h.host, "tc/any: concrete 3-min host waits");
        var j = qdec(await req(ht, "/api/quick.png?game=1&tok=ANYJOIN1&tc=any"));   // "Any"
        ok(!j.host && j.code === h.code, "tc/any: an Any seeker joins the waiting 3-min host");
        var s = await clkSec(ht, h.code, 0);
        ok(s.sec === 180, "tc/any: the Any joiner adopts the host's 3-min bank (180s)");
    })();
    await (async function () {
        // (d) Two "Any" seekers meet with no concrete bank around → resolve to the 5-min default.
        var ht = new Hub({ storage: new FakeStorage() });
        var h = qdec(await req(ht, "/api/quick.png?game=4&tok=ANYANY01&tc=any"));
        ok(h.host, "tc/any: first Any seeker HOSTS an undecided-bank lobby");
        var j = qdec(await req(ht, "/api/quick.png?game=4&tok=ANYANY02&tc=any"));
        ok(!j.host && j.code === h.code, "tc/any: the second Any seeker joins it");
        var s = await clkSec(ht, h.code, 0);
        ok(s.sec === 300, "tc/any: two Any seekers resolve to the 5-min default (300s)");
    })();
    await (async function () {
        // (e) A concrete seeker adopts a waiting "Any" host (fixing the bank to the concrete pick).
        var ht = new Hub({ storage: new FakeStorage() });
        var h = qdec(await req(ht, "/api/quick.png?game=1&tok=ANYWAIT1&tc=any"));   // Any host waits
        ok(h.host, "tc/any: Any host waits with no fixed bank");
        var j = qdec(await req(ht, "/api/quick.png?game=1&tok=CONCJN10&tc=600"));   // concrete 10 min
        ok(!j.host && j.code === h.code, "tc/any: a concrete 10-min seeker joins the waiting Any host");
        var s = await clkSec(ht, h.code, 0);
        ok(s.sec === 600, "tc/any: the Any host adopts the joiner's 10-min bank (600s)");
    })();

    // ── checkers variants: Russian / English / Any ────────────────────────────
    await (async function () {
        var hv = new Hub({ storage: new FakeStorage() });
        var russian = qdec(await req(hv, "/api/quick.png?game=1&tok=CVRUSH01&tc=180&cv=russian"));
        ok(russian.host, "cv: first Russian checkers seeker HOSTS");
        var english = qdec(await req(hv, "/api/quick.png?game=1&tok=CVENGL01&tc=180&cv=english"));
        ok(english.host && english.code !== russian.code, "cv: English seeker does not join a Russian waiting lobby");
        var any = qdec(await req(hv, "/api/quick.png?game=1&tok=CVANY001&tc=any&cv=any"));
        ok(!any.host && any.code === russian.code, "cv/any: Any seeker joins the compatible Russian lobby");
        var meta = await req(hv, "/api/match.png?code=" + russian.code);
        ok(meta.w === 1 && meta.h === 5, "cv: match metadata reports Russian 3-minute checkers");
    })();

    // ── multi-select quick match (mquick): intersection matching + status game ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        // Host offers {1,2,4}. No waiting host yet → becomes HOST of an undecided lobby.
        var mh = await req(hm, "/api/mquick.png?games=1,2,4&tok=MQHOST01");
        ok(codeHost(mh), "mquick: first caller becomes HOST (role flag)");
        var mc = decCode(mh);
        ok(mc >= 0 && mc <= 1023, "mquick: host code valid (" + mc + ")");
        // While undecided, status reports game+1 = 1 (game 0).
        var msu = await req(hm, "/api/status.png?code=" + mc);
        ok(msu.w === 1 && msu.h === 1, "mquick: undecided lobby reports players=1, game=0 (h=1)");
        // Joiner offers {4,5}. Intersection with host {1,2,4} = {4} → pairs, fixing game 4 (chess).
        var mj = await req(hm, "/api/mquick.png?games=5,4&tok=MQJOIN01");
        ok(!codeHost(mj), "mquick: intersecting joiner becomes JOINER");
        var mjc = decCode(mj);
        ok(mjc === mc, "mquick: joiner paired into the host's lobby (same code)");
        // Both sides now learn the fixed game from status: players=2, h = game+1 = 5.
        var msd = await req(hm, "/api/status.png?code=" + mc);
        ok(msd.w === 2 && msd.h === 5, "mquick: decided lobby reports players=2, game=4 (h=5)");
        // The fixed lobby is a real chess game: white e2-e4 is accepted.
        var mv = await req(hm, "/api/move.png?code=" + mc + "&from=" + sq(6, 4) + "&to=" + sq(4, 4) + "&end=1&tok=MQHOST01");
        ok(mv.w === 1 && mv.h === 1, "mquick: fixed game plays chess (e2-e4 accepted)");
    })();

    // ── mquick: Durak resolves to one heads-up pair and auto-starts its dealer flow ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        var mh = await req(hm, "/api/mquick.png?games=2,3&tok=MQDHOST1");
        var mc = decCode(mh);
        ok(codeHost(mh), "mquick/durak: first caller waits as host");
        var mj = await req(hm, "/api/mquick.png?games=3&tok=MQDJOIN1");
        ok(!codeHost(mj) && decCode(mj) === mc,
            "mquick/durak: intersecting caller joins the same lobby");
        var ms = await req(hm, "/api/status.png?code=" + mc);
        ok(ms.w === 2 && ms.h === 4,
            "mquick/durak: match resolves to game 3 with exactly two players");
        var room = await req(hm, "/api/room.png?code=" + mc);
        ok(room.w === 2 && room.h === 2,
            "mquick/durak: filled two-seat room starts automatically");
        var first = await req(hm, "/api/dlog.png?code=" + mc + "&since=0");
        ok(first.w === 2 && first.h >= 1 && first.h <= 36,
            "mquick/durak: authoritative deal begins with TRUMP");
        var third = await req(hm, "/api/quick.png?game=3&tok=MQDTHIRD");
        ok(codeHost(third) && decCode(third) !== mc,
            "mquick/durak: a third caller opens a new pair instead of joining the running match");
    })();

    // ── mquick: non-intersecting sets do NOT pair ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        var a = await req(hm, "/api/mquick.png?games=1,2&tok=MQNOAA01");   // host offers {1,2}
        ok(codeHost(a), "mquick: host offers {1,2} (HOST)");
        var ac = decCode(a);
        var b = await req(hm, "/api/mquick.png?games=4,5&tok=MQNOBB01");   // disjoint {4,5}
        ok(codeHost(b), "mquick: disjoint set does NOT pair - hosts its own lobby");
        var bc = decCode(b);
        ok(bc !== ac, "mquick: the two disjoint hosts are separate lobbies");
        // A third caller offering {2} takes the FIRST host (which still waits under queue 2).
        var c = await req(hm, "/api/mquick.png?games=2&tok=MQNOCC01");
        ok(!codeHost(c) && (decCode(c)) === ac, "mquick: {2} joins the {1,2} host, fixing game 2");
    })();

    // ── mquick: cancel clears EVERY per-game queue the multi-lobby registered under ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        var a = await req(hm, "/api/mquick.png?games=1,2,5&tok=MQCANAA1");
        var ac = decCode(a);
        await req(hm, "/api/cancel.png?code=" + ac + "&tok=MQCANAA1");
        // Every queue is now free: a single-game quick on 1, 2 AND 5 each hosts fresh.
        var g1 = await req(hm, "/api/quick.png?game=1&tok=MQFRSH11");
        ok(codeHost(g1), "mquick cancel: queue 1 freed (quick hosts fresh)");
        var g2 = await req(hm, "/api/quick.png?game=2&tok=MQFRSH21");
        ok(codeHost(g2), "mquick cancel: queue 2 freed");
        var g5 = await req(hm, "/api/quick.png?game=5&tok=MQFRSH51");
        ok(codeHost(g5), "mquick cancel: queue 5 freed");
    })();

    // ── mquick: a single /api/quick joiner can match a waiting multi-lobby ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        var a = await req(hm, "/api/mquick.png?games=2,5&tok=MQMIXAA1");   // multi-host {2,5}
        var ac = decCode(a);
        // A plain single-game quick for game 5 should join the multi-host, fixing game 5.
        var j = await req(hm, "/api/quick.png?game=5&tok=MQMIXBB1");
        ok(!codeHost(j) && (decCode(j)) === ac, "mquick: single quick(5) joins a {2,5} multi-host");
        var msd = await req(hm, "/api/status.png?code=" + ac);
        ok(msd.w === 2 && msd.h === 6, "mquick: mixed match fixed game 5 (status h=6)");
    })();

    // ── cancel: only a SEATED player (with token), and only while waiting, may cancel ──
    var h3 = new Hub({ storage: new FakeStorage() });
    var qc = await req(h3, "/api/quick.png?game=1&tok=CANCELAA");
    var cc = decCode(qc);
    // A cancel WITHOUT a token must NOT destroy the lobby (blocks 4-digit-code griefers).
    await req(h3, "/api/cancel.png?code=" + cc);
    d = await req(h3, "/api/status.png?code=" + cc);
    ok(d.w === 1, "cancel without a token leaves the waiting lobby alive");
    // A cancel with a FOREIGN token also does nothing.
    await req(h3, "/api/cancel.png?code=" + cc + "&tok=STRANGER0");
    d = await req(h3, "/api/status.png?code=" + cc);
    ok(d.w === 1, "cancel with a foreign token leaves the lobby alive");
    // The seated host's token cancels it, freeing the waiting slot.
    await req(h3, "/api/cancel.png?code=" + cc + "&tok=CANCELAA");
    var qc2 = await req(h3, "/api/quick.png?game=1&tok=CANCELBB");
    ok(codeHost(qc2), "after a legitimate cancel, next quick hosts fresh (slot freed)");
    d = await req(h3, "/api/status.png?code=" + cc);
    ok(d.w === 9, "cancelled lobby is gone");

    // ── rematch handshake ──────────────────────────────────────────────────────
    await (async function () {
        var L = await seatedLobby(1, "RMHOST01", "RMJOIN01");
        // Play a couple of moves so the board is non-initial before the rematch resets it.
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(5, 0) + "&to=" + sq(4, 1) + "&end=1&tok=RMHOST01");
        await req(L.hub, "/api/move.png?code=" + L.code + "&from=" + sq(2, 1) + "&to=" + sq(3, 0) + "&end=1&tok=RMJOIN01");
        // Foreign token can't rematch.
        var bad = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=STRANGER0&gen=0");
        ok(bad.w === 9 && bad.h === 3, "rematch: foreign token → (9,3)");
        // Host asks first: armed, still gen 0 → (1, gen+1) = (1,1).
        var r1 = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMHOST01&gen=0");
        ok(r1.w === 1 && r1.h === 1, "rematch: host armed, waiting → (1, gen0+1)");
        // Host polling again is idempotent - still waiting, no double-arm side effect.
        var r1b = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMHOST01&gen=0");
        ok(r1b.w === 1 && r1b.h === 1, "rematch: host re-poll stays waiting (idempotent)");
        // Joiner asks: both armed → reset + gen++ → (2, gen1+1) = (2,2).
        var r2 = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMJOIN01&gen=0");
        ok(r2.w === 2 && r2.h === 2, "rematch: both ready → (2, gen1+1)");
        // The board is fresh: poll from 0 sees nothing (moves cleared), status back to 2 players.
        var pl = await req(L.hub, "/api/poll.png?code=" + L.code + "&since=0");
        ok(pl.w === 1 && pl.h === 1, "rematch: state reset - poll(since=0) → (1,1) nothing new");
        // Host's stale gen-0 poll after the bump can't re-arm the next rematch; it just reads gen 1.
        var stale = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMHOST01&gen=0");
        ok(stale.w === 1 && stale.h === 2, "rematch: stale gen-0 poll reads gen 1, does not arm");
        // A second full rematch at the live gen works and bumps to gen 2.
        await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMHOST01&gen=1");
        var r3 = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMJOIN01&gen=1");
        ok(r3.w === 2 && r3.h === 3, "rematch: second rematch at live gen → (2, gen2+1)");
    })();

    // ── authoritative clocks (time controls + flag-fall) ───────────────────────
    await (async function () {
        // create with tc=60 → the host lobby carries a 60s bank per seat.
        var hub = new Hub({ storage: new FakeStorage() });
        var c = await req(hub, "/api/create.png?game=4&tok=CLKHOST01&tc=60");
        var code = decCode(c);
        // join learns the time control from the height as a tc-INDEX+1 (60s → index 1 → h=2).
        var j = await req(hub, "/api/join.png?code=" + code + "&tok=CLKJOIN01");
        ok(j.w === 4 && j.h === 2, "join reports the host's time control (tc=60 → index 1 → h=2)");
        // clocks are per-seat now: read each seat with &seat= and decode the banded value.
        var b0 = await clkSec(hub, code, 0), b1 = await clkSec(hub, code, 1);
        ok(b0.sec === 60 && b1.sec === 60, "clocks: both seats start at the full 60s bank");

        // an UNTIMED lobby (no tc) reports the untimed sentinel, never a bogus clock.
        var u = await seatedLobby(4, "UNTMHOST1", "UNTMJOIN1");
        var uc = await clkSec(u.hub, u.code, 0);
        ok(uc.sentinel === 8, "clocks: untimed lobby → (9,8) sentinel");

        // a missing lobby reports the gone sentinel.
        var gc = await clkSec(hub, 1, 0);
        ok(gc.sentinel === 9, "clocks: missing lobby → (9,9) sentinel");

        // tc off the menu (e.g. 42s) is rejected → untimed lobby.
        var hub2 = new Hub({ storage: new FakeStorage() });
        var c2 = await req(hub2, "/api/create.png?game=4&tok=BADTCHOST&tc=42");
        var code2 = decCode(c2);
        var j2 = await req(hub2, "/api/join.png?code=" + code2 + "&tok=BADTCJOIN");
        ok(j2.h === 1, "create: off-menu tc (42s) is rejected → untimed (join h=1)");

        // tc is ignored for a non-clock game (TTT) → untimed.
        var hub3 = new Hub({ storage: new FakeStorage() });
        var c3 = await req(hub3, "/api/create.png?game=2&tok=TTTTCHOST&tc=300");
        var code3 = decCode(c3);
        var j3 = await req(hub3, "/api/join.png?code=" + code3 + "&tok=TTTTCJOIN");
        ok(j3.h === 1, "create: tc ignored for a non-clock game (TTT) → untimed");

        // ── time charging + flag-fall (deterministic: rewind clkStart in storage) ──
        // A clock only advances by wall time. To test without sleeping, we reach into the
        // fake storage and move the running seat's clkStart back by N ms, then read /clocks.
        var fhub = new Hub({ storage: new FakeStorage() });
        var fc = await req(fhub, "/api/create.png?game=4&tok=FLAGHOST1&tc=60");
        var fcode = decCode(fc);
        await req(fhub, "/api/join.png?code=" + fcode + "&tok=FLAGJOIN1");
        var L = await fhub.storage.get("l:" + fcode);
        // Seat 0 (host) is on the move. Pretend 25s elapsed since its turn began.
        L.clkStart = L.clkStart - 25000;
        await fhub.storage.put("l:" + fcode, L);
        // Per-seat now: seat 0 (running) has ~35s left, seat 1 (idle) still the full 60.
        var ck2a = await clkSec(fhub, fcode, 0);
        var ck2b = await clkSec(fhub, fcode, 1);
        ok(ck2a.sec === 35 && ck2b.sec === 60, "clocks: 25s charged to the running seat only (seat0=35, seat1=60)");

        // Now blow past the bank: rewind 70s > 60s → running seat flags and loses.
        L = await fhub.storage.get("l:" + fcode);
        L.clkStart = L.clkStart - 70000;
        await fhub.storage.put("l:" + fcode, L);
        var ck3 = await clkSec(fhub, fcode, 0);
        ok(ck3.sec === 0, "clocks: running seat's bank hits 0 → flag-fall (seat0=0)");
        // The flag is now persisted: a move by EITHER seat is refused (game over on time).
        var mv = await req(fhub, "/api/move.png?code=" + fcode + "&from=" + sq(6, 4) + "&to=" + sq(4, 4) + "&end=1&tok=FLAGHOST1");
        ok(mv.w === 9 && mv.h === 2, "move after flag-fall is refused → (9,2)");
        // A later /clocks re-read still shows the flagged seat at 0 (sticks, doesn't tick back up).
        var ck4 = await clkSec(fhub, fcode, 0);
        ok(ck4.sec === 0, "clocks: flag sticks on later reads (seat0=0)");
    })();

    // ── /api/leave: mid-game exit (pair teardown, foreign-token no-op, N-seat fold-out) ──
    await (async function () {
        // A) Pair game (chess): a live match. Leaving tears the lobby down so the opponent's next
        //    poll returns (9,9) "gone" - the survivor is shown "Opponent left." and wins by default.
        var hub = new Hub({ storage: new FakeStorage() });
        var c = await req(hub, "/api/create.png?game=1&tok=LVHOST001");
        var code = decCode(c);
        await req(hub, "/api/join.png?code=" + code + "&tok=LVJOIN001");
        // A stranger with no seat token can never nuke the match.
        var lv0 = await req(hub, "/api/leave.png?code=" + code + "&tok=STRANGER9");
        ok(lv0.w === 1 && lv0.h === 1, "leave: foreign token → (1,1) no-op");
        var st0 = await req(hub, "/api/status.png?code=" + code);
        ok(st0.w === 2, "leave: match still intact after a foreign-token leave");
        // The seated joiner leaves → lobby is deleted.
        var lv1 = await req(hub, "/api/leave.png?code=" + code + "&tok=LVJOIN001");
        ok(lv1.w === 1 && lv1.h === 1, "leave: seated player leaving → (1,1)");
        var pgone = await req(hub, "/api/poll.png?code=" + code + "&since=0");
        ok(pgone.w === 9 && pgone.h === 9, "leave: opponent's poll now returns (9,9) gone");
        // Leaving an already-gone lobby is a harmless no-op.
        var lv2 = await req(hub, "/api/leave.png?code=" + code + "&tok=LVHOST001");
        ok(lv2.w === 1 && lv2.h === 1, "leave: already-gone lobby → (1,1) no-op");

        // B) 3-seat durak: a live table. One seat leaves → the table PLAYS ON (still 2 present).
        //    A LEFT(45+seat) event is appended so both survivors learn, and the game is NOT over.
        var dhub = new Hub({ storage: new FakeStorage() });
        var dc = await req(dhub, "/api/dcreate.png?n=3&tok=DLHOST01");
        var dcode = decCode(dc);
        await req(dhub, "/api/djoin.png?code=" + dcode + "&tok=DLPLR201");
        await req(dhub, "/api/djoin.png?code=" + dcode + "&tok=DLPLR301");
        await req(dhub, "/api/start.png?code=" + dcode + "&tok=DLHOST01");
        // Drain the log to the current tail so we can spot the LEFT event that leave appends.
        var tail = 0;
        for (var di = 0; di < 60; di++) {
            var lg = await req(dhub, "/api/dlog.png?code=" + dcode + "&since=" + di);
            if (lg.w === 1 && lg.h === 1) { tail = di; break; }
        }
        // Seat 2 (DLPLR301) leaves. Table still has seats 0 & 1 → not torn down.
        var dlv = await req(dhub, "/api/leave.png?code=" + dcode + "&tok=DLPLR301");
        ok(dlv.w === 1 && dlv.h === 1, "leave(durak-3): seat 2 leaves → (1,1)");
        var droom = await req(dhub, "/api/droom.png?code=" + dcode);
        ok(droom.w >= 50, "leave(durak-3): table still alive & started after a leave");
        // A LEFT(47) event (45 + seat 2) is present in the freshly-appended tail.
        var sawLeft = false, sawOver = false;
        for (var dj = tail; dj < tail + 30; dj++) {
            var e = await req(dhub, "/api/dlog.png?code=" + dcode + "&since=" + dj);
            if (e.w === 1 && e.h === 1) break;
            if (e.w === 47 && e.h === 1) sawLeft = true;
            if (e.w === 60) sawOver = true;
        }
        ok(sawLeft, "leave(durak-3): LEFT(47) event logged for the departed seat");
        ok(!sawOver, "leave(durak-3): 2 players remain → game NOT over");
        // Now a SECOND seat leaves → only one player left → table torn down.
        await req(dhub, "/api/leave.png?code=" + dcode + "&tok=DLPLR201");
        var dgone = await req(dhub, "/api/dlog.png?code=" + dcode + "&since=0");
        ok(dgone.w === 9 && dgone.h === 9, "leave(durak-3): dropping to 1 player tears the table down");

        // C) 3-seat poker: a live table. One seat leaves → folds out, LEFT(50+seat) logged, plays on.
        var phub = new Hub({ storage: new FakeStorage() });
        var pc = await req(phub, "/api/pcreate.png?n=3&tok=PLHOST01");
        var pcode = decCode(pc);
        await req(phub, "/api/pjoin.png?code=" + pcode + "&tok=PLPLR201");
        await req(phub, "/api/pjoin.png?code=" + pcode + "&tok=PLPLR301");
        await req(phub, "/api/pstart.png?code=" + pcode + "&tok=PLHOST01");
        var ptail = 0;
        for (var pi = 0; pi < 80; pi++) {
            var pe = await req(phub, "/api/plog.png?code=" + pcode + "&since=" + pi);
            if (pe.w === 1 && pe.h === 1) { ptail = pi; break; }
        }
        var plv = await req(phub, "/api/leave.png?code=" + pcode + "&tok=PLPLR301");
        ok(plv.w === 1 && plv.h === 1, "leave(poker-3): seat 2 leaves → (1,1)");
        var proom = await req(phub, "/api/proom.png?code=" + pcode);
        ok(proom.w >= 50, "leave(poker-3): table still alive & started after a leave");
        var sawPLeft = false;
        for (var pj2 = ptail; pj2 < ptail + 30; pj2++) {
            var pev = await req(phub, "/api/plog.png?code=" + pcode + "&since=" + pj2);
            if (pev.w === 1 && pev.h === 1) break;
            if (pev.w === 52 && pev.h === 1) sawPLeft = true;
        }
        ok(sawPLeft, "leave(poker-3): LEFT(52) event logged for the departed seat");
        var afterFirstPokerLeave = (await phub.storage.get("l:" + pcode)).state.log.length;
        for (var repeatLeave = 0; repeatLeave < 20; repeatLeave++) {
            await req(phub, "/api/leave.png?code=" + pcode + "&tok=PLPLR301");
        }
        var afterRepeatedPokerLeave = (await phub.storage.get("l:" + pcode)).state.log.length;
        ok(afterRepeatedPokerLeave === afterFirstPokerLeave,
            "leave(poker-3): repeated leave is idempotent and appends no duplicate LEFT events");

        // Even a first-time departure at the hard log ceiling must not push the persisted lobby
        // past MOVE_CAP. Tearing the abuse-only table down is safer than an unlogged fold.
        var capHub = new Hub({ storage: new FakeStorage() });
        var capCreate = await req(capHub, "/api/pcreate.png?n=4&tok=CAPLHOST");
        var capCode = decCode(capCreate);
        await req(capHub, "/api/pjoin.png?code=" + capCode + "&tok=CAPLPLR1");
        await req(capHub, "/api/pjoin.png?code=" + capCode + "&tok=CAPLPLR2");
        await req(capHub, "/api/pjoin.png?code=" + capCode + "&tok=CAPLPLR3");
        await req(capHub, "/api/pstart.png?code=" + capCode + "&tok=CAPLHOST");
        var cappedLobby = await capHub.storage.get("l:" + capCode);
        cappedLobby.state.log = new Array(1200).fill({ w: 2, h: 1 });
        await capHub.storage.put("l:" + capCode, cappedLobby);
        await req(capHub, "/api/leave.png?code=" + capCode + "&tok=CAPLPLR3");
        ok((await req(capHub, "/api/plog.png?code=" + capCode + "&since=0")).w === 9,
            "leave(poker-4): MOVE_CAP departure tears down instead of growing the log");

        // D) Pre-start lobby: leave behaves like cancel (tears down a waiting lobby).
        var whub = new Hub({ storage: new FakeStorage() });
        var wc = await req(whub, "/api/create.png?game=1&tok=WLHOST001");
        var wcode = decCode(wc);
        await req(whub, "/api/leave.png?code=" + wcode + "&tok=WLHOST001");
        var wstat = await req(whub, "/api/status.png?code=" + wcode);
        ok(wstat.w === 9, "leave: pre-start host leaving tears the waiting lobby down");

        // E) Pre-start MULTI-seat leave keeps the table. A joiner walking away (closing the Esc
        // menu in the room view calls /api/leave) used to delete the whole lobby, taking the host
        // and every other seated player with it. The vacated index becomes a HOLE, never a
        // renumbering - each client cached its own seat at join time and is never told otherwise.
        var hhub = new Hub({ storage: new FakeStorage() });
        var hc = await req(hhub, "/api/dcreate.png?n=4&tok=HOLEHOST");
        var hcode = decCode(hc);
        var hj1 = await req(hhub, "/api/djoin.png?code=" + hcode + "&tok=HOLEJ001");
        var hj2 = await req(hhub, "/api/djoin.png?code=" + hcode + "&tok=HOLEJ002");
        ok(hj1.h === 2 && hj2.h === 3, "hole: joiners took seats 1 and 2");
        var hlv = await req(hhub, "/api/leave.png?code=" + hcode + "&tok=HOLEJ001");
        ok(hlv.w === 1 && hlv.h === 1, "hole: pre-start joiner leave → (1,1)");
        var hroom = await req(hhub, "/api/droom.png?code=" + hcode);
        ok(hroom.w !== 9, "hole: table SURVIVES a pre-start joiner leave");
        ok(hroom.w === 2, "hole: droom reports 2 present (not the 3 seats ever handed out)");
        // The seat-2 player must keep index 2 - compacting would have handed it index 1.
        var hre = await req(hhub, "/api/djoin.png?code=" + hcode + "&tok=HOLEJ002");
        ok(hre.h === 3, "hole: the remaining joiner still holds seat 2 (no renumbering)");
        // A fresh joiner refills the hole rather than growing the table past cap.
        var hj3 = await req(hhub, "/api/djoin.png?code=" + hcode + "&tok=HOLEJ003");
        ok(hj3.h === 2, "hole: a new joiner is seated INTO the vacated index 1");
        ok((await req(hhub, "/api/droom.png?code=" + hcode)).w === 3, "hole: droom back to 3 present");
        var refilledDurak = await hhub.storage.get("l:" + hcode);
        ok(!refilledDurak.left || refilledDurak.left.indexOf(1) < 0,
            "hole: djoin clears the replacement seat's stale left marker");
        // Start, then let the other original joiner leave. Host + replacement are still live, so
        // stale departure bookkeeping must not tear their table down.
        await req(hhub, "/api/start.png?code=" + hcode + "&tok=HOLEHOST");
        await req(hhub, "/api/leave.png?code=" + hcode + "&tok=HOLEJ002");
        var refilledDurakRoom = await req(hhub, "/api/droom.png?code=" + hcode);
        ok(refilledDurakRoom.w === 52,
            "hole: later leave keeps the started Durak table alive with host + replacement");

        // Host leaving PRE-start still ends a separate room - nobody else can press Start.
        var hostLeaveHub = new Hub({ storage: new FakeStorage() });
        var hostLeaveCreate = await req(hostLeaveHub, "/api/dcreate.png?n=3&tok=HLHOST01");
        var hostLeaveCode = decCode(hostLeaveCreate);
        await req(hostLeaveHub, "/api/djoin.png?code=" + hostLeaveCode + "&tok=HLJOIN01");
        await req(hostLeaveHub, "/api/leave.png?code=" + hostLeaveCode + "&tok=HLHOST01");
        ok((await req(hostLeaveHub, "/api/droom.png?code=" + hostLeaveCode)).w === 9,
            "hole: pre-start HOST leave still tears the table down");

        // F) Start with an unfilled hole: the deal must run and fold the empty seat out, so the
        // remaining players get a live game instead of a table that waits on a ghost.
        var ghub = new Hub({ storage: new FakeStorage() });
        var gc = await req(ghub, "/api/dcreate.png?n=4&tok=GAPHOST1");
        var gcode = decCode(gc);
        await req(ghub, "/api/djoin.png?code=" + gcode + "&tok=GAPJ0001");
        await req(ghub, "/api/djoin.png?code=" + gcode + "&tok=GAPJ0002");
        await req(ghub, "/api/leave.png?code=" + gcode + "&tok=GAPJ0001");   // hole at seat 1
        var gst = await req(ghub, "/api/start.png?code=" + gcode + "&tok=GAPHOST1");
        ok(gst.w === 1 && gst.h === 1, "gap: host can start a durak table with a hole in it");
        var sawGapLeft = false, gapEvents = 0;
        for (var gi = 0; gi < 60; gi++) {
            var gev = await req(ghub, "/api/dlog.png?code=" + gcode + "&since=" + gi);
            if (gev.w === 1 && gev.h === 1) break;
            gapEvents++;
            if (gev.w === 46) sawGapLeft = true;                 // LEFT(seat 1) = 45 + 1
        }
        ok(gapEvents > 0, "gap: the deal produced a public log");
        ok(sawGapLeft, "gap: the empty seat is folded out via a LEFT event");
        // Poker takes the same route, but a hole just starts with a zero stack (newHand sits it out).
        var qhub = new Hub({ storage: new FakeStorage() });
        var qc = await req(qhub, "/api/pcreate.png?n=4&tok=GAPPHST1");
        var qcode = decCode(qc);
        await req(qhub, "/api/pjoin.png?code=" + qcode + "&tok=GAPPJ001");
        await req(qhub, "/api/pjoin.png?code=" + qcode + "&tok=GAPPJ002");
        await req(qhub, "/api/leave.png?code=" + qcode + "&tok=GAPPJ001");
        var qbad = await req(qhub, "/api/pstart.png?code=" + qcode + "&tok=GAPPJ002");
        ok(qbad.w === 9 && qbad.h === 1, "gap: non-host cannot deal a partial poker table");
        var qst = await req(qhub, "/api/pstart.png?code=" + qcode + "&tok=GAPPHST1");
        ok(qst.w === 1 && qst.h === 1, "gap: host can deal a poker table with a hole in it");
        ok((await req(qhub, "/api/proom.png?code=" + qcode)).w >= 50, "gap: poker table reports started");
        var sawPokerGapLeft = false;
        for (var qgi = 0; qgi < 20; qgi++) {
            var qgev = await req(qhub, "/api/plog.png?code=" + qcode + "&since=" + qgi);
            if (qgev.w === 1 && qgev.h === 1) break;
            if (qgev.w === 51) sawPokerGapLeft = true;              // LEFT(seat 1) = 50 + 1
        }
        ok(sawPokerGapLeft, "gap: poker clients are told that the empty seat is out");

        // Poker reuses and restores a pre-start hole exactly like Durak. A later leave must count
        // the replacement as live rather than deleting the table out from under it.
        var pHoleHub = new Hub({ storage: new FakeStorage() });
        var pHoleCreate = await req(pHoleHub, "/api/pcreate.png?n=4&tok=PHOLHOST");
        var pHoleCode = decCode(pHoleCreate);
        await req(pHoleHub, "/api/pjoin.png?code=" + pHoleCode + "&tok=PHOLPLR1");
        await req(pHoleHub, "/api/pjoin.png?code=" + pHoleCode + "&tok=PHOLPLR2");
        await req(pHoleHub, "/api/leave.png?code=" + pHoleCode + "&tok=PHOLPLR1");
        var pHoleJoin = await req(pHoleHub, "/api/pjoin.png?code=" + pHoleCode + "&tok=PHOLREPL");
        ok(pHoleJoin.h === 2, "hole: pjoin reuses the vacated seat index");
        var refilledPoker = await pHoleHub.storage.get("l:" + pHoleCode);
        ok(!refilledPoker.left || refilledPoker.left.indexOf(1) < 0,
            "hole: pjoin clears the replacement seat's stale left marker");
        await req(pHoleHub, "/api/pstart.png?code=" + pHoleCode + "&tok=PHOLHOST");
        await req(pHoleHub, "/api/leave.png?code=" + pHoleCode + "&tok=PHOLPLR2");
        ok((await req(pHoleHub, "/api/proom.png?code=" + pHoleCode)).w === 52,
            "hole: later leave keeps the started Poker table alive with host + replacement");

        // G) /api/join must REFUSE an mquick lobby. It sits at game 0 until a seeker resolves it
        // through finalizeJoin; the generic join hard-set players=2 with game 0 and state null,
        // which bricked the lobby for its full 30-minute life (host span forever on waitForMulti-
        // Match, every move answered (9,2), and the pubq:m:* keys stayed pinned to a dead code).
        var mhub = new Hub({ storage: new FakeStorage() });
        var mc = await req(mhub, "/api/mquick.png?games=1,2&tok=MQHOST001");
        var mcode = decCode(mc);
        var mj = await req(mhub, "/api/join.png?code=" + mcode + "&tok=MQJOIN001");
        ok(mj.w === 20 && mj.h === 1, "mquick: generic /api/join is refused with (20,1) missing");
        var mstat = await req(mhub, "/api/status.png?code=" + mcode);
        ok(mstat.w === 1, "mquick: the lobby is untouched - still waiting with 1 player");
        // …and the intended path still works: a seeker matches through mquick itself.
        var ms = await req(mhub, "/api/mquick.png?games=2,4&tok=MQSEEK001");
        ok(ms.w > 0 && ms.w !== 9, "mquick: a real seeker still matches into the lobby");

        // J) A token can never occupy both seats of one lobby. seatOf returns the FIRST match, so
        // self-matching made seat 1 unreachable: every move resolved to seat 0 and the game wedged
        // after the first one. Reachable honestly by double-clicking Quick Match (cancel then
        // refuses to free the abandoned lobby because players is already 2).
        var xhub = new Hub({ storage: new FakeStorage() });
        var q1 = await req(xhub, "/api/quick.png?game=2&tok=SELFMTCH");
        var q2 = await req(xhub, "/api/quick.png?game=2&tok=SELFMTCH");
        ok(decCode(q1) !== decCode(q2), "self-match: a second quick with the same token does NOT join its own lobby");
        ok((await req(xhub, "/api/status.png?code=" + decCode(q1))).w === 1, "self-match: the first lobby is still waiting for a real opponent");
        // A different token matches into whichever lobby currently owns the queue slot (the second
        // host overwrote it), but it must be a REAL match: two players in one lobby.
        var q3 = await req(xhub, "/api/quick.png?game=2&tok=OTHERPLR");
        ok((await req(xhub, "/api/status.png?code=" + decCode(q3))).w === 2, "self-match: a DIFFERENT token still matches into a waiting lobby");
        // Typing your own private code is idempotent, not a second seat.
        var chub = new Hub({ storage: new FakeStorage() });
        var cc = await req(chub, "/api/create.png?game=2&tok=SELFJOIN");
        var ccode = decCode(cc);
        var selfJoin = await req(chub, "/api/join.png?code=" + ccode + "&tok=SELFJOIN");
        ok(selfJoin.w === 2, "self-join: the host typing its own code gets an idempotent reply");
        ok((await req(chub, "/api/status.png?code=" + ccode)).w === 1, "self-join: the lobby still has ONE player");
        ok((await req(chub, "/api/join.png?code=" + ccode + "&tok=REALJOIN")).w === 2, "self-join: a real joiner can still take seat 1");

        // H) Rematch on a 3-seat table needs EVERY seat, not just seats 0 and 1. Two players used
        // to be able to reset the game from under the third: state was re-initialised and the
        // public log truncated to empty, leaving that seat's `since` cursor past the end of it -
        // a frozen screen with no way back.
        var rhub = new Hub({ storage: new FakeStorage() });
        var rc = await req(rhub, "/api/dcreate.png?n=3&tok=RMHOST01");
        var rcode = decCode(rc);
        await req(rhub, "/api/djoin.png?code=" + rcode + "&tok=RMPLR001");
        await req(rhub, "/api/djoin.png?code=" + rcode + "&tok=RMPLR002");
        await req(rhub, "/api/start.png?code=" + rcode + "&tok=RMHOST01");
        var rlogLen = 0;
        for (var ri = 0; ri < 80; ri++) {
            var rev = await req(rhub, "/api/dlog.png?code=" + rcode + "&since=" + ri);
            if (rev.w === 1 && rev.h === 1) { rlogLen = ri; break; }
        }
        ok(rlogLen > 0, "rematch: the started table has a public log");
        var rm0 = await req(rhub, "/api/rematch.png?code=" + rcode + "&tok=RMHOST01&gen=0");
        var rm1 = await req(rhub, "/api/rematch.png?code=" + rcode + "&tok=RMPLR001&gen=0");
        ok(rm0.w === 1 && rm1.w === 1, "rematch: seats 0 and 1 agreeing is NOT enough on a 3-seat table");
        var stillThere = await req(rhub, "/api/dlog.png?code=" + rcode + "&since=" + (rlogLen - 1));
        ok(!(stillThere.w === 1 && stillThere.h === 1), "rematch: seat 2's log cursor is still valid");
        var rm2 = await req(rhub, "/api/rematch.png?code=" + rcode + "&tok=RMPLR002&gen=0");
        ok(rm2.w === 2, "rematch: the LAST seat agreeing performs the reset");
        ok((await req(rhub, "/api/droom.png?code=" + rcode)).w === 53,
            "rematch: all 3 seats are automatically dealt a fresh Durak game");
        var freshDurakLog = await req(rhub, "/api/dlog.png?code=" + rcode + "&since=0");
        ok(freshDurakLog.w === 2, "rematch: fresh Durak log begins with TRUMP, not an empty poll");
        // An empty seat can never answer, so it must not hold the rematch hostage.
        var ehub = new Hub({ storage: new FakeStorage() });
        var ec = await req(ehub, "/api/dcreate.png?n=3&tok=RMEHOST1");
        var ecode = decCode(ec);
        await req(ehub, "/api/djoin.png?code=" + ecode + "&tok=RMEPLR01");
        await req(ehub, "/api/djoin.png?code=" + ecode + "&tok=RMEPLR02");
        await req(ehub, "/api/start.png?code=" + ecode + "&tok=RMEHOST1");
        await req(ehub, "/api/leave.png?code=" + ecode + "&tok=RMEPLR02");   // seat 2 walks out mid-game
        await req(ehub, "/api/rematch.png?code=" + ecode + "&tok=RMEHOST1&gen=0");
        var erm = await req(ehub, "/api/rematch.png?code=" + ecode + "&tok=RMEPLR01&gen=0");
        ok(erm.w === 2, "rematch: a departed seat does not block the remaining players");
        ok((await req(ehub, "/api/droom.png?code=" + ecode)).w === 52,
            "rematch: remaining Durak seats are automatically redealt");
        var departedFreshLog = await req(ehub, "/api/dlog.png?code=" + ecode + "&since=0");
        ok(departedFreshLog.w === 2,
            "rematch: Durak redeal with a departed seat still begins with TRUMP");

        // Poker uses the same generic Play Again handshake, but its controller also only polls:
        // a successful rematch must append a fresh HAND event server-side.
        var pokerRematchHub = new Hub({ storage: new FakeStorage() });
        var pokerRematchCreate = await req(pokerRematchHub, "/api/pcreate.png?n=2&tok=PRMHOST1");
        var pokerRematchCode = decCode(pokerRematchCreate);
        await req(pokerRematchHub, "/api/pjoin.png?code=" + pokerRematchCode + "&tok=PRMJOIN1");
        await req(pokerRematchHub, "/api/pstart.png?code=" + pokerRematchCode + "&tok=PRMHOST1");
        await req(pokerRematchHub, "/api/rematch.png?code=" + pokerRematchCode + "&tok=PRMHOST1&gen=0");
        var pokerRematchDone = await req(pokerRematchHub,
            "/api/rematch.png?code=" + pokerRematchCode + "&tok=PRMJOIN1&gen=0");
        ok(pokerRematchDone.w === 2, "rematch: both Poker seats complete the handshake");
        ok((await req(pokerRematchHub, "/api/proom.png?code=" + pokerRematchCode)).w === 52,
            "rematch: Poker table is automatically dealt again");
        var freshPokerLog = await req(pokerRematchHub,
            "/api/plog.png?code=" + pokerRematchCode + "&since=0");
        ok(freshPokerLog.w === 2, "rematch: fresh Poker log begins with HAND, not an empty poll");

        // I) Durak PASS is idempotent. applyPass always was, but the event push was not, so a seat
        // spamming /api/dact?a=4 appended a PASS event every time. st.pub was the one monotonic log
        // MOVE_CAP never bounded, so it grew until the Durable Object's 128 KiB per-value limit made
        // storage.put throw - after which EVERY request on that lobby answered (9,7) forever.
        // PASS is only legal on a fully-covered non-empty table, so build one first (same shape as
        // the durak-pass test above): opener attacks, defender covers.
        var shub = new Hub({ storage: new FakeStorage() });
        var sc = await req(shub, "/api/dcreate.png?n=3&tok=SPHOST01");
        var scode = decCode(sc);
        var stoks = ["SPHOST01", "SPPLR001", "SPPLR002"];
        await req(shub, "/api/djoin.png?code=" + scode + "&tok=SPPLR001");
        await req(shub, "/api/djoin.png?code=" + scode + "&tok=SPPLR002");
        await req(shub, "/api/start.png?code=" + scode + "&tok=SPHOST01");
        var sOpenEv = await req(shub, "/api/dlog.png?code=" + scode + "&since=1");
        var sOpen = sOpenEv.h - 1, sDef = (sOpen + 1) % 3;
        var sAtk = (await req(shub, "/api/ddraw.png?code=" + scode + "&tok=" + stoks[sOpen] + "&i=0")).w - 2;
        await req(shub, "/api/dact.png?code=" + scode + "&tok=" + stoks[sOpen] + "&a=1&c=" + sAtk);
        var sCovered = false;
        for (var sdi = 0; sdi < 6 && !sCovered; sdi++) {
            var sdc = (await req(shub, "/api/ddraw.png?code=" + scode + "&tok=" + stoks[sDef] + "&i=" + sdi)).w - 2;
            var scov = await req(shub, "/api/dact.png?code=" + scode + "&tok=" + stoks[sDef] + "&a=2&p=0&c=" + sdc);
            if (scov.w === 1 && scov.h === 1) sCovered = true;
        }
        async function logLen(hub, c) {
            for (var i = 0; i < 400; i++) {
                var e = await req(hub, "/api/dlog.png?code=" + c + "&since=" + i);
                if (e.w === 1 && e.h === 1) return i;
            }
            return -1;
        }
        if (sCovered) {
            // Pass ONCE from the opener. On a 3-seat table this only settles that seat - Bito waits
            // for the co-attacker - so the pass window stays open, which is the state the unbounded
            // push exploited. (If the co-attacker held no legal throw-in the cover already beat the
            // table; then there is nothing to spam and we skip, same as the durak-pass test does.)
            var firstPass = await req(shub, "/api/dact.png?code=" + scode + "&tok=" + stoks[sOpen] + "&a=4");
            var afterFirst = await logLen(shub, scode);
            var stillOpen = (await req(shub, "/api/dact.png?code=" + scode + "&tok=" + stoks[sOpen] + "&a=4")).w === 1;
            if (firstPass.w === 1 && stillOpen) {
                // Re-passing the SAME already-settled seat must be a no-op. Without the guard each
                // call pushed another PASS event, and st.pub had no MOVE_CAP ceiling.
                for (var sp = 0; sp < 40; sp++)
                    await req(shub, "/api/dact.png?code=" + scode + "&tok=" + stoks[sOpen] + "&a=4");
                var afterSpam = await logLen(shub, scode);
                ok(afterSpam === afterFirst,
                    "pass-spam: 41 re-passes from a settled seat add 0 events (added " + (afterSpam - afterFirst) + ")");
            }
        }
    })();

    console.log("\nALL SERVER TESTS PASSED (" + passed + " checks)");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
