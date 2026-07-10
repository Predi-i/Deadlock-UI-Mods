/* ============================================================================
 * GENERATED FILE — DO NOT EDIT BY HAND.
 * Produced by `node tools/build_worker.js` from:
 *   panorama/scripts/rules/checkers.js + ttt.js + chess.js   (shared with client)
 *   server/worker.core.js                                    (authored core)
 * Edit those sources, then rebuild. See server/README.md.
 * ============================================================================ */

/* ── shared rules (from panorama/scripts/rules/*.js; attach to globalThis.MGRules) ── */
// ---- rules/checkers.js ----
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

    // Men move forward only; kings slide any distance along a diagonal ("flying").
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

    // Men capture in ANY diagonal direction (forward or backward), one square over.
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

    function anyCaptureFor(b, color) {
        for (var i = 0; i < 64; i++) {
            if (colorOf(b[i]) === color && captureMoves(b, i).length > 0) return true;
        }
        return false;
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

    function hasAnyMove(b, color) {
        for (var i = 0; i < 64; i++) {
            if (colorOf(b[i]) !== color) continue;
            if (simpleMoves(b, i).length || captureMoves(b, i).length) return true;
        }
        return false;
    }

    // ── AI (bot mode) ────────────────────────────────────────────────────────
    // A "sequence" is a full legal turn: an array of hops [{from,to}, ...]. Multi-
    // jumps are expanded into their full chains so the bot evaluates whole turns.
    function captureSequencesFrom(b, i) {
        var caps = captureMoves(b, i);
        if (caps.length === 0) return [];
        var seqs = [];
        for (var k = 0; k < caps.length; k++) {
            var mv = caps[k];
            var nb = b.slice();
            var res = applyHop(nb, i, mv.to);
            if (!res.promoted && captureMoves(nb, mv.to).length > 0) {
                var tails = captureSequencesFrom(nb, mv.to);
                for (var t = 0; t < tails.length; t++) {
                    seqs.push([{ from: i, to: mv.to }].concat(tails[t]));
                }
            } else {
                seqs.push([{ from: i, to: mv.to }]);
            }
        }
        return seqs;
    }

    function legalSequences(b, color) {
        var i, k, seqs = [], hasCap = false;
        for (i = 0; i < 64; i++) {
            if (colorOf(b[i]) === color && captureMoves(b, i).length) { hasCap = true; break; }
        }
        if (hasCap) { // forced capture: only capture chains are legal
            for (i = 0; i < 64; i++) {
                if (colorOf(b[i]) !== color) continue;
                var cs = captureSequencesFrom(b, i);
                for (k = 0; k < cs.length; k++) seqs.push(cs[k]);
            }
            return seqs;
        }
        for (i = 0; i < 64; i++) {
            if (colorOf(b[i]) !== color) continue;
            var sm = simpleMoves(b, i);
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
            var val = isKing(v) ? 25 : 10; // flying kings are worth far more than a man
            if (v === 1) val += (7 - rowOf(i));   // white man: advance toward row 0
            else if (v === 3) val += rowOf(i);    // black man: advance toward row 7
            score += (colorOf(v) === me ? val : -val);
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
            // small random tie-break so the bot isn't perfectly repetitive
            var sc = minimax(nb, opp, color, DEPTH - 1, -1e9, 1e9) + Math.random() * 0.5;
            if (sc > best) { best = sc; pick = seqs[k]; }
        }
        return pick;
    }

    R.checkers = {
        WHITE: WHITE, BLACK: BLACK,
        idx: idx, rowOf: rowOf, colOf: colOf, isDark: isDark,
        colorOf: colorOf, isKing: isKing,
        initialBoard: initialBoard,
        simpleMoves: simpleMoves, captureMoves: captureMoves,
        anyCaptureFor: anyCaptureFor, applyHop: applyHop, hasAnyMove: hasAnyMove,
        legalSequences: legalSequences, chooseBotMove: chooseBotMove
    };
})();

// ---- rules/ttt.js ----
"use strict";

/*
 * rules/ttt.js — pure Tic-Tac-Toe rules, shared by client predictor + server authority.
 * See rules/checkers.js header for the shared-namespace mechanism.
 *
 * Board is a flat length-9 array: 0 empty, 1 = X, 2 = O. Cells index left→right,
 * top→bottom (0..8). Host plays X and moves first.
 */

