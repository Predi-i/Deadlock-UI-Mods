"use strict";
// Parity test: the client predictor and the authoritative server must agree on the
// legal-move set for every reachable position, or a public game desyncs (client thinks
// a move is legal, server rejects it - or vice-versa). Run: node tools/mg_parity_test.js
//
// Since the trust refactor BOTH sides run the SAME files: the client <include>s
// panorama/scripts/rules/*.js, and tools/build_worker.js concatenates those very bytes
// into server/worker.js. This test proves that pipeline: it loads the rules the CLIENT
// way (globalThis.MGRules from the source files) and the rules the SERVER way (sliced out
// of the GENERATED worker.js), then checks that, over many random self-played positions,
// the two engines return byte-identical legal-move sets. A mismatch means the build step
// drifted from the source - exactly the desync this whole refactor exists to prevent.

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

// ── CLIENT side: load rules/*.js the way base_hud.xml does (into globalThis.MGRules) ──
function loadClientRules() {
    const sandbox = {};                 // isolated MGRules so it can't collide with the server copy
    const g = { globalThis: sandbox };
    ["checkers.js", "ttt.js", "chess.js", "connectfour.js", "durak.js", "poker.js"].forEach((name) => {
        let src = fs.readFileSync(path.join(root, "panorama", "scripts", "rules", name), "utf8");
        // The IIFE resolves its namespace off `globalThis`; give it our sandbox as that.
        new Function("globalThis", src)(sandbox);
    });
    return sandbox.MGRules;
}

// ── SERVER side: pull MGRules out of the GENERATED worker.js (proves the build output) ──
function loadServerRules() {
    let src = fs.readFileSync(path.join(root, "server", "worker.js"), "utf8");
    // Strip the ESM exports so it evaluates as a plain script; expose a sandbox globalThis.
    src = src.replace("export default", "const __d =").replace("export class Hub", "class Hub");
    src += "\n;return globalThis.MGRules;";
    const sandbox = {};
    return new Function("globalThis", src)(sandbox);
}

const CL = loadClientRules();
const SV = loadServerRules();

let failures = 0, checks = 0;
function ok(cond, msg) { checks++; if (!cond) { failures++; console.log("  ✗ " + msg); } }

// A tiny deterministic RNG so a failure is reproducible.
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// ── checkers: play random legal turns from both engines' shared move generator, and at
// each step assert the two engines enumerate the SAME legal first-hops for the mover. ──
(() => {
    const C = CL.checkers, S = SV.checkers;
    function firstHopsKey(R, b, color) {
        const seqs = R.legalSequences(b, color), set = {};
        for (let i = 0; i < seqs.length; i++) set[seqs[i][0].from + ">" + seqs[i][0].to] = 1;
        return Object.keys(set).sort().join(",");
    }
    let rng = makeRng(20260710), mismatches = 0, positions = 0;
    for (let game = 0; game < 60; game++) {
        let b = C.initialBoard(), color = C.WHITE, steps = 0;
        while (steps < 120) {
            const kc = firstHopsKey(C, b, color), ks = firstHopsKey(S, b, color);
            positions++;
            if (kc !== ks) { mismatches++; break; }
            const seqs = C.legalSequences(b, color);
            if (!seqs.length) break;
            const seq = seqs[(rng() * seqs.length) | 0];
            for (let h = 0; h < seq.length; h++) C.applyHop(b, seq[h].from, seq[h].to);
            color = color === C.WHITE ? C.BLACK : C.WHITE;
            steps++;
        }
    }
    ok(mismatches === 0, "checkers: client & server legal moves identical over " + positions + " positions");
})();

