"use strict";

/*
 * rules/connectfour.js - pure Connect Four rules, shared by client predictor + server
 * authority (same shared-namespace mechanism as rules/checkers.js / rules/ttt.js).
 *
 * Board is a flat length-42 array, index = row*7 + col. row 0 = TOP, row 5 = BOTTOM;
 * col 0 = LEFT. Values: 0 empty, 1 = host (red, seat 0, moves first), 2 = joiner (yellow).
 * A move is a COLUMN 0..6; gravity drops the disc to the lowest empty row of that column,
 * so only the column travels the wire (the landing row is derived - same "derive, don't
 * transmit" idiom as checkers applyHop / chess makeMove).
 */

(function () {
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const COLS = 7, ROWS = 6, CELLS = COLS * ROWS;

    function idx(r, c) { return r * COLS + c; }
    function initialBoard() { const b = new Array(CELLS); for (let i = 0; i < CELLS; i++) b[i] = 0; return b; }

    // Columns whose TOP cell is empty (i.e. not full).
    function legalCols(b) {
        const out = [];
        for (let c = 0; c < COLS; c++) if (b[idx(0, c)] === 0) out.push(c);
        return out;
    }
    // Lowest empty row of a column (where a dropped disc lands), or -1 if the column is full.
    function dropRow(b, col) {
        if (col < 0 || col >= COLS) return -1;
        for (let r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === 0) return r;
        return -1;
    }
    // Drop a disc for `player` into `col`. Returns { board, row } with a NEW board (the caller
    // decides whether to keep it), or null if the column is full. Board is copied so callers
    // can use it as a predictor without clobbering their own state.
    function drop(b, col, player) {
        let r = dropRow(b, col);
        if (r < 0) return null;
        const nb = b.slice();
        nb[idx(r, col)] = player;
        return { board: nb, row: r };
    }

    // First player with four-in-a-row (horizontal, vertical, both diagonals), or 0.
    const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
    function winner(b) {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const v = b[idx(r, c)];
                if (!v) continue;
                for (let d = 0; d < DIRS.length; d++) {
                    const dr = DIRS[d][0], dc = DIRS[d][1];
                    let rr = r + dr * 3, cc = c + dc * 3;
                    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                    if (b[idx(r + dr, c + dc)] === v && b[idx(r + dr * 2, c + dc * 2)] === v &&
                        b[idx(rr, cc)] === v) return v;
                }
            }
        }
        return 0;
    }
    function isFull(b) { for (let i = 0; i < CELLS; i++) if (b[i] === 0) return false; return true; }
    function isDraw(b) { return !winner(b) && isFull(b); }

    // The four-cell winning line for `player` (row-major cell indices), or null. UI-only -
    // lets the controller highlight the winning discs.
    function winningLine(b, player) {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (b[idx(r, c)] !== player) continue;
                for (let d = 0; d < DIRS.length; d++) {
                    const dr = DIRS[d][0], dc = DIRS[d][1];
                    let rr = r + dr * 3, cc = c + dc * 3;
                    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                    if (b[idx(r + dr, c + dc)] === player && b[idx(r + dr * 2, c + dc * 2)] === player &&
                        b[idx(rr, cc)] === player)
                        return [idx(r, c), idx(r + dr, c + dc), idx(r + dr * 2, c + dc * 2), idx(rr, cc)];
                }
            }
        }
        return null;
    }

    // ── bot ──────────────────────────────────────────────────────────────────────
    // Negamax + alpha-beta with a light positional eval. Centre columns are searched first
    // (better pruning) and weighted in the eval (classic Connect Four heuristic).
    //
    // PERF (2026-07-20 - the maintainer's "дикие лаги"): the search runs SYNCHRONOUSLY on
    // Panorama's UI thread, and the old code allocated a fresh 42-element board (drop()'s
    // b.slice()) at EVERY node - tens of thousands of arrays per move, GC-thrashing Panorama's
    // slow interpreter into a multi-second freeze. Now the search does MAKE/UNDO on ONE working
    // board (write a cell, recurse, write it back to 0): zero allocation in the hot loop. The
    // public drop() still copies (its callers rely on that); only the internal search mutates,
    // and it always restores, so cfBotMove leaves the caller's board untouched. DEPTH trimmed
    // 6 → 5 for extra headroom (the win/block shortcuts below keep it tactically sharp).
    const CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6];
    const DEPTH = 5;

    // Count windows of 4 and score them: a window with only my discs is good, only theirs bad.
    function evalBoard(b, me) {
        let opp = me === 1 ? 2 : 1, score = 0, r, c, d;
        // centre column preference
        for (r = 0; r < ROWS; r++) if (b[idx(r, 3)] === me) score += 3;
        for (r = 0; r < ROWS; r++) {
            for (c = 0; c < COLS; c++) {
                for (d = 0; d < DIRS.length; d++) {
                    const dr = DIRS[d][0], dc = DIRS[d][1];
                    let rr = r + dr * 3, cc = c + dc * 3;
                    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                    let mine = 0, theirs = 0, k;
                    for (k = 0; k < 4; k++) {
                        const v = b[idx(r + dr * k, c + dc * k)];
                        if (v === me) mine++; else if (v === opp) theirs++;
                    }
                    if (mine && theirs) continue;          // mixed window is dead
                    if (mine === 3) score += 50; else if (mine === 2) score += 10; else if (mine === 1) score += 1;
                    if (theirs === 3) score -= 80; else if (theirs === 2) score -= 12; else if (theirs === 1) score -= 1;
                }
            }
        }
        return score;
    }

    // Did the disc JUST placed at (r,c) complete a four-in-a-row? Only scans the four lines
    // THROUGH that cell (O(1)) instead of the whole board - the make/undo search's per-node
    // terminal test. `v` is the mover's colour at (r,c).
    function winsAt(b, r, c, v) {
        for (let d = 0; d < DIRS.length; d++) {
            let dr = DIRS[d][0], dc = DIRS[d][1], run = 1, k, rr, cc;
            for (k = 1; k < 4; k++) {                      // extend one way
                rr = r + dr * k; cc = c + dc * k;
                if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || b[idx(rr, cc)] !== v) break;
                run++;
            }
            for (k = 1; k < 4; k++) {                      // …and the other
                rr = r - dr * k; cc = c - dc * k;
                if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || b[idx(rr, cc)] !== v) break;
                run++;
            }
            if (run >= 4) return true;
        }
        return false;
    }
    // Lowest empty row of `col` on the CURRENT (mutated) board - search's make step. -1 if full.
    function landRow(b, col) { for (let r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === 0) return r; return -1; }

    // Negamax on ONE working board via make/undo (no per-node allocation - see the PERF note).
    // `lastWin` = the mover of the PARENT node just won by landing at (lastR,lastC); we detect the
    // terminal at the child so we never need a full-board winner() scan inside the loop.
    //
    // NEGAMAX INVARIANT: every value this returns is from the point of view of `player` (the side
    // to move AT THIS NODE), because the caller negates it. Scoring relative to a fixed root
    // colour instead made the sign flip with parity - the bot maximised the OPPONENT on even
    // plies and lost 0:40 head-to-head against this corrected version.
    function negamax(b, player, depth, alpha, beta, lastR, lastC, lastV) {
        // The parent's move ended the game. lastV is the parent's mover, never `player`, so this
        // node's side to move has already lost. Deeper wins score lower (prefer the fast mate).
        if (lastR >= 0 && winsAt(b, lastR, lastC, lastV))
            return -(100000 + depth);
        if (depth === 0) return evalBoard(b, player);
        let best = -1e9, moved = false;
        for (let i = 0; i < CENTER_ORDER.length; i++) {
            let col = CENTER_ORDER[i];
            let r = landRow(b, col);
            if (r < 0) continue;                           // full
            moved = true;
            const cell = idx(r, col);
            b[cell] = player;                              // make
            const val = -negamax(b, player === 1 ? 2 : 1, depth - 1, -beta, -alpha, r, col, player);
            b[cell] = 0;                                   // undo
            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) break;                      // prune
        }
        if (!moved) return 0;                              // board full → draw
        return best;
    }

    // Returns the column the bot plays, or -1 if the board is full.
    function cfBotMove(b, player) {
        const cols = legalCols(b);
        if (cols.length === 0) return -1;
        let opp = player === 1 ? 2 : 1, i, col, r;
        // Work on a private copy so the search's make/undo can never touch the caller's board
        // (make/undo always restores, but a copy makes that guarantee unconditional).
        const w = b.slice();
        // 1) take an immediate win
        for (i = 0; i < cols.length; i++) { col = cols[i]; r = landRow(w, col); w[idx(r, col)] = player; if (winsAt(w, r, col, player)) { w[idx(r, col)] = 0; return col; } w[idx(r, col)] = 0; }
        // 2) block the opponent's immediate win
        for (i = 0; i < cols.length; i++) { col = cols[i]; r = landRow(w, col); w[idx(r, col)] = opp; if (winsAt(w, r, col, opp)) { w[idx(r, col)] = 0; return col; } w[idx(r, col)] = 0; }
        // 3) search
        let bestCol = cols[0], bestVal = -1e9;
        for (i = 0; i < CENTER_ORDER.length; i++) {
            col = CENTER_ORDER[i];
            r = landRow(w, col);
            if (r < 0) continue;
            const cell = idx(r, col);
            w[cell] = player;                              // make
            const val = -negamax(w, opp, DEPTH - 1, -1e9, 1e9, r, col, player);
            w[cell] = 0;                                   // undo
            if (val > bestVal) { bestVal = val; bestCol = col; }
        }
        return bestCol;
    }

    R.connectfour = {
        COLS: COLS, ROWS: ROWS, CELLS: CELLS,
        idx: idx, initialBoard: initialBoard, legalCols: legalCols, dropRow: dropRow,
        drop: drop, winner: winner, isFull: isFull, isDraw: isDraw, winningLine: winningLine,
        cfBotMove: cfBotMove
    };
})();
