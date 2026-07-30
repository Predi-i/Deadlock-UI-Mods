/* ============================================================================
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Produced by `node tools/build_worker.js` from:
 *   panorama/scripts/rules/*.js                              (shared with client)
 *   server/pixelbattle_map.generated.js                     (generated land mask)
 *   server/admin_panel.js                                   (browser admin assets)
 *   server/worker.core.js                                    (authored core)
 * Edit those sources, then rebuild. See server/README.md.
 * ============================================================================ */

/* ── shared rules (from panorama/scripts/rules/*.js; attach to globalThis.MGRules) ── */
// ---- rules/checkers.js ----
"use strict";

/*
 * rules/checkers.js - pure Russian-draughts rules, shared by BOTH runtimes.
 *
 * SINGLE SOURCE OF TRUTH. The client loads this as a Panorama script (it hangs the
 * functions off $.MG.Rules.checkers); the Cloudflare Worker gets the exact same bytes
 * concatenated by tools/build_worker.js (it hangs them off globalThis.MGRules.checkers).
 * So the predictor on the client and the authority on the server can never disagree.
 *
 * NO DOM, NO rendering, NO network - pure functions only. The only environment thing it
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
    // is captured - this covers both a man's 1-over jump and a flying king's ranged
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
        // steps - but a corrupt/desynced hop must never spin the loop forever.
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

    // Both variants share board encoding, promotion and the bot driver. They differ in
    // (a) their simple/capture generators and (b) what a mid-capture promotion does:
    //   • Russian (promotionEndsTurn=false): a man that reaches the crowning row DURING a
    //     capture becomes a king and MUST keep capturing as a flying king if it can (canon).
    //   • English (promotionEndsTurn=true): promotion ends the turn immediately, even if the
    //     freshly crowned king could jump again.
    // Everything else (turn sequencing, bot) stays in this one factory.
    function makeRules(simpleMovesFor, captureMovesFor, promotionEndsTurn) {
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

        // Draw detection. Without it a king-vs-king endgame shuffles forever: the engine had NO
        // draw rule at all, so an untimed game (the default) could never end and bot-vs-bot
        // self-play hit its move cap ~15% of the time.
        //
        // `idle` is the caller's count of consecutive TURNS with no capture and no man move -
        // exactly the quantity the Russian-draughts 15-move rule bounds. Tracking it needs the
        // game's move history, which these pure per-position functions don't have, so the caller
        // owns the counter (mg_checkers.js pushHistory, which already knows whether the completed
        // turn captured). Omit it and only the position-local draw is reported.
        //
        // Returns "" when the position is not drawn, else a short reason id.
        function drawReason(b, idle) {
            if (idle >= 30) return "idle";               // 30 plies = 15 moves per side
            // Bare kings on both sides with nothing to attack: one king each can never force a win.
            var wk = 0, bk = 0, wm = 0, bm = 0;
            for (var i = 0; i < 64; i++) {
                var v = b[i];
                if (v === 0) continue;
                if (v === 1) wm++; else if (v === 2) wk++;
                else if (v === 3) bm++; else if (v === 4) bk++;
            }
            if (wm === 0 && bm === 0 && wk === 1 && bk === 1) return "kings";
            return "";
        }

        // A sequence is one complete turn. For English (promotionEndsTurn=true) a promotion
        // during a capture ends the turn immediately. For Russian (promotionEndsTurn=false) the
        // newly crowned king must keep capturing as a flying king if it can (canon).
        function captureSequencesFrom(b, i) {
            var caps = captureMovesFor(b, i);
            if (caps.length === 0) return [];
            var seqs = [];
            for (var k = 0; k < caps.length; k++) {
                var mv = caps[k];
                var nb = b.slice();
                var res = applyHop(nb, i, mv.to);
                // English: a promotion ends the turn. Russian: the fresh king (nb already holds
                // the king value, so captureMovesFor routes to the king generator) keeps capturing.
                var canContinue = (!res.promoted || !promotionEndsTurn) && captureMovesFor(nb, mv.to).length > 0;
                if (canContinue) {
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
            promotionEndsTurn: promotionEndsTurn,
            initialBoard: initialBoard,
            simpleMoves: simpleMovesFor, captureMoves: captureMovesFor,
            anyCaptureFor: anyCaptureFor, applyHop: applyHop, hasAnyMove: hasAnyMove,
            drawReason: drawReason,
            legalSequences: legalSequences, chooseBotMove: chooseBotMove, chooseBotMovePrep: chooseBotMovePrep
        };
    }

    R.checkers = makeRules(simpleMoves, captureMoves, false);
    R.checkersEnglish = makeRules(englishSimpleMoves, englishCaptureMoves, true);
})();

// ---- rules/ttt.js ----
"use strict";

/*
 * rules/ttt.js - pure Tic-Tac-Toe rules, shared by client predictor + server authority.
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
            b[i] = 0;                      // restore - this must not mutate the board
            if (w && w.mark === mark) return i;
        }
        return -1;
    }

    // Heuristic bot: win > block > center > corner > side. Strong but not a full
    // minimax, so a sharp human can still fork it - deliberately beatable.
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
 * rules/chess.js - pure chess rules, shared by client predictor + server authority.
 * See rules/checkers.js header for the shared-namespace mechanism.
 *
 * Board is a flat Array(64), index = row*8 + col, row 0 = TOP (black back rank), row 7 =
 * BOTTOM (white back rank). Piece value: 0 empty; SIGN = colour (white > 0, black < 0);
 * ABS = type 1=pawn 2=knight 3=bishop 4=rook 5=queen 6=king. "Colour" here is +1 (white) /
 * -1 (black) - the sign of the piece - NOT the checkers WHITE/BLACK strings. White = host,
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

    // Game state that from/to alone can't carry: castling rights + en-passant target square +
    // the halfmove clock for the fifty-move rule (`half`: plies since the last capture or pawn
    // move). `half` is a plain int so cloneChessState stays allocation-cheap inside the search.
    // Threefold repetition is NOT tracked here - it needs the whole game's position list, which
    // would make every search node copy an array. The caller keeps a positionKey() count instead
    // and passes it to chessResult().
    function initialChessState() { return { ep: -1, wK: true, wQ: true, bK: true, bQ: true, half: 0 }; }
    function cloneChessState(st) { return { ep: st.ep, wK: st.wK, wQ: st.wQ, bK: st.bK, bQ: st.bQ, half: st.half || 0 }; }

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
        // Fifty-move rule: the halfmove clock resets on a capture or ANY pawn move, else ticks.
        // Read b[to] BEFORE the board is mutated below.
        nst.half = (t === C_PAWN || b[to] !== 0) ? 0 : (st.half || 0) + 1;
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
        if (kSide && b[cSq(row, 5)] === 0 && b[cSq(row, 6)] === 0 && b[cSq(row, 7)] === color * C_ROOK &&
            !attacksSquare(b, cSq(row, 5), -color) && !attacksSquare(b, cSq(row, 6), -color)) {
            moves.push({ from: ksq, to: cSq(row, 6) });
        }
        if (qSide && b[cSq(row, 1)] === 0 && b[cSq(row, 2)] === 0 && b[cSq(row, 3)] === 0 && b[cSq(row, 0)] === color * C_ROOK &&
            !attacksSquare(b, cSq(row, 3), -color) && !attacksSquare(b, cSq(row, 2), -color)) {
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

    // Can EITHER side still force a mate with the material on the board? Draws the classic
    // insufficient-material cases: K vs K, K+minor vs K, and K+B vs K+B on the same colour.
    // Any pawn, rook or queen (or two minors on one side) can still mate, so those are "ongoing".
    function insufficientMaterial(b) {
        var minors = { 1: [], "-1": [] };      // bishop/knight squares per colour
        for (var i = 0; i < 64; i++) {
            var v = b[i];
            if (v === 0) continue;
            var t = cType(v);
            if (t === C_KING) continue;
            if (t === C_PAWN || t === C_ROOK || t === C_QUEEN) return false;   // mating material
            minors[cSign(v)].push({ t: t, sq: i });
        }
        var w = minors[1], bl = minors["-1"];
        if (w.length > 1 || bl.length > 1) return false;   // two minors can mate (BB, and BN)
        if (w.length === 0 && bl.length === 0) return true;                    // K vs K
        if (w.length + bl.length === 1) return true;                           // K+minor vs K
        // one minor each: only a draw when both are bishops on the SAME colour complex
        if (w[0].t === C_BISHOP && bl[0].t === C_BISHOP) {
            var wc = (cRow(w[0].sq) + cCol(w[0].sq)) & 1;
            var bc = (cRow(bl[0].sq) + cCol(bl[0].sq)) & 1;
            return wc === bc;
        }
        return false;
    }

    // Compact position identity for threefold repetition: piece placement + side to move +
    // castling rights + en-passant target. Two positions repeat only when ALL of those match
    // (FIDE), so the key must include everything that changes the set of legal continuations.
    function positionKey(b, st, color) {
        var s = b.join(",");
        return s + "|" + color + "|" + (st.wK ? 1 : 0) + (st.wQ ? 1 : 0) + (st.bK ? 1 : 0) + (st.bQ ? 1 : 0) + "|" + st.ep;
    }

    // "ongoing" | "checkmate" | "stalemate" | "draw50" | "repetition" | "insufficient"
    // for `color` to move. `repeats` is OPTIONAL: how many times the CURRENT position has now
    // occurred in this game (the caller counts positionKey() hits - the rules module can't, since
    // it would have to carry the whole game history into every search node). Pass nothing and only
    // the position-local draws are reported, which is what the bot search wants.
    function chessResult(b, st, color, repeats) {
        if (legalMoves(b, st, color).length > 0) {
            // A checkmate/stalemate ALWAYS outranks a draw claim: you can be mated on move 100
            // of a fifty-move count, and that is a loss, not a draw.
            if (repeats >= 3) return "repetition";
            if ((st.half || 0) >= 100) return "draw50";        // 100 plies = 50 full moves
            if (insufficientMaterial(b)) return "insufficient";
            return "ongoing";
        }
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
    // caller can yield between them. Panorama JS is single-threaded - the one-shot search froze the
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
        insufficientMaterial: insufficientMaterial, positionKey: positionKey,
        chessBotMove: chessBotMove, chessBotMovePrep: chessBotMovePrep
    };
})();

// ---- rules/connectfour.js ----
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

    // The four-cell winning line for `player` (row-major cell indices), or null. UI-only -
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
    // PERF (2026-07-20 - the maintainer's "дикие лаги"): the search runs SYNCHRONOUSLY on
    // Panorama's UI thread, and the old code allocated a fresh 42-element board (drop()'s
    // b.slice()) at EVERY node - tens of thousands of arrays per move, GC-thrashing Panorama's
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
    // THROUGH that cell (O(1)) instead of the whole board - the make/undo search's per-node
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
    // Lowest empty row of `col` on the CURRENT (mutated) board - search's make step. -1 if full.
    function landRow(b, col) { for (var r = ROWS - 1; r >= 0; r--) if (b[idx(r, col)] === 0) return r; return -1; }

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
        var best = -1e9, moved = false;
        for (var i = 0; i < CENTER_ORDER.length; i++) {
            var col = CENTER_ORDER[i];
            var r = landRow(b, col);
            if (r < 0) continue;                           // full
            moved = true;
            var cell = idx(r, col);
            b[cell] = player;                              // make
            var val = -negamax(b, player === 1 ? 2 : 1, depth - 1, -beta, -alpha, r, col, player);
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
            var val = -negamax(w, opp, DEPTH - 1, -1e9, 1e9, r, col, player);
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
 * rules/durak.js - pure "Durak" (Podkidnoy) rules, shared by the client (predictor + bot)
 * and the authoritative server dealer (same shared-namespace mechanism as rules/ttt.js).
 *
 * Card model: id 0..35 = suit*9 + rank. suit 0..3 = S,H,D,C. rank 0..8 = 6,7,8,9,T,J,Q,K,A
 * (higher rank index = stronger). Trump = suit of the deck's bottom card. A given seed fully
 * determines a deal (mulberry32), and online the SERVER owns that seed - so the client never
 * sees the deck, it rebuilds its view from the public event log + its own private cards.
 *
 * Scope note: public matchmaking is heads-up, while private online tables and offline bot
 * games support 2–4 players. The same rules engine drives every seat count.
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

    // Deterministic PRNG (mulberry32) so a given seed always deals the same game - the test
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
            // matching ranks before the table is beaten - the mechanic the 2-player code never
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
    // already passed - so consensus must be re-earned before the bout can be beaten.
    function resetPasses(st) {
        for (var s = 0; s < st.numPlayers; s++) st.passed[s] = false;
    }
    // Is `seat` an in-play ATTACKER (not the defender, not out)? Only these seats throw in and
    // vote on ending the bout; the defender's "end" action is Take, handled separately.
    function isAttackSeat(st, seat) { return seat !== st.defender && !st.out[seat]; }

    // Record that `seat` is done adding cards to the current table (a "pass"/knock). Idempotent.
    function applyPass(st, seat) { if (isAttackSeat(st, seat)) st.passed[seat] = true; }

    // Has `seat` settled the current table - i.e. it owes no further Bito confirmation? An attack
    // seat is settled once it either passed (declared "done"/Bito) OR holds NO cards at all (an
    // empty hand can neither throw in nor meaningfully confirm, so it auto-settles - the deadlock
    // guard). A seat that still HOLDS cards is NOT auto-settled just because none of them is a legal
    // throw-in: it must explicitly press Bito. That explicit-confirm rule is what keeps a covered
    // table on screen after the defender covers - the old "no legal throw-in ⇒ auto-settled" made
    // canBito flip true in the SAME tick a defence landed, so endBout swept the felt to discard
    // before the player could even see what the defender covered with.
    function attackSeatSettled(st, seat) {
        if (!isAttackSeat(st, seat)) return true;
        if (st.passed[seat]) return true;
        if (st.hands[seat].length === 0) return true;   // nothing to add or hold back → auto-settle
        return false;                                    // holds cards → must explicitly Bito/pass
    }
    // The table may be beaten (Bito) only when it's non-empty, fully covered, AND every in-play
    // attack seat has settled (explicitly passed, or holds no cards). This is the throw-in/Bito
    // consensus: every attacker (human or bot) confirms before the bout ends.
    function canBito(st) {
        if (st.table.length === 0 || uncoveredCount(st) !== 0) return false;
        for (var s = 0; s < st.numPlayers; s++) if (!attackSeatSettled(st, s)) return false;
        return true;
    }
    // First in-play attack seat (turn order from the primary attacker) that has NOT settled - i.e.
    // whoever is currently "on the clock" to either throw in a card or confirm Bito on a covered
    // table. -1 when everyone has settled (the bout is ready to be beaten). Drives actionActor so
    // the confirm turn walks every attacker, not just those still holding a legal throw-in.
    function firstUnsettled(st) {
        if (uncoveredCount(st) !== 0) return -1;
        for (var k = 0; k < st.numPlayers; k++) {
            var s = (st.attacker + k) % st.numPlayers;
            if (!attackSeatSettled(st, s)) return s;
        }
        return -1;
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
        // The leaver's hand is dead - count it into the discard pile so deck maths stay sane.
        st.discard += st.hands[seat].length;
        st.hands[seat] = [];
        // Void any open bout: the table's cards go to discard (the defender may be the one leaving,
        // so there's no clean "took"/"beaten" resolution - the bout simply doesn't count).
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
        firstUnsettled: firstUnsettled,
        inPlayCount: inPlayCount, refill: refill, endBout: endBout, checkOver: checkOver, leaveSeat: leaveSeat,
        cardValue: cardValue, sortByValue: sortByValue,
        durakBotAttack: durakBotAttack, durakBotDefend: durakBotDefend
    };
})();

// ---- rules/poker.js ----
"use strict";

/*
 * rules/poker.js - pure No-Limit Texas Hold'em rules, shared by the client (predictor +
 * bot) and the authoritative server dealer (same shared-namespace mechanism as the other
 * rules/*.js). Nothing here touches Panorama; it is fully unit-testable in Node.
 *
 * Card model: id 0..51 = suit*13 + rank. suit 0..3 = S,H,D,C. rank 0..12 = 2,3,4,5,6,7,8,9,
 * T,J,Q,K,A (higher rank index = stronger). This matches the deck art filenames
 * (SUIT_CHARS[suit] + RANK_CHARS[rank] + ".vtex" → e.g. "SA", "H2", "DT"). A given seed
 * fully determines a deal (mulberry32); online the SERVER owns that seed so the client
 * never sees the deck or a foreign hole card - it rebuilds its view from the public event
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

    // Deterministic PRNG (mulberry32) - identical to the other engines so seeds line up.
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
        if (c0[0] === 4) return [7, c0[1], bestExcluding(cards, [c0[1]])];
        if (c0[0] === 3 && c1 && c1[0] >= 2) return [6, c0[1], c1[1]];
        if (flushVals) { flushVals = flushVals.slice().sort(desc); return [5, flushVals[0], flushVals[1], flushVals[2], flushVals[3], flushVals[4]]; }
        var st = straightHigh(allVals(cards));
        if (st) return [4, st];
        if (c0[0] === 3) return [3, c0[1], vals[1], vals[2]];
        if (c0[0] === 2 && c1 && c1[0] === 2) return [2, c0[1], c1[1], bestExcluding(cards, [c0[1], c1[1]])];
        if (c0[0] === 2) return [1, c0[1], vals[1], vals[2], vals[3]];
        var hv = allVals(cards).sort(desc);
        return [0, hv[0], hv[1], hv[2], hv[3], hv[4]];
    }
    function desc(a, b) { return b - a; }
    function allVals(cards) { var o = []; for (var i = 0; i < cards.length; i++) o.push(cardVal(cards[i])); return o; }
    // Highest card value in `cards` whose value is not in `exclude`. MUST NOT be derived from
    // the `vals` (group) order: groups sort by COUNT first, so a third pair / second pair sits
    // ahead of the genuine high kicker there and picking from it awarded the wrong pot
    // (e.g. AAKK2 2 Q scored its kicker as the 2, not the Q).
    function bestExcluding(cards, exclude) {
        var best = 0;
        for (var i = 0; i < cards.length; i++) {
            var v = cardVal(cards[i]);
            if (exclude.indexOf(v) !== -1) continue;
            if (v > best) best = v;
        }
        return best;
    }

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
    // dealt, and dealBoard/showdown/finish become no-ops (see st.online guards) - the client
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
            bet: [], committed: [], folded: [], allIn: [], inHand: [], acted: [], noReopen: [],
            street: "preflop", currentBet: 0, minRaise: bb,
            toAct: -1, lastAggressor: -1,
            pots: [], result: null
        };
        for (var s = 0; s < numPlayers; s++) {
            st.bet.push(0); st.committed.push(0); st.folded.push(false);
            st.allIn.push(false); st.acted.push(false); st.noReopen.push(false);
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
        // A blind can put its own seat ALL-IN (stack <= sb/bb). The heads-up branch above
        // assigns toAct = sbSeat unconditionally, and legalActions() returns nothing for an
        // all-in seat, so every action was rejected and the hand froze in "preflop" forever
        // (offline the bot re-folded into a dead table; online /api/pact answered code 2 to
        // everyone). Route the opener through nextToAct, and if NOBODY can voluntarily act,
        // run the board out - the same terminal handling nextStreet already does. Uncalled
        // chips come back through the single-contributor side pot in showdown().
        if (st.toAct < 0 || st.allIn[st.toAct] || st.stacks[st.toAct] === 0)
            st.toAct = nextToAct(st, st.toAct >= 0 ? st.toAct : bbSeat);
        if (st.toAct < 0) {
            if (activeCount(st) <= 1) finish(st);
            else runout(st);
        }
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
        // capped by the stack (a short stack can shove for less as an all-in). `noReopen`
        // marks seats that had already matched the bet when a SHORT all-in came in: they owe
        // the shove's remainder but standard NLHE does not let them re-raise it.
        var maxTo = st.bet[seat] + st.stacks[seat];
        if (maxTo > st.currentBet && !(st.noReopen && st.noReopen[seat])) {
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
            // resetActedExcept used to run UNCONDITIONALLY, which contradicted this comment and
            // handed a free re-raise to seats that had already called.
            st.currentBet = Math.max(st.currentBet, st.bet[seat]);
            st.lastAggressor = seat;
            if (raiseSize >= st.minRaise) {
                st.minRaise = raiseSize;
                resetActedExcept(st, seat);
                clearNoReopen(st);                  // a full raise reopens the action for everyone
            } else {
                // Short all-in: only seats that still owe chips must act again, and they may only
                // call or fold. Seats that already matched the previous currentBet are done.
                for (var s2 = 0; s2 < st.numPlayers; s2++) {
                    if (s2 === seat) continue;
                    if (st.bet[s2] < st.currentBet) { st.acted[s2] = false; st.noReopen[s2] = true; }
                }
            }
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
    // Clear the "you may call but not re-raise" marks (set by a short all-in). Called whenever a
    // full-size raise reopens the action and at the start of every new street.
    function clearNoReopen(st) {
        for (var s = 0; s < st.numPlayers; s++) st.noReopen[s] = false;
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
    // dealing is a no-op here - betting never reads st.board, only the display does.
    function dealBoard(st, n) { if (st.online) return; for (var i = 0; i < n; i++) st.board.push(st.deck.shift()); }

    function nextStreet(st) {
        // clear the street's bets (committed already holds them for side pots)
        for (var s = 0; s < st.numPlayers; s++) { st.bet[s] = 0; st.acted[s] = false; }
        st.currentBet = 0; st.minRaise = st.bb; st.lastAggressor = -1;
        clearNoReopen(st);                  // last street's short-shove restrictions expire
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

    // A seat abandons the table mid-game (online "Leave"). It plays out EXACTLY like a fold -
    // card-independent, so the server and every client replay it byte-identically off a single
    // LEFT event - plus the leaver forfeits their remaining chips so `newHand`'s `stacks[s] > 0`
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
    // weak hands to real pressure - plenty for a friendly table, no bluff modelling.
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

/* ── generated Pixel Battle land mask ── */
/* GENERATED by tools/build_pixelbattle_map.js - DO NOT EDIT. */
const PX_PALETTE = [[0,0,0],[255,255,255],[196,201,204],[94,102,112],[0,0,0],[255,69,0],[255,168,0],[255,214,53],[126,237,86],[0,163,104],[81,233,244],[54,144,234],[36,80,164],[129,30,159],[180,74,192],[255,153,170],[156,105,38],[24,52,67],[165,171,145]];
const PX_ALPHA = [0,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255,255];
const PX_VIEW_PALETTE = [[24,52,67],[165,171,145],[255,255,255],[196,201,204],[94,102,112],[0,0,0],[255,69,0],[255,168,0],[255,214,53],[126,237,86],[0,163,104],[81,233,244],[54,144,234],[36,80,164],[129,30,159],[180,74,192],[255,153,170],[156,105,38],[24,52,67],[165,171,145]];
const PX_LAND_SPANS = [[],[],[],[],[],[],[],[],[],[200,219],[134,135,138,167,189,225],[126,163,169,179,181,189,191,218,222,223],[122,124,128,160,165,222,224,237,392,392],[119,128,138,156,160,232,284,285,288,290,323,327,387,395],[119,131,133,154,163,229,273,274,278,280,284,293,388,397],[106,108,122,131,135,147,159,228,272,285,391,397,400,402],[106,113,116,119,124,129,131,147,152,227,274,282,288,288,398,405],[95,98,119,121,131,133,135,144,154,227,277,280,286,289],[84,90,118,121,129,144,155,229,278,279,400,407],[82,86,91,93,99,101,110,116,123,126,140,141,157,226,344,352,396,416],[89,97,101,105,110,110,113,116,124,129,134,140,172,227,338,346,384,417,451,461],[95,100,119,122,125,141,174,226,335,341,379,414,452,460,466,469],[79,88,175,224,334,338,379,411],[79,91,104,106,112,117,120,125,130,132,137,139,141,145,176,225,333,336,371,416,418,424,431,436,455,459],[78,87,89,92,94,96,99,99,102,105,110,111,113,117,120,122,128,140,178,223,331,335,354,358,362,362,371,438,455,456],[77,84,87,101,103,106,112,118,120,121,128,148,177,222,330,334,354,358,362,363,365,369,371,438,454,468],[0,2,80,83,88,106,115,116,119,123,128,153,180,224,330,335,352,357,360,362,364,439,443,450,452,470,511,511],[28,38,88,108,119,124,129,156,179,181,183,219,222,224,290,298,336,336,351,358,362,482],[25,52,69,71,73,75,78,78,89,111,116,116,119,124,135,142,144,159,178,222,284,298,352,358,361,482,498,500],[23,58,63,86,91,109,115,119,122,126,134,139,147,160,183,219,282,304,342,347,353,358,361,495,499,510],[0,1,19,92,102,105,122,130,134,139,150,158,182,216,279,309,331,332,338,340,342,350,354,359,362,511],[0,4,21,92,99,99,103,110,116,118,120,129,133,139,146,148,152,163,180,209,277,312,319,321,327,359,363,511],[0,6,23,139,146,147,152,164,179,207,276,313,319,320,324,358,361,511],[0,12,21,22,25,133,135,137,151,167,180,205,233,234,275,303,307,312,316,316,319,357,359,511],[2,13,17,132,150,158,163,166,180,201,222,234,273,287,291,305,313,511],[6,10,19,131,133,136,145,160,182,198,224,235,272,285,292,305,313,511],[9,9,27,130,133,139,145,147,151,162,182,197,225,234,271,285,289,305,309,508],[13,13,27,126,132,136,139,141,154,157,159,163,183,197,228,229,269,283,288,509],[22,126,155,159,162,163,184,195,266,281,286,510],[21,123,137,137,142,142,145,148,150,151,159,161,185,194,264,280,286,487,490,506],[20,122,145,153,186,194,263,279,287,479,483,486,489,502],[21,39,41,45,47,121,145,156,190,194,263,280,286,477,483,484,488,499],[18,19,22,38,40,44,51,120,146,156,192,193,263,282,288,290,297,475,486,493,498,498],[26,36,40,41,57,120,145,156,163,164,264,281,291,467,471,475,484,487],[26,26,28,29,31,37,59,122,145,158,162,165,264,268,272,279,289,456,483,486],[32,35,65,123,146,166,248,250,272,279,291,455,481,485],[31,33,36,38,66,124,147,167,248,252,270,270,273,278,287,288,290,453,479,487],[29,31,67,129,147,167,248,251,268,270,274,278,286,452,478,487],[26,29,68,131,146,169,248,252,268,269,272,276,286,450,477,485],[24,25,70,137,145,170,249,253,268,269,272,273,286,448,477,485],[70,138,143,174,244,247,251,254,268,270,279,282,284,450,477,484],[67,67,72,138,144,174,242,246,252,255,268,451,453,455,478,483],[72,138,144,176,243,246,249,256,263,459,478,482],[68,68,74,139,144,176,242,245,250,257,262,459,478,480],[74,140,144,175,249,257,261,455,458,459,478,479],[75,171,175,176,249,256,259,455,458,459],[74,76,78,162,165,170,174,175,248,248,250,250,258,455,458,460],[76,77,80,159,165,166,173,176,253,253,256,455,458,460],[77,79,81,157,160,163,172,179,251,251,254,454,458,458],[79,79,82,156,158,163,172,180,250,454,458,458],[79,80,82,155,157,163,177,177,179,180,252,453,458,458],[80,164,179,180,253,307,310,327,331,452,458,459],[80,164,166,166,169,170,254,298,303,305,310,324,332,451],[80,168,254,273,275,297,302,307,309,322,330,450],[80,159,162,165,254,272,277,296,303,304,309,321,329,449,457,458],[79,157,162,163,254,266,270,273,278,296,312,322,328,448,457,462],[79,155,243,260,264,265,271,275,280,295,313,323,329,446,455,462],[79,154,243,259,268,268,272,275,282,294,315,323,331,441,455,456,458,459],[79,156,243,259,268,268,273,278,284,295,303,306,315,324,333,440,455,456],[79,151,244,257,275,279,284,296,298,298,300,309,314,325,334,439,455,456],[79,150,243,256,268,269,277,281,284,287,289,289,293,293,295,326,331,426,430,438,455,457],[80,150,243,255,268,269,278,279,284,287,294,325,332,425,429,430,433,436,455,457],[80,149,243,255,268,268,279,279,285,288,294,325,332,423,428,428,434,437,455,457],[81,146,148,148,243,254,278,278,286,289,294,325,333,423,434,438,454,456],[82,147,244,254,274,277,286,288,295,325,333,424,427,428,436,439,453,455],[82,147,243,244,247,252,264,269,271,271,277,277,287,288,295,327,332,429,436,439,450,450,452,455],[83,147,247,248,257,270,298,298,302,303,307,427,436,439,450,455],[84,147,247,248,254,271,304,304,307,425,436,439,445,455],[84,146,247,270,302,303,307,425,436,437,444,453],[87,144,246,270,307,426,442,444,446,449],[89,143,244,271,306,427,440,442,444,445],[89,141,243,275,286,287,306,427,441,442],[90,140,243,277,284,289,305,428,441,442],[90,92,95,139,242,278,284,294,298,300,305,428,441,441],[91,92,95,139,242,281,284,428],[91,92,96,128,134,135,137,139,242,323,327,429],[93,93,96,120,127,127,138,140,241,301,303,304,306,323,328,428],[94,94,97,118,138,140,240,324,329,428],[92,95,99,117,138,141,238,302,306,324,330,427],[93,96,99,117,139,141,237,303,307,325,332,335,337,426],[96,96,101,117,139,141,236,303,308,326,337,426],[96,97,101,117,140,141,235,304,308,326,328,328,335,335,339,425],[96,97,102,116,235,305,309,328,334,335,351,424,428,428],[98,98,103,116,145,145,234,305,309,329,333,336,352,423,427,428],[99,99,104,116,233,305,311,339,353,422,427,428],[99,99,105,116,137,141,233,306,311,339,355,420,427,427],[106,116,136,136,140,144,232,307,312,340,354,384,387,416],[31,31,106,116,130,131,144,146,232,308,312,339,355,379,387,408,412,413],[33,33,106,117,127,131,145,147,232,308,312,338,359,379,387,407,412,412],[34,34,106,118,127,131,146,149,233,308,313,337,360,378,388,406,412,413],[34,34,107,118,127,131,152,156,233,308,314,337,360,376,389,405,410,412],[108,120,125,130,150,150,153,158,233,308,315,336,360,375,390,406,411,412],[111,130,145,147,154,154,233,310,315,335,360,374,390,406,427,429],[112,129,233,310,316,334,360,372,390,407,427,429],[115,129,232,311,317,330,360,372,390,392,394,408,427,429],[118,119,123,129,133,135,232,311,317,329,361,369,391,391,395,409,427,428],[124,137,232,312,317,327,361,369,395,410,427,428],[125,137,232,314,317,325,362,369,395,410,428,428],[128,136,232,315,318,323,362,369,395,410,428,428,430,431],[131,136,232,316,318,319,362,369,396,397,400,410,428,428,431,432],[132,136,154,154,232,317,363,369,396,397,402,410,428,428,433,433],[133,136,152,154,156,156,233,316,327,328,363,369,396,397,402,410,429,429,434,434],[134,136,149,158,235,317,323,328,364,369,396,397,403,409,429,431,433,433],[134,137,149,153,155,162,164,166,168,168,235,327,364,368,396,396,405,407,425,425,431,431,433,433],[136,138,143,143,148,153,155,168,237,327,365,367,370,370,396,396,405,406,424,424,430,430,434,434],[137,142,144,145,147,169,237,327,365,366,370,370,396,397,405,405,433,435],[140,141,145,171,237,326,366,366,369,371,397,398,430,435],[141,141,145,172,238,326,369,371,397,398,430,430,433,435],[146,173,240,325,370,371,398,400,422,422,432,433,435,435],[146,174,177,177,241,257,263,325,399,401,421,422,433,434],[146,180,242,254,263,324,392,393,399,402,420,424],[146,181,244,245,264,266,268,323,392,395,399,402,418,424],[146,182,269,322,393,396,399,402,418,422],[146,183,270,322,394,397,400,402,417,422],[144,183,270,321,395,398,401,403,414,423],[144,184,269,319,396,400,402,403,412,412,414,423,437,437],[143,184,269,318,397,401,411,424,428,428,433,433,437,438],[142,183,269,316,397,402,411,422,427,427,431,432,437,438],[142,186,269,316,398,402,411,422,426,426],[141,189,269,315,399,403,412,422,426,426,429,430,442,446],[141,191,269,314,399,404,413,421,426,428,444,446,451,452],[141,192,194,194,270,313,400,405,413,421,425,428,446,446,450,454],[142,199,271,312,401,406,415,420,425,426,428,429,436,436,438,441,444,447,449,458],[141,201,272,312,402,406,419,419,426,426,428,429,445,445,447,461],[140,202,272,311,403,406,426,426,429,430,449,462,472,473],[141,205,273,310,404,406,426,426,430,430,452,463,469,469,471,471],[141,205,273,310,407,408,447,447,453,465,468,470,476,476],[142,205,274,311,406,409,413,414,453,465,477,477],[143,206,274,311,408,416,453,464],[143,205,275,311,413,419,452,459,464,466,482,482],[144,205,275,311,422,424,427,429,434,435,456,459,464,466],[144,204,275,311,426,426,432,433,465,467,483,483,485,485],[145,204,275,312,427,427,432,432,467,469],[145,203,275,313,458,458],[146,202,275,313,445,445,458,458],[146,201,275,313,442,450,458,459],[147,200,274,313,325,326,441,449,457,459],[147,200,274,313,325,326,441,449,457,459],[148,200,273,313,324,326,435,437,440,448,457,461],[149,200,273,313,323,327,434,448,457,462,493,493],[150,200,273,312,321,327,433,450,457,462],[152,199,273,311,319,326,432,451,457,462,494,494,510,511],[154,199,273,309,319,325,430,453,456,463],[155,199,273,308,319,325,430,463,508,509],[156,199,273,307,319,325,429,463],[156,199,274,305,319,325,428,464],[156,198,274,304,319,324,425,466],[156,197,275,305,319,324,422,467,490,490],[156,197,275,305,318,324,420,467,491,491],[156,196,276,306,318,323,419,468,492,493],[156,195,276,306,318,323,418,469],[156,191,276,305,318,323,418,470],[156,189,277,305,318,322,417,471],[156,187,277,303,319,322,418,472],[155,186,277,301,418,473],[155,186,277,302,417,473],[155,186,278,302,418,473],[155,186,278,301,418,473],[155,186,279,301,419,473],[154,185,280,300,419,473],[154,184,280,299,420,473],[154,183,281,298,420,473],[154,182,282,298,420,473],[154,181,282,296,421,437,444,472],[154,180,282,295,421,433,447,472],[154,180,282,293,420,431,448,450,452,471],[154,179,282,286,420,425,448,449,452,470],[153,173,177,177,421,423,451,451,453,470,502,502],[153,174,453,469,502,503],[152,174,455,469,503,503],[152,174,455,468,504,505],[151,173,455,468,504,505],[151,172,458,460,462,464,504,509],[152,166,504,508],[151,167,504,507],[151,166,505,506],[151,162,165,165,462,466,501,501,503,503,505,505],[151,163,462,466,500,503],[150,150,153,165,463,465,499,502],[150,150,152,163,463,464,498,501],[152,162,496,500],[150,162,494,499],[150,160,493,498],[149,159,493,497],[149,160],[150,162],[149,161],[148,159,354,354],[149,159,354,355],[149,157],[149,157],[149,157,169,173],[150,156],[150,150,152,154,156,158],[151,152,154,159],[153,161],[156,159,161,162],[],[],[],[],[],[],[],[],[],[],[],[172,173],[168,169],[165,166],[164,166,402,402,448,448],[161,165,329,336,381,381,400,405,414,419,442,449],[160,163,325,338,377,383,386,386,390,390,396,396,398,424,428,463],[160,162,321,342,346,350,371,463],[160,163,304,304,316,354,368,468],[154,156,159,165,303,308,313,354,367,477],[154,157,159,166,280,283,299,352,361,482],[154,157,159,167,263,270,273,352,360,486],[150,158,160,168,241,242,246,247,251,254,257,352,358,497],[111,118,149,157,161,168,239,352,357,498],[109,109,113,113,129,129,159,168,237,497],[75,76,82,82,109,116,121,134,141,142,144,145,152,169,233,496],[87,89,91,94,112,168,234,493],[59,100,114,164,232,490],[48,162,228,488],[48,156,220,488],[44,145,214,488],[31,150,210,489],[24,26,32,144,186,192,205,492],[25,28,36,144,185,193,205,488],[46,146,169,169,183,193,214,484],[47,152,162,170,179,190,214,483],[34,40,43,157,203,484],[37,166,184,192,195,486],[39,171,177,489],[38,495],[11,14,42,500],[0,20,53,511],[0,42,47,511],[0,511],[0,511],[0,511],[0,511],[0,511],[0,511]];

