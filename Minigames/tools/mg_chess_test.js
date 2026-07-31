"use strict";
// Ad-hoc rules test for the shared chess engine. Run: node tools/mg_chess_test.js
// Since the trust refactor the engine lives in panorama/scripts/rules/chess.js - the exact
// same file the authoritative server runs. Loading it in Node (no `$`) attaches it to
// globalThis.MGRules.chess, which we read here.
// Exercises: perft node counts + castling / en-passant / promotion / mate / stalemate.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "panorama", "scripts", "rules", "chess.js"), "utf8");
new Function(src)(); // populates globalThis.MGRules.chess
const M = globalThis.MGRules.chess;


let failures = 0;
function ok(cond, msg) { if (!cond) { failures++; console.log("  ✗ " + msg); } else { console.log("  ✓ " + msg); } }
const WHITE = 1, BLACK = -1;
function empty() { const b = new Array(64); for (let i = 0; i < 64; i++) b[i] = 0; return b; }
function hasMove(list, from, to) { return list.some(m => m.from === from && m.to === to); }

// ── perft: node counts from the initial position (well-known reference values) ──
function perft(b, st, color, depth) {
    const moves = M.legalMoves(b, st, color);
    if (depth === 1) return moves.length;
    let n = 0;
    for (let i = 0; i < moves.length; i++) {
        const r = M.makeMove(b, st, moves[i].from, moves[i].to);
        n += perft(r[0], r[1], -color, depth - 1);
    }
    return n;
}
(() => {
    const b = M.initialChessBoard(), st = M.initialChessState();
    ok(perft(b, st, WHITE, 1) === 20, "perft(1) == 20");
    ok(perft(b, st, WHITE, 2) === 400, "perft(2) == 400");
    ok(perft(b, st, WHITE, 3) === 8902, "perft(3) == 8902");
})();

// ── castling: both sides available on a clear back rank ──
(() => {
    const b = empty();
    b[M.cSq(7, 4)] = 6; b[M.cSq(7, 0)] = 4; b[M.cSq(7, 7)] = 4;   // white K + both rooks
    b[M.cSq(0, 4)] = -6;                                          // lone black king
    const st = M.initialChessState();
    const mv = M.legalMoves(b, st, WHITE);
    ok(hasMove(mv, M.cSq(7, 4), M.cSq(7, 6)), "kingside castle O-O generated");
    ok(hasMove(mv, M.cSq(7, 4), M.cSq(7, 2)), "queenside castle O-O-O generated");
})();

// ── castling blocked THROUGH check (rook rakes the f-file) ──
(() => {
    const b = empty();
    b[M.cSq(7, 4)] = 6; b[M.cSq(7, 0)] = 4; b[M.cSq(7, 7)] = 4;
    b[M.cSq(0, 4)] = -6;
    b[M.cSq(0, 5)] = -4;                                         // black rook on the open f-file → hits f1
    const st = M.initialChessState();
    const mv = M.legalMoves(b, st, WHITE);
    ok(!hasMove(mv, M.cSq(7, 4), M.cSq(7, 6)), "O-O forbidden: king would pass through attacked f1");
    ok(hasMove(mv, M.cSq(7, 4), M.cSq(7, 2)), "O-O-O still legal (c1/d1 unattacked)");
})();

// ── en passant: capture the just-double-pushed pawn ──
(() => {
    const b = empty();
    b[M.cSq(3, 4)] = 1;    // white pawn poised on the 5th rank
    b[M.cSq(1, 3)] = -1;   // black pawn on its start square
    b[M.cSq(7, 4)] = 6; b[M.cSq(0, 4)] = -6;
    let st = M.initialChessState();
    const dbl = M.makeMove(b, st, M.cSq(1, 3), M.cSq(3, 3));     // black double push d7-d5
    const nb = dbl[0], nst = dbl[1];
    ok(nst.ep === M.cSq(2, 3), "double push sets the en-passant target");
    const mv = M.legalMoves(nb, nst, WHITE);
    ok(hasMove(mv, M.cSq(3, 4), M.cSq(2, 3)), "en-passant capture generated");
    const cap = M.makeMove(nb, nst, M.cSq(3, 4), M.cSq(2, 3));
    ok(cap[0][M.cSq(3, 3)] === 0, "en-passant removes the passed pawn");
    ok(cap[0][M.cSq(2, 3)] === 1, "en-passant lands the capturing pawn");
})();

// ── promotion: a pawn reaching the last rank becomes a queen ──
(() => {
    const b = empty();
    b[M.cSq(1, 0)] = 1;                          // white pawn one step from promotion
    b[M.cSq(7, 4)] = 6; b[M.cSq(0, 7)] = -6;
    const r = M.makeMove(b, M.initialChessState(), M.cSq(1, 0), M.cSq(0, 0));
    ok(r[0][M.cSq(0, 0)] === 5, "pawn auto-promotes to a queen");
})();

// ── checkmate: fool's mate (1.f3 e5 2.g4 Qh4#) ──
(() => {
    let b = M.initialChessBoard(), st = M.initialChessState();
    function mv(f, t) { const r = M.makeMove(b, st, f, t); b = r[0]; st = r[1]; }
    mv(M.cSq(6, 5), M.cSq(5, 5));   // 1. f3
    mv(M.cSq(1, 4), M.cSq(3, 4));   // 1... e5
    mv(M.cSq(6, 6), M.cSq(4, 6));   // 2. g4
    mv(M.cSq(0, 3), M.cSq(4, 7));   // 2... Qh4#
    ok(M.inCheck(b, WHITE), "fool's mate: white king is in check");
    ok(M.chessResult(b, st, WHITE) === "checkmate", "fool's mate is detected as checkmate");
})();

// ── stalemate: Kf7 + Qg6 vs lone Kh8, black to move ──
(() => {
    const b = empty();
    b[M.cSq(0, 7)] = -6;   // black king h8
    b[M.cSq(1, 5)] = 6;    // white king f7
    b[M.cSq(2, 6)] = 5;    // white queen g6
    const st = M.initialChessState();
    ok(!M.inCheck(b, BLACK), "stalemate position: black is NOT in check");
    ok(M.chessResult(b, st, BLACK) === "stalemate", "no legal move + not in check == stalemate");
})();

// ── bot returns a legal move from the opening position ──
(() => {
    const b = M.initialChessBoard(), st = M.initialChessState();
    const legal = M.legalMoves(b, st, WHITE);
    const pick = M.chessBotMove(b, st, WHITE);
    ok(pick && hasMove(legal, pick.from, pick.to), "chessBotMove returns a legal move");
})();

console.log(failures === 0 ? "\nAll chess tests passed." : "\n" + failures + " chess test(s) FAILED.");
process.exitCode = failures === 0 ? 0 : 1;
