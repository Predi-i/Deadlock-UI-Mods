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

    // Resumable variant of chooseBotMove: the SAME depth-5 search, but exposed as a driver so
    // the caller can evaluate ONE root move per frame and yield between them. Panorama JS is
    // single-threaded, so the old one-shot call froze the whole HUD for the length of the search
    // (the "лаги при ходе бота"); worse, that freeze ate the only window in which a premove could
    // be grabbed. Stepping across frames keeps the UI live and the bot exactly as strong.
    // Usage: var d = chooseBotMovePrep(b,color); while(!d.done()) d.step(); var seq = d.result();
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

    R.checkers = {
        WHITE: WHITE, BLACK: BLACK,
        idx: idx, rowOf: rowOf, colOf: colOf, isDark: isDark,
        colorOf: colorOf, isKing: isKing,
        initialBoard: initialBoard,
        simpleMoves: simpleMoves, captureMoves: captureMoves,
        anyCaptureFor: anyCaptureFor, applyHop: applyHop, hasAnyMove: hasAnyMove,
        legalSequences: legalSequences, chooseBotMove: chooseBotMove, chooseBotMovePrep: chooseBotMovePrep
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

    // Resumable variant of chessBotMove: SAME depth-3 alpha-beta, but one root move per step so the
    // caller can yield between them. Panorama JS is single-threaded — the one-shot search froze the
    // whole HUD (the "лаги при ходе бота") and that freeze swallowed the premove-grab window.
    // Stepping across frames keeps the UI responsive; the node budget is shared across steps so the
    // total work (and playing strength) is unchanged.
    // Usage: var d = chessBotMovePrep(b,st,color); while(!d.done()) d.step(); var mv = d.result();
    function chessBotMovePrep(b, st, color) {
        var moves = legalMoves(b, st, color);
        orderChessMoves(b, moves);
        var budget = { n: 0, max: 120000 }, DEPTH = 3, i = 0, best = null, bestScore = -1e9;
        return {
            done: function () { return i >= moves.length; },
            step: function () {
                if (i >= moves.length) return;
                var r = makeMove(b, st, moves[i].from, moves[i].to);
                var sc = -negamax(r[0], r[1], -color, DEPTH - 1, -1e9, 1e9, budget) + Math.random() * 8;
                if (sc > bestScore) { bestScore = sc; best = moves[i]; }
                i++;
            },
            result: function () { return best; }
        };
    }

    R.chess = {
        C_PAWN: C_PAWN, C_KNIGHT: C_KNIGHT, C_BISHOP: C_BISHOP, C_ROOK: C_ROOK, C_QUEEN: C_QUEEN, C_KING: C_KING,
        cSq: cSq, cRow: cRow, cCol: cCol, cSign: cSign, cType: cType,
        initialChessBoard: initialChessBoard, initialChessState: initialChessState, cloneChessState: cloneChessState,
        findKing: findKing, attacksSquare: attacksSquare, inCheck: inCheck,
        makeMove: makeMove, pseudoMoves: pseudoMoves, legalMoves: legalMoves, chessResult: chessResult,
        chessBotMove: chessBotMove, chessBotMovePrep: chessBotMovePrep
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
    // Negamax + alpha-beta with a light positional eval. Centre columns are searched first
    // (better pruning) and weighted in the eval (classic Connect Four heuristic).
    //
    // PERF (2026-07-20 — the maintainer's "дикие лаги"): the search runs SYNCHRONOUSLY on
    // Panorama's UI thread, and the old code allocated a fresh 42-element board (drop()'s
    // b.slice()) at EVERY node — tens of thousands of arrays per move, GC-thrashing Panorama's
    // slow interpreter into a multi-second freeze. Now the search does MAKE/UNDO on ONE working
    // board (write a cell, recurse, write it back to 0): zero allocation in the hot loop. The
    // public drop() still copies (its callers rely on that); only the internal search mutates,
    // and it always restores, so cfBotMove leaves the caller's board untouched. DEPTH trimmed
    // 6 → 5 for extra headroom (the win/block shortcuts below keep it tactically sharp).
    var CENTER_ORDER = [3, 2, 4, 1, 5, 0, 6];
    var DEPTH = 5;

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

    // Did the disc JUST placed at (r,c) complete a four-in-a-row? Only scans the four lines
    // THROUGH that cell (O(1)) instead of the whole board — the make/undo search's per-node
    // terminal test. `v` is the mover's colour at (r,c).
    function winsAt(b, r, c, v) {
        for (var d = 0; d < DIRS.length; d++) {
            var dr = DIRS[d][0], dc = DIRS[d][1], run = 1, k, rr, cc;
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
    // Lowest empty row of `col` on the CURRENT (mutated) board — search's make step. -1 if full.
    function landRow(b, col) { for (var r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === 0) return r; return -1; }

    // Negamax on ONE working board via make/undo (no per-node allocation — see the PERF note).
    // `lastWin` = the mover of the PARENT node just won by landing at (lastR,lastC); we detect the
    // terminal at the child so we never need a full-board winner() scan inside the loop.
    function negamax(b, player, me, depth, alpha, beta, lastR, lastC, lastV) {
        if (lastR >= 0 && winsAt(b, lastR, lastC, lastV))  // parent's move already won
            return lastV === me ? -(100000 + depth) : (100000 + depth);
        if (depth === 0) return evalBoard(b, me);
        var best = -1e9, moved = false;
        for (var i = 0; i < CENTER_ORDER.length; i++) {
            var col = CENTER_ORDER[i];
            var r = landRow(b, col);
            if (r < 0) continue;                           // full
            moved = true;
            var cell = idx(r, col);
            b[cell] = player;                              // make
            var val = -negamax(b, player === 1 ? 2 : 1, me, depth - 1, -beta, -alpha, r, col, player);
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
        var cols = legalCols(b);
        if (cols.length === 0) return -1;
        var opp = player === 1 ? 2 : 1, i, col, r;
        // Work on a private copy so the search's make/undo can never touch the caller's board
        // (make/undo always restores, but a copy makes that guarantee unconditional).
        var w = b.slice();
        // 1) take an immediate win
        for (i = 0; i < cols.length; i++) { col = cols[i]; r = landRow(w, col); w[idx(r, col)] = player; if (winsAt(w, r, col, player)) { w[idx(r, col)] = 0; return col; } w[idx(r, col)] = 0; }
        // 2) block the opponent's immediate win
        for (i = 0; i < cols.length; i++) { col = cols[i]; r = landRow(w, col); w[idx(r, col)] = opp; if (winsAt(w, r, col, opp)) { w[idx(r, col)] = 0; return col; } w[idx(r, col)] = 0; }
        // 3) search
        var bestCol = cols[0], bestVal = -1e9;
        for (i = 0; i < CENTER_ORDER.length; i++) {
            col = CENTER_ORDER[i];
            r = landRow(w, col);
            if (r < 0) continue;
            var cell = idx(r, col);
            w[cell] = player;                              // make
            var val = -negamax(w, opp, player, DEPTH - 1, -1e9, 1e9, r, col, player);
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

// ---- rules/durak.js ----
"use strict";

/*
 * rules/durak.js — pure "Durak" (Podkidnoy) rules, shared by the client (predictor + bot)
 * and the authoritative server dealer (same shared-namespace mechanism as rules/ttt.js).
 *
 * Card model: id 0..35 = suit*9 + rank. suit 0..3 = S,H,D,C. rank 0..8 = 6,7,8,9,T,J,Q,K,A
 * (higher rank index = stronger). Trump = suit of the deck's bottom card. A given seed fully
 * determines a deal (mulberry32), and online the SERVER owns that seed — so the client never
 * sees the deck, it rebuilds its view from the public event log + its own private cards.
 *
 * Scope note: the mod ships 2-player online Durak for now; 3–4-player online seating/plumbing
 * is deferred (see mg_ui.js). These rules already generalise to numPlayers 2..4 and the
 * offline bot exercises 2/3/4, so nothing here blocks a later expansion.
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

    var SUIT_CHARS = ["S", "H", "D", "C"];
    var RANK_CHARS = ["6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_SIZE = 36;

    function suitOf(id) { return (id / 9) | 0; }
    function rankOf(id) { return id % 9; }

    // Deterministic PRNG (mulberry32) so a given seed always deals the same game — the test
    // relies on this, and online the server owns the seed.
    function makeRng(seed) {
        var s = seed | 0;
        return function () {
            s = (s + 0x6D2B79F5) | 0;
            var t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function freshDeck(rng) {
        var d = [];
        for (var i = 0; i < DECK_SIZE; i++) d.push(i);
        for (var j = DECK_SIZE - 1; j > 0; j--) {
            var k = (rng() * (j + 1)) | 0;
            var t = d[j]; d[j] = d[k]; d[k] = t;
        }
        return d;
    }

    // Draw from the FRONT (index 0 = top). The bottom card (last index) is the trump card,
    // drawn last, so it stays put until the deck is nearly empty.
    function deal(deck, numPlayers) {
        var hands = [];
        for (var s = 0; s < numPlayers; s++) hands.push([]);
        var dk = deck.slice();
        for (var n = 0; n < 6; n++)
            for (var p = 0; p < numPlayers; p++) hands[p].push(dk.shift());
        var trumpCard = dk[dk.length - 1];
        return { hands: hands, deck: dk, trumpCard: trumpCard, trump: suitOf(trumpCard) };
    }

    // A `def` card beats an `att` card if: same suit and higher rank, OR it is a trump
    // covering a non-trump. Trump-vs-trump is decided by rank (same-suit branch).
    function beats(att, def, trump) {
        var sa = suitOf(att), sd = suitOf(def);
        if (sd === sa) return rankOf(def) > rankOf(att);
        if (sd === trump && sa !== trump) return true;
        return false;
    }

    function removeCard(hand, id) { var k = hand.indexOf(id); if (k >= 0) hand.splice(k, 1); }

    // Lowest trump holder opens the very first attack (classic rule); seat 0 if nobody
    // holds a trump.
    function firstAttacker(st) {
        var best = -1, bestRank = 99;
        for (var s = 0; s < st.numPlayers; s++) {
            var h = st.hands[s];
            for (var k = 0; k < h.length; k++) {
                if (suitOf(h[k]) === st.trump && rankOf(h[k]) < bestRank) { bestRank = rankOf(h[k]); best = s; }
            }
        }
        return best < 0 ? 0 : best;
    }

    function nextInPlay(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (seat + k) % st.numPlayers;
            if (!st.out[s]) return s;
        }
        return seat;
    }
    function firstInPlayFrom(st, seat) { return st.out[seat] ? nextInPlay(st, seat) : seat; }

    function newGame(numPlayers, seed) {
        var dealt = deal(freshDeck(makeRng(seed)), numPlayers);
        var st = {
            numPlayers: numPlayers,
            trump: dealt.trump,
            trumpCard: dealt.trumpCard,
            deck: dealt.deck,
            hands: dealt.hands,
            table: [],          // [{ a: attackId, d: defenseId | -1 }]
            attacker: 0,
            defender: 0,
            phase: "attack",   // "attack" | "defend" | "over"
            discard: 0,
            out: [],
            // Classic podkidnoy throw-in consensus: `passed[s]` = seat s has declared "done
            // adding" for the CURRENT table. A bout ends by Bito only once EVERY in-play
            // non-defender who still holds a legal throw-in has passed (see canBito). Any card
            // hitting the table (attack OR cover) reopens the window, so passes reset then. This
            // is what gives co-attackers (and the primary attacker) a real window to pile on
            // matching ranks before the table is beaten — the mechanic the 2-player code never
            // exercised (one non-defender = the attacker, so its single "pass" was the old Bito).
            passed: [],
            loser: -1
        };
        for (var s = 0; s < numPlayers; s++) { st.out.push(false); st.passed.push(false); }
        st.attacker = firstAttacker(st);
        st.defender = nextInPlay(st, st.attacker);
        return st;
    }

    // table queries
    function tableRankSet(st) {
        var set = {};
        for (var i = 0; i < st.table.length; i++) {
            set[rankOf(st.table[i].a)] = 1;
            if (st.table[i].d >= 0) set[rankOf(st.table[i].d)] = 1;
        }
        return set;
    }
    function uncoveredCount(st) {
        var n = 0;
        for (var i = 0; i < st.table.length; i++) if (st.table[i].d < 0) n++;
        return n;
    }
    function firstUncovered(st) {
        for (var i = 0; i < st.table.length; i++) if (st.table[i].d < 0) return i;
        return -1;
    }

    // Can `seat` play `card` as an attack right now?
    //  - opener (empty table): only the attacker, any card.
    //  - throw-in (non-empty): rank must already be on the table, table capped at 6 cards,
    //    and never more uncovered attacks than the defender can still cover.
    function canAttackWith(st, seat, card) {
        if (st.out[seat]) return false;
        if (seat === st.defender) return false;
        if (st.hands[seat].indexOf(card) < 0) return false;
        if (st.table.length === 0) return seat === st.attacker;
        if (st.table.length >= 6) return false;
        if (uncoveredCount(st) + 1 > st.hands[st.defender].length) return false;
        return !!tableRankSet(st)[rankOf(card)];
    }
    function legalAttacks(st, seat) {
        var out = [], h = st.hands[seat];
        for (var i = 0; i < h.length; i++) if (canAttackWith(st, seat, h[i])) out.push(h[i]);
        return out;
    }
    function canDefendPair(st, pairIndex, card) {
        var p = st.table[pairIndex];
        if (!p || p.d >= 0) return false;
        if (st.hands[st.defender].indexOf(card) < 0) return false;
        return beats(p.a, card, st.trump);
    }
    function legalDefends(st, pairIndex) {
        var out = [], h = st.hands[st.defender];
        for (var i = 0; i < h.length; i++) if (canDefendPair(st, pairIndex, h[i])) out.push(h[i]);
        return out;
    }

    // Clear every seat's "done adding" flag. Called whenever the table changes (a new attack
    // card or a cover), because fresh cards can create new throw-in options for a seat that had
    // already passed — so consensus must be re-earned before the bout can be beaten.
    function resetPasses(st) {
        for (var s = 0; s < st.numPlayers; s++) st.passed[s] = false;
    }
    // Is `seat` an in-play ATTACKER (not the defender, not out)? Only these seats throw in and
    // vote on ending the bout; the defender's "end" action is Take, handled separately.
    function isAttackSeat(st, seat) { return seat !== st.defender && !st.out[seat]; }

    // Record that `seat` is done adding cards to the current table (a "pass"/knock). Idempotent.
    function applyPass(st, seat) { if (isAttackSeat(st, seat)) st.passed[seat] = true; }

    // Has `seat` earned the right to still act (throw in) or must it pass? An attack seat is
    // "settled" once it either passed OR holds no legal throw-in for the current table.
    function attackSeatSettled(st, seat) {
        if (!isAttackSeat(st, seat)) return true;
        if (st.passed[seat]) return true;
        return legalAttacks(st, seat).length === 0;
    }
    // The table may be beaten (Bito) only when it's non-empty, fully covered, AND every in-play
    // attack seat has settled (passed or has nothing legal to throw in). This replaces the old
    // "primary attacker presses Bito" single-vote rule so 3–4-player throw-ins get their window.
    function canBito(st) {
        if (st.table.length === 0 || uncoveredCount(st) !== 0) return false;
        for (var s = 0; s < st.numPlayers; s++) if (!attackSeatSettled(st, s)) return false;
        return true;
    }
    // Which attack seats could still throw a legal card in right now (table covered, not yet
    // passed, and holding a matching-rank card), in classic turn order starting from the primary
    // attacker. Empty ⇒ nobody left to add → the bout is ready for Bito.
    function pendingThrowers(st) {
        var out = [];
        if (uncoveredCount(st) !== 0) return out;   // still defending; no throw-in window yet
        for (var k = 0; k < st.numPlayers; k++) {
            var s = (st.attacker + k) % st.numPlayers;
            if (isAttackSeat(st, s) && !st.passed[s] && legalAttacks(st, s).length > 0) out.push(s);
        }
        return out;
    }

    // mutators
    function applyAttack(st, seat, card) {
        removeCard(st.hands[seat], card);
        st.table.push({ a: card, d: -1 });
        st.phase = "defend";
        resetPasses(st);                 // a new attack card reopens the throw-in window for everyone
    }
    function applyDefend(st, pairIndex, card) {
        removeCard(st.hands[st.defender], card);
        st.table[pairIndex].d = card;
        resetPasses(st);                 // a fresh cover can enable new throw-in ranks → reopen
        if (uncoveredCount(st) === 0) st.phase = "attack"; // hand back to the attacker(s): add or Bito
    }

    function updateOut(st) {
        var deckEmpty = st.deck.length === 0;
        for (var s = 0; s < st.numPlayers; s++) {
            if (!st.out[s] && st.hands[s].length === 0 && deckEmpty) st.out[s] = true;
        }
    }
    function inPlayCount(st) {
        var n = 0;
        for (var s = 0; s < st.numPlayers; s++) if (!st.out[s]) n++;
        return n;
    }
    // Refill hands to 6, attacker(s) first in turn order, defender LAST (standard).
    function refill(st) {
        var order = [];
        for (var k = 0; k < st.numPlayers; k++) {
            var s = (st.attacker + k) % st.numPlayers;
            if (s === st.defender || st.out[s]) continue;
            order.push(s);
        }
        if (!st.out[st.defender]) order.push(st.defender);
        for (var i = 0; i < order.length; i++) {
            var seat = order[i];
            while (st.hands[seat].length < 6 && st.deck.length > 0) st.hands[seat].push(st.deck.shift());
        }
    }
    // End the current bout. took=true → defender picks up the whole table; else the table
    // is "beaten" (Bito) and discarded. Then refill and rotate roles.
    function endBout(st, took) {
        var oldDef = st.defender, i;
        if (took) {
            for (i = 0; i < st.table.length; i++) {
                st.hands[oldDef].push(st.table[i].a);
                if (st.table[i].d >= 0) st.hands[oldDef].push(st.table[i].d);
            }
        } else {
            for (i = 0; i < st.table.length; i++) { st.discard++; if (st.table[i].d >= 0) st.discard++; }
        }
        st.table = [];
        resetPasses(st);                 // fresh table → nobody has settled yet
        refill(st);
        updateOut(st);
        // Successful defense → the defender attacks next. Took → the taker is skipped.
        var base = firstInPlayFrom(st, took ? nextInPlay(st, oldDef) : oldDef);
        st.attacker = base;
        st.defender = nextInPlay(st, base);
        st.phase = "attack";
        checkOver(st);
    }
    // A seat abandons the table mid-game (online "Leave"). Their cards leave play with them, any
    // live bout is voided (a defender walking out can't be forced to finish), the survivors refill,
    // and roles rotate to the next in-play seats. Deterministic so the server drives it and clients
    // just apply the resulting LEFT + DRAW + ROLES events. inPlayCount ≤ 1 afterwards ends the game.
    function leaveSeat(st, seat) {
        if (st.out[seat] || st.phase === "over") return;
        st.out[seat] = true;
        // The leaver's hand is dead — count it into the discard pile so deck maths stay sane.
        st.discard += st.hands[seat].length;
        st.hands[seat] = [];
        // Void any open bout: the table's cards go to discard (the defender may be the one leaving,
        // so there's no clean "took"/"beaten" resolution — the bout simply doesn't count).
        for (var i = 0; i < st.table.length; i++) { st.discard++; if (st.table[i].d >= 0) st.discard++; }
        st.table = [];
        resetPasses(st);
        refill(st);                          // survivors top up (attacker-first, defender last)
        updateOut(st);
        var base = firstInPlayFrom(st, st.attacker);   // skip the leaver if it was the attacker
        st.attacker = base;
        st.defender = nextInPlay(st, base);
        st.phase = "attack";
        checkOver(st);
    }

    // Game ends when one or zero players are still holding cards. That last player is the
    // fool (durak); zero means a rare simultaneous-empty draw.
    function checkOver(st) {
        if (st.phase === "over") return true;
        updateOut(st);
        if (inPlayCount(st) <= 1) {
            st.phase = "over";
            st.loser = -1;
            for (var s = 0; s < st.numPlayers; s++) if (!st.out[s]) st.loser = s;
            return true;
        }
        return false;
    }

    // bot
    // Trumps sort far above non-trumps so the bot spends its cheapest, non-trump cards first.
    function cardValue(id, trump) { return rankOf(id) + (suitOf(id) === trump ? 100 : 0); }
    function sortByValue(arr, trump) {
        arr.sort(function (a, b) { return cardValue(a, trump) - cardValue(b, trump); });
        return arr;
    }
    // Returns the card to attack/throw-in with, or -1 to end the bout (Bito).
    function durakBotAttack(st, seat) {
        var la = sortByValue(legalAttacks(st, seat), st.trump);
        if (la.length === 0) return -1;
        if (st.table.length === 0) return la[0];            // opener must play its lowest
        var lowest = la[0];
        // Throw in only a genuinely cheap non-trump (6/7/8); otherwise stop.
        if (suitOf(lowest) !== st.trump && rankOf(lowest) <= 2) return lowest;
        return -1;
    }
    // Returns { pair, card } to cover the first open attack, or null to take.
    function durakBotDefend(st, seat) {
        var i = firstUncovered(st);
        if (i < 0) return null;
        var ld = sortByValue(legalDefends(st, i), st.trump);
        if (ld.length === 0) return null;                   // can't beat it → must take
        return { pair: i, card: ld[0] };
    }

    R.durak = {
        SUIT_CHARS: SUIT_CHARS, RANK_CHARS: RANK_CHARS, DECK_SIZE: DECK_SIZE,
        suitOf: suitOf, rankOf: rankOf, makeRng: makeRng, freshDeck: freshDeck, deal: deal,
        beats: beats, removeCard: removeCard, firstAttacker: firstAttacker, nextInPlay: nextInPlay,
        firstInPlayFrom: firstInPlayFrom, newGame: newGame, tableRankSet: tableRankSet,
        uncoveredCount: uncoveredCount, firstUncovered: firstUncovered, canAttackWith: canAttackWith,
        legalAttacks: legalAttacks, canDefendPair: canDefendPair, legalDefends: legalDefends,
        applyAttack: applyAttack, applyDefend: applyDefend, updateOut: updateOut,
        resetPasses: resetPasses, isAttackSeat: isAttackSeat, applyPass: applyPass,
        attackSeatSettled: attackSeatSettled, canBito: canBito, pendingThrowers: pendingThrowers,
        inPlayCount: inPlayCount, refill: refill, endBout: endBout, checkOver: checkOver, leaveSeat: leaveSeat,
        cardValue: cardValue, sortByValue: sortByValue,
        durakBotAttack: durakBotAttack, durakBotDefend: durakBotDefend
    };
})();

// ---- rules/poker.js ----
"use strict";

/*
 * rules/poker.js — pure No-Limit Texas Hold'em rules, shared by the client (predictor +
 * bot) and the authoritative server dealer (same shared-namespace mechanism as the other
 * rules/*.js). Nothing here touches Panorama; it is fully unit-testable in Node.
 *
 * Card model: id 0..51 = suit*13 + rank. suit 0..3 = S,H,D,C. rank 0..12 = 2,3,4,5,6,7,8,9,
 * T,J,Q,K,A (higher rank index = stronger). This matches the deck art filenames
 * (SUIT_CHARS[suit] + RANK_CHARS[rank] + ".vtex" → e.g. "SA", "H2", "DT"). A given seed
 * fully determines a deal (mulberry32); online the SERVER owns that seed so the client
 * never sees the deck or a foreign hole card — it rebuilds its view from the public event
 * log + its own private cards.
 *
 * Hand evaluation returns a comparable SCORE ARRAY [category, k1, k2, ...] where category
 * 8=straight flush … 0=high card and the k's are tie-break ranks, high-to-low. Compare two
 * scores lexicographically with compareScores(): >0 means the first hand wins.
 *
 * Betting is No-Limit: fold / check / call / raise-to. Side pots are built from each
 * player's total committed chips at showdown, so an all-in short stack can only win the
 * portion it matched. Deterministic bot (seeded rng) so mg_poker_test.js reproduces games.
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

    var SUIT_CHARS = ["S", "H", "D", "C"];
    var RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    var DECK_SIZE = 52;

    function suitOf(id) { return (id / 13) | 0; }
    function rankOf(id) { return id % 13; }
    function cardVal(id) { return rankOf(id) + 2; }   // 2..14 (ace high)

    // Deterministic PRNG (mulberry32) — identical to the other engines so seeds line up.
    function makeRng(seed) {
        var s = seed | 0;
        return function () {
            s = (s + 0x6D2B79F5) | 0;
            var t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function freshDeck(rng) {
        var d = [];
        for (var i = 0; i < DECK_SIZE; i++) d.push(i);
        for (var j = DECK_SIZE - 1; j > 0; j--) {
            var k = (rng() * (j + 1)) | 0;
            var t = d[j]; d[j] = d[k]; d[k] = t;
        }
        return d;
    }

    // ── hand evaluation ─────────────────────────────────────────────────────────
    // High card of the best straight in `vals` (array of card values 2..14, dups ok), or 0.
    // Handles the wheel (A-2-3-4-5) by letting the ace also count as 1.
    function straightHigh(vals) {
        var present = {};
        for (var i = 0; i < vals.length; i++) present[vals[i]] = 1;
        if (present[14]) present[1] = 1;               // ace plays low for the wheel
        var run = 0;
        for (var v = 14; v >= 1; v--) {
            if (present[v]) { run++; if (run >= 5) return v + 4; } else run = 0;
        }
        return 0;
    }

    // Score the best 5-card hand out of 5..7 cards. Returns [category, tiebreak…].
    function score(cards) {
        var byVal = {}, bySuit = [[], [], [], []], i, v, s;
        for (i = 0; i < cards.length; i++) {
            v = cardVal(cards[i]); s = suitOf(cards[i]);
            byVal[v] = (byVal[v] || 0) + 1;
            bySuit[s].push(v);
        }
        // flush / straight flush
        var flushVals = null;
        for (s = 0; s < 4; s++) if (bySuit[s].length >= 5) flushVals = bySuit[s];
        if (flushVals) {
            var sfHigh = straightHigh(flushVals);
            if (sfHigh) return [8, sfHigh];
        }
        // grouped by count then value, high to low
        var groups = [];
        for (var key in byVal) if (byVal.hasOwnProperty(key)) groups.push([byVal[key], parseInt(key, 10)]);
        groups.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
        // ordered distinct values high→low (kickers)
        var vals = [];
        for (i = 0; i < groups.length; i++) vals.push(groups[i][1]);

        var c0 = groups[0], c1 = groups[1];
        if (c0[0] === 4) return [7, c0[1], firstOther(vals, c0[1])];
        if (c0[0] === 3 && c1 && c1[0] >= 2) return [6, c0[1], c1[1]];
        if (flushVals) { flushVals = flushVals.slice().sort(desc); return [5, flushVals[0], flushVals[1], flushVals[2], flushVals[3], flushVals[4]]; }
        var st = straightHigh(allVals(cards));
        if (st) return [4, st];
        if (c0[0] === 3) return [3, c0[1], vals[1], vals[2]];
        if (c0[0] === 2 && c1 && c1[0] === 2) return [2, c0[1], c1[1], firstOtherPair(vals, c0[1], c1[1])];
        if (c0[0] === 2) return [1, c0[1], vals[1], vals[2], vals[3]];
        var hv = allVals(cards).sort(desc);
        return [0, hv[0], hv[1], hv[2], hv[3], hv[4]];
    }
    function desc(a, b) { return b - a; }
    function allVals(cards) { var o = []; for (var i = 0; i < cards.length; i++) o.push(cardVal(cards[i])); return o; }
    function firstOther(vals, exclude) { for (var i = 0; i < vals.length; i++) if (vals[i] !== exclude) return vals[i]; return 0; }
    function firstOtherPair(vals, a, b) { for (var i = 0; i < vals.length; i++) if (vals[i] !== a && vals[i] !== b) return vals[i]; return 0; }

    function compareScores(a, b) {
        var n = Math.max(a.length, b.length);
        for (var i = 0; i < n; i++) {
            var x = a[i] || 0, y = b[i] || 0;
            if (x !== y) return x - y;
        }
        return 0;
    }
    // Best score for a seat given its 2 hole cards + the community board.
    function evalSeat(hole, board) { return score(hole.concat(board)); }

    // ── seating helpers ─────────────────────────────────────────────────────────
    function nextSeat(st, seat) { return (seat + 1) % st.numPlayers; }
    // Next seat that can still voluntarily act (in the hand, not folded, not all-in, has chips).
    function nextToAct(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (seat + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) return s;
        }
        return -1;
    }
    // First seat left of the button that is still in the hand (used to open postflop streets).
    function firstLeftOfButton(st) {
        for (var k = 1; k <= st.numPlayers; k++) {
            var s = (st.button + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s]) return s;
        }
        return -1;
    }
    function activeCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) n++; return n; }
    function canActCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) n++; return n; }

    // ── hand lifecycle ────────────────────────────────────────────────────────────
    // Move `amt` chips from a seat's stack into the pot; caps at the stack (all-in) and
    // tracks both this-street bet and the hand-total committed (for side pots).
    function putIn(st, seat, amt) {
        var pay = Math.min(amt, st.stacks[seat]);
        st.stacks[seat] -= pay;
        st.bet[seat] += pay;
        st.committed[seat] += pay;
        if (st.stacks[seat] === 0) st.allIn[seat] = true;
        return pay;
    }

    // Start a fresh hand. `stacks` is per-seat chips; seats with 0 chips sit out (not inHand).
    // Blinds are posted, hole cards dealt, action set to the correct opener.
    //
    // ONLINE: pass seed=null. The deck stays EMPTY (the server owns it), no hole cards are
    // dealt, and dealBoard/showdown/finish become no-ops (see st.online guards) — the client
    // fills board/hole/winners from the server's public event log instead. Everything else
    // (blinds, currentBet, whose turn) is CARD-INDEPENDENT, so the client's replay of the
    // betting is byte-identical to the server's authority with no deck knowledge at all.
    function newHand(numPlayers, button, stacks, sb, bb, seed) {
        var online = (seed == null);
        var deck = online ? [] : freshDeck(makeRng(seed));
        var st = {
            numPlayers: numPlayers, button: button, sb: sb, bb: bb, online: online,
            deck: deck, hole: [], board: [],
            stacks: stacks.slice(),
            bet: [], committed: [], folded: [], allIn: [], inHand: [], acted: [],
            street: "preflop", currentBet: 0, minRaise: bb,
            toAct: -1, lastAggressor: -1,
            pots: [], result: null
        };
        for (var s = 0; s < numPlayers; s++) {
            st.bet.push(0); st.committed.push(0); st.folded.push(false);
            st.allIn.push(false); st.acted.push(false);
            st.inHand.push(stacks[s] > 0);
            st.hole.push([]);
        }
        // The button MUST sit on an occupied seat: a tournament caller rotates the button
        // blindly and it can land on a busted (0-chip) seat, which would otherwise post a
        // blind on an empty seat (heads-up branch) and hang the hand. Normalise it here.
        if (!st.inHand[button]) button = nextOccupied(st, button);
        st.button = button;
        // deal 2 hole cards to each in-hand seat (button+1 first, like a real deal). Online the
        // deck is empty and hole cards arrive privately per seat, so skip the deal.
        if (!online) for (var round = 0; round < 2; round++) {
            for (var k = 1; k <= numPlayers; k++) {
                var seat = (button + k) % numPlayers;
                if (st.inHand[seat]) st.hole[seat].push(st.deck.shift());
            }
        }
        // blinds. Heads-up: button posts the small blind and acts first preflop.
        var sbSeat, bbSeat;
        if (activeSeatCount(st) === 2) {
            sbSeat = button; bbSeat = nextOccupied(st, button);
        } else {
            sbSeat = nextOccupied(st, button); bbSeat = nextOccupied(st, sbSeat);
        }
        putIn(st, sbSeat, sb);
        putIn(st, bbSeat, bb);
        st.currentBet = bb;
        st.minRaise = bb;
        st.bbSeat = bbSeat;
        // preflop opener = seat left of the big blind (UTG); heads-up = the SB/button.
        st.toAct = (activeSeatCount(st) === 2) ? sbSeat : nextToAct(st, bbSeat);
        return st;
    }
    function activeSeatCount(st) { var n = 0; for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s]) n++; return n; }
    function nextOccupied(st, seat) {
        for (var k = 1; k <= st.numPlayers; k++) { var s = (seat + k) % st.numPlayers; if (st.inHand[s]) return s; }
        return seat;
    }

    // What can `seat` legally do right now?
    function legalActions(st, seat) {
        var out = { canFold: false, canCheck: false, canCall: false, callAmount: 0,
                    canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
        if (st.street === "over" || st.street === "showdown") return out;
        if (seat !== st.toAct || !st.inHand[seat] || st.folded[seat] || st.allIn[seat]) return out;
        var toCall = st.currentBet - st.bet[seat];
        out.canFold = true;
        if (toCall <= 0) out.canCheck = true;
        else { out.canCall = true; out.callAmount = Math.min(toCall, st.stacks[seat]); }
        // A raise needs chips beyond the call. Min raise-to = currentBet + last raise size,
        // capped by the stack (a short stack can shove for less as an all-in).
        var maxTo = st.bet[seat] + st.stacks[seat];
        if (maxTo > st.currentBet) {
            out.canRaise = true;
            out.minRaiseTo = Math.min(maxTo, st.currentBet + st.minRaise);
            out.maxRaiseTo = maxTo;
        }
        return out;
    }

    // Apply an action for the seat to act. action = {type:"fold"|"check"|"call"|"raise", to?}.
    // Returns true on success. Advances the turn, closes the street, and runs showdown as
    // needed. Illegal actions are rejected (return false) so the server can validate.
    function applyAction(st, seat, action) {
        var la = legalActions(st, seat);
        var t = action.type;
        if (t === "fold") {
            if (!la.canFold) return false;
            st.folded[seat] = true;
        } else if (t === "check") {
            if (!la.canCheck) return false;
        } else if (t === "call") {
            if (!la.canCall) return false;
            putIn(st, seat, st.currentBet - st.bet[seat]);
        } else if (t === "raise" || t === "bet") {
            if (!la.canRaise) return false;
            var to = action.to | 0;
            // clamp: at least minRaiseTo (unless it's an all-in shove), at most the whole stack
            if (to > la.maxRaiseTo) return false;
            if (to < la.minRaiseTo && to !== la.maxRaiseTo) return false;
            var raiseSize = to - st.currentBet;
            putIn(st, seat, to - st.bet[seat]);
            // A full-size raise reopens the action; a short all-in that doesn't reach the
            // min-raise does NOT (matched players don't get to re-raise). Standard NLHE.
            if (raiseSize >= st.minRaise) st.minRaise = raiseSize;
            st.currentBet = Math.max(st.currentBet, st.bet[seat]);
            st.lastAggressor = seat;
            resetActedExcept(st, seat);
        } else {
            return false;
        }
        st.acted[seat] = true;
        advance(st);
        return true;
    }
    function resetActedExcept(st, seat) {
        for (var s = 0; s < st.numPlayers; s++) if (s !== seat) st.acted[s] = false;
    }

    // Is the current betting round complete?
    function roundOver(st) {
        for (var s = 0; s < st.numPlayers; s++) {
            if (!st.inHand[s] || st.folded[s] || st.allIn[s]) continue;
            if (!st.acted[s]) return false;
            if (st.bet[s] !== st.currentBet) return false;
        }
        return true;
    }

    function advance(st) {
        // everyone but one folded → that player wins the whole pot immediately
        if (activeCount(st) <= 1) { finish(st); return; }
        // at most one player can still act → no more betting; run out the board
        if (canActCount(st) <= 1 && roundOver(st)) { runout(st); return; }
        if (roundOver(st)) { nextStreet(st); return; }
        var nxt = nextToAct(st, st.toAct);
        st.toAct = nxt;
    }

    var STREETS = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" };
    // Online the deck is empty and the board is filled from the server's BOARD events, so
    // dealing is a no-op here — betting never reads st.board, only the display does.
    function dealBoard(st, n) { if (st.online) return; for (var i = 0; i < n; i++) st.board.push(st.deck.shift()); }

    function nextStreet(st) {
        // clear the street's bets (committed already holds them for side pots)
        for (var s = 0; s < st.numPlayers; s++) { st.bet[s] = 0; st.acted[s] = false; }
        st.currentBet = 0; st.minRaise = st.bb; st.lastAggressor = -1;
        var nx = STREETS[st.street];
        if (nx === "flop") dealBoard(st, 3);
        else if (nx === "turn" || nx === "river") dealBoard(st, 1);
        st.street = nx;
        if (nx === "showdown") { showdown(st); return; }
        // if nobody can voluntarily act anymore, run the rest of the board out
        if (canActCount(st) <= 1) { runout(st); return; }
        st.toAct = firstLeftOfButton(st);
        if (st.toAct >= 0 && (st.folded[st.toAct] || st.allIn[st.toAct] || st.stacks[st.toAct] === 0))
            st.toAct = nextToAct(st, st.toAct);
    }

    // All betting is done but the board isn't complete (players all-in) → deal remaining
    // community cards and go to showdown.
    function runout(st) {
        while (st.street !== "showdown") {
            var nx = STREETS[st.street];
            if (nx === "flop") dealBoard(st, 3);
            else if (nx === "turn" || nx === "river") dealBoard(st, 1);
            st.street = nx;
        }
        showdown(st);
    }

    // A seat abandons the table mid-game (online "Leave"). It plays out EXACTLY like a fold —
    // card-independent, so the server and every client replay it byte-identically off a single
    // LEFT event — plus the leaver forfeits their remaining chips so `newHand`'s `stacks[s] > 0`
    // test sits them out of every future hand. Folding a seat that wasn't `toAct` can still end
    // the hand (everyone else already folded) or complete the round (they were the last to act),
    // so we re-run the same terminal checks `advance` does, but only hand `toAct` forward when the
    // LEAVER was the one on the clock (otherwise the current actor keeps their turn).
    function leaveSeat(st, seat) {
        var wasLive = st.inHand[seat] && !st.folded[seat];
        st.stacks[seat] = 0;                       // forfeit remaining chips → out of all future hands
        if (!wasLive) return;
        st.folded[seat] = true;
        st.acted[seat] = true;                     // don't let roundOver wait on a seat that's gone
        var wasToAct = st.toAct === seat;
        if (activeCount(st) <= 1) { finish(st); return; }
        if (canActCount(st) <= 1 && roundOver(st)) { runout(st); return; }
        if (roundOver(st)) { nextStreet(st); return; }
        if (wasToAct) st.toAct = nextToAct(st, st.toAct);
    }

    // Single player left (all others folded): they take the pot uncontested, no cards shown.
    function finish(st) {
        var winner = -1;
        for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) { winner = s; break; }
        var total = 0;
        for (s = 0; s < st.numPlayers; s++) total += st.committed[s];
        if (winner >= 0) st.stacks[winner] += total;
        st.pots = [{ amount: total, winners: winner >= 0 ? [winner] : [] }];
        st.result = { winners: winner >= 0 ? [winner] : [], uncontested: true };
        st.street = "over";
        st.toAct = -1;
    }

    // Build side pots from committed[], then award each pot to the best eligible hand(s).
    // ONLINE the hole cards aren't known during the betting replay (they arrive later as SHOW
    // events), so defer: freeze the hand at "showdown" with no result and let the client call
    // resolveShowdown(st) once it has populated st.hole from the events. Side pots are built
    // from committed[] (card-independent) so the deferred resolution is identical to the server.
    function showdown(st) {
        if (st.online && !st._resolving) { st.street = "showdown"; st.toAct = -1; return; }
        var contribs = st.committed.slice();
        var pots = [];
        while (true) {
            var min = Infinity, any = false, s;
            for (s = 0; s < st.numPlayers; s++) if (contribs[s] > 0) { any = true; if (contribs[s] < min) min = contribs[s]; }
            if (!any) break;
            var amount = 0, eligible = [];
            for (s = 0; s < st.numPlayers; s++) {
                if (contribs[s] > 0) {
                    amount += min; contribs[s] -= min;
                    if (!st.folded[s]) eligible.push(s);   // folded chips are dead money
                }
            }
            pots.push({ amount: amount, eligible: eligible });
        }
        // evaluate every contender once
        var scores = {};
        for (var i = 0; i < st.numPlayers; i++)
            if (st.inHand[i] && !st.folded[i]) scores[i] = evalSeat(st.hole[i], st.board);

        var resultPots = [];
        for (i = 0; i < pots.length; i++) {
            var p = pots[i];
            var best = null, winners = [];
            for (var j = 0; j < p.eligible.length; j++) {
                var seat = p.eligible[j], sc = scores[seat];
                if (!best || compareScores(sc, best) > 0) { best = sc; winners = [seat]; }
                else if (compareScores(sc, best) === 0) winners.push(seat);
            }
            distribute(st, p.amount, winners);
            resultPots.push({ amount: p.amount, winners: winners.slice() });
        }
        st.pots = resultPots;
        st.result = { winners: mergeWinners(resultPots), scores: scores, uncontested: false };
        st.street = "over";
        st.toAct = -1;
    }
    // Split a pot among winners; odd chips go to the first winner left of the button.
    function distribute(st, amount, winners) {
        if (winners.length === 0) return;
        var each = Math.floor(amount / winners.length);
        var rem = amount - each * winners.length;
        var ordered = winners.slice().sort(function (a, b) {
            return seatOrderFromButton(st, a) - seatOrderFromButton(st, b);
        });
        for (var i = 0; i < ordered.length; i++) st.stacks[ordered[i]] += each;
        for (i = 0; i < rem; i++) st.stacks[ordered[i]] += 1;
    }
    function seatOrderFromButton(st, seat) { return (seat - st.button + st.numPlayers) % st.numPlayers; }
    function mergeWinners(pots) {
        var set = {}, out = [];
        for (var i = 0; i < pots.length; i++) for (var j = 0; j < pots[i].winners.length; j++) set[pots[i].winners[j]] = 1;
        for (var k in set) if (set.hasOwnProperty(k)) out.push(parseInt(k, 10));
        return out;
    }
    function totalPot(st) { var t = 0; for (var s = 0; s < st.numPlayers; s++) t += st.committed[s]; return t; }

    // ONLINE showdown resolver: the client calls this after filling st.hole (from SHOW events)
    // and st.board (from BOARD events) for a hand that reached "showdown" via the deferred path
    // above. Runs the SAME side-pot + eval logic and awards the pots, so the online result is
    // identical to the server's without the client ever seeing the deck.
    function resolveShowdown(st) {
        if (st.street !== "showdown") return;
        st._resolving = true;
        showdown(st);
        st._resolving = false;
    }

    // ── bot ─────────────────────────────────────────────────────────────────────
    // A deterministic, honest-but-cautious bot. Preflop it rates its two cards; postflop it
    // rates its made hand's category. It calls small bets, raises with strength, and folds
    // weak hands to real pressure — plenty for a friendly table, no bluff modelling.
    function preflopStrength(hole) {
        var a = cardVal(hole[0]), b = cardVal(hole[1]);
        var hi = Math.max(a, b), lo = Math.min(a, b);
        var pair = a === b, suited = suitOf(hole[0]) === suitOf(hole[1]);
        var gap = hi - lo;
        var s = 0;
        if (pair) s = 0.5 + hi / 28;                       // 0.57 (22) … 1.0 (AA)
        else {
            s = (hi + lo) / 40;                            // high-card weight
            if (suited) s += 0.08;
            if (gap === 1) s += 0.06; else if (gap === 2) s += 0.03;
            if (hi === 14) s += 0.05;
        }
        return s;
    }
    function madeStrength(st, seat) {
        var sc = evalSeat(st.hole[seat], st.board);
        return sc[0] / 8 + (sc[1] || 0) / 200;             // category dominates, top rank breaks ties
    }
    function botAction(st, seat, rng) {
        var la = legalActions(st, seat);
        if (!la.canFold && !la.canCheck) return { type: "check" };
        var r = rng ? rng() : 0.5;
        var strength = (st.street === "preflop") ? preflopStrength(st.hole[seat]) : madeStrength(st, seat);
        var toCall = la.canCall ? la.callAmount : 0;
        var pot = totalPot(st);
        var potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

        // strong hand → raise sometimes
        if (la.canRaise && strength > 0.6 && r < 0.6) {
            var target = st.currentBet + Math.max(st.minRaise, Math.floor(pot * (0.5 + strength * 0.5)));
            target = Math.min(target, la.maxRaiseTo);
            target = Math.max(target, la.minRaiseTo);
            return { type: "raise", to: target };
        }
        if (la.canCheck) {
            if (la.canRaise && strength > 0.72 && r < 0.5) {
                var t2 = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, st.bb * 3));
                return { type: "raise", to: t2 };
            }
            return { type: "check" };
        }
        // facing a bet: call when the hand beats the pot odds (plus a margin), else fold
        if (la.canCall && strength >= potOdds + 0.15) return { type: "call" };
        if (la.canCall && toCall <= st.bb && strength > 0.25) return { type: "call" };  // cheap peek
        return { type: "fold" };
    }

    R.poker = {
        SUIT_CHARS: SUIT_CHARS, RANK_CHARS: RANK_CHARS, DECK_SIZE: DECK_SIZE,
        suitOf: suitOf, rankOf: rankOf, cardVal: cardVal, makeRng: makeRng, freshDeck: freshDeck,
        straightHigh: straightHigh, score: score, compareScores: compareScores, evalSeat: evalSeat,
        nextSeat: nextSeat, nextToAct: nextToAct, firstLeftOfButton: firstLeftOfButton,
        activeCount: activeCount, canActCount: canActCount, totalPot: totalPot,
        newHand: newHand, legalActions: legalActions, applyAction: applyAction, leaveSeat: leaveSeat,
        roundOver: roundOver, showdown: showdown, resolveShowdown: resolveShowdown,
        nextOccupied: nextOccupied, activeSeatCount: activeSeatCount,
        preflopStrength: preflopStrength, madeStrength: madeStrength, botAction: botAction
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
    // In-memory per-IP sliding window for the lobby-FORMATION routes (create/join family).
    // Lives on the single Durable Object instance, so every request sees the same counters
    // (no KV lag). Keyed by CF-Connecting-IP: legit players sit on distinct IPs and never
    // approach the cap, while a brute-forcer sweeping the 4-digit code space or flooding
    // `create` is one IP and gets throttled. A null IP (local/tests) is exempt (fails open),
    // and the HOT read/poll loop is DELIBERATELY never throttled — a (9,x) sentinel there
    // would be misread by the poll decoder as a real move. Bounded to RL_MAX_IPS entries so
    // the map itself can't be used to exhaust memory.
    this.rl = new Map();          // ip -> array of recent request timestamps (ms)
  }

  // Sliding-window rate check for one IP. Returns true if this request is ALLOWED. A null/
  // empty IP is always allowed (local dev + the test harness send no CF-Connecting-IP). Prunes
  // timestamps older than the window on each call, and evicts the oldest IP once the map is
  // full so a spoofed-IP flood can't grow it without bound.
  rateOk(ip) {
    if (!ip) return true;
    const now = Date.now();
    let hits = this.rl.get(ip);
    if (!hits) {
      if (this.rl.size >= RL_MAX_IPS) { const first = this.rl.keys().next().value; if (first !== undefined) this.rl.delete(first); }
      hits = [];
      this.rl.set(ip, hits);
    }
    // Drop timestamps outside the window (in place, cheap for small arrays).
    let k = 0;
    for (let i = 0; i < hits.length; i++) if (now - hits[i] < RL_WINDOW_MS) hits[k++] = hits[i];
    hits.length = k;
    if (hits.length >= RL_MAX_HITS) return false;
    hits.push(now);
    return true;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Panorama's <Image> loader only fetches URLs that look like an image, so the
    // client appends ".png" to every route. Strip it here before routing.
    const p = url.pathname.replace(/\.png$/, "");
    const q = url.searchParams;
    // Normalise `code` to a canonical 4-digit integer string, or "" if it isn't one. All
    // real lobby codes are 1000..9999 (freshCode), so anything else (unicode, "1e3", a
    // giant string) can never name a live lobby — reject it here so it can't create junk
    // "l:<garbage>" keys or match via loose string coercion. "" makes every `code ? …`
    // guard below fall straight to the missing/gone branch.
    const code = validCode(q.get("code"));

    // Rate-limit the formation + existence-probe routes by client IP (Cloudflare sets
    // CF-Connecting-IP; absent locally / in tests → fails open). (9,4) is a dedicated
    // "slow down" marker the throttled client methods surface as a friendly retry, and
    // it can never be confused with a real reply on these routes.
    if (THROTTLED_ROUTES[p] && !this.rateOk(request.headers.get("CF-Connecting-IP"))) {
      return png(9, 4);
    }

    try {
      if (p === "/api/probe") return png(600, 1000);
      if (p === "/api/ping") return png(1, 1);

      if (p === "/api/create") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        if (!SUPPORTED_GAMES[game]) return png(9, 6);      // unsupported game id (6..9 have no engine)

        if (!validTok(q.get("tok"))) return png(9, 3);     // reject empty/garbage seat token
        const newCode = await this.freshCode();

        const tc = clockSecFor(game, q.get("tc"));         // 0 unless chess/checkers with a bank
        const lobby = {
          game, players: 1, moves: [], pub: 0, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null], // seat 0 = host = white/X/+1, moves first
          turn: 0,                                     // seat index whose turn it is
          tc: tc,                                      // per-seat bank in SECONDS (0 = no clock)
          state: initState(game)                       // authoritative board/state
        };
        initClock(lobby);
        await this.storage.put("l:" + newCode, lobby);
        // Split the 4-digit code across both dimensions to keep them small.
        return png(Math.floor(newCode / 100), (newCode % 100) + 1);
      }

      if (p === "/api/quick") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        if (!SUPPORTED_GAMES[game]) return png(9, 6);      // unsupported game id (6..9 have no engine)
        if (!validTok(q.get("tok"))) return png(9, 3);     // reject empty/garbage seat token

        // TIME-CONTROL matchmaking (chess/checkers only; other games have no bank). The picker
        // sends tc = concrete SECONDS (60/180/300/600) or the literal "any". Searchers pool by
        // (game, tc-bucket) so a 1-min seeker never gets force-matched into a 10-min waiter:
        //   • concrete T  → join a same-T waiter, else an "any" waiter (which then adopts T),
        //                   else host a T lobby.
        //   • "any"       → join ANY waiter (adopt its bank; if that waiter is itself "any",
        //                   the game resolves to 5 min), else host an "any" lobby.
        // Non-clock games ignore tc entirely and share one bucket ("0"). Single-quick queues use
        // the prefix pubq:q:<game>:<bucket> so they never collide with mquick's pubq:<game>.
        const clockGame = !!CLOCK_GAMES[game];
        const rawTc = q.get("tc");
        const wantAny = clockGame && rawTc === "any";
        const wantTc = clockGame && !wantAny ? clockSecFor(game, rawTc) : 0;  // concrete secs, else 0
        // The bank this seeker will impose once paired: a concrete pick fixes to itself; "Any"
        // resolves to 5 min against an unbanked/undecided host. (When joining a single-quick host
        // that already holds a concrete bank, that host's bank stands instead — see below.)
        const seekerTc = clockGame ? (wantAny ? 300 : wantTc) : 0;
        // Candidate queues to try joining, in order:
        //   • single-quick tc buckets (pubq:q:<game>:<bucket>) — a concrete seeker also accepts an
        //     "any" host; an "any" seeker sweeps every bucket.
        //   • the shared mquick queue (pubq:<game>) — an undecided multi-select host (game 0) whose
        //     candidate set includes this game; finalizeJoin fixes the game for it.
        // Each entry is [storageKey, isMquickQueue].
        const buckets = !clockGame ? ["0"]
          : wantAny ? ["60", "180", "300", "600", "any"]
          : [String(wantTc), "any"];
        const qkey = (b) => "pubq:q:" + game + ":" + b;
        const queues = buckets.map((b) => [qkey(b), false]);
        queues.push(["pubq:" + game, true]);   // mquick multi-hosts live here (undecided game 0)

        for (let i = 0; i < queues.length; i++) {
          const waitCode = await this.storage.get(queues[i][0]);
          if (!waitCode) continue;
          const w = await this.storage.get("l:" + waitCode);
          const isMulti = w && w.game === 0 && w.games && w.games.indexOf(game) >= 0;
          if (w && w.pub && w.players < 2 && (w.game === game || isMulti)) {
            // Resolve the bank now that both seats are known:
            //   • single-quick host with a concrete bank (w.tc>0, not qtcAny) → that bank stands.
            //   • single-quick "any" host (qtcAny) or an mquick multi-host (no bank) → the seeker
            //     imposes seekerTc (its own concrete T, or 5 min if it too asked for "Any").
            if (!clockGame) w.tc = 0;
            else if (w.qtcAny || isMulti || !w.tc) { w.tc = seekerTc; delete w.qtcAny; }
            // else the host's concrete w.tc stands and the joiner plays at it.
            await this.finalizeJoin(waitCode, w, q.get("tok"), game);
            return png(Math.floor(waitCode / 100), (waitCode % 100) + 1); // JOINER (black)
          }
          // stale/closed slot — try the next queue, then fall through to hosting.
        }

        // No match: host a fresh public lobby in OUR bucket and wait.
        const hostBucket = !clockGame ? "0" : wantAny ? "any" : String(wantTc);
        const newCode = await this.freshCode();
        const lobby = {
          game, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null], // host takes seat 0 (white/X/+1)
          turn: 0,
          tc: clockGame && !wantAny ? wantTc : 0,      // concrete bank, or 0 while an "any" host is unresolved
          qtcAny: clockGame && wantAny ? 1 : 0,        // unresolved "any" host — its bank is fixed at join
          qk: qkey(hostBucket),                        // the queue slot this lobby holds (for clearQueuesFor)
          state: initState(game)
        };
        initClock(lobby);
        await this.storage.put("l:" + newCode, lobby);
        await this.storage.put(qkey(hostBucket), newCode);
        // HOST (white): +100 on the width flags the role without a fragile extra value.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }

      // Multi-select quick match. The caller sends a SET of games it will accept
      // (games=1,2,4,5 — the uplink is unlimited, so the whole set rides up freely).
      // A joiner takes any waiting host whose game (or candidate set) intersects ours,
      // FIXING the lobby to the matched game. With no match, we host ONE undecided lobby
      // (game 0) registered in EVERY selected per-game queue; the first joiner to pick one
      // of them fixes the game. Both sides learn the chosen game from /api/status (its
      // height carries game+1), so no extra downlink value is needed.
      if (p === "/api/mquick") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return png(9, 3);     // reject empty/garbage seat token
        const set = parseGameSet(q.get("games"));
        if (set.length === 0) return png(9, 6);            // no valid multi-capable game ids
        for (let i = 0; i < set.length; i++) {
          const g = set[i];
          const waitCode = await this.storage.get("pubq:" + g);
          if (!waitCode) continue;
          const w = await this.storage.get("l:" + waitCode);
          if (w && w.pub && w.players < 2 &&
              (w.game === g || (w.game === 0 && w.games && w.games.indexOf(g) >= 0))) {
            await this.finalizeJoin(waitCode, w, q.get("tok"), g);
            return png(Math.floor(waitCode / 100), (waitCode % 100) + 1); // JOINER
          }
        }
        const newCode = await this.freshCode();
        const lobby = {
          game: 0, games: set, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null],      // host takes seat 0
          turn: 0,
          state: null                                      // fixed once a joiner picks a game
        };
        await this.storage.put("l:" + newCode, lobby);
        for (let i = 0; i < set.length; i++) await this.storage.put("pubq:" + set[i], newCode);
        // HOST: +100 on the width flags the role, exactly like /api/quick.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }

      if (p === "/api/cancel") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        // Only a SEATED player (valid token) may cancel, and only while the lobby is still
        // waiting for the second player. Never let a 4-digit code-guesser nuke an active match.
        if (lobby && seatOf(lobby, q.get("tok")) >= 0 && lobby.players < 2) {
          await this.storage.delete("l:" + code);
          await this.clearQueuesFor(lobby, code); // clear every per-game queue this lobby holds
        }
        return png(1, 1);
      }

      // ── leave a game already in progress ──────────────────────────────────────
      // `cancel` only fires while a lobby is still waiting (players < 2). Once a match is live,
      // the "Leave" button hits THIS route so the opponent learns immediately instead of relying
      // on the 30-min idle sweep. A valid seat token is the anchor of trust — a 4-digit
      // code-guesser holds no seat token, so it can never nuke someone else's active match.
      //   • Pair games (board games, or any table down to its last two present players): the lobby
      //     is deleted, so the survivor's next poll/dlog/plog — and any action — returns (9,9) and
      //     the client shows "Opponent left." (they win a decided game).
      //   • 3–4-seat durak/poker with ≥3 present: the seat is folded out via durakLeave/pokerLeave,
      //     which appends a LEFT event (+ DRAW/ROLES or board/WIN) to the public log so the table
      //     plays on without the leaver. The game only ends here if it drops to one player.
      if (p === "/api/leave") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(1, 1);                       // already gone — nothing to do
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(1, 1);                     // not a seated player: ignore, don't leak
        lobby.left = lobby.left || [];
        if (lobby.left.indexOf(seat) < 0) lobby.left.push(seat);
        const started = !!(lobby.state && lobby.state.started);
        const present = lobby.players - lobby.left.length;  // still-seated players after this leave
        const isMultiSeat = !!lobby.cap && (lobby.game === 3 || lobby.game === 6);
        if (started && isMultiSeat && present >= 2) {
          // Table plays on without the leaver: fold them out and log it.
          if (lobby.game === 3) durakLeave(lobby, seat);
          else pokerLeave(lobby, seat);
          lobby.t = nowSeq();
          await this.storage.put("l:" + code, lobby);
          return png(1, 1);
        }
        // Pair game, pre-start lobby, or the table just dropped to one player → tear it down.
        await this.storage.delete("l:" + code);
        await this.clearQueuesFor(lobby, code);
        return png(1, 1);
      }


      if (p === "/api/join") {
        if (!validTok(q.get("tok"))) return png(9, 3); // reject empty/garbage seat token
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(20, 1);             // missing
        // Game-type guard (H2): the generic 2-seat join hard-sets players=2/seats[1], which would
        // CORRUPT an N-seat poker/durak lobby (those carry `cap` and grow via seats.push through
        // pjoin/djoin). A poker lobby (game 6) is never joinable here either. Refuse both so a
        // guessed code can't clobber a multi-seat table — the client already routes them to
        // pjoin/djoin, so a legitimate joiner never hits this path.
        if (lobby.cap || lobby.game === 6) return png(20, 1); // not a generic 2-seat lobby → "missing"
        if (lobby.players >= 2) return png(21, 1); // full

        lobby.players = 2;
        lobby.seats = lobby.seats || [null, null];
        lobby.seats[1] = { tok: q.get("tok") || "" }; // joiner takes seat 1
        initClock(lobby);                          // arm the bank now that both seats are present
        await this.storage.put("l:" + code, lobby);
        // height carries the time control (seconds+1) so the joiner learns the host's chosen
        // bank without picking it. tc=0 → height 1 (no clock), a plain "which game" reply.
        return png(lobby.game, (lobby.tc || 0) + 1); // w: game (1..9) · h: tc seconds + 1
      }

      if (p === "/api/status") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 1);              // gone
        // height carries the chosen game + 1 (1 while an mquick lobby is still undecided,
        // game=0). A multi-select HOST reads it to learn which game a joiner picked; the
        // single-game callers ignore it (they already know their game). Never (9,x).
        return png(lobby.players, (lobby.game || 0) + 1); // w: 1|2 players · h: game+1
      }

      if (p === "/api/move") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);              // no lobby
        if (lobby.players < 2) return png(9, 1);   // can't move before the opponent has joined
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);            // bad / foreign token — caller isn't a seat here
        const from = clampInt(q.get("from"), 0, 0, 63);
        const to = clampInt(q.get("to"), 0, 0, 63);
        const end = clampInt(q.get("end"), 0, 0, 1);
        // Authoritative validation: the server owns the board, enforces whose turn it is,
        // and rejects any illegal move with a (9,x) code. The stored `end` is the one the
        // SERVER computes (never the client's), so a cheat can't forge the turn hand-off.
        // A seat that has already flagged (bank ran out) is out of moves — the game is over on
        // time and the server refuses further play from either side.
        if (clockCheckFlag(lobby) >= 0) { await this.storage.put("l:" + code, lobby); return png(9, 2); }
        const v = validateMove(lobby, seat, from, to, end);
        if (!v.ok) return png(9, v.code);          // (9,1) not your turn · (9,2) illegal
        // Hard ceiling on the move log (poll?since indexes it directly, so it can't be
        // truncated — we refuse to grow it past a size no real game reaches). A legit chess/
        // checkers game is well under 600 plies; MOVE_CAP is pure-abuse territory (two colluding
        // seats shuffling a piece to bloat the DO's storage). Reject as illegal past the cap.
        if (lobby.moves.length >= MOVE_CAP) return png(9, 2);
        lobby.moves.push(v.move);
        lobby.t = nowSeq();                        // keep-alive: TTL is measured from last activity
        // Clock accounting: bill the elapsed time to the seat that just moved, and (only when
        // the move ENDS the turn) start the opponent's clock. Mid-chain hops (checkers multi-
        // jump, v.move.e === 0) keep the SAME clock running — the turn hasn't handed off yet.
        // validateMove already advanced lobby.turn on a hand-off, so it names the next seat.
        clockCharge(lobby, v.move.e === 1, lobby.turn);
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

      // Authoritative clocks. Returns each seat's remaining SECONDS right now:
      //   -> (sec0 + 1, sec1 + 1)     both banks; sec in [0,600] so each int is in [1,601]
      //   -> (9, 999)                 lobby gone
      //   -> (9, 998)                 lobby is UNTIMED (no bank configured)
      // The sentinels live at height >= 900, which a real reading can never reach (max height
      // 601), so they never collide with a genuine clock value the way a bare (9,x) would (9 s
      // left is a perfectly normal reading). Both clients poll this ~1/s and render it verbatim,
      // so they can't disagree on the time or on who flagged: the running seat reaching 0 IS the
      // flag-fall signal (that seat loses), decided by the server clock alone — no /api/timeout.
      if (p === "/api/clocks") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 999);            // gone
        if (!lobby.clkMs) return png(9, 998);      // untimed game → no clocks
        // Persist a freshly-detected flag so the outcome sticks for later polls / moves.
        if (clockCheckFlag(lobby) >= 0) await this.storage.put("l:" + code, lobby);
        const s0 = Math.min(600, Math.max(0, clockSec(lobby, 0)));
        const s1 = Math.min(600, Math.max(0, clockSec(lobby, 1)));
        return png(s0 + 1, s1 + 1);
      }

      if (p === "/api/reset") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        if (seatOf(lobby, q.get("tok")) < 0) return png(9, 3); // only a seated player may reset
        // Rematch = same game, fresh state. The game TYPE is fixed at create time and can
        // never be switched mid-lobby (that would desync / void the opponent's board).
        lobby.moves = [];
        lobby.turn = 0;
        lobby.state = initState(lobby.game);
        initClock(lobby);                          // fresh banks for the rematch
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }

      // Rematch handshake. Both seats poll this from the game-over screen; when BOTH have
      // asked, the server performs the same reset as /api/reset, bumps `gen`, clears the
      // ready flags, and reports (2, gen+1). Until then it reports (1, gen+1) = "waiting".
      //   -> (1, gen+1) I'm marked, waiting for the opponent
      //   -> (2, gen+1) both ready: state was reset THIS call, restart now
      //   -> (9,3) bad/foreign token · (9,9) no lobby
      // The caller passes &gen=<its current generation>. We only ARM a seat's flag when that
      // matches the lobby's live `gen`; a stale poll from BEFORE a restart (old gen) can't
      // re-arm the next rematch, it just reads the bumped gen and the client restarts. This is
      // what stops the flag "sticking" across consecutive rematches (no extra clear round-trip).
      if (p === "/api/rematch") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        if (lobby.players < 2) return png(1, (lobby.gen || 0) + 1); // opponent already left/never joined
        lobby.gen = lobby.gen || 0;
        lobby.rm = lobby.rm || [false, false];
        const callerGen = clampInt(q.get("gen"), 0, 0, 100000);
        if (callerGen === lobby.gen) lobby.rm[seat] = true; // only arm against the live generation
        lobby.t = nowSeq();                                 // keep-alive
        if (lobby.rm[0] && lobby.rm[1]) {
          lobby.moves = [];
          lobby.turn = 0;
          lobby.state = initState(lobby.game);
          initClock(lobby);                        // fresh banks for the rematch
          lobby.gen++;
          lobby.rm = [false, false];
          await this.storage.put("l:" + code, lobby);
          return png(2, lobby.gen + 1);                     // both ready: reset done, gen bumped
        }
        await this.storage.put("l:" + code, lobby);
        return png(1, lobby.gen + 1);                       // waiting for the opponent
      }


      // ── Durak (authoritative dealer, 2 players) ────────────────────────────
      // Separate route set from the 2-int move/poll games: the worker OWNS the deck,
      // hands and seed, deals PRIVATELY per seat via /api/ddraw, and relays PUBLIC events
      // via an indexed /api/dlog. Clients rebuild table/trump/turn/roles/counts from the
      // public log and learn only their OWN card identities privately. All actions require
      // a seat token (tok → seat), which also gates ddraw so a cheat can't read a foreign
      // seat's private cards. Only 2 players are wired for now (3–4 seating is deferred).
      if (p === "/api/room") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 1);                        // gone
        const started = lobby.state && lobby.state.started ? 2 : 1; // h: 2 started, 1 waiting
        return png(lobby.players, started);
      }
      if (p === "/api/start") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const r = durakStart(lobby, seat);
        if (!r.ok) return png(9, r.code);
        lobby.t = nowSeq();                                  // keep-alive: TTL from last activity
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }
      if (p === "/api/dact") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const a = clampInt(q.get("a"), 0, 1, 4);
        const pr = clampInt(q.get("p"), 0, 0, 5);
        const c = clampInt(q.get("c"), 0, 0, 35);
        const r = durakAct(lobby, seat, a, pr, c);
        if (!r.ok) return png(9, r.code);
        lobby.t = nowSeq();                                  // keep-alive: TTL from last activity
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }
      if (p === "/api/dlog") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.pub ? lobby.state.pub[since] : null;
        if (!ev) return png(1, 1);                           // nothing new (no event is (1,1))
        return png(ev.w, ev.h);
      }
      if (p === "/api/ddraw") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);                      // only your own seat's private cards
        const i = clampInt(q.get("i"), 0, 0, 100000);
        const priv = lobby.state && lobby.state.priv ? lobby.state.priv[seat] : null;
        const card = priv ? priv[i] : undefined;
        if (card === undefined || card === null) return png(1, 1); // no card at that index yet
        return png(card + 2, 1);
      }

      // ── Durak N-seat private lobby (2–4 players) ─────────────────────────────────
      // Mirrors the poker lobby routes (pcreate/pjoin/proom): the 2-int move/poll lobby is
      // hard-capped at 2 seats, so a 3–4-player table needs its OWN create/join/room that seats
      // up to `cap`. Once dealt, play runs through the SAME /api/start · /api/dact · /api/dlog ·
      // /api/ddraw handlers above — those are seat-token + state driven and seat-count agnostic,
      // so nothing about the game protocol changes; only lobby formation grows past two seats.
      if (p === "/api/dcreate") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return png(9, 3);
        const cap = clampInt(q.get("n"), 2, 2, 4);           // seat cap 2..4
        const newCode = await this.freshCode();
        const lobby = {
          game: 3, players: 1, moves: [], pub: 0, t: nowSeq(), cap: cap,
          seats: [{ tok: q.get("tok") || "" }],              // host = seat 0
          turn: 0,
          state: initState(3)
        };
        await this.storage.put("l:" + newCode, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }
      if (p === "/api/djoin") {
        if (!validTok(q.get("tok"))) return png(9, 3);
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 3 || !lobby.cap) return png(20, 1); // missing / not an N-seat durak lobby
        if (lobby.state && lobby.state.started) return png(22, 1);       // already started
        if (seatOf(lobby, q.get("tok")) >= 0)                           // idempotent re-join (poll safety)
          return png(lobby.cap, lobby.players);
        if (lobby.players >= lobby.cap) return png(21, 1);              // full
        lobby.seats.push({ tok: q.get("tok") || "" });
        lobby.players++;
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return png(lobby.cap, lobby.players);
      }
      if (p === "/api/droom") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 3 || !lobby.cap) return png(9, 1); // gone / not an N-seat durak lobby
        const started = lobby.state && lobby.state.started ? 100 : 0;
        // width = players joined (+100 once started) · height = seat cap
        return png(lobby.players + started, lobby.cap);
      }

      // ── Poker (authoritative dealer, 2–4 players; its own multi-seat lobby) ──────
      // A poker lobby holds up to `cap` seats (chosen at create). Unlike the 2-int games it is
      // NOT capped at 2 — pjoin fills seats up to cap, and the host starts when ready.
      if (p === "/api/pcreate") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return png(9, 3);
        const cap = clampInt(q.get("n"), 2, 2, 4);           // seat cap 2..4
        const newCode = await this.freshCode();
        const lobby = {
          game: 6, players: 1, pub: 0, t: nowSeq(), cap: cap,
          seats: [{ tok: q.get("tok") || "" }],              // host = seat 0
          state: initState(6)
        };
        await this.storage.put("l:" + newCode, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return png(Math.floor(newCode / 100) + 100, (newCode % 100) + 1);
      }
      if (p === "/api/pjoin") {
        if (!validTok(q.get("tok"))) return png(9, 3);
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(20, 1);   // missing / not a poker lobby
        if (lobby.state && lobby.state.started) return png(22, 1); // already started
        if (seatOf(lobby, q.get("tok")) >= 0)                // idempotent re-join (poll safety)
          return png(lobby.cap || 4, lobby.players);
        if (lobby.players >= (lobby.cap || 4)) return png(21, 1); // full
        lobby.seats.push({ tok: q.get("tok") || "" });
        lobby.players++;
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return png(lobby.cap || 4, lobby.players);
      }
      if (p === "/api/proom") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 1);    // gone
        const started = lobby.state && lobby.state.started ? 100 : 0;
        // width = players joined (+100 once started) · height = seat cap
        return png(lobby.players + started, lobby.cap || 4);
      }
      if (p === "/api/pstart") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const r = pokerStart(lobby, seat);
        if (!r.ok) return png(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }
      if (p === "/api/pact") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const a = clampInt(q.get("a"), 0, 0, 3);
        const to = clampInt(q.get("to"), 0, 0, 5000);
        const r = pokerAct(lobby, seat, a, to);
        if (!r.ok) return png(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }
      if (p === "/api/pnext") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const r = pokerNext(lobby, seat);
        if (!r.ok) return png(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return png(1, 1);
      }
      if (p === "/api/plog") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.log ? lobby.state.log[since] : null;
        if (!ev) return png(1, 1);                           // nothing new
        return png(ev.w, ev.h);
      }
      if (p === "/api/pdraw") {
        const lobby = code ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return png(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return png(9, 3);
        const i = clampInt(q.get("i"), 0, 0, 1);             // exactly 2 hole cards (0,1)
        const hole = lobby.state && lobby.state.serverHole ? lobby.state.serverHole[seat] : null;
        const card = hole ? hole[i] : undefined;
        if (card === undefined || card === null) return png(1, 1);
        return png(card + 2, 1);                             // card+2, like ddraw
      }

      return png(9, 8); // unknown route
    } catch (e) {
      return png(9, 7); // server error marker
    }
  }

  async freshCode() {
    // 4-digit lobby code (1000..9999). Never return a code that's already taken — random
    // probes first, then a full linear scan as a fallback so we can't clobber a live lobby.
    for (let i = 0; i < 200; i++) {
      const c = 1000 + Math.floor(Math.random() * 9000);
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    for (let c = 1000; c <= 9999; c++) {
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    return 0; // server full (extremely unlikely); the client-side create just looks broken
  }

  // Seat a joiner into a waiting host lobby, FIXING the game if the host was a still-
  // undecided multi-select lobby (game 0 → the picked game, and initialise its board now
  // that we know which engine it needs). Clears EVERY per-game queue the host held, so a
  // multi-lobby registered under several games can never be double-joined.
  async finalizeJoin(waitCode, w, tok, game) {
    if (w.game === 0) { w.game = game; w.games = null; w.state = initState(game); }
    w.players = 2;
    w.seats = w.seats || [null, null];
    w.seats[1] = { tok: tok || "" };           // joiner takes seat 1
    initClock(w);                              // (re)anchor the bank to the JOIN moment, so a host that
                                               // waited in the public queue isn't billed for idle matchmaking
    await this.storage.put("l:" + waitCode, w);
    await this.clearQueuesFor(w, waitCode);
  }

  // Remove a lobby's code from every public queue it registered under. Three queue shapes:
  //   • single-quick  → one (game, tc-bucket) slot stored in lobby.qk (pubq:q:<game>:<bucket>)
  //   • multi-select  → one pubq:<game> per candidate game in lobby.games[]
  // Only deletes a queue entry that still points at THIS code (a newer host may have replaced
  // it). Both shapes are cleared idempotently, so a mislabeled lobby can't strand a slot.
  async clearQueuesFor(lobby, code) {
    if (lobby.qk) {
      const wc = await this.storage.get(lobby.qk);
      if (wc != null && Number(wc) === Number(code)) await this.storage.delete(lobby.qk);
    }
    const ids = lobby.games && lobby.games.length ? lobby.games : [lobby.game];
    for (let i = 0; i < ids.length; i++) {
      const g = ids[i];
      if (!g) continue;
      const wc = await this.storage.get("pubq:" + g);
      if (wc != null && Number(wc) === Number(code)) await this.storage.delete("pubq:" + g);
    }
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

// A seat token must be a non-empty, sanely-bounded alphanumeric string. Rejecting junk /
// empty tokens stops us from ever creating an unusable "occupied but tokenless" seat (a
// seat whose empty tok makes seatOf return -1 forever), and the length cap keeps a caller
// from bloating Durable Object storage with a giant token. The client mint is 48 hex-ish
// chars (see MG.Session.newToken), comfortably inside these bounds.
function validTok(tok) {
  return typeof tok === "string" && tok.length >= 8 && tok.length <= 64 && /^[a-z0-9]+$/i.test(tok);
}

// Canonicalise an incoming lobby code. Real codes are 4-digit ints (1000..9999, see
// freshCode); we require the raw param to be EXACTLY four digits and return it as a
// string, else "". Using a strict regex (not parseInt) rejects "1e3", "1000abc",
// " 1000", unicode digits, etc. — so `code` can only ever name a real key or nothing.
function validCode(raw) {
  return typeof raw === "string" && /^[0-9]{4}$/.test(raw) ? raw : "";
}

// ── per-IP rate limit for lobby FORMATION + existence-probe routes ────────────
// Window/cap are tuned so no legitimate flow comes close: a single client makes ~1
// create/quick plus ~1 status|room poll per ~1.5 s (≈8 hits/10 s), and even several
// players sharing one NAT/household IP stay well under RL_MAX_HITS. A brute-forcer
// sweeping the 9000-code space or flooding `create` is one IP and gets capped to
// RL_MAX_HITS/window (≈6 req/s → ~25 min for a full sweep — a real deterrent, and H2
// already blocks multi-seat lobbies from a guessed join). RL_MAX_IPS bounds the map so
// a spoofed-IP flood can't grow it without bound. The in-game hot loop (move/poll/log/
// draw/clocks/rematch) is NEVER gated — a (9,x) throttle sentinel there would be
// misread by the poll decoder as a real move (from=8,to=4) and corrupt the board.
const RL_WINDOW_MS = 10000;   // sliding window length
const RL_MAX_HITS = 60;       // max FORMATION/probe hits per IP per window
const RL_MAX_IPS = 5000;      // cap on tracked IPs (memory bound)
// Hard ceiling on a lobby's monotonic event array (moves[] for the 2-int games, log[] for
// poker). poll/plog `since` indexes these directly, so they can NEVER be truncated — instead
// we refuse to grow them past a size no honest game reaches (a full chess/checkers game is
// well under 600 plies; a 200-chip poker table ends in far fewer events). Only two colluding
// seats deliberately bloating the single DO's storage ever hit it. Reject as illegal past it.
const MOVE_CAP = 4000;
// Routes the limiter guards. Formation (create + every join variant) is the DoS +
// brute-force-join vector; the existence probes (status/room/proom/droom) are how a
// sweeper discovers which of the 9000 codes are live. Everything else — probe/ping
// (calibration must always work), cancel (frees lobbies), and the whole in-game loop —
// is intentionally exempt.
const THROTTLED_ROUTES = {
  "/api/create": 1, "/api/quick": 1, "/api/mquick": 1, "/api/join": 1,
  "/api/pcreate": 1, "/api/pjoin": 1, "/api/dcreate": 1, "/api/djoin": 1,
  "/api/status": 1, "/api/room": 1, "/api/proom": 1, "/api/droom": 1
};

// Game ids the generic /api/create lobby accepts. 3 = durak creates its lobby here too, then
// switches to its own dealer routes (room/start/dact/…). 6 = poker is DELIBERATELY absent: it
// owns a fully separate route set (pcreate/pjoin/pstart/pact/…) because the generic lobby is
// hard-capped at 2 seats and poker seats 2–4. An id outside this set has no engine, so
// create/quick reject it up front and move never relays it.
const SUPPORTED_GAMES = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };

// Games eligible for MULTI-select quick match. Durak (3) is excluded: it uses a wholly
// separate route set (room/start/dact/…), so it can't share the 2-int move/poll lobby a
// multi-lobby becomes. Parse "1,2,4,5" → a de-duplicated, sorted array of valid ids.
const MQUICK_GAMES = { 1: 1, 2: 1, 4: 1, 5: 1 };
function parseGameSet(raw) {
  if (!raw) return [];
  const parts = String(raw).split(",");
  const seen = {}, out = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parseInt(parts[i], 10);
    if (!isNaN(n) && MQUICK_GAMES[n] && !seen[n]) { seen[n] = 1; out.push(n); }
  }
  out.sort(function (a, b) { return a - b; });
  return out;
}


// ── authoritative game clocks ────────────────────────────────────────────────
// Only chess (4) and checkers (1) run a time bank; the picker offers 1/3/5/10 min. tc is
// stored in SECONDS (fits one downlink int: 600 < ~1000). Any other value / game → 0 = no
// clock (TTT/Durak/C4 use their own per-move rule client-side). QUICK forces a fixed 5 min.
const CLOCK_GAMES = { 1: 1, 4: 1 };
const CLOCK_CHOICES = { 60: 1, 180: 1, 300: 1, 600: 1 };
const QUICK_CLOCK_SEC = { 1: 300, 4: 300 };
function clockSecFor(game, raw) {
  if (!CLOCK_GAMES[game]) return 0;
  const n = parseInt(raw, 10);
  return CLOCK_CHOICES[n] ? n : 0;   // reject anything not on the menu (0 = play untimed)
}

// The bank is stored as remaining MILLISECONDS per seat plus, while a side is on the move,
// the wall-clock ms at which its turn began (runStart). remaining(seat) = stored ms minus
// the elapsed run of the active seat, floored at 0. Because both clients read the SAME
// server time via /api/clocks, neither can drift out of agreement and the server alone
// decides flag-fall (remaining hits 0). No clock → clkMs stays null and everything is a no-op.
function initClock(lobby) {
  if (!lobby.tc) { lobby.clkMs = null; return; }
  lobby.clkMs = [lobby.tc * 1000, lobby.tc * 1000];
  lobby.clkRun = 0;                 // seat currently ticking (seat 0 = host moves first)
  lobby.clkStart = Date.now();      // wall-clock ms when the running seat's turn began
  lobby.clkFlag = -1;               // seat that flagged (-1 = nobody yet)
}
// Charge the running seat for the time elapsed since its turn began, and (if `handoff`)
// start the other seat's turn. Call on every accepted move BEFORE reading/persisting.
function clockCharge(lobby, handoff, nextSeat) {
  if (!lobby.clkMs) return;
  const now = Date.now();
  const run = lobby.clkRun;
  lobby.clkMs[run] = Math.max(0, lobby.clkMs[run] - (now - lobby.clkStart));
  if (lobby.clkMs[run] === 0 && lobby.clkFlag < 0) lobby.clkFlag = run;
  if (handoff) { lobby.clkRun = nextSeat; lobby.clkStart = now; }
  else lobby.clkStart = now;        // mid-chain: same seat keeps running, reset the anchor
}
// Remaining SECONDS for a seat right now (rounded up so a live "0:01" isn't shown as flagged
// until it truly hits 0). Reflects the running seat's elapsed time without mutating storage.
function clockSec(lobby, seat) {
  if (!lobby.clkMs) return -1;      // -1 = untimed (client shows no clock)
  let ms = lobby.clkMs[seat];
  if (seat === lobby.clkRun && lobby.clkFlag < 0) ms = Math.max(0, ms - (Date.now() - lobby.clkStart));
  return Math.ceil(ms / 1000);
}
// Has the running seat's bank expired as of now? Persist the flag so the result sticks.
function clockCheckFlag(lobby) {
  if (!lobby.clkMs || lobby.clkFlag >= 0) return lobby.clkFlag;
  const run = lobby.clkRun;
  if (lobby.clkMs[run] - (Date.now() - lobby.clkStart) <= 0) { lobby.clkMs[run] = 0; lobby.clkFlag = run; }
  return lobby.clkFlag;
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
  if (game === 3) return { started: 0, pub: [], priv: [[], []] };                                  // durak (dealt on /api/start)
  if (game === 5) return { board: R.connectfour.initialBoard() };                                  // connect four
  if (game === 6) return { started: 0, pub: [], priv: [], st: null, stacks: null, button: -1 };    // poker (dealt on /api/pstart)
  return null;
}

// Validate a move by the seat holder against the authoritative state. Returns
// { ok:true, move:{f,t,e} } (e computed by the SERVER) or { ok:false, code } where
// code is 1 (not your turn) or 2 (illegal move). Mutates lobby.state / lobby.turn on
// acceptance. A game with no server engine relays unchecked (backward compatible).
function validateMove(lobby, seat, from, to, end) {
  const R = rules();
  // No authoritative engine for this lobby → REJECT. We never blindly relay an unchecked
  // move (that would make the server a dumb, cheatable relay for any unknown game id).
  if (!lobby.state) return { ok: false, code: 2 };
  if (lobby.game === 1) return validateCheckers(R.checkers, lobby, seat, from, to);
  if (lobby.game === 2) return validateTtt(lobby, seat, from, to);
  if (lobby.game === 4) return validateChess(R.chess, lobby, seat, from, to);
  if (lobby.game === 5) return validateConnectFour(R.connectfour, lobby, seat, from, to);
  return { ok: false, code: 2 };
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
  const R = rules();
  const b = lobby.state.board;
  if (seat !== lobby.turn) return { ok: false, code: 1 };
  // Reject any move once the game is already decided (a win line or a full board), so a
  // loser can't keep placing marks and corrupt the finished log.
  if (R.ttt.tttWinner(b) || R.ttt.tttFull(b)) return { ok: false, code: 2 };
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
  if (RC.winner(st.board) || RC.isFull(st.board)) return { ok: false, code: 2 }; // game already over
  if (to !== 7 || from < 0 || from >= RC.COLS) return { ok: false, code: 2 };

  const r = RC.drop(st.board, from, seat === 0 ? 1 : 2);
  if (!r) return { ok: false, code: 2 };     // column full
  st.board = r.board;
  lobby.turn = seat === 0 ? 1 : 0;
  return { ok: true, move: { f: from, t: 7, e: 1 } };
}

/* ─────────────────── Durak authoritative dealer (2–4 players) ──────────────────────
 * Public event encoding (each fits the 2-int downlink, both dims <= ~63; NONE is (1,1)):
 *   TRUMP        (2,  trumpCard+1)
 *   OPEN atk a   (3,  a+1)                     first attacker seat
 *   ROLES a d    (4,  a*4 + d + 1)             post-bout roles: attacker a, defender d (0..3)
 *   PLAY  s c    (10+s, c+1)                   seat s attacks/throws in card c (s 0..3)
 *   COVER p c    (20+p, c+1)                   defender covers table pair p with card c (p 0..5)
 *   TAKE  s      (30+s, 1)                     seat s (defender) takes the table (s 0..3)
 *   BITO         (40,   1)                     table beaten & discarded
 *   DRAW  s n    (50+s, n+1)                   seat s drew n cards from the deck (s 0..3)
 *   OVER  L      (60,   L+2)                   game over; L = fool seat (-1 = draw)
 * ROLES makes the SERVER authoritative over the post-bout rotation (who attacks/defends next),
 * which for 3–4 players depends on refill order + who ran out of cards — state the client can't
 * replay. The 2-player wire is unchanged except for this one extra event after each bout.
 * Private per-seat draws go to state.priv[seat] and are pulled one index at a time via
 * /api/ddraw (gated by the seat token), encoded as (card+2, 1). The +2 is deliberate:
 * card id 0 would otherwise collide with the universal (1,1) "nothing new" marker.
 */
function dpush(st, w, h) { st.pub.push({ w: w, h: h }); }

function durakStart(lobby, seat) {
  const R = rules().durak;
  const st = lobby.state;
  if (!st || st.started) return { ok: true };            // idempotent (already dealt)
  if (seat !== 0) return { ok: false, code: 1 };         // only the host (seat 0) starts
  const n = lobby.players;                               // deal for however many actually seated (2..4)
  if (n < 2) return { ok: false, code: 2 };              // need at least two players
  const seedBuf = new Uint32Array(1); crypto.getRandomValues(seedBuf);
  const seed = seedBuf[0] & 0x7fffffff;                  // SERVER owns the seed (never sent down)
  const g = R.newGame(n, seed);

  st.numPlayers = n;
  st.trump = g.trump; st.trumpCard = g.trumpCard;
  st.deck = g.deck; st.hands = g.hands; st.table = g.table;
  st.attacker = g.attacker; st.defender = g.defender; st.phase = g.phase;
  st.discard = g.discard; st.out = g.out; st.loser = g.loser;
  st.passed = g.passed;                                  // throw-in consensus flags (per seat)
  st.pub = []; st.priv = [];
  for (let s = 0; s < n; s++) st.priv.push([]);
  st.started = 1;
  dpush(st, 2, g.trumpCard + 1);                         // TRUMP
  dpush(st, 3, g.attacker + 1);                          // OPEN(first attacker)
  for (let s = 0; s < n; s++) {
    for (let k = 0; k < g.hands[s].length; k++) st.priv[s].push(g.hands[s][k]);
    dpush(st, 50 + s, g.hands[s].length + 1);            // DRAW(s, 6)
  }
  return { ok: true };
}

// Resolve a bout, then emit DRAW events for the DECK cards each seat picked up during
// refill. A card drawn from the deck is one now in a hand that WAS in the pre-bout deck
// (hands and deck are disjoint before the bout), so hand_after ∩ deckBefore = the draws.
// Table cards a taker picks up were already public, so they are NOT re-emitted.
function durakEndBout(st, took) {
  const R = rules().durak;
  const before = {};
  for (let i = 0; i < st.deck.length; i++) before[st.deck[i]] = 1;
  R.endBout(st, took);
  for (let s = 0; s < st.numPlayers; s++) {
    const drawn = [];
    for (let k = 0; k < st.hands[s].length; k++) if (before[st.hands[s][k]]) drawn.push(st.hands[s][k]);
    if (drawn.length) {
      for (let d = 0; d < drawn.length; d++) st.priv[s].push(drawn[d]);
      dpush(st, 50 + s, drawn.length + 1);               // DRAW(s, n)
    }
  }
  if (st.phase === "over") { dpush(st, 60, st.loser + 2); return; }  // OVER(loser)
  // ROLES(attacker, defender): the SERVER owns the post-bout rotation (it depends on refill,
  // who went `out`, and skip-the-taker rules — all card-state the client can't replay). Emitting
  // it authoritatively frees the client from a fragile local swap, which is only correct for 2
  // players. Encoded as (4, attacker*4 + defender + 1); attacker/defender ∈ 0..3 → h ∈ 1..16.
  dpush(st, 4, st.attacker * 4 + st.defender + 1);
}

// A seat abandons a live durak table. Mirrors durakEndBout's DRAW accounting: snapshot the deck,
// run the shared leaveSeat rule (voids the bout, refills survivors, rotates roles), then emit the
// LEFT event, a DRAW per seat that picked up from the deck, and the authoritative post-leave ROLES
// (or OVER when one player remains). Deterministic → clients replay it off the public log.
function durakLeave(lobby, seat) {
  const R = rules().durak;
  const st = lobby.state;
  if (!st || !st.started || st.phase === "over") return;
  if (st.out[seat]) return;                                 // already gone (idempotent)
  const before = {};
  for (let i = 0; i < st.deck.length; i++) before[st.deck[i]] = 1;
  R.leaveSeat(st, seat);
  dpush(st, 45 + seat, 1);                                  // LEFT(seat)
  for (let s = 0; s < st.numPlayers; s++) {
    const drawn = [];
    for (let k = 0; k < st.hands[s].length; k++) if (before[st.hands[s][k]]) drawn.push(st.hands[s][k]);
    if (drawn.length) {
      for (let d = 0; d < drawn.length; d++) st.priv[s].push(drawn[d]);
      dpush(st, 50 + s, drawn.length + 1);                 // DRAW(s, n)
    }
  }
  if (st.phase === "over") { dpush(st, 60, st.loser + 2); return; }  // OVER(loser)
  dpush(st, 4, st.attacker * 4 + st.defender + 1);         // ROLES(attacker, defender)
}

// A seat abandons a live poker table. Folds them out of the current hand and forfeits their chips
// (leaveSeat sets stack 0 → newHand sits them out forever) via the shared rule, emits LEFT(seat),
// then flushes the board/showdown/WIN the fold may have triggered — exactly like a normal fold.
function pokerLeave(lobby, seat) {
  const R = rules().poker;
  const s = lobby.state;
  if (!s || !s.started) return;
  s.log = s.log || [];
  if (s.st) R.leaveSeat(s.st, seat);
  else if (s.stacks) s.stacks[seat] = 0;                   // between hands: just forfeit the stack
  s.log.push({ w: 50 + seat, h: 1 });                      // LEFT(seat)
  if (s.st && !s.handOver) pokerFlush(lobby);              // fold may have ended the hand
}

// Validate + apply one durak action by the seat holder. a: 1 attack, 2 cover, 3 take, 4 bito.
function durakAct(lobby, seat, a, p, c) {
  const R = rules().durak;
  const st = lobby.state;
  if (!st || !st.started || st.phase === "over") return { ok: false, code: 2 };
  if (a === 1) {                                         // attack / throw-in
    if (!R.canAttackWith(st, seat, c)) {
      // distinguish "not your role/turn" from "illegal card" for a friendlier client message
      if (seat === st.defender) return { ok: false, code: 1 };
      return { ok: false, code: 2 };
    }
    R.applyAttack(st, seat, c);
    dpush(st, 10 + seat, c + 1);
    return { ok: true };
  }
  if (a === 2) {                                         // cover a table pair
    if (seat !== st.defender) return { ok: false, code: 1 };
    if (!R.canDefendPair(st, p, c)) return { ok: false, code: 2 };
    R.applyDefend(st, p, c);                              // resets throw-in passes (fresh window)
    dpush(st, 20 + p, c + 1);
    // If that cover completed the table and NO attack seat has a legal throw-in left, there's
    // nobody to wait on — beat the table immediately rather than dangle for a pass that can't come.
    if (R.canBito(st)) { dpush(st, 40, 1); durakEndBout(st, false); }
    return { ok: true };
  }
  if (a === 3) {                                         // take
    if (seat !== st.defender) return { ok: false, code: 1 };
    if (st.table.length === 0) return { ok: false, code: 2 };
    dpush(st, 30 + seat, 1);
    durakEndBout(st, true);
    return { ok: true };
  }
  if (a === 4) {                                         // pass / knock ("done adding to this table")
    // Classic podkidnoy: an attack seat declares it won't throw in more. The table is BEATEN
    // (Bito) only once EVERY in-play attack seat has settled (passed or holds no legal throw-in) —
    // NOT the moment the primary attacker knocks. So this records the pass authoritatively and
    // only ends the bout when consensus is reached; otherwise it echoes a PASS event so the other
    // clients update their local `passed` set (which gates their own Pass button + status).
    if (seat === st.defender || st.out[seat]) return { ok: false, code: 1 };
    if (st.table.length === 0 || R.uncoveredCount(st) !== 0) return { ok: false, code: 2 };
    R.applyPass(st, seat);
    if (R.canBito(st)) { dpush(st, 40, 1); durakEndBout(st, false); }
    else dpush(st, 41 + seat, 1);                        // PASS(seat) — window stays open for others
    return { ok: true };
  }
  return { ok: false, code: 2 };
}


/* ─────────────────────── Poker (authoritative dealer, 2–4 players) ──────────────────────
 * Its OWN route set, like Durak, because the 2-int move/poll lobby is hard-capped at 2 seats
 * and poker seats 2–4 with a host "Start" gate. The worker owns the deck, seed, button, and
 * every hole card; it deals hole cards PRIVATELY (via /api/pdraw, card+2 like ddraw) and relays
 * only PUBLIC facts through an indexed event log (/api/plog). The client replays the shared
 * poker.applyAction to reconstruct all betting truth (pot / whose turn / legal actions are
 * card-INDEPENDENT), and fills board + revealed hole cards + winners from the log — so it never
 * needs the deck and can't diverge from the server.
 *
 * Public event log entries (each fits the 2-int downlink; width picks the type, height the
 * payload+1; a real entry can never decode to (1,1) = "nothing new"):
 *   HAND   (2, button+1)                     start a fresh hand, dealer button on `button`
 *   FOLD   (10+seat, 1)                      seat folds
 *   CHECK  (20+seat, 1)                      seat checks
 *   CALL   (30+seat, 1)                      seat calls
 *   RAISE  (40+seat, to+1)                   seat raises TO `to` chips (this street)
 *   BOARD  (5, card+1)                       one community card revealed (card 0..51)
 *   SHOW   (60+seat, card+1)                 a hole card of `seat` shown at showdown
 *   WIN    (7, 1)                            hand resolved — client runs resolveShowdown/finish
 *   OVER   (8, 1)                            table over (one player has all the chips)
 * Private draw (/api/pdraw?i=): the i-th hole card the caller was dealt this hand → (card+2, 1),
 * or (1,1) if not dealt yet. The client pulls its 2 hole cards each hand exactly like Durak.
 *
 * Action codes for /api/pact (a, to): a = 0 fold · 1 check · 2 call · 3 raise (to=amount).
 */

// Build the authoritative poker state for a lobby that has `n` seated players. Deals the whole
// hand server-side with a per-hand seed, then converts it into a public event stream + private
// hole cards. Returns the fresh `st` (full, with cards) so the caller can persist it.
function pokerNewHand(lobby) {
  const R = rules().poker;
  const s = lobby.state;
  const n = s.n;                                    // seat count fixed at start
  // rotate the button to the next occupied (non-busted) seat
  let button = s.button;
  const stacks = s.stacks.slice();
  // find next seat with chips for the button (first hand: seat 0)
  if (button < 0) button = 0;
  else { for (let k = 1; k <= n; k++) { const c = (button + k) % n; if (stacks[c] > 0) { button = c; break; } } }
  // SECURITY (C1): the seed MUST be a fresh CSPRNG draw per hand — never derived from
  // lobby.t and never chained through pseed. mulberry32 is fully deterministic, so a
  // predictable seed leaks the entire deck order (every seat's hole cards + the full
  // board) before a bet is placed. Same CSPRNG source durakStart uses (see above).
  const seedBuf = new Uint32Array(1); crypto.getRandomValues(seedBuf);
  const seed = seedBuf[0] & 0x7fffffff;             // SERVER owns the seed (never sent down)
  const st = R.newHand(n, button, stacks, PK_SB, PK_BB, seed);
  s.button = st.button;
  // reset the public log for the hand and stash the private hole cards per seat
  s.hole = st.hole.map((h) => h.slice());           // [[c,c],…] server-only until SHOW
  s.drawn = [];                                      // per-seat: how many hole cards pulled
  for (let i = 0; i < n; i++) s.drawn.push(0);
  s.board = [];                                      // revealed community cards (public)
  s.boardShown = 0;                                  // how many BOARD events emitted so far
  s.shownFor = [];                                   // seats whose hole cards were SHOW-n
  // Replace st.hole/deck with an ONLINE shell so the SERVER also tracks betting via the same
  // shared reducer the client uses — guaranteeing identical validation. The server keeps the
  // real cards in s.hole for private dealing + showdown.
  s.st = R.newHand(n, st.button, stacks, PK_SB, PK_BB, null); // online shell (no cards)
  // BUG (2026-07-18, "three identical 2♠ on the flop online"): newHand deals the board LAZILY —
  // st.board is [] until nextStreet shifts cards off the deck. Reading st.board here captured an
  // empty array, so pokerFlush emitted BOARD(undefined) → PNG h=1 → the client decoded card id 0
  // (= 2♠) for every community card. The 5 board cards are the TOP of the freshly-dealt deck AFTER
  // the 2·n hole cards (dealBoard/runout just shift them in flop/turn/river order), so slice them
  // straight off the deck now. Verified byte-identical to the real runout for every seed.
  s.st.__fullBoard = st.deck.slice(0, 5);             // full 5-card board (server reveals on schedule)
  s.serverHole = st.hole;                             // real hole cards for showdown eval
  // The log is CONTINUOUS across hands so the client's `since` cursor stays monotonic — a HAND
  // event just appends and the client reads it as "new hand, pull my hole cards".
  s.log = s.log || [];
  s.handStart = s.log.length;                         // index of THIS hand's HAND event
  s.log.push({ w: 2, h: st.button + 1 });             // HAND event opens the hand
  s.handOver = 0;
  return s;
}

// Push the BOARD events needed to catch the public board up to the online reducer's street,
// then, if the hand has reached showdown/over, emit SHOW + WIN (or just WIN for uncontested).
function pokerFlush(lobby) {
  const R = rules().poker;
  const s = lobby.state;
  const online = s.st;
  // How many board cards should be visible for the current street? A "showdown" (everyone
  // called down / all-in runout) reveals all five. But an uncontested "over" — everyone
  // folded to one player — reveals NOTHING new: no community card is shown for a hand that
  // never reached a showdown (leaking them was the "board appears after a preflop fold" bug).
  const want = online.street === "flop" ? 3
    : online.street === "turn" ? 4
    : (online.street === "river" || online.street === "showdown") ? 5
    : online.street === "over" ? s.boardShown
    : 0;
  while (s.boardShown < want) {
    const card = s.st.__fullBoard[s.boardShown];
    s.board.push(card);
    s.log.push({ w: 5, h: card + 1 });                // BOARD
    s.boardShown++;
  }
  if ((online.street === "showdown" || online.street === "over") && !s.handOver) {
    // Uncontested (everyone folded) → no cards shown, just resolve. Contested showdown → reveal
    // every non-folded contender's two hole cards, then WIN.
    const contenders = [];
    for (let i = 0; i < s.n; i++) if (online.inHand[i] && !online.folded[i]) contenders.push(i);
    if (contenders.length > 1) {
      for (let j = 0; j < contenders.length; j++) {
        const seat = contenders[j];
        for (let c = 0; c < s.serverHole[seat].length; c++)
          s.log.push({ w: 60 + seat, h: s.serverHole[seat][c] + 1 });   // SHOW
      }
    }
    // Resolve on the SERVER's online reducer using the real cards so stacks stay authoritative.
    online.hole = s.serverHole;
    online.board = s.st.__fullBoard.slice(0, 5);
    R.resolveShowdown(online);
    s.stacks = online.stacks.slice();                 // banked result
    s.log.push({ w: 7, h: 1 });                       // WIN — client resolves locally too
    s.handOver = 1;
    // Table over? one seat holds every chip.
    let alive = 0; for (let i = 0; i < s.n; i++) if (s.stacks[i] > 0) alive++;
    if (alive <= 1) { s.log.push({ w: 8, h: 1 }); s.tableOver = 1; }
  }
}

// Blinds for the online table (match the offline controller: SB 5 / BB 10, 200-chip stacks).
const PK_SB = 5, PK_BB = 10, PK_START = 200;

// Host presses Start: fix the seat count to whoever is seated, deal the first hand.
function pokerStart(lobby, seat) {
  const R = rules().poker;
  const s = lobby.state;
  if (!s) return { ok: false, code: 2 };
  if (s.started) return { ok: true };                 // idempotent
  if (seat !== 0) return { ok: false, code: 1 };       // only the host starts
  const n = lobby.players;
  if (n < 2) return { ok: false, code: 2 };            // need at least two seated
  s.n = n;
  s.button = -1;                                       // first hand normalises to seat 0
  s.stacks = [];
  for (let i = 0; i < n; i++) s.stacks.push(PK_START);
  s.started = 1;
  pokerNewHand(lobby);
  return { ok: true };
}

// Validate + apply one betting action by the seat holder. a: 0 fold · 1 check · 2 call · 3 raise.
function pokerAct(lobby, seat, a, to) {
  const R = rules().poker;
  const s = lobby.state;
  if (!s || !s.started || s.handOver) return { ok: false, code: 2 };
  const online = s.st;
  if (online.toAct !== seat) return { ok: false, code: 1 };  // not your turn
  const action = a === 0 ? { type: "fold" }
    : a === 1 ? { type: "check" }
    : a === 2 ? { type: "call" }
    : { type: "raise", to: to | 0 };
  // Snapshot the log length so we can emit the matching public event for the accepted action.
  if (!R.applyAction(online, seat, action)) return { ok: false, code: 2 }; // illegal
  if (a === 0) s.log.push({ w: 10 + seat, h: 1 });
  else if (a === 1) s.log.push({ w: 20 + seat, h: 1 });
  else if (a === 2) s.log.push({ w: 30 + seat, h: 1 });
  else s.log.push({ w: 40 + seat, h: (to | 0) + 1 });
  pokerFlush(lobby);
  return { ok: true };
}

// Deal the NEXT hand (any seated client may request it once the current hand is over and the
// table isn't finished). Idempotent per hand via s.handOver.
function pokerNext(lobby, seat) {
  const s = lobby.state;
  if (!s || !s.started) return { ok: false, code: 2 };
  if (!s.handOver) return { ok: false, code: 2 };      // current hand still live
  if (s.tableOver) return { ok: false, code: 2 };
  // Bound the continuous log so two colluding seats can't fold forever to bloat the DO's
  // storage (M3). A real 200-chip table ends in a few dozen hands (< a few hundred events);
  // MOVE_CAP is far above any honest game, so this only ever trips on abuse — after which no
  // new hand is dealt and the table effectively ends where it is.
  if (s.log && s.log.length >= MOVE_CAP) return { ok: false, code: 2 };
  pokerNewHand(lobby);
  return { ok: true };
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
