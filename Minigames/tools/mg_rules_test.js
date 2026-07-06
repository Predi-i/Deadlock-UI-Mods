"use strict";
// Ad-hoc rules test for mg_games.js (Russian draughts). Run: node tools/mg_rules_test.js
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "panorama", "scripts", "mg_games.js"), "utf8");
const start = src.indexOf("var WHITE");
const end = src.indexOf("// ── checkers controller");
if (start < 0 || end < 0) throw new Error("could not slice pure-function section");
const body = src.slice(start, end);
const factory = new Function(
    body +
    "; return { initialBoard, simpleMoves, captureMoves, applyHop, legalSequences, chooseBotMove," +
    " colorOf, isKing, idx, rowOf, colOf, anyCaptureFor, hasAnyMove, WHITE, BLACK };"
);
const M = factory();

let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }
function empty() { return new Array(64).fill(0); }

// 1) Man captures BACKWARD (white moves up, this capture goes down a row).
(function () {
    const b = empty();
    b[M.idx(3, 3)] = 1; // white man
    b[M.idx(4, 4)] = 3; // black man behind it
    const caps = M.captureMoves(b, M.idx(3, 3));
    const land = M.idx(5, 5);
    const found = caps.some(c => c.to === land && c.cap === M.idx(4, 4));
    ok(found, "white man captures backward (to " + land + ")");
})();

// 2) Flying king slides multiple squares on an empty diagonal.
(function () {
    const b = empty();
    b[M.idx(7, 0)] = 2; // white king, bottom-left corner
    const moves = M.simpleMoves(b, M.idx(7, 0)).map(m => m.to);
    ok(moves.includes(M.idx(0, 7)), "flying king reaches far corner (0,7)");
    ok(moves.length === 7, "flying king has 7 slide targets, got " + moves.length);
})();

// 3) Flying king captures at range and may land beyond the taken piece.
(function () {
    const b = empty();
    b[M.idx(7, 0)] = 2;  // white king
    b[M.idx(4, 3)] = 3;  // black man in its path
    const caps = M.captureMoves(b, M.idx(7, 0));
    const cap = M.idx(4, 3);
    ok(caps.every(c => c.cap === cap), "all captures take the single enemy at (4,3)");
    ok(caps.some(c => c.to === M.idx(3, 4)), "king can land right behind the enemy (3,4)");
    ok(caps.some(c => c.to === M.idx(0, 7)), "king can land far behind the enemy (0,7)");
})();

// 4) applyHop removes the piece on the diagonal (ranged king capture) & keeps king.
(function () {
    const b = empty();
    b[M.idx(7, 0)] = 2;
    b[M.idx(4, 3)] = 3;
    const res = M.applyHop(b, M.idx(7, 0), M.idx(0, 7));
    ok(res.captured === true, "applyHop reports captured");
    ok(b[M.idx(4, 3)] === 0, "captured enemy removed from board");
    ok(b[M.idx(7, 0)] === 0, "king left its origin");
    ok(b[M.idx(0, 7)] === 2, "king landed and stayed a king");
})();

// 5) Man promotion on a simple forward move still works.
(function () {
    const b = empty();
    b[M.idx(1, 2)] = 1; // white man one step from the back rank
    const res = M.applyHop(b, M.idx(1, 2), M.idx(0, 1));
    ok(res.promoted === true && b[M.idx(0, 1)] === 2, "white man promotes to king on reaching row 0");
})();

// 6) Full bot-vs-bot game terminates cleanly with only legal moves.
(function () {
    let b = M.initialBoard();
    let color = M.WHITE, moves = 0, allLegal = true;
    const t0 = Date.now();
    while (moves < 300) {
        const seqs = M.legalSequences(b, color);
        if (seqs.length === 0) break;
        const seq = M.chooseBotMove(b, color);
        if (!seq) break;
        // verify the chosen sequence is among the legal ones (by from/to of first hop)
        const legalFirst = seqs.some(s => s[0].from === seq[0].from && s[0].to === seq[0].to);
        if (!legalFirst) allLegal = false;
        for (const h of seq) M.applyHop(b, h.from, h.to);
        color = color === M.WHITE ? M.BLACK : M.WHITE;
        moves++;
    }
    const ms = Date.now() - t0;
    let wc = 0, bc = 0;
    for (let i = 0; i < 64; i++) { if (M.colorOf(b[i]) === M.WHITE) wc++; else if (M.colorOf(b[i]) === M.BLACK) bc++; }
    ok(allLegal, "bot only played legal moves");
    ok(moves < 300, "game terminated in " + moves + " moves (not the safety cap)");
    console.log("    (white=" + wc + " black=" + bc + " moves=" + moves + " time=" + ms + "ms)");
})();

console.log(failures === 0 ? "\nALL RULES TESTS PASSED" : "\n" + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
