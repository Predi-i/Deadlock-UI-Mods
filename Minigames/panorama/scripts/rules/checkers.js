"use strict";

/*
 * rules/checkers.js — pure Russian-draughts rules, shared by BOTH runtimes.
 *
 * SINGLE SOURCE OF TRUTH. The client loads this as a Panorama script (it hangs the
 * functions off $.MG.Rules.checkers); the Cloudflare Worker gets the exact same bytes
 * concatenated by tools/build_worker.js (it hangs them off globalThis.MGRules.checkers).
 * So the predictor on the client and the authority on the server can never disagree.
 *
 * NO DOM, NO rendering, NO network — pure functions only. The only environment thing it
 * touches is the namespace object it attaches to, resolved below for whichever runtime.
 *
 * Board: flat Array(64), index = row*8 + col. Values: 0 empty · 1 white man · 2 white
 * king · 3 black man · 4 black king. White = host, rows 5-7, moves UP, moves first.
 */

(function () {
    // Resolve the shared namespace for this runtime:
    //  - Panorama client: $ is the cross-script shared object → $.MG.Rules
    //  - Worker / Node   : no $, but globalThis exists → globalThis.MGRules
    var R;
    if (typeof $ !== "undefined" && $) {
        var MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    var WHITE = "w", BLACK = "b";

    function idx(r, c) { return r * 8 + c; }
    function rowOf(i) { return (i / 8) | 0; }
    function colOf(i) { return i % 8; }
    function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
    function isDark(r, c) { return ((r + c) & 1) === 1; }

    function colorOf(v) { return v === 1 || v === 2 ? WHITE : (v === 3 || v === 4 ? BLACK : null); }
    function isKing(v) { return v === 2 || v === 4; }
    function isEnemy(v, color) { var c = colorOf(v); return c && c !== color; }

    function initialBoard() {
        var b = new Array(64);
        for (var i = 0; i < 64; i++) b[i] = 0;
        for (var r = 0; r < 8; r++) {
            for (var c = 0; c < 8; c++) {
                if (!isDark(r, c)) continue;
                if (r <= 2) b[idx(r, c)] = 3;       // black men (top)
                else if (r >= 5) b[idx(r, c)] = 1;  // white men (bottom)
            }
        }
        return b;
    }

    // Russian draughts: men move forward only; kings slide any distance along a diagonal ("flying").
    var ALL_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    function moveDirs(v) {
        if (v === 1) return [[-1, -1], [-1, 1]]; // white man: up
        if (v === 3) return [[1, -1], [1, 1]];   // black man: down
        return ALL_DIRS;                          // king: all four
    }

    function simpleMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var r = rowOf(i), c = colOf(i), out = [];
        if (isKing(v)) {
            // Flying king: any number of empty squares along each diagonal.
            for (var k = 0; k < 4; k++) {
                var dr = ALL_DIRS[k][0], dc = ALL_DIRS[k][1];
                var nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc) && b[idx(nr, nc)] === 0) {
                    out.push({ to: idx(nr, nc) });
                    nr += dr; nc += dc;
                }
            }
            return out;
        }
        var dirs = moveDirs(v); // forward only for men
        for (var m = 0; m < dirs.length; m++) {
            var pr = r + dirs[m][0], pc = c + dirs[m][1];
            if (inBounds(pr, pc) && b[idx(pr, pc)] === 0) out.push({ to: idx(pr, pc) });
        }
        return out;
    }

    // Russian men capture in ANY diagonal direction (forward or backward), one square over.
    // A flying king slides over empties, takes exactly one enemy, and may land on
    // any empty square beyond it.
    function captureMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var color = colorOf(v), r = rowOf(i), c = colOf(i), out = [];
        if (isKing(v)) {
            for (var k = 0; k < 4; k++) {
                var dr = ALL_DIRS[k][0], dc = ALL_DIRS[k][1];
                var nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc) && b[idx(nr, nc)] === 0) { nr += dr; nc += dc; }
                if (!inBounds(nr, nc) || !isEnemy(b[idx(nr, nc)], color)) continue;
                var cap = idx(nr, nc);
                var lr = nr + dr, lc = nc + dc;
                while (inBounds(lr, lc) && b[idx(lr, lc)] === 0) {
                    out.push({ to: idx(lr, lc), cap: cap });
                    lr += dr; lc += dc;
                }
            }
            return out;
        }
        for (var k2 = 0; k2 < 4; k2++) {
            var mr = r + ALL_DIRS[k2][0], mc = c + ALL_DIRS[k2][1];         // enemy square
            var lr2 = r + 2 * ALL_DIRS[k2][0], lc2 = c + 2 * ALL_DIRS[k2][1]; // landing
            if (!inBounds(lr2, lc2) || b[idx(lr2, lc2)] !== 0) continue;
            if (isEnemy(b[idx(mr, mc)], color)) out.push({ to: idx(lr2, lc2), cap: idx(mr, mc) });
        }
        return out;
    }

    // Apply a single hop in place. Any piece on the diagonal between `from` and `to`
    // is captured — this covers both a man's 1-over jump and a flying king's ranged
    // capture without needing the captured square passed in (keeps the net protocol
    // just {from,to,end}). Returns {captured, promoted}.
    function applyHop(b, from, to) {
        var v = b[from];
        b[from] = 0;
        var fr = rowOf(from), fc = colOf(from), tr = rowOf(to), tc = colOf(to);
        var dr = tr > fr ? 1 : -1, dc = tc > fc ? 1 : -1;
        var captured = false;
        // Walk the diagonal, bounded to the board (max 7 steps). The guard is pure
        // insurance: a legal move is always diagonal so it reaches (tr,tc) within 7
        // steps — but a corrupt/desynced hop must never spin the loop forever.
        var r = fr + dr, c = fc + dc, guard = 0;
        while ((r !== tr || c !== tc) && guard++ < 8 && inBounds(r, c)) {
            var j = idx(r, c);
            if (b[j] !== 0) { b[j] = 0; captured = true; }
            r += dr; c += dc;
        }
        var promoted = false;
        if (v === 1 && tr === 0) { v = 2; promoted = true; }
        else if (v === 3 && tr === 7) { v = 4; promoted = true; }
        b[to] = v;
        return { captured: captured, promoted: promoted };
    }

    // English draughts: men move and jump forward only. Kings move/jump exactly one
    // square at a time in either direction, rather than flying across a diagonal.
    function englishSimpleMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var r = rowOf(i), c = colOf(i), dirs = isKing(v) ? ALL_DIRS : moveDirs(v), out = [];
        for (var k = 0; k < dirs.length; k++) {
            var nr = r + dirs[k][0], nc = c + dirs[k][1];
            if (inBounds(nr, nc) && b[idx(nr, nc)] === 0) out.push({ to: idx(nr, nc) });
        }
        return out;
    }

    function englishCaptureMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var color = colorOf(v), r = rowOf(i), c = colOf(i);
        var dirs = isKing(v) ? ALL_DIRS : moveDirs(v), out = [];
        for (var k = 0; k < dirs.length; k++) {
            var mr = r + dirs[k][0], mc = c + dirs[k][1];
            var lr = r + 2 * dirs[k][0], lc = c + 2 * dirs[k][1];
            if (!inBounds(lr, lc) || b[idx(lr, lc)] !== 0) continue;
            if (isEnemy(b[idx(mr, mc)], color)) out.push({ to: idx(lr, lc), cap: idx(mr, mc) });
        }
        return out;
    }

    // Both variants share board encoding, promotion and the bot driver. Only their
    // simple/capture generators differ, so keep all turn sequencing in one factory.
    function makeRules(simpleMovesFor, captureMovesFor) {
        function anyCaptureFor(b, color) {
            for (var i = 0; i < 64; i++) {
                if (colorOf(b[i]) === color && captureMovesFor(b, i).length > 0) return true;
            }
            return false;
        }

        function hasAnyMove(b, color) {
            for (var i = 0; i < 64; i++) {
                if (colorOf(b[i]) !== color) continue;
                if (simpleMovesFor(b, i).length || captureMovesFor(b, i).length) return true;
            }
            return false;
        }

        // A sequence is one complete turn. Multi-jumps are expanded so promotion ends a
        // turn in both variants before the newly crowned king can jump again.
        function captureSequencesFrom(b, i) {
            var caps = captureMovesFor(b, i);
            if (caps.length === 0) return [];
            var seqs = [];
            for (var k = 0; k < caps.length; k++) {
                var mv = caps[k];
                var nb = b.slice();
                var res = applyHop(nb, i, mv.to);
                if (!res.promoted && captureMovesFor(nb, mv.to).length > 0) {
                    var tails = captureSequencesFrom(nb, mv.to);
                    for (var t = 0; t < tails.length; t++) seqs.push([{ from: i, to: mv.to }].concat(tails[t]));
                } else {
                    seqs.push([{ from: i, to: mv.to }]);
                }
            }
            return seqs;
        }

        function legalSequences(b, color) {
            var i, k, seqs = [], hasCap = false;
            for (i = 0; i < 64; i++) {
                if (colorOf(b[i]) === color && captureMovesFor(b, i).length) { hasCap = true; break; }
            }
            if (hasCap) {
                for (i = 0; i < 64; i++) {
                    if (colorOf(b[i]) !== color) continue;
                    var cs = captureSequencesFrom(b, i);
                    for (k = 0; k < cs.length; k++) seqs.push(cs[k]);
                }
                return seqs;
            }
            for (i = 0; i < 64; i++) {
                if (colorOf(b[i]) !== color) continue;
                var sm = simpleMovesFor(b, i);
                for (k = 0; k < sm.length; k++) seqs.push([{ from: i, to: sm[k].to }]);
            }
            return seqs;
        }

        function applySequence(b, seq) {
            for (var h = 0; h < seq.length; h++) applyHop(b, seq[h].from, seq[h].to);
        }

        function evalBoard(b, me) {
            var score = 0;
            for (var i = 0; i < 64; i++) {
                var v = b[i]; if (!v) continue;
                var val = isKing(v) ? 25 : 10;
                if (v === 1) val += 7 - rowOf(i);
                else if (v === 3) val += rowOf(i);
                score += colorOf(v) === me ? val : -val;
            }
            return score;
        }

        function minimax(b, color, me, depth, alpha, beta) {
            var seqs = legalSequences(b, color);
            if (seqs.length === 0) return color === me ? -100000 + depth : 100000 - depth;
            if (depth === 0) return evalBoard(b, me);
            var opp = color === WHITE ? BLACK : WHITE, k, nb, sc;
            if (color === me) {
                var best = -1e9;
                for (k = 0; k < seqs.length; k++) {
                    nb = b.slice(); applySequence(nb, seqs[k]);
                    sc = minimax(nb, opp, me, depth - 1, alpha, beta);
                    if (sc > best) best = sc;
                    if (best > alpha) alpha = best;
                    if (alpha >= beta) break;
                }
                return best;
            }
            var worst = 1e9;
            for (k = 0; k < seqs.length; k++) {
                nb = b.slice(); applySequence(nb, seqs[k]);
                sc = minimax(nb, opp, me, depth - 1, alpha, beta);
                if (sc < worst) worst = sc;
                if (worst < beta) beta = worst;
                if (alpha >= beta) break;
            }
            return worst;
        }

        function chooseBotMove(b, color) {
            var seqs = legalSequences(b, color);
            if (seqs.length === 0) return null;
            var opp = color === WHITE ? BLACK : WHITE;
            var DEPTH = 5, best = -1e9, pick = seqs[0];
            for (var k = 0; k < seqs.length; k++) {
                var nb = b.slice(); applySequence(nb, seqs[k]);
                var sc = minimax(nb, opp, color, DEPTH - 1, -1e9, 1e9) + Math.random() * 0.5;
                if (sc > best) { best = sc; pick = seqs[k]; }
            }
            return pick;
        }

        function chooseBotMovePrep(b, color) {
            var seqs = legalSequences(b, color);
            var opp = color === WHITE ? BLACK : WHITE;
            var DEPTH = 5, i = 0, best = -1e9, pick = seqs.length ? seqs[0] : null;
            return {
                done: function () { return i >= seqs.length; },
                step: function () {
                    if (i >= seqs.length) return;
                    var nb = b.slice(); applySequence(nb, seqs[i]);
                    var sc = minimax(nb, opp, color, DEPTH - 1, -1e9, 1e9) + Math.random() * 0.5;
                    if (sc > best) { best = sc; pick = seqs[i]; }
                    i++;
                },
                result: function () { return pick; }
            };
        }

        return {
            WHITE: WHITE, BLACK: BLACK,
            idx: idx, rowOf: rowOf, colOf: colOf, isDark: isDark,
            colorOf: colorOf, isKing: isKing,
            initialBoard: initialBoard,
            simpleMoves: simpleMovesFor, captureMoves: captureMovesFor,
            anyCaptureFor: anyCaptureFor, applyHop: applyHop, hasAnyMove: hasAnyMove,
            legalSequences: legalSequences, chooseBotMove: chooseBotMove, chooseBotMovePrep: chooseBotMovePrep
        };
    }

    R.checkers = makeRules(simpleMoves, captureMoves);
    R.checkersEnglish = makeRules(englishSimpleMoves, englishCaptureMoves);
})();
