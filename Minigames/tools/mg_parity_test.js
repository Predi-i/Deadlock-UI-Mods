"use strict";
// Parity test: the client predictor and the authoritative server must agree on the
// legal-move set for every reachable position, or a public game desyncs (client thinks
// a move is legal, server rejects it — or vice-versa). Run: node tools/mg_parity_test.js
//
// Since the trust refactor BOTH sides run the SAME files: the client <include>s
// panorama/scripts/rules/*.js, and tools/build_worker.js concatenates those very bytes
// into server/worker.js. This test proves that pipeline: it loads the rules the CLIENT
// way (globalThis.MGRules from the source files) and the rules the SERVER way (sliced out
// of the GENERATED worker.js), then checks that, over many random self-played positions,
// the two engines return byte-identical legal-move sets. A mismatch means the build step
// drifted from the source — exactly the desync this whole refactor exists to prevent.

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

// ── CLIENT side: load rules/*.js the way base_hud.xml does (into globalThis.MGRules) ──
function loadClientRules() {
    var sandbox = {};                 // isolated MGRules so it can't collide with the server copy
    var g = { globalThis: sandbox };
    ["checkers.js", "ttt.js", "chess.js"].forEach(function (name) {
        var src = fs.readFileSync(path.join(root, "panorama", "scripts", "rules", name), "utf8");
        // The IIFE resolves its namespace off `globalThis`; give it our sandbox as that.
        new Function("globalThis", src)(sandbox);
    });
    return sandbox.MGRules;
}

// ── SERVER side: pull MGRules out of the GENERATED worker.js (proves the build output) ──
function loadServerRules() {
    var src = fs.readFileSync(path.join(root, "server", "worker.js"), "utf8");
    // Strip the ESM exports so it evaluates as a plain script; expose a sandbox globalThis.
    src = src.replace("export default", "const __d =").replace("export class Hub", "class Hub");
    src += "\n;return globalThis.MGRules;";
    var sandbox = {};
    return new Function("globalThis", src)(sandbox);
}

const CL = loadClientRules();
const SV = loadServerRules();

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { failures++; console.log("  ✗ " + msg); } }

// A tiny deterministic RNG so a failure is reproducible.
function makeRng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ── checkers: play random legal turns from both engines' shared move generator, and at
// each step assert the two engines enumerate the SAME legal first-hops for the mover. ──
(function () {
    var C = CL.checkers, S = SV.checkers;
    function firstHopsKey(R, b, color) {
        var seqs = R.legalSequences(b, color), set = {};
        for (var i = 0; i < seqs.length; i++) set[seqs[i][0].from + ">" + seqs[i][0].to] = 1;
        return Object.keys(set).sort().join(",");
    }
    var rng = makeRng(20260710), mismatches = 0, positions = 0;
    for (var game = 0; game < 60; game++) {
        var b = C.initialBoard(), color = C.WHITE, steps = 0;
        while (steps < 120) {
            var kc = firstHopsKey(C, b, color), ks = firstHopsKey(S, b, color);
            positions++;
            if (kc !== ks) { mismatches++; break; }
            var seqs = C.legalSequences(b, color);
            if (!seqs.length) break;
            var seq = seqs[(rng() * seqs.length) | 0];
            for (var h = 0; h < seq.length; h++) C.applyHop(b, seq[h].from, seq[h].to);
            color = color === C.WHITE ? C.BLACK : C.WHITE;
            steps++;
        }
    }
    ok(mismatches === 0, "checkers: client & server legal moves identical over " + positions + " positions");
})();

// ── tic-tac-toe: every reachable board (exhaustive) must give the same bot pick + winner ──
(function () {
    var C = CL.ttt, S = SV.ttt, mism = 0, seen = 0;
    function walk(b, mark) {
        seen++;
        var wc = C.tttWinner(b), ws = S.tttWinner(b);
        if ((wc && wc.mark) !== (ws && ws.mark)) { mism++; return; }
        if (C.tttFull(b) !== S.tttFull(b)) { mism++; return; }
        if (C.tttBotMove(b.slice(), mark) !== S.tttBotMove(b.slice(), mark)) { mism++; return; }
        if (wc || C.tttFull(b)) return;
        for (var i = 0; i < 9; i++) if (!b[i]) { var nb = b.slice(); nb[i] = mark; walk(nb, mark === 1 ? 2 : 1); }
    }
    walk([0, 0, 0, 0, 0, 0, 0, 0, 0], 1);
    ok(mism === 0, "ttt: client & server winner/full/bot identical over " + seen + " reachable states");
})();

// ── chess: random self-play; at each ply assert identical legalMoves sets ──
(function () {
    var C = CL.chess, S = SV.chess;
    function movesKey(R, b, st, color) {
        var ms = R.legalMoves(b, st, color), a = [];
        for (var i = 0; i < ms.length; i++) a.push(ms[i].from + ">" + ms[i].to);
        return a.sort().join(",");
    }
    var rng = makeRng(770077), mismatches = 0, plies = 0;
    for (var game = 0; game < 40; game++) {
        var b = C.initialChessBoard(), st = C.initialChessState(), color = 1, steps = 0;
        while (steps < 60) {
            var kc = movesKey(C, b, st, color), ks = movesKey(S, b, st, color);
            plies++;
            if (kc !== ks) { mismatches++; break; }
            var ms = C.legalMoves(b, st, color);
            if (!ms.length) break;
            var mv = ms[(rng() * ms.length) | 0];
            var r = C.makeMove(b, st, mv.from, mv.to);
            b = r[0]; st = r[1]; color = -color; steps++;
        }
    }
    ok(mismatches === 0, "chess: client & server legalMoves identical over " + plies + " plies");
})();

console.log((failures === 0 ? "  ✓ " : "") + "");
console.log(failures === 0
    ? "ALL PARITY CHECKS PASSED (" + checks + " checks) — client predictor == server authority"
    : "\n" + failures + " PARITY FAILURE(S) — client and server rules have DRIFTED (rebuild worker.js?)");
process.exit(failures === 0 ? 0 : 1);
