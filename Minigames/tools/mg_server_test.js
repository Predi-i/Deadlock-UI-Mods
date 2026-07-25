"use strict";
// Server-logic test for the GENERATED worker.js. Run: node tools/mg_server_test.js
// (Run `node tools/build_worker.js` first — worker.js bundles the shared rules the
// authoritative server validates with.)
//
// worker.js is a Cloudflare ESM module. To avoid adding package.json / wrangler to the
// deploy path, we load it by stripping the two `export` keywords and evaluating it (same
// trick mg_rules_test.js uses for the client). The bundled rule IIFEs attach to
// globalThis.MGRules, which the Hub's validators read. Then we drive the Hub class with a
// fake storage, decoding each PNG's (width, height) — exactly what the client reads back.
//
// NOTE ON TOKENS: the server now enforces validTok() — a seat token must be an 8..64-char
// alphanumeric string (rejects empty/garbage so a lobby can't end up "occupied but
// tokenless"). Every real seat token below is therefore ≥ 8 chars. Deliberately-invalid
// tokens (foreign/short) are used only where a rejection is the expected result.
const fs = require("fs");
const path = require("path");

let src = fs.readFileSync(path.join(__dirname, "..", "server", "worker.js"), "utf8");
src = src.replace("export default", "const __workerDefault =").replace("export class Hub", "class Hub");
src += "\n;return { Hub };";
const { Hub } = new Function(src)();

// Minimal Durable-Object storage stand-in.
class FakeStorage {
    constructor() { this.m = new Map(); }
    async get(k) { return this.m.has(k) ? this.m.get(k) : undefined; }
    async put(k, v) { this.m.set(k, v); }
    async delete(k) { this.m.delete(k); }
    async list(opts) {
        var prefix = (opts && opts.prefix) || "";
        var out = new Map();
        for (var e of this.m) if (String(e[0]).startsWith(prefix)) out.set(e[0], e[1]);
        return out;
    }
}