/* ── authored Pixel Battle browser admin assets ── */
/*
 * Browser admin panel assets for Pixel Battle.
 *
 * This file is concatenated into server/worker.js by tools/build_worker.js. The page
 * contains no credentials and receives no trusted identity from client-side code:
 * worker.core.js validates a signed GitHub OAuth session before serving any /admin route.
 */
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Pixel Battle Admin</title>
  <link rel="stylesheet" href="/admin/style.css">
</head>
<body>
  <header>
    <div>
      <p class="eyebrow">DEADLOCK MINIGAMES</p>
      <h1>Pixel Battle Admin</h1>
    </div>
    <div class="identity"><span id="adminLogin">Authenticating…</span><a href="/admin/logout">Sign out</a></div>
  </header>
  <main>
    <section class="panel canvas-panel">
      <div class="section-head">
        <div><h2>Canvas</h2><p id="canvasMeta">Loading current state…</p></div>
        <div class="toolbar">
          <button id="reloadCanvas" class="secondary">Reload</button>
          <button id="clearQueue" class="secondary">Clear queue</button>
          <button id="applyPixels" class="primary" disabled>Apply 0 pixels</button>
        </div>
      </div>
      <div class="canvas-nav">
        <div class="zoom-tools" aria-label="Canvas navigation">
          <button id="zoomOut" class="secondary zoom-button" type="button" title="Zoom out">−</button>
          <button id="zoomFit" class="secondary" type="button" title="Fit the complete map">Fit</button>
          <button id="zoomIn" class="secondary zoom-button" type="button" title="Zoom in">+</button>
          <span id="zoomLevel" class="zoom-level">100%</span>
          <button id="panMode" class="secondary" type="button" aria-pressed="false">Pan</button>
          <button id="inspectMode" class="secondary inspect-button" type="button" aria-pressed="false">Inspect pixel</button>
        </div>
        <div id="pixelCoords" class="pixel-coords">PIXEL -, -</div>
      </div>
      <div id="canvasShell" class="canvas-shell"><canvas id="canvas" width="512" height="256"></canvas></div>
      <div id="debugPanel" class="debug-panel" hidden>
        <div class="debug-copy">
          <p id="debugEyebrow" class="debug-eyebrow">INSPECTOR</p>
          <h3 id="debugTitle">Pixel details</h3>
          <div id="debugLines" class="debug-lines"></div>
        </div>
        <div id="debugActions" class="debug-actions"></div>
      </div>
      <div id="palette" class="palette" aria-label="Paint palette"></div>
      <p class="hint">Wheel zooms toward the cursor. Use Pan, Shift-drag, or middle-drag to move. Left-drag paints. Admin uploads do not spend a Steam account's pixel bank.</p>
    </section>

    <section class="panel log-panel">
      <div class="section-head">
        <div><h2>Action log</h2><p>Exact server-accepted changes, newest first.</p></div>
        <form id="searchForm" class="search">
          <input id="steamId" inputmode="numeric" autocomplete="off" placeholder="Steam32 ID (optional)">
          <button class="secondary" type="submit">Search</button>
          <button id="banUser" class="danger" type="button" disabled>Ban</button>
          <button id="unbanUser" class="secondary" type="button" disabled>Unban</button>
        </form>
      </div>
      <div id="logStatus" class="status"></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Pixels</th><th>State</th><th></th></tr></thead>
          <tbody id="actions"></tbody>
        </table>
      </div>
      <button id="moreActions" class="secondary more" hidden>Load more</button>
    </section>
  </main>
  <div id="toast" role="status" aria-live="polite"></div>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