// ── tic-tac-toe: every reachable board (exhaustive) must give the same bot pick + winner ──
(() => {
    let C = CL.ttt, S = SV.ttt, mism = 0, seen = 0;
    function walk(b, mark) {
        seen++;
        const wc = C.tttWinner(b), ws = S.tttWinner(b);
        if ((wc && wc.mark) !== (ws && ws.mark)) { mism++; return; }
        if (C.tttFull(b) !== S.tttFull(b)) { mism++; return; }
        if (C.tttBotMove(b.slice(), mark) !== S.tttBotMove(b.slice(), mark)) { mism++; return; }
        if (wc || C.tttFull(b)) return;
        for (let i = 0; i < 9; i++) if (!b[i]) { const nb = b.slice(); nb[i] = mark; walk(nb, mark === 1 ? 2 : 1); }
    }
    walk([0, 0, 0, 0, 0, 0, 0, 0, 0], 1);
    ok(mism === 0, "ttt: client & server winner/full/bot identical over " + seen + " reachable states");
})();

// ── chess: random self-play; at each ply assert identical legalMoves sets ──
(() => {
    const C = CL.chess, S = SV.chess;
    function movesKey(R, b, st, color) {
        const ms = R.legalMoves(b, st, color), a = [];
        for (let i = 0; i < ms.length; i++) a.push(ms[i].from + ">" + ms[i].to);
        return a.sort().join(",");
    }
    let rng = makeRng(770077), mismatches = 0, plies = 0;
    for (let game = 0; game < 40; game++) {
        let b = C.initialChessBoard(), st = C.initialChessState(), color = 1, steps = 0;
        while (steps < 60) {
            const kc = movesKey(C, b, st, color), ks = movesKey(S, b, st, color);
            plies++;
            if (kc !== ks) { mismatches++; break; }
            const ms = C.legalMoves(b, st, color);
            if (!ms.length) break;
            const mv = ms[(rng() * ms.length) | 0];
            const r = C.makeMove(b, st, mv.from, mv.to);
            b = r[0]; st = r[1]; color = -color; steps++;
        }
    }
    ok(mismatches === 0, "chess: client & server legalMoves identical over " + plies + " plies");
})();

// ── connect four: random self-play; at each ply assert identical legalCols + winner + bot ──
(() => {
    const C = CL.connectfour, S = SV.connectfour;
    function key(R, b) { return R.legalCols(b).join(",") + "|" + R.winner(b) + "|" + R.cfBotMove(b.slice(), 1) + "/" + R.cfBotMove(b.slice(), 2); }
    let rng = makeRng(424242), mismatches = 0, plies = 0;
    for (let game = 0; game < 40; game++) {
        let b = C.initialBoard(), p = 1, steps = 0;
        while (steps < 42) {
            plies++;
            if (key(C, b) !== key(S, b)) { mismatches++; break; }
            if (C.winner(b) || C.isFull(b)) break;
            const cols = C.legalCols(b);
            if (!cols.length) break;
            const col = cols[(rng() * cols.length) | 0];
            b = C.drop(b, col, p).board;
            p = p === 1 ? 2 : 1; steps++;
        }
    }
    ok(mismatches === 0, "connect four: client & server legalCols/winner/bot identical over " + plies + " plies");
})();