(function () {
    var R;
    if (typeof $ !== "undefined" && $) {
        var MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    var TTT_LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8],   // cols
        [0, 4, 8], [2, 4, 6]               // diagonals
    ];

    // Returns { mark, line } for the first completed line, or null.
    function tttWinner(b) {
        for (var i = 0; i < TTT_LINES.length; i++) {
            var L = TTT_LINES[i], v = b[L[0]];
            if (v && v === b[L[1]] && v === b[L[2]]) return { mark: v, line: L };
        }
        return null;
    }

    function tttFull(b) {
        for (var i = 0; i < 9; i++) if (!b[i]) return false;
        return true;
    }

    // If `mark` has a one-move win available, return that cell; else -1.
    function tttFindWin(b, mark) {
        for (var i = 0; i < 9; i++) {
            if (b[i]) continue;
            b[i] = mark;
            var w = tttWinner(b);
            b[i] = 0;                      // restore — this must not mutate the board
            if (w && w.mark === mark) return i;
        }
        return -1;
    }

    // Heuristic bot: win > block > center > corner > side. Strong but not a full
    // minimax, so a sharp human can still fork it — deliberately beatable.
    function tttBotMove(b, mark) {
        var opp = mark === 1 ? 2 : 1;
        var pick = tttFindWin(b, mark); if (pick >= 0) return pick;   // 1) take the win
        pick = tttFindWin(b, opp);      if (pick >= 0) return pick;   // 2) block theirs
        if (!b[4]) return 4;                                          // 3) center
        var corners = [0, 2, 6, 8];
        for (var i = 0; i < 4; i++) if (!b[corners[i]]) return corners[i]; // 4) corner
        var sides = [1, 3, 5, 7];
        for (var j = 0; j < 4; j++) if (!b[sides[j]]) return sides[j];     // 5) side
        return -1;                                                    // board full
    }

    R.ttt = {
        TTT_LINES: TTT_LINES,
        tttWinner: tttWinner, tttFull: tttFull, tttBotMove: tttBotMove
    };
})();

// ---- rules/chess.js ----
"use strict";

/*
 * rules/chess.js — pure chess rules, shared by client predictor + server authority.
 * See rules/checkers.js header for the shared-namespace mechanism.
 *
 * Board is a flat Array(64), index = row*8 + col, row 0 = TOP (black back rank), row 7 =
 * BOTTOM (white back rank). Piece value: 0 empty; SIGN = colour (white > 0, black < 0);
 * ABS = type 1=pawn 2=knight 3=bishop 4=rook 5=queen 6=king. "Colour" here is +1 (white) /
 * -1 (black) — the sign of the piece — NOT the checkers WHITE/BLACK strings. White = host,
 * bottom rows (6-7), moves first. Promotion is ALWAYS to a queen (MVP). from/to alone
 * travels the wire: castling / en-passant / promotion are derived by makeMove.
 */

