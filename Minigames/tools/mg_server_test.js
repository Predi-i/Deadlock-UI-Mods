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

async function dims(res) {
    var b = new Uint8Array(await res.arrayBuffer());
    var rd = function (o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; };
    return { w: rd(16), h: rd(20) }; // IHDR width @16, height @20 (big-endian)
}
async function req(hub, pathAndQuery) {
    var res = await hub.fetch(new Request("https://mg.test" + pathAndQuery));
    return await dims(res);
}
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
    var code = d.w * 100 + (d.h - 1);
    await req(hub, "/api/join.png?code=" + code + "&tok=" + TJ);
    return { hub, code };
}

async function main() {
    var d;

    // ── calibration + private lobby round-trip with tokens ──
    var hub = new Hub({ storage: new FakeStorage() });
    d = await req(hub, "/api/probe.png");
    ok(d.w === 600 && d.h === 1000, "probe = (600,1000)");

    // ── token & game-id validation on create ──
    d = await req(hub, "/api/create.png?game=1");                  // no token
    ok(d.w === 9 && d.h === 3, "create with NO token → (9,3) bad-token");
    d = await req(hub, "/api/create.png?game=1&tok=short");        // 5 chars < 8
    ok(d.w === 9 && d.h === 3, "create with too-short token → (9,3) bad-token");
    d = await req(hub, "/api/create.png?game=6&tok=HOSTTOK01");    // unsupported id
    ok(d.w === 9 && d.h === 6, "create with unsupported game id → (9,6)");

    d = await req(hub, "/api/create.png?game=1&tok=HOSTTOK01");
    var code = d.w * 100 + (d.h - 1);
    ok(code >= 1000 && code <= 9999, "create returns a 4-digit code (" + code + ")");

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
    var end = d.w > 100 ? 1 : 0, from = (end ? d.w - 100 : d.w) - 1, to = d.h - 1;
    ok(end === 1 && from === sq(5, 0) && to === sq(4, 1), "poll round-trips the accepted move with server end=1");

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
        var pend = pd.w > 100 ? 1 : 0, pfrom = (pend ? pd.w - 100 : pd.w) - 1, pto = pd.h - 1;
        ok(pend === 1 && pfrom === 3 && pto === 7, "c4: poll round-trips the column drop with end=1");
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

    // ── public quickmatch: pairs two callers into one lobby (with tokens) ──
    var h2 = new Hub({ storage: new FakeStorage() });
    var q1 = await req(h2, "/api/quick.png?game=1&tok=QUICKQAA");
    ok(q1.w >= 100, "quick #1 becomes HOST (w>=100 role flag)");
    var c1 = (q1.w - 100) * 100 + (q1.h - 1);
    ok(c1 >= 1000 && c1 <= 9999, "host code valid (" + c1 + ")");

    var q2 = await req(h2, "/api/quick.png?game=1&tok=QUICKQBB");
    ok(q2.w < 100, "quick #2 becomes JOINER (w<100)");
    var c2 = q2.w * 100 + (q2.h - 1);
    ok(c2 === c1, "joiner is paired into the host's lobby (same code)");
    d = await req(h2, "/api/status.png?code=" + c1);
    ok(d.w === 2, "paired lobby has 2 players");

    // ── concurrency: more players form a SECOND independent lobby ──
    var q3 = await req(h2, "/api/quick.png?game=1&tok=QUICKQCC");
    ok(q3.w >= 100, "quick #3 hosts a new lobby (waiting slot was consumed)");
    var c3 = (q3.w - 100) * 100 + (q3.h - 1);
    ok(c3 !== c1, "second lobby has a different code (" + c3 + ")");
    var q4 = await req(h2, "/api/quick.png?game=1&tok=QUICKQDD");
    var c4 = q4.w * 100 + (q4.h - 1);
    ok(q4.w < 100 && c4 === c3, "quick #4 joins the second lobby");

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
    ok(g2.w >= 100, "quick for a different game hosts its own lobby (per-game queue)");

    // ── cancel: only a SEATED player (with token), and only while waiting, may cancel ──
    var h3 = new Hub({ storage: new FakeStorage() });
    var qc = await req(h3, "/api/quick.png?game=1&tok=CANCELAA");
    var cc = (qc.w - 100) * 100 + (qc.h - 1);
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
    ok(qc2.w >= 100, "after a legitimate cancel, next quick hosts fresh (slot freed)");
    d = await req(h3, "/api/status.png?code=" + cc);
    ok(d.w === 9, "cancelled lobby is gone");

    console.log("\nALL SERVER TESTS PASSED (" + passed + " checks)");
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