const ADMIN_CSS = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0d12;color:#edf2f7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,#1a2534 0,transparent 34rem),#0a0d12}
header{height:82px;padding:0 max(24px,calc((100vw - 1400px)/2));display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #27303c;background:#0c1017dd}
h1,h2,p{margin:0}h1{font-size:23px;letter-spacing:.01em}.eyebrow{color:#63d7bd;font-size:11px;font-weight:800;letter-spacing:.18em;margin-bottom:4px}
.identity{display:flex;gap:16px;align-items:center;color:#aab5c3;font-size:13px}.identity a{color:#63d7bd;text-decoration:none}
main{max-width:1400px;margin:0 auto;padding:28px 24px 48px;display:grid;gap:24px}.panel{background:#111720;border:1px solid #293341;border-radius:14px;box-shadow:0 18px 50px #0007;overflow:hidden}
.section-head{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid #27303c}.section-head h2{font-size:17px}.section-head p,.hint{color:#8996a6;font-size:12px;margin-top:5px}
.toolbar,.search{display:flex;gap:9px;align-items:center}button,input{border:1px solid #354253;border-radius:8px;background:#19212c;color:#edf2f7;font:inherit;height:38px;padding:0 14px}
button{font-size:12px;font-weight:750;cursor:pointer}button:hover{border-color:#64748b}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#24a98b;border-color:#38c9a9;color:#04120f}.secondary{background:#18202b}
  input{width:220px;outline:none}input:focus{border-color:#63d7bd}.canvas-nav{margin:18px 22px 10px;display:flex;align-items:center;justify-content:space-between;gap:12px}.zoom-tools{display:flex;align-items:center;gap:8px}.zoom-button{width:42px;padding:0;font-size:21px;line-height:1}.zoom-level{min-width:64px;padding:6px 9px;border-radius:7px;background:#0c1118;border:1px solid #293747;color:#85e1ca;text-align:center;font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace}.pixel-coords{color:#9aabba;font:700 12px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.05em}.canvas-shell{height:min(72vh,820px);min-height:420px;margin:0 22px 16px;overflow:auto;border:1px solid #394758;background:#080b10;padding:12px;border-radius:10px;overscroll-behavior:contain;scrollbar-color:#43556a #101720}
  canvas{display:block;max-width:none;image-rendering:pixelated;cursor:crosshair;background:#183443;touch-action:none;user-select:none}.canvas-shell.pan-mode canvas{cursor:grab}.canvas-shell.panning canvas{cursor:grabbing}.canvas-shell.inspect-mode canvas{cursor:help}.canvas-shell.pan-mode{border-color:#4f9d8b;box-shadow:inset 0 0 0 1px #4f9d8b44}.canvas-shell.inspect-mode{border-color:#5ca7dc;box-shadow:inset 0 0 0 1px #5ca7dc44}#panMode.active{background:#244b43;border-color:#5cc6aa;color:#b8ffeb}#inspectMode.active{background:#1c405b;border-color:#62b8ef;color:#c9ecff}
  [hidden]{display:none!important}.debug-panel{margin:0 22px 16px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:20px;border:1px solid #38506a;border-radius:10px;background:#0c131c}.debug-copy{min-width:0}.debug-eyebrow{color:#69bfea;font-size:10px;font-weight:800;letter-spacing:.15em;margin-bottom:4px}.debug-copy h3{font-size:16px}.debug-lines{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:8px;color:#9eacbb;font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.debug-lines .important{color:#f3f7fb}.debug-lines .conflict{color:#ff8c95}.debug-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px}.debug-actions button{height:32px;padding:0 10px}.palette{display:flex;flex-wrap:wrap;gap:7px;padding:0 22px}.swatch{width:34px;height:34px;padding:0;border-radius:7px;position:relative}.swatch.selected{outline:2px solid #fff;outline-offset:2px}.swatch.eraser{background:repeating-linear-gradient(135deg,#d7dde5 0 7px,#687586 7px 14px)}
.swatch span{position:absolute;visibility:hidden}.hint{padding:14px 22px 20px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:12px 15px;border-bottom:1px solid #222c38;white-space:nowrap}th{color:#8290a1;font-size:10px;text-transform:uppercase;letter-spacing:.1em}td.actor{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.state-ok{color:#69d9bd}.state-undone{color:#f6bd60}.state-partial{color:#ff8f70}.row-actions{display:flex;gap:7px}.row-actions button{height:30px;padding:0 9px}.danger{border-color:#7d3d42;color:#ffacb3}.status{padding:12px 15px;color:#9aa7b6;font-size:12px}.more{margin:16px}
#toast{position:fixed;right:22px;bottom:22px;max-width:420px;padding:12px 15px;border-radius:9px;background:#18222d;border:1px solid #3a4a5d;box-shadow:0 12px 35px #0009;opacity:0;transform:translateY(8px);transition:opacity .15s,transform .15s;pointer-events:none;font-size:13px}
  #toast.show{opacity:1;transform:translateY(0)}@media(max-width:800px){header{padding:0 16px}.identity span{display:none}main{padding:16px}.section-head{align-items:flex-start;flex-direction:column}.toolbar,.search{width:100%;flex-wrap:wrap}input{flex:1}.canvas-nav{margin:14px;align-items:flex-start;flex-direction:column}.zoom-tools{flex-wrap:wrap}.canvas-shell{height:65vh;min-height:360px;margin:0 14px 14px}.debug-panel{margin:0 14px 14px;align-items:flex-start;flex-direction:column}.debug-actions{justify-content:flex-start}.palette{padding:0 14px}}`;

const ADMIN_JS = `"use strict";
(function(){
  var state=null,baseImage=null,pending=new Map(),selected=1,drawing=false,lastKey="",lastPaintPoint=null,cursor="",banState=null;
  var zoom=1,panMode=false,inspectMode=false,panning=false,panStart=null,preview=null,pulseRaf=null;
  var canvas=document.getElementById("canvas"),ctx=canvas.getContext("2d",{alpha:false});
  var shell=document.getElementById("canvasShell"),applyBtn=document.getElementById("applyPixels"),toast=document.getElementById("toast");
  function notify(message,bad){toast.textContent=message;toast.style.borderColor=bad?"#8d4249":"#3a4a5d";toast.classList.add("show");setTimeout(function(){toast.classList.remove("show");},2600);}
  async function api(path,options){
    options=options||{};options.headers=Object.assign({"X-MG-Admin":"1"},options.headers||{});
    if(options.body)options.headers["Content-Type"]="application/json";
    var response=await fetch(path,options),data=null;
    try{data=await response.json();}catch(e){}
    if(!response.ok)throw new Error(data&&data.error?data.error:"Request failed ("+response.status+")");
    return data;
  }
  function hex(rgb){return "#"+rgb.map(function(v){return v.toString(16).padStart(2,"0");}).join("");}
  function updateApply(){applyBtn.disabled=pending.size===0;applyBtn.textContent="Apply "+pending.size+" pixel"+(pending.size===1?"":"s");}
  function render(){
    ctx.imageSmoothingEnabled=false;
    if(baseImage)ctx.drawImage(baseImage,0,0,512,256);else{ctx.fillStyle="#183443";ctx.fillRect(0,0,512,256);}
    pending.forEach(function(color,key){var xy=key.split(","),x=+xy[0],y=+xy[1];if(color===0){ctx.fillStyle="#183443";ctx.fillRect(x,y,1,1);}else{ctx.fillStyle=hex(state.palette[color]);ctx.fillRect(x,y,1,1);}});
    if(preview&&preview.kind==="inspect"){ctx.fillStyle="#00e5ff";ctx.fillRect(preview.x,preview.y,1,1);}
    else if(preview&&preview.pixels&&state){
      var pulse=0.5+0.5*Math.abs(Math.sin(Date.now()/380));
      preview.pixels.forEach(function(p){
        if(!preview.force&&!p.revertible){ctx.fillStyle="#ff2446";}
        else{var rgb=state.palette[p.afterDisplay]||state.palette[0];ctx.fillStyle="rgba("+rgb[0]+","+rgb[1]+","+rgb[2]+","+pulse+")";}
        ctx.fillRect(p.x,p.y,1,1);
      });
    }
    updateApply();
  }
  function loadImage(version){
    return new Promise(function(resolve,reject){var image=new Image();image.onload=function(){if(image.naturalWidth!==512||image.naturalHeight!==256){reject(new Error("Admin canvas must be exactly 512x256."));return;}baseImage=image;render();resolve();};image.onerror=reject;image.src="/admin/api/canvas?v="+version+"&rnd="+Math.random();});
  }
  function buildPalette(){
    var host=document.getElementById("palette");host.textContent="";
    state.palette.forEach(function(rgb,index){
      var button=document.createElement("button");button.type="button";button.className="swatch"+(index===selected?" selected":"")+(index===0?" eraser":"");
      if(index!==0)button.style.background=hex(rgb);button.title=state.paletteNames[index]||("Color "+index);
      button.innerHTML="<span>"+button.title+"</span>";button.addEventListener("click",function(){selected=index;buildPalette();});host.appendChild(button);
    });
  }
  async function loadState(){
    state=await api("/admin/api/state");document.getElementById("adminLogin").textContent="@"+state.admin;
    document.getElementById("canvasMeta").textContent="Version "+state.version+" · "+state.painted+" painted pixels · "+state.bans+" banned";
    buildPalette();await loadImage(state.version);
  }
  function point(event){
    var r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(511,Math.floor((event.clientX-r.left)*512/r.width))),y:Math.max(0,Math.min(255,Math.floor((event.clientY-r.top)*256/r.height)))};
  }
  function updateCoords(event){var p=point(event);document.getElementById("pixelCoords").textContent="PIXEL "+p.x+", "+p.y;return p;}
  function queuePixel(x,y){var key=x+","+y;if(key===lastKey)return;lastKey=key;pending.set(key,selected);}
  function paint(event){
    var p=updateCoords(event);
    if(!lastPaintPoint){queuePixel(p.x,p.y);}else{
      var dx=p.x-lastPaintPoint.x,dy=p.y-lastPaintPoint.y,steps=Math.max(Math.abs(dx),Math.abs(dy));
      if(!steps)queuePixel(p.x,p.y);
      for(var i=1;i<=steps;i++)queuePixel(Math.round(lastPaintPoint.x+dx*i/steps),Math.round(lastPaintPoint.y+dy*i/steps));
    }
    lastPaintPoint=p;render();
  }
  function fitWidth(){return Math.max(512,shell.clientWidth-24);}
  function setZoom(next,event){
    next=Math.max(1,Math.min(32,next));
    var oldRect=canvas.getBoundingClientRect(),rx=.5,ry=.5,clientX=0,clientY=0;
    if(event){clientX=event.clientX;clientY=event.clientY;rx=Math.max(0,Math.min(1,(clientX-oldRect.left)/oldRect.width));ry=Math.max(0,Math.min(1,(clientY-oldRect.top)/oldRect.height));}
    else{var sr=shell.getBoundingClientRect();clientX=sr.left+shell.clientWidth/2;clientY=sr.top+shell.clientHeight/2;rx=Math.max(0,Math.min(1,(clientX-oldRect.left)/oldRect.width));ry=Math.max(0,Math.min(1,(clientY-oldRect.top)/oldRect.height));}
    zoom=next;canvas.style.width=Math.round(fitWidth()*zoom)+"px";canvas.style.height=Math.round(fitWidth()*zoom/2)+"px";
    var newRect=canvas.getBoundingClientRect();
    shell.scrollLeft+=newRect.left+rx*newRect.width-clientX;
    shell.scrollTop+=newRect.top+ry*newRect.height-clientY;
    document.getElementById("zoomLevel").textContent=Math.round(zoom*100)+"%";
    document.getElementById("zoomOut").disabled=zoom<=1;document.getElementById("zoomIn").disabled=zoom>=32;
  }
  function fitCanvas(){zoom=1;canvas.style.width=fitWidth()+"px";canvas.style.height=Math.round(fitWidth()/2)+"px";shell.scrollLeft=0;shell.scrollTop=0;document.getElementById("zoomLevel").textContent="100%";document.getElementById("zoomOut").disabled=true;document.getElementById("zoomIn").disabled=false;}
  function setToolMode(mode){
    panMode=mode==="pan";inspectMode=mode==="inspect";
    shell.classList.toggle("pan-mode",panMode);shell.classList.toggle("inspect-mode",inspectMode);
    var pan=document.getElementById("panMode"),inspect=document.getElementById("inspectMode");
    pan.classList.toggle("active",panMode);pan.setAttribute("aria-pressed",panMode?"true":"false");
    inspect.classList.toggle("active",inspectMode);inspect.setAttribute("aria-pressed",inspectMode?"true":"false");
  }
  function stopPointer(){drawing=false;panning=false;panStart=null;lastKey="";lastPaintPoint=null;shell.classList.remove("panning");}
  canvas.addEventListener("pointerdown",function(e){
    if(inspectMode&&e.button===0){inspectPixel(updateCoords(e));e.preventDefault();return;}
    if(panMode||e.shiftKey||e.button===1){
      panning=true;panStart={x:e.clientX,y:e.clientY,left:shell.scrollLeft,top:shell.scrollTop};shell.classList.add("panning");canvas.setPointerCapture(e.pointerId);e.preventDefault();return;
    }
    if(e.button!==0)return;drawing=true;lastKey="";lastPaintPoint=null;canvas.setPointerCapture(e.pointerId);paint(e);e.preventDefault();
  });
  canvas.addEventListener("pointermove",function(e){
    updateCoords(e);
    if(panning&&panStart){shell.scrollLeft=panStart.left-(e.clientX-panStart.x);shell.scrollTop=panStart.top-(e.clientY-panStart.y);return;}
    if(drawing)paint(e);
  });
  canvas.addEventListener("pointerup",stopPointer);
  canvas.addEventListener("pointercancel",stopPointer);
  canvas.addEventListener("pointerleave",function(){if(!drawing&&!panning)document.getElementById("pixelCoords").textContent="PIXEL -, -";});
  canvas.addEventListener("contextmenu",function(e){e.preventDefault();});
  shell.addEventListener("wheel",function(e){if(!canvas.contains(e.target)&&e.target!==canvas)return;e.preventDefault();setZoom(e.deltaY<0?zoom*2:zoom/2,e);},{passive:false});
  document.getElementById("zoomOut").addEventListener("click",function(){setZoom(zoom/2);});
  document.getElementById("zoomIn").addEventListener("click",function(){setZoom(zoom*2);});
  document.getElementById("zoomFit").addEventListener("click",fitCanvas);
  document.getElementById("panMode").addEventListener("click",function(){setToolMode(panMode?"paint":"pan");});
  document.getElementById("inspectMode").addEventListener("click",function(){setToolMode(inspectMode?"paint":"inspect");});
  window.addEventListener("resize",function(){if(zoom===1)fitCanvas();});
  function focusBounds(bounds){
    if(!bounds)return;
    var span=Math.max(bounds[2]-bounds[0]+1,bounds[3]-bounds[1]+1),target=span<=4?32:(span<=16?16:(span<=48?8:(span<=128?4:2)));
    setZoom(target);
    var rect=canvas.getBoundingClientRect(),centerX=(bounds[0]+bounds[2]+1)/2,centerY=(bounds[1]+bounds[3]+1)/2;
    shell.scrollLeft=centerX/512*rect.width-shell.clientWidth/2+12;
    shell.scrollTop=centerY/256*rect.height-shell.clientHeight/2+12;
  }
  function debugButton(label,className,handler){
    var button=document.createElement("button");button.type="button";button.className=className||"secondary";button.textContent=label;button.addEventListener("click",handler);return button;
  }
  function showDebug(eyebrow,title,lines,buttons){
    var panel=document.getElementById("debugPanel"),lineHost=document.getElementById("debugLines"),actions=document.getElementById("debugActions");
    document.getElementById("debugEyebrow").textContent=eyebrow;document.getElementById("debugTitle").textContent=title;
    lineHost.textContent="";actions.textContent="";
    lines.forEach(function(line){var span=document.createElement("span");span.textContent=line.text||line;if(line.className)span.className=line.className;lineHost.appendChild(span);});
    buttons.forEach(function(button){actions.appendChild(debugButton(button.label,button.className,button.handler));});
    panel.hidden=false;
  }
  function clearPreview(){
    stopPulse();preview=null;render();document.getElementById("debugPanel").hidden=true;
  }
  // Action previews highlight the pixels a player actually PLACED (their after-colours), pulsing
  // so they stand out against the rest of the canvas. A rAF loop just re-renders while such a
  // preview is up; stopped whenever the preview is an inspect pixel or cleared.
  function startPulse(){if(pulseRaf)return;pulseRaf=requestAnimationFrame(function loop(){if(preview&&preview.pixels){render();pulseRaf=requestAnimationFrame(loop);}else{pulseRaf=null;}});}
  function stopPulse(){if(pulseRaf){cancelAnimationFrame(pulseRaf);pulseRaf=null;}}
  function actorName(action){
    return action.steamid?("Steam32 "+action.steamid):(action.admin?("@"+action.admin):action.actor);
  }
  function transitionSummary(pixels){
    if(!state)return "";
    var groups=new Map();
    pixels.forEach(function(p){var key=p.beforeDisplay+">"+p.afterDisplay;groups.set(key,(groups.get(key)||0)+1);});
    var out=[];groups.forEach(function(count,key){var pair=key.split(">"),before=state.paletteNames[+pair[0]]||pair[0],after=state.paletteNames[+pair[1]]||pair[1];out.push(before+" → "+after+" ×"+count);});
    return out.slice(0,8).join(" · ");
  }
  function userActions(steamid){
    document.getElementById("steamId").value=steamid;loadActions(true);document.querySelector(".log-panel").scrollIntoView({behavior:"smooth",block:"start"});
  }
  function banFromDebug(steamid){
    document.getElementById("steamId").value=steamid;loadBanState(steamid).then(function(){setBan(true);});
  }
  function applyActionPreview(data,force,shouldFocus){
    preview={kind:"action",pixels:data.pixels||[],force:!!force,data:data};startPulse();render();if(shouldFocus)focusBounds(data.bounds);
    var lines=[
      {text:actorName(data),className:"important"},
      {text:new Date(data.at).toLocaleString()},
      {text:"Action "+data.id},
      {text:"Placed: "+data.count+" pixel"+(data.count===1?"":"s"),className:"important"},
      {text:"Safe undo reverts: "+data.revertible+" pixel"+(data.revertible===1?"":"s")},
      {text:"Conflicts: "+data.conflicts,className:data.conflicts?"conflict":""}
    ];
    var transitions=transitionSummary(data.pixels||[]);if(transitions)lines.push({text:transitions});
    var buttons=[];
    if(data.conflicts)buttons.push({label:force?"Show safe scope":"Show force scope",className:"secondary",handler:function(){applyActionPreview(data,!force,false);}});
    if(data.steamid){
      buttons.push({label:"User actions",className:"secondary",handler:function(){userActions(data.steamid);}});
      buttons.push({label:"Ban user",className:"danger",handler:function(){banFromDebug(data.steamid);}});
    }
    if(data.kind==="paint"&&!data.undoneAt){
      buttons.push({label:"Undo",className:"secondary",handler:function(){undoAction(data.id,false);}});
      buttons.push({label:"Force undo",className:"danger",handler:function(){if(confirm("Force undo and overwrite "+data.conflicts+" conflicting pixels?"))undoAction(data.id,true);}});
    }
    buttons.push({label:"Clear preview",className:"secondary",handler:clearPreview});
    showDebug("PLACED PIXELS"+(data.conflicts&&force?" (FORCE SCOPE)":""),actorName(data)+" · "+data.count+" pixels",lines,buttons);
  }
  async function previewAction(id){
    showDebug("ACTION PREVIEW","Loading "+id+"…",[],[]);
    try{var data=await api("/admin/api/action?id="+encodeURIComponent(id));applyActionPreview(data,false,true);}catch(e){notify(e.message,true);clearPreview();}
  }
  async function inspectPixel(p){
    showDebug("PIXEL INSPECTOR","Inspecting "+p.x+", "+p.y+"…",[],[]);
    try{
      var data=await api("/admin/api/pixel?x="+p.x+"&y="+p.y);stopPulse();preview={kind:"inspect",x:p.x,y:p.y};render();focusBounds([p.x,p.y,p.x,p.y]);
      var lines=[{text:"Color: "+data.colorName,className:"important"},{text:"Coordinate "+p.x+", "+p.y}],buttons=[];
      if(data.action){
        lines.push({text:"Last changed by "+actorName(data.action),className:"important"},{text:new Date(data.action.at).toLocaleString()},{text:"Action "+data.action.id});
        buttons.push({label:"Preview action",className:"primary",handler:function(){previewAction(data.action.id);}});
        if(data.action.steamid){
          buttons.push({label:"User actions",className:"secondary",handler:function(){userActions(data.action.steamid);}});
          buttons.push({label:"Ban user",className:"danger",handler:function(){banFromDebug(data.action.steamid);}});
        }
      }else{lines.push({text:"No recorded owner for this pixel.",className:"conflict"});}
      buttons.push({label:"Clear",className:"secondary",handler:clearPreview});
      showDebug("PIXEL INSPECTOR","Pixel "+p.x+", "+p.y,lines,buttons);
    }catch(e){notify(e.message,true);clearPreview();}
  }
  document.getElementById("clearQueue").addEventListener("click",function(){pending.clear();render();});
  document.getElementById("reloadCanvas").addEventListener("click",async function(){try{pending.clear();clearPreview();await loadState();notify("Canvas reloaded.");}catch(e){notify(e.message,true);}});
  applyBtn.addEventListener("click",async function(){
    if(!pending.size)return;applyBtn.disabled=true;
    var pixels=[];pending.forEach(function(color,key){var xy=key.split(",");pixels.push({x:+xy[0],y:+xy[1],color:color});});
    try{
      var applied=0;
      for(var i=0;i<pixels.length;i+=4096){var result=await api("/admin/api/paint",{method:"POST",body:JSON.stringify({pixels:pixels.slice(i,i+4096)})});applied+=result.changed;}
      pending.clear();clearPreview();await loadState();await loadActions(true);notify("Applied "+applied+" changed pixels.");
    }catch(e){notify(e.message,true);updateApply();}
  });
  function esc(text){return String(text).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];});}
  function actionRow(action){
    var tr=document.createElement("tr"),stateText="Active",stateClass="state-ok";
    if(action.undoneAt){stateText=action.undoSkipped?"Partial undo":"Undone";stateClass=action.undoSkipped?"state-partial":"state-undone";}
    var actor=action.steamid||action.admin||"admin",kind=action.kind==="undo"?"Undo "+action.targetActionId:(action.kind==="ban"?"Ban"+(action.note?": "+action.note:""):(action.kind==="unban"?"Unban":(action.actor==="admin"?"Admin paint":"Player paint")));
    tr.innerHTML="<td>"+esc(new Date(action.at).toLocaleString())+"</td><td class=\\"actor\\">"+esc(actor)+"</td><td>"+esc(kind)+"</td><td>"+action.count+"</td><td class=\\""+stateClass+"\\">"+stateText+"</td><td><div class=\\"row-actions\\"></div></td>";
    var buttons=tr.querySelector(".row-actions");
    if(action.count>0){
      var previewButton=document.createElement("button");previewButton.className="secondary";previewButton.textContent="Preview";previewButton.onclick=function(){previewAction(action.id);};buttons.appendChild(previewButton);
    }
    if(action.actor==="player"&&!action.undoneAt){
      var undo=document.createElement("button");undo.className="secondary";undo.textContent="Undo";undo.onclick=function(){undoAction(action.id,false);};buttons.appendChild(undo);
      var force=document.createElement("button");force.className="danger";force.textContent="Force";force.title="Also overwrite pixels changed by later actions";force.onclick=function(){if(confirm("Force undo this action and overwrite newer pixels at the same coordinates?"))undoAction(action.id,true);};buttons.appendChild(force);
    }
    return tr;
  }
  async function undoAction(id,force){
    try{var result=await api("/admin/api/undo",{method:"POST",body:JSON.stringify({actionId:id,force:force})});clearPreview();await loadState();await loadActions(true);notify("Reverted "+result.changed+" pixels"+(result.skipped?"; skipped "+result.skipped+" newer changes":"")+".");}catch(e){notify(e.message,true);}
  }
  async function loadActions(reset){
    if(reset){cursor="";document.getElementById("actions").textContent="";}
    var steam=document.getElementById("steamId").value.trim(),path="/admin/api/actions?limit=50";
    if(steam)path+="&steamid="+encodeURIComponent(steam);if(cursor)path+="&before="+encodeURIComponent(cursor);
    document.getElementById("logStatus").textContent="Loading…";
    try{
      var data=await api(path),body=document.getElementById("actions");data.actions.forEach(function(a){body.appendChild(actionRow(a));});
      cursor=data.next||"";document.getElementById("moreActions").hidden=!cursor;
      document.getElementById("logStatus").textContent=data.actions.length?(steam?"Actions for "+steam:"All actions"):"No actions found.";
      if(reset)await loadBanState(steam);
    }catch(e){document.getElementById("logStatus").textContent=e.message;notify(e.message,true);}
  }
  async function loadBanState(steam){
    var ban=document.getElementById("banUser"),unban=document.getElementById("unbanUser");
    banState=null;ban.disabled=true;unban.disabled=true;
    if(!steam)return;
    var data=await api("/admin/api/ban-status?steamid="+encodeURIComponent(steam));
    banState=data;ban.disabled=data.banned;unban.disabled=!data.banned;
    if(data.banned)document.getElementById("logStatus").textContent="BANNED "+steam+(data.ban.reason?" · "+data.ban.reason:"");
  }
  async function setBan(banned){
    var steam=document.getElementById("steamId").value.trim();
    if(!steam)return;
    var reason="";
    if(banned){
      reason=prompt("Optional reason shown in the admin audit log:","")||"";
      if(!confirm("Ban Steam32 "+steam+" from Pixel Battle?"))return;
    }else if(!confirm("Unban Steam32 "+steam+"? The player must reload the mod before the button unlocks."))return;
    try{
      await api(banned?"/admin/api/ban":"/admin/api/unban",{method:"POST",body:JSON.stringify({steamid:steam,reason:reason})});
      await loadState();await loadActions(true);notify((banned?"Banned ":"Unbanned ")+steam+".");
    }catch(e){notify(e.message,true);}
  }
  document.getElementById("searchForm").addEventListener("submit",function(e){e.preventDefault();loadActions(true);});
  document.getElementById("banUser").addEventListener("click",function(){setBan(true);});
  document.getElementById("unbanUser").addEventListener("click",function(){setBan(false);});
  document.getElementById("moreActions").addEventListener("click",function(){loadActions(false);});
  fitCanvas();
  Promise.all([loadState(),loadActions(true)]).catch(function(e){notify(e.message,true);});
})();`;

function adminAssetResponse(path) {
  let body = "", type = "";
  if (path === "/admin" || path === "/admin/") {
    body = ADMIN_HTML;
    type = "text/html; charset=utf-8";
  } else if (path === "/admin/style.css") {
    body = ADMIN_CSS;
    type = "text/css; charset=utf-8";
  } else if (path === "/admin/app.js") {
    body = ADMIN_JS;
    type = "text/javascript; charset=utf-8";
  } else {
    return null;
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}

/* ── authored core (from server/worker.core.js) ── */
/* global CompressionStream, PX_ALPHA, PX_LAND_SPANS, PX_PALETTE, PX_VIEW_PALETTE, adminAssetResponse, atob */
/**
 * Deadlock Minigames relay - Worker-compatible CORE (authored source).
 *
 * ⚠ DO NOT DEPLOY THIS FILE DIRECTLY. The deploy artifact is `server/worker.js`,
 * generated by `node tools/build_worker.js`, which prepends the SHARED rule engines
 * (panorama/scripts/rules/*.js) so the server validates moves with byte-for-byte the
 * same code the client predicts with. Edit THIS file, then rebuild. See server/README.md.
 *
 * Panorama UI has no fetch / no AsyncWebRequest / no websockets. The ONLY channel
 * back to the client is the intrinsic pixel size of an <Image>: the client sets an
 * image src and reads actuallayoutwidth / actuallayoutheight. So every response here
 * is a tiny PNG whose (width, height) ENCODE two integers.
 *
 * Sending data TO the server is unlimited (URL query params). Only the RESPONSE is
 * squeezed into (width, height). This asymmetry is why the SEAT TOKEN (identity) can
 * flow up freely in the query while the downlink stays two small ints.
 *
 * Transport is strongly consistent because all state lives in ONE serialized Hub
 * instance. Production uses local SQLite; the legacy Cloudflare adapter can still
 * supply Durable Object storage. There is no eventually-consistent cache between players.
 *
 * DOWNLINK ENCODING (2026-07-20): every DATA response carries a small "level" per
 * dimension, dim = level*9 + 15 (see the d() encoder near the bottom). This survives
 * UI-scaled displays where the old dim=int+1 died (value 1 rendered as 2). Safe range is
 * levels 0..63 per dimension. The (w,h) pairs below are those LEVELS (what the client
 * decodes back), NOT raw pixels. Only /api/probe stays literal pixels (600,1000) - it's
 * the calibration reference. Proven 720p–8K by tools/mg_simulate_resolutions.js.
 *
 * Game routes below are GET + PNG (pass &rnd=... to defeat engine caching).
 * `/admin` and `/admin/*` are the separate GitHub-authenticated browser admin + JSON API.
 *   /api/probe                                    -> (600,1000) LITERAL px      swap + scale calibration
 *   /api/ping                                     -> (1,1)                       UI tester route
 *   /api/pxcanvas                                 -> 512x256 transparent PNG     shared Pixel Battle layer
 *   /api/pxview?x=X&y=Y&z=Z                       -> 800x400 opaque PNG           sharp 1/2/4/8/16x view
 *   /api/pxversion                                -> (version&63, version>>6)     reload only after a change
 *   /api/pxbank?id=STEAM32                        -> (balance&63, balance>>6)     100 cap, +1 / 30 seconds
 *   /api/pxput?id=STEAM32&b=x,y,c;...             -> remaining balance           10..128 unique pixels
 *   /api/create?game=G&tok=T                      -> dCode(code, host=false)     new PRIVATE lobby, host = seat 0
 *   /api/quick?game=G&tok=T&tc=..&cv=..            -> dCode(code, JOINER|HOST)   role is the code BAND, not +100
 *   /api/mquick?games=..&tok=T&tc=..&cv=..         -> dCode(code, JOINER|HOST)   multi-select; game fixed on join
 *   /api/cancel?code=C                            -> (1,1)                       drop a still-waiting lobby
 *   /api/join?code=C&tok=T                         -> (G, tcIndex+1) ok · (20,1) missing · (21,1) full
 *   /api/status?code=C&tok=T                      -> (players, game+1) · (9,1) gone
 *   /api/match?code=C                             -> (game, tcIndex*2+variantBit+1) · (9,1) gone/undecided
 *   /api/move?code=C&from=F&to=T&end=E&tok=T       -> (1,1) ok · (9,1) not-your-turn · (9,2) illegal · (9,3) bad-token · (9,9) gone
 *   /api/poll?code=C&since=S                       -> (from, to) RAW squares · (1,1) nothing new
 *   /api/reset?code=C&game=G&tok=T                 -> (1,1)
 *   /api/clocks?code=C&seat=S                      -> (30+sec>>6, sec&63) one seat · (9,9) no lobby · (9,8) untimed
 *
 * CODES are rebased to 0..1023 (was 4-digit 1000..9999) so a code half fits a level. dCode()
 * splits code = hi<<6 | lo: width = BAND + hi (joiner/create band 24, host band 40), height =
 * lo. The band both stays clear of every sentinel (1 ok · 9 err · 20/21/22 formation) AND
 * encodes the host/joiner role, so the old fragile +100 role flag is gone. validCode()
 * canonicalises the client's decimal code to the int storage key.
 *
 * POLL sends the move as RAW squares (from,to), no +1, no +100. The turn-hand-off flag `end`
 * is NOT transmitted - from+to+end is 13 bits > the 12 the codec allows - it is DERIVED on the
 * client by replaying the SAME shared rules engine on the SAME board (a mid-chain capture with
 * more jumps keeps the turn; else it hands off). The server stays authoritative on move
 * LEGALITY; end is pure segmentation. from != to for a real move, so (1,1) is still "nothing".
 *
 * CLOCKS are per-seat now (was both banks in one image): a bank is 0..600 = 10 bits and needs
 * BOTH dimensions (hi=sec>>6 on width band 30..39, lo=sec&63 on height). The caller passes
 * &seat=0|1 and resyncs both every ~8s. Both clients read the SAME server clock, so flag-fall (a
 * seat's bank hitting 0 = that seat loses) is server-decided with no drift. tc (60/180/300/600 s)
 * is chosen at create (create?tc=SEC), forced to 300 for a quick match, and carried to the
 * joiner as a small INDEX in the /api/join height (tcIndex, not raw seconds which overflow a
 * level). Untimed games (TTT/Durak/C4, tc=0) get (9,8) and never poll clocks.
 *
 * Move rejection codes all fit the 2-int downlink (width 9 + a small height discriminator):
 *   (9,1) not your turn · (9,2) illegal move · (9,3) bad/foreign token · (9,9) no lobby.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isAdminPath(url.pathname)) {
      if (url.pathname === "/admin/login") return beginGitHubLogin(url, env);
      if (url.pathname === "/admin/auth/callback") return finishGitHubLogin(request, url, env);
      if (url.pathname === "/admin/logout") return adminLogout(url);

      const auth = await authorizeAdmin(request, env);
      if (!auth.ok) return auth.response;

      const asset = adminAssetResponse(url.pathname);
      if (asset) return asset;
      if (!url.pathname.startsWith("/admin/api/")) {
        return new Response("Not found", { status: 404 });
      }

      // The Hub storage surface is not publicly addressable. Strip any caller-supplied
      // value and inject only the login from the outer-runtime-verified signed session.
      const headers = new Headers(request.headers);
      headers.delete("X-MG-Admin-Login");
      headers.set("X-MG-Admin-Login", auth.login);
      request = new Request(request, { headers: headers });
    } else if (!url.pathname.startsWith("/api/")) {
      return new Response("Deadlock Minigames relay OK", { status: 200 });
    }
    // /api/probe is the calibration reference: a literal 600x1000 all-zero PNG, identical for every
    // caller and independent of ALL state. It was going through the Durable Object like every other
    // route, which billed a DO request on top of the Worker request and re-encoded 601 KB from
    // scratch each time (the shared free-tier bucket covers both). Serve it here from a cached
    // compact pre-compressed buffer instead. /api/ping is a fixed (1,1) for the same reason.
    if (url.pathname === "/api/probe" || url.pathname === "/api/probe.png") return probeResponse();
    if (url.pathname === "/api/ping" || url.pathname === "/api/ping.png") return d(1, 1);
    // All game state lives in one strongly-consistent serialized Hub.
    const id = env.HUB.idFromName("hub");
    const stub = env.HUB.get(id);
    return stub.fetch(request);
  },
};

// The probe PNG never changes. This is a zlib-compressed 600x1000 all-zero grayscale image:
// 662 bytes instead of the generic stored-deflate encoder's 601113-byte response. The client
// reads only its intrinsic dimensions, so shipping hundreds of kilobytes of zeroes was pure
// latency/bandwidth. Decode the constant once per isolate.
const PROBE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAlgAAAPoCAAAAAAnsN/BAAACXUlEQVR42u3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgYLC8AAXJRhA8AAAAASUVORK5CYII=";
let PROBE_BYTES = null;
function probeResponse() {
  if (!PROBE_BYTES) {
    const binary = atob(PROBE_PNG_BASE64);
    PROBE_BYTES = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) PROBE_BYTES[i] = binary.charCodeAt(i);
  }
  return pngResponse(PROBE_BYTES);
}

const ADMIN_SESSION_COOKIE = "mg_admin_session";
const ADMIN_OAUTH_STATE_COOKIE = "mg_oauth_state";
const ADMIN_OAUTH_VERIFIER_COOKIE = "mg_oauth_verifier";
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

function isAdminPath(pathname) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

function adminDenied(message, status) {
  return {
    ok: false,
    response: new Response(message, {
      status: status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    })
  };
}

function base64UrlBytes(value) {
  let text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  while (text.length % 4) text += "=";
  const decoded = atob(text);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += alphabet[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += alphabet[c & 63];
  }
  return out;
}

function randomBase64Url(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function cookieValue(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim(), equals = part.indexOf("=");
    if (equals > 0 && part.substring(0, equals) === name) {
      return part.substring(equals + 1);
    }
  }
  return "";
}

function adminConfig(env) {
  const config = {
    clientId: String(env.GITHUB_CLIENT_ID || "").trim(),
    clientSecret: String(env.GITHUB_CLIENT_SECRET || "").trim(),
    githubId: String(env.ADMIN_GITHUB_ID || "").trim(),
    sessionSecret: String(env.ADMIN_SESSION_SECRET || "")
  };
  config.ok = !!(config.clientId && config.clientSecret &&
    /^\d+$/.test(config.githubId) && config.githubId !== "0" &&
    config.sessionSecret.length >= 32);
  return config;
}

function adminCookie(name, value, maxAge, path) {
  return name + "=" + value + "; Path=" + path +
    "; Max-Age=" + maxAge + "; HttpOnly; Secure; SameSite=Lax";
}

function redirectWithCookies(location, cookies) {
  const headers = new Headers({
    "Location": location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  for (let i = 0; i < cookies.length; i++) headers.append("Set-Cookie", cookies[i]);
  return new Response(null, { status: 302, headers: headers });
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

async function adminHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function issueAdminSession(config, user) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    id: String(user.id),
    login: String(user.login || ""),
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  })));
  const signature = await crypto.subtle.sign(
    "HMAC", await adminHmacKey(config.sessionSecret), new TextEncoder().encode(payload)
  );
  return payload + "." + base64UrlEncode(new Uint8Array(signature));
}

async function verifyAdminSession(request, config) {
  const token = cookieValue(request, ADMIN_SESSION_COOKIE);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC", await adminHmacKey(config.sessionSecret), base64UrlBytes(parts[1]),
      new TextEncoder().encode(parts[0])
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    const now = Math.floor(Date.now() / 1000);
    if (String(payload.id || "") !== config.githubId ||
        !/^[A-Za-z0-9-]{1,39}$/.test(String(payload.login || "")) ||
        !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

async function beginGitHubLogin(url, env) {
  const config = adminConfig(env);
  if (!config.ok) return adminDenied("Admin authentication is not configured.", 503).response;
  const state = randomBase64Url(32), verifier = randomBase64Url(48);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", url.origin + "/admin/auth/callback");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");
  return redirectWithCookies(authorize.toString(), [
    adminCookie(ADMIN_OAUTH_STATE_COOKIE, state, 600, "/admin/auth/callback"),
    adminCookie(ADMIN_OAUTH_VERIFIER_COOKIE, verifier, 600, "/admin/auth/callback")
  ]);
}

async function finishGitHubLogin(request, url, env) {
  const config = adminConfig(env);
  if (!config.ok) return adminDenied("Admin authentication is not configured.", 503).response;
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const savedState = cookieValue(request, ADMIN_OAUTH_STATE_COOKIE);
  const verifier = cookieValue(request, ADMIN_OAUTH_VERIFIER_COOKIE);
  const clearFlow = [
    adminCookie(ADMIN_OAUTH_STATE_COOKIE, "", 0, "/admin/auth/callback"),
    adminCookie(ADMIN_OAUTH_VERIFIER_COOKIE, "", 0, "/admin/auth/callback")
  ];
  if (!code || !state || state !== savedState || !verifier) {
    return redirectWithCookies("/admin/login?error=oauth", clearFlow);
  }

  try {
    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: url.origin + "/admin/auth/callback",
        code_verifier: verifier
      })
    });
    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenBody || !tokenBody.access_token) {
      return redirectWithCookies("/admin/login?error=token", clearFlow);
    }
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + tokenBody.access_token,
        "User-Agent": "Deadlock-Minigames-Admin",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    const user = await userResponse.json();
    if (!userResponse.ok || String(user && user.id || "") !== config.githubId ||
        !/^[A-Za-z0-9-]{1,39}$/.test(String(user && user.login || ""))) {
      const headers = new Headers({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      });
      for (let i = 0; i < clearFlow.length; i++) headers.append("Set-Cookie", clearFlow[i]);
      return new Response("This GitHub account is not allowed.", { status: 403, headers: headers });
    }
    const session = await issueAdminSession(config, user);
    clearFlow.push(adminCookie(ADMIN_SESSION_COOKIE, session, ADMIN_SESSION_SECONDS, "/admin"));
    return redirectWithCookies("/admin", clearFlow);
  } catch (error) {
    return redirectWithCookies("/admin/login?error=github", clearFlow);
  }
}

function adminLogout(url) {
  return redirectWithCookies(url.origin + "/admin/login", [
    adminCookie(ADMIN_SESSION_COOKIE, "", 0, "/admin")
  ]);
}

async function authorizeAdmin(request, env) {
  const config = adminConfig(env);
  if (!config.ok) {
    return adminDenied("Admin authentication is not configured.", 503);
  }
  const session = await verifyAdminSession(request, config);
  if (session) return { ok: true, login: session.login };
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin/api/")) return adminDenied("GitHub login required.", 401);
  return {
    ok: false,
    response: redirectWithCookies("/admin/login", [
      adminCookie(ADMIN_SESSION_COOKIE, "", 0, "/admin")
    ])
  };
}

export class Hub {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
    // In-memory per-IP sliding window for the lobby-FORMATION routes (create/join family).
    // Lives on the single Hub instance, so every request sees the same counters (no KV lag).
    // Keyed by trusted CF-Connecting-IP: the direct-VPS adapter overwrites that header from
    // the socket address; the legacy Cloudflare runtime supplies it at the edge. Legit players
    // approach the cap, while a brute-forcer sweeping the 4-digit code space or flooding
    // `create` is one IP and gets throttled. A null IP (local/tests) is exempt (fails open).
    // Hot read/poll routes skip this REQUEST-frequency limiter, but the separate distinct-code
    // guard below can safely slow enumeration with each route's existing gone sentinel.
    // Bounded to RL_MAX_IPS entries so the maps cannot be used to exhaust memory.
    this.rl = new Map();          // ip -> array of recent request timestamps (ms)
    this.codeScan = new Map();    // ip -> distinct lobby codes touched in the scan window
    this.pxrl = new Map();        // account+ip -> recent Pixel Battle uploads
    this.pxIpBudget = new Map();  // ip -> shared pixel token bucket (Steam32 rotation cannot reset it)
    this.pxViewRl = new Map();    // ip -> token bucket for expensive uncached viewport renders
    this.pxTiles = null;          // lazily hydrated sparse 32x32 canvas tiles
    this.pxViewCache = new Map(); // version+origin -> native-size edit viewport PNG
    this.pxCanvasCache = null;    // { version, bytes } for the compatibility canvas route
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

  // A normal client touches one lobby code repeatedly. Curl-style enumeration touches dozens of
  // DIFFERENT codes, so count distinct values rather than requests: polling, retries and several
  // people behind one NAT remain free, while a 0..1023 sweep slows to a crawl. This is a temporary
  // throttle, never a ban; the set resets after CODE_SCAN_WINDOW_MS.
  codeProbeOk(ip, code) {
    if (!ip || code === "") return true;
    const now = Date.now();
    let record = this.codeScan.get(ip);
    if (!record || now - record.at >= CODE_SCAN_WINDOW_MS) {
      if (!record && this.codeScan.size >= RL_MAX_IPS) {
        const first = this.codeScan.keys().next().value;
        if (first !== undefined) this.codeScan.delete(first);
      }
      record = { at: now, seen: new Set() };
      this.codeScan.set(ip, record);
    }
    if (record.seen.has(code)) return true;
    if (record.seen.size >= CODE_SCAN_MAX_CODES) return false;
    record.seen.add(code);
    return true;
  }

  // Shared IP pixel budget. It is deliberately generous enough for six fresh players behind one
  // household/NAT to spend their entire 100px banks immediately. Unlike the account bank it cannot
  // be reset by rotating a client-reported Steam32. Tokens refill continuously; no IP is banned.
  pixelSpendOk(ip, cost) {
    if (!ip || cost <= 0) return true;
    const now = Date.now();
    let record = this.pxIpBudget.get(ip);
    if (!record) {
      if (this.pxIpBudget.size >= PX_UPLOAD_MAX_KEYS) {
        const first = this.pxIpBudget.keys().next().value;
        if (first !== undefined) this.pxIpBudget.delete(first);
      }
      record = { at: now, tokens: PX_IP_PIXEL_BURST };
      this.pxIpBudget.set(ip, record);
    }
    record.tokens = Math.min(PX_IP_PIXEL_BURST,
      record.tokens + (now - record.at) * PX_IP_PIXEL_REFILL_PER_MS);
    record.at = now;
    if (record.tokens < cost) return false;
    record.tokens -= cost;
    return true;
  }

  // View navigation is bursty, so allow twelve uncached frames immediately and then one per
  // second. Cache hits never consume this budget. A human's coalesced D-pad/zoom requests stay
  // below it; a script cycling cache keys receives a retryable image sentinel instead of burning
  // the single Durable Object on continuous 800x400 deflates.
  pixelViewOk(ip) {
    if (!ip) return true;
    const now = Date.now();
    let record = this.pxViewRl.get(ip);
    if (!record) {
      if (this.pxViewRl.size >= PX_UPLOAD_MAX_KEYS) {
        const first = this.pxViewRl.keys().next().value;
        if (first !== undefined) this.pxViewRl.delete(first);
      }
      record = { at: now, tokens: PX_VIEW_BURST };
      this.pxViewRl.set(ip, record);
    }
    record.tokens = Math.min(PX_VIEW_BURST,
      record.tokens + (now - record.at) * PX_VIEW_REFILL_PER_MS);
    record.at = now;
    if (record.tokens < 1) return false;
    record.tokens -= 1;
    return true;
  }

  // A seated client may wait in a private/public lobby for longer than the 30-minute idle
  // sweep. Refresh the timestamp at most once per five minutes, and only for a valid seat
  // token: anonymous code scanners cannot pin guessed lobbies in storage.
  async touchWaitingLobby(code, lobby, tok) {
    if (!lobby || code === "" || seatOf(lobby, tok) < 0) return;
    const now = Date.now();
    if (!lobby.t || now - lobby.t >= LOBBY_TOUCH_MS) {
      lobby.t = now;
      await this.storage.put("l:" + code, lobby);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    // Panorama's <Image> loader only fetches URLs that look like an image, so the
    // client appends ".png" to every route. Strip it here before routing.
    const p = url.pathname.replace(/\.png$/, "");
    const q = url.searchParams;
    // Normalise `code` to a canonical 0..1023 integer string, or "" if it is malformed.
    // Code "0" is VALID, so route lookups must compare with "" rather than use truthiness.
    const code = validCode(q.get("code"));

    const clientIp = request.headers.get("CF-Connecting-IP");
    // Rate-limit the formation + existence-probe routes by client IP (the outer runtime
    // injects trusted CF-Connecting-IP; absent in direct Hub tests → fails open). (9,4) is a dedicated
    // "slow down" marker the throttled client methods surface as a friendly retry, and
    // it can never be confused with a real reply on these routes.
    if (THROTTLED_ROUTES[p] && !this.rateOk(clientIp)) {
      return d(9, 4);
    }
    // All code-bearing routes are existence oracles in some form (even token-gated draw/action
    // routes distinguish "gone" from "bad token"). Limit DISTINCT codes per IP, but never forge
    // a terminal "gone": each route family below gets a non-terminal/empty response it can decode.
    if (code !== "" && !CODE_SCAN_EXEMPT_ROUTES[p] && !this.codeProbeOk(clientIp, code)) {
      // Read/log routes return their ordinary "nothing new" value, hiding whether the code
      // exists without falsely telling a real client that its opponent left. Authenticated
      // writes use bad-token, clocks use a retryable server sentinel, and formation/status
      // routes keep the explicit busy marker their callers already retry.
      if (CODE_SCAN_EMPTY_ROUTES[p]) return d(1, 1);
      if (p === "/api/clocks") return d(9, 7);
      if (CODE_SCAN_AUTH_ROUTES[p]) return d(9, 3);
      return d(9, 4);
    }

    try {
      if (p.startsWith("/admin/api/")) return await handlePixelAdmin(this, request, url);
      if (p === "/api/probe") return probeResponse();
      if (p === "/api/ping") return d(1, 1);
      if (p === "/api/pxcanvas") return await pixelCanvasPng(this);
      if (p === "/api/pxview") {
        const account = validPixelAccount(q.get("id"));
        if (account && await pixelBan(this, account)) return d(5, 63);
        const zoom = pixelViewZoom(q.get("z"));
        const viewCols = PX_W / zoom, viewRows = PX_H / zoom;
        const viewX = clampInt(q.get("x"), 0, 0, PX_W - viewCols);
        const viewY = clampInt(q.get("y"), 0, 0, PX_H - viewRows);
        return await pixelViewPng(this, viewX, viewY, zoom, clientIp);
      }
      if (p === "/api/pxversion") {
        const account = validPixelAccount(q.get("id"));
        if (account && await pixelBan(this, account)) return d(5, 63);
        return pixelVersionPng(await pixelVersion(this));
      }
      if (p === "/api/pxbank") {
        const account = validPixelAccount(q.get("id"));
        if (!account) return d(1, 63);
        if (await pixelBan(this, account)) return d(5, 63);
        const bank = await pixelBank(this, account, 0);
        return pixelBankPng(bank.balance);
      }
      if (p === "/api/pxput") {
        const account = validPixelAccount(q.get("id"));
        if (!account) return d(1, 63);
        if (await pixelBan(this, account)) return d(5, 63);
        if (!pixelUploadRateOk(this, account, clientIp)) return d(4, 63);
        const batch = parsePixelBatch(q.get("b"));
        if (!batch) return d(2, 63);
        const result = await applyPixelBatch(this, account, batch, clientIp);
        if (!result.ok) return d(result.reason, 63);
        return pixelBankPng(result.balance);
      }

      if (p === "/api/create") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        if (!SUPPORTED_GAMES[game]) return d(9, 6);      // unsupported game id (6..9 have no engine)

        if (!validTok(q.get("tok"))) return d(9, 3);     // reject empty/garbage seat token
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                 // all 1024 lobby codes are occupied

        const tc = clockSecFor(game, q.get("tc"));         // 0 unless chess/checkers with a bank
        const cv = checkersVariantFor(game, q.get("cv"));
        const lobby = {
          game, players: 1, moves: [], pub: 0, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null], // seat 0 = host = white/X/+1, moves first
          turn: 0,                                     // seat index whose turn it is
          tc: tc,                                      // per-seat bank in SECONDS (0 = no clock)
          cv: cv,                                      // Russian or English checkers (empty for other games)
          state: initState(game, cv)                   // authoritative board/state
        };
        initClock(lobby);
        await this.storage.put("l:" + newCode, lobby);
        // Code rides the level-quantised downlink in the joiner/create band (see dCode).
        return dCode(newCode, false);
      }

      if (p === "/api/quick") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        if (!SUPPORTED_GAMES[game]) return d(9, 6);
        if (!validTok(q.get("tok"))) return d(9, 3);

        const rawTc = q.get("tc") || "0";
        const rawCv = q.get("cv") || CHECKERS_DEFAULT_VARIANT;
        const timeBuckets = timeBucketsFor(game, rawTc);
        const variantBuckets = variantBucketsFor(game, rawCv);
        const queues = [], seenQueues = {};
        function addQueue(key) { if (!seenQueues[key]) { seenQueues[key] = 1; queues.push(key); } }
        for (let ti = 0; ti < timeBuckets.length; ti++) {
          for (let vi = 0; vi < variantBuckets.length; vi++) {
            addQueue(quickQueueKey(game, timeBuckets[ti], variantBuckets[vi]));
            addQueue(multiQueueKey(game, timeBuckets[ti], variantBuckets[vi]));
          }
        }

        for (let i = 0; i < queues.length; i++) {
          const waitCode = await this.storage.get(queues[i]);
          // Code 0 is a real lobby code. Durable Object storage returns undefined for a
          // missing queue key, so use a nullish check rather than treating numeric 0 as empty.
          if (waitCode == null) continue;
          const w = await this.storage.get("l:" + waitCode);
          // Never seat a token into a lobby it already holds a seat in. Two /api/quick calls with
          // the same token used to seat the caller as its own opponent: seatOf returns the FIRST
          // match, so seat 1 became unreachable, every move was attributed to seat 0, and the game
          // wedged after the first move. Reachable honestly by double-clicking Quick Match, since
          // cancel then refuses to free the abandoned lobby (players is already 2).
          if (w && seatOf(w, q.get("tok")) >= 0) continue;
          const isMulti = w && w.game === 0 && w.games && w.games.indexOf(game) >= 0;
          if (w && w.pub && w.players < 2 && (w.game === game || isMulti) && preferencesMatch(w, game, rawTc, rawCv)) {
            await this.finalizeJoin(waitCode, w, q.get("tok"), game, resolveMatchOptions(w, game, rawTc, rawCv));
            return dCode(Number(waitCode), false);
          }
        }

        const hostTimeBucket = timeBucketFor(game, rawTc);
        const hostVariantBucket = variantBucketFor(game, rawCv);
        const cv = checkersVariantFor(game, rawCv);
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                 // all 1024 lobby codes are occupied
        const lobby = {
          game, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null],
          turn: 0,
          tc: CLOCK_GAMES[game] && rawTc !== "any" ? clockSecFor(game, rawTc) : 0,
          qtcAny: CLOCK_GAMES[game] && rawTc === "any" ? 1 : 0,
          cv: cv,
          qcvAny: wantsAnyCheckersVariant(game, rawCv) ? 1 : 0,
          qk: quickQueueKey(game, hostTimeBucket, hostVariantBucket),
          state: initState(game, cv)
        };
        initClock(lobby);
        await this.storage.put("l:" + newCode, lobby);
        await this.storage.put(lobby.qk, newCode);
        return dCode(newCode, true);
      }

      // Multi-select uses the same time-control and checkers-variant preferences as Quick
      // Match. The first compatible game fixes the lobby; /api/match exposes the result.
      if (p === "/api/mquick") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return d(9, 3);     // reject empty/garbage seat token
        const set = parseGameSet(q.get("games"));
        if (set.length === 0) return d(9, 6);            // no valid multi-capable game ids
        const rawTc = q.get("tc") || "0";
        const rawCv = q.get("cv") || CHECKERS_DEFAULT_VARIANT;
        const seenQueues = {};
        for (let i = 0; i < set.length; i++) {
          const g = set[i];
          const timeBuckets = timeBucketsFor(g, rawTc);
          const variantBuckets = variantBucketsFor(g, rawCv);
          for (let kind = 0; kind < 2; kind++) {
            for (let ti = 0; ti < timeBuckets.length; ti++) {
              for (let vi = 0; vi < variantBuckets.length; vi++) {
                const key = kind === 0
                  ? quickQueueKey(g, timeBuckets[ti], variantBuckets[vi])
                  : multiQueueKey(g, timeBuckets[ti], variantBuckets[vi]);
                if (seenQueues[key]) continue;
                seenQueues[key] = 1;
                const waitCode = await this.storage.get(key);
                if (waitCode == null) continue;             // code 0 is valid (see /api/quick)
                const w = await this.storage.get("l:" + waitCode);
                if (w && seatOf(w, q.get("tok")) >= 0) continue;   // never match a token to itself (see /api/quick)
                const isMulti = w && w.game === 0 && w.games && w.games.indexOf(g) >= 0;
                if (w && w.pub && w.players < 2 && (w.game === g || isMulti) && preferencesMatch(w, g, rawTc, rawCv)) {
                  await this.finalizeJoin(waitCode, w, q.get("tok"), g, resolveMatchOptions(w, g, rawTc, rawCv));
                  return dCode(Number(waitCode), false);
                }
              }
            }
          }
        }
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                 // all 1024 lobby codes are occupied
        const lobby = {
          game: 0, games: set, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null],      // host takes seat 0
          turn: 0,
          mtc: rawTc,
          mcv: rawCv,
          mqs: [],
          state: null                                      // fixed once a joiner picks a game
        };
        for (let i = 0; i < set.length; i++) {
          const g = set[i];
          const key = multiQueueKey(g, timeBucketFor(g, rawTc), variantBucketFor(g, rawCv));
          lobby.mqs.push(key);
          await this.storage.put(key, newCode);
        }
        await this.storage.put("l:" + newCode, lobby);
        // HOST: +100 on the width flags the role, exactly like /api/quick.
        return dCode(newCode, true);
      }

      if (p === "/api/cancel") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        // Only a SEATED player (valid token) may cancel, and only while the lobby is still
        // waiting for the second player. Never let a 4-digit code-guesser nuke an active match.
        if (lobby && seatOf(lobby, q.get("tok")) >= 0 && lobby.players < 2) {
          await this.storage.delete("l:" + code);
          await this.clearQueuesFor(lobby, code); // clear every per-game queue this lobby holds
        }
        return d(1, 1);
      }

      // ── leave a game already in progress ──────────────────────────────────────
      // `cancel` only fires while a lobby is still waiting (players < 2). Once a match is live,
      // the "Leave" button hits THIS route so the opponent learns immediately instead of relying
      // on the 30-min idle sweep. A valid seat token is the anchor of trust - a 4-digit
      // code-guesser holds no seat token, so it can never nuke someone else's active match.
      //   • Pair games (board games, or any table down to its last two present players): the lobby
      //     is deleted, so the survivor's next poll/dlog/plog - and any action - returns (9,9) and
      //     the client shows "Opponent left." (they win a decided game).
      //   • 3–4-seat durak/poker with ≥3 present: the seat is folded out via durakLeave/pokerLeave,
      //     which appends a LEFT event (+ DRAW/ROLES or board/WIN) to the public log so the table
      //     plays on without the leaver. The game only ends here if it drops to one player.
      if (p === "/api/leave") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(1, 1);                       // already gone - nothing to do
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(1, 1);                     // not a seated player: ignore, don't leak
        lobby.left = lobby.left || [];
        // A live multi-seat lobby keeps the departed seat object so old public events can still
        // resolve its stable index. That also means seatOf() continues to recognise its token:
        // make repeated leave requests a true no-op before they can append another LEFT event.
        if (lobby.left.indexOf(seat) >= 0) return d(1, 1);
        lobby.left.push(seat);
        const started = !!(lobby.state && lobby.state.started);
        const present = liveSeatCount(lobby);              // non-null seats not recorded as departed
        const isMultiSeat = !!lobby.cap && (lobby.game === 3 || lobby.game === 6);
        if (started && isMultiSeat && present >= 2) {
          // At the abuse-only log ceiling, folding one more poker seat without a matching LEFT
          // event would desynchronise every client. End the lobby cleanly instead of growing the
          // Durable Object value past MOVE_CAP or persisting an invisible state transition.
          if (lobby.game === 6 && lobby.state && lobby.state.log &&
              lobby.state.log.length >= MOVE_CAP) {
            await this.storage.delete("l:" + code);
            await this.clearQueuesFor(lobby, code);
            return d(1, 1);
          }
          // Table plays on without the leaver: fold them out and log it.
          if (lobby.game === 3) durakLeave(lobby, seat);
          else pokerLeave(lobby, seat);
          lobby.t = nowSeq();
          await this.storage.put("l:" + code, lobby);
          return d(1, 1);
        }
        // PRE-START multi-seat table: the leaver is not in a hand yet, so there is nothing to fold
        // out - but tearing the lobby down took everyone else with it. Any joiner who simply closed
        // the Esc menu in the room view (cleanupCurrentView calls /api/leave) killed the host's
        // table. Keep the lobby and leave a HOLE at that index instead.
        // The hole is deliberate: every seated client cached its own seat index when it joined and
        // is never told otherwise (droom/proom report only counts), so compacting `seats` would
        // silently hand a player someone else's seat. durakStart/pokerStart deal for
        // seats.length and then fold the holes out through the same durakLeave/pokerLeave path a
        // mid-game leave uses, so the holes cost nothing but a LEFT event.
        // The HOST leaving still ends it - nobody else can press Start.
        if (!started && isMultiSeat && present >= 2 && seat !== 0) {
          lobby.seats[seat] = null;
          lobby.t = nowSeq();
          await this.storage.put("l:" + code, lobby);
          return d(1, 1);
        }
        // Pair game, pre-start pair/host lobby, or the table just dropped to one player → tear it down.
        await this.storage.delete("l:" + code);
        await this.clearQueuesFor(lobby, code);
        return d(1, 1);
      }


      if (p === "/api/join") {
        if (!validTok(q.get("tok"))) return d(9, 3); // reject empty/garbage seat token
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(20, 1);             // missing
        // Game-type guard (H2): the generic 2-seat join hard-sets players=2/seats[1], which would
        // CORRUPT an N-seat poker/durak lobby (those carry `cap` and grow via seats.push through
        // pjoin/djoin). A poker lobby (game 6) is never joinable here either. Refuse both so a
        // guessed code can't clobber a multi-seat table - the client already routes them to
        // pjoin/djoin, so a legitimate joiner never hits this path.
        // `!lobby.game` covers an mquick lobby, which sits at game 0 until a SEEKER picks one of
        // lobby.games via finalizeJoin. Joining it here set players=2 with game still 0 and state
        // still null, which BRICKED the lobby for its full 30-minute life: the host's
        // waitForMultiMatch requires game > 0 so it span forever, /api/match answered (9,1), every
        // move answered (9,2), and the pubq:m:* queue keys stayed pinned to a dead code.
        if (lobby.cap || lobby.game === 6 || !lobby.game) return d(20, 1); // not a generic 2-seat lobby → "missing"
        // Already seated here? Answer idempotently instead of taking the second seat as well -
        // pjoin/djoin have always done this. Without it a host could type its OWN code and become
        // its own opponent, after which seatOf resolved every move to seat 0 and the game wedged.
        if (seatOf(lobby, q.get("tok")) >= 0) return d(lobby.game, tcIndex(lobby.tc || 0) + 1);
        if (lobby.players >= 2) return d(21, 1); // full

        lobby.players = 2;
        lobby.seats = lobby.seats || [null, null];
        lobby.seats[1] = { tok: q.get("tok") || "" }; // joiner takes seat 1
        initClock(lobby);                          // arm the bank now that both seats are present
        autoStartDealerIfFull(lobby);              // a private heads-up Durak room is now full
        await this.storage.put("l:" + code, lobby);
        // height carries the time-control INDEX+1 (0..4 → 1..5) so the joiner learns the host's
        // chosen bank without picking it. Index (not raw seconds) keeps it inside one level dim.
        // tc=0 → index 0 → height 1 (no clock), a plain "which game" reply.
        return d(lobby.game, tcIndex(lobby.tc || 0) + 1); // w: game (1..9) · h: tc-index + 1
      }

      if (p === "/api/status") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 1);              // gone
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        // height carries the chosen game + 1 (1 while an mquick lobby is still undecided,
        // game=0). A multi-select HOST reads it to learn which game a joiner picked; the
        // single-game callers ignore it (they already know their game). Never (9,x).
        return d(lobby.players, (lobby.game || 0) + 1); // w: 1|2 players · h: game+1
      }

      // Resolved-options readout: once a lobby is settled (both seats seated, or a single host
      // holding concrete prefs), report the CHOSEN game + time-control + checkers variant so a
      // client can mount the correct engine. The 2-int join/quick replies only carry role+code,
      // so the variant (and the exact bank for a resolved "Any") needs its own tiny channel.
      //   width  = game (1..9)
      //   height = tcIndex*2 + variantBit + 1   (variantBit: english=1, else 0; +1 keeps it ≥1)
      // e.g. Russian 3-min checkers = (1, 2*2+0+1) = (1,5). An undecided mquick lobby → (9,1).
      if (p === "/api/match") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 1);              // gone
        if (!lobby.game) return d(9, 1);         // still-undecided mquick lobby: no game fixed yet
        const g = lobby.game;
        const ti = CLOCK_GAMES[g] ? tcIndex(lobby.tc || 0) : 0;
        const variantBit = g === 1 && checkersVariantFor(g, lobby.cv) === "english" ? 1 : 0;
        return d(g, ti * 2 + variantBit + 1);
      }

      if (p === "/api/move") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);              // no lobby
        if (lobby.players < 2) return d(9, 1);   // can't move before the opponent has joined
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);            // bad / foreign token - caller isn't a seat here
        const from = clampInt(q.get("from"), 0, 0, 63);
        const to = clampInt(q.get("to"), 0, 0, 63);
        const end = clampInt(q.get("end"), 0, 0, 1);
        // Authoritative validation: the server owns the board, enforces whose turn it is,
        // and rejects any illegal move with a (9,x) code. The stored `end` is the one the
        // SERVER computes (never the client's), so a cheat can't forge the turn hand-off.
        // A seat that has already flagged (bank ran out) is out of moves - the game is over on
        // time and the server refuses further play from either side.
        if (clockCheckFlag(lobby) >= 0) { await this.storage.put("l:" + code, lobby); return d(9, 2); }
        const v = validateMove(lobby, seat, from, to, end);
        if (!v.ok) return d(9, v.code);          // (9,1) not your turn · (9,2) illegal
        // Hard ceiling on the move log (poll?since indexes it directly, so it can't be
        // truncated - we refuse to grow it past a size no real game reaches). A legit chess/
        // checkers game is well under 600 plies; MOVE_CAP is pure-abuse territory (two colluding
        // seats shuffling a piece to bloat the DO's storage). Reject as illegal past the cap.
        if (lobby.moves.length >= MOVE_CAP) return d(9, 2);
        lobby.moves.push(v.move);
        lobby.t = nowSeq();                        // keep-alive: TTL is measured from last activity
        // Clock accounting: bill the elapsed time to the seat that just moved, and (only when
        // the move ENDS the turn) start the opponent's clock. Mid-chain hops (checkers multi-
        // jump, v.move.e === 0) keep the SAME clock running - the turn hasn't handed off yet.
        // validateMove already advanced lobby.turn on a hand-off, so it names the next seat.
        clockCharge(lobby, v.move.e === 1, lobby.turn);
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);                          // accepted
      }


      if (p === "/api/poll") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);              // 9x9 signals lobby destroyed / opponent left
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const mv = lobby.moves[since]; // 0-based; this move is seq = since+1
        if (!mv) return d(1, 1);                 // nothing new (from==to can't be a real move)
        // width = from square, height = to square, both RAW 0..63. The turn-hand-off
        // flag `end` is NO LONGER sent: it fit neither dimension under the level codec
        // (from+to+end = 13 bits > 12), and it is derivable - the client applies the SAME
        // shared rules engine to the SAME board and recomputes it bit-for-bit (a mid-chain
        // capture with more jumps available keeps the turn; else it hands off). The server
        // stays authoritative on move LEGALITY; `end` is pure segmentation, safe to derive.
        // from != to for every real move, so a genuine reply can never read as (1,1).
        return d(mv.f, mv.t);
      }

      // Authoritative clocks. Returns ONE seat's remaining SECONDS per read (the caller
      // passes &seat=0|1 and polls both ~1/s). Splitting per-seat is forced by the level
      // codec: a bank is 0..600 = 10 bits, which needs BOTH dimensions (hi=sec>>6 on the
      // width, lo=sec&63 on the height), leaving no room to pack two banks in one image.
      //   -> (CLK_BASE+hi, lo)   remaining seconds for the asked seat (sec = hi*64 + lo)
      //   -> (9, 9)              lobby gone
      //   -> (9, 8)              lobby is UNTIMED (no bank configured)
      // Sentinels use width 9 (never a real clock: CLK_BASE=30 puts a real reading at width
      // 30..39), so they can't be misread as a time the way the old height>=900 trick risked.
      // Both clients read the SAME server clock, so they can't disagree on the time or on who
      // flagged: a seat's bank reaching 0 IS the flag-fall signal (that seat loses).
      if (p === "/api/clocks") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);              // gone
        if (!lobby.clkMs) return d(9, 8);        // untimed game → no clocks
        // Persist a freshly-detected flag so the outcome sticks for later polls / moves.
        if (clockCheckFlag(lobby) >= 0) await this.storage.put("l:" + code, lobby);
        const seat = clampInt(q.get("seat"), 0, 0, 1);
        const s = Math.min(600, Math.max(0, clockSec(lobby, seat)));
        return d(CLK_BASE + ((s >> 6) & 15), s & 63);   // width band 30..39, height 0..63
      }

      if (p === "/api/reset") {
        // Deprecated unsafe endpoint. A unilateral reset desynchronises the other players and used
        // to lose the English-checkers variant. Rematches must use the consensus handshake below.
        return d(9, 8);
      }

      // Rematch handshake. Every present seat polls this from the game-over screen; when all have
      // asked, the server resets/redeals, bumps `gen`, clears the
      // ready flags, and reports (2, gen+1). Until then it reports (1, gen+1) = "waiting".
      //   -> (1, gen+1) I'm marked, waiting for the other players
      //   -> (2, gen+1) consensus reached: state was reset THIS call, restart now
      //   -> (9,3) bad/foreign token · (9,9) no lobby
      // The caller passes &gen=<its current generation>. We only ARM a seat's flag when that
      // matches the lobby's live `gen`; a stale poll from BEFORE a restart (old gen) can't
      // re-arm the next rematch, it just reads the bumped gen and the client restarts. This is
      // what stops the flag "sticking" across consecutive rematches (no extra clear round-trip).
      if (p === "/api/rematch") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        lobby.gen = (lobby.gen || 0) % 63;         // normalise a legacy/persisted gen into 6 bits
        if (lobby.players < 2) return d(1, lobby.gen + 1); // opponent already left/never joined
        // Consent is per SEAT, across every seat that still holds one. `rm` used to be hard-wired
        // to two entries and the reset fired on rm[0] && rm[1] alone, so on a 3-4 seat durak/poker
        // table two players could wipe the game out from under the rest: state was re-initialised,
        // the public log truncated to empty, and every other seat's `since` cursor was left past
        // the end of it - a permanently frozen screen with no way back.
        const rmSeats = lobby.seats ? lobby.seats.length : 2;
        if (!lobby.rm || lobby.rm.length !== rmSeats) {
          const fresh = [];
          for (let i = 0; i < rmSeats; i++) fresh.push(false);
          lobby.rm = fresh;
        }
        const callerGen = clampInt(q.get("gen"), 0, 0, 100000);
        if (callerGen === lobby.gen) lobby.rm[seat] = true; // only arm against the live generation
        lobby.t = nowSeq();                                 // keep-alive
        // An empty seat can never answer, so it must not hold the rematch hostage. A seat is empty
        // either because a pre-start leave nulled it, or because a mid-game leave recorded it in
        // `left` (that path keeps the seat object so the public log's LEFT event still resolves).
        let allReady = true;
        for (let i = 0; i < rmSeats; i++) {
          if (lobby.seats && !lobby.seats[i]) continue;
          if (lobby.left && lobby.left.indexOf(i) >= 0) continue;
          if (!lobby.rm[i]) { allReady = false; break; }
        }
        if (allReady) {
          lobby.moves = [];
          lobby.turn = 0;
          // Mid-game departures retain their seat objects so their old log events keep stable
          // indices. A fresh dealer game must treat those seats as holes; otherwise Durak deals
          // them a hand again and Poker gives them a fresh stack despite nobody being there.
          if (lobby.seats && lobby.left) {
            for (let i = 0; i < lobby.left.length; i++) {
              const departed = lobby.left[i];
              if (departed >= 0 && departed < lobby.seats.length) lobby.seats[departed] = null;
            }
          }
          lobby.state = initState(lobby.game, lobby.cv, lobby.seats ? lobby.seats.length : 2);
          initClock(lobby);                        // fresh banks for the rematch
          // Board games are ready immediately after initState. Dealer games are not: their
          // remounted controllers only poll dlog/plog and never call Start again, so deal the
          // fresh game atomically with the successful rematch handshake.
          let redeal = null;
          if (lobby.game === 3) redeal = durakStart(lobby, 0);
          else if (lobby.game === 6) redeal = pokerStart(lobby, 0);
          if (redeal && !redeal.ok) return d(9, redeal.code || 2);
          // Wrap the generation into 6 bits so gen+1 stays a valid level (<=63) on the
          // downlink. gen is only used for equality / "did a restart happen" detection, and
          // 63 rematches can't elapse between two of a client's polls, so wrapping is safe.
          lobby.gen = (lobby.gen + 1) % 63;
          const cleared = [];
          for (let i = 0; i < rmSeats; i++) cleared.push(false);
          lobby.rm = cleared;
          await this.storage.put("l:" + code, lobby);
          return d(2, lobby.gen + 1);                     // everyone ready: reset done, gen bumped
        }
        await this.storage.put("l:" + code, lobby);
        return d(1, lobby.gen + 1);                       // waiting for the opponent
      }


      // ── Durak (authoritative dealer, 2–4 players) ──────────────────────────
      // Separate route set from the 2-int move/poll games: the worker OWNS the deck,
      // hands and seed, deals PRIVATELY per seat via /api/ddraw, and relays PUBLIC events
      // via an indexed /api/dlog. Clients rebuild table/trump/turn/roles/counts from the
      // public log and learn only their OWN card identities privately. All actions require
      // a seat token (tok → seat), which also gates ddraw so a cheat can't read a foreign
      // seat's private cards. Public Quick is heads-up; private tables use 2–4 seats.
      if (p === "/api/room") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 1);                        // gone
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        const started = lobby.state && lobby.state.started ? 2 : 1; // h: 2 started, 1 waiting
        return d(lobby.players, started);
      }
      if (p === "/api/start") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = durakStart(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();                                  // keep-alive: TTL from last activity
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);
      }
      if (p === "/api/dact") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        // Same MOVE_CAP guard the 2-int games and poker already carry. durak's st.pub was the one
        // monotonic log with no ceiling, so a seat that could keep appending events (see the PASS
        // idempotency fix in durakAct) could grow the lobby past the Durable Object's 128 KiB
        // per-value limit, after which storage.put threw and the table answered (9,7) forever.
        if (lobby.state && lobby.state.pub && lobby.state.pub.length >= MOVE_CAP) return d(9, 2);
        const a = clampInt(q.get("a"), 0, 1, 4);
        const pr = clampInt(q.get("p"), 0, 0, 5);
        const c = clampInt(q.get("c"), 0, 0, 35);
        const r = durakAct(lobby, seat, a, pr, c);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();                                  // keep-alive: TTL from last activity
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);
      }
      if (p === "/api/dlog") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.pub ? lobby.state.pub[since] : null;
        if (!ev) return d(1, 1);                           // nothing new (no event is (1,1))
        return d(ev.w, ev.h);
      }
      if (p === "/api/ddraw") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);                      // only your own seat's private cards
        const i = clampInt(q.get("i"), 0, 0, 100000);
        const priv = lobby.state && lobby.state.priv ? lobby.state.priv[seat] : null;
        const card = priv ? priv[i] : undefined;
        if (card === undefined || card === null) return d(1, 1); // no card at that index yet
        return d(card + 2, 1);
      }

      // ── Durak N-seat private lobby (2–4 players) ─────────────────────────────────
      // Mirrors the poker lobby routes (pcreate/pjoin/proom): the 2-int move/poll lobby is
      // hard-capped at 2 seats, so a 3–4-player table needs its OWN create/join/room that seats
      // up to `cap`. Once dealt, play runs through the SAME /api/start · /api/dact · /api/dlog ·
      // /api/ddraw handlers above - those are seat-token + state driven and seat-count agnostic,
      // so nothing about the game protocol changes; only lobby formation grows past two seats.
      if (p === "/api/dcreate") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return d(9, 3);
        const cap = clampInt(q.get("n"), 2, 2, 4);           // seat cap 2..4
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                    // all 1024 lobby codes are occupied
        const lobby = {
          game: 3, players: 1, moves: [], pub: 0, t: nowSeq(), cap: cap,
          seats: [{ tok: q.get("tok") || "" }],              // host = seat 0
          turn: 0,
          state: initState(3, null, cap)
        };
        await this.storage.put("l:" + newCode, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return dCode(newCode, true);
      }
      if (p === "/api/djoin") {
        if (!validTok(q.get("tok"))) return d(9, 3);
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 3 || !lobby.cap) return d(20, 1); // missing / not an N-seat durak lobby
        const existingSeat = seatOf(lobby, q.get("tok"));
        if (existingSeat >= 0)                                           // idempotent re-join (poll safety)
          return d(lobby.cap, existingSeat + 1);                         // preserve the caller's seat
        if (lobby.state && lobby.state.started) return d(22, 1);       // already started
        if (presentCount(lobby) >= lobby.cap) return d(21, 1);        // full
        // Reuse a hole a pre-start leave left behind before growing the table, so a 3-seat lobby
        // whose seat 1 walked away can be refilled instead of overflowing past `cap`.
        const holeD = seatHole(lobby);
        if (holeD >= 0) {
          lobby.seats[holeD] = { tok: q.get("tok") || "" };
          restoreLeftSeat(lobby, holeD);
        }
        else { lobby.seats.push({ tok: q.get("tok") || "" }); lobby.players++; }
        lobby.t = nowSeq();
        autoStartDealerIfFull(lobby);
        await this.storage.put("l:" + code, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return d(lobby.cap, (holeD >= 0 ? holeD : lobby.seats.length - 1) + 1);
      }
      if (p === "/api/droom") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 3 || !lobby.cap) return d(9, 1); // gone / not an N-seat durak lobby
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        const started = lobby.state && lobby.state.started ? ROOM_STARTED : 0;
        // width = players PRESENT (+ROOM_STARTED band once dealt) · height = seat cap.
        // liveSeatCount, not `players`: pre-start leaves create holes, while started games retain
        // departed seat objects for stable event indices. Neither should appear as present.
        return d(liveSeatCount(lobby) + started, lobby.cap);
      }

      // ── Poker (authoritative dealer, 2–4 players; its own multi-seat lobby) ──────
      // A poker lobby holds up to `cap` seats (chosen at create). Unlike the 2-int games it is
      // NOT capped at 2 - pjoin fills seats up to cap, and the host starts when ready.
      if (p === "/api/pcreate") {
        await this.maybeSweep();
        if (!validTok(q.get("tok"))) return d(9, 3);
        const cap = clampInt(q.get("n"), 2, 2, 4);           // seat cap 2..4
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                    // all 1024 lobby codes are occupied
        const lobby = {
          game: 6, players: 1, pub: 0, t: nowSeq(), cap: cap,
          seats: [{ tok: q.get("tok") || "" }],              // host = seat 0
          state: initState(6)
        };
        await this.storage.put("l:" + newCode, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return dCode(newCode, true);
      }
      if (p === "/api/pjoin") {
        if (!validTok(q.get("tok"))) return d(9, 3);
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(20, 1);   // missing / not a poker lobby
        const existingSeat = seatOf(lobby, q.get("tok"));
        if (existingSeat >= 0)                                // idempotent re-join (poll safety)
          return d(lobby.cap || 4, existingSeat + 1);          // preserve the caller's seat
        if (lobby.state && lobby.state.started) return d(22, 1); // already started
        if (presentCount(lobby) >= (lobby.cap || 4)) return d(21, 1); // full
        // Reuse a hole a pre-start leave left behind before growing the table (see /api/djoin).
        const holeP = seatHole(lobby);
        if (holeP >= 0) {
          lobby.seats[holeP] = { tok: q.get("tok") || "" };
          restoreLeftSeat(lobby, holeP);
        }
        else { lobby.seats.push({ tok: q.get("tok") || "" }); lobby.players++; }
        lobby.t = nowSeq();
        autoStartDealerIfFull(lobby);
        await this.storage.put("l:" + code, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return d(lobby.cap || 4, (holeP >= 0 ? holeP : lobby.seats.length - 1) + 1);
      }
      if (p === "/api/proom") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 1);    // gone
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        const started = lobby.state && lobby.state.started ? ROOM_STARTED : 0;
        // width = players PRESENT (+ROOM_STARTED band once started) · height = seat cap.
        // liveSeatCount, not `players` - see /api/droom.
        return d(liveSeatCount(lobby) + started, lobby.cap || 4);
      }
      if (p === "/api/pstart") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = pokerStart(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);
      }
      if (p === "/api/pact") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const a = clampInt(q.get("a"), 0, 0, 3);
        const to = clampInt(q.get("to"), 0, 0, 5000);
        const r = pokerAct(lobby, seat, a, to);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);
      }
      if (p === "/api/pnext") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = pokerNext(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put("l:" + code, lobby);
        return d(1, 1);
      }
      if (p === "/api/plog") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.log ? lobby.state.log[since] : null;
        if (!ev) return d(1, 1);                           // nothing new
        return d(ev.w, ev.h);
      }
      if (p === "/api/pdraw") {
        const lobby = code !== "" ? await this.storage.get("l:" + code) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const i = clampInt(q.get("i"), 0, 0, 1);             // exactly 2 hole cards (0,1)
        const hole = lobby.state && lobby.state.serverHole ? lobby.state.serverHole[seat] : null;
        const card = hole ? hole[i] : undefined;
        if (card === undefined || card === null) return d(1, 1);
        return d(card + 2, 1);                             // card+2, like ddraw
      }

      return d(9, 8); // unknown route
    } catch (e) {
      return d(9, 7); // server error marker
    }
  }

  async freshCode() {
    // Lobby code, rebased to 0..CODE_MAX (was 1000..9999). The whole code must ride DOWN in
    // one image on create/quick, and the level-quantised downlink caps a code at CODE_MAX
    // (=CODE_HI_MAX*64+63) so it can be split into two 6-bit halves (see codePng/CODE_*).
    // Random probes first, then a full linear scan as a fallback so we never clobber a live
    // lobby. Storage keys are "l:"+int, so a minted int and a client-typed code that
    // validCode canonicalised to the same int-string land on the same key.
    for (let i = 0; i < 200; i++) {
      const c = Math.floor(Math.random() * (CODE_MAX + 1));
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    for (let c = 0; c <= CODE_MAX; c++) {
      const existing = await this.storage.get("l:" + c);
      if (!existing) return c;
    }
    return -1; // server full (extremely unlikely); create surfaces it as a broken mint
  }

  // Seat a joiner into a waiting host lobby, FIXING the game if the host was a still-
  // undecided multi-select lobby (game 0 → the picked game, and initialise its board now
  // that we know which engine it needs). Clears EVERY per-game queue the host held, so a
  // multi-lobby registered under several games can never be double-joined.
  async finalizeJoin(waitCode, w, tok, game, opts) {
    opts = opts || {};
    // Resolve the pair's bank + checkers variant now that BOTH seats are known. resolveMatchOptions
    // has already reconciled the host's and seeker's preferences (a concrete pick wins over "Any";
    // two "Any"s fall to the 5-min / Russian defaults). Fix the lobby to those concrete values and
    // clear the "unresolved Any" flags so lobbyTimeChoice/lobbyVariantChoice read the settled state.
    if (w.game === 0) { w.game = game; w.games = null; }
    w.cv = game === 1 ? (opts.cv || checkersVariantFor(game, w.cv)) : "";
    if (CLOCK_GAMES[game]) w.tc = opts.tc || 0;
    else w.tc = 0;
    delete w.qtcAny; delete w.qcvAny;
    // (Re)initialise the board with the RESOLVED variant. An undecided mquick lobby had no state;
    // a single-quick "Any"-variant host may have been built for the wrong engine, so rebuild it.
    w.state = initState(w.game, w.cv);
    w.players = 2;
    w.seats = w.seats || [null, null];
    w.seats[1] = { tok: tok || "" };           // joiner takes seat 1
    initClock(w);                              // (re)anchor the bank to the JOIN moment, so a host that
                                               // waited in the public queue isn't billed for idle matchmaking
    autoStartDealerIfFull(w);                  // heads-up Durak starts as soon as matchmaking fills it
    await this.storage.put("l:" + waitCode, w);
    await this.clearQueuesFor(w, waitCode);
  }

  // Remove a lobby's code from every public queue it registered under. Two queue shapes, both
  // now keyed by (game, tc-bucket, variant-bucket):
  //   • single-quick  → one slot stored in lobby.qk        (pubq:q:<game>:<tc>:<cv>)
  //   • multi-select  → one pubq:m:… per candidate game, all stored in lobby.mqs[]
  // Only deletes a queue entry that still points at THIS code (a newer host may have replaced
  // it). Both shapes are cleared idempotently, so a mislabeled lobby can't strand a slot.
  async clearQueuesFor(lobby, code) {
    const keys = [];
    if (lobby.qk) keys.push(lobby.qk);
    if (lobby.mqs && lobby.mqs.length) for (let i = 0; i < lobby.mqs.length; i++) keys.push(lobby.mqs[i]);
    for (let i = 0; i < keys.length; i++) {
      const wc = await this.storage.get(keys[i]);
      if (wc != null && Number(wc) === Number(code)) await this.storage.delete(keys[i]);
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
        // Drop the public-queue slots BEFORE the lobby itself. Sweeping the lobby alone left the
        // pubq:q/pubq:m keys pointing at a dead code, and every later seeker paid a storage.get
        // per stranded key before falling through to hosting its own lobby.
        await this.clearQueuesFor(lobby, key.slice(2));
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

// Canonicalise an incoming lobby code. Codes are ints 0..CODE_MAX (see freshCode); the
// client sends the code as plain decimal digits. Parse strictly (1..4 digits, no signs/
// exponents/unicode), range-check, and return the CANONICAL int-string so a lookup key
// always matches the mint key regardless of zero-padding ("0042" and "42" → "42"). Out
// of range or malformed → "" so every `code ? …` guard falls to the missing/gone branch.
function validCode(raw) {
  if (typeof raw !== "string" || !/^[0-9]{1,4}$/.test(raw)) return "";
  const n = parseInt(raw, 10);
  return n >= 0 && n <= CODE_MAX ? String(n) : "";
}

// Lobby codes are rebased to 0..CODE_MAX so they fit the level-quantised downlink (a
// dimension carries a level 0..63; see the `d()` encoder). A code splits into hi=code>>6
// (0..15) on the width and lo=code&63 on the height. The width is OFFSET into a dedicated
// BAND - joiner/create at 24, host at 40 - so it can never land on an error sentinel
// (9 busy/err · 20 missing · 21 full · 22 started) or the (1,1) ok marker. Host vs joiner
// is thus the band, not a fragile +100. Client mirror: mg_net.js decodeCode().
const CODE_MAX = 1023;
const CODE_BAND_JOIN = 24;   // width 24..39 → joiner/create
const CODE_BAND_HOST = 40;   // width 40..55 → host (role flag folded into the band)
// proom/droom fold the "started" flag into the WIDTH as a band offset (was +100, which
// overflows a level): waiting → players 1..4, started → 51..54. Clear of every sentinel
// (1 ok · 9 err · 20/21/22 formation) and <=63. Client mirror: mg_net.js proom/droom.
const ROOM_STARTED = 50;
// Clocks band: a real per-seat reading is width 30..39 (hi = sec>>6, 0..9), height 0..63.
// 30 sits clear of the code bands (24..55 overlaps, but /api/clocks never returns a code)
// and clear of the {1,9,20,21,22} sentinel widths, so a live clock is never a sentinel.
const CLK_BASE = 30;
function dCode(code, isHost) {
  return d((isHost ? CODE_BAND_HOST : CODE_BAND_JOIN) + ((code >> 6) & 15), code & 63);
}

// ── per-IP rate limit for lobby FORMATION + existence-probe routes ────────────
// Window/cap are tuned so no legitimate flow comes close: a single client makes about one
// create/quick plus one status/room poll every 1.5 seconds, and even several players sharing
// one NAT stay below RL_MAX_HITS. Formation floods are capped here; the separate guard slows
// enumeration of the real 1024-code space to sixteen DISTINCT codes/minute while repeat reads
// of one lobby stay free. Hot game loops skip this request-frequency limiter because a generic
// (9,4) marker could corrupt their specialised decoders; scan rejection uses (9,9) instead.
const RL_WINDOW_MS = 10000;   // sliding window length
const RL_MAX_HITS = 60;       // max FORMATION/probe hits per IP per window
const RL_MAX_IPS = 5000;      // cap on tracked IPs (memory bound)
const CODE_SCAN_WINDOW_MS = 60000;
const CODE_SCAN_MAX_CODES = 16; // one code retries freely; a full 1024-code sweep takes >=64 min/IP
const LOBBY_TOUCH_MS = 5 * 60000; // authenticated room/status reads keep a waiting lobby alive cheaply
// Hard ceiling on a lobby's monotonic event array (moves[] for the 2-int games, log[] for
// poker, pub[] for durak). poll/plog/dlog `since` indexes these directly, so they can NEVER be
// truncated - instead we refuse to grow them past a size no honest game reaches (a full
// chess/checkers game is well under 600 plies; a 200-chip poker table ends in far fewer events).
// Only two colluding seats deliberately bloating the single DO's storage ever hit it.
// Sized against the Durable Object's 128 KiB PER-VALUE limit, not just against honest play: at
// 4000 entries moves[] alone serialises to ~88 KB, and the board, seats, clocks and (for poker)
// the deck state share that same value - close enough to the real limit that an abuser could
// still push a lobby into the storage.put exception that makes it answer (9,7) forever. 1200
// leaves ~26 KB for the log and a 4x margin for everything else.
const MOVE_CAP = 1200;
// Routes the limiter guards. Formation (create + every join variant) is the DoS +
// brute-force-join vector; the existence probes (status/room/proom/droom/match) are how a
// sweeper discovers which of the 1024 codes are live. Everything else - probe/ping
// (calibration must always work), cancel (frees lobbies), and the whole in-game loop -
// is intentionally exempt.
// /api/match belongs here despite answering per-lobby data: it is called ONCE per mount, not in
// the hot loop, and it answers (9,1) for a dead code and real data for a live one - the same
// existence oracle /api/status is, only it used to be free. Its client decoder already treats
// (9,4) as "busy, retry" (mg_net.js match), so the throttle sentinel is safe there.
const THROTTLED_ROUTES = {
  "/api/create": 1, "/api/quick": 1, "/api/mquick": 1, "/api/join": 1,
  "/api/pcreate": 1, "/api/pjoin": 1, "/api/dcreate": 1, "/api/djoin": 1,
  "/api/status": 1, "/api/room": 1, "/api/proom": 1, "/api/droom": 1,
  "/api/match": 1
};
// Distinct-code rejection must never masquerade as a terminal lobby/opponent departure.
// Tokenless read streams get "nothing new"; authenticated writes get their existing bad-token
// marker. leave/cancel are exempt because they reveal nothing and must always clean up.
const CODE_SCAN_EMPTY_ROUTES = {
  "/api/poll": 1, "/api/dlog": 1, "/api/ddraw": 1, "/api/plog": 1, "/api/pdraw": 1
};
const CODE_SCAN_AUTH_ROUTES = {
  "/api/move": 1, "/api/rematch": 1, "/api/start": 1, "/api/dact": 1,
  "/api/pstart": 1, "/api/pact": 1, "/api/pnext": 1, "/api/reset": 1
};
const CODE_SCAN_EXEMPT_ROUTES = {
  "/api/leave": 1, "/api/cancel": 1
};

// Game ids the generic /api/create lobby accepts. 3 = durak creates its lobby here too, then
// switches to its own dealer routes (room/start/dact/…). 6 = poker is DELIBERATELY absent: it
// owns a fully separate route set (pcreate/pjoin/pstart/pact/…) because the generic lobby is
// hard-capped at 2 seats and poker seats 2–4. An id outside this set has no engine, so
// create/quick reject it up front and move never relays it.
const SUPPORTED_GAMES = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };

// Games eligible for MULTI-select quick match. Durak (3) is safe here because every mquick
// lobby is a two-seat pair: once resolved it switches to the normal room/dlog/ddraw dealer
// flow and auto-starts. Poker remains private-table only. Parse "1,2,3,4,5" into a sorted set.
const MQUICK_GAMES = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };
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
const CHECKERS_VARIANTS = { russian: 1, english: 1 };
const CHECKERS_DEFAULT_VARIANT = "russian";
function clockSecFor(game, raw) {
  if (!CLOCK_GAMES[game]) return 0;
  const n = parseInt(raw, 10);
  return CLOCK_CHOICES[n] ? n : 0;   // reject anything not on the menu (0 = play untimed)
}
function checkersVariantFor(game, raw) {
  if (game !== 1) return "";
  return CHECKERS_VARIANTS[raw] ? raw : CHECKERS_DEFAULT_VARIANT;
}
function wantsAnyCheckersVariant(game, raw) { return game === 1 && raw === "any"; }
function timeBucketFor(game, raw) {
  if (!CLOCK_GAMES[game]) return "0";
  return raw === "any" ? "any" : String(clockSecFor(game, raw));
}
function variantBucketFor(game, raw) {
  if (game !== 1) return "0";
  return wantsAnyCheckersVariant(game, raw) ? "any" : checkersVariantFor(game, raw);
}
function timeBucketsFor(game, raw) {
  if (!CLOCK_GAMES[game]) return ["0"];
  if (raw === "any") return ["60", "180", "300", "600", "any"];
  return [String(clockSecFor(game, raw)), "any"];
}
function variantBucketsFor(game, raw) {
  if (game !== 1) return ["0"];
  if (wantsAnyCheckersVariant(game, raw)) return ["russian", "english", "any"];
  return [checkersVariantFor(game, raw), "any"];
}
function quickQueueKey(game, tc, cv) { return "pubq:q:" + game + ":" + tc + ":" + cv; }
function multiQueueKey(game, tc, cv) { return "pubq:m:" + game + ":" + tc + ":" + cv; }
function lobbyTimeChoice(lobby, game) {
  if (!CLOCK_GAMES[game]) return "0";
  if (lobby.game === 0 && lobby.mtc != null) return lobby.mtc === "any" ? "any" : String(clockSecFor(game, lobby.mtc));
  if (lobby.qtcAny) return "any";
  return String(lobby.tc | 0);
}
function lobbyVariantChoice(lobby, game) {
  if (game !== 1) return "0";
  if (lobby.game === 0 && lobby.mcv != null) return wantsAnyCheckersVariant(game, lobby.mcv) ? "any" : checkersVariantFor(game, lobby.mcv);
  if (lobby.qcvAny) return "any";
  return checkersVariantFor(game, lobby.cv);
}
function preferencesMatch(lobby, game, rawTc, rawCv) {
  const hostTc = lobbyTimeChoice(lobby, game);
  const seekerTc = CLOCK_GAMES[game] ? (rawTc === "any" ? "any" : String(clockSecFor(game, rawTc))) : "0";
  if (hostTc !== "any" && seekerTc !== "any" && hostTc !== seekerTc) return false;
  const hostCv = lobbyVariantChoice(lobby, game);
  const seekerCv = game === 1 ? (wantsAnyCheckersVariant(game, rawCv) ? "any" : checkersVariantFor(game, rawCv)) : "0";
  return hostCv === "any" || seekerCv === "any" || hostCv === seekerCv;
}
function resolveMatchOptions(lobby, game, rawTc, rawCv) {
  const hostTc = lobbyTimeChoice(lobby, game);
  const seekerTc = CLOCK_GAMES[game] ? (rawTc === "any" ? "any" : String(clockSecFor(game, rawTc))) : "0";
  let tc = 0;
  if (CLOCK_GAMES[game]) {
    if (hostTc !== "any" && Number(hostTc) > 0) tc = Number(hostTc);
    else if (seekerTc !== "any" && Number(seekerTc) > 0) tc = Number(seekerTc);
    else tc = QUICK_CLOCK_SEC[game];
  }
  const hostCv = lobbyVariantChoice(lobby, game);
  const seekerCv = game === 1 ? (wantsAnyCheckersVariant(game, rawCv) ? "any" : checkersVariantFor(game, rawCv)) : "";
  const cv = game === 1
    ? (hostCv !== "any" ? hostCv : (seekerCv !== "any" ? seekerCv : CHECKERS_DEFAULT_VARIANT))
    : "";
  return { tc: tc, cv: cv };
}
// The time control is one of a tiny fixed menu, so it rides the downlink as a small INDEX
// (0..4) rather than raw seconds (0..600 would overflow one level dimension). Client mirror:
// mg_net.js TC_SECS. Index 0 = untimed; 1..4 = 60/180/300/600 s.
const TC_SECS = [0, 60, 180, 300, 600];
function tcIndex(sec) { const i = TC_SECS.indexOf(sec | 0); return i < 0 ? 0 : i; }

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

// How many seats are actually occupied right now. `players` counts seats ever handed out and is
// never decremented (the seat INDEX has to stay stable for clients that cached it), so a pre-start
// leave leaves a null hole behind. Anything that asks "are there enough people to play / to show"
// must use this, not `players`.
function presentCount(lobby) {
  if (!lobby.seats) return lobby.players | 0;
  let n = 0;
  for (let i = 0; i < lobby.seats.length; i++) if (lobby.seats[i]) n++;
  return n;
}

// Count seats that are both occupied and still participating. Started multi-seat games retain
// a departed seat object for stable event indices, while pre-start departures leave a null hole.
// Checking both representations keeps leave decisions correct across either state.
function liveSeatCount(lobby) {
  if (!lobby.seats) return Math.max(0, (lobby.players | 0) - ((lobby.left && lobby.left.length) || 0));
  let n = 0;
  for (let i = 0; i < lobby.seats.length; i++) {
    if (!lobby.seats[i]) continue;
    if (lobby.left && lobby.left.indexOf(i) >= 0) continue;
    n++;
  }
  return n;
}

// Dealer rooms may start early by host request, but once every DECLARED seat is occupied there
// is nothing left to wait for. Start server-side so all clients observe one atomic state change;
// this also covers heads-up Durak quick/mquick lobbies, whose implicit cap is two.
function autoStartDealerIfFull(lobby) {
  if (!lobby || !lobby.state || lobby.state.started) return false;
  const cap = lobby.cap || (lobby.game === 3 ? 2 : 0);
  if (cap < 2 || liveSeatCount(lobby) < cap) return false;
  const result = lobby.game === 3 ? durakStart(lobby, 0)
    : lobby.game === 6 ? pokerStart(lobby, 0)
    : null;
  return !!(result && result.ok);
}

// A pre-start replacement inherits a vacated index, not the previous occupant's departure.
// Remove every stale copy defensively so rematch consensus and later leave counts see it as live.
function restoreLeftSeat(lobby, seat) {
  if (!lobby.left || !lobby.left.length) return;
  lobby.left = lobby.left.filter(function (leftSeat) { return leftSeat !== seat; });
}

// Index of the first seat a pre-start leave vacated, or -1 if the table is dense. Seat 0 (the
// host) is never a hole - a host leaving pre-start tears the lobby down instead.
function seatHole(lobby) {
  if (!lobby.seats) return -1;
  for (let i = 1; i < lobby.seats.length; i++) if (!lobby.seats[i]) return i;
  return -1;
}

// Fresh authoritative state per game. null = no server engine → legacy relay.
// Fresh authoritative state per game. null = no server engine → legacy relay.
// `seatCount` matters only for durak: its private-card array is per seat, and hard-coding two
// slots handed a 3-4 seat table a state that ddraw could never index for seats 2/3 (a rematch on
// such a table used to leave those seats permanently unable to read their own cards). Poker
// allocates `priv` at deal time, so it needs nothing here.
function initState(game, checkersVariant, seatCount) {
  const R = rules();
  if (game === 1) {
    const C = checkersVariantFor(game, checkersVariant) === "english" ? R.checkersEnglish : R.checkers;
    return { board: C.initialBoard(), chainSq: -1 };
  }
  if (game === 2) return { board: [0, 0, 0, 0, 0, 0, 0, 0, 0] };            // tic-tac-toe
  if (game === 4) return { board: R.chess.initialChessBoard(), cst: R.chess.initialChessState() }; // chess
  if (game === 3) {                                                                                // durak (dealt on /api/start)
    const priv = [];
    const n = Math.max(2, seatCount | 0);
    for (let i = 0; i < n; i++) priv.push([]);
    return { started: 0, pub: [], priv: priv };
  }
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
  if (lobby.game === 1) {
    const C = checkersVariantFor(1, lobby.cv) === "english" ? R.checkersEnglish : R.checkers;
    return validateCheckers(C, lobby, seat, from, to);
  }
  if (lobby.game === 2) return validateTtt(lobby, seat, from, to);
  if (lobby.game === 4) return validateChess(R.chess, lobby, seat, from, to);
  if (lobby.game === 5) return validateConnectFour(R.connectfour, lobby, seat, from, to);
  return { ok: false, code: 2 };
}


function validateCheckers(RC, lobby, seat, from, to) {
  const st = lobby.state, b = st.board;
  const side = seat === 0 ? RC.WHITE : RC.BLACK;
  const chaining = st.chainSq >= 0;
  // Reject any move once the game is decided, the way validateTtt/validateConnectFour do - a
  // loser could otherwise keep hopping after the end and bloat the finished log. Draughts is
  // decided when the side ON THE CLOCK has no move (or has no pieces at all); a mid-chain seat
  // is by definition still moving, so only test at a turn boundary.
  if (!chaining) {
    const mover = lobby.turn === 0 ? RC.WHITE : RC.BLACK;
    if (!RC.hasAnyMove(b, mover)) return { ok: false, code: 2 };
  }
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
  // Same piece may keep jumping → chain continues. A mid-capture promotion ends the chain
  // only where the variant says so (English); Russian canon: the fresh king keeps capturing.
  const more = res.captured && (!res.promoted || !RC.promotionEndsTurn) && RC.captureMoves(b, to).length > 0;
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
  // Reject moves once the game is decided (mirrors validateTtt/validateConnectFour). The mover's
  // own terminal state is what matters, and `side` IS the mover here since the turn check passed.
  // Repetition is intentionally NOT counted server-side: it needs the whole position list, and
  // both clients already agree on it from the same move log, so the extra state buys nothing.
  if (RX.chessResult(st.board, st.cst, side) !== "ongoing") return { ok: false, code: 2 };
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
 * which for 3–4 players depends on refill order + who ran out of cards - state the client can't
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
  // Deal for every seat INDEX that exists, holes included: a pre-start leave nulls seats[i] but
  // must not renumber the others (each client cached its own index). Holes are folded out right
  // after the deal, below.
  const n = lobby.seats ? lobby.seats.length : lobby.players;
  if (presentCount(lobby) < 2) return { ok: false, code: 2 };   // need at least two live players
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
  // Fold out the holes a pre-start leave left behind, through the SAME path a mid-game leave
  // uses - so every client replays it off the public log with no new event type. Runs after the
  // deal because leaveSeat needs a live state to fold out of.
  if (lobby.seats) {
    for (let s = 0; s < n; s++) if (!lobby.seats[s]) durakLeave(lobby, s);
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
  // who went `out`, and skip-the-taker rules - all card-state the client can't replay). Emitting
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
// then flushes the board/showdown/WIN the fold may have triggered - exactly like a normal fold.
function pokerLeave(lobby, seat) {
  const R = rules().poker;
  const s = lobby.state;
  if (!s || !s.started) return;
  s.log = s.log || [];
  s.leftLogged = s.leftLogged || [];
  if (s.leftLogged[seat]) return;                            // repeated leave is a true no-op
  if (s.log.length >= MOVE_CAP) return;                      // never grow the persisted value past its cap
  s.leftLogged[seat] = 1;
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
    // Only auto-beat if canBito already holds - under the explicit-Bito rule that's only when every
    // remaining attacker holds NO cards. An attacker still holding cards must send its own PASS
    // (Bito) first, so the covered table stays visible until confirmed instead of being swept to
    // discard the instant the defence lands.
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
    // (Bito) only once EVERY in-play attack seat has settled (passed or holds no legal throw-in) -
    // NOT the moment the primary attacker knocks. So this records the pass authoritatively and
    // only ends the bout when consensus is reached; otherwise it echoes a PASS event so the other
    // clients update their local `passed` set (which gates their own Pass button + status).
    if (seat === st.defender || st.out[seat]) return { ok: false, code: 1 };
    if (st.table.length === 0 || R.uncoveredCount(st) !== 0) return { ok: false, code: 2 };
    // Idempotent: applyPass is (rules/durak.js just sets passed[seat] = true), but dpush is NOT.
    // A client spamming /api/dact?a=4 from one seat appended a fresh PASS event every time, and
    // st.pub is the ONE log MOVE_CAP never bounded - it grew until the Durable Object hit its
    // 128 KiB per-value limit, at which point storage.put threw and EVERY later request on that
    // lobby (including the defender's) answered (9,7) forever. Re-passing is now a no-op.
    if (st.passed[seat]) return { ok: true };
    R.applyPass(st, seat);
    if (R.canBito(st)) { dpush(st, 40, 1); durakEndBout(st, false); }
    else dpush(st, 41 + seat, 1);                        // PASS(seat) - window stays open for others
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
 * card-INDEPENDENT), and fills board + revealed hole cards + winners from the log - so it never
 * needs the deck and can't diverge from the server.
 *
 * Public event log entries (each fits the 2-int downlink; width picks the type, height the
 * payload+1; a real entry can never decode to (1,1) = "nothing new"):
 *   HAND   (2, button+1)                     start a fresh hand, dealer button on `button`
 *   FOLD   (10+seat, 1)                      seat folds
 *   CHECK  (20+seat, 1)                      seat checks
 *   CALL   (30+seat, 1)                      seat calls
 *   RAISE  (40+seat, to&63) + RAISEHI (44+seat, to>>6)   raise TO `to` chips, split into
 *                                            a lo/hi 6-bit pair (to = hi*64 + lo, up to ~800);
 *                                            width 40-47 never reads as (1,1), so no +1 needed
 *   BOARD  (5, card+1)                       one community card revealed (card 0..51)
 *   SHOW   (60+seat, card+1)                 a hole card of `seat` shown at showdown
 *   WIN    (7, 1)                            hand resolved - client runs resolveShowdown/finish
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
  // SECURITY (C1): the seed MUST be a fresh CSPRNG draw per hand - never derived from
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
  // shared reducer the client uses - guaranteeing identical validation. The server keeps the
  // real cards in s.hole for private dealing + showdown.
  s.st = R.newHand(n, st.button, stacks, PK_SB, PK_BB, null); // online shell (no cards)
  // BUG (2026-07-18, "three identical 2♠ on the flop online"): newHand deals the board LAZILY -
  // st.board is [] until nextStreet shifts cards off the deck. Reading st.board here captured an
  // empty array, so pokerFlush emitted BOARD(undefined) → PNG h=1 → the client decoded card id 0
  // (= 2♠) for every community card. The 5 board cards are the TOP of the freshly-dealt deck AFTER
  // the 2·n hole cards (dealBoard/runout just shift them in flop/turn/river order), so slice them
  // straight off the deck now. Verified byte-identical to the real runout for every seed.
  s.st.__fullBoard = st.deck.slice(0, 5);             // full 5-card board (server reveals on schedule)
  s.serverHole = st.hole;                             // real hole cards for showdown eval
  // The log is CONTINUOUS across hands so the client's `since` cursor stays monotonic - a HAND
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
  // called down / all-in runout) reveals all five. But an uncontested "over" - everyone
  // folded to one player - reveals NOTHING new: no community card is shown for a hand that
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
    s.log.push({ w: 7, h: 1 });                       // WIN - client resolves locally too
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
  // Seat COUNT is the index space, holes included: a pre-start leave nulls seats[i] and must not
  // renumber anyone (each client cached its own index at join). A hole simply starts with a zero
  // stack, which newHand's `stacks[s] > 0` test already reads as "sitting out" - no extra event,
  // no special case downstream.
  const n = lobby.seats ? lobby.seats.length : lobby.players;
  if (presentCount(lobby) < 2) return { ok: false, code: 2 };   // need at least two live players
  s.n = n;
  s.button = -1;                                       // first hand normalises to seat 0
  s.stacks = [];
  for (let i = 0; i < n; i++) s.stacks.push(lobby.seats && !lobby.seats[i] ? 0 : PK_START);
  s.started = 1;
  pokerNewHand(lobby);
  // HAND makes every remounted client build the same N-seat shell. Follow it with LEFT for each
  // hole so clients also zero those stacks and never wait for an absent seat to act.
  if (lobby.seats) {
    for (let i = 0; i < n; i++) if (!lobby.seats[i]) pokerLeave(lobby, i);
  }
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
  else {
    // RAISE. The raise-TO amount reaches the whole stack (~800), which is 10 bits -
    // it can't ride one dimension's 6-bit level. Split into a lo/hi PAIR of events the
    // client restitches: RAISE(40+seat, to&63) then RAISEHI(44+seat, to>>6). Both use
    // RAW 6-bit halves (no +1): width 40..47 can never read as the (1,1) "nothing new"
    // marker, so height 0 is safe. to = hi*64 + lo, capped at MOVE-log growth like any
    // event pair. Client mirror: mg_net.js plog raise/raisehi.
    const t = to | 0;
    s.log.push({ w: 40 + seat, h: t & 63 });
    s.log.push({ w: 44 + seat, h: (t >> 6) & 63 });
  }
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
  // MOVE_CAP is far above any honest game, so this only ever trips on abuse - after which no
  // new hand is dealt and the table effectively ends where it is.
  if (s.log && s.log.length >= MOVE_CAP) return { ok: false, code: 2 };
  pokerNewHand(lobby);
  return { ok: true };
}


/* ─────────────────────────── LEVEL DOWNLINK ENCODING ───────────────────────────
 * Every DATA response is a "level" per dimension, not a raw integer:
 *   dim = level*STEP + BASE      (STEP=9, BASE=15)
 * WHY: the old dim=int+1 encoding dies on a UI-scaled display. The engine rounds
 * actuallayout, and on scale>1 it biases small sizes UPWARD ~1px, so value 1 renders
 * indistinguishable from 2 - corrupting corner-square moves, the (1,1) marker, and
 * every code half. STEP=9 spaces adjacent levels 9 logical px apart, so a ±2px engine
 * error can't cross a boundary even when a sub-1080p display downscales. Safe range is
 * levels 0..63 (63*9+15 = 582px < the 600px probe envelope, so the host panel is never
 * clamped). Proven across 720p–8K by tools/mg_simulate_resolutions.js. Mirrors
 * mg_net.js decodeLevel EXACTLY. See github2/IMAGE_SIDECHANNEL_1PX_BUG.md.
 *
 * probe stays a LITERAL png(600,1000): it is the calibration reference the client
 * divides by, so it must carry its true pixel size, not a level. Everything else goes
 * through d(w,h). */
const STEP = 9, BASE = 15;
function d(w, h) { return png(w * STEP + BASE, h * STEP + BASE); }

/* ───────────────────────── Pixel Battle ─────────────────────────
 * The generated Natural Earth mask is the immutable base; paint is stored in
 * sparse 32x32 chunks. /pxcanvas emits a transparent paint layer for compatibility,
 * while /pxview composites a sharp native-size frame for every interactive zoom.
 */
const PX_W = 512, PX_H = 256, PX_TILE = 32, PX_TILE_COLS = PX_W / PX_TILE;
const PX_VIEW_W = 800, PX_VIEW_H = 400;
const PX_BANK_CAP = 100, PX_REGEN_MS = 30000;
const PX_MIN_BATCH = 10, PX_MAX_BATCH = 128;
const PX_UPLOAD_WINDOW_MS = 60000, PX_UPLOAD_MAX_HITS = 30, PX_UPLOAD_MAX_KEYS = 5000;
const PX_IP_PIXEL_BURST = 600;
const PX_IP_PIXEL_REFILL_PER_MS = 120 / 60000; // 120 changed pixels/min after the six-player burst
const PX_VIEW_BURST = 12;
const PX_VIEW_REFILL_PER_MS = 1 / 1000;         // one new uncached viewport per second
const PX_ADMIN_MAX_BATCH = 4096;
const PX_AUDIT_RETENTION_MS = 180 * 24 * 60 * 60000;
const PX_AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60000;
const PX_AUDIT_PRUNE_LIMIT = 512; // bounded once-daily cleanup; enough for normal public traffic
const PX_ADMIN_COLOR_NAMES = [
  "eraser", "white", "light gray", "dark gray", "black", "red", "orange", "yellow",
  "lime", "green", "cyan", "blue", "navy", "purple", "magenta", "pink", "brown",
  "ocean", "land"
];

function pixelViewZoom(raw) {
  const zoom = Number(raw);
  return zoom === 1 || zoom === 2 || zoom === 4 || zoom === 8 || zoom === 16 ? zoom : 16;
}

function validPixelAccount(raw) {
  if (typeof raw !== "string" || !/^[0-9]{5,12}$/.test(raw) || raw === "0") return "";
  return raw;
}

async function pixelBan(hub, account) {
  return await hub.storage.get("px:b:" + account) || null;
}

function pixelBankPng(balance) {
  return d(balance & 63, (balance >> 6) & 63);
}

// The canvas version rides ONE 2-int reply as (lo6, hi6), so it must stay clear of the reserved
// error band: the client reads h === 63 as an error and (5,63) specifically as "you are banned".
// A 12-bit version (& 4095) put every value from 4032 up into that band - version 4037 encoded
// bit-for-bit identically to the ban sentinel, so a canvas that had simply been painted 4037 times
// showed every client a false ban, and the other 63 values in the band broke the poll outright.
// PX_VERSION_MOD keeps h <= 62. The version is only ever compared for equality ("did the canvas
// change?"), so wrapping one step earlier costs nothing.
const PX_VERSION_MOD = 63 * 64;         // 4032 → version 0..4031 → h 0..62

function pixelVersionPng(version) {
  return d(version & 63, (version >> 6) & 63);
}

async function pixelVersion(hub) {
  return ((await hub.storage.get("px:version")) || 0) % PX_VERSION_MOD;
}

async function pixelBank(hub, account, spend) {
  const key = "px:u:" + account;
  const now = Date.now();
  let record = await hub.storage.get(key);
  if (!record || !Number.isFinite(record.balance) || !Number.isFinite(record.at)) {
    record = { balance: PX_BANK_CAP, at: now };
  }

  let current = Math.max(0, Math.min(PX_BANK_CAP, record.balance | 0));
  let at = Math.min(now, Math.max(0, Number(record.at) || now));
  if (current >= PX_BANK_CAP) {
    at = now;
  } else {
    const gained = Math.floor((now - at) / PX_REGEN_MS);
    if (gained > 0) {
      current = Math.min(PX_BANK_CAP, current + gained);
      at = current >= PX_BANK_CAP ? now : at + gained * PX_REGEN_MS;
    }
  }

  if (spend > current) return { ok: false, balance: current };
  current -= spend;
  await hub.storage.put(key, { balance: current, at: at });
  return { ok: true, balance: current };
}

function parsePixelBatch(raw) {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const parts = raw.split(";");
  if (parts.length < PX_MIN_BATCH || parts.length > PX_MAX_BATCH) return null;
  const unique = new Map();
  for (let i = 0; i < parts.length; i++) {
    const match = /^([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,2})$/.exec(parts[i]);
    if (!match) return null;
    const x = parseInt(match[1], 10), y = parseInt(match[2], 10), color = parseInt(match[3], 10);
    if (x < 0 || x >= PX_W || y < 0 || y >= PX_H || color < 0 || color >= PX_PALETTE.length) return null;
    unique.set(x + "," + y, { x: x, y: y, color: color });
  }
  if (unique.size < PX_MIN_BATCH || unique.size > PX_MAX_BATCH) return null;
  return Array.from(unique.values());
}

function pixelUploadRateOk(hub, account, ip) {
  if (!ip) return true;
  const key = account + "|" + ip;
  const now = Date.now();
  let hits = hub.pxrl.get(key);
  if (!hits) {
    if (hub.pxrl.size >= PX_UPLOAD_MAX_KEYS) {
      const oldest = hub.pxrl.keys().next().value;
      if (oldest !== undefined) hub.pxrl.delete(oldest);
    }
    hits = [];
    hub.pxrl.set(key, hits);
  }
  let keep = 0;
  for (let i = 0; i < hits.length; i++) if (now - hits[i] < PX_UPLOAD_WINDOW_MS) hits[keep++] = hits[i];
  hits.length = keep;
  if (hits.length >= PX_UPLOAD_MAX_HITS) return false;
  hits.push(now);
  return true;
}

async function pixelTiles(hub) {
  if (hub.pxTiles) return hub.pxTiles;
  const stored = await hub.storage.list({ prefix: "px:t:" });
  const tiles = new Map();
  for (const [key, value] of stored) {
    const index = parseInt(String(key).substring(5), 10);
    if (!Number.isFinite(index) || index < 0) continue;
    if (value instanceof Uint8Array && value.length === PX_TILE * PX_TILE) tiles.set(index, value);
    else if (Array.isArray(value) && value.length === PX_TILE * PX_TILE) tiles.set(index, Uint8Array.from(value));
  }
  hub.pxTiles = tiles;
  return tiles;
}

function pixelAt(tiles, x, y) {
  const tx = Math.floor(x / PX_TILE), ty = Math.floor(y / PX_TILE);
  const tile = tiles.get(ty * PX_TILE_COLS + tx);
  return tile ? tile[(y % PX_TILE) * PX_TILE + (x % PX_TILE)] : 0;
}

async function applyPixelBatch(hub, account, batch, ip) {
  const tiles = await pixelTiles(hub);
  const changed = [];
  for (let i = 0; i < batch.length; i++) {
    const pixel = batch[i];
    const before = pixelAt(tiles, pixel.x, pixel.y);
    if (before !== pixel.color) {
      changed.push({ x: pixel.x, y: pixel.y, before: before, after: pixel.color });
    }
  }

  if (!hub.pixelSpendOk(ip, changed.length)) return { ok: false, reason: 4, balance: 0 };
  // Both the production SQLite adapter and SQLite-backed Durable Objects expose transaction().
  // Keep the player's bank, sparse tiles,
  // version, audit action, and ownership attribution all-or-nothing. Work on a cloned in-memory
  // tile cache and publish it only after commit; an aborted transaction therefore cannot leave
  // this isolate serving uncommitted pixels from RAM.
  return pixelStorageTransaction(hub, function (txHub) {
    return applyPixelChanges(txHub, account, changed);
  }, tiles);
}

async function pixelStorageTransaction(hub, work, sourceTiles) {
  if (typeof hub.storage.transaction !== "function") {
    const fallbackResult = await work(hub);
    await bestEffortPixelAuditPrune(hub);
    return fallbackResult;
  }
  const tiles = sourceTiles || await pixelTiles(hub);
  const txTiles = new Map();
  for (const [index, tile] of tiles) txTiles.set(index, new Uint8Array(tile));
  const result = await hub.storage.transaction(async function (txn) {
    const txHub = Object.create(hub);
    txHub.storage = txn;
    txHub.pxTiles = txTiles;
    txHub.pxViewCache = new Map();
    txHub.pxCanvasCache = null;
    return work(txHub);
  });
  hub.pxTiles = txTiles;
  hub.pxViewCache.clear();
  hub.pxCanvasCache = null;
  await bestEffortPixelAuditPrune(hub);
  return result;
}

async function applyPixelChanges(hub, account, changed) {
  const bank = await pixelBank(hub, account, changed.length);
  if (!bank.ok) return { ok: false, reason: 3, balance: bank.balance };
  if (changed.length === 0) return { ok: true, balance: bank.balance };

  const ownership = await attachPixelOwners(hub, changed);
  await persistPixelDeltas(hub, changed);
  const action = await logPixelAction(hub, {
    actor: "player",
    steamid: account,
    kind: "paint",
    deltas: changed
  });
  await persistPixelOwnership(hub, changed, action.id, ownership);
  return { ok: true, balance: bank.balance };
}

async function persistPixelDeltas(hub, changed) {
  const tiles = await pixelTiles(hub);
  const dirty = new Map();
  for (let i = 0; i < changed.length; i++) {
    const pixel = changed[i];
    const tx = Math.floor(pixel.x / PX_TILE), ty = Math.floor(pixel.y / PX_TILE);
    const index = ty * PX_TILE_COLS + tx;
    let tile = tiles.get(index);
    if (!tile) {
      tile = new Uint8Array(PX_TILE * PX_TILE);
      tiles.set(index, tile);
    }
    tile[(pixel.y % PX_TILE) * PX_TILE + (pixel.x % PX_TILE)] = pixel.after;
    dirty.set(index, tile);
  }
  for (const [index, tile] of dirty) {
    let hasPaint = false;
    for (let i = 0; i < tile.length; i++) {
      if (tile[i] !== 0) { hasPaint = true; break; }
    }
    if (hasPaint) {
      await hub.storage.put("px:t:" + index, tile);
    } else {
      await hub.storage.delete("px:t:" + index);
      tiles.delete(index);
    }
  }
  const version = ((await pixelVersion(hub)) + 1) % PX_VERSION_MOD;   // stays clear of the h=63 error band
  await hub.storage.put("px:version", version);
  hub.pxViewCache.clear();
  hub.pxCanvasCache = null;
  return version;
}

function pixelActionId() {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return String(Date.now()).padStart(13, "0") + "-" + random[0].toString(16).padStart(8, "0");
}

function validPixelActionId(raw) {
  return typeof raw === "string" && /^[0-9]{13}-[0-9a-f]{8}$/.test(raw) ? raw : "";
}

function pixelDeltaBounds(deltas) {
  if (!Array.isArray(deltas) || !deltas.length) return null;
  let minX = PX_W, minY = PX_H, maxX = -1, maxY = -1;
  for (let i = 0; i < deltas.length; i++) {
    const dlt = deltas[i];
    const x = Array.isArray(dlt) ? dlt[0] : dlt.x;
    const y = Array.isArray(dlt) ? dlt[1] : dlt.y;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX >= 0 ? [minX, minY, maxX, maxY] : null;
}

async function logPixelAction(hub, input) {
  const id = pixelActionId();
  const action = {
    id: id,
    at: Date.now(),
    actor: input.actor,
    steamid: input.steamid || "",
    admin: input.admin || "",
    kind: input.kind || "paint",
    note: input.note || "",
    targetActionId: input.targetActionId || "",
    deltas: input.deltas.map(function (p) {
      return [p.x, p.y, p.before, p.after, p.beforeOwnerActionId || ""];
    })
  };
  action.bounds = pixelDeltaBounds(action.deltas);
  await hub.storage.put("px:a:" + id, action);
  if (action.steamid) await hub.storage.put("px:ua:" + action.steamid + ":" + id, true);
  return action;
}

// Retention is housekeeping, not part of accepting an action. It runs after the paint/undo
// transaction commits, so a large catch-up batch neither lengthens nor rolls back that mutation.
async function bestEffortPixelAuditPrune(hub) {
  try {
    await maybePrunePixelAudit(hub, Date.now());
  } catch (error) {
    // Best-effort only; the next daily action retries cleanup.
  }
}

// Audit entries are append-only while retained, but cannot grow forever in the single public
// Durable Object. Once per day remove at most the oldest 512 actions past 180 days plus their
// per-user indexes. Current pixel colours remain intact; an ownership pointer to an expired
// action simply becomes unattributed in the admin inspector.
async function maybePrunePixelAudit(hub, now) {
  const lastKey = "px:audit:lastPrune";
  const last = (await hub.storage.get(lastKey)) || 0;
  if (now - last < PX_AUDIT_PRUNE_INTERVAL_MS) return;
  const cutoff = now - PX_AUDIT_RETENTION_MS;
  let removed = 0;
  let caughtUp = false;
  while (removed < PX_AUDIT_PRUNE_LIMIT) {
    const page = await hub.storage.list({
      prefix: "px:a:",
      limit: Math.min(128, PX_AUDIT_PRUNE_LIMIT - removed)
    });
    if (!page.size) { caughtUp = true; break; }
    let pageRemoved = 0;
    for (const [key, action] of page) {
      if (!action || !Number.isFinite(action.at) || action.at >= cutoff) {
        caughtUp = true;
        break;
      }
      await hub.storage.delete(key);
      if (action.steamid) await hub.storage.delete("px:ua:" + action.steamid + ":" + action.id);
      removed++;
      pageRemoved++;
    }
    if (caughtUp || pageRemoved < page.size) break;
  }
  // If the cap was exhausted while old records remain, leave lastPrune stale: the very next
  // action immediately removes another batch. Once caught up, return to the cheap daily cadence.
  if (caughtUp) await hub.storage.put(lastKey, now);
}

function pixelActionSummary(action) {
  return {
    id: action.id,
    at: action.at,
    actor: action.actor,
    steamid: action.steamid || "",
    admin: action.admin || "",
    kind: action.kind,
    note: action.note || "",
    targetActionId: action.targetActionId || "",
    count: Array.isArray(action.deltas) ? action.deltas.length : 0,
    undoneAt: action.undoneAt || 0,
    undoneBy: action.undoneBy || "",
    undoSkipped: action.undoSkipped || 0,
    undoActionId: action.undoActionId || "",
    bounds: action.bounds || pixelDeltaBounds(action.deltas)
  };
}

function pixelOwnershipLocation(x, y) {
  const tx = Math.floor(x / PX_TILE), ty = Math.floor(y / PX_TILE);
  return {
    tile: ty * PX_TILE_COLS + tx,
    offset: (y % PX_TILE) * PX_TILE + (x % PX_TILE)
  };
}

function pixelOwnershipRecord(raw) {
  if (!raw || !Array.isArray(raw.entries)) {
    return { entries: [], refs: new Uint16Array(PX_TILE * PX_TILE) };
  }
  let refs = raw.refs;
  if (!(refs instanceof Uint16Array) || refs.length !== PX_TILE * PX_TILE) {
    refs = Array.isArray(refs) && refs.length === PX_TILE * PX_TILE
      ? Uint16Array.from(refs) : new Uint16Array(PX_TILE * PX_TILE);
  }
  return { entries: raw.entries.slice(0, PX_TILE * PX_TILE), refs: refs };
}

function pixelOwnerFromRecord(record, offset) {
  const ref = record.refs[offset] || 0;
  return ref > 0 && ref <= record.entries.length ? String(record.entries[ref - 1] || "") : "";
}

async function pixelOwnerActionId(hub, x, y) {
  const location = pixelOwnershipLocation(x, y);
  const record = pixelOwnershipRecord(await hub.storage.get("px:o:" + location.tile));
  return pixelOwnerFromRecord(record, location.offset);
}

async function attachPixelOwners(hub, changed) {
  const records = new Map();
  for (let i = 0; i < changed.length; i++) {
    const p = changed[i], location = pixelOwnershipLocation(p.x, p.y);
    let record = records.get(location.tile);
    if (!record) {
      record = pixelOwnershipRecord(await hub.storage.get("px:o:" + location.tile));
      records.set(location.tile, record);
    }
    p.beforeOwnerActionId = pixelOwnerFromRecord(record, location.offset);
  }
  return records;
}

async function persistPixelOwnership(hub, changed, defaultActionId, loadedRecords) {
  const grouped = new Map();
  for (let i = 0; i < changed.length; i++) {
    const p = changed[i], location = pixelOwnershipLocation(p.x, p.y);
    let updates = grouped.get(location.tile);
    if (!updates) { updates = []; grouped.set(location.tile, updates); }
    const owner = Object.prototype.hasOwnProperty.call(p, "ownerActionId")
      ? String(p.ownerActionId || "") : String(defaultActionId || "");
    updates.push({ offset: location.offset, owner: owner });
  }

  for (const [tile, updates] of grouped) {
    const key = "px:o:" + tile;
    const old = loadedRecords && loadedRecords.has(tile)
      ? loadedRecords.get(tile) : pixelOwnershipRecord(await hub.storage.get(key));
    const values = new Array(PX_TILE * PX_TILE);
    for (let i = 0; i < values.length; i++) values[i] = pixelOwnerFromRecord(old, i);
    for (let i = 0; i < updates.length; i++) values[updates[i].offset] = updates[i].owner;

    const entries = [], entryRefs = new Map(), refs = new Uint16Array(PX_TILE * PX_TILE);
    for (let i = 0; i < values.length; i++) {
      const owner = values[i];
      if (!owner) continue;
      let ref = entryRefs.get(owner);
      if (!ref) {
        entries.push(owner);
        ref = entries.length;
        entryRefs.set(owner, ref);
      }
      refs[i] = ref;
    }
    if (entries.length) await hub.storage.put(key, { entries: entries, refs: refs });
    else await hub.storage.delete(key);
  }
}

function adminJson(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function adminError(message, status) {
  return adminJson({ error: message }, status || 400);
}

function adminIdentity(request) {
  const login = String(request.headers.get("X-MG-Admin-Login") || "").trim();
  return /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : "";
}

function adminMutationAllowed(request, url) {
  if (request.method !== "POST" || request.headers.get("X-MG-Admin") !== "1") return false;
  const origin = request.headers.get("Origin") || "";
  const fetchSite = request.headers.get("Sec-Fetch-Site") || "";
  return origin === url.origin && (!fetchSite || fetchSite === "same-origin");
}

async function readAdminPixels(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > 400000) return null;
  let body;
  try { body = await request.json(); } catch (error) { return null; }
  if (!body || !Array.isArray(body.pixels) ||
      body.pixels.length < 1 || body.pixels.length > PX_ADMIN_MAX_BATCH) return null;
  const unique = new Map();
  for (let i = 0; i < body.pixels.length; i++) {
    const p = body.pixels[i];
    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.color) ||
        p.x < 0 || p.x >= PX_W || p.y < 0 || p.y >= PX_H ||
        p.color < 0 || p.color >= PX_PALETTE.length) return null;
    unique.set(p.x + "," + p.y, { x: p.x, y: p.y, color: p.color });
  }
  return Array.from(unique.values());
}

async function adminPixelState(hub, login) {
  const tiles = await pixelTiles(hub);
  let painted = 0;
  for (const tile of tiles.values()) {
    for (let i = 0; i < tile.length; i++) if (tile[i]) painted++;
  }
  const bans = await hub.storage.list({ prefix: "px:b:" });
  return adminJson({
    admin: login,
    version: await pixelVersion(hub),
    painted: painted,
    bans: bans.size,
    palette: PX_PALETTE,
    paletteNames: PX_ADMIN_COLOR_NAMES
  });
}

async function adminPixelActions(hub, url) {
  const steamidRaw = url.searchParams.get("steamid") || "";
  const steamid = steamidRaw ? validPixelAccount(steamidRaw) : "";
  if (steamidRaw && !steamid) return adminError("Invalid Steam32 ID.", 400);
  const beforeRaw = url.searchParams.get("before") || "";
  const before = beforeRaw ? validPixelActionId(beforeRaw) : "";
  if (beforeRaw && !before) return adminError("Invalid action cursor.", 400);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const prefix = steamid ? "px:ua:" + steamid + ":" : "px:a:";
  const options = { prefix: prefix, reverse: true, limit: limit + 1 };
  if (before) options.end = prefix + before;
  const listed = await hub.storage.list(options);
  const ids = [];
  for (const key of listed.keys()) ids.push(String(key).substring(prefix.length));
  const hasMore = ids.length > limit;
  if (hasMore) ids.length = limit;

  const actions = [];
  for (let i = 0; i < ids.length; i++) {
    const action = await hub.storage.get("px:a:" + ids[i]);
    if (action) actions.push(pixelActionSummary(action));
  }
  return adminJson({
    actions: actions,
    next: hasMore && ids.length ? ids[ids.length - 1] : ""
  });
}

async function adminPixelPaint(hub, request, login) {
  const pixels = await readAdminPixels(request);
  if (!pixels) return adminError("Invalid pixel batch.", 400);
  const tiles = await pixelTiles(hub);
  const changed = [];
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i], before = pixelAt(tiles, p.x, p.y);
    if (before !== p.color) changed.push({ x: p.x, y: p.y, before: before, after: p.color });
  }
  if (!changed.length) {
    return adminJson({ changed: 0, version: await pixelVersion(hub) });
  }
  return pixelStorageTransaction(hub, async function (txHub) {
    const ownership = await attachPixelOwners(txHub, changed);
    const version = await persistPixelDeltas(txHub, changed);
    const action = await logPixelAction(txHub, {
      actor: "admin", admin: login, kind: "paint", deltas: changed
    });
    await persistPixelOwnership(txHub, changed, action.id, ownership);
    return adminJson({ changed: changed.length, version: version, actionId: action.id });
  }, tiles);
}

async function adminPixelUndo(hub, request, login) {
  let body;
  try { body = await request.json(); } catch (error) { return adminError("Invalid JSON body.", 400); }
  const actionId = validPixelActionId(body && body.actionId);
  const force = !!(body && body.force);
  if (!actionId) return adminError("Invalid action ID.", 400);
  return pixelStorageTransaction(hub, async function (txHub) {
    const actionKey = "px:a:" + actionId;
    const action = await txHub.storage.get(actionKey);
    if (!action || action.kind !== "paint" || !Array.isArray(action.deltas)) {
      return adminError("Action not found or cannot be undone.", 404);
    }
    if (action.undoneAt) return adminError("Action was already undone.", 409);

    const tiles = await pixelTiles(txHub);
    const changed = [];
    let skipped = 0;
    for (let i = 0; i < action.deltas.length; i++) {
      const dlt = action.deltas[i];
      if (!Array.isArray(dlt) || dlt.length < 4) continue;
      const current = pixelAt(tiles, dlt[0], dlt[1]);
      if (!force && current !== dlt[3]) { skipped++; continue; }
      if (current !== dlt[2]) {
        changed.push({
          x: dlt[0], y: dlt[1], before: current, after: dlt[2],
          ownerActionId: validPixelActionId(dlt[4]) || ""
        });
      }
    }

    let version = await pixelVersion(txHub), undoAction = null;
    if (changed.length) {
      const ownership = await attachPixelOwners(txHub, changed);
      version = await persistPixelDeltas(txHub, changed);
      undoAction = await logPixelAction(txHub, {
        actor: "admin",
        admin: login,
        kind: "undo",
        targetActionId: actionId,
        deltas: changed
      });
      await persistPixelOwnership(txHub, changed, undoAction.id, ownership);
    }
    action.undoneAt = Date.now();
    action.undoneBy = login;
    action.undoSkipped = skipped;
    action.undoActionId = undoAction ? undoAction.id : "";
    await txHub.storage.put(actionKey, action);
    return adminJson({
      changed: changed.length,
      skipped: skipped,
      version: version,
      undoActionId: action.undoActionId
    });
  });
}

async function adminPixelAction(hub, url) {
  const actionId = validPixelActionId(url.searchParams.get("id") || "");
  if (!actionId) return adminError("Invalid action ID.", 400);
  const action = await hub.storage.get("px:a:" + actionId);
  if (!action) return adminError("Action not found.", 404);
  const detail = pixelActionSummary(action);
  const tiles = await pixelTiles(hub);
  const deltas = Array.isArray(action.deltas) ? action.deltas : [];
  detail.pixels = [];
  detail.revertible = 0;
  detail.conflicts = 0;
  for (let i = 0; i < deltas.length; i++) {
    const dlt = deltas[i];
    if (!Array.isArray(dlt) || dlt.length < 4) continue;
    const current = pixelAt(tiles, dlt[0], dlt[1]);
    const revertible = current === dlt[3];
    if (revertible) detail.revertible++;
    else detail.conflicts++;
    detail.pixels.push({
      x: dlt[0], y: dlt[1],
      before: dlt[2], after: dlt[3], current: current,
      beforeDisplay: dlt[2] || (pixelLandAt(dlt[0], dlt[1]) ? 18 : 17),
      afterDisplay: dlt[3] || (pixelLandAt(dlt[0], dlt[1]) ? 18 : 17),
      currentDisplay: current || (pixelLandAt(dlt[0], dlt[1]) ? 18 : 17),
      revertible: revertible
    });
  }
  return adminJson(detail);
}

async function legacyPixelOwnerAction(hub, x, y) {
  let before = "", scanned = 0;
  while (scanned < 5000) {
    const options = { prefix: "px:a:", reverse: true, limit: 250 };
    if (before) options.end = before;
    const listed = await hub.storage.list(options);
    if (!listed.size) break;
    let lastKey = "";
    for (const [key, action] of listed) {
      lastKey = String(key);
      scanned++;
      if (!action || !Array.isArray(action.deltas)) continue;
      for (let i = action.deltas.length - 1; i >= 0; i--) {
        const dlt = action.deltas[i];
        if (Array.isArray(dlt) && dlt[0] === x && dlt[1] === y) {
          await persistPixelOwnership(hub, [{ x: x, y: y, ownerActionId: action.id }], "");
          return action;
        }
      }
    }
    if (listed.size < 250 || !lastKey) break;
    before = lastKey;
  }
  return null;
}

async function adminPixelInspect(hub, url) {
  const x = Number(url.searchParams.get("x")), y = Number(url.searchParams.get("y"));
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= PX_W || y < 0 || y >= PX_H) {
    return adminError("Invalid pixel coordinate.", 400);
  }
  const tiles = await pixelTiles(hub);
  const color = pixelAt(tiles, x, y);
  let actionId = await pixelOwnerActionId(hub, x, y);
  let action = actionId ? await hub.storage.get("px:a:" + actionId) : null;
  if (!action) {
    action = await legacyPixelOwnerAction(hub, x, y);
    actionId = action ? action.id : "";
  }
  return adminJson({
    x: x,
    y: y,
    color: color,
    colorName: PX_ADMIN_COLOR_NAMES[color] || ("color " + color),
    action: action ? pixelActionSummary(action) : null
  });
}

async function readAdminBanTarget(request) {
  let body;
  try { body = await request.json(); } catch (error) { return null; }
  const steamid = validPixelAccount(String(body && body.steamid || ""));
  if (!steamid) return null;
  const reason = String(body && body.reason || "").trim().substring(0, 200);
  return { steamid: steamid, reason: reason };
}

async function adminPixelBanStatus(hub, url) {
  const steamid = validPixelAccount(url.searchParams.get("steamid") || "");
  if (!steamid) return adminError("Invalid Steam32 ID.", 400);
  const ban = await pixelBan(hub, steamid);
  return adminJson({
    steamid: steamid,
    banned: !!ban,
    ban: ban || null
  });
}

async function adminPixelBan(hub, request, login, banned) {
  const target = await readAdminBanTarget(request);
  if (!target) return adminError("Invalid Steam32 ID or JSON body.", 400);
  const key = "px:b:" + target.steamid;
  if (banned) {
    const record = {
      steamid: target.steamid,
      at: Date.now(),
      by: login,
      reason: target.reason
    };
    await hub.storage.put(key, record);
    const action = await logPixelAction(hub, {
      actor: "admin", admin: login, steamid: target.steamid,
      kind: "ban", note: target.reason, deltas: []
    });
    return adminJson({ steamid: target.steamid, banned: true, ban: record, actionId: action.id });
  }
  const previous = await pixelBan(hub, target.steamid);
  await hub.storage.delete(key);
  const action = await logPixelAction(hub, {
    actor: "admin", admin: login, steamid: target.steamid,
    kind: "unban", note: previous && previous.reason || "", deltas: []
  });
  return adminJson({ steamid: target.steamid, banned: false, actionId: action.id });
}

async function handlePixelAdmin(hub, request, url) {
  const login = adminIdentity(request);
  if (!login) return adminError("Verified admin identity required.", 403);
  const path = url.pathname;
  if (request.method === "GET" && path === "/admin/api/state") {
    return adminPixelState(hub, login);
  }
  if (request.method === "GET" && path === "/admin/api/actions") {
    return adminPixelActions(hub, url);
  }
  if (request.method === "GET" && path === "/admin/api/action") {
    return adminPixelAction(hub, url);
  }
  if (request.method === "GET" && path === "/admin/api/pixel") {
    return adminPixelInspect(hub, url);
  }
  if (request.method === "GET" && path === "/admin/api/ban-status") {
    return adminPixelBanStatus(hub, url);
  }
  if (request.method === "GET" && path === "/admin/api/canvas") {
    return pixelAdminCanvasPng(hub);
  }
  if (path === "/admin/api/paint" || path === "/admin/api/undo" ||
      path === "/admin/api/ban" || path === "/admin/api/unban") {
    if (!adminMutationAllowed(request, url)) return adminError("Same-origin admin request required.", 403);
    if (path === "/admin/api/paint") return adminPixelPaint(hub, request, login);
    if (path === "/admin/api/undo") return adminPixelUndo(hub, request, login);
    return adminPixelBan(hub, request, login, path === "/admin/api/ban");
  }
  return adminError("Admin route not found.", 404);
}

async function pixelCanvasPng(hub) {
  const version = await pixelVersion(hub);
  if (hub.pxCanvasCache && hub.pxCanvasCache.version === version) {
    return pngResponse(hub.pxCanvasCache.bytes);
  }
  const tiles = await pixelTiles(hub);
  const bytes = await indexedPngBytes(PX_W, PX_H, PX_PALETTE, function (x, y) {
    return pixelAt(tiles, x, y);
  }, PX_ALPHA);
  hub.pxCanvasCache = { version: version, bytes: bytes };
  return pngResponse(bytes);
}

function pixelLandAt(x, y) {
  const spans = PX_LAND_SPANS[y] || [];
  for (let i = 0; i + 1 < spans.length; i += 2) {
    if (x < spans[i]) return false;
    if (x <= spans[i + 1]) return true;
  }
  return false;
}

async function pixelAdminCanvasPng(hub) {
  const tiles = await pixelTiles(hub);
  return pngResponse(await indexedPngBytes(PX_W, PX_H, PX_VIEW_PALETTE, function (x, y) {
    const paint = pixelAt(tiles, x, y);
    return paint ? paint + 1 : (pixelLandAt(x, y) ? 1 : 0);
  }));
}

async function pixelViewPng(hub, originX, originY, zoom, ip) {
  const version = await pixelVersion(hub);
  const cacheKey = version + ":" + zoom + ":" + originX + ":" + originY;
  const cached = hub.pxViewCache.get(cacheKey);
  if (cached) return pngResponse(cached);
  if (!hub.pixelViewOk(ip)) return d(6, 63); // retryable busy sentinel; client validates aspect

  const tiles = await pixelTiles(hub);
  const viewCols = PX_W / zoom, viewRows = PX_H / zoom;
  const logical = new Uint8Array(viewCols * viewRows);
  for (let row = 0; row < viewRows; row++) {
    for (let col = 0; col < viewCols; col++) {
      const mapX = originX + col, mapY = originY + row;
      const paint = pixelAt(tiles, mapX, mapY);
      logical[row * viewCols + col] =
        paint ? paint + 1 : (pixelLandAt(mapX, mapY) ? 1 : 0);
    }
  }
  const bytes = await indexedPngBytes(PX_VIEW_W, PX_VIEW_H, PX_VIEW_PALETTE, function (x, y) {
    const col = Math.min(viewCols - 1, Math.floor(x * viewCols / PX_VIEW_W));
    const row = Math.min(viewRows - 1, Math.floor(y * viewRows / PX_VIEW_H));
    return logical[row * viewCols + col];
  });
  if (hub.pxViewCache.size >= 24) {
    const oldest = hub.pxViewCache.keys().next().value;
    if (oldest !== undefined) hub.pxViewCache.delete(oldest);
  }
  hub.pxViewCache.set(cacheKey, bytes);
  return pngResponse(bytes);
}

async function indexedPngBytes(w, h, palette, pixelAt, alpha) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = u32(w).concat(u32(h), [8, 3, 0, 0, 0]); // 8-bit indexed colour
  const plte = [];
  for (let i = 0; i < palette.length; i++) {
    plte.push(palette[i][0] & 255, palette[i][1] & 255, palette[i][2] & 255);
  }

  // PNG filter 0 per row followed by one palette index per physical pixel.
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) raw.push(pixelAt(x, y) & 255);
  }

  let bytes = sig.concat(chunk("IHDR", ihdr)).concat(chunk("PLTE", plte));
  if (alpha && alpha.length) bytes = bytes.concat(chunk("tRNS", alpha));
  bytes = bytes.concat(chunk("IDAT", Array.from(await deflateBytes(raw)))).concat(chunk("IEND", []));
  return new Uint8Array(bytes);
}

async function deflateBytes(raw) {
  if (typeof CompressionStream !== "undefined") {
    const source = new Response(new Uint8Array(raw)).body;
    const compressed = source.pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(compressed).arrayBuffer());
  }
  return new Uint8Array(storedZlib(raw));
}

function storedZlib(raw) {
  const zlib = [0x78, 0x01]; // zlib header: deflate, fastest/no compression
  let off = 0;
  do {
    const blockLen = Math.min(65535, raw.length - off);
    const final = off + blockLen >= raw.length ? 1 : 0;
    zlib.push(final, blockLen & 255, (blockLen >> 8) & 255,
      ~blockLen & 255, (~blockLen >> 8) & 255);
    for (let i = 0; i < blockLen; i++) zlib.push(raw[off + i]);
    off += blockLen;
  } while (off < raw.length);
  zlib.push(...u32(adler32Bytes(raw)));
  return zlib;
}

function adler32Bytes(bytes) {
  const MOD = 65521;
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a += bytes[i] & 255;
    b += a;
    // Keep the sums bounded without paying a modulo on every byte.
    if ((i & 4095) === 4095) { a %= MOD; b %= MOD; }
  }
  a %= MOD; b %= MOD;
  return ((b << 16) | a) >>> 0;
}

function pngResponse(bytes) {
  return new Response(bytes, {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      "access-control-allow-origin": "*",
    },
  });
}

/* ─────────────────────────── PNG encoder ───────────────────────────
 * Emits an 8-bit grayscale PNG of exactly W x H black pixels. The Cloudflare
 * fallback uses stored deflate blocks; the Node VPS injects a synchronous native
 * zlib hook so large clock/move dimensions do not consume ~100 KiB per response.
 * The client only cares about the dimensions.
 */
function png(w, h) {
  return pngResponse(pngBytes(w, h));
}

// The raw PNG bytes, split out from png() so a caller that reuses one image (probe) can cache
// them instead of re-encoding. Returns a Uint8Array.
function pngBytes(w, h) {
  w = Math.max(1, Math.min(w | 0, 8000));
  h = Math.max(1, Math.min(h | 0, 8000));

  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = u32(w).concat(u32(h), [8, 0, 0, 0, 0]); // 8-bit, grayscale

  // Raw scanlines: each row = 1 filter byte (0) + W pixel bytes (0). All zeros.
  const rawLen = h * (1 + w);

  let zlib = null;
  if (globalThis.MG_NODE_DEFLATE_SYNC) {
    try {
      zlib = Array.from(globalThis.MG_NODE_DEFLATE_SYNC(new Uint8Array(rawLen)));
    } catch (error) {
      zlib = null;
    }
  }
  if (!zlib) {
    // Portable Worker fallback: zlib header + stored deflate blocks + adler32.
    zlib = [0x78, 0x01];
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
  }

  const bytes = sig
    .concat(chunk("IHDR", ihdr))
    .concat(chunk("IDAT", zlib))
    .concat(chunk("IEND", []));

  return new Uint8Array(bytes);
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