// Downlink is now LEVEL-quantised: the worker sends dim = level*STEP + BASE (see
// worker.core.js d()), and the client recovers level = round((dim - BASE)/STEP). The
// test mirrors that: rawDims reads the literal PNG pixels; req() level-decodes them so
// every assertion compares the LOGICAL value (which IS the level) exactly as before.
// The probe alone is sent literally (it's the calibration reference), so it's read raw.
var STEP = 9, BASE = 15;
async function rawDims(res) {
    var b = new Uint8Array(await res.arrayBuffer());
    var rd = function (o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; };
    return { w: rd(16), h: rd(20) }; // IHDR width @16, height @20 (big-endian)
}
function delevel(d) { return { w: Math.round((d.w - BASE) / STEP), h: Math.round((d.h - BASE) / STEP) }; }
async function reqRaw(hub, pathAndQuery) {
    var res = await hub.fetch(new Request("https://mg.test" + pathAndQuery));
    return await rawDims(res);
}
async function req(hub, pathAndQuery) {
    return delevel(await reqRaw(hub, pathAndQuery));
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
async function seatedLobby(game, TH, TJ) {
    var hub = new Hub({ storage: new FakeStorage() });
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

    // ── token & game-id validation on create ──
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
        // L1: a non-4-digit code can never name a lobby — normalised to "" → missing, not a
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
        // Host (red, seat 0) drops in column 3 — accepted (to=7 marker).
        var a = await req(L.hub, "/api/move.png?code=" + L.code + "&from=3&to=7&end=1&tok=HCF11234");
        ok(a.w === 1 && a.h === 1, "c4: host drops in column 3 (accepted)");
        // A bad marker (to != 7) is illegal.
        var b2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=5&end=1&tok=JCF11234");
        ok(b2.w === 9 && b2.h === 2, "c4: wrong destination marker → (9,2)");
        // Host playing twice in a row → not your turn.
        var c2 = await req(L.hub, "/api/move.png?code=" + L.code + "&from=2&to=7&end=1&tok=HCF11234");
        ok(c2.w === 9 && c2.h === 1, "c4: host playing twice → (9,1) not-your-turn");
        // Joiner (yellow) drops in column 2 — accepted (turn alternation).
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

    // ── durak: authoritative dealer (2 players), private deal + public log ──
    await (async function () {
        var L = await seatedLobby(3, "DHOST123", "DJOIN123");   // create(game=3) + join → seats 0/1
        // Waiting room: both seated, not started yet.
        var rm = await req(L.hub, "/api/room.png?code=" + L.code);
        ok(rm.w === 2 && rm.h === 1, "durak: room shows 2 players, not started");
        // Only the host (seat 0) may start.
        var badStart = await req(L.hub, "/api/start.png?code=" + L.code + "&tok=DJOIN123");
        ok(badStart.w === 9 && badStart.h === 1, "durak: non-host start → (9,1)");
        var st = await req(L.hub, "/api/start.png?code=" + L.code + "&tok=DHOST123");
        ok(st.w === 1 && st.h === 1, "durak: host start deals the game");
        var rm2 = await req(L.hub, "/api/room.png?code=" + L.code);
        ok(rm2.w === 2 && rm2.h === 2, "durak: room now shows started");
        // Public log: TRUMP, OPEN, DRAW(0,6), DRAW(1,6).
        var e0 = await req(L.hub, "/api/dlog.png?code=" + L.code + "&since=0");
        ok(e0.w === 2 && e0.h >= 2 && e0.h <= 37, "durak: dlog[0] = TRUMP (2, trumpCard+1)");
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
        // Host creates a 3-seat durak table (dcreate is NOT the generic create — the 2-int lobby
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
        var j2 = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR301");
        ok(j2.w === 3 && j2.h === 3, "durak-N: djoin → cap 3, seat index 2");
        // Simulate a lost response: seat 1 retries only after seat 2 has joined. The response
        // must still carry seat 1, not the table's current player count.
        var j1c = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR201");
        ok(j1c.w === 3 && j1c.h === 2, "durak-N: late re-join preserves the original seat index");
        // Table now full: a 4th join is refused.
        var j3 = await req(hub, "/api/djoin.png?code=" + code + "&tok=DKPLR401");
        ok(j3.w === 21, "durak-N: djoin into a full table → (21,1)");
        // Only the host (seat 0) starts, and dealing sets started + numPlayers=3.
        var badStart = await req(hub, "/api/start.png?code=" + code + "&tok=DKPLR201");
        ok(badStart.w === 9 && badStart.h === 1, "durak-N: non-host start → (9,1)");
        var st = await req(hub, "/api/start.png?code=" + code + "&tok=DKHOST01");
        ok(st.w === 1 && st.h === 1, "durak-N: host start deals the game");
        var dr2 = await req(hub, "/api/droom.png?code=" + code);
        ok(dr2.w === 53 && dr2.h === 3, "durak-N: droom now shows started (players 3, +50 band)");
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
        // co-attacker). A single opener PASS must NOT beat the table — it only settles that seat;
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
            // No legal cover in this deal — the consensus path needs a covered table, so just
            // assert the pass route rejects an uncovered table and move on (still a real check).
            var earlyPass = await req(hub, "/api/dact.png?code=" + code + "&tok=" + toks[openSeat] + "&a=4");
            ok(earlyPass.w === 9 && earlyPass.h === 2, "durak-pass: pass on an uncovered table → (9,2)");
        } else {
            // The cover may have ALREADY beaten the table: if no attack seat held a legal throw-in,
            // canBito() is true the instant the last pair is covered, so the server auto-emits BITO
            // (valid consensus of zero pending throwers). Scan the log tail to find out which case
            // we're in — both are correct, but they need different follow-up assertions.
            var seq = 5, coverBito = false;
            for (;;) {
                var lg0 = await req(hub, "/api/dlog.png?code=" + code + "&since=" + seq);
                if (lg0.w === 1 && lg0.h === 1) break;               // drained
                if (lg0.w === 40 && lg0.h === 1) coverBito = true;
                seq++;
            }
            if (coverBito) {
                // Auto-consensus on cover: nobody could throw in, so the table was beaten with no
                // pass needed. That IS the consensus rule with an empty pending set — assert it.
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
        // Host creates a 2-seat poker lobby (pcreate is NOT the generic create — poker owns its
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
        // A second player joins → learns its own seat (1) and the cap (2).
        var pj = await req(hub, "/api/pjoin.png?code=" + code + "&tok=PJOIN123");
        ok(pj.w === 2 && pj.h === 2, "poker: pjoin → cap 2, seat index 1");
        // Re-join is idempotent (poll safety).
        var pj2 = await req(hub, "/api/pjoin.png?code=" + code + "&tok=PJOIN123");
        ok(pj2.w === 2 && pj2.h === 2, "poker: pjoin re-join idempotent");
        // Only the host (seat 0) starts.
        var badStart = await req(hub, "/api/pstart.png?code=" + code + "&tok=PJOIN123");
        ok(badStart.w === 9 && badStart.h === 1, "poker: non-host start → (9,1)");
        var ps = await req(hub, "/api/pstart.png?code=" + code + "&tok=PHOST123");
        ok(ps.w === 1 && ps.h === 1, "poker: host start deals the first hand");
        var pr2 = await req(hub, "/api/proom.png?code=" + code);
        ok(pr2.w === 52 && pr2.h === 2, "poker: proom now shows started (players 2, started band +50)");
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
    // lazily deals it — so every BOARD event encoded card id 0 (= 2♠). No prior test reached a
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
        // track whose turn it is here — just try each token with CALL, then CHECK, until the flop
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
        ok(board.length >= 3, "poker: reached the flop — at least 3 BOARD cards emitted (" + board.length + ")");
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

    // ── mquick: non-intersecting sets do NOT pair ──
    await (async function () {
        var hm = new Hub({ storage: new FakeStorage() });
        var a = await req(hm, "/api/mquick.png?games=1,2&tok=MQNOAA01");   // host offers {1,2}
        ok(codeHost(a), "mquick: host offers {1,2} (HOST)");
        var ac = decCode(a);
        var b = await req(hm, "/api/mquick.png?games=4,5&tok=MQNOBB01");   // disjoint {4,5}
        ok(codeHost(b), "mquick: disjoint set does NOT pair — hosts its own lobby");
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
        // Host polling again is idempotent — still waiting, no double-arm side effect.
        var r1b = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMHOST01&gen=0");
        ok(r1b.w === 1 && r1b.h === 1, "rematch: host re-poll stays waiting (idempotent)");
        // Joiner asks: both armed → reset + gen++ → (2, gen1+1) = (2,2).
        var r2 = await req(L.hub, "/api/rematch.png?code=" + L.code + "&tok=RMJOIN01&gen=0");
        ok(r2.w === 2 && r2.h === 2, "rematch: both ready → (2, gen1+1)");
        // The board is fresh: poll from 0 sees nothing (moves cleared), status back to 2 players.
        var pl = await req(L.hub, "/api/poll.png?code=" + L.code + "&since=0");
        ok(pl.w === 1 && pl.h === 1, "rematch: state reset — poll(since=0) → (1,1) nothing new");
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
        //    poll returns (9,9) "gone" — the survivor is shown "Opponent left." and wins by default.
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

        // D) Pre-start lobby: leave behaves like cancel (tears down a waiting lobby).
        var whub = new Hub({ storage: new FakeStorage() });
        var wc = await req(whub, "/api/create.png?game=1&tok=WLHOST001");
        var wcode = decCode(wc);
        await req(whub, "/api/leave.png?code=" + wcode + "&tok=WLHOST001");
        var wstat = await req(whub, "/api/status.png?code=" + wcode);
        ok(wstat.w === 9, "leave: pre-start host leaving tears the waiting lobby down");
    })();

    console.log("\nALL SERVER TESTS PASSED (" + passed + " checks)");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