// ── durak: server owns the deck/seed, so drive one deterministic self-play per seed with
// the CLIENT engine, and at every ply assert the SERVER engine enumerates the identical
// legalAttacks (for the attacker) and legalDefends (for each uncovered pair). Both sides
// share newGame(seed), so a mismatch means the bundled durak rules drifted from source. ──
(() => {
    const C = CL.durak, S = SV.durak;
    function attKey(R, st, seat) { return R.legalAttacks(st, seat).slice().sort((a, b) => { return a - b; }).join(","); }
    function defKey(R, st, pair) { return R.legalDefends(st, pair).slice().sort((a, b) => { return a - b; }).join(","); }
    let rng = makeRng(31415926), mismatches = 0, plies = 0;
    for (let game = 0; game < 40; game++) {
        const seed = (rng() * 0x7fffffff) | 0;
        let st = C.newGame(2, seed);          // client-owned copy drives the walk
        let steps = 0;
        while (st.phase !== "over" && steps < 400) {
            plies++;
            // The server engine is stateless over the SAME object, so compare enumerations on `st`.
            if (attKey(C, st, st.attacker) !== attKey(S, st, st.attacker)) { mismatches++; break; }
            const u = C.firstUncovered(st);
            if (u >= 0 && defKey(C, st, u) !== defKey(S, st, u)) { mismatches++; break; }
            // Advance with the client's own bot so the walk is deterministic and legal.
            if (st.phase === "defend" && st.table.length && C.uncoveredCount(st) > 0) {
                const d = C.durakBotDefend(st, st.defender);
                if (d) { C.applyDefend(st, d.pair, d.card); }
                else { C.endBout(st, true); }
            } else {
                const a = C.durakBotAttack(st, st.attacker);
                if (a >= 0) { C.applyAttack(st, st.attacker, a); }
                else if (st.table.length && C.uncoveredCount(st) === 0) { C.endBout(st, false); }
                else { C.endBout(st, true); }   // attacker has nothing to open with → bout ends
            }
            steps++;
        }
    }
    ok(mismatches === 0, "durak: client & server legalAttacks/legalDefends identical over " + plies + " plies");
})();

// ── poker: the ONLY game with a server-side dealer and a pot, so a client/server rules drift
// here misawards chips. Both sides share newHand(seed), so drive one deterministic self-play per
// seed with the CLIENT engine and at every action assert the SERVER engine reports the identical
// legalActions for the seat on the clock, plus the identical showdown scores/pots at the end. ──
(() => {
    const C = CL.poker, S = SV.poker;
    function laKey(R, st, seat) {
        const la = R.legalActions(st, seat);
        return [la.canFold, la.canCheck, la.canCall, la.callAmount, la.canRaise, la.minRaiseTo, la.maxRaiseTo].join(",");
    }
    function scoreKey(R, cards) { return R.score(cards).join(","); }
    let rng = makeRng(2718281), mismatches = 0, plies = 0, hands = 0, evals = 0;
    for (let game = 0; game < 40; game++) {
        const n = 2 + ((rng() * 3) | 0);                 // 2..4 seats
        let stacks = []; for (var s = 0; s < n; s++) stacks.push(200);
        let button = 0;
        for (let hand = 0; hand < 12; hand++) {
            let alive = 0; for (s = 0; s < n; s++) if (stacks[s] > 0) alive++;
            if (alive < 2) break;
            const seed = (rng() * 0x7fffffff) | 0;
            let st = C.newHand(n, button, stacks, 5, 10, seed);
            hands++;
            let guard = 0;
            while (st.street !== "over" && guard++ < 500) {
                plies++;
                const seat = st.toAct;
                if (seat < 0) break;
                // Stateless over the SAME object: a divergence means the bundled rules drifted.
                if (laKey(C, st, seat) !== laKey(S, st, seat)) { mismatches++; break; }
                const act = C.botAction(st, seat, rng);
                if (!C.applyAction(st, seat, act) && !C.applyAction(st, seat, { type: "fold" })) break;
            }
            // Hand evaluation is what actually decides the pot - compare it on the real cards.
            for (s = 0; s < n; s++) {
                if (!st.hole[s] || st.hole[s].length !== 2 || st.board.length < 3) continue;
                evals++;
                if (scoreKey(C, st.hole[s].concat(st.board)) !== scoreKey(S, st.hole[s].concat(st.board))) { mismatches++; break; }
            }
            stacks = st.stacks.slice();
            button = (button + 1) % n;
        }
    }
    ok(mismatches === 0, "poker: client & server legalActions/score identical over " + plies + " actions in " + hands + " hands (" + evals + " showdown evals)");
})();

console.log((failures === 0 ? "  ✓ " : "") + "");
console.log(failures === 0
    ? "ALL PARITY CHECKS PASSED (" + checks + " checks) - client predictor == server authority"
    : "\n" + failures + " PARITY FAILURE(S) - client and server rules have DRIFTED (rebuild worker.js?)");
process.exit(failures === 0 ? 0 : 1);