(function () {
    var R;
    if (typeof $ !== "undefined" && $) {
        var MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    var C_PAWN = 1, C_KNIGHT = 2, C_BISHOP = 3, C_ROOK = 4, C_QUEEN = 5, C_KING = 6;
    var KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    var KING_D   = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    var DIAG_D   = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    var ORTHO_D  = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    var QUEEN_D  = DIAG_D.concat(ORTHO_D);

    function cSq(r, c) { return r * 8 + c; }
    function cRow(i) { return (i / 8) | 0; }
    function cCol(i) { return i % 8; }
    function cOn(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
    function cSign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
    function cType(v) { return v < 0 ? -v : v; }

    function initialChessBoard() {
        var b = new Array(64);
        for (var i = 0; i < 64; i++) b[i] = 0;
        var back = [C_ROOK, C_KNIGHT, C_BISHOP, C_QUEEN, C_KING, C_BISHOP, C_KNIGHT, C_ROOK];
        for (var c = 0; c < 8; c++) {
            b[cSq(0, c)] = -back[c];   // black back rank (top)
            b[cSq(1, c)] = -C_PAWN;    // black pawns
            b[cSq(6, c)] = C_PAWN;     // white pawns
            b[cSq(7, c)] = back[c];    // white back rank (bottom)
        }
        return b;
    }

    // Game state that from/to alone can't carry: castling rights + en-passant target square.
    function initialChessState() { return { ep: -1, wK: true, wQ: true, bK: true, bQ: true }; }
    function cloneChessState(st) { return { ep: st.ep, wK: st.wK, wQ: st.wQ, bK: st.bK, bQ: st.bQ }; }

    function findKing(b, color) {
        var k = color > 0 ? C_KING : -C_KING;
        for (var i = 0; i < 64; i++) if (b[i] === k) return i;
        return -1;
    }

    // Is square s attacked by any piece of `byColor` (+1/-1)? Used for check + castling.
    function attacksSquare(b, s, byColor) {
        var sr = cRow(s), sc = cCol(s), i, r, c, v;
        // pawns: a byColor pawn attacking s sits one row "behind" s (row = sr + byColor).
        var pr = sr + byColor;
        if (pr >= 0 && pr < 8) {
            if (sc > 0 && b[cSq(pr, sc - 1)] === byColor * C_PAWN) return true;
            if (sc < 7 && b[cSq(pr, sc + 1)] === byColor * C_PAWN) return true;
        }
        for (i = 0; i < 8; i++) {                                  // knights
            r = sr + KNIGHT_D[i][0]; c = sc + KNIGHT_D[i][1];
            if (cOn(r, c) && b[cSq(r, c)] === byColor * C_KNIGHT) return true;
        }
        for (i = 0; i < 8; i++) {                                  // king
            r = sr + KING_D[i][0]; c = sc + KING_D[i][1];
            if (cOn(r, c) && b[cSq(r, c)] === byColor * C_KING) return true;
        }
        for (i = 0; i < 4; i++) {                                  // diagonals → bishop/queen
            r = sr + DIAG_D[i][0]; c = sc + DIAG_D[i][1];
            while (cOn(r, c)) {
                v = b[cSq(r, c)];
                if (v !== 0) { if (cSign(v) === byColor && (cType(v) === C_BISHOP || cType(v) === C_QUEEN)) return true; break; }
                r += DIAG_D[i][0]; c += DIAG_D[i][1];
            }
        }
        for (i = 0; i < 4; i++) {                                  // orthogonals → rook/queen
            r = sr + ORTHO_D[i][0]; c = sc + ORTHO_D[i][1];
            while (cOn(r, c)) {
                v = b[cSq(r, c)];
                if (v !== 0) { if (cSign(v) === byColor && (cType(v) === C_ROOK || cType(v) === C_QUEEN)) return true; break; }
                r += ORTHO_D[i][0]; c += ORTHO_D[i][1];
            }
        }
        return false;
    }

    function inCheck(b, color) {
        var k = findKing(b, color);
        return k >= 0 && attacksSquare(b, k, -color);
    }

    // Apply from→to on a COPY, deriving castling / en-passant / promotion from board+state so
    // the network receive path needs only {from,to} (same "derive, don't transmit" trick as
    // checkers applyHop). Returns [newBoard, newState]. Promotion is ALWAYS to a queen (MVP).
    function makeMove(b, st, from, to) {
        var nb = b.slice(), nst = cloneChessState(st);
        var piece = b[from], color = cSign(piece), t = cType(piece);
        var fr = cRow(from), fc = cCol(from), tr = cRow(to), tc = cCol(to);
        nst.ep = -1;
        nb[to] = piece; nb[from] = 0;
        if (t === C_PAWN) {
            if (Math.abs(tr - fr) === 2) nst.ep = cSq((fr + tr) >> 1, fc);   // double push sets ep
            else if (tc !== fc && b[to] === 0) nb[cSq(fr, tc)] = 0;          // en-passant capture
            if (tr === 0 || tr === 7) nb[to] = color * C_QUEEN;             // auto-queen promotion
        } else if (t === C_KING) {
            if (color > 0) { nst.wK = false; nst.wQ = false; } else { nst.bK = false; nst.bQ = false; }
            if (tc - fc === 2) { nb[cSq(fr, 5)] = nb[cSq(fr, 7)]; nb[cSq(fr, 7)] = 0; }        // O-O
            else if (fc - tc === 2) { nb[cSq(fr, 3)] = nb[cSq(fr, 0)]; nb[cSq(fr, 0)] = 0; }   // O-O-O
        }
        // a rook leaving OR being captured on its home corner forfeits that side's castling
        if (from === cSq(7, 0) || to === cSq(7, 0)) nst.wQ = false;
        if (from === cSq(7, 7) || to === cSq(7, 7)) nst.wK = false;
        if (from === cSq(0, 0) || to === cSq(0, 0)) nst.bQ = false;
        if (from === cSq(0, 7) || to === cSq(0, 7)) nst.bK = false;
        return [nb, nst];
    }

    // King castling candidates, appended to `moves`. Blocks castling out of / through / into
    // check and requires the squares between king and rook to be empty + the rook present.
    function addCastles(b, st, color, ksq, moves) {
        var row = color > 0 ? 7 : 0;
        if (ksq !== cSq(row, 4)) return;
        if (attacksSquare(b, ksq, -color)) return;                 // not out of check
        var kSide = color > 0 ? st.wK : st.bK;
        var qSide = color > 0 ? st.wQ : st.bQ;
        if (kSide && b[cSq(row, 5)] === 0 && b[cSq(row, 6)] === 0 && b[cSq(row, 7)] === color * C_ROOK
            && !attacksSquare(b, cSq(row, 5), -color) && !attacksSquare(b, cSq(row, 6), -color)) {
            moves.push({ from: ksq, to: cSq(row, 6) });
        }
        if (qSide && b[cSq(row, 1)] === 0 && b[cSq(row, 2)] === 0 && b[cSq(row, 3)] === 0 && b[cSq(row, 0)] === color * C_ROOK
            && !attacksSquare(b, cSq(row, 3), -color) && !attacksSquare(b, cSq(row, 2), -color)) {
            moves.push({ from: ksq, to: cSq(row, 2) });
        }
    }

    // Pseudo-legal moves for `color` (own-king-safety NOT yet filtered). Each is {from,to}.
    function pseudoMoves(b, st, color) {
        var moves = [], i, r, c, v, t, d, nr, nc;
        for (i = 0; i < 64; i++) {
            v = b[i];
            if (v === 0 || cSign(v) !== color) continue;
            t = cType(v); r = cRow(i); c = cCol(i);
            if (t === C_PAWN) {
                var fwd = -color;                         // white(+1) moves up the board (row-1)
                var one = r + fwd;
                if (one >= 0 && one < 8 && b[cSq(one, c)] === 0) {
                    moves.push({ from: i, to: cSq(one, c) });
                    var startRow = color > 0 ? 6 : 1, two = r + 2 * fwd;
                    if (r === startRow && b[cSq(two, c)] === 0) moves.push({ from: i, to: cSq(two, c) });
                }
                for (d = -1; d <= 1; d += 2) {
                    nc = c + d;
                    if (nc < 0 || nc > 7 || one < 0 || one > 7) continue;
                    var tsq = cSq(one, nc), tv = b[tsq];
                    if ((tv !== 0 && cSign(tv) === -color) || tsq === st.ep) moves.push({ from: i, to: tsq });
                }
            } else if (t === C_KNIGHT) {
                for (d = 0; d < 8; d++) {
                    nr = r + KNIGHT_D[d][0]; nc = c + KNIGHT_D[d][1];
                    if (cOn(nr, nc) && cSign(b[cSq(nr, nc)]) !== color) moves.push({ from: i, to: cSq(nr, nc) });
                }
            } else if (t === C_KING) {
                for (d = 0; d < 8; d++) {
                    nr = r + KING_D[d][0]; nc = c + KING_D[d][1];
                    if (cOn(nr, nc) && cSign(b[cSq(nr, nc)]) !== color) moves.push({ from: i, to: cSq(nr, nc) });
                }
                addCastles(b, st, color, i, moves);
            } else {
                var dirs = t === C_BISHOP ? DIAG_D : (t === C_ROOK ? ORTHO_D : QUEEN_D);
                for (d = 0; d < dirs.length; d++) {
                    nr = r + dirs[d][0]; nc = c + dirs[d][1];
                    while (cOn(nr, nc)) {
                        var sv = b[cSq(nr, nc)];
                        if (sv === 0) moves.push({ from: i, to: cSq(nr, nc) });
                        else { if (cSign(sv) !== color) moves.push({ from: i, to: cSq(nr, nc) }); break; }
                        nr += dirs[d][0]; nc += dirs[d][1];
                    }
                }
            }
        }
        return moves;
    }

    // Legal moves = pseudo-legal minus those leaving one's own king in check.
    function legalMoves(b, st, color) {
        var ps = pseudoMoves(b, st, color), out = [];
        for (var i = 0; i < ps.length; i++) {
            var r = makeMove(b, st, ps[i].from, ps[i].to);
            if (!inCheck(r[0], color)) out.push(ps[i]);
        }
        return out;
    }

    // "ongoing" | "checkmate" | "stalemate" for `color` to move.
    function chessResult(b, st, color) {
        if (legalMoves(b, st, color).length > 0) return "ongoing";
        return inCheck(b, color) ? "checkmate" : "stalemate";
    }

    // ── chess bot: material + light positional eval, alpha-beta negamax ──────────
    function pieceValue(t) { return t === C_PAWN ? 100 : t === C_KNIGHT ? 320 : t === C_BISHOP ? 330
        : t === C_ROOK ? 500 : t === C_QUEEN ? 900 : t === C_KING ? 20000 : 0; }

    // White-positive static score: material + a small central pull for every piece.
    function evalBoard(b) {
        var s = 0;
        for (var i = 0; i < 64; i++) {
            var v = b[i];
            if (v === 0) continue;
            var sg = cSign(v);
            s += sg * pieceValue(cType(v));
            var center = (3.5 - Math.abs(3.5 - cCol(i))) + (3.5 - Math.abs(3.5 - cRow(i)));
            s += sg * center * 2;
        }
        return s;
    }

    // Captures first → better alpha-beta pruning.
    function orderChessMoves(b, moves) {
        moves.sort(function (a, z) {
            return (b[z.to] !== 0 ? pieceValue(cType(b[z.to])) : 0) - (b[a.to] !== 0 ? pieceValue(cType(b[a.to])) : 0);
        });
    }

    function negamax(b, st, color, depth, alpha, beta, budget) {
        if (depth === 0) return color * evalBoard(b);
        var moves = legalMoves(b, st, color);
        if (moves.length === 0) return inCheck(b, color) ? -100000 - depth : 0;   // mate (deeper = worse) / stalemate
        orderChessMoves(b, moves);
        var best = -1e9;
        for (var i = 0; i < moves.length; i++) {
            if (budget.n++ > budget.max) break;                  // node cap: bail with best-so-far
            var r = makeMove(b, st, moves[i].from, moves[i].to);
            var sc = -negamax(r[0], r[1], -color, depth - 1, -beta, -alpha, budget);
            if (sc > best) best = sc;
            if (best > alpha) alpha = best;
            if (alpha >= beta) break;
        }
        return best;
    }

    // Pick a move for `color`. Depth/budget tuned to stay responsive in Panorama; if the node
    // budget trips mid-search the best move found so far is used. Tiny jitter avoids repetition.
    function chessBotMove(b, st, color) {
        var moves = legalMoves(b, st, color);
        if (moves.length === 0) return null;
        orderChessMoves(b, moves);
        var budget = { n: 0, max: 120000 }, DEPTH = 3, best = null, bestScore = -1e9;
        for (var i = 0; i < moves.length; i++) {
            var r = makeMove(b, st, moves[i].from, moves[i].to);
            var sc = -negamax(r[0], r[1], -color, DEPTH - 1, -1e9, 1e9, budget) + Math.random() * 8;
            if (sc > bestScore) { bestScore = sc; best = moves[i]; }
        }
        return best;
    }

    R.chess = {
        C_PAWN: C_PAWN, C_KNIGHT: C_KNIGHT, C_BISHOP: C_BISHOP, C_ROOK: C_ROOK, C_QUEEN: C_QUEEN, C_KING: C_KING,
        cSq: cSq, cRow: cRow, cCol: cCol, cSign: cSign, cType: cType,
        initialChessBoard: initialChessBoard, initialChessState: initialChessState, cloneChessState: cloneChessState,
        findKing: findKing, attacksSquare: attacksSquare, inCheck: inCheck,
        makeMove: makeMove, pseudoMoves: pseudoMoves, legalMoves: legalMoves, chessResult: chessResult,
        chessBotMove: chessBotMove
    };
})();

// ---- rules/connectfour.js ----
"use strict";

/*
 * rules/connectfour.js — pure Connect Four rules, shared by client predictor + server
 * authority (same shared-namespace mechanism as rules/checkers.js / rules/ttt.js).
 *
 * Board is a flat length-42 array, index = row*7 + col. row 0 = TOP, row 5 = BOTTOM;
 * col 0 = LEFT. Values: 0 empty, 1 = host (red, seat 0, moves first), 2 = joiner (yellow).
 * A move is a COLUMN 0..6; gravity drops the disc to the lowest empty row of that column,
 * so only the column travels the wire (the landing row is derived — same "derive, don't
 * transmit" idiom as checkers applyHop / chess makeMove).
 */

(function () {
    var R;
    if (typeof $ !== "undefined" && $) {
        var MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    var COLS = 7, ROWS = 6, CELLS = COLS * ROWS;

    function idx(r, c) { return r * COLS + c; }
    function initialBoard() { var b = new Array(CELLS); for (var i = 0; i < CELLS; i++) b[i] = 0; return b; }

    // Columns whose TOP cell is empty (i.e. not full).
    function legalCols(b) {
        var out = [];
        for (var c = 0; c < COLS; c++) if (b[idx(0, c)] === 0) out.push(c);
        return out;
    }
    // Lowest empty row of a column (where a dropped disc lands), or -1 if the column is full.
    function dropRow(b, col) {
        if (col < 0 || col >= COLS) return -1;
        for (var r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === 0) return r;
        return -1;
    }
    // Drop a disc for `player` into `col`. Returns { board, row } with a NEW board (the caller
    // decides whether to keep it), or null if the column is full. Board is copied so callers
    // can use it as a predictor without clobbering their own state.
    function drop(b, col, player) {
        var r = dropRow(b, col);
        if (r < 0) return null;
        var nb = b.slice();
        nb[idx(r, col)] = player;
        return { board: nb, row: r };
    }

    // First player with four-in-a-row (horizontal, vertical, both diagonals), or 0.
    var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
    function winner(b) {
        for (var r = 0; r < ROWS; r++) {
            for (var c = 0; c < COLS; c++) {
                var v = b[idx(r, c)];
                if (!v) continue;
                for (var d = 0; d < DIRS.length; d++) {
                    var dr = DIRS[d][0], dc = DIRS[d][1];
                    var rr = r + dr * 3, cc = c + dc * 3;
                    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                    if (b[idx(r + dr, c + dc)] === v && b[idx(r + dr * 2, c + dc * 2)] === v &&
                        b[idx(rr, cc)] === v) return v;
                }
            }
        }
        return 0;
    }
    function isFull(b) { for (var i = 0; i < CELLS; i++) if (b[i] === 0) return false; return true; }
    function isDraw(b) { return !winner(b) && isFull(b); }

    // The four-cell winning line for `player` (row-major cell indices), or null. UI-only —
    // lets the controller highlight the winning discs.
    function winningLine(b, player) {
        for (var r = 0; r < ROWS; r++) {
            for (var c = 0; c < COLS; c++) {
                if (b[idx(r, c)] !== player) continue;
                for (var d = 0; d < DIRS.length; d++) {
                    var dr = DIRS[d][0], dc = DIRS[d][1];
                    var rr = r + dr * 3, cc = c + dc * 3;
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
    // Negamax + alpha-beta with a light positional eval. Depth is a perf guess for Panorama;
    // if the bot hitches in-game, drop DEPTH. Centre columns are searched first (better
    // pruning) and weighted in the eval (classic Connect Four heuristic).
    var CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6];
    var DEPTH = 6;

    // Count windows of 4 and score them: a window with only my discs is good, only theirs bad.
    function evalBoard(b, me) {
        var opp = me === 1 ? 2 : 1, score = 0, r, c, d;
        // centre column preference
        for (r = 0; r < ROWS; r++) if (b[idx(r, 3)] === me) score += 3;
        for (r = 0; r < ROWS; r++) {
            for (c = 0; c < COLS; c++) {
                for (d = 0; d < DIRS.length; d++) {
                    var dr = DIRS[d][0], dc = DIRS[d][1];
                    var rr = r + dr * 3, cc = c + dc * 3;
                    if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                    var mine = 0, theirs = 0, k;
                    for (k = 0; k < 4; k++) {
                        var v = b[idx(r + dr * k, c + dc * k)];
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

    function negamax(b, player, me, depth, alpha, beta) {
        var w = winner(b);
        if (w) return w === me ? (100000 + depth) : -(100000 + depth); // sooner wins score higher
        var cols = legalCols(b);
        if (cols.length === 0) return 0;                   // draw
        if (depth === 0) return evalBoard(b, me);
        var best = -1e9;
        for (var i = 0; i < CENTER_ORDER.length; i++) {
            var col = CENTER_ORDER[i];
            if (b[idx(0, col)] !== 0) continue;            // full
            var res = drop(b, col, player);
            var val = -negamax(res.board, player === 1 ? 2 : 1, me, depth - 1, -beta, -alpha);
            if (val > best) best = val;
            if (val > alpha) alpha = val;
            if (alpha >= beta) break;                      // prune
        }
        return best;
    }

    // Returns the column the bot plays, or -1 if the board is full.
    function cfBotMove(b, player) {
        var cols = legalCols(b);
        if (cols.length === 0) return -1;
        var opp = player === 1 ? 2 : 1, i, col, res;
        // 1) take an immediate win
        for (i = 0; i < cols.length; i++) { res = drop(b, cols[i], player); if (winner(res.board) === player) return cols[i]; }
        // 2) block the opponent's immediate win
        for (i = 0; i < cols.length; i++) { res = drop(b, cols[i], opp); if (winner(res.board) === opp) return cols[i]; }
        // 3) search
        var bestCol = cols[0], bestVal = -1e9;
        for (i = 0; i < CENTER_ORDER.length; i++) {
            col = CENTER_ORDER[i];
            if (b[idx(0, col)] !== 0) continue;
            res = drop(b, col, player);
            var val = -negamax(res.board, opp, player, DEPTH - 1, -1e9, 1e9);
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

/* ── authored core (from server/worker.core.js) ── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Deadlock Minigames relay OK", { status: 200 });
    }
    // All game state lives in a single strongly-consistent Durable Object.
    const id = env.HUB.idFromName("hub");
    const stub = env.HUB.get(id);
    return stub.fetch(request);
  },
};

export class Hub {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Panorama's <Image> loader only fetches URLs that look like an image, so the
    // client appends ".png" to every route. Strip it here before routing.
    const p = url.pathname.replace(/\.png$/, "");
    const q = url.searchParams;
    const code = q.get("code");

    try {
      if (p === "/api/probe") return png(600, 1000);
      if (p === "/api/ping") return png(1, 1);

      if (p === "/api/create") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        const newCode = await this.freshCode();
        const lobby = {
          game, players: 1, moves: [], pub: 0, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null], // seat 0 = host = white/X/+1, moves first
          turn: 0,                                     // seat index whose turn it is
          state: initState(game)                       // authoritative board/state
        };
        await this.storage.put("l:" + newCode, lobby);
        // Split the 4-digit code across both dimensions to keep them small.
        return png(Math.floor(newCode / 100), (newCode % 100) + 1);
      }

      if (p === "/api/quick") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        const waitCode = await this.storage.get("pubq:" + game);
        if (waitCode) {
          const w = await this.storage.get("l:" + waitCode);
          if (w && w.pub && w.players < 2) {
            w.players = 2;
            w.seats = w.seats || [null, null];
            w.seats[1] = { tok: q.get("tok") || "" }; // joiner takes seat 1 (black/O/-1)
            await this.storage.put("l:" + waitCode, w);
            await this.storage.delete("pubq:" + game);
            return png(Math.floor(waitCode / 100), (waitCode % 100) + 1); // JOINER (black)
          }
          // stale/closed slot — fall through and host a fresh lobby.
        }
        const newCode = await this.freshCode();
        const lobby = {
          game, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null], // host takes seat 0 (white/X/+1)
          turn: 0,
          state: initState(game)
        };
        await this.storage.put("l:" + newCode, lobby);
        await this.storage.put("pubq:" + game, newCode);
        // HOST (white): +100 on the width flags the role without a fragile extra value.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }

      if (p === "/api/cancel") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (lobby) {
          await this.storage.delete("l:" + code);
          const waitCode = await this.storage.get("pubq:" + lobby.game);
          if (waitCode != null && Number(waitCode) === Number(code)) {
            await this.storage.delete("pubq:" + lobby.game);
          }
        }
        return png(1, 1);
      }

      if (p === "/api/join") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(20, 1);             // missing
        if (lobby.players >= 2) return png(21, 1); // full
        lobby.players = 2;
        lobby.seats = lobby.seats || [null, null];
        lobby.seats[1] = { tok: q.get("tok") || "" }; // joiner takes seat 1
        await this.storage.put("l:" + code, lobby);
        return png(lobby.game, 1);                 // ok: which game the host picked (1..9)
      }

      if (p === "/api/status") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 1);              // gone
        return png(lobby.players, 1);              // 1 or 2
      }

      if (p === "/api/move") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);              // no lobby
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);            // bad / foreign token — caller isn't a seat here
        const from = clampInt(q.get("from"), 0, 0, 63);
        const to = clampInt(q.get("to"), 0, 0, 63);
        const end = clampInt(q.get("end"), 0, 0, 1);
        // Authoritative validation: the server owns the board, enforces whose turn it is,
        // and rejects any illegal move with a (9,x) code. The stored `end` is the one the
        // SERVER computes (never the client's), so a cheat can't forge the turn hand-off.
        const v = validateMove(lobby, seat, from, to, end);
        if (!v.ok) return png(9, v.code);          // (9,1) not your turn · (9,2) illegal
        lobby.moves.push(v.move);
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);                          // accepted
      }

      if (p === "/api/poll") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);              // 9x9 signals lobby destroyed / opponent left
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const mv = lobby.moves[since]; // 0-based; this move is seq = since+1
        if (!mv) return png(1, 1);                 // nothing new
        // width = from+1 (+100 if this hop ends the turn); height = to+1.
        // Keeping `end` in a separate hundreds-range (not a low bit) makes it
        // immune to +/-1 rounding from UI scaling. from != to, so never (1,1).
        return png(mv.f + 1 + (mv.e ? 100 : 0), mv.t + 1);
      }

      if (p === "/api/reset") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        if (seatOf(lobby, q.get("tok")) < 0) return png(9, 3); // only a seated player may reset
        lobby.game = clampInt(q.get("game"), lobby.game, 1, 9);
        lobby.moves = [];
        lobby.turn = 0;
        lobby.state = initState(lobby.game);
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }

      return png(9, 8); // unknown route
    } catch (e) {
      return png(9, 7); // server error marker
    }
  }

  async freshCode() {
    // 4-digit lobby code (1000..9999), avoid collisions.
    for (let i = 0; i < 40; i++) {
      const c = 1000 + Math.floor(Math.random() * 9000);
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    return 1000 + Math.floor(Math.random() * 9000);
  }

  // Opportunistic cleanup so a public relay's storage stays bounded. Runs at most
  // once a minute (guarded by a stored timestamp) and only off write paths
  // (create/quick), never on the hot poll loop. Drops lobbies idle for > 30 min.
  async maybeSweep() {
    const now = Date.now();
    const last = (await this.storage.get("lastSweep")) || 0;
    if (now - last < 60000) return;
    await this.storage.put("lastSweep", now);
    const all = await this.storage.list({ prefix: "l:" });
    for (const [key, lobby] of all) {
      if (lobby && lobby.t && now - lobby.t > 30 * 60000) {
        await this.storage.delete(key);
      }
    }
  }
}

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function nowSeq() {
  // Monotonic-ish tag for debugging; not used for logic.
  return Date.now();
}

/* ───────────────── authoritative identity + move validation ─────────────────
 * The seat token is the trust anchor. It flows ONLY upward (query param), is never
 * echoed in a response, and is long + random, so an observer can neither read nor
 * guess it. seatOf maps a presented token to its seat index (0/1) or -1 (→ (9,3)).
 * Fixed seat↔side mapping (matches the client): seat 0 = host, moves first.
 */
function rules() { return (typeof globalThis !== "undefined" && globalThis.MGRules) || {}; }

function seatOf(lobby, tok) {
  if (!tok || !lobby.seats) return -1;
  for (let i = 0; i < lobby.seats.length; i++) {
    const s = lobby.seats[i];
    if (s && s.tok && s.tok === tok) return i;
  }
  return -1;
}

// Fresh authoritative state per game. null = no server engine → legacy relay.
function initState(game) {
  const R = rules();
  if (game === 1) return { board: R.checkers.initialBoard(), chainSq: -1 }; // checkers
  if (game === 2) return { board: [0, 0, 0, 0, 0, 0, 0, 0, 0] };            // tic-tac-toe
  if (game === 4) return { board: R.chess.initialChessBoard(), cst: R.chess.initialChessState() }; // chess
  if (game === 5) return { board: R.connectfour.initialBoard() };                                  // connect four
  return null;
}

// Validate a move by the seat holder against the authoritative state. Returns
// { ok:true, move:{f,t,e} } (e computed by the SERVER) or { ok:false, code } where
// code is 1 (not your turn) or 2 (illegal move). Mutates lobby.state / lobby.turn on
// acceptance. A game with no server engine relays unchecked (backward compatible).
function validateMove(lobby, seat, from, to, end) {
  const R = rules();
  if (!lobby.state) return { ok: true, move: { f: from, t: to, e: end } };
  if (lobby.game === 1) return validateCheckers(R.checkers, lobby, seat, from, to);
  if (lobby.game === 2) return validateTtt(lobby, seat, from, to);
  if (lobby.game === 4) return validateChess(R.chess, lobby, seat, from, to);
  if (lobby.game === 5) return validateConnectFour(R.connectfour, lobby, seat, from, to);
  return { ok: true, move: { f: from, t: to, e: end } };
}

function validateCheckers(RC, lobby, seat, from, to) {
  const st = lobby.state, b = st.board;
  const side = seat === 0 ? RC.WHITE : RC.BLACK;
  const chaining = st.chainSq >= 0;
  // Turn: mid-chain only the chaining seat may move, and only its chain piece.
  if (chaining) { if (seat !== lobby.turn || from !== st.chainSq) return { ok: false, code: 1 }; }
  else if (seat !== lobby.turn) return { ok: false, code: 1 };
  if (RC.colorOf(b[from]) !== side) return { ok: false, code: 2 };
  // Legal targets for THIS piece, honouring forced capture / an active chain.
  let targets;
  if (chaining || RC.anyCaptureFor(b, side)) targets = RC.captureMoves(b, from);
  else targets = RC.simpleMoves(b, from);
  let ok = false;
  for (let i = 0; i < targets.length; i++) if (targets[i].to === to) { ok = true; break; }
  if (!ok) return { ok: false, code: 2 };
  const res = RC.applyHop(b, from, to); // mutates the authoritative board
  // Same piece may keep jumping (a capture, and not just crowned) → chain continues.
  const more = res.captured && !res.promoted && RC.captureMoves(b, to).length > 0;
  let e;
  if (more) { st.chainSq = to; e = 0; }                       // turn stays with this seat
  else { st.chainSq = -1; e = 1; lobby.turn = seat === 0 ? 1 : 0; } // hand off
  return { ok: true, move: { f: from, t: to, e: e } };
}

function validateTtt(lobby, seat, from, to) {
  const b = lobby.state.board;
  if (seat !== lobby.turn) return { ok: false, code: 1 };
  // A placement is cell 0..8 with the fixed marker to===9, onto an empty cell.
  if (to !== 9 || from < 0 || from > 8 || b[from] !== 0) return { ok: false, code: 2 };
  b[from] = seat === 0 ? 1 : 2;              // X (host) / O (joiner)
  lobby.turn = seat === 0 ? 1 : 0;
  return { ok: true, move: { f: from, t: 9, e: 1 } };
}

function validateChess(RX, lobby, seat, from, to) {
  const st = lobby.state;
  const side = seat === 0 ? 1 : -1;          // white / black
  if (seat !== lobby.turn) return { ok: false, code: 1 };
  if (RX.cSign(st.board[from]) !== side) return { ok: false, code: 2 };
  const legal = RX.legalMoves(st.board, st.cst, side); // includes self-check filter, castling, ep
  let ok = false;
  for (let i = 0; i < legal.length; i++) if (legal[i].from === from && legal[i].to === to) { ok = true; break; }
  if (!ok) return { ok: false, code: 2 };
  const r = RX.makeMove(st.board, st.cst, from, to);
  st.board = r[0]; st.cst = r[1];
  lobby.turn = seat === 0 ? 1 : 0;           // every chess move ends the turn
  return { ok: true, move: { f: from, t: to, e: 1 } };
}

// Connect Four: a move is a COLUMN in `from` (0..6) with the fixed marker `to === 7` (so
// from != to always holds, exactly like tic-tac-toe's to === 9). The server derives the
// landing row via gravity and rejects a full column. Host = seat 0 = red, moves first.
function validateConnectFour(RC, lobby, seat, from, to) {
  const st = lobby.state;
  if (seat !== lobby.turn) return { ok: false, code: 1 };
  if (to !== 7 || from < 0 || from >= RC.COLS) return { ok: false, code: 2 };
  const r = RC.drop(st.board, from, seat === 0 ? 1 : 2);
  if (!r) return { ok: false, code: 2 };     // column full
  st.board = r.board;
  lobby.turn = seat === 0 ? 1 : 0;
  return { ok: true, move: { f: from, t: 7, e: 1 } };
}


/* ─────────────────────────── PNG encoder ───────────────────────────
 * Emits an 8-bit grayscale PNG of exactly W x H black pixels. Data is all
 * zeros, wrapped in zlib "stored" (uncompressed) deflate blocks — no real
 * compression needed. The client only cares about the dimensions.
 */
function png(w, h) {
  w = Math.max(1, Math.min(w | 0, 8000));
  h = Math.max(1, Math.min(h | 0, 8000));

  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = u32(w).concat(u32(h), [8, 0, 0, 0, 0]); // 8-bit, grayscale

  // Raw scanlines: each row = 1 filter byte (0) + W pixel bytes (0). All zeros.
  const rawLen = h * (1 + w);

  // zlib stream: header + stored deflate blocks + adler32.
  const zlib = [0x78, 0x01];
  let off = 0;
  do {
    const blockLen = Math.min(65535, rawLen - off);
    const final = off + blockLen >= rawLen ? 1 : 0;
    zlib.push(final, blockLen & 255, (blockLen >> 8) & 255,
      ~blockLen & 255, (~blockLen >> 8) & 255);
    for (let i = 0; i < blockLen; i++) zlib.push(0);
    off += blockLen;
  } while (off < rawLen);
  zlib.push(...u32(adler32Zeros(rawLen)));

  const bytes = sig
    .concat(chunk("IHDR", ihdr))
    .concat(chunk("IDAT", zlib))
    .concat(chunk("IEND", []));

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "access-control-allow-origin": "*",
    },
  });
}

function u32(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type, data) {
  const t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const body = t.concat(data);
  return u32(data.length).concat(body, u32(crc32(body)));
}

// Adler32 of an all-zeros buffer of length n. a stays 1; b = (n * 1) mod 65521.
function adler32Zeros(n) {
  const MOD = 65521;
  const a = 1;
  const b = ((n % MOD) * 1) % MOD; // each step adds a(=1)
  return ((b << 16) | a) >>> 0;
}

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
