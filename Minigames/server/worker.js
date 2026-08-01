/* ============================================================================
 * GENERATED FILE - DO NOT EDIT BY HAND.
 * Produced by `node tools/build_worker.js` from:
 *   panorama/scripts/rules/*.js                              (shared with client)
 *   server/pixelbattle_map.generated.js                     (generated land mask)
 *   server/geo_pool.generated.js                            (prebuilt GeoGuesser pool)
 *   server/geo_credit_tables.generated.js                   (reveal country/credit tables)
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
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const WHITE = "w", BLACK = "b";

    function idx(r, c) { return r * 8 + c; }
    function rowOf(i) { return (i / 8) | 0; }
    function colOf(i) { return i % 8; }
    function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
    function isDark(r, c) { return ((r + c) & 1) === 1; }

    function colorOf(v) { return v === 1 || v === 2 ? WHITE : (v === 3 || v === 4 ? BLACK : null); }
    function isKing(v) { return v === 2 || v === 4; }
    function isEnemy(v, color) { let c = colorOf(v); return c && c !== color; }

    function initialBoard() {
        const b = new Array(64);
        for (let i = 0; i < 64; i++) b[i] = 0;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (!isDark(r, c)) continue;
                if (r <= 2) b[idx(r, c)] = 3;       // black men (top)
                else if (r >= 5) b[idx(r, c)] = 1;  // white men (bottom)
            }
        }
        return b;
    }

    // Russian draughts: men move forward only; kings slide any distance along a diagonal ("flying").
    const ALL_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    function moveDirs(v) {
        if (v === 1) return [[-1, -1], [-1, 1]]; // white man: up
        if (v === 3) return [[1, -1], [1, 1]];   // black man: down
        return ALL_DIRS;                          // king: all four
    }

    function simpleMoves(b, i) {
        let v = b[i]; if (!v) return [];
        let r = rowOf(i), c = colOf(i), out = [];
        if (isKing(v)) {
            // Flying king: any number of empty squares along each diagonal.
            for (let k = 0; k < 4; k++) {
                const dr = ALL_DIRS[k][0], dc = ALL_DIRS[k][1];
                let nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc) && b[idx(nr, nc)] === 0) {
                    out.push({ to: idx(nr, nc) });
                    nr += dr; nc += dc;
                }
            }
            return out;
        }
        const dirs = moveDirs(v); // forward only for men
        for (let m = 0; m < dirs.length; m++) {
            const pr = r + dirs[m][0], pc = c + dirs[m][1];
            if (inBounds(pr, pc) && b[idx(pr, pc)] === 0) out.push({ to: idx(pr, pc) });
        }
        return out;
    }

    // Russian men capture in ANY diagonal direction (forward or backward), one square over.
    // A flying king slides over empties, takes exactly one enemy, and may land on
    // any empty square beyond it.
    function captureMoves(b, i) {
        let v = b[i]; if (!v) return [];
        let color = colorOf(v), r = rowOf(i), c = colOf(i), out = [];
        if (isKing(v)) {
            for (let k = 0; k < 4; k++) {
                const dr = ALL_DIRS[k][0], dc = ALL_DIRS[k][1];
                let nr = r + dr, nc = c + dc;
                while (inBounds(nr, nc) && b[idx(nr, nc)] === 0) { nr += dr; nc += dc; }
                if (!inBounds(nr, nc) || !isEnemy(b[idx(nr, nc)], color)) continue;
                const cap = idx(nr, nc);
                let lr = nr + dr, lc = nc + dc;
                while (inBounds(lr, lc) && b[idx(lr, lc)] === 0) {
                    out.push({ to: idx(lr, lc), cap: cap });
                    lr += dr; lc += dc;
                }
            }
            return out;
        }
        for (let k2 = 0; k2 < 4; k2++) {
            const mr = r + ALL_DIRS[k2][0], mc = c + ALL_DIRS[k2][1];         // enemy square
            const lr2 = r + 2 * ALL_DIRS[k2][0], lc2 = c + 2 * ALL_DIRS[k2][1]; // landing
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
        let v = b[from];
        b[from] = 0;
        const fr = rowOf(from), fc = colOf(from), tr = rowOf(to), tc = colOf(to);
        const dr = tr > fr ? 1 : -1, dc = tc > fc ? 1 : -1;
        let captured = false;
        // Walk the diagonal, bounded to the board (max 7 steps). The guard is pure
        // insurance: a legal move is always diagonal so it reaches (tr,tc) within 7
        // steps - but a corrupt/desynced hop must never spin the loop forever.
        let r = fr + dr, c = fc + dc, guard = 0;
        while ((r !== tr || c !== tc) && guard++ < 8 && inBounds(r, c)) {
            const j = idx(r, c);
            if (b[j] !== 0) { b[j] = 0; captured = true; }
            r += dr; c += dc;
        }
        let promoted = false;
        if (v === 1 && tr === 0) { v = 2; promoted = true; }
        else if (v === 3 && tr === 7) { v = 4; promoted = true; }
        b[to] = v;
        return { captured: captured, promoted: promoted };
    }

    // English draughts: men move and jump forward only. Kings move/jump exactly one
    // square at a time in either direction, rather than flying across a diagonal.
    function englishSimpleMoves(b, i) {
        let v = b[i]; if (!v) return [];
        let r = rowOf(i), c = colOf(i), dirs = isKing(v) ? ALL_DIRS : moveDirs(v), out = [];
        for (let k = 0; k < dirs.length; k++) {
            let nr = r + dirs[k][0], nc = c + dirs[k][1];
            if (inBounds(nr, nc) && b[idx(nr, nc)] === 0) out.push({ to: idx(nr, nc) });
        }
        return out;
    }

    function englishCaptureMoves(b, i) {
        let v = b[i]; if (!v) return [];
        let color = colorOf(v), r = rowOf(i), c = colOf(i);
        const dirs = isKing(v) ? ALL_DIRS : moveDirs(v), out = [];
        for (let k = 0; k < dirs.length; k++) {
            const mr = r + dirs[k][0], mc = c + dirs[k][1];
            let lr = r + 2 * dirs[k][0], lc = c + 2 * dirs[k][1];
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
            for (let i = 0; i < 64; i++) {
                if (colorOf(b[i]) === color && captureMovesFor(b, i).length > 0) return true;
            }
            return false;
        }

        function hasAnyMove(b, color) {
            for (let i = 0; i < 64; i++) {
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
            let wk = 0, bk = 0, wm = 0, bm = 0;
            for (let i = 0; i < 64; i++) {
                let v = b[i];
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
            const caps = captureMovesFor(b, i);
            if (caps.length === 0) return [];
            const seqs = [];
            for (let k = 0; k < caps.length; k++) {
                const mv = caps[k];
                let nb = b.slice();
                const res = applyHop(nb, i, mv.to);
                // English: a promotion ends the turn. Russian: the fresh king (nb already holds
                // the king value, so captureMovesFor routes to the king generator) keeps capturing.
                const canContinue = (!res.promoted || !promotionEndsTurn) && captureMovesFor(nb, mv.to).length > 0;
                if (canContinue) {
                    const tails = captureSequencesFrom(nb, mv.to);
                    for (let t = 0; t < tails.length; t++) seqs.push([{ from: i, to: mv.to }].concat(tails[t]));
                } else {
                    seqs.push([{ from: i, to: mv.to }]);
                }
            }
            return seqs;
        }

        function legalSequences(b, color) {
            let i, k, seqs = [], hasCap = false;
            for (i = 0; i < 64; i++) {
                if (colorOf(b[i]) === color && captureMovesFor(b, i).length) { hasCap = true; break; }
            }
            if (hasCap) {
                for (i = 0; i < 64; i++) {
                    if (colorOf(b[i]) !== color) continue;
                    const cs = captureSequencesFrom(b, i);
                    for (k = 0; k < cs.length; k++) seqs.push(cs[k]);
                }
                return seqs;
            }
            for (i = 0; i < 64; i++) {
                if (colorOf(b[i]) !== color) continue;
                const sm = simpleMovesFor(b, i);
                for (k = 0; k < sm.length; k++) seqs.push([{ from: i, to: sm[k].to }]);
            }
            return seqs;
        }

        function applySequence(b, seq) {
            for (let h = 0; h < seq.length; h++) applyHop(b, seq[h].from, seq[h].to);
        }

        function evalBoard(b, me) {
            let score = 0;
            for (let i = 0; i < 64; i++) {
                let v = b[i]; if (!v) continue;
                let val = isKing(v) ? 25 : 10;
                if (v === 1) val += 7 - rowOf(i);
                else if (v === 3) val += rowOf(i);
                score += colorOf(v) === me ? val : -val;
            }
            return score;
        }

        function minimax(b, color, me, depth, alpha, beta) {
            const seqs = legalSequences(b, color);
            if (seqs.length === 0) return color === me ? -100000 + depth : 100000 - depth;
            if (depth === 0) return evalBoard(b, me);
            let opp = color === WHITE ? BLACK : WHITE, k, nb, sc;
            if (color === me) {
                let best = -1e9;
                for (k = 0; k < seqs.length; k++) {
                    nb = b.slice(); applySequence(nb, seqs[k]);
                    sc = minimax(nb, opp, me, depth - 1, alpha, beta);
                    if (sc > best) best = sc;
                    if (best > alpha) alpha = best;
                    if (alpha >= beta) break;
                }
                return best;
            }
            let worst = 1e9;
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
            const seqs = legalSequences(b, color);
            if (seqs.length === 0) return null;
            const opp = color === WHITE ? BLACK : WHITE;
            let DEPTH = 5, best = -1e9, pick = seqs[0];
            for (let k = 0; k < seqs.length; k++) {
                let nb = b.slice(); applySequence(nb, seqs[k]);
                let sc = minimax(nb, opp, color, DEPTH - 1, -1e9, 1e9) + Math.random() * 0.5;
                if (sc > best) { best = sc; pick = seqs[k]; }
            }
            return pick;
        }

        function chooseBotMovePrep(b, color) {
            const seqs = legalSequences(b, color);
            const opp = color === WHITE ? BLACK : WHITE;
            let DEPTH = 5, i = 0, best = -1e9, pick = seqs.length ? seqs[0] : null;
            return {
                done: function () { return i >= seqs.length; },
                step: function () {
                    if (i >= seqs.length) return;
                    let nb = b.slice(); applySequence(nb, seqs[i]);
                    let sc = minimax(nb, opp, color, DEPTH - 1, -1e9, 1e9) + Math.random() * 0.5;
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
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const TTT_LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],   // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8],   // cols
        [0, 4, 8], [2, 4, 6]               // diagonals
    ];

    // Returns { mark, line } for the first completed line, or null.
    function tttWinner(b) {
        for (let i = 0; i < TTT_LINES.length; i++) {
            const L = TTT_LINES[i], v = b[L[0]];
            if (v && v === b[L[1]] && v === b[L[2]]) return { mark: v, line: L };
        }
        return null;
    }

    function tttFull(b) {
        for (let i = 0; i < 9; i++) if (!b[i]) return false;
        return true;
    }

    // If `mark` has a one-move win available, return that cell; else -1.
    function tttFindWin(b, mark) {
        for (let i = 0; i < 9; i++) {
            if (b[i]) continue;
            b[i] = mark;
            const w = tttWinner(b);
            b[i] = 0;                      // restore - this must not mutate the board
            if (w && w.mark === mark) return i;
        }
        return -1;
    }

    // Heuristic bot: win > block > center > corner > side. Strong but not a full
    // minimax, so a sharp human can still fork it - deliberately beatable.
    function tttBotMove(b, mark) {
        const opp = mark === 1 ? 2 : 1;
        let pick = tttFindWin(b, mark); if (pick >= 0) return pick;   // 1) take the win
        pick = tttFindWin(b, opp);      if (pick >= 0) return pick;   // 2) block theirs
        if (!b[4]) return 4;                                          // 3) center
        const corners = [0, 2, 6, 8];
        for (let i = 0; i < 4; i++) if (!b[corners[i]]) return corners[i]; // 4) corner
        const sides = [1, 3, 5, 7];
        for (let j = 0; j < 4; j++) if (!b[sides[j]]) return sides[j];     // 5) side
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
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const C_PAWN = 1, C_KNIGHT = 2, C_BISHOP = 3, C_ROOK = 4, C_QUEEN = 5, C_KING = 6;
    const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    const KING_D   = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    const DIAG_D   = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const ORTHO_D  = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const QUEEN_D  = DIAG_D.concat(ORTHO_D);

    function cSq(r, c) { return r * 8 + c; }
    function cRow(i) { return (i / 8) | 0; }
    function cCol(i) { return i % 8; }
    function cOn(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
    function cSign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
    function cType(v) { return v < 0 ? -v : v; }

    function initialChessBoard() {
        const b = new Array(64);
        for (let i = 0; i < 64; i++) b[i] = 0;
        const back = [C_ROOK, C_KNIGHT, C_BISHOP, C_QUEEN, C_KING, C_BISHOP, C_KNIGHT, C_ROOK];
        for (let c = 0; c < 8; c++) {
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
        const k = color > 0 ? C_KING : -C_KING;
        for (let i = 0; i < 64; i++) if (b[i] === k) return i;
        return -1;
    }

    // Is square s attacked by any piece of `byColor` (+1/-1)? Used for check + castling.
    function attacksSquare(b, s, byColor) {
        let sr = cRow(s), sc = cCol(s), i, r, c, v;
        // pawns: a byColor pawn attacking s sits one row "behind" s (row = sr + byColor).
        const pr = sr + byColor;
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
        const k = findKing(b, color);
        return k >= 0 && attacksSquare(b, k, -color);
    }

    // Apply from→to on a COPY, deriving castling / en-passant / promotion from board+state so
    // the network receive path needs only {from,to} (same "derive, don't transmit" trick as
    // checkers applyHop). Returns [newBoard, newState]. Promotion is ALWAYS to a queen (MVP).
    function makeMove(b, st, from, to) {
        const nb = b.slice(), nst = cloneChessState(st);
        let piece = b[from], color = cSign(piece), t = cType(piece);
        const fr = cRow(from), fc = cCol(from), tr = cRow(to), tc = cCol(to);
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
        const row = color > 0 ? 7 : 0;
        if (ksq !== cSq(row, 4)) return;
        if (attacksSquare(b, ksq, -color)) return;                 // not out of check
        const kSide = color > 0 ? st.wK : st.bK;
        const qSide = color > 0 ? st.wQ : st.bQ;
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
        let moves = [], i, r, c, v, t, d, nr, nc;
        for (i = 0; i < 64; i++) {
            v = b[i];
            if (v === 0 || cSign(v) !== color) continue;
            t = cType(v); r = cRow(i); c = cCol(i);
            if (t === C_PAWN) {
                const fwd = -color;                         // white(+1) moves up the board (row-1)
                const one = r + fwd;
                if (one >= 0 && one < 8 && b[cSq(one, c)] === 0) {
                    moves.push({ from: i, to: cSq(one, c) });
                    const startRow = color > 0 ? 6 : 1, two = r + 2 * fwd;
                    if (r === startRow && b[cSq(two, c)] === 0) moves.push({ from: i, to: cSq(two, c) });
                }
                for (d = -1; d <= 1; d += 2) {
                    nc = c + d;
                    if (nc < 0 || nc > 7 || one < 0 || one > 7) continue;
                    const tsq = cSq(one, nc), tv = b[tsq];
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
                const dirs = t === C_BISHOP ? DIAG_D : (t === C_ROOK ? ORTHO_D : QUEEN_D);
                for (d = 0; d < dirs.length; d++) {
                    nr = r + dirs[d][0]; nc = c + dirs[d][1];
                    while (cOn(nr, nc)) {
                        const sv = b[cSq(nr, nc)];
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
        const ps = pseudoMoves(b, st, color), out = [];
        for (let i = 0; i < ps.length; i++) {
            let r = makeMove(b, st, ps[i].from, ps[i].to);
            if (!inCheck(r[0], color)) out.push(ps[i]);
        }
        return out;
    }

    // Can EITHER side still force a mate with the material on the board? Draws the classic
    // insufficient-material cases: K vs K, K+minor vs K, and K+B vs K+B on the same colour.
    // Any pawn, rook or queen (or two minors on one side) can still mate, so those are "ongoing".
    function insufficientMaterial(b) {
        const minors = { 1: [], "-1": [] };      // bishop/knight squares per colour
        for (let i = 0; i < 64; i++) {
            let v = b[i];
            if (v === 0) continue;
            let t = cType(v);
            if (t === C_KING) continue;
            if (t === C_PAWN || t === C_ROOK || t === C_QUEEN) return false;   // mating material
            minors[cSign(v)].push({ t: t, sq: i });
        }
        const w = minors[1], bl = minors["-1"];
        if (w.length > 1 || bl.length > 1) return false;   // two minors can mate (BB, and BN)
        if (w.length === 0 && bl.length === 0) return true;                    // K vs K
        if (w.length + bl.length === 1) return true;                           // K+minor vs K
        // one minor each: only a draw when both are bishops on the SAME colour complex
        if (w[0].t === C_BISHOP && bl[0].t === C_BISHOP) {
            const wc = (cRow(w[0].sq) + cCol(w[0].sq)) & 1;
            const bc = (cRow(bl[0].sq) + cCol(bl[0].sq)) & 1;
            return wc === bc;
        }
        return false;
    }

    // Compact position identity for threefold repetition: piece placement + side to move +
    // castling rights + en-passant target. Two positions repeat only when ALL of those match
    // (FIDE), so the key must include everything that changes the set of legal continuations.
    function positionKey(b, st, color) {
        let s = b.join(",");
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
        let s = 0;
        for (let i = 0; i < 64; i++) {
            let v = b[i];
            if (v === 0) continue;
            const sg = cSign(v);
            s += sg * pieceValue(cType(v));
            const center = (3.5 - Math.abs(3.5 - cCol(i))) + (3.5 - Math.abs(3.5 - cRow(i)));
            s += sg * center * 2;
        }
        return s;
    }

    // Captures first → better alpha-beta pruning.
    function orderChessMoves(b, moves) {
        moves.sort((a, z) => {
            return (b[z.to] !== 0 ? pieceValue(cType(b[z.to])) : 0) - (b[a.to] !== 0 ? pieceValue(cType(b[a.to])) : 0);
        });
    }

    function negamax(b, st, color, depth, alpha, beta, budget) {
        if (depth === 0) return color * evalBoard(b);
        const moves = legalMoves(b, st, color);
        if (moves.length === 0) return inCheck(b, color) ? -100000 - depth : 0;   // mate (deeper = worse) / stalemate
        orderChessMoves(b, moves);
        let best = -1e9;
        for (let i = 0; i < moves.length; i++) {
            if (budget.n++ > budget.max) break;                  // node cap: bail with best-so-far
            let r = makeMove(b, st, moves[i].from, moves[i].to);
            const sc = -negamax(r[0], r[1], -color, depth - 1, -beta, -alpha, budget);
            if (sc > best) best = sc;
            if (best > alpha) alpha = best;
            if (alpha >= beta) break;
        }
        return best;
    }

    // Pick a move for `color`. Depth/budget tuned to stay responsive in Panorama; if the node
    // budget trips mid-search the best move found so far is used. Tiny jitter avoids repetition.
    function chessBotMove(b, st, color) {
        const moves = legalMoves(b, st, color);
        if (moves.length === 0) return null;
        orderChessMoves(b, moves);
        let budget = { n: 0, max: 120000 }, DEPTH = 3, best = null, bestScore = -1e9;
        for (let i = 0; i < moves.length; i++) {
            let r = makeMove(b, st, moves[i].from, moves[i].to);
            const sc = -negamax(r[0], r[1], -color, DEPTH - 1, -1e9, 1e9, budget) + Math.random() * 8;
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
        const moves = legalMoves(b, st, color);
        orderChessMoves(b, moves);
        let budget = { n: 0, max: 120000 }, DEPTH = 3, i = 0, best = null, bestScore = -1e9;
        return {
            done: function () { return i >= moves.length; },
            step: function () {
                if (i >= moves.length) return;
                let r = makeMove(b, st, moves[i].from, moves[i].to);
                const sc = -negamax(r[0], r[1], -color, DEPTH - 1, -1e9, 1e9, budget) + Math.random() * 8;
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
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const SUIT_CHARS = ["S", "H", "D", "C"];
    const RANK_CHARS = ["6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    const DECK_SIZE = 36;

    function suitOf(id) { return (id / 9) | 0; }
    function rankOf(id) { return id % 9; }

    // Deterministic PRNG (mulberry32) so a given seed always deals the same game - the test
    // relies on this, and online the server owns the seed.
    function makeRng(seed) {
        let s = seed | 0;
        return () => {
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function freshDeck(rng) {
        const d = [];
        for (let i = 0; i < DECK_SIZE; i++) d.push(i);
        for (let j = DECK_SIZE - 1; j > 0; j--) {
            let k = (rng() * (j + 1)) | 0;
            let t = d[j]; d[j] = d[k]; d[k] = t;
        }
        return d;
    }

    // Draw from the FRONT (index 0 = top). The bottom card (last index) is the trump card,
    // drawn last, so it stays put until the deck is nearly empty.
    function deal(deck, numPlayers) {
        const hands = [];
        for (let s = 0; s < numPlayers; s++) hands.push([]);
        const dk = deck.slice();
        for (let n = 0; n < 6; n++)
            for (let p = 0; p < numPlayers; p++) hands[p].push(dk.shift());
        const trumpCard = dk[dk.length - 1];
        return { hands: hands, deck: dk, trumpCard: trumpCard, trump: suitOf(trumpCard) };
    }

    // A `def` card beats an `att` card if: same suit and higher rank, OR it is a trump
    // covering a non-trump. Trump-vs-trump is decided by rank (same-suit branch).
    function beats(att, def, trump) {
        const sa = suitOf(att), sd = suitOf(def);
        if (sd === sa) return rankOf(def) > rankOf(att);
        if (sd === trump && sa !== trump) return true;
        return false;
    }

    function removeCard(hand, id) { let k = hand.indexOf(id); if (k >= 0) hand.splice(k, 1); }

    // Lowest trump holder opens the very first attack (classic rule); seat 0 if nobody
    // holds a trump.
    function firstAttacker(st) {
        let best = -1, bestRank = 99;
        for (let s = 0; s < st.numPlayers; s++) {
            const h = st.hands[s];
            for (let k = 0; k < h.length; k++) {
                if (suitOf(h[k]) === st.trump && rankOf(h[k]) < bestRank) { bestRank = rankOf(h[k]); best = s; }
            }
        }
        return best < 0 ? 0 : best;
    }

    function nextInPlay(st, seat) {
        for (let k = 1; k <= st.numPlayers; k++) {
            let s = (seat + k) % st.numPlayers;
            if (!st.out[s]) return s;
        }
        return seat;
    }
    function firstInPlayFrom(st, seat) { return st.out[seat] ? nextInPlay(st, seat) : seat; }

    function newGame(numPlayers, seed) {
        const dealt = deal(freshDeck(makeRng(seed)), numPlayers);
        const st = {
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
        for (let s = 0; s < numPlayers; s++) { st.out.push(false); st.passed.push(false); }
        st.attacker = firstAttacker(st);
        st.defender = nextInPlay(st, st.attacker);
        return st;
    }

    // table queries
    function tableRankSet(st) {
        const set = {};
        for (let i = 0; i < st.table.length; i++) {
            set[rankOf(st.table[i].a)] = 1;
            if (st.table[i].d >= 0) set[rankOf(st.table[i].d)] = 1;
        }
        return set;
    }
    function uncoveredCount(st) {
        let n = 0;
        for (let i = 0; i < st.table.length; i++) if (st.table[i].d < 0) n++;
        return n;
    }
    function firstUncovered(st) {
        for (let i = 0; i < st.table.length; i++) if (st.table[i].d < 0) return i;
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
        const out = [], h = st.hands[seat];
        for (let i = 0; i < h.length; i++) if (canAttackWith(st, seat, h[i])) out.push(h[i]);
        return out;
    }
    function canDefendPair(st, pairIndex, card) {
        let p = st.table[pairIndex];
        if (!p || p.d >= 0) return false;
        if (st.hands[st.defender].indexOf(card) < 0) return false;
        return beats(p.a, card, st.trump);
    }
    function legalDefends(st, pairIndex) {
        const out = [], h = st.hands[st.defender];
        for (let i = 0; i < h.length; i++) if (canDefendPair(st, pairIndex, h[i])) out.push(h[i]);
        return out;
    }

    // Clear every seat's "done adding" flag. Called whenever the table changes (a new attack
    // card or a cover), because fresh cards can create new throw-in options for a seat that had
    // already passed - so consensus must be re-earned before the bout can be beaten.
    function resetPasses(st) {
        for (let s = 0; s < st.numPlayers; s++) st.passed[s] = false;
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
        for (let s = 0; s < st.numPlayers; s++) if (!attackSeatSettled(st, s)) return false;
        return true;
    }
    // First in-play attack seat (turn order from the primary attacker) that has NOT settled - i.e.
    // whoever is currently "on the clock" to either throw in a card or confirm Bito on a covered
    // table. -1 when everyone has settled (the bout is ready to be beaten). Drives actionActor so
    // the confirm turn walks every attacker, not just those still holding a legal throw-in.
    function firstUnsettled(st) {
        if (uncoveredCount(st) !== 0) return -1;
        for (let k = 0; k < st.numPlayers; k++) {
            let s = (st.attacker + k) % st.numPlayers;
            if (!attackSeatSettled(st, s)) return s;
        }
        return -1;
    }
    // Which attack seats could still throw a legal card in right now (table covered, not yet
    // passed, and holding a matching-rank card), in classic turn order starting from the primary
    // attacker. Empty ⇒ nobody left to add → the bout is ready for Bito.
    function pendingThrowers(st) {
        const out = [];
        if (uncoveredCount(st) !== 0) return out;   // still defending; no throw-in window yet
        for (let k = 0; k < st.numPlayers; k++) {
            let s = (st.attacker + k) % st.numPlayers;
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
        const deckEmpty = st.deck.length === 0;
        for (let s = 0; s < st.numPlayers; s++) {
            if (!st.out[s] && st.hands[s].length === 0 && deckEmpty) st.out[s] = true;
        }
    }
    function inPlayCount(st) {
        let n = 0;
        for (let s = 0; s < st.numPlayers; s++) if (!st.out[s]) n++;
        return n;
    }
    // Refill hands to 6, attacker(s) first in turn order, defender LAST (standard).
    function refill(st) {
        const order = [];
        for (let k = 0; k < st.numPlayers; k++) {
            let s = (st.attacker + k) % st.numPlayers;
            if (s === st.defender || st.out[s]) continue;
            order.push(s);
        }
        if (!st.out[st.defender]) order.push(st.defender);
        for (let i = 0; i < order.length; i++) {
            const seat = order[i];
            while (st.hands[seat].length < 6 && st.deck.length > 0) st.hands[seat].push(st.deck.shift());
        }
    }
    // End the current bout. took=true → defender picks up the whole table; else the table
    // is "beaten" (Bito) and discarded. Then refill and rotate roles.
    function endBout(st, took) {
        let oldDef = st.defender, i;
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
        const base = firstInPlayFrom(st, took ? nextInPlay(st, oldDef) : oldDef);
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
        for (let i = 0; i < st.table.length; i++) { st.discard++; if (st.table[i].d >= 0) st.discard++; }
        st.table = [];
        resetPasses(st);
        refill(st);                          // survivors top up (attacker-first, defender last)
        updateOut(st);
        const base = firstInPlayFrom(st, st.attacker);   // skip the leaver if it was the attacker
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
            for (let s = 0; s < st.numPlayers; s++) if (!st.out[s]) st.loser = s;
            return true;
        }
        return false;
    }

    // bot
    // Trumps sort far above non-trumps so the bot spends its cheapest, non-trump cards first.
    function cardValue(id, trump) { return rankOf(id) + (suitOf(id) === trump ? 100 : 0); }
    function sortByValue(arr, trump) {
        arr.sort((a, b) => { return cardValue(a, trump) - cardValue(b, trump); });
        return arr;
    }
    // Returns the card to attack/throw-in with, or -1 to end the bout (Bito).
    function durakBotAttack(st, seat) {
        const la = sortByValue(legalAttacks(st, seat), st.trump);
        if (la.length === 0) return -1;
        if (st.table.length === 0) return la[0];            // opener must play its lowest
        const lowest = la[0];
        // Throw in only a genuinely cheap non-trump (6/7/8); otherwise stop.
        if (suitOf(lowest) !== st.trump && rankOf(lowest) <= 2) return lowest;
        return -1;
    }
    // Returns { pair, card } to cover the first open attack, or null to take.
    function durakBotDefend(st, seat) {
        let i = firstUncovered(st);
        if (i < 0) return null;
        const ld = sortByValue(legalDefends(st, i), st.trump);
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
    let R;
    if (typeof $ !== "undefined" && $) {
        const MG = ($.MG = $.MG || {});
        R = (MG.Rules = MG.Rules || {});
    } else if (typeof globalThis !== "undefined") {
        R = (globalThis.MGRules = globalThis.MGRules || {});
    } else {
        R = (this.MGRules = this.MGRules || {});
    }

    const SUIT_CHARS = ["S", "H", "D", "C"];
    const RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
    const DECK_SIZE = 52;

    function suitOf(id) { return (id / 13) | 0; }
    function rankOf(id) { return id % 13; }
    function cardVal(id) { return rankOf(id) + 2; }   // 2..14 (ace high)

    // Deterministic PRNG (mulberry32) - identical to the other engines so seeds line up.
    function makeRng(seed) {
        let s = seed | 0;
        return () => {
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function freshDeck(rng) {
        const d = [];
        for (let i = 0; i < DECK_SIZE; i++) d.push(i);
        for (let j = DECK_SIZE - 1; j > 0; j--) {
            let k = (rng() * (j + 1)) | 0;
            let t = d[j]; d[j] = d[k]; d[k] = t;
        }
        return d;
    }

    // ── hand evaluation ─────────────────────────────────────────────────────────
    // High card of the best straight in `vals` (array of card values 2..14, dups ok), or 0.
    // Handles the wheel (A-2-3-4-5) by letting the ace also count as 1.
    function straightHigh(vals) {
        const present = {};
        for (let i = 0; i < vals.length; i++) present[vals[i]] = 1;
        if (present[14]) present[1] = 1;               // ace plays low for the wheel
        let run = 0;
        for (let v = 14; v >= 1; v--) {
            if (present[v]) { run++; if (run >= 5) return v + 4; } else run = 0;
        }
        return 0;
    }

    // Score the best 5-card hand out of 5..7 cards. Returns [category, tiebreak…].
    function score(cards) {
        let byVal = {}, bySuit = [[], [], [], []], i, v, s;
        for (i = 0; i < cards.length; i++) {
            v = cardVal(cards[i]); s = suitOf(cards[i]);
            byVal[v] = (byVal[v] || 0) + 1;
            bySuit[s].push(v);
        }
        // flush / straight flush
        let flushVals = null;
        for (s = 0; s < 4; s++) if (bySuit[s].length >= 5) flushVals = bySuit[s];
        if (flushVals) {
            const sfHigh = straightHigh(flushVals);
            if (sfHigh) return [8, sfHigh];
        }
        // grouped by count then value, high to low
        const groups = [];
        for (const key in byVal) if (byVal.hasOwnProperty(key)) groups.push([byVal[key], parseInt(key, 10)]);
        groups.sort((a, b) => { return b[0] - a[0] || b[1] - a[1]; });
        // ordered distinct values high→low (kickers)
        const vals = [];
        for (i = 0; i < groups.length; i++) vals.push(groups[i][1]);

        const c0 = groups[0], c1 = groups[1];
        if (c0[0] === 4) return [7, c0[1], bestExcluding(cards, [c0[1]])];
        if (c0[0] === 3 && c1 && c1[0] >= 2) return [6, c0[1], c1[1]];
        if (flushVals) { flushVals = flushVals.slice().sort(desc); return [5, flushVals[0], flushVals[1], flushVals[2], flushVals[3], flushVals[4]]; }
        const st = straightHigh(allVals(cards));
        if (st) return [4, st];
        if (c0[0] === 3) return [3, c0[1], vals[1], vals[2]];
        if (c0[0] === 2 && c1 && c1[0] === 2) return [2, c0[1], c1[1], bestExcluding(cards, [c0[1], c1[1]])];
        if (c0[0] === 2) return [1, c0[1], vals[1], vals[2], vals[3]];
        const hv = allVals(cards).sort(desc);
        return [0, hv[0], hv[1], hv[2], hv[3], hv[4]];
    }
    function desc(a, b) { return b - a; }
    function allVals(cards) { const o = []; for (let i = 0; i < cards.length; i++) o.push(cardVal(cards[i])); return o; }
    // Highest card value in `cards` whose value is not in `exclude`. MUST NOT be derived from
    // the `vals` (group) order: groups sort by COUNT first, so a third pair / second pair sits
    // ahead of the genuine high kicker there and picking from it awarded the wrong pot
    // (e.g. AAKK2 2 Q scored its kicker as the 2, not the Q).
    function bestExcluding(cards, exclude) {
        let best = 0;
        for (let i = 0; i < cards.length; i++) {
            let v = cardVal(cards[i]);
            if (exclude.indexOf(v) !== -1) continue;
            if (v > best) best = v;
        }
        return best;
    }

    function compareScores(a, b) {
        let n = Math.max(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const x = a[i] || 0, y = b[i] || 0;
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
        for (let k = 1; k <= st.numPlayers; k++) {
            let s = (seat + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) return s;
        }
        return -1;
    }
    // First seat left of the button that is still in the hand (used to open postflop streets).
    function firstLeftOfButton(st) {
        for (let k = 1; k <= st.numPlayers; k++) {
            let s = (st.button + k) % st.numPlayers;
            if (st.inHand[s] && !st.folded[s]) return s;
        }
        return -1;
    }
    function activeCount(st) { let n = 0; for (let s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) n++; return n; }
    function canActCount(st) { let n = 0; for (let s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s] && !st.allIn[s] && st.stacks[s] > 0) n++; return n; }

    // ── hand lifecycle ────────────────────────────────────────────────────────────
    // Move `amt` chips from a seat's stack into the pot; caps at the stack (all-in) and
    // tracks both this-street bet and the hand-total committed (for side pots).
    function putIn(st, seat, amt) {
        const pay = Math.min(amt, st.stacks[seat]);
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
        const online = (seed == null);
        const deck = online ? [] : freshDeck(makeRng(seed));
        const st = {
            numPlayers: numPlayers, button: button, sb: sb, bb: bb, online: online,
            deck: deck, hole: [], board: [],
            stacks: stacks.slice(),
            bet: [], committed: [], folded: [], allIn: [], inHand: [], acted: [], noReopen: [],
            street: "preflop", currentBet: 0, minRaise: bb,
            toAct: -1, lastAggressor: -1,
            pots: [], result: null
        };
        for (let s = 0; s < numPlayers; s++) {
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
        if (!online) for (let round = 0; round < 2; round++) {
            for (let k = 1; k <= numPlayers; k++) {
                const seat = (button + k) % numPlayers;
                if (st.inHand[seat]) st.hole[seat].push(st.deck.shift());
            }
        }
        // blinds. Heads-up: button posts the small blind and acts first preflop.
        let sbSeat, bbSeat;
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
    function activeSeatCount(st) { let n = 0; for (let s = 0; s < st.numPlayers; s++) if (st.inHand[s]) n++; return n; }
    function nextOccupied(st, seat) {
        for (let k = 1; k <= st.numPlayers; k++) { let s = (seat + k) % st.numPlayers; if (st.inHand[s]) return s; }
        return seat;
    }

    // What can `seat` legally do right now?
    function legalActions(st, seat) {
        const out = { canFold: false, canCheck: false, canCall: false, callAmount: 0,
                    canRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
        if (st.street === "over" || st.street === "showdown") return out;
        if (seat !== st.toAct || !st.inHand[seat] || st.folded[seat] || st.allIn[seat]) return out;
        const toCall = st.currentBet - st.bet[seat];
        out.canFold = true;
        if (toCall <= 0) out.canCheck = true;
        else { out.canCall = true; out.callAmount = Math.min(toCall, st.stacks[seat]); }
        // A raise needs chips beyond the call. Min raise-to = currentBet + last raise size,
        // capped by the stack (a short stack can shove for less as an all-in). `noReopen`
        // marks seats that had already matched the bet when a SHORT all-in came in: they owe
        // the shove's remainder but standard NLHE does not let them re-raise it.
        const maxTo = st.bet[seat] + st.stacks[seat];
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
        const la = legalActions(st, seat);
        let t = action.type;
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
            const to = action.to | 0;
            // clamp: at least minRaiseTo (unless it's an all-in shove), at most the whole stack
            if (to > la.maxRaiseTo) return false;
            if (to < la.minRaiseTo && to !== la.maxRaiseTo) return false;
            const raiseSize = to - st.currentBet;
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
                for (let s2 = 0; s2 < st.numPlayers; s2++) {
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
        for (let s = 0; s < st.numPlayers; s++) if (s !== seat) st.acted[s] = false;
    }
    // Clear the "you may call but not re-raise" marks (set by a short all-in). Called whenever a
    // full-size raise reopens the action and at the start of every new street.
    function clearNoReopen(st) {
        for (let s = 0; s < st.numPlayers; s++) st.noReopen[s] = false;
    }

    // Is the current betting round complete?
    function roundOver(st) {
        for (let s = 0; s < st.numPlayers; s++) {
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
        const nxt = nextToAct(st, st.toAct);
        st.toAct = nxt;
    }

    const STREETS = { preflop: "flop", flop: "turn", turn: "river", river: "showdown" };
    // Online the deck is empty and the board is filled from the server's BOARD events, so
    // dealing is a no-op here - betting never reads st.board, only the display does.
    function dealBoard(st, n) { if (st.online) return; for (let i = 0; i < n; i++) st.board.push(st.deck.shift()); }

    function nextStreet(st) {
        // clear the street's bets (committed already holds them for side pots)
        for (let s = 0; s < st.numPlayers; s++) { st.bet[s] = 0; st.acted[s] = false; }
        st.currentBet = 0; st.minRaise = st.bb; st.lastAggressor = -1;
        clearNoReopen(st);                  // last street's short-shove restrictions expire
        const nx = STREETS[st.street];
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
            const nx = STREETS[st.street];
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
        const wasLive = st.inHand[seat] && !st.folded[seat];
        st.stacks[seat] = 0;                       // forfeit remaining chips → out of all future hands
        if (!wasLive) return;
        st.folded[seat] = true;
        st.acted[seat] = true;                     // don't let roundOver wait on a seat that's gone
        const wasToAct = st.toAct === seat;
        if (activeCount(st) <= 1) { finish(st); return; }
        if (canActCount(st) <= 1 && roundOver(st)) { runout(st); return; }
        if (roundOver(st)) { nextStreet(st); return; }
        if (wasToAct) st.toAct = nextToAct(st, st.toAct);
    }

    // Single player left (all others folded): they take the pot uncontested, no cards shown.
    function finish(st) {
        let winner = -1;
        for (var s = 0; s < st.numPlayers; s++) if (st.inHand[s] && !st.folded[s]) { winner = s; break; }
        let total = 0;
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
        const contribs = st.committed.slice();
        const pots = [];
        while (true) {
            let min = Infinity, any = false, s;
            for (s = 0; s < st.numPlayers; s++) if (contribs[s] > 0) { any = true; if (contribs[s] < min) min = contribs[s]; }
            if (!any) break;
            let amount = 0, eligible = [];
            for (s = 0; s < st.numPlayers; s++) {
                if (contribs[s] > 0) {
                    amount += min; contribs[s] -= min;
                    if (!st.folded[s]) eligible.push(s);   // folded chips are dead money
                }
            }
            pots.push({ amount: amount, eligible: eligible });
        }
        // evaluate every contender once
        const scores = {};
        for (var i = 0; i < st.numPlayers; i++)
            if (st.inHand[i] && !st.folded[i]) scores[i] = evalSeat(st.hole[i], st.board);

        const resultPots = [];
        for (i = 0; i < pots.length; i++) {
            const p = pots[i];
            let best = null, winners = [];
            for (let j = 0; j < p.eligible.length; j++) {
                const seat = p.eligible[j], sc = scores[seat];
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
        const each = Math.floor(amount / winners.length);
        const rem = amount - each * winners.length;
        const ordered = winners.slice().sort((a, b) => {
            return seatOrderFromButton(st, a) - seatOrderFromButton(st, b);
        });
        for (var i = 0; i < ordered.length; i++) st.stacks[ordered[i]] += each;
        for (i = 0; i < rem; i++) st.stacks[ordered[i]] += 1;
    }
    function seatOrderFromButton(st, seat) { return (seat - st.button + st.numPlayers) % st.numPlayers; }
    function mergeWinners(pots) {
        const set = {}, out = [];
        for (let i = 0; i < pots.length; i++) for (let j = 0; j < pots[i].winners.length; j++) set[pots[i].winners[j]] = 1;
        for (let k in set) if (set.hasOwnProperty(k)) out.push(parseInt(k, 10));
        return out;
    }
    function totalPot(st) { let t = 0; for (let s = 0; s < st.numPlayers; s++) t += st.committed[s]; return t; }

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
        const a = cardVal(hole[0]), b = cardVal(hole[1]);
        const hi = Math.max(a, b), lo = Math.min(a, b);
        const pair = a === b, suited = suitOf(hole[0]) === suitOf(hole[1]);
        const gap = hi - lo;
        let s = 0;
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
        const sc = evalSeat(st.hole[seat], st.board);
        return sc[0] / 8 + (sc[1] || 0) / 200;             // category dominates, top rank breaks ties
    }
    function botAction(st, seat, rng) {
        const la = legalActions(st, seat);
        if (!la.canFold && !la.canCheck) return { type: "check" };
        const r = rng ? rng() : 0.5;
        const strength = (st.street === "preflop") ? preflopStrength(st.hole[seat]) : madeStrength(st, seat);
        const toCall = la.canCall ? la.callAmount : 0;
        const pot = totalPot(st);
        const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

        // strong hand → raise sometimes
        if (la.canRaise && strength > 0.6 && r < 0.6) {
            let target = st.currentBet + Math.max(st.minRaise, Math.floor(pot * (0.5 + strength * 0.5)));
            target = Math.min(target, la.maxRaiseTo);
            target = Math.max(target, la.minRaiseTo);
            return { type: "raise", to: target };
        }
        if (la.canCheck) {
            if (la.canRaise && strength > 0.72 && r < 0.5) {
                const t2 = Math.min(la.maxRaiseTo, Math.max(la.minRaiseTo, st.bb * 3));
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

/* ── generated GeoGuesser panorama pool ── */
/* GENERATED by tools/build_geo_pool_module.js from server/geo_pool.json - DO NOT EDIT. */
/* 2334 prebuilt 360-degree panorama locations:
   source|id|lat|lon|region|provider|country|continent
   source 0 = Panoramax, 1 = Mapillary. `region` is the coarse harvest-balance bbox;
   `continent` is the DISPLAY continent for country (index into the same six names), and
   is -1 with an empty country for rows Natural Earth cannot place. Starting a lobby picks
   from this list and makes ZERO catalog requests. Refresh with tools/build_geo_pool.js,
   then rerun this and tools/build_geo_credit_tables.js. */
const GEO_POOL_PACKED = "1|4109783629074442|57.628258|18.292751|0|ainali|Sweden|0\n1|1503099496812994|-27.719039|153.058422|5|smithwa|Australia|5\n1|1191018652734748|10.278981|123.979712|4|Kaart 360|Philippines|4\n1|1469720277254374|-32.012434|115.894081|5|radiotrefoil|Australia|5\n1|289052699535300|16.850997|-11.815608|3|sidi|Mauritania|3\n1|1511723606372948|45.545285|-73.585261|1|VdM|Canada|1\n0|539493be-7921-4607-bb76-b57dea3d4c09|35.462249|-97.654073|1|Hopen111|United States of America|1\n1|1825413274646467|-8.579778|125.533445|5|NOD|Timor-Leste|4\n1|8374713299210415|-37.217305|150.016088|5|Echidna|Australia|5\n1|2447924108958414|3.950809|39.751999|3|GetFound Africa|Ethiopia|3\n1|737620200243445|18.435011|79.529625|4|mkhan|India|4\n1|528902559364184|-41.082717|-71.181442|2|Kaart Local|Argentina|2\n1|1558914988892211|-8.653508|125.640276|5|kahbeng|Timor-Leste|4\n1|4007969872825443|-0.288306|36.131747|3|danbomett|Kenya|3\n1|660002203225624|44.881182|13.859478|0|LTuropolec|Croatia|0\n1|2736274266563412|58.410201|13.879671|0|thewizard|Sweden|0\n1|1230492251272356|-32.704803|26.609123|3|Infratec2024|South Africa|3\n1|1338139134948091|40.689951|-95.790595|1|flug32|United States of America|1\n1|2086670748542726|35.608032|45.352907|4|Bwarrior|Iraq|4\n1|1881198312592203|-6.137829|24.480327|3|bmitto|Democratic Republic of the Congo|3\n1|1694216401604951|48.832604|-94.849995|1|cartographer|United States of America|1\n1|663483253253509|40.982300|37.887386|4|cbsordu|Turkey|4\n1|137520982608741|-8.747733|-63.881199|2|jaderbavaresco|Brazil|2\n1|749926869835548|37.282102|-80.052222|1|echostorm|United States of America|1\n1|632808581304224|18.275404|109.666511|4|adirricor|China|4\n1|832825524257800|-33.757989|151.232108|5|aharvey|Australia|5\n1|506284803742491|47.950992|16.410463|0|di0v0n|Austria|0\n1|1099134431362359|52.672329|-7.259023|0|annekaro|Ireland|0\n1|547665909567584|58.660336|17.087956|0|sunkist|Sweden|0\n1|1477367826607702|-27.217843|-61.188321|2|RoloRoldana|Argentina|2\n1|987467962203360|-17.463142|145.015740|5|coreagc|Australia|5\n1|1038786283898935|-29.058519|141.863478|5|Kangaroo|Australia|5\n1|761146080193379|50.190252|-61.559889|1|michelcouturemotomcm|Canada|1\n1|977786047692152|-8.787252|120.170148|5|rgtm ryuiki|Indonesia|4\n1|464803111460672|47.105582|17.571502|0|kolesajr|Hungary|0\n1|1394054564560684|-16.394714|30.997945|3|Kennedy Jomokela|Zimbabwe|3\n1|1572722577154904|34.393716|8.029540|3|amorToun|Tunisia|3\n1|1332497815083067|-36.230166|174.496590|5|ralley|New Zealand|5\n1|217637826562881|33.376452|-7.299419|3|immergismap|Morocco|3\n1|506590201498891|-0.187826|-78.476801|2|kaart 2|Ecuador|2\n1|959011238383489|-17.427918|145.204774|5|coreagc|Australia|5\n1|742190324806028|-26.334842|28.765897|3|Infratec2025|South Africa|3\n1|670155734142541|52.482405|13.526304|0|eserte|Germany|0\n1|1860054451290203|7.852283|6.083744|3|Newwaves123|Nigeria|3\n1|442296492100257|45.409774|-108.557148|1|adamroads|United States of America|1\n1|2499588063823952|6.582559|3.408491|3|bccdelta|Nigeria|3\n1|639589867251191|-21.974806|-44.900972|2|prefeiturabaependimap|Brazil|2\n1|6744061535673167|30.968143|34.775735|3|jeffreymartin|Israel|4\n1|162550599750555|42.419288|-8.638121|0|sgonzalezd|Spain|0\n1|2501118753647022|39.767739|21.188942|0|nglf|Greece|0\n1|998213395054332|-22.294203|-53.279228|2|Sicart360|Brazil|2\n1|993573269401157|53.025891|-7.300211|0|annekaro|Ireland|0\n1|199553635348164|48.151537|-3.010846|0|simon geovelo|France|0\n1|948122099433490|24.670056|120.856388|4|shinling|Taiwan|4\n1|457186257088185|-21.671715|-57.921453|2|Desireespindler|Brazil|2\n1|2160000991048508|50.421374|-114.546206|1|tomvh|Canada|1\n1|611674233812722|-0.187109|-78.505708|2|kaart 2|Ecuador|2\n1|317102468003110|4.082226|-72.972813|2|juanmelo|Colombia|2\n1|305716161022105|-6.273764|39.429823|3|federicodebetto|Tanzania|3\n1|1680501589770015|3.559528|11.554026|3|vteck|Cameroon|3\n1|1576229472965311|51.131956|71.478967|4|YMtest|Kazakhstan|4\n1|448436369589764|-20.275475|148.743492|5|esriau 1topo|Australia|5\n1|1975914702796772|44.208053|-102.206785|1|penncohwy|United States of America|1\n1|2062503410564283|13.416949|-16.657867|3|kmc streets|Gambia|3\n1|1522268022828982|53.511877|-114.019866|1|Westower Braedyn|Canada|1\n1|2390000401208643|-4.780285|-40.079481|2|Amplomap360|Brazil|2\n1|620161232520211|-16.010606|145.445433|5|coreagc|Australia|5\n1|4056226231128333|3.341828|23.960545|3|tojoaro|Democratic Republic of the Congo|3\n1|240730239081491|-43.500772|172.687445|5|blackmapsmaksym|New Zealand|5\n1|528129868223414|26.270043|50.207929|4|mahmoud12|Saudi Arabia|4\n1|1341505166675912|3.717297|34.866671|3|duncankebut|Kenya|3\n1|661419208552303|-27.586344|-48.508472|2|guilhermez|Brazil|2\n1|363107162136885|14.683463|121.078098|4|srdpmapping|Philippines|4\n1|720630369266708|53.415452|-2.945481|0|markagreen14|United Kingdom|0\n1|746511873591821|-12.756846|45.101972|3|SIG 3CO|France|0\n1|1859570084715228|-5.921822|24.840151|3|bmitto|Democratic Republic of the Congo|3\n1|26873070582301930|-16.476289|-54.606813|2|PMR|Brazil|2\n1|2622428144842093|7.766040|113.243274|4|Arifyabarokah123||-1\n1|602900711842702|-39.810220|-73.244411|2|Transporte DSS|Chile|2\n1|983137420995437|51.698783|73.163112|4|kazrap|Kazakhstan|4\n1|988661202488932|53.540628|-106.932830|1|boxer123|Canada|1\n1|331938288277711|41.788073|-72.524547|1|cholloway|United States of America|1\n1|357525116152134|56.579146|30.142418|4|ivangeo|Russia|0\n1|710403298576774|26.323772|78.446405|4|snranjan|India|4\n1|522819865687130|32.028274|35.349341|3|360ms|Palestine|4\n1|640615991584642|32.219267|-90.564124|1|jeffreymartin|United States of America|1\n1|2904084589793386|-8.746869|-63.877231|2|jaderbavaresco|Brazil|2\n1|953533602127455|50.444108|16.930894|0|tpenerga|Poland|0\n1|3275012222752584|43.644496|-88.895853|1|greenline|United States of America|1\n1|1152814591241364|40.932020|29.274078|0|burakonder|Turkey|4\n1|1306797887186030|27.974236|85.567939|4|Nepal FRES|Nepal|4\n1|643496841480698|-3.701478|143.637626|5|PNGDOWH|Papua New Guinea|5\n1|1283862632720791|28.595680|-81.268431|1|rking|United States of America|1\n1|444094762099959|44.707758|7.841649|0|canfe|Italy|0\n1|282517086841705|9.533450|-13.690681|3|dabohamda|Guinea|3\n1|133919222086621|30.427846|-95.492615|1|microsoft|United States of America|1\n1|3824121777700316|56.258344|21.529196|0|lakd|Lithuania|0\n1|1439072966440896|26.138106|-80.297253|1|microsoft|United States of America|1\n1|1444109809979013|40.885956|0.302865|0|meteolasenia|Spain|0\n1|1205619144255550|-12.724945|45.059925|3|geodzer|France|0\n1|1700757987908997|-3.781692|-70.367326|2|juanmelo|Colombia|2\n1|2341164123037044|34.408656|8.067919|3|amorToun|Tunisia|3\n1|1275256850097128|52.660812|-7.256805|0|annekaro|Ireland|0\n1|862457492784682|40.414294|-3.664514|0|inspectorl3|Spain|0\n1|962197165549547|9.353101|-79.832252|2|kaart 4|Panama|1\n1|1627363442039095|-37.740725|145.210670|5|HIPA|Australia|5\n1|1038751711153196|55.635836|-3.103628|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|800271075965910|25.859653|84.398376|4|balu geo|India|4\n1|3270361089902934|-23.440851|-46.259678|2|360|Brazil|2\n1|310487130536769|-17.574788|178.243860|5|flashkiwi|Fiji|5\n1|870693958405222|32.696050|-17.088554|3|geouma|Portugal|0\n1|1349869710073703|8.491018|-13.248256|3|Franklyn 1|Sierra Leone|3\n1|900391291599388|-29.693369|-50.160899|2|jaderbavaresco|Brazil|2\n1|187204077217781|-11.131126|-51.702751|2|gmancilla|Brazil|2\n1|831165408461155|55.951374|-3.209912|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|1146225474333030|43.123305|-7.633812|0|AdgobaAlvac|Spain|0\n1|1169224971598277|21.334782|39.945692|3|ehabeid|Saudi Arabia|4\n1|919942677691871|41.450409|-72.471040|1|ctroadway360|United States of America|1\n1|587306790138504|-0.507872|166.952542|5|flashkiwi|Nauru|5\n1|1260887029370090|-41.816650|-73.506960|2|ricardomadridg|Chile|2\n1|332613296452046|-32.572273|26.620486|3|Infratec2024|South Africa|3\n1|1506043263326674|-0.605508|-72.245302|2|juanmelo|Colombia|2\n1|983050420120140|43.287162|-0.547950|0|sogefi|France|0\n1|245796537304485|25.579649|-103.516296|1|innerpace360|Mexico|1\n1|144803428154695|41.096616|37.088401|4|cbsordu|Turkey|4\n1|609903031667633|-20.270186|-70.037247|2|Kaart Local|Chile|2\n1|3516701745254707|-0.534912|166.943177|5|flashkiwi|Nauru|5\n1|1298339764740173|-36.442736|174.592889|5|bede|New Zealand|5\n1|236815745285455|55.815067|12.374695|0|fur1ksw1|Denmark|0\n1|153333143391899|17.509158|-13.099553|3|sidi|Mauritania|3\n1|807352993823954|-29.974036|-71.264104|2|Josebaeza|Chile|2\n1|1529408555852801|24.527744|39.650224|3|mahmoud12|Saudi Arabia|4\n1|2036582747229957|42.579914|-106.684726|1|flug32|United States of America|1\n1|2391767867943019|41.064608|-111.970347|1|flug32|United States of America|1\n1|9492679267450428|-6.791694|39.194388|3|OMDTZ1|Tanzania|3\n1|748970538309892|43.648213|-116.390550|1|marker geo1|United States of America|1\n1|923456486341767|-12.107650|-77.046545|2|kaart 360|Peru|2\n1|550220348030562|-41.117548|-73.054756|2|Kaart Local|Chile|2\n1|184164500637978|31.831320|131.281036|4|kojiroucircle|Japan|4\n1|1101813335097134|50.703866|18.195502|0|altaaro|Poland|0\n1|2154805108421338|39.923963|3.839259|0|trekviewed|Spain|0\n1|1181775212286108|57.105647|65.433108|4|survaero|Russia|4\n1|501972437661717|-20.834436|-41.115704|2|360|Brazil|2\n1|1173874313053217|30.231825|-87.907852|1|steer360network|United States of America|1\n1|1134589673710432|-27.585127|-56.635470|2|emanuel alejandro maciel|Argentina|2\n1|688167827451194|45.577866|-62.655818|1|TNG Engineering|Canada|1\n1|828454871165668|-20.317265|-40.387943|2|360|Brazil|2\n1|211406110462033|-20.375115|148.622553|5|esriau 1topo|Australia|5\n1|1528475397894350|-10.569850|142.225217|5|flashkiwi|Australia|5\n1|759721198027874|47.645721|-117.276999|1|amidave|United States of America|1\n1|906077681430175|23.327884|105.297683|4|theonenetwork|Vietnam|4\n1|1484900989640150|-45.824349|170.630904|5|skillsy|New Zealand|5\n1|890856082229448|37.404358|121.734597|4|recklessxpy|China|4\n1|1296426888484750|44.560799|-97.997818|1|GIS ISG|United States of America|1\n1|569337047363459|56.353330|51.595116|4|vovenarg|Russia|0\n1|1035443442050063|-17.762372|-63.188687|2|Wakamolee|Bolivia|2\n1|4019333891499211|38.757173|-9.206695|0|davipt|Portugal|0\n1|1342298408007050|9.036749|38.756008|3|DanTsg|Ethiopia|3\n1|2275949382916331|-19.108586|33.471128|3|renaldoflor|Mozambique|3\n1|897680282870376|-16.594325|178.982826|5|LTC|Fiji|5\n1|1011643091014824|31.954594|-110.441682|1|rking|United States of America|1\n1|583050749981421|26.174222|-97.653856|1|rking|United States of America|1\n1|1233631238755400|41.353617|-72.716343|1|ctroadway360|United States of America|1\n1|1786816391867243|28.579650|-13.957536|3|trekviewed|Spain|0\n1|290095480650193|42.319865|-83.085597|1|codgis|United States of America|1\n1|798153552492603|42.777373|-118.439383|1|ChronicHiker|United States of America|1\n1|1188054925661750|55.847246|-4.299237|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|1012006099996515|-22.755355|-41.877866|2|360|Brazil|2\n1|1774388096567903|45.101451|142.116645|4|yuki charo|Japan|4\n1|288444859641985|40.837404|-115.755765|1|rking|United States of America|1\n1|2059956431249229|38.320021|-76.506411|1|stmaryscounty1|United States of America|1\n1|1295809996087904|53.864979|-78.730108|1|michelcouturemotomcm|Canada|1\n1|236887928210329|40.743574|14.774494|0|klimakas|Italy|0\n1|273255345651020|-29.152451|150.967192|5|Wallaby|Australia|5\n0|cf093731-3398-4500-a890-21f1796ddb0b|6.006128|-0.194873|3|Nzau|Ghana|3\n1|2130774707222104|22.021218|96.470198|4|mghla|Myanmar|4\n1|253430479867608|52.175799|-106.639285|1|sbailey|Canada|1\n1|1677293046079900|1.747094|40.057617|3|quantiscale|Kenya|3\n1|146758624082226|43.504722|104.055556|4|l1ndemann|Mongolia|4\n1|181606951143154|43.157610|45.551488|4|microfauna|Russia|0\n1|1049311753236928|28.536927|-81.405302|1|Sitetour|United States of America|1\n1|1286010986757313|-35.662701|174.294194|5|timwardWDC|New Zealand|5\n1|3268785346685309|53.696795|55.936997|4|velostas|Russia|0\n1|1674599419910908|-33.555505|25.692038|3|Infratec2025|South Africa|3\n1|1717134576364215|7.795895|-72.201441|2|rolandovasq|Venezuela|2\n1|379159430073156|54.559111|100.582422|4|moltgeo|Russia|4\n1|1862581351329720|-26.749985|153.057678|5|LukeCWalton|Australia|5\n1|1147120447250380|6.158696|-75.655264|2|LaEstrella FN360|Colombia|2\n1|396630669204411|24.605560|46.634682|3|GreenRiyadh|Saudi Arabia|4\n1|945780420493101|35.887798|44.985727|4|flashkiwi|Iraq|4\n1|1638803494077640|40.806266|-124.144820|1|marker geo1|United States of America|1\n1|1062109717755595|-27.672456|153.024873|5|ianstephenson|Australia|5\n1|557198876376210|54.872310|10.357894|0|jenspeterhansen|Denmark|0\n1|203013684992401|40.600314|-124.145100|1|jesseakaraccoon|United States of America|1\n1|542085608561437|-12.221886|-60.690004|2|jaderbavaresco|Brazil|2\n1|129667432434678|-41.888428|148.274930|5|aharvey|Australia|5\n1|180827947274425|43.388887|-1.658014|0|geovelo|France|0\n1|981980561429687|46.629376|-97.324726|1|UAS ISG|United States of America|1\n1|1368200707048741|51.315365|75.820609|4|kazrap|Kazakhstan|4\n1|1145053844192418|-36.875780|174.699378|5|ralley|New Zealand|5\n1|1741679936716224|50.177310|-61.381572|1|michelcouturemotomcm|Canada|1\n1|1080837942578720|-11.063812|-51.931607|2|gmancilla|Brazil|2\n1|196816865969864|40.952630|38.060909|4|cbsordu|Turkey|4\n1|681874347244044|-14.788783|-57.282399|2|geocid|Brazil|2\n1|462656276425115|-8.572944|125.539167|5|NOD|Timor-Leste|4\n1|945767486970164|-16.398932|31.014607|3|Kennedy Jomokela|Zimbabwe|3\n1|809016402018442|47.477244|-94.821456|1|cartographer|United States of America|1\n1|373398819020216|52.588995|-7.175921|0|annekaro|Ireland|0\n1|1112455239814823|44.985965|20.147650|0|borovac|Serbia|0\n1|1166528441654465|6.741150|125.366899|4|Kaart 360|Philippines|4\n1|1230391821172408|48.590351|70.633652|4|kazrap|Kazakhstan|4\n1|1513857160011130|34.854504|-108.529119|1|riddelleng|United States of America|1\n1|965061852045100|52.434751|-7.022215|0|annekaro|Ireland|0\n1|1611246683114498|-1.483771|-48.465675|2|mapconcierge|Brazil|2\n1|2427117651070237|53.502545|-113.959268|1|Westower Braedyn|Canada|1\n1|602404640728948|29.801997|-94.657609|1|rking|United States of America|1\n1|375036382330128|43.274016|76.730018|4|kazrap|Kazakhstan|4\n1|3143000549231473|39.902617|4.064309|0|trekviewed|Spain|0\n1|814956289453648|16.941808|96.151664|4|thohi|Myanmar|4\n1|685620306146826|18.324151|109.702809|4|adirricor|China|4\n1|1339256793365450|56.462461|10.161144|0|jenspeterhansen|Denmark|0\n1|838386198026756|-8.894973|146.721676|5|PNGDOWH|Papua New Guinea|5\n1|1221917913434898|50.862077|18.069339|0|wojciechwalus|Poland|0\n1|982939219182312|-22.271011|166.469756|5|ratzillas|New Caledonia|5\n1|1317352682259375|-33.737497|143.015648|5|Kangaroo|Australia|5\n1|358710843362024|2.034778|45.323328|3|adiiba25|Somalia|3\n1|1317162052725732|48.598149|8.384333|0|RadNETZ|Germany|0\n0|5d055af4-be65-45d7-8b26-3cfcb5aabce8|49.949653|36.328386|4|dehtiarne|Ukraine|0\n1|1267068751247171|5.560875|95.285266|4|rgtm ryuiki|Indonesia|4\n1|591364532907481|38.008486|23.870858|0|efikour|Greece|0\n1|2347999395616243|24.633577|121.790989|4|lisbethw1130|Taiwan|4\n1|651880443467895|40.687125|-111.868833|1|rking|United States of America|1\n1|1648740739754311|53.859123|-78.708627|1|michelcouturemotomcm|Canada|1\n1|849443132580888|-10.156007|148.823801|5|jthnz|Papua New Guinea|5\n1|205999784681064|26.686921|-77.302023|1|steer360network|Bahamas|1\n1|1318162059895007|-8.517885|115.269080|5|Kaart 360|Indonesia|4\n1|507439987043375|43.646139|-1.443171|0|c64|France|0\n1|1778097013544985|28.489979|-16.334628|3|MttoviarioAPIlalaguna|Spain|0\n1|2861944390714299|-1.574645|29.066453|3|tojoaro|Democratic Republic of the Congo|3\n1|424741032610827|-16.201900|144.418691|5|coreagc|Australia|5\n1|184047026979807|51.157269|94.468260|4|survaero|Russia|4\n1|740832168376168|50.776191|-4.567268|0|trekviewed|United Kingdom|0\n1|466081036122583|52.946767|-66.900638|1|zombiegraph|Canada|1\n1|965993448352052|-26.508293|29.958583|3|Infratec2024|South Africa|3\n1|485808512464613|57.770610|108.118870|4|trolleway|Russia|4\n1|688159959783500|33.547103|-81.723367|1|pdorrohcityofaikensc|United States of America|1\n1|2054188671997808|53.243383|5.568954|0|thewizard|Netherlands|0\n1|404769611173216|56.570342|30.160115|4|ivangeo|Russia|0\n1|771638409310293|-6.154562|24.427993|3|bmitto|Democratic Republic of the Congo|3\n1|418483924398969|52.283535|13.209829|0|Altnowaweser|Germany|0\n1|1350851656038547|30.984890|41.025944|3|ehabeid|Saudi Arabia|4\n1|3374668179431670|26.977980|100.432688|4|adirricor|China|4\n1|213770728004556|-29.052843|167.956058|5|flashkiwi|Norfolk Island|5\n1|671201385100949|38.977501|-76.530980|1|rking|United States of America|1\n1|1326897332876143|-5.635853|25.462679|3|bmitto|Democratic Republic of the Congo|3\n1|138059638360778|54.576357|100.578394|4|moltgeo|Russia|4\n1|2412769979221554|40.699115|29.487464|0|burakonder|Turkey|4\n1|957292223996871|40.940409|27.434681|0|burakonder|Turkey|0\n1|214034117012851|34.089948|-117.344776|1|rking|United States of America|1\n1|1179815966507024|40.970706|-111.921388|1|rking|United States of America|1\n1|239087078946590|-26.707631|153.121981|5|LukeCWalton|Australia|5\n1|333196688224316|26.805115|37.948877|3|mahmoud12|Saudi Arabia|4\n1|1628173341102715|-30.984588|-55.503630|2|Kaart Local|Uruguay|2\n1|117232813954394|-12.785390|143.306165|5|coreagc|Australia|5\n1|1620763892663968|44.835135|142.137502|4|yuki charo|Japan|4\n0|87baa1ca-a69e-4ec7-81c9-0cc177778adc|42.451216|-71.076975|1|slinky309|United States of America|1\n1|1363692008593979|37.983109|-8.260455|0|filohipo|Portugal|0\n1|1547007916010712|-8.708222|120.170692|5|rgtm ryuiki|Indonesia|4\n1|768946191083943|27.110152|100.251974|4|adirricor|China|4\n1|1167103288580613|39.215776|9.117474|0|mapconcierge|Italy|0\n1|455640106405686|5.172690|5.836081|3|michael212|Nigeria|3\n1|475726568481564|31.282459|120.753342|4|recklessxpy|China|4\n1|942069363305789|-41.992473|148.285653|5|aharvey|Australia|5\n1|744767979553274|25.532325|-103.530075|1|innerpace360|Mexico|1\n1|1164783670720891|-35.673951|174.319117|5|ralley|New Zealand|5\n1|8409500479151968|53.237533|-2.748983|0|jg360|United Kingdom|0\n1|1047686499129300|-21.952275|-44.891148|2|prefeiturabaependimap|Brazil|2\n1|841968973332719|14.462223|78.160790|4|geomannar|India|4\n1|315666976852530|45.568904|-1.063792|0|ev1velodyssee|France|0\n1|3347082498908605|-12.180820|-77.020787|2|kaart 2|Peru|2\n1|1528452891927434|41.738486|-122.660605|1|marker geo1|United States of America|1\n1|2179204752233924|18.402205|109.849672|4|adirricor|China|4\n1|184289353556450|41.554908|-73.049924|1|ctroadway360|United States of America|1\n1|2045463656363132|-8.479306|119.898972|5|engelbertus|Indonesia|4\n1|1381973322387634|-10.570980|142.220917|5|flashkiwi|Australia|5\n1|2917236711927585|52.157962|-106.669600|1|sbailey|Canada|1\n1|168712138511493|0.572834|25.183268|3|tojoaro|Democratic Republic of the Congo|3\n1|750217760251458|-27.977536|152.993027|5|ScenicRimRC|Australia|5\n1|2818823728366247|-27.748801|152.924518|5|ripram|Australia|5\n1|1174422159827110|18.513318|73.855923|4|tranzitnotes|India|4\n1|584682013117088|2.358122|31.485644|3|federicodebetto|Uganda|3\n1|1288920869628387|-19.224100|-45.972148|2|MuitoAlemdasFronteiras|Brazil|2\n1|635852111686857|-29.029975|167.924713|5|flashkiwi|Norfolk Island|5\n1|859488784689462|-12.094168|142.558712|5|coreagc|Australia|5\n1|1159971704685098|14.559402|99.938498|4|Shindai|Thailand|4\n1|133648838801813|-33.929943|151.165391|5|aharvey|Australia|5\n1|2136980946822166|50.893747|142.163733|4|jocem58265|Russia|4\n1|405327251995491|-16.350974|30.851482|3|Kennedy Jomokela|Zimbabwe|3\n1|346940431586000|-11.782982|-61.888010|2|jaderbavaresco|Brazil|2\n1|467139559342513|27.691318|86.729437|4|gallimaps|Nepal|4\n1|3514415108688889|28.357121|-16.874587|3|trekviewed|Spain|0\n1|1756181968619430|-20.701442|-44.858264|2|IGTECH|Brazil|2\n1|976448233448875|53.005772|132.672502|4|vememi9618|Russia|4\n1|308691957380878|-27.338689|-58.169596|2|emanuel alejandro maciel|Argentina|2\n1|1036751880799265|31.184138|35.361317|3|jeffreymartin|Israel|4\n1|759333146013957|27.094918|142.194314|4|wata909|Japan|4\n1|338742389251234|45.592137|-62.642133|1|TonyMummery|Canada|1\n1|3068907640095663|9.825990|3.362005|3|michael212|Benin|3\n1|276751020826864|30.182953|-95.706962|1|microsoft|United States of America|1\n1|3999655343426897|-27.342942|-55.054366|2|emanuel alejandro maciel|Argentina|2\n1|1065204310904578|41.022518|28.587221|0|ademturkmen|Turkey|0\n1|4770459816383274|-21.973201|-44.896593|2|prefeiturabaependimap|Brazil|2\n1|769595385301898|49.462273|-2.567350|0|FiftyPence|Guernsey|0\n1|1656315481393893|-5.348349|39.690815|3|federicodebetto|Tanzania|3\n1|2085271061625574|-51.676718|-69.275650|2|jpabloroots|Argentina|2\n1|581607074671460|-36.818580|174.430679|5|ralley|New Zealand|5\n1|294582072308554|18.259927|79.341499|4|neogeoinfo|India|4\n1|952572866963752|25.730231|84.527746|4|subhash geo|India|4\n1|919791986363016|-41.173069|-73.491195|2|Kaart Local|Chile|2\n1|1272747116982732|56.484519|9.845481|0|jenspeterhansen|Denmark|0\n1|2879711552285724|52.409109|-7.209523|0|dave683|Ireland|0\n1|1445185012499725|43.119019|131.890518|4|trolleway|Russia|4\n1|1047496117662131|-8.724698|115.234868|5|Kaart 360|Indonesia|4\n1|2514809668889628|52.494374|31.100555|4|360 m5 by|Belarus|0\n1|966225981669410|4.083847|-72.967008|2|juanmelo|Colombia|2\n1|3061312754026535|50.896875|142.156266|4|jocem58265|Russia|4\n1|2489602117842259|-33.721952|150.322363|5|radiotrefoil|Australia|5\n1|1192230594898775|1.684118|31.721291|3|federicodebetto|Uganda|3\n1|940909425766147|-35.615353|174.520841|5|timwardWDC|New Zealand|5\n1|600711083074676|-12.824223|45.131349|3|SIG 3CO|France|0\n1|462168663122427|-21.700516|-57.885782|2|Desireespindler|Brazil|2\n1|866458238569791|-29.155414|150.997296|5|Wallaby|Australia|5\n1|347278517672358|31.409002|35.384439|3|jeffreymartin|Israel|4\n1|1011624125157386|40.495798|-124.108535|1|marker geo1|United States of America|1\n1|2863893210422861|34.149247|-114.280489|1|rking|United States of America|1\n1|2103299710026449|40.663276|14.425337|0|stefan RolfsRom|Italy|0\n1|743918770702197|-16.401771|30.937797|3|Kennedy Jomokela|Zimbabwe|3\n1|476761486983000|14.740014|-17.152453|3|laminendiaye|Senegal|3\n1|1006772640143444|5.367225|-4.102333|3|cign|Côte d’Ivoire|3\n1|1701201144435501|36.493095|29.115429|0|trekviewed|Turkey|4\n1|139229678178048|51.503940|45.957820|4|trolleway|Russia|0\n1|210125081460258|53.091961|-105.856578|1|boxer123|Canada|1\n1|2502282740146664|36.022284|14.228378|0|richlv|Malta|0\n1|805423873431107|28.897699|-13.745605|3|javiersanp|Spain|0\n1|3942154842585674|-9.569003|-35.740513|2|viniciusmap|Brazil|2\n1|1418685912658868|28.361236|-16.870992|3|trekviewed|Spain|0\n1|584761887484353|-15.735935|-47.929482|2|mapconcierge|Brazil|2\n1|825100845052634|54.553303|100.550319|4|moltgeo|Russia|4\n1|1457174002788755|28.392676|77.307875|4|skysign|India|4\n1|613751716246224|53.896860|42.800992|4|investproekt|Russia|0\n1|1120872395852617|-8.753825|-63.893920|2|jaderbavaresco|Brazil|2\n1|2765098347025604|-30.518136|-71.487207|2|Kaart Local|Chile|2\n1|1570305786700743|27.547178|99.830359|4|adirricor|China|4\n1|901320531474121|-26.992673|28.203208|3|Infratec2024|South Africa|3\n1|444133338738867|39.686482|64.603271|4|kazrap|Uzbekistan|4\n1|353298377772953|23.053534|72.450532|4|skysign|India|4\n1|27285507374386308|40.239551|-123.820806|1|marker geo1|United States of America|1\n1|1651140842801298|-26.538447|28.340905|3|Infratec2026|South Africa|3\n1|1472062806502333|31.914715|-102.309880|1|rking|United States of America|1\n1|1020759567159098|53.012257|-4.100097|0|TramperUser|United Kingdom|0\n1|305407647929737|-6.426713|39.473591|3|federicodebetto|Tanzania|3\n1|1931018707642172|59.378171|17.904591|0|bruno360|Sweden|0\n1|952576976062280|-8.079581|-79.116610|2|kaart 2|Peru|2\n1|682423420685278|-31.291748|142.287944|5|Kangaroo|Australia|5\n1|673611868991479|-2.735623|141.340994|5|PNGDOWH|Papua New Guinea|5\n1|998389155988132|-16.461480|-54.613200|2|PMR|Brazil|2\n1|929724365469285|-36.717773|174.714229|5|ZealandiaStreamwalkView|New Zealand|5\n1|933556114750912|40.692974|-99.418866|1|Mosaic51 Dylan|United States of America|1\n1|1004358601497117|28.342397|-16.921134|3|trekviewed|Spain|0\n1|1786359626091205|45.228489|104.536475|4|INsta3600|Mongolia|4\n1|1560979835700786|40.785201|-124.136099|1|marker geo1|United States of America|1\n1|1077275033695575|41.277741|-96.016268|1|quickness805|United States of America|1\n1|507020730644673|-27.681477|153.092950|5|ianstephenson|Australia|5\n1|3851010895029033|9.012900|38.764210|3|DanTsg|Ethiopia|3\n1|165595012178667|5.808527|5.084813|3|michael212|Nigeria|3\n1|1310082447388178|13.423047|-16.692693|3|Africa360view|Gambia|3\n1|2038293480315013|41.178099|-96.119224|1|quickness805|United States of America|1\n1|476479943453198|34.023783|-84.720267|1|giscoregroup|United States of America|1\n1|448484620632638|-11.726523|-49.053692|2|guigandra|Brazil|2\n1|1529359558847986|59.242974|14.556041|0|bruno360|Sweden|0\n0|865625a9-c7c4-45ef-923b-6c594be5db61|-49.699211|-71.870578|2|Bastian Greshake Tzovara|Argentina|2\n1|851688147305190|7.102108|125.607337|4|kaart 360|Philippines|4\n1|1351657325949144|52.855057|-7.398671|0|annekaro|Ireland|0\n1|1177956669332805|29.631527|-81.523781|1|rking|United States of America|1\n1|907175450063824|59.833212|30.357639|4|trolleway|Russia|0\n1|529788604854081|26.293893|43.925069|3|ehabeid|Saudi Arabia|4\n0|fc8bd33b-7505-4ff9-ae7f-f18d799e763f|30.381599|-97.964790|1|DayGeckoArt|United States of America|1\n1|1685966718993238|46.089034|16.201111|0|infopgt|Croatia|0\n1|980236863533052|-29.958960|-71.305542|2|DNC|Chile|2\n1|1314700730795370|-12.823184|45.130082|3|SIG 3CO|France|0\n1|138032855214671|4.565952|-74.126237|2|sarahantos|Colombia|2\n1|579411266921191|2.041532|31.716024|3|federicodebetto|Uganda|3\n1|824178315771818|-0.544013|166.919195|5|flashkiwi|Nauru|5\n1|741013808881251|-15.800072|-48.058065|2|MuitoAlemdasFronteiras|Brazil|2\n1|534827085069029|5.268261|-4.006491|3|cign|Côte d’Ivoire|3\n1|3814497878730677|-36.735520|174.716997|5|ralley|New Zealand|5\n1|1910933463108980|59.645784|30.125807|4|catherinegautier|Russia|0\n1|783806136886894|-33.738457|150.284488|5|Wattle|Australia|5\n1|3703914476544814|-23.588447|-70.378827|2|Gduran|Chile|2\n1|393246876428316|-13.163609|-72.544477|2|jaderbavaresco|Peru|2\n1|212023387161775|59.291213|24.505588|0|jiipeefin|Estonia|0\n1|3012096975611901|48.724249|2.444822|0|Urbanisme Mobilites|France|0\n1|242353112203671|36.506959|-4.919122|0|bonhdg|Spain|0\n1|799112307387891|-28.909793|151.917401|5|flashkiwi|Australia|5\n1|3559232227516013|14.798942|-17.340050|3|laminendiaye|Senegal|3\n1|1569257843412069|33.937566|-4.988228|3|ismaeltthds|Morocco|3\n1|874402040172870|47.837139|3.573106|0|beat|France|0\n1|1248995723328662|-30.948823|19.432691|3|RuanZ|South Africa|3\n1|796968226436947|45.504530|141.892516|4|yuki charo|Japan|4\n1|869341493667007|55.848010|37.002152|4|trolleway|Russia|0\n1|1294975298920549|28.362574|-16.890723|3|trekviewed|Spain|0\n1|1008257883465162|49.179837|-123.941352|1|Mitchmiller|Canada|1\n1|374787051891051|-32.759139|152.167060|5|Eucalyptus|Australia|5\n1|1015093199875657|43.370621|45.631434|4|microfauna|Russia|0\n0|a7b4b2ef-ee34-431b-b2e4-f0a30cf12bde|53.955928|-1.090757|0|RichmondRob|United Kingdom|0\n1|3454738078003660|-0.617575|-72.384595|2|juanmelo|Colombia|2\n1|8490283117759240|45.488460|-73.751072|1|VdM|Canada|1\n1|1594263595024131|-45.257198|170.270511|5|skillsy|New Zealand|5\n1|171334832183424|-36.831721|-73.100648|2|Josebaeza|Chile|2\n1|533895517791370|34.016125|-4.974039|3|ismaeltthds|Morocco|3\n1|387476710324773|-29.417076|142.000131|5|Kangaroo|Australia|5\n1|1089315775076528|3.731761|34.859519|3|duncankebut|Kenya|3\n1|201516972260514|42.454547|-8.624328|0|sgonzalezd|Spain|0\n1|1042188931446206|-32.781585|26.827652|3|Infratec2025|South Africa|3\n1|513407756704919|9.432565|100.012955|4|garok|Thailand|4\n1|970065574830466|-8.348783|-74.586725|2|johnarupire|Peru|2\n1|1204824121569762|52.296150|5.331330|0|thewizard|Netherlands|0\n1|292312173641274|32.896229|-87.321459|1|jeffreymartin|United States of America|1\n1|659136956765896|-35.078482|138.496723|5|RandyXu|Australia|5\n1|4097853753641822|25.871824|48.813401|3|mahmoud12|Saudi Arabia|4\n1|1253587155897456|-33.436243|-70.631278|2|kaart 360|Chile|2\n1|3502396263269975|-12.143545|44.422138|3|Harsake|Comoros|3\n1|508370193853614|29.672370|-95.657118|1|microsoft|United States of America|1\n1|2509208062767412|50.898084|142.155225|4|jocem58265|Russia|4\n1|727973050391810|51.064574|17.361145|0|wwmajor|Poland|0\n1|944581947725351|52.792522|-67.104821|1|zombiegraph|Canada|1\n1|227095608794449|26.523675|-78.659345|1|steer360network|Bahamas|1\n1|437243268621637|54.061037|-124.568663|1|pavlohladysh|Canada|1\n1|947931064942646|-8.541836|115.325190|5|Kaart 360|Indonesia|4\n1|1693183617884426|13.435348|-16.689231|3|GambiaStreetView|Gambia|3\n1|3640561756237354|-32.140494|-56.113300|2|Kaart Local|Uruguay|2\n1|1283160126857187|-15.870758|-48.972930|2|helmert engenharia|Brazil|2\n1|1482461815958583|41.015870|-80.672676|1|gtaylor|United States of America|1\n1|1902814306549875|25.906064|-80.159145|1|microsoft|United States of America|1\n1|2018677939082236|-37.204025|145.504183|5|skillsy|Australia|5\n1|4289958301318381|49.630201|6.545773|0|Itsmerobinnn|Germany|0\n1|920953627145761|36.479893|29.112798|0|trekviewed|Turkey|4\n1|1315347162886400|57.354570|25.157533|0|richlv|Latvia|0\n1|335367637951577|45.826900|27.438844|0|bogdancandrea|Romania|0\n1|922076870453331|32.727476|-16.886444|3|geouma|Portugal|0\n1|928971405821590|-12.054616|-77.056994|2|kaart 360|Peru|2\n1|1141140254551063|39.220134|9.121903|0|mapconcierge|Italy|0\n1|128083043274939|59.081992|17.445494|0|bruno360|Sweden|0\n1|769266250621158|56.858500|33.459840|4|trolleway|Russia|0\n0|5bf211d4-7e02-4b9a-b0df-57d978510653|-43.545693|172.528037|5|chch parks|New Zealand|5\n1|1760554457965904|-26.547608|153.096630|5|LukeCWalton|Australia|5\n1|606458844083540|-33.967405|150.896261|5|alantgeo|Australia|5\n1|1973351689717459|-33.737938|143.014159|5|Kangaroo|Australia|5\n1|1719963749176566|59.166650|14.604150|0|bruno360|Sweden|0\n1|1061940142500617|40.845587|0.331538|0|meteolasenia|Spain|0\n1|323305585812353|56.843712|60.683101|4|trolleway|Russia|4\n1|841490864183618|45.666999|-106.632277|1|adamroads|United States of America|1\n1|1144608539807645|-11.719417|-49.099000|2|guigandra|Brazil|2\n1|583339941518757|-20.727113|-70.169090|2|Kaart Local|Chile|2\n1|1929154484112671|-26.472380|20.612446|3|photosofafrica|South Africa|3\n1|693417023728906|10.358361|123.949929|4|Kaart 360|Philippines|4\n1|3712302488902530|56.889677|24.072257|0|ursus|Latvia|0\n1|791749965586474|26.607437|101.785845|4|adirricor|China|4\n1|1938824736664594|-35.464366|174.246385|5|timwardWDC|New Zealand|5\n1|717377532831044|43.791890|6.422623|0|ccapv germain|France|0\n1|454582777044183|-36.949038|149.938197|5|Echidna|Australia|5\n1|3225467347778016|-43.099736|147.004464|5|aharvey|Australia|5\n1|320450846208364|9.768321|3.397325|3|michael212|Nigeria|3\n1|345147437897516|28.682286|77.049039|4|AkashHeliware|India|4\n1|1444963892607316|43.318999|16.995918|0|SilvioBasic|Croatia|0\n0|77440c4e-bc71-487a-b3f3-2e89e747927e|53.430231|14.550782|0|n8aktiver|Poland|0\n1|1825632747607769|39.213958|-104.873195|1|muntz man|United States of America|1\n1|143977744706898|43.270925|17.081151|0|SilvioBasic|Croatia|0\n1|602962202280051|40.142327|-96.665121|1|1335|United States of America|1\n1|2019939961762890|27.890867|85.549529|4|Nepal FRES|Nepal|4\n1|1016398110402964|-30.973943|22.146157|3|Infratec2025|South Africa|3\n1|1617186829084965|41.308201|42.487403|4|58zarali|Turkey|4\n1|1110713867385681|31.960670|-110.434000|1|rking|United States of America|1\n1|899086143137386|52.691308|4.814986|0|thewizard|Netherlands|0\n1|499179371951084|52.589534|9.055101|0|weseraue2022|Germany|0\n1|2847958338736501|6.181452|-75.608966|2|Itagui FN360|Colombia|2\n1|783407226964803|-13.511223|-71.984417|2|jaderbavaresco|Peru|2\n1|495961221723465|47.627888|-117.222311|1|cholloway|United States of America|1\n1|542349270951642|43.343827|45.656262|4|microfauna|Russia|0\n1|1156602061485551|-5.291303|39.802088|3|federicodebetto|Tanzania|3\n1|533742867639767|-17.348632|178.214350|5|flashkiwi|Fiji|5\n1|282557067680949|52.404814|23.820176|0|PesDyuck|Belarus|0\n1|837308518376966|-1.422833|-48.457735|2|mapconcierge|Brazil|2\n1|503808325345273|-0.615773|-72.383408|2|juanmelo|Colombia|2\n1|1049098036058130|-17.817500|-63.151015|2|kaart 2|Bolivia|2\n1|1197427688064968|-37.111024|149.916347|5|Echidna|Australia|5\n1|348287398124406|-32.818509|26.757408|3|Infratec2024|South Africa|3\n1|583934024386739|-1.488094|-48.452677|2|mapconcierge|Brazil|2\n1|2812008092338923|39.002214|-120.995324|1|marker geo1|United States of America|1\n1|787885518755107|-41.321561|148.249278|5|aharvey|Australia|5\n1|1591648198763432|55.748730|12.346350|0|neogeografen|Denmark|0\n1|1626083111831641|-5.683715|25.380038|3|bmitto|Democratic Republic of the Congo|3\n1|3463740793788731|-38.354595|144.764621|5|HIPA|Australia|5\n1|484620384394372|44.753888|19.660846|0|brackone|Serbia|0\n1|6194140264013883|-29.777762|151.110766|5|evilbunny|Australia|5\n1|491984402363298|49.618474|135.395856|4|niimostov|Russia|4\n1|1094461484560952|51.457689|71.834424|4|kazrap|Kazakhstan|4\n1|790804389713674|56.066817|-3.722399|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|436545661590428|-42.086199|145.611028|5|coreagc|Australia|5\n1|372329051031181|59.920698|10.824636|0|BYM OlaJuulHolm|Norway|0\n1|562200372931411|23.046040|72.530493|4|skysign|India|4\n1|465535399207087|2.034829|45.300997|3|adiiba25|Somalia|3\n1|2023221621442886|58.079355|24.499182|0|richlv|Estonia|0\n0|9b67fe04-da3d-4a83-8dfe-04a56505e499|44.239504|22.528364|0|BrackoNe|Serbia|0\n1|2534664603495792|38.476770|16.441423|0|marcuscalabresus|Italy|0\n1|1017743489848675|21.341558|39.938827|3|ehabeid|Saudi Arabia|4\n1|1066835818225924|-53.015879|-70.825648|2|jloaiza|Chile|2\n1|7021320054556155|37.691951|-77.602740|1|echostorm|United States of America|1\n1|315173571063980|18.800809|100.785396|4|SoT|Thailand|4\n1|908269828294650|-12.205130|44.466896|3|Harsake|Comoros|3\n1|766899557523820|13.464526|-16.669456|3|kmc streets|Gambia|3\n1|819259868715395|30.576045|-9.535625|3|afmk|Morocco|3\n0|40b0e892-6a8a-4e0c-86d6-f6cffcc54332|-29.213212|-66.011625|2|Bastian Greshake Tzovara|Argentina|2\n1|551037839212339|39.917704|116.390745|4|wsp us|China|4\n1|227991452023215|43.798294|-102.656572|1|penncohwy|United States of America|1\n1|1962070060608937|45.792322|-108.590177|1|chrisbeddow|United States of America|1\n1|3970104286551361|5.428028|6.484648|3|chowe ICT|Nigeria|3\n1|4584151151906297|45.598571|-62.637275|1|TNG Engineering|Canada|1\n1|715751483831359|-29.322850|142.167839|5|Kangaroo|Australia|5\n1|1138772941282816|48.864003|10.103526|0|RadNETZ|Germany|0\n1|2729366820749281|-41.883500|-73.660280|2|Gines Agurto|Chile|2\n1|196335132325208|18.796160|95.213540|4|taroo|Myanmar|4\n1|804595411045797|53.522812|-106.883779|1|boxer123|Canada|1\n1|527194565363205|55.742181|49.146298|4|kirillngeos|Russia|0\n1|642628247279255|51.584799|-115.315242|1|tomvh|Canada|1\n1|981104760504669|-39.816052|-73.255411|2|SolutivaSistemas|Chile|2\n1|2281110175401414|-16.167994|31.203922|3|osunga|Zimbabwe|3\n1|256934164096238|-11.840287|-61.885115|2|jaderbavaresco|Brazil|2\n1|300784974785690|-10.088898|148.631425|5|jthnz|Papua New Guinea|5\n1|807428254292717|-8.559444|125.555611|5|NOD|Timor-Leste|4\n1|2866935763623128|-41.322939|148.249544|5|aharvey|Australia|5\n1|2032382177697792|-0.066611|34.384067|3|bmitto|Kenya|3\n1|561671303488635|-36.124645|144.786347|5|Kangaroo|Australia|5\n1|504285172156975|7.694672|134.631717|4|hokiangahick|Palau|5\n1|1142553846928205|40.436642|-111.890951|1|rking|United States of America|1\n1|2195536400932750|-0.874425|119.834598|5|benjidad|Indonesia|4\n1|1443463667550345|49.112143|105.375907|4|wata909|Mongolia|4\n1|426468109547181|26.800299|100.497414|4|adirricor|China|4\n1|218866451216853|-1.831685|30.078699|3|dpu transport|Rwanda|3\n1|306548801517059|53.395093|-2.915830|0|markagreen14|United Kingdom|0\n1|699049835272933|-28.623563|29.698617|3|ovvio|South Africa|3\n1|328638186416921|28.682231|77.036275|4|AkashHeliware|India|4\n1|232060055498285|59.835010|8.384605|0|catoandersen|Norway|0\n1|1516424866261232|-35.534303|174.231390|5|timwardWDC|New Zealand|5\n1|402198428887695|-30.283846|150.085371|5|Wallaby|Australia|5\n1|1185811916726534|-30.811185|-71.580433|2|Kaart Local|Chile|2\n1|2467982433651186|40.923033|29.309127|0|burakonder|Turkey|4\n1|585006529318877|-15.921299|145.351254|5|coreagc|Australia|5\n1|989017470169425|40.581947|-124.135591|1|marker geo1|United States of America|1\n1|1139045444923957|-32.701376|26.290345|3|Infratec2025|South Africa|3\n1|2287250734943276|25.015853|-77.342684|1|dpu transport|Bahamas|1\n1|209610868404752|48.964089|-122.224850|1|networklanman|United States of America|1\n1|1127760419053580|41.139012|-101.187326|1|quickness805|United States of America|1\n0|c09751ad-47ff-42e1-ab5d-d0c0acf69615|-2.231545|-78.796450|2|Hopen111|Ecuador|2\n0|e2dbf91a-ff43-4dfc-9c4a-444fe9437e7b|10.368785|123.873682|4|amcrepin|Philippines|4\n1|799261631024251|55.631638|51.810691|4|ngeos|Russia|0\n1|825541742025052|9.822098|3.366137|3|michael212|Benin|3\n1|2361015961041964|36.530224|10.837065|0|slaheddinefateh|Tunisia|3\n0|f694a789-1c0b-4835-9828-c18fa85da0de|38.709764|-78.331283|1|slinky309|United States of America|1\n1|460332861705062|49.508065|-99.156775|1|spread8|Canada|1\n1|502464864676546|-5.116904|39.809942|3|federicodebetto|Tanzania|3\n1|2834727283461446|-9.574131|147.368479|5|jthnz|Papua New Guinea|5\n1|800411964242828|31.636482|-8.012822|3|navcities|Morocco|3\n1|2203525440390215|35.219877|-106.410874|1|Hikerandy|United States of America|1\n1|475695793639042|45.480112|6.299585|0|serfim cit y|France|0\n1|1377526333543518|-34.302410|146.038347|5|zebjohnson|Australia|5\n1|929509051197967|39.537606|-106.391971|1|stilldavid|United States of America|1\n1|397583169487831|13.500057|144.803247|4|Power01|Guam|5\n1|2136004937164093|-45.282302|170.281098|5|skillsy|New Zealand|5\n1|1000080697467239|58.196677|50.794666|4|gluhov55|Russia|0\n1|1170928138231484|8.145113|-72.547361|2|KingRam|Colombia|2\n1|4565873470316758|18.602834|73.795879|4|skysign|India|4\n1|711804867755038|37.887384|-1.359044|0|AdgobaAlvac|Spain|0\n1|561483270131141|51.011100|-4.434632|0|trekviewed|United Kingdom|0\n1|592037732807458|39.156061|-91.905375|1|hmhtb|United States of America|1\n1|835996025089095|52.796709|-67.081982|1|zombiegraph|Canada|1\n1|1891352331329084|-32.538776|152.316848|5|Eucalyptus|Australia|5\n1|1312024203752344|-16.529841|-40.177124|2|MuitoAlemdasFronteiras|Brazil|2\n1|496398312640680|37.455661|121.601558|4|recklessxpy|China|4\n1|2341422172951378|50.031674|10.506348|0|ZXStreetview|Germany|0\n1|1014962905913855|-12.634091|143.425112|5|coreagc|Australia|5\n1|1411103373002239|-22.482254|-68.930028|2|Kaart Local|Chile|2\n1|138829728232998|53.385804|83.728142|4|quadrotest|Russia|4\n1|1209803791044177|-20.929594|-54.964524|2|guigandra|Brazil|2\n1|112635127563111|-43.307661|171.434181|5|spectrestudios|New Zealand|5\n1|1171569724997272|-36.475396|174.603033|5|bede|New Zealand|5\n1|2394920444236762|43.903329|22.287678|0|brackone|Serbia|0\n1|760972042965537|6.859991|79.869796|4|gazaly|Sri Lanka|4\n1|618365241014067|-6.872050|39.260176|3|OMDTZ1|Tanzania|3\n1|1505690234131797|-3.080061|37.422343|3|trekviewed|Tanzania|3\n1|3291048584358533|-31.967983|-56.039943|2|Kaart Local|Uruguay|2\n1|587202306513711|-28.531206|29.779372|3|ovvio|South Africa|3\n1|899909602498213|4.054278|9.700918|3|keke|Cameroon|3\n1|543694716897425|40.875631|29.266398|0|ademturkmen|Turkey|4\n1|983035019795114|6.874915|-58.338409|2|mystershaw|Guyana|2\n1|803712477209884|38.740105|-9.300167|0|pt360|Portugal|0\n1|2642553662814106|46.338013|-96.197240|1|milk man|United States of America|1\n1|1622867672161308|-18.954106|-47.264664|2|MuitoAlemdasFronteiras|Brazil|2\n1|212127247134992|55.824705|21.123075|0|lakd|Lithuania|0\n1|418783374616145|40.925416|-96.510862|1|quickness805|United States of America|1\n1|717889096619516|-36.880719|-73.138705|2|Josebaeza|Chile|2\n1|1017358620722071|41.036050|-123.873167|1|marker geo1|United States of America|1\n1|3318358108319576|48.402319|106.201805|4|wata909|Mongolia|4\n1|523127485376726|43.903333|103.525000|4|l1ndemann|Mongolia|4\n1|654620806927472|6.033107|80.214928|4|gazaly|Sri Lanka|4\n1|1185558408574711|28.328596|-16.877884|3|javiersanp|Spain|0\n1|338666444489924|29.242558|48.094307|3|alotaibiuop|Kuwait|4\n0|b5a285f9-2efb-43b0-9edb-714ce153530a|-41.236260|174.979461|5|JokerNZ|New Zealand|5\n1|499470408156108|57.735094|59.864304|4|moltgeo|Russia|0\n1|2418033491994936|-16.542544|-39.880834|2|MuitoAlemdasFronteiras|Brazil|2\n1|526069675991160|51.536786|-115.357435|1|tomvh|Canada|1\n1|980274712776306|29.330315|48.011794|3|takethebuskw|Kuwait|4\n1|8807002502704546|42.813034|-78.723499|1|rking|United States of America|1\n1|409689601989879|-37.157725|-72.660573|2|Kaart Local|Chile|2\n1|3258417921000483|8.484507|-13.246353|3|Jborg88|Sierra Leone|3\n1|661675751807863|36.486545|-4.989775|0|jcpablo|Spain|0\n1|923379057011209|33.069852|10.228317|3|ayoubbenhcin|Tunisia|3\n1|763039804688247|-17.830838|177.731652|5|flashkiwi|Fiji|5\n1|1280438100643528|-17.067324|145.748750|5|xnoise|Australia|5\n1|540469128337011|13.414238|-16.661041|3|GambiaStreetView|Gambia|3\n1|924848302681528|-29.088071|141.214075|5|Kangaroo|Australia|5\n1|1280662099176141|49.137105|-123.807362|1|Mitchmiller|Canada|1\n1|1592549658223905|-26.754371|152.568313|5|flashkiwi|Australia|5\n1|1544908156147518|39.987473|-86.079231|1|opsstreetscan|United States of America|1\n1|1397927767247708|42.448744|-73.259008|1|msingh|United States of America|1\n1|1432759435286689|-19.218414|-46.014877|2|MuitoAlemdasFronteiras|Brazil|2\n1|1445777259539489|-4.782609|-40.075502|2|Amplomap360|Brazil|2\n1|1679170443493704|-35.391590|-62.423555|2|Ale011988|Argentina|2\n1|663356641141628|18.305768|42.726657|3|ehabeid|Saudi Arabia|4\n1|760073475296149|17.574371|120.388266|4|srdpmapping|Philippines|4\n1|812238426096651|40.828039|-115.747946|1|rking|United States of America|1\n1|147780077328725|31.597393|-8.028404|3|navcities|Morocco|3\n1|1058711969060647|-20.271158|-70.093712|2|Shirley1|Chile|2\n1|799000362524065|-37.795257|145.142514|5|dkazemi1364|Australia|5\n1|925828699362543|-33.382465|18.378285|3|RuanZ|South Africa|3\n1|1194798312559360|-29.398693|-53.001336|2|jaderbavaresco|Brazil|2\n1|4634083513319922|55.022655|51.775469|4|ngeos|Russia|0\n1|519086882796356|56.814748|24.591722|0|mednis|Latvia|0\n1|509937420182556|6.457409|3.411000|3|moriwo|Nigeria|3\n1|1305689828356324|-16.434814|-54.625996|2|PMR|Brazil|2\n1|1102849869358907|45.503342|-97.837163|1|GIS ISG|United States of America|1\n1|181945854182139|-26.494741|27.496652|3|infratec|South Africa|3\n1|143130522039162|-29.018999|167.958282|5|flashkiwi|Norfolk Island|5\n1|3812589108875984|-16.160725|30.558403|3|Tadiwamachisi|Zimbabwe|3\n1|1504091776924913|38.244759|48.302859|4|58zarali|Iran|4\n1|371121764857078|46.293135|16.322499|0|geoprem|Croatia|0\n1|170980984948259|26.100016|-80.230390|1|microsoft|United States of America|1\n1|1247371132831861|13.472118|144.709458|4|flashkiwi|Guam|5\n1|322748432585168|54.580650|100.564132|4|moltgeo|Russia|4\n1|8280027452061027|-26.714015|153.054255|5|LukeCWalton|Australia|5\n1|1712667989490525|-0.335705|36.056377|3|danbomett|Kenya|3\n1|1046306106541898|51.775948|55.567832|4|armaz|Russia|0\n1|1964055957743892|46.645802|-70.363870|1|michelcouturemotomcm|Canada|1\n1|1314581832540656|-32.763196|152.145336|5|Eucalyptus|Australia|5\n1|1079995414327956|56.286178|8.427153|0|peterleth|Denmark|0\n1|151639520263042|13.459030|-16.661082|3|kmc streets|Gambia|3\n1|754243208597792|33.534182|-102.004240|1|rking|United States of America|1\n1|1064275134695372|-31.281674|142.296306|5|Kangaroo|Australia|5\n1|1567816857387301|-11.674055|-61.187544|2|jaderbavaresco|Brazil|2\n1|820651515501872|-42.803592|147.443361|5|michaelroach|Australia|5\n1|1666180614569741|-45.829135|170.593124|5|skillsy|New Zealand|5\n1|892451991330674|31.046371|-8.394563|3|sige|Morocco|3\n1|1314073649495772|-2.089385|-79.933462|2|kaart 2|Ecuador|2\n1|838635716860788|41.824163|-72.885842|1|ctroadway360|United States of America|1\n1|684629232256430|29.747513|-95.430168|1|microsoft|United States of America|1\n1|649751413476543|-17.822180|-63.219891|2|kaart 2|Bolivia|2\n1|1121070636555571|25.250123|55.344435|4|FalconUae|United Arab Emirates|4\n1|429388929863972|-37.104591|149.951392|5|Echidna|Australia|5\n1|1279934940418804|58.889236|17.919190|0|bruno360|Sweden|0\n0|fe63b0a3-ae07-46e2-8742-92541e8b56c0|-43.741107|-69.996961|2|Bastian Greshake Tzovara|Argentina|2\n1|338656790944848|32.393068|-96.845562|1|aboynton|United States of America|1\n1|3378622295690091|46.339252|-85.708915|1|networklanman|United States of America|1\n1|927058788095527|37.002830|-79.898429|1|rking|United States of America|1\n1|2151128808731963|-27.441318|-55.863261|2|santiagoperalta|Argentina|2\n1|906572441146834|3.910854|11.490181|3|asturksever|Cameroon|3\n1|977715930915594|46.398271|13.180197|0|Protezione Civile FVG Ri|Italy|0\n1|1477615740665183|-8.362999|-63.422084|2|jaderbavaresco|Brazil|2\n1|831959508864004|-32.008131|152.566196|5|Eucalyptus|Australia|5\n1|1378639844116555|-41.393805|174.875156|5|PhillCook|New Zealand|5\n1|1189274781872580|-41.264648|-72.996831|2|Kaart Local|Chile|2\n1|2377967775925058|-13.525019|-71.972320|2|jaderbavaresco|Peru|2\n1|880794637217660|-6.816831|39.251703|3|OMDTZ1|Tanzania|3\n1|2863932227188360|57.918543|12.526406|0|akom|Sweden|0\n1|814254312514554|-1.931003|28.931597|3|tojoaro|Democratic Republic of the Congo|3\n1|969943127887834|43.518360|-0.919332|0|sogefi|France|0\n1|5019700994744050|46.317405|6.961439|0|epoc|Switzerland|0\n1|385746364557779|-8.271831|-74.650703|2|johnarupire|Peru|2\n1|638620589160056|40.643577|0.238191|0|meteolasenia|Spain|0\n1|339695611202500|-41.359134|147.412083|5|coreagc|Australia|5\n1|387519536158141|38.480112|16.407759|0|marcuscalabresus|Italy|0\n1|1912630739860823|40.216873|28.875323|0|burakonder|Turkey|0\n1|622142113265169|-2.184233|-79.893391|2|kaart 2|Ecuador|2\n1|297539796031609|-0.503597|166.943167|5|flashkiwi|Nauru|5\n1|1009081936500078|56.909672|59.945739|4|urbanresearch|Russia|0\n1|1680533782336243|42.268883|-88.855176|1|rking|United States of America|1\n1|2176678735855832|-35.970104|147.004903|5|radiotrefoil|Australia|5\n1|8772847882831528|-46.154695|-72.182526|2|Kaart Local|Chile|2\n1|1598882124318591|7.813550|6.061239|3|Newwaves123|Nigeria|3\n1|1103769436790503|21.163232|94.873016|4|mghla|Myanmar|4\n1|623859755850121|5.173291|5.706873|3|michael212|Nigeria|3\n1|398508099412079|-41.352985|-73.043807|2|Constanzavr|Chile|2\n1|315438516841911|38.925397|-77.002932|1|nupano|United States of America|1\n1|1356808736136339|-27.831282|153.025969|5|ianstephenson|Australia|5\n1|372750157513450|31.897648|35.218761|3|360ms|Palestine|4\n1|897890184956960|51.577553|74.380423|4|kazrap|Kazakhstan|4\n1|1329122805183468|-8.790019|120.172486|5|rgtm ryuiki|Indonesia|4\n1|1695068861408106|28.593357|-81.476032|1|rking|United States of America|1\n1|1220845253403116|25.728282|84.506134|4|balu geo|India|4\n1|264890536711413|36.585701|44.443316|4|flashkiwi|Iraq|4\n1|2098422003859041|-8.370846|-74.568680|2|johnarupire|Peru|2\n1|1634883687429673|27.836806|85.568542|4|Nepal FRES|Nepal|4\n1|1363532161021567|-26.358018|27.371896|3|Infratec2024|South Africa|3\n1|998191683156131|-34.174437|22.118001|3|Mossel Bay Municipality|South Africa|3\n1|2088879218508308|-8.474527|119.903749|5|engelbertus|Indonesia|4\n1|607665835039168|-17.657303|177.812886|5|flashkiwi|Fiji|5\n1|344830307251447|37.237275|140.998778|4|ryosatake527|Japan|4\n1|304064174533666|-18.040207|177.552266|5|flashkiwi|Fiji|5\n1|1085920440367637|51.494784|11.975724|0|MarcAurel2|Germany|0\n1|1217553970542478|49.155487|102.826260|4|wata909|Mongolia|4\n1|1281492957435163|-34.050846|22.232019|3|Mossel Bay Municipality|South Africa|3\n1|1277250884425165|5.878171|-55.097666|2|ost360vr Joscelin|Suriname|2\n1|196072406184398|-34.023236|151.066317|5|radiotrefoil|Australia|5\n1|806518403636332|-4.298064|-55.959109|2|comtacti|Brazil|2\n1|3975583145859871|39.657846|118.187536|4|comradely|China|4\n1|1542642360175643|7.803698|-72.224323|2|rolandovasq|Venezuela|2\n1|938153252427964|-42.364212|-73.723444|2|Gines Agurto|Chile|2\n1|125263862924086|34.628319|50.897317|4|ammarpak|Iran|4\n1|307489997521411|47.667846|-117.292401|1|amidave|United States of America|1\n1|1055270151856520|58.849961|5.719849|0|catoandersen|Norway|0\n1|3850646691903962|7.006375|100.490656|4|PMU B|Thailand|4\n1|279315240544521|59.394390|5.306003|0|catoandersen|Norway|0\n1|1179949384353254|-19.138481|33.482693|3|renaldoflor|Mozambique|3\n1|151180834078638|40.064845|-86.128574|1|opsstreetscan|United States of America|1\n1|1661483354984095|34.461524|8.098442|3|amorToun|Tunisia|3\n1|310846297358466|45.418789|-76.366669|1|msingh|Canada|1\n1|575360408434418|28.618549|-106.092197|1|GISCUU|Mexico|1\n1|548012747912617|51.326042|-68.122287|1|zombiegraph|Canada|1\n1|1191130484875970|44.770028|-0.750306|0|bricev|France|0\n1|1965029814120441|-25.256835|-54.038857|2|ANTT|Brazil|2\n1|184766630174577|-42.807358|147.434992|5|michaelroach|Australia|5\n1|479271357913309|52.514174|-106.413955|1|boxer123|Canada|1\n0|29eb083a-a34a-4dbe-bd51-162a52d5b746|5.411567|100.345036|4|ZX Streetview|Malaysia|4\n1|815256844085508|-20.344575|148.950883|5|HIPA|Australia|5\n1|3223256531337432|26.184372|-97.698600|1|rking|United States of America|1\n1|928963470979293|35.795729|-78.630496|1|jcaruso|United States of America|1\n1|1310787566965115|33.093710|-16.303340|3|filipesilva|Portugal|0\n1|851687457788458|-16.393239|-40.226376|2|MuitoAlemdasFronteiras|Brazil|2\n1|498613918272981|56.511218|66.541373|4|kotkota15|Russia|4\n1|969650685334193|56.386523|9.607763|0|jenspeterhansen|Denmark|0\n1|765446755212914|-2.201493|-79.891649|2|kaart 2|Ecuador|2\n1|183881346977993|41.421477|-95.862832|1|pottawattamie|United States of America|1\n1|160105336062725|-22.236391|166.475513|5|flashkiwi|New Caledonia|5\n1|1038982914172279|54.675600|25.281836|0|vms|Lithuania|0\n1|577566025247390|51.449164|-98.585436|1|DariusP|Canada|1\n1|396711469433694|-13.150389|-72.521031|2|jaderbavaresco|Peru|2\n1|2051446015024603|46.891219|-124.109229|1|uwrapid|United States of America|1\n1|857186310736753|-34.039417|22.217327|3|Mossel Bay Municipality|South Africa|3\n1|518841422606045|29.731255|-95.386313|1|microsoft|United States of America|1\n1|812024210470673|31.342698|-109.545632|1|rking|United States of America|1\n1|1483075562865940|39.071894|-3.249441|0|AdgobaAlvac|Spain|0\n1|698744119794281|36.546476|-76.189803|1|vorpalblade|United States of America|1\n1|1292972381996489|43.460277|-0.726343|0|sogefi|France|0\n1|1324969279683915|5.281117|100.241125|4|ZXStreetview|Malaysia|4\n1|1032823954221191|32.790325|35.020809|3|trigSkarim|Israel|4\n1|2217740748699844|50.510765|-63.251356|1|CorenitnL|Canada|1\n1|481626478097536|40.969110|-90.374980|1|hmhtb|United States of America|1\n1|963199178456946|35.524321|-90.426566|1|Mosaic51 Dylan|United States of America|1\n1|1420753388999436|43.813927|145.068223|4|rgtm ryuiki|Japan|4\n1|2372425899792391|38.028767|23.855124|0|cedionysis|Greece|0\n1|1145007190178486|11.266152|107.569070|4|LANG THANG KHAP PHO|Vietnam|4\n1|750832208958447|-20.011780|148.225888|5|esriau 1topo|Australia|5\n1|847353499190471|-35.074264|138.497779|5|unisageoscience|Australia|5\n1|773655570005607|25.550084|-103.517913|1|innerpace360|Mexico|1\n1|531426876521040|-20.263557|-70.105093|2|Shirley1|Chile|2\n1|793010610384763|-0.916999|119.895094|5|benjidad|Indonesia|4\n1|8283315798418564|-36.984218|174.870225|5|ralley|New Zealand|5\n1|2229519387555254|-26.399560|-54.389398|2|santiagoperalta|Argentina|2\n1|2149759705876257|-11.436293|-61.472001|2|jaderbavaresco|Brazil|2\n1|1362294476003812|-16.196143|-40.467349|2|MuitoAlemdasFronteiras|Brazil|2\n1|1294308389542181|-8.624251|115.170166|5|Kaart 360|Indonesia|4\n1|1105885094621910|-20.611507|-52.392025|2|jaderbavaresco|Brazil|2\n1|3687717778194538|-2.910854|-78.985613|2|Hopen111|Ecuador|2\n1|792754954949171|-33.951936|151.016775|5|alantgeo|Australia|5\n1|3631838773718107|-0.551922|166.936171|5|flashkiwi|Nauru|5\n1|506897782382183|-23.018709|-50.024253|2|ANTT|Brazil|2\n1|1163359654086616|55.876691|21.421292|0|lakd|Lithuania|0\n1|552682384554835|21.373550|39.804416|3|ehabeid|Saudi Arabia|4\n1|1397547034164526|4.082265|-72.954080|2|juanmelo|Colombia|2\n1|274547078291587|33.562995|-81.700694|1|pdorrohcityofaikensc|United States of America|1\n1|1119710645537434|59.853632|10.657889|0|NesoddenKommuneSamferdse|Norway|0\n1|1536386236710611|53.269347|0.320436|0|lennartvdhorst|United Kingdom|0\n1|295057779886403|-10.586700|142.221512|5|flashkiwi|Australia|5\n1|1105329970004611|51.648678|35.940296|4|tereshhenko55|Russia|0\n1|1575745956513088|-16.322952|30.896438|3|Kennedy Jomokela|Zimbabwe|3\n1|8635161713238145|27.809522|86.722448|4|gallimaps|Nepal|4\n1|1044215826742703|48.996675|-123.808783|1|Mitchmiller|Canada|1\n1|1029174446344805|48.040794|106.904428|4|wata909|Mongolia|4\n1|168903042402228|-30.009650|-71.339582|2|rodolfohcp|Chile|2\n1|1064212244128646|-5.186552|39.766840|3|federicodebetto|Tanzania|3\n1|962576064913408|40.342622|-3.742464|0|skfd|Spain|0\n1|286082120713199|-10.583530|142.211559|5|flashkiwi|Australia|5\n1|1110286367823757|56.948654|23.904931|0|ursus|Latvia|0\n1|451947832546575|14.785328|-17.318353|3|ismailaseye|Senegal|3\n1|317032794113260|-22.780323|-41.901633|2|360|Brazil|2\n1|831144144433574|38.486035|16.461339|0|marcuscalabresus|Italy|0\n1|813315987335630|52.441169|-106.480020|1|boxer123|Canada|1\n1|734510415450187|45.289159|-87.005998|1|tonypd|United States of America|1\n1|383022143047723|24.983293|55.107360|4|wassaf|United Arab Emirates|4\n1|3702994063246376|14.604709|121.026561|4|kaart 4|Philippines|4\n1|318595483113591|32.144678|35.494849|3|360ms|Palestine|4\n1|519124977178843|-33.752677|151.194158|5|Possum|Australia|5\n1|184755804176725|41.195813|-73.413252|1|ctroadway360|United States of America|1\n1|485529176118178|37.523853|-122.252785|1|crabkilla|United States of America|1\n1|1113744984016239|-37.248460|-73.320433|2|ccb|Chile|2\n1|1268505566987344|55.837072|37.314867|4|Krasnogorsk360|Russia|0\n1|1320571180189899|53.968847|-78.981132|1|michelcouturemotomcm|Canada|1\n1|226571807163008|13.469358|144.800294|4|Power01|Guam|5\n1|2144164876093024|54.615200|18.495841|0|Atemiki|Poland|0\n1|792730500404404|-0.897357|119.885624|5|benjidad|Indonesia|4\n1|476242130134213|-47.748083|-65.894621|2|jpabloroots|Argentina|2\n1|893341089205726|-32.005535|115.895133|5|radiotrefoil|Australia|5\n1|3984075408530430|-9.171464|147.187755|5|PNGDOWH|Papua New Guinea|5\n1|1151443681949047|56.039256|14.161684|0|kristianstad|Sweden|0\n1|3906901796267169|4.696978|-74.050125|2|krojasSDM|Colombia|2\n1|1217606460447227|32.857709|-17.157671|3|geouma|Portugal|0\n1|2082910809105204|52.659784|-7.268396|0|annekaro|Ireland|0\n1|3900318836670885|28.935604|-13.817909|3|javiersanp|Spain|0\n1|537561665914602|41.167890|-92.916707|1|Hopen111|United States of America|1\n1|1101723418536141|-16.090419|-48.069672|2|helmert engenharia|Brazil|2\n1|821782960265488|-27.130063|-70.802184|2|Transporte DSS|Chile|2\n1|691589183275234|25.220253|82.878375|4|subhash geo|India|4\n1|2417666458401444|-26.628903|27.979073|3|Infratec2023|South Africa|3\n1|1130542152443678|40.815253|0.524899|0|mcd3|Spain|0\n1|2624900114482372|31.983145|131.482055|4|kojiroucircle|Japan|4\n1|253317539801477|-19.776005|-43.392108|2|Amplomap360|Brazil|2\n1|1237018667928552|49.186887|102.875173|4|wata909|Mongolia|4\n1|878519966069494|39.832216|-84.907886|1|arudir|United States of America|1\n1|1219047655520492|-31.478437|22.347666|3|infratec|South Africa|3\n1|505649239042532|-6.815942|39.286746|3|OMDTZ1|Tanzania|3\n1|203827595337817|13.825384|100.080073|4|NAKHONPATHOM CITY STREET|Thailand|4\n1|4692675820762519|55.765196|49.232594|4|arturngeos|Russia|0\n1|739051115228860|-35.706963|174.128161|5|timwardWDC|New Zealand|5\n1|389476720896819|-29.720738|-50.195028|2|jaderbavaresco|Brazil|2\n1|103349789085248|1.542051|32.037391|3|federicodebetto|Uganda|3\n1|650794949578587|46.864727|-124.100967|1|uwrapid|United States of America|1\n1|1368629161261200|8.470584|-13.246315|3|Aliebvandy|Sierra Leone|3\n1|1046128277729326|51.321776|-114.983795|1|ContraBand|Canada|1\n1|874960016403152|32.855196|-17.213290|3|nunocaldeira|Portugal|0\n1|2694432344050007|45.020206|19.816548|0|borovac|Serbia|0\n1|196316712378840|47.641551|-117.204173|1|cholloway|United States of America|1\n1|943306919776959|30.597084|-9.508991|3|afmk|Morocco|3\n1|225185862325321|2.964559|24.140854|3|tojoaro|Democratic Republic of the Congo|3\n1|418571583588576|19.130556|72.874056|4|tranzitnotes|India|4\n1|192476550201112|-0.078632|-78.438869|2|kaart 2|Ecuador|2\n1|2127413360959370|-32.590011|152.270597|5|Eucalyptus|Australia|5\n1|1089166292169340|32.759810|-16.788477|3|geouma|Portugal|0\n1|936396575541221|-41.137178|175.189194|5|PhillCook|New Zealand|5\n1|1712429266451660|-8.604605|115.320015|5|Kaart 360|Indonesia|4\n1|1362969801455112|50.907747|142.178170|4|jocem58265|Russia|4\n1|479564583294127|28.882191|48.228564|3|takethebuskw|Kuwait|4\n1|1416152866811241|-8.810784|-63.857202|2|jaderbavaresco|Brazil|2\n1|113079575117607|52.388379|23.835323|0|PesDyuck|Belarus|0\n1|581572316583485|-25.468596|-56.019506|2|tyraayala|Paraguay|2\n1|963664738297001|38.750626|-9.168920|0|filohipo|Portugal|0\n1|164934768896912|26.290331|43.924851|3|ehabeid|Saudi Arabia|4\n1|633873501277945|-34.417822|19.164984|3|gertcb|South Africa|3\n1|985964270612537|-16.822340|-49.905458|2|helmert engenharia|Brazil|2\n1|2528856344233203|-9.526118|-35.781232|2|viniciusmap|Brazil|2\n1|526341558651513|45.189935|-109.246604|1|chrisbeddow|United States of America|1\n1|1175936297771361|44.865259|20.644253|0|brackone|Serbia|0\n1|1529718048013999|56.487839|84.952997|4|Fedor 1|Russia|4\n1|1243812609602166|-17.402061|-66.070536|2|kaart 2|Bolivia|2\n1|516918030694785|39.246877|-9.312861|0|waldyrious|Portugal|0\n1|313423643572758|-42.682406|146.716866|5|aharvey|Australia|5\n1|1428516984897810|36.016023|14.336162|0|richlv|Malta|0\n1|444993951431347|-10.019948|147.725424|5|PNGDOWH|Papua New Guinea|5\n0|8b35b57a-1674-41d5-92d0-49934a43cf4e|43.569671|22.265730|0|BrackoNe|Serbia|0\n1|132742955493974|44.610849|-76.224166|1|amidave|Canada|1\n1|1316913806044139|-35.047507|138.507722|5|RandyXu|Australia|5\n1|968211110617021|59.939520|30.342865|4|vlivyur|Russia|0\n1|5427077267367109|31.351203|-7.607950|3|sige|Morocco|3\n1|187581083716943|44.915280|-67.007780|1|rking|United States of America|1\n1|1090277828049238|39.066426|-106.400330|1|stilldavid|United States of America|1\n1|754985962427142|-25.159197|29.386827|3|gertcb|South Africa|3\n1|504478253900580|11.204328|125.011113|4|arc ttl|Philippines|4\n1|642383641010094|48.337211|69.712769|4|kazrap|Kazakhstan|4\n1|1152644019175996|55.288956|11.230697|0|jenspeterhansen|Denmark|0\n1|294971969714674|40.880937|-96.682503|1|vorpalblade|United States of America|1\n1|1622100729559611|48.877451|-64.555377|1|CorenitnL|Canada|1\n1|3165991070302534|35.739683|51.945828|4|behzad62elahi|Iran|4\n1|1502531297066819|25.036769|-77.351081|1|dpu transport|Bahamas|1\n1|1747510582433840|42.244897|42.759805|4|bumbeishvili|Georgia|4\n1|3934170686879392|36.469981|29.105560|0|trekviewed|Turkey|4\n1|1389367339571163|41.043332|-111.948702|1|flug32|United States of America|1\n1|1982604408746758|-28.617547|20.349191|3|photosofafrica|South Africa|3\n1|814194154705925|7.094118|125.627852|4|kaart 360|Philippines|4\n1|1724055098203030|-36.121561|174.570185|5|ralley|New Zealand|5\n1|978126279623536|-17.383776|178.160135|5|flashkiwi|Fiji|5\n1|1260636986232978|-11.497223|-61.373593|2|jaderbavaresco|Brazil|2\n1|829934041347435|-28.743519|20.999656|3|photosofafrica|South Africa|3\n1|1425878418507244|36.545058|29.133853|0|trekviewed|Turkey|4\n1|1495784884571516|-8.546909|125.549388|5|micheldavitt|Timor-Leste|4\n1|1147135349780679|-8.567778|125.548139|5|NOD|Timor-Leste|4\n1|25082072394754430|-19.116382|33.472289|3|renaldoflor|Mozambique|3\n1|462611108159627|30.315787|-95.752002|1|microsoft|United States of America|1\n1|4044584075855589|33.403458|-111.874701|1|mycota|United States of America|1\n1|820968528828591|56.284705|43.980209|4|shipovnick|Russia|0\n1|1327933239322194|57.008260|24.164471|0|richlv|Latvia|0\n1|1234047141107771|52.036238|23.107980|0|farmer798|Poland|0\n1|458103949618792|3.740719|34.816007|3|duncankebut|Kenya|3\n1|2346246292472012|56.455262|67.669856|4|catherinegautier|Russia|4\n1|1707618573420675|-28.423195|-48.799280|2|jaderbavaresco|Brazil|2\n1|830122171820163|36.278280|29.384830|0|asturksever|Turkey|4\n1|1344640531199372|52.508043|13.405613|0|supaplex030|Germany|0\n1|855901818673177|50.993204|4.260902|0|vansteelandt|Belgium|0\n1|118471023630182|51.050724|3.712294|0|vansteelandt|Belgium|0\n1|1143573247033355|43.617701|-116.398340|1|marker geo|United States of America|1\n1|660440923757926|-3.803222|39.832028|3|GetFound Africa|Kenya|3\n1|917480163470834|8.997668|-79.519660|2|kaart5|Panama|1\n1|1438150788024428|-45.392265|-72.694713|2|Antoniam|Chile|2\n1|1509753883227623|-6.782988|39.228321|3|OMDTZ1|Tanzania|3\n1|1047126847162222|-41.132912|175.243519|5|nboland|New Zealand|5\n1|786842623698137|-30.345113|21.821674|3|Infratec2025|South Africa|3\n1|937820618531246|-12.712095|45.052541|3|geodzer|France|0\n1|219449246286071|25.614282|-80.377374|1|microsoft|United States of America|1\n1|1300592762256457|41.064243|-124.136264|1|marker geo1|United States of America|1\n1|853123085291505|-12.713705|143.287429|5|coreagc|Australia|5\n1|918114595697340|46.875361|-124.103216|1|uwrapid|United States of America|1\n1|991309930466059|-7.805655|-77.886740|2|GMINGENIEROS|Peru|2\n1|1421322045752740|25.768819|84.488356|4|vishalneogeo|India|4\n1|1300337607256604|-38.024738|-72.412629|2|Kaart Local|Chile|2\n1|1953820388577718|-41.277701|174.949065|5|PhillCook|New Zealand|5\n1|1149721379460640|51.771911|55.576586|4|armaz|Russia|0\n1|249180511590430|26.310116|50.209894|4|mahmoud12|Saudi Arabia|4\n1|1214074322383848|38.997122|68.767035|4|kavinda|Tajikistan|4\n1|3649080355306240|50.286675|8.947805|0|tmka|Germany|0\n1|4212374455713881|47.683657|-122.385324|1|tannewt|United States of America|1\n1|2826758670881095|40.851235|-115.795178|1|rking|United States of America|1\n1|463169654971897|51.211460|58.296946|4|okhtis|Russia|0\n1|732661621160252|14.006033|100.701152|4|tritaporn|Thailand|4\n0|cbba3737-60d0-4d70-99d3-9fc01c0ac723|46.073456|4.042306|0|luppano|France|0\n1|2505905539573261|-28.586698|20.285321|3|photosofafrica|South Africa|3\n1|1494994988764614|-8.646007|115.227047|5|Kaart 360|Indonesia|4\n1|542068145309851|21.368035|39.803901|3|ehabeid|Saudi Arabia|4\n1|941587608759027|53.119152|18.066006|0|PerspektywaLokalna|Poland|0\n1|666184746289085|58.832861|9.088649|0|aslakm|Norway|0\n1|221038497675739|41.463844|-87.164707|1|mbobcekpoco|United States of America|1\n1|1314522530881476|53.869934|-78.758382|1|michelcouturemotomcm|Canada|1\n1|2534409710062150|-29.299503|151.637657|5|Wallaby|Australia|5\n1|1108854793878127|48.211754|-0.393694|0|sogefi|France|0\n1|514285306393909|38.775004|-9.098316|0|davipt|Portugal|0\n1|966820654996587|9.054163|-79.451706|2|kaart5|Panama|1\n1|1970142356864178|-35.671727|174.100285|5|timwardWDC|New Zealand|5\n1|1184159409608608|-32.006701|115.892962|5|radiotrefoil|Australia|5\n1|724476340291421|52.456138|30.991683|4|360 m5 by|Belarus|0\n1|217435530249015|-10.847329|142.366123|5|coreagc|Australia|5\n1|547587313315528|-25.397253|-57.287048|2|solcaceresf|Paraguay|2\n1|445095708312200|44.847567|-118.041781|1|rking|United States of America|1\n1|988976386115436|50.379269|8.613772|0|tmka|Germany|0\n1|1390744012307531|-29.969257|-71.309385|2|DNC|Chile|2\n1|921678535724514|57.748739|12.176268|0|goteview|Sweden|0\n1|1140911290885284|-6.778767|39.248955|3|OMDTZ1|Tanzania|3\n1|1495464918165776|-0.906236|119.884635|5|benjidad|Indonesia|4\n1|449478258046974|31.731270|-116.553573|1|streetmaps|Mexico|1\n1|346906044485352|-8.549194|125.566167|5|NOD|Timor-Leste|4\n1|1475736267683640|32.747997|-16.969655|3|geouma|Portugal|0\n1|374306643906260|5.345861|-3.950669|3|cign|Côte d’Ivoire|3\n1|687819002831656|56.053056|-3.664564|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|1085803469625306|-2.828993|141.497940|5|PNGDOWH|Papua New Guinea|5\n1|172799325290789|-23.078986|-45.617913|2|360|Brazil|2\n1|2055645452043273|-6.105333|24.354731|3|bmitto|Democratic Republic of the Congo|3\n1|711502598238852|44.262402|15.234750|0|Tim1|Croatia|0\n1|298721328394417|31.719566|35.197766|3|360ms|Palestine|4\n1|211317723850562|31.724146|116.784370|4|sunkins|China|4\n1|822409577404582|46.999680|28.865460|0|Sku1255|Moldova|0\n1|3282356618635950|-8.891445|-36.498626|2|viniciusmap|Brazil|2\n1|4777857902497988|35.004747|45.612802|4|rawaz85|Iraq|4\n1|525876268418584|30.168123|-95.815144|1|microsoft|United States of America|1\n1|1318006453168322|54.607616|18.492431|0|Atemiki|Poland|0\n1|477650766686137|-20.012672|148.245533|5|esriau 1topo|Australia|5\n1|1678672326531158|32.655869|-16.921737|3|Hinojal|Portugal|0\n1|770833346968653|17.595739|-12.842494|3|sidi|Mauritania|3\n1|2263500957481112|-22.928318|-47.127476|2|jmfaria|Brazil|2\n1|3586578291447932|-27.428644|-57.332768|2|emanuel alejandro maciel|Paraguay|2\n1|1522106346034355|53.908793|-78.815087|1|michelcouturemotomcm|Canada|1\n1|1703300263758601|56.355489|9.635170|0|jenspeterhansen|Denmark|0\n1|1306660830531426|-27.804036|152.936063|5|ianstephenson|Australia|5\n1|388698257183753|8.975664|-79.520506|2|kaart 2|Panama|1\n1|461982731578315|0.333502|32.567844|3|sige|Uganda|3\n1|7648402945191133|21.066535|105.955747|4|bemaps2 hn|Vietnam|4\n1|1176806803046675|-12.537043|-51.529799|2|gmancilla|Brazil|2\n1|1439027384001968|-3.689678|143.059545|5|PNGDOWH|Papua New Guinea|5\n1|1159783337821600|-36.443724|174.751380|5|ralley|New Zealand|5\n1|1170541433417145|32.796220|-8.644821|3|immergismap|Morocco|3\n1|1477391602838179|-43.502443|172.706790|5|blackmapsmaksym|New Zealand|5\n1|681799373923713|-14.712947|-60.249306|2|jaderbavaresco|Brazil|2\n1|1207987517527050|-45.386064|-72.689901|2|Antoniam|Chile|2\n1|1247373016801801|-29.716530|27.028553|3|Infratec2024|South Africa|3\n1|5591279574236518|26.279987|127.744229|4|spring|Japan|4\n1|1533109381857797|40.990168|28.793110|0|burakonder|Turkey|0\n1|331004401847037|31.914599|35.120917|3|360ms|Palestine|4\n1|1630862941238778|18.778997|98.996710|4|SoT|Thailand|4\n1|586694573455476|38.277164|-78.983917|1|pmfox97|United States of America|1\n1|942339196490281|55.809968|37.241078|4|Krasnogorsk360|Russia|0\n0|272a9982-7b48-49c7-b213-e69db4f7205f|46.040315|19.665038|0|borovac|Serbia|0\n0|9d1e0979-5aed-43db-9faa-ee89b513cbd1|-15.696727|46.334981|3|Eric S|Madagascar|3\n1|175601474475729|1.552418|30.246747|3|tojoaro|Democratic Republic of the Congo|3\n1|751716183794418|-26.557897|29.989643|3|Infratec2024|South Africa|3\n1|536478949317066|-6.198289|155.537235|5|PNGDOWH|Papua New Guinea|5\n1|688638370342483|-19.229132|-45.015842|2|IGTECH|Brazil|2\n1|177152604887138|58.943972|5.593054|0|catoandersen|Norway|0\n1|559133359898017|45.502255|-73.576105|1|VdM|Canada|1\n1|7345407065568416|-35.465468|174.386007|5|bede|New Zealand|5\n1|582860239526700|-47.738026|-65.899570|2|jpabloroots|Argentina|2\n1|3950027001753106|43.912351|-1.326440|0|ev1velodyssee|France|0\n1|2845213415667750|-2.964563|141.745412|5|PNGDOWH|Papua New Guinea|5\n1|399794198158674|51.711049|54.382160|4|rifrif|Russia|0\n1|826754593566101|-37.774594|145.135045|5|andpen|Australia|5\n1|1290402835799207|45.098598|7.555341|0|canfe|Italy|0\n1|3134124823517678|53.404777|-2.922259|0|markagreen14|United Kingdom|0\n1|1484359703347833|49.969197|100.006891|4|wata909|Mongolia|4\n1|384450087058938|-25.634200|-48.427917|2|CTMGEO|Brazil|2\n1|1112607802598353|36.562277|140.645892|4|loglogy|Japan|4\n1|1303556124586778|33.059667|-16.330536|3|nunocaldeira|Portugal|0\n1|320148870126747|-41.657803|146.305690|5|coreagc|Australia|5\n1|306659471029880|-27.710665|153.118323|5|ianstephenson|Australia|5\n0|22df25e8-082c-4514-8061-a1767a53fc1b|-42.079257|-63.758163|2|Bastian Greshake Tzovara|Argentina|2\n1|311041277157488|54.597701|100.549437|4|moltgeo|Russia|4\n1|1274961157737820|36.049360|14.314406|0|richlv|Malta|0\n1|1257631458384949|-34.357695|19.117939|3|gertcb|South Africa|3\n1|2038601173631800|38.687780|-121.779224|1|marker geo1|United States of America|1\n1|941580800589114|36.746015|-103.954921|1|marker geo|United States of America|1\n1|867712472724650|-16.195948|-40.648676|2|MuitoAlemdasFronteiras|Brazil|2\n1|879794107726953|52.790171|5.104346|0|thewizard|Netherlands|0\n1|1385078035784568|-12.049631|-77.072379|2|kaart 360|Peru|2\n1|1280079273140491|-46.285178|-71.944688|2|Kaart Local|Chile|2\n1|1504822081041116|-11.193596|-61.901525|2|jaderbavaresco|Brazil|2\n1|3829354297172928|55.649265|51.819622|4|ngeos|Russia|0\n1|1167570531179359|-21.705688|-57.887808|2|Desireespindler|Brazil|2\n1|882613506842126|-33.723238|143.026865|5|Kangaroo|Australia|5\n1|1519533878930454|-27.137999|-48.478549|2|jaderbavaresco|Brazil|2\n1|1379751939444950|49.978184|-110.610509|1|networklanman|Canada|1\n1|1070836987152358|-34.350183|18.826169|3|gertcb|South Africa|3\n1|800764028861732|31.267015|120.680434|4|recklessxpy|China|4\n1|2814407562158091|-20.270525|148.521962|5|esriau 1topo|Australia|5\n1|139721838185322|-4.346565|-55.785267|2|comtacti|Brazil|2\n1|819823428627128|28.319722|-16.866287|3|javiersanp|Spain|0\n1|1330841215297202|31.554606|-110.211178|1|rking|United States of America|1\n1|611546594034815|40.501318|-111.952958|1|rking|United States of America|1\n1|1012943341606566|26.243865|49.997989|3|mahmoud12|Saudi Arabia|4\n1|1305405031265123|40.737602|-124.200786|1|marker geo1|United States of America|1\n1|2371900046503631|-6.826118|39.222943|3|OMDTZ1|Tanzania|3\n1|1183041506414014|9.009545|-79.534288|2|kaart 2|Panama|1\n1|272506978600784|-26.435747|20.624088|3|photosofafrica|South Africa|3\n1|1841845316593365|-29.118015|26.789856|3|Infratec2024|South Africa|3\n1|506759317031015|31.801432|35.471233|3|360ms|Palestine|4\n1|916517955593597|31.786621|-102.478927|1|rking|United States of America|1\n1|534209854254208|5.804596|5.078136|3|michael212|Nigeria|3\n1|578406381074862|-8.127392|-79.074470|2|kaart 2|Peru|2\n1|931674387617128|29.324320|48.085488|3|takethebuskw|Kuwait|4\n1|1011878996304179|5.228997|-3.749127|3|cign|Côte d’Ivoire|3\n1|1884517758370611|-20.026465|148.214749|5|esriau 1topo|Australia|5\n1|625990899335740|49.016101|-95.487839|1|networklanman|Canada|1\n1|1762755744346186|45.719550|-123.852257|1|quickness805|United States of America|1\n1|239431929173753|-29.059457|141.863048|5|Kangaroo|Australia|5\n1|238597378641283|-29.038999|167.963746|5|flashkiwi|Norfolk Island|5\n1|1350583796909639|33.518383|126.519079|4|monotaxism|South Korea|4\n1|356632700491122|9.101609|-79.393038|2|kaart 2|Panama|1\n1|2700139336843798|52.477527|13.426093|0|supaplex030|Germany|0\n1|694193205099408|21.675464|75.111422|4|balu geo|India|4\n1|1159829878731199|9.098709|-79.456052|2|kaart 2|Panama|1\n1|1259043544492566|-54.855542|-68.573317|2|severingeo|Argentina|2\n1|975973720099383|-26.323671|20.737462|3|photosofafrica|Botswana|3\n1|500249401132424|59.157885|17.840669|0|ainali|Sweden|0\n1|126756226822572|34.948799|135.748988|4|okadatsuneo|Japan|4\n1|399442681610098|-36.910538|174.689346|5|ralley|New Zealand|5\n1|724335876163635|-17.371570|-66.204313|2|kaart 2|Bolivia|2\n1|381478633644371|46.416997|73.916052|4|Arystan|Kazakhstan|4\n1|237301099093617|31.465911|35.396659|3|jeffreymartin|Israel|4\n1|484905489490262|5.339312|-4.030046|3|cign|Côte d’Ivoire|3\n1|471460768987128|38.549103|-121.489369|1|marker geo1|United States of America|1\n1|703322914433301|3.719255|34.841755|3|duncankebut|Kenya|3\n1|278305251094645|41.151394|-8.615442|0|skfd|Portugal|0\n1|159166059714300|22.131159|113.588869|4|joaocsampayo|Macao|4\n1|519423449253650|-17.675850|141.087519|5|coreagc|Australia|5\n1|2228628981212551|58.019067|56.242155|4|kirikset|Russia|0\n1|4325497387462877|38.523789|16.388244|0|marcuscalabresus|Italy|0\n1|1564156814811065|-37.695200|144.768951|5|JRickard WGA|Australia|5\n1|437369438672338|-36.269241|174.513989|5|ralley|New Zealand|5\n1|1390435821315855|59.139873|25.249760|0|ESTmapper1001|Estonia|0\n1|1418068065899401|42.976049|140.490510|4|flashkiwi|Japan|4\n1|494315195103715|29.267178|47.925203|3|takethebuskw|Kuwait|4\n1|161122586016759|44.067505|-103.149979|1|penncohwy|United States of America|1\n1|575952930544221|40.899936|37.497312|4|cbsordu|Turkey|4\n1|1376870394236453|-16.593446|-40.377403|2|MuitoAlemdasFronteiras|Brazil|2\n1|1512845669338875|-34.577292|-58.429418|2|kaartcam|Argentina|2\n1|337134979054474|-37.093325|-72.381715|2|Kaart Local|Chile|2\n1|853096017232157|53.124452|5.407543|0|thewizard|Netherlands|0\n1|858051583260139|6.996993|100.444505|4|PMU B|Thailand|4\n1|997457806375142|53.831560|-78.678461|1|michelcouturemotomcm|Canada|1\n1|786946089627299|-36.173278|174.448477|5|ralley|New Zealand|5\n1|497834508234245|51.023743|4.316382|0|vansteelandt|Belgium|0\n1|749684337908327|-30.969855|22.131740|3|Infratec2025|South Africa|3\n1|1004275261941832|49.381749|105.878781|4|wata909|Mongolia|4\n1|490612185525956|38.026175|23.812772|0|dkarkasina|Greece|0\n1|468099549273420|-32.544017|152.305927|5|Eucalyptus|Australia|5\n1|749297602402814|40.661535|16.612649|0|raxpa|Italy|0\n1|591457769409170|3.758084|34.823146|3|duncankebut|Kenya|3\n1|1027187878614247|34.902537|-89.933076|1|hdmaps1|United States of America|1\n1|2088168861930745|-43.776250|-72.953852|2|contactoacve|Chile|2\n1|1981650082188246|-0.507161|166.951029|5|flashkiwi|Nauru|5\n1|607219608109380|57.185798|-2.179389|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|825177293568896|48.312623|-109.842840|1|adamroads|United States of America|1\n1|1210543083221036|49.023390|-95.606447|1|networklanman|Canada|1\n1|1625731025331122|-27.897661|-53.285083|2|CAROA TOPOGRAFIA AGRIMEN|Brazil|2\n1|478621980298436|6.982532|-73.051431|2|innerpace360|Colombia|2\n1|932345071803739|51.545529|-3.262666|0|niallain|United Kingdom|0\n1|366194231459148|-54.252371|-36.491579|2|interact||-1\n1|1468114547275313|-6.793866|-79.840726|2|kaart 2|Peru|2\n1|345797570535714|-43.037552|146.277367|5|coreagc|Australia|5\n1|925776078276842|-6.053357|39.408199|3|federicodebetto|Tanzania|3\n1|473631300619875|-10.093051|148.745812|5|jthnz|Papua New Guinea|5\n1|615543434373089|-1.460719|-48.506617|2|mapconcierge|Brazil|2\n1|1128374625673953|-33.444100|-70.692246|2|kaart 360|Chile|2\n1|497364261409296|-9.093793|148.510391|5|jthnz|Papua New Guinea|5\n1|659564533543754|51.401578|11.657447|0|Planungsgesellschaft RV|Germany|0\n1|1952629628833496|-3.859650|143.857868|5|PNGDOWH|Papua New Guinea|5\n1|1144288189371697|-5.252859|-56.048869|2|comtacti|Brazil|2\n1|829860016219099|47.032124|28.804780|0|Sku1255|Moldova|0\n1|823987714911768|5.258328|-3.981959|3|cign|Côte d’Ivoire|3\n1|169141018560734|51.548743|43.190188|4|investproekt|Russia|0\n1|615799537700706|39.937060|64.367901|4|thoughtspark|Uzbekistan|4\n1|854053111813896|39.666014|118.194843|4|comradely|China|4\n1|576541026666345|25.493542|-103.348777|1|innerpace360|Mexico|1\n1|1432305050707068|-34.791695|150.778400|5|Echidna|Australia|5\n1|1281538307503580|9.010415|38.772595|3|DanTsg|Ethiopia|3\n1|317562959730754|31.885874|35.439874|3|360ms|Palestine|4\n1|425108799406374|-41.649136|145.954380|5|coreagc|Australia|5\n1|813941548288276|41.004600|-111.909542|1|flug32|United States of America|1\n1|474894944127675|26.539625|100.916410|4|adirricor|China|4\n1|828996776561448|-33.859167|18.643527|3|RuanZ|South Africa|3\n1|1289575416092070|51.653427|-115.250716|1|ContraBand|Canada|1\n1|487859238937212|57.388160|65.706118|4|survaero|Russia|4\n1|872476461223377|-40.909597|-73.246737|2|Kaart Local|Chile|2\n1|304927981340421|47.045813|-1.645648|0|stephanep|France|0\n1|825624520085940|44.207094|15.290057|0|Tim1|Croatia|0\n1|1109093660822381|-17.887622|177.706207|5|flashkiwi|Fiji|5\n1|327004289028492|32.778296|-16.979856|3|nunocaldeira|Portugal|0\n1|2254787422010851|36.525947|10.834503|0|slaheddinefateh|Tunisia|3\n1|310700690503713|-34.895107|-56.080295|2|dontv|Uruguay|2\n1|456865694188057|40.014359|-111.734747|1|rking|United States of America|1\n1|1301772398830212|-6.120242|24.315096|3|bmitto|Democratic Republic of the Congo|3\n1|1429774820754326|-18.147417|178.444635|5|flashkiwi|Fiji|5\n1|1067803764270697|-32.454349|142.371390|5|Kangaroo|Australia|5\n1|2859520824393216|43.970142|-87.731493|1|GIS ISG|United States of America|1\n1|1630576264053004|45.019691|-85.352630|1|networklanman|United States of America|1\n1|1768636950397997|-12.699195|45.069332|3|geodzer|France|0\n1|896567652589250|-1.451397|-48.496473|2|mapconcierge|Brazil|2\n1|1113988259699948|41.318039|-111.941798|1|rking|United States of America|1\n1|1236644854413832|-16.103984|-48.076363|2|helmert engenharia|Brazil|2\n1|276360998623950|-27.629517|153.100963|5|eechingng|Australia|5\n1|1110984023293834|42.925751|23.561718|0|alexanderbtodorov|Bulgaria|0\n1|812784467131457|43.096650|25.667988|0|alexanderbtodorov|Bulgaria|0\n1|1214334669415034|36.389651|-94.174025|1|jpinar|United States of America|1\n1|1221004391708297|43.672309|-92.938801|1|keithbcoa|United States of America|1\n1|558349255522100|-4.356259|-55.961727|2|comtacti|Brazil|2\n1|296732855133084|35.744950|51.801682|4|behzad62elahi|Iran|4\n1|575916237875837|35.953889|-77.936181|1|cbailey03|United States of America|1\n1|1505105753168635|59.651234|56.767384|4|moltgeo|Russia|0\n1|200494251689406|-23.585158|-70.395284|2|datagis|Chile|2\n1|155914529830076|0.584892|25.180841|3|tojoaro|Democratic Republic of the Congo|3\n1|926131875284171|-9.379797|-38.012093|2|360|Brazil|2\n1|2139611810177134|4.048489|9.696281|3|keke|Cameroon|3\n1|1139883857854422|44.798246|20.351041|0|brackone|Serbia|0\n1|495452568445434|33.318122|-7.318259|3|immergismap|Morocco|3\n1|1468950517941959|-8.858094|125.563644|5|kahbeng|Timor-Leste|4\n1|4013841998838597|5.512197|95.357652|4|rgtm ryuiki|Indonesia|4\n1|175967077641484|59.937397|30.312846|4|trolleway|Russia|0\n1|739293482013868|55.826618|12.360818|0|fur1nnj4|Denmark|0\n1|288863769454737|6.442479|3.454961|3|moriwo|Nigeria|3\n1|2151899054998652|-0.539949|166.912035|5|flashkiwi|Nauru|5\n1|339724275444293|13.469731|144.801317|4|Power01|Guam|5\n1|844451870099766|3.755129|34.808008|3|duncankebut|Kenya|3\n1|170053048377138|-15.271525|-63.850907|2|teambolivia|Bolivia|2\n1|817449793546325|52.651049|-7.254802|0|annekaro|Ireland|0\n1|1541409384448862|40.473626|-3.886724|0|seraq|Spain|0\n1|2730449920527576|-32.154815|135.068637|5|josh g|Australia|5\n1|753537245743649|58.716552|5.623129|0|catoandersen|Norway|0\n1|270867668281272|-36.536729|174.681202|5|ralley|New Zealand|5\n1|2485511305196997|-11.255392|-61.902143|2|jaderbavaresco|Brazil|2\n1|571172298437833|48.147369|68.792531|4|kazrap|Kazakhstan|4\n1|442359082063337|-11.018064|-68.756330|2|jaderbavaresco|Brazil|2\n1|2036605270302894|-8.690349|115.161745|5|Kaart 360|Indonesia|4\n1|1710565639445324|42.889880|-7.936607|0|AdgobaAlvac|Spain|0\n0|0c83f0d8-9769-4202-a84a-bad449492535|-11.493321|-76.629037|2|johnarupire|Peru|2\n1|512640869941508|55.747510|49.189133|4|kirillngeos|Russia|0\n1|1534279957253297|28.846260|-106.510976|1|GISCUU|Mexico|1\n1|372702154144405|-4.362670|-55.784829|2|comtacti|Brazil|2\n1|686130447122727|23.826475|90.353338|4|tayefbarikoi|Bangladesh|4\n1|472671763991567|33.445177|-7.194763|3|immergismap|Morocco|3\n1|856895963161058|-27.152974|-48.476488|2|jaderbavaresco|Brazil|2\n1|1489190352231237|31.497728|-110.189779|1|rking|United States of America|1\n1|449354700436430|5.615326|-72.908053|2|angoca|Colombia|2\n1|189506953028334|54.389302|24.055521|0|klimakas|Lithuania|0\n1|2399065000511109|47.043993|28.840571|0|Sku1255|Moldova|0\n1|3804174406499022|42.437201|-82.982915|1|codgis|United States of America|1\n1|910616783689809|-11.021319|-68.757365|2|jaderbavaresco|Brazil|2\n1|1469068630706245|-27.809865|153.131620|5|ianstephenson|Australia|5\n1|740207497916698|42.002899|45.568948|4|bumbeishvili|Georgia|4\n1|320945882958783|46.841045|-71.220356|1|BPRSTC|Canada|1\n1|1471068277780613|37.960897|23.639688|0|cedionysis|Greece|0\n1|132745192898713|-28.633670|29.909889|3|ovvio|South Africa|3\n1|689473129307634|-1.866162|-79.982842|2|kaart 2|Ecuador|2\n1|3016318081888310|-35.351270|174.313829|5|timwardWDC|New Zealand|5\n1|1868712163529438|-36.770906|145.582283|5|radiotrefoil|Australia|5\n1|505746742033443|5.019973|-74.007477|2|angoca|Colombia|2\n1|1449272048760882|48.763642|-91.624582|1|amidave|Canada|1\n1|448238024163126|3.742288|34.804736|3|duncankebut|Kenya|3\n1|818375152125377|9.470621|100.035408|4|garok|Thailand|4\n1|995648939774395|-36.736521|146.972552|5|zebjohnson|Australia|5\n1|769605070816623|50.624769|-115.106636|1|tomvh|Canada|1\n1|1176102363651161|59.269406|17.974258|0|bruno360|Sweden|0\n1|1597069381173636|7.822451|6.091163|3|Newwaves123|Nigeria|3\n1|325998136038287|-17.403885|145.220680|5|coreagc|Australia|5\n1|188442420861052|-0.530155|166.910293|5|flashkiwi|Nauru|5\n1|1119038616490692|-45.404130|-72.539413|2|Kaart Local|Chile|2\n1|826558208290069|13.662183|78.329299|4|geomannar|India|4\n1|2063786310716672|5.506769|-72.967435|2|trujilorenza|Colombia|2\n1|1535707621535739|-34.184231|22.156943|3|Mossel Bay Municipality|South Africa|3\n1|914580199100115|47.494561|1.247893|0|geovelo|France|0\n1|1633938327398309|-21.687852|-57.904931|2|Desireespindler|Brazil|2\n1|3123713914541951|43.244546|17.074616|0|SilvioBasic|Croatia|0\n1|175852647742908|30.062483|-95.254378|1|microsoft|United States of America|1\n1|1483275375557963|-43.523294|172.649138|5|blackmapsmaksym|New Zealand|5\n1|2186079538192089|29.924956|-95.647926|1|microsoft|United States of America|1\n1|6507133959299086|35.699042|140.856828|4|mura|Japan|4\n1|1141239201412813|-19.112518|33.477549|3|renaldoflor|Mozambique|3\n1|3464699903771680|-29.536663|150.579097|5|evilbunny|Australia|5\n1|1355529495759515|6.994458|100.448206|4|PMU B|Thailand|4\n1|147400627403952|-27.347806|-55.062279|2|emanuel alejandro maciel|Argentina|2\n1|537977251077439|37.966102|23.725937|0|zaf3kala|Greece|0\n1|389149822581300|59.427454|16.482945|0|eskilstuna kommun|Sweden|0\n1|1212393013455967|-26.496311|30.008187|3|Infratec2024|South Africa|3\n1|480707496579221|45.989932|11.665881|0|giubar|Italy|0\n1|761938072661359|9.053891|-79.444545|2|kaart 2|Panama|1\n1|1124379595541227|52.958895|17.909724|0|MElbonet81|Poland|0\n1|1689988768418259|-2.571900|150.798045|5|PNGDOWH|Papua New Guinea|5\n1|1790940005199716|58.903504|17.321244|0|bruno360|Sweden|0\n1|1397138990715838|-21.956792|-44.878011|2|prefeiturabaependimap|Brazil|2\n1|183061620755708|-29.038886|167.963654|5|flashkiwi|Norfolk Island|5\n1|1459500555250711|55.696014|8.192666|0|jenspeterhansen|Denmark|0\n1|2408428436302131|3.588467|11.552054|3|vteck|Cameroon|3\n1|148685751385398|-29.775567|151.110509|5|evilbunny|Australia|5\n1|1354505462448705|36.550412|-76.376559|1|vorpalblade|United States of America|1\n1|1145305690860028|36.045763|14.239392|0|richlv|Malta|0\n1|792163730512068|-8.557259|125.522503|5|kahbeng|Timor-Leste|4\n1|702343242663366|53.056270|5.508378|0|thewizard|Netherlands|0\n1|184930130279696|-12.654617|142.790255|5|coreagc|Australia|5\n1|221266777240710|-0.226700|-78.514264|2|kaart 2|Ecuador|2\n1|824727968162168|37.189512|140.707390|4|loglogy|Japan|4\n1|978591073792153|39.663137|20.834354|0|supco survey|Greece|0\n0|b3746f3d-903a-4754-82f4-e65e35a6e2f9|36.137293|-5.350986|0|R mi|Spain|0\n1|211817690416018|-20.269948|148.719325|5|esriau 1topo|Australia|5\n1|1625116428716356|-45.776168|170.729872|5|skillsy|New Zealand|5\n1|359450338871389|-11.385275|142.413021|5|coreagc|Australia|5\n1|1966447813751158|-13.154378|-72.524780|2|jaderbavaresco|Peru|2\n1|1335221974320102|52.347287|14.552302|0|Oderradler|Germany|0\n1|1332898288017369|52.476805|-7.447485|0|annekaro|Ireland|0\n1|944152780892722|-8.373507|-74.532530|2|johnarupire|Peru|2\n1|1492240762267477|-41.261107|174.908418|5|PhillCook|New Zealand|5\n1|629199780174652|-12.790600|45.104734|3|SIG 3CO|France|0\n1|6984416011592422|43.364444|45.614201|4|microfauna|Russia|0\n1|1478902416535469|45.154445|142.325612|4|yuki charo|Japan|4\n1|3998624103753898|52.067348|21.027080|0|inwazjamb|Poland|0\n1|1521184362457170|6.148115|-75.392424|2|CMPCONSULTORIA|Colombia|2\n1|4030708313905827|-16.384552|-40.246838|2|MuitoAlemdasFronteiras|Brazil|2\n1|2461635700975438|55.714637|8.714445|0|jenspeterhansen|Denmark|0\n1|836220490364208|13.449121|-16.674255|3|kmc streets|Gambia|3\n1|1376850112691197|-22.228300|166.502810|5|ratzillas|New Caledonia|5\n1|1721881911623204|-34.647782|150.482476|5|Echidna|Australia|5\n1|418367593783562|5.208380|5.808063|3|michael212|Nigeria|3\n1|1309280374126224|47.584432|12.570184|0|osmplus org|Austria|0\n1|299694851690608|25.895205|48.819910|3|mahmoud12|Saudi Arabia|4\n1|502269934251185|30.189229|-95.565845|1|microsoft|United States of America|1\n1|2127191204508669|51.421595|19.715425|0|inwazjamb|Poland|0\n1|1548516705595967|42.399256|-8.663667|0|sgonzalezd|Spain|0\n1|247415098218254|-0.093861|34.273228|3|quantiscale|Kenya|3\n1|1740170166435037|53.532530|-107.059023|1|boxer123|Canada|1\n1|1213138502907448|-0.602446|-78.601187|2|kaart 2|Ecuador|2\n1|1238277564531612|46.165351|1.853094|0|eric s|France|0\n1|898737348729263|-21.702695|-57.877011|2|Desireespindler|Brazil|2\n1|815734231221442|41.168032|-123.917122|1|marker geo1|United States of America|1\n1|1101607447555398|-3.740471|-38.504576|2|matheusgomesms|Brazil|2\n1|819175620214391|39.713375|-89.024568|1|hmhtb|United States of America|1\n1|186075514078882|49.140742|-123.843842|1|Mitchmiller|Canada|1\n1|1099733527190378|56.141230|40.366640|4|trolleway|Russia|0\n1|188290880269131|-11.769207|-49.076075|2|guigandra|Brazil|2\n1|1737834577341818|33.064317|-16.333831|3|PedroSantos|Portugal|0\n1|859938485290384|27.551158|-82.528176|1|jcox|United States of America|1\n1|255899903129092|-15.753904|145.290195|5|coreagc|Australia|5\n1|1255405928482773|-16.299313|-39.025379|2|mauriciomensura|Brazil|2\n1|1236059468143078|42.990558|140.565296|4|kojiroucircle|Japan|4\n1|2812053519059006|34.195655|-117.358481|1|rking|United States of America|1\n1|1695776141393683|24.493773|39.641282|3|mahmoud12|Saudi Arabia|4\n1|1079273659855769|43.654147|-93.354147|1|Hopen111|United States of America|1\n1|526189611767672|13.277139|79.039880|4|balu geo|India|4\n1|703470211853930|-33.742299|143.125264|5|Kangaroo|Australia|5\n1|767956010413476|56.921838|60.034758|4|urbanresearch|Russia|4\n1|931429164206388|5.355277|-3.972052|3|cign|Côte d’Ivoire|3\n1|1063776299247178|52.339263|-7.409520|0|annekaro|Ireland|0\n1|234839445072146|59.382382|24.825923|0|ESTmapper1001|Estonia|0\n1|1547277243118171|36.071004|14.254588|0|richlv|Malta|0\n1|479148670167948|-20.344393|148.636878|5|esriau 1topo|Australia|5\n1|296451355385435|43.605869|6.904477|0|vgrosso|France|0\n0|af7a316c-8d12-4c5e-b47c-c719111d0e07|32.795959|35.525063|3|Evgeniy360|Israel|4\n1|1693996212001639|39.352975|2.913144|0|mcd3|Spain|0\n1|277959645306594|-12.781413|45.112638|3|SIG 3CO|France|0\n1|1780497396243066|40.859053|-115.745292|1|rking|United States of America|1\n1|349281430165255|31.704157|-102.373891|1|rking|United States of America|1\n1|2515617358789803|-8.677503|119.555515|5|rgtm ryuiki|Indonesia|4\n0|13fe8640-3ce5-436c-9ffd-079af881abe8|53.257271|-3.979660|0|Preben Vangberg|United Kingdom|0\n1|523880346970801|-37.038586|174.873944|5|ralley|New Zealand|5\n1|381825687146833|43.717088|0.458232|0|paul ggat|France|0\n1|301831274723587|-54.281731|-36.508683|2|interact||-1\n1|587596822838764|26.953629|102.127561|4|adirricor|China|4\n1|1342808099770688|-32.715316|152.185822|5|Eucalyptus|Australia|5\n1|6727211324002318|-27.855117|153.053147|5|eechingng|Australia|5\n1|944309939739337|55.761687|12.393151|0|fur1ksw1|Denmark|0\n1|1017262365347844|5.330196|-3.998004|3|cign|Côte d’Ivoire|3\n1|303371114646161|-1.874966|28.989392|3|tojoaro|Democratic Republic of the Congo|3\n1|479841643233206|35.732201|51.636548|4|behzad62elahi|Iran|4\n1|2870584219784244|-34.633484|-58.409745|2|kaartcam|Argentina|2\n1|582927954305362|-52.593428|-70.484342|2|jloaiza|Chile|2\n1|1384736972987729|-27.644747|153.042809|5|ianstephenson|Australia|5\n1|1476386902704155|-20.087748|148.486107|5|esriau 1topo|Australia|5\n1|709582148413118|32.180998|34.872663|3|trigSkarim|Israel|4\n1|1048415512639732|-47.754324|-65.895256|2|jpabloroots|Argentina|2\n1|823420463446411|39.214690|9.114146|0|mapconcierge|Italy|0\n1|814849794587647|7.792649|-72.216704|2|rolandovasq|Venezuela|2\n1|488277055931478|26.674293|-77.269629|1|steer360network|Bahamas|1\n1|1821635185079117|-2.608381|141.002107|5|PNGDOWH|Papua New Guinea|5\n1|2955080751480012|40.972195|-111.927803|1|rking|United States of America|1\n0|edd6e8d1-371a-40d1-90b3-8bef993ddb30|43.168985|-124.171613|1|doakey3|United States of America|1\n1|956386857454867|-8.885405|-36.460928|2|viniciusmap|Brazil|2\n1|469449997673672|-6.226542|155.565579|5|jthnz|Papua New Guinea|5\n1|3538962093000270|43.227696|45.608285|4|microfauna|Russia|0\n1|1237650891265641|53.046880|6.441926|0|thewizard|Netherlands|0\n1|621860809284125|24.604773|46.648546|3|GreenRiyadh|Saudi Arabia|4\n1|673200543655140|45.820185|73.446047|4|Arystan|Kazakhstan|4\n1|1075975350378285|20.976723|105.822880|4|bemaps2 hn|Vietnam|4\n1|494415725083890|21.178563|94.879667|4|4htet|Myanmar|4\n1|314159703412522|33.007817|-96.996267|1|bwyatt516|United States of America|1\n1|969463887155672|-5.219469|-56.056229|2|comtacti|Brazil|2\n1|3100588790239793|47.665327|-122.282483|1|uwrapid|United States of America|1\n1|891953233565321|24.489996|39.659614|3|mahmoud12|Saudi Arabia|4\n1|1700124751431211|47.496144|-92.409489|1|RS EH MAPR 1|United States of America|1\n1|943628652867962|-12.649551|143.413933|5|coreagc|Australia|5\n1|2922232548097817|39.332772|68.554203|4|kavinda|Tajikistan|4\n1|819776240947874|-52.863060|-69.375136|2|Transporte DSS|Chile|2\n1|623905860205891|5.555951|95.284908|4|rgtm ryuiki|Indonesia|4\n1|901674553945067|-32.239585|135.196360|5|josh g|Australia|5\n1|832241024053016|-17.644757|177.410861|5|flashkiwi|Fiji|5\n1|1747300109217497|-22.677575|-43.831119|2|jaderbavaresco|Brazil|2\n1|748365963796634|7.243028|5.181663|3|LightChild|Nigeria|3\n1|2628032104214400|36.075287|14.237333|0|richlv|Malta|0\n1|1450757473248984|-37.848968|144.882336|5|skillsy|Australia|5\n1|4427229530644255|-20.720097|-41.135807|2|360|Brazil|2\n1|835405117064606|38.478837|16.464796|0|marcuscalabresus|Italy|0\n1|5983829198349669|-21.225376|-68.252399|2|SolutivaSistemas|Chile|2\n1|1707632082770648|26.594177|-78.553466|1|steer360network|Bahamas|1\n1|164775202930846|-35.737275|174.308371|5|ZealandiaStreamwalkView|New Zealand|5\n1|183030441205499|-29.022965|167.968483|5|flashkiwi|Norfolk Island|5\n1|487192076050219|56.270781|21.547670|0|lakd|Lithuania|0\n1|1502380254778523|48.786594|8.640025|0|Planungsgesellschaft RV|Germany|0\n1|486001536051252|1.553374|30.247742|3|tojoaro|Democratic Republic of the Congo|3\n1|876112376355812|49.102167|-122.646835|1|yzhao|Canada|1\n1|839102358013282|-16.154369|31.079358|3|Kennedy Jomokela|Zimbabwe|3\n1|1323249349692646|-11.209418|-61.901673|2|jaderbavaresco|Brazil|2\n1|5147321458716512|32.787804|-96.848577|1|kaart 360|United States of America|1\n1|735068122196679|50.541730|-4.029604|0|trekviewed|United Kingdom|0\n1|833407470650934|59.926223|10.879054|0|BYM OlaJuulHolm|Norway|0\n1|741429898702711|58.961706|18.340261|0|msamme|Sweden|0\n1|3074102136312917|48.920121|103.845044|4|wata909|Mongolia|4\n1|4628352427258234|16.832339|-11.836781|3|sidi|Mauritania|3\n1|757106578311766|35.805022|139.785488|4|mura|Japan|4\n1|2406068356407857|-20.218250|-70.153139|2|SolutivaSistemas|Chile|2\n1|1204986887518643|54.102948|77.786324|4|Sonnik|Russia|4\n1|1410850119813697|36.354631|25.474184|0|efikour|Greece|0\n1|616527124578526|38.695948|-1.674066|0|AdgobaAlvac|Spain|0\n1|234914325356691|56.450828|30.211687|4|ivangeo|Russia|0\n1|1684258559603356|-24.026557|-53.440242|2|Sicart360|Brazil|2\n1|1838761269620765|31.076064|-7.962387|3|sige|Morocco|3\n1|1455887431832342|-16.525571|-68.090836|2|kaart 2|Bolivia|2\n1|1028273662211831|-0.564461|-72.166581|2|juanmelo|Colombia|2\n1|1326814226190270|-8.784106|115.166273|5|Kaart 360|Indonesia|4\n1|714631817955785|-23.652671|-46.648704|2|gabinete falzoni|Brazil|2\n1|303278272202010|-36.833791|174.611267|5|ralley|New Zealand|5\n1|711434781517554|-20.490917|-69.328267|2|Kaart Local|Chile|2\n1|3735725393415188|33.053272|-16.281856|3|nunocaldeira|Portugal|0\n1|1200679210846392|-32.774142|26.636981|3|Infratec2024|South Africa|3\n1|436259644804696|-16.848104|145.689443|5|coreagc|Australia|5\n1|432726916271939|-34.708083|-58.391647|2|kaart 360|Argentina|2\n1|762339280206628|-12.831938|45.124417|3|SIG 3CO|France|0\n1|1262067041878620|11.000300|106.598195|4|bemaps3 sg|Vietnam|4\n1|1518187962409449|4.136969|-72.893359|2|juanmelo|Colombia|2\n1|1246796090707349|41.763331|13.368280|0|odiug|Italy|0\n1|683030333783394|52.958943|132.760816|4|vememi9618|Russia|4\n1|302691878197056|28.375111|-16.601702|3|javiersanp|Spain|0\n1|631536078245383|3.103751|24.124129|3|tojoaro|Democratic Republic of the Congo|3\n1|569702015059624|-12.130335|-77.031993|2|kaart 2|Peru|2\n1|1089733018438439|14.578021|121.053819|4|srdpmapping|Philippines|4\n1|2382699135584224|9.015613|38.772615|3|DanTsg|Ethiopia|3\n1|144934318277855|42.455676|-8.653664|0|sgonzalezd|Spain|0\n1|226380753508760|-9.071590|-78.583449|2|kaart 2|Peru|2\n1|1821056982115543|-0.882527|119.840159|5|benjidad|Indonesia|4\n1|496074994771694|47.073153|-109.407875|1|rking|United States of America|1\n1|1371225723690568|-12.021306|-77.086313|2|kaart 2|Peru|2\n1|1073656180758262|59.920264|14.869362|0|bruno360|Sweden|0\n1|298162918615443|1.365307|29.766744|3|tojoaro|Democratic Republic of the Congo|3\n1|915948967131786|-8.563809|125.540509|5|NOD|Timor-Leste|4\n1|1217798033143070|52.430783|13.382252|0|eserte|Germany|0\n1|121224783760380|6.978490|-73.046169|2|innerpace360|Colombia|2\n1|456999648725859|59.468455|112.624792|4|trolleway|Russia|4\n1|1738431804225985|27.281180|81.267134|4|vishalneogeo|India|4\n1|508478436946330|55.785521|12.398676|0|fur1aje1|Denmark|0\n1|2514501918922303|55.527265|9.455604|0|thewizard|Denmark|0\n1|337269114413662|-25.385440|-57.147074|2|solcaceresf|Paraguay|2\n1|2136729847227035|53.129992|10.097856|0|buffoon|Germany|0\n1|455480555752460|37.578337|139.825007|4|tm3594|Japan|4\n1|1024205359430374|28.063855|-16.516784|3|trekviewed|Spain|0\n1|1321330750172656|33.067245|-16.336740|3|PedroSantos|Portugal|0\n1|1781568762610904|-34.674664|-58.382216|2|kaart 360|Argentina|2\n1|28259810563618736|-5.878595|-78.687793|2|Jhostin270|Peru|2\n1|210715794626071|58.917043|5.597551|0|catoandersen|Norway|0\n1|725263299526934|-20.261421|-70.104339|2|SolutivaSistemas|Chile|2\n1|137365098426033|57.092451|65.165503|4|survaero|Russia|4\n1|873670546521798|13.533343|79.081819|4|geomannar|India|4\n1|1625041624923062|9.045409|-79.451432|2|kaart 3|Panama|1\n1|180531740613389|42.108529|140.572320|4|kou kita|Japan|4\n1|896524144616671|-27.193327|-49.514436|2|guilhermez|Brazil|2\n1|405519878033236|-41.654335|145.948643|5|coreagc|Australia|5\n1|964852496552822|46.176507|-97.135407|1|UAS ISG|United States of America|1\n1|813396419560087|13.323679|79.040593|4|geomannar|India|4\n1|961195149663794|36.387190|8.704725|0|ayoubbenhcin|Tunisia|3\n1|961584601469061|54.054578|-124.702252|1|pavlohladysh|Canada|1\n1|1135265857482931|-36.540957|174.707552|5|ralley|New Zealand|5\n1|269009951581943|51.216898|58.390565|4|okhtis|Russia|0\n1|2191333111002227|-22.277161|166.442190|5|flashkiwi|New Caledonia|5\n1|1037804367421928|50.468118|-3.531751|0|TomBrough2024|United Kingdom|0\n1|2881892872150300|44.121120|0.386618|0|lmuffato|France|0\n1|233044394827717|43.633377|-80.635476|1|msingh|Canada|1\n1|395557425824471|35.062813|-107.640433|1|adamroads|United States of America|1\n1|449297443826021|-25.492447|-54.737779|2|carfran79|Paraguay|2\n1|1432839468119684|-53.130385|-70.865596|2|jloaiza|Chile|2\n1|203740388986557|-26.847135|27.853177|3|Infratec2023|South Africa|3\n1|25350088618012444|48.064928|16.324632|0|erias|Austria|0\n1|844756195107301|-35.737843|174.138644|5|timwardWDC|New Zealand|5\n1|1435347514543384|43.319438|6.470206|0|PhilipBroughton Mills|France|0\n1|775746343697175|50.383840|17.405293|0|altaaro|Poland|0\n1|1835158033321715|30.567637|-9.536847|3|afmk|Morocco|3\n1|374251427768856|10.938325|7.831424|3|michael212|Nigeria|3\n1|1664559804386356|44.832245|-117.977909|1|rking|United States of America|1\n1|6429075870481979|-7.792726|-79.211494|2|kaart 2|Peru|2\n1|320593717158902|-2.585902|150.791358|5|GHDEdmond|Papua New Guinea|5\n1|26360965286899720|49.886809|-119.571924|1|eraticwanderer|Canada|1\n1|703959417737278|51.826097|75.443111|4|kazrap|Kazakhstan|4\n1|1890945815060727|40.045191|116.414168|4|Cicero101|China|4\n1|1254535152628262|-8.352253|-74.578296|2|johnarupire|Peru|2\n1|734761233866826|58.676375|17.061305|0|oxelosund|Sweden|0\n1|1318098173705158|-11.305299|-61.889215|2|jaderbavaresco|Brazil|2\n1|1089305326112316|-12.060430|-77.023086|2|kaart 360|Peru|2\n1|1871842233571865|21.395300|39.809713|3|ehabeid|Saudi Arabia|4\n1|821123125159395|25.629352|-80.325386|1|microsoft|United States of America|1\n1|135525125303533|-27.045259|-55.245375|2|santiagoperalta|Argentina|2\n1|1068730034611411|55.711748|-4.692632|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|1968642170429334|48.883919|-64.554027|1|CorenitnL|Canada|1\n1|874766374945238|31.962256|130.552757|4|yumechan|Japan|4\n1|460182031731687|14.703822|-17.453607|3|ismailaseye|Senegal|3\n1|1420293945415220|-4.770105|-40.057903|2|Amplomap360|Brazil|2\n1|566752062995314|-15.724118|-47.942380|2|mapconcierge|Brazil|2\n1|1221335882801604|-38.401706|-73.498528|2|Kaart Local|Chile|2\n1|864192597842163|-10.692251|142.531944|5|coreagc|Australia|5\n1|654092914049980|40.832148|-0.802504|0|AdgobaAlvac|Spain|0\n1|1015766554175523|56.950517|24.112919|0|ursus|Latvia|0\n1|593558445647754|24.629854|46.680302|3|GreenRiyadh|Saudi Arabia|4\n1|684366823008430|-22.248531|166.469898|5|ratzillas|New Caledonia|5\n1|959745260224104|50.013682|72.980116|4|kazrap|Kazakhstan|4\n1|1217631185991300|-45.670807|-71.930977|2|Kaart Local|Chile|2\n1|1696075764365094|52.925592|-118.098225|1|graharg|Canada|1\n1|1563678741738164|53.384240|6.010822|0|thewizard|Netherlands|0\n1|1619432559121136|28.587153|77.042583|4|skysign|India|4\n1|803560458258860|27.515695|41.585716|3|mahmoud12|Saudi Arabia|4\n1|300951921536815|-54.262527|-36.498117|2|interact||-1\n1|1292579544889599|-16.276881|-39.028188|2|mauriciomensura|Brazil|2\n1|1006006900052399|-33.675659|150.281288|5|radiotrefoil|Australia|5\n1|7311708065602208|-37.251037|149.964869|5|Echidna|Australia|5\n1|823395970139475|45.443263|141.652397|4|yuki charo|Japan|4\n1|1548538763350552|-8.895939|-36.496872|2|viniciusmap|Brazil|2\n1|1234478921836917|50.957428|-0.507218|0|BlizzardBorn42Car|United Kingdom|0\n1|1550504689120493|54.373770|17.227822|0|Atemiki|Poland|0\n1|373658862121369|-27.763665|153.133387|5|eechingng|Australia|5\n1|1427431889418816|40.589581|-124.124578|1|marker geo1|United States of America|1\n1|8735877589771153|39.070942|-84.392135|1|rking|United States of America|1\n1|4774883302625691|45.902314|-74.191262|1|opsstreetscan|Canada|1\n1|829183435236043|52.783995|-105.048851|1|boxer123|Canada|1\n1|1693385828774389|-5.991771|24.692487|3|bmitto|Democratic Republic of the Congo|3\n1|452838240572074|32.754720|-16.875022|3|geouma|Portugal|0\n1|1303603631600405|-38.631148|-73.436174|2|Kaart Local|Chile|2\n1|3547585042232095|-11.996248|-77.010192|2|kaart 2|Peru|2\n1|3578547672377205|-12.052988|-77.025355|2|kaart 2|Peru|2\n1|323846309275632|56.028827|35.738372|4|investpromvs|Russia|0\n1|312744616963954|13.437767|-16.670701|3|kmc streets|Gambia|3\n1|1689356385528002|-45.120698|169.306566|5|skillsy|New Zealand|5\n1|229084282781828|50.679419|3.075617|0|meldig|France|0\n1|2894261504103899|42.943065|-89.428059|1|vgxhc|United States of America|1\n1|889066025401550|18.781245|99.017206|4|renovate|Thailand|4\n1|777929884713818|-14.772540|-39.269125|2|helmert engenharia|Brazil|2\n1|827182880132971|-37.016654|-73.156369|2|SolutivaSistemas|Chile|2\n1|624697180460204|-6.867395|39.253102|3|OMDTZ1|Tanzania|3\n1|1215855289845556|-32.587713|26.677149|3|Infratec2024|South Africa|3\n1|316966977613495|-26.679573|153.133185|5|LukeCWalton|Australia|5\n1|203263828831407|48.319578|69.603793|4|kazrap|Kazakhstan|4\n1|1208031171507037|3.351219|-55.438243|2|ost360vr Joscelin|Suriname|2\n1|312633711273487|-22.785994|-41.947974|2|360|Brazil|2\n1|1220151932491447|37.779923|38.575170|4|makro360|Turkey|4\n1|1554635025375886|-4.272367|-38.046514|2|matheusgomesms|Brazil|2\n1|828561394410484|29.891785|-95.633554|1|microsoft|United States of America|1\n1|316235069913121|38.504536|16.374000|0|marcuscalabresus|Italy|0\n1|3871892459593310|45.777163|-108.515640|1|chrisbeddow|United States of America|1\n1|3217045245150082|-8.781763|13.240520|3|renaldoflor|Angola|3\n1|2404322429911577|-10.074341|147.736861|5|PNGDOWH|Papua New Guinea|5\n1|396773952312308|40.051724|-86.141253|1|opsstreetscan|United States of America|1\n1|409040118422882|27.517158|41.702518|3|mahmoud12|Saudi Arabia|4\n1|139883888126104|22.164153|113.545595|4|joaocsampayo|Macao|4\n1|4235152193185296|39.688478|-104.987446|1|atd2019|United States of America|1\n1|968972522688396|-7.757254|-63.142796|2|jaderbavaresco|Brazil|2\n1|1293423435928315|10.506552|124.030186|4|Kaart 360|Philippines|4\n1|992022389496529|-8.591685|119.951539|5|rgtm ryuiki|Indonesia|4\n1|879800772949806|25.841432|-80.266793|1|microsoft|United States of America|1\n1|1599260924105661|-14.885860|-60.085342|2|jaderbavaresco|Brazil|2\n1|4028090877245885|-11.254279|142.392136|5|coreagc|Australia|5\n1|559141911741481|34.256724|-6.514644|3|joaourbano|Morocco|3\n1|793245877986805|-22.310395|166.450614|5|ratzillas|New Caledonia|5\n1|1876581079711780|57.409124|25.764163|0|richlv|Latvia|0\n1|256134536886742|-10.579960|142.211291|5|flashkiwi|Australia|5\n1|412415458261219|33.517467|126.500609|4|eneerhut|South Korea|4\n1|1482040472665134|-33.448110|151.265302|5|Eucalyptus|Australia|5\n1|1759581138248932|-34.230938|146.214844|5|tomburnett|Australia|5\n1|910423550032425|30.036322|31.016505|3|Twospatial|Egypt|3\n1|565592844801641|31.866807|-102.454592|1|rking|United States of America|1\n1|585430249995071|26.179132|-97.679218|1|rking|United States of America|1\n1|1238080107660697|41.172469|-73.268754|1|ctroadway360|United States of America|1\n1|2323268528179158|-5.548059|155.006081|5|gdenholm|Papua New Guinea|5\n1|2095157924222372|22.326833|114.230394|4|wangxiaojiao|Hong Kong|4\n1|2182879932179110|37.534475|-122.237753|1|pixelpete|United States of America|1\n1|2163462670463139|35.821412|-78.611238|1|jcaruso|United States of America|1\n1|671378168285463|-0.033819|18.193813|3|CTSteward|Democratic Republic of the Congo|3\n1|1634516317620743|-8.827892|115.214670|5|Kaart 360|Indonesia|4\n1|544804538488327|-34.570629|-58.553448|2|kaart 360|Argentina|2\n1|2314365332317773|-20.212633|-70.152787|2|SolutivaSistemas|Chile|2\n1|744212409579304|34.380904|-103.194108|1|clovismapping|United States of America|1\n1|483822656098392|34.039578|-84.230753|1|nickoday|United States of America|1\n1|994452705345752|-36.797747|149.942769|5|Echidna|Australia|5\n1|774815995596222|45.756488|106.266446|4|INsta3600|Mongolia|4\n1|1601056464172869|39.548118|-111.444913|1|SunriseTraffic|United States of America|1\n1|1633764323665992|-28.317778|26.150604|3|infratec|South Africa|3\n1|3485473858271760|-11.745110|43.249460|3|Harsake|Comoros|3\n1|925309608982642|-43.516535|172.720520|5|blackmapsmaksym|New Zealand|5\n1|111257631602994|27.404530|99.946156|4|adirricor|China|4\n1|798412489488820|-41.160722|175.198545|5|PhillCook|New Zealand|5\n1|1278607397296632|50.451120|-63.246940|1|michelcouturemotomcm|Canada|1\n1|1054012780202673|-20.708359|-44.813951|2|IGTECH|Brazil|2\n1|1324138566267652|25.242366|47.147241|3|mahmoud12|Saudi Arabia|4\n1|204502374873665|32.653802|-16.962126|3|geouma|Portugal|0\n1|339914245231026|52.430477|130.874856|4|vememi9618|Russia|4\n1|321508552704658|18.704811|79.409098|4|mkhan|India|4\n1|1893236714684997|-7.808962|-77.693603|2|GMINGENIEROS|Peru|2\n1|1648350362709241|28.766050|-81.633735|1|rking|United States of America|1\n1|605506801743738|-4.860685|-40.022092|2|Amplomap360|Brazil|2\n1|851824353499675|-3.730563|-38.485086|2|matheusgomesms|Brazil|2\n1|1843674599536417|36.122402|-120.374100|1|marker geo1|United States of America|1\n1|590384252004415|-47.741597|-65.891608|2|jpabloroots|Argentina|2\n1|673070553760803|37.979112|23.716505|0|zaf3kala|Greece|0\n1|788160502072402|-22.309518|166.452514|5|flashkiwi|New Caledonia|5\n1|694136622313791|37.475144|121.370688|4|recklessxpy|China|4\n1|257419009802360|-17.212160|145.443683|5|coreagc|Australia|5\n1|2365747707199779|-3.986212|-79.351904|2|sig eerssa|Ecuador|2\n1|785513802327353|11.029383|76.042061|4|mohammedshibu|India|4\n1|1630095118253800|-45.234891|169.430938|5|skillsy|New Zealand|5\n1|3783676685076748|56.222665|51.313655|4|vovenarg|Russia|0\n1|979413521368002|-8.628493|115.208661|5|Kaart 360|Indonesia|4\n1|227195233779145|25.076113|-77.339847|1|dpu transport|Bahamas|1\n1|903729177139221|31.240398|121.497206|4|wsp us|China|4\n0|5848146e-a926-43c3-a54e-4c66136f6513|-43.549317|172.532254|5|chch parks|New Zealand|5\n1|642488171670434|50.929337|5.315881|0|Eebie|Belgium|0\n1|1884771625027959|4.529666|-74.088291|2|sarahantos|Colombia|2\n1|1131484268896011|-12.143092|44.429609|3|Harsake|Comoros|3\n1|492295193503289|-12.834738|45.114088|3|SIG 3CO|France|0\n1|486153667187818|-37.261613|150.049516|5|Echidna|Australia|5\n1|636072721693402|-0.325711|-78.446145|2|kaart 2|Ecuador|2\n1|1459546825336493|-0.919342|119.874047|5|benjidad|Indonesia|4\n1|458889913823868|39.947888|64.408822|4|thoughtspark|Uzbekistan|4\n1|957781168330296|-18.691757|144.697570|5|coreagc|Australia|5\n1|799244028485446|-8.651430|-63.759392|2|jaderbavaresco|Brazil|2\n1|1850682052507406|7.815998|6.069504|3|Newwaves123|Nigeria|3\n1|186183180383729|18.411456|109.796831|4|adirricor|China|4\n1|1569317520298220|21.003131|105.841470|4|theonenetwork|Vietnam|4\n1|288569216317981|55.554369|22.254172|0|lakd|Lithuania|0\n1|249958820240885|55.844816|21.116177|0|lakd|Lithuania|0\n1|1437973279896683|55.455897|21.636409|0|lakd|Lithuania|0\n1|649885239848137|-8.145407|-79.050530|2|kaart 2|Peru|2\n1|463525391612523|-41.435504|147.137426|5|launceston|Australia|5\n1|2742339869483376|2.941240|-73.207441|2|juanmelo|Colombia|2\n1|1160771846084117|-30.952090|22.123198|3|Infratec2025|South Africa|3\n1|1468800064335402|7.069229|125.601660|4|kaart 360|Philippines|4\n1|1939066193509458|47.657168|26.405838|0|DARIUSDINCA|Romania|0\n1|484887489300759|56.024878|22.209143|0|lakd|Lithuania|0\n1|1210501917012136|45.618969|-106.668519|1|adamroads|United States of America|1\n1|278713928130167|13.035776|80.156617|4|GSPLMukundhan|India|4\n1|1374561996259595|30.558992|-9.547967|3|afmk|Morocco|3\n1|490466873179248|-10.796404|-51.824948|2|gmancilla|Brazil|2\n1|1292331265797389|32.728527|-16.967004|3|geouma|Portugal|0\n1|782352329892119|47.564155|-122.284441|1|uwrapid|United States of America|1\n1|3866480690234675|27.908487|85.582827|4|Nepal FRES|Nepal|4\n1|387073010782280|27.523927|41.701925|3|mahmoud12|Saudi Arabia|4\n1|3900437023407561|-1.677398|29.218302|3|tojoaro|Democratic Republic of the Congo|3\n1|1070899901891897|43.315439|-8.355196|0|sanjorgepinho|Spain|0\n1|1532452311732397|44.677914|-94.000683|1|codeproquo|United States of America|1\n1|975116871802733|-8.657056|115.140797|5|Kaart 360|Indonesia|4\n1|876508294253807|-16.393631|30.994534|3|Kennedy Jomokela|Zimbabwe|3\n1|969554355853748|-34.171842|22.124156|3|Mossel Bay Municipality|South Africa|3\n1|1601202734106854|38.219880|48.294910|4|58zarali|Iran|4\n1|1020053953114412|-8.368739|-74.588582|2|johnarupire|Peru|2\n1|1286509163066705|43.391576|144.002971|4|rgtm ryuiki|Japan|4\n1|474960433721999|38.953694|68.791711|4|kavinda|Tajikistan|4\n1|1512947906659910|40.894314|-96.570008|1|quickness805|United States of America|1\n1|507259304897231|-17.736233|-63.117095|2|kaart 2|Bolivia|2\n1|1209478683455283|51.607233|-68.230688|1|zombiegraph|Canada|1\n1|453656577375930|-32.477507|152.283993|5|Eucalyptus|Australia|5\n1|1307479249734541|-41.295445|-73.410566|2|felipeeugenio|Chile|2\n1|480308427301067|-17.811057|178.196343|5|flashkiwi|Fiji|5\n1|32824486997194772|-19.116753|33.480121|3|ainguane|Mozambique|3\n1|1179209092488873|52.464934|13.419577|0|supaplex030|Germany|0\n1|811178093970865|-0.543277|166.950112|5|flashkiwi|Nauru|5\n1|874224784527911|51.706013|-8.521898|0|graharg|Ireland|0\n1|1386940489076769|-26.766787|153.110944|5|LukeCWalton|Australia|5\n1|710723488212152|-43.890220|-72.371661|2|Kaart Local|Chile|2\n1|197958366556910|-41.763399|-73.137686|2|Kaart Local|Chile|2\n1|323142963465109|49.293789|-124.148197|1|Mitchmiller|Canada|1\n1|2941875352710861|6.307974|23.861614|3|raffael|Central African Republic|3\n1|199779298481227|-1.947918|28.927325|3|tojoaro|Democratic Republic of the Congo|3\n1|448006553674003|-42.732703|145.978417|5|coreagc|Australia|5\n1|1039364571848107|39.504582|21.147362|0|nglf|Greece|0\n1|920604798699646|34.076459|-84.187837|1|nickoday|United States of America|1\n1|1055379553242677|41.795148|44.780479|4|bumbeishvili|Georgia|4\n1|1131789311342489|35.808183|-90.718350|1|Mosaic51 Dylan|United States of America|1\n1|661090682673820|49.912942|14.582822|0|jeffreymartin|Czechia|0\n1|321845150301348|-22.750943|-41.982014|2|360|Brazil|2\n1|1108346044027034|28.621402|-106.092437|1|GISCUU|Mexico|1\n1|319796299546626|13.433913|-16.663795|3|kmc streets|Gambia|3\n1|1029846711630269|56.542824|9.746228|0|jenspeterhansen|Denmark|0\n1|313990818264472|-30.581251|145.690382|5|Wallaby|Australia|5\n1|1298306277757619|52.393389|23.823276|0|PesDyuck|Belarus|0\n1|337398552536727|-15.486721|-70.131545|2|jaderbavaresco|Peru|2\n1|1170947757531441|-8.350598|-74.588268|2|johnarupire|Peru|2\n1|1759679544675261|26.975123|-91.712056|1|graharg||-1\n1|2986757754981618|-22.309715|166.452736|5|flashkiwi|New Caledonia|5\n1|491967896026957|-25.327982|-57.639233|2|juliaoporto|Paraguay|2\n1|1083481793921897|25.740461|84.527003|4|subhash geo|India|4\n1|917004634027772|40.694165|0.278407|0|meteolasenia|Spain|0\n1|462901558342278|37.575627|139.923575|4|jmmapiranger|Japan|4\n1|2290459384768534|-37.007620|-73.158229|2|SolutivaSistemas|Chile|2\n1|770913945357446|-8.768690|-63.870238|2|jaderbavaresco|Brazil|2\n1|1552719262362750|6.061397|121.027478|4|rskorzus|Philippines|4\n1|1322741562733032|-41.269633|174.943884|5|PhillCook|New Zealand|5\n1|962037966038179|43.373591|-0.726026|0|sogefi|France|0\n1|380638746861894|46.117551|73.608883|4|Arystan|Kazakhstan|4\n1|1991815937869463|-1.957867|30.061703|3|dpu transport|Rwanda|3\n1|346905104125972|-5.346251|39.669556|3|federicodebetto|Tanzania|3\n1|2789133051247707|23.133281|105.028256|4|theonenetwork|Vietnam|4\n1|177898641002825|44.847828|-93.366244|1|trpd|United States of America|1\n1|967533712627940|-45.210862|169.354734|5|skillsy|New Zealand|5\n1|4012041812355877|-14.720661|-60.223329|2|jaderbavaresco|Brazil|2\n1|548051557589646|32.008436|-90.959142|1|hdmaps1|United States of America|1\n1|3903557899680818|52.354943|4.819666|0|amsterdam|Netherlands|0\n1|517999053777343|-12.157017|-76.959024|2|kaart5|Peru|2\n0|97dfd114-39a3-4d44-bdc2-81260bb3b7f6|9.655198|124.022636|4|amcrepin|Philippines|4\n1|1201274551488641|4.052627|9.699388|3|keke|Cameroon|3\n1|629985501735191|18.549497|78.613658|4|geomannar|India|4\n1|1953583375545596|-3.969504|-79.192450|2|sig eerssa|Ecuador|2\n1|271497931345810|-20.305450|148.521030|5|esriau 1topo|Australia|5\n1|299508706110321|56.688052|10.246091|0|jenspeterhansen|Denmark|0\n1|1462554142035666|24.999290|121.525533|4|irvinfly|Taiwan|4\n1|525179336732674|39.498495|64.831651|4|kazrap|Uzbekistan|4\n1|2067681740702531|-8.585655|125.631492|5|kahbeng|Timor-Leste|4\n1|2144823332921016|24.493634|39.642164|3|mahmoud12|Saudi Arabia|4\n1|839172533700046|-12.784571|143.343103|5|coreagc|Australia|5\n1|481648899811122|35.761243|51.962832|4|behzad62elahi|Iran|4\n1|646232191190434|11.214408|107.497019|4|LANG THANG KHAP PHO|Vietnam|4\n1|530646271310801|26.196946|-80.251949|1|microsoft|United States of America|1\n1|776933808102196|9.987775|123.372660|4|Kaart 360|Philippines|4\n1|722132774113913|-5.697434|155.127007|5|gdenholm|Papua New Guinea|5\n1|603545742825818|31.765777|130.569295|4|Y Suzuki|Japan|4\n1|1557569858288940|-1.494326|-48.442104|2|mapconcierge|Brazil|2\n1|1325582886378792|-6.140299|24.381503|3|bmitto|Democratic Republic of the Congo|3\n1|569529021103829|-41.547681|-73.156521|2|felipeeugenio|Chile|2\n1|312304880533312|11.028767|76.049776|4|mohammedshibu|India|4\n1|909846394884316|36.534648|29.141774|0|trekviewed|Turkey|4\n1|372893118623843|-29.000186|141.097730|5|Kangaroo|Australia|5\n1|248968423641951|45.187513|-109.342793|1|chrisbeddow|United States of America|1\n1|912952304648565|10.293521|123.895160|4|Kaart 360|Philippines|4\n1|161197885940466|0.594615|25.179214|3|tojoaro|Democratic Republic of the Congo|3\n1|547086358297187|52.805246|-67.097356|1|zombiegraph|Canada|1\n1|830520891177235|32.580427|-7.448327|3|immergismap|Morocco|3\n1|1305398385066229|-34.177373|22.084189|3|Mossel Bay Municipality|South Africa|3\n1|318657223300624|-22.289364|166.441643|5|ratzillas|New Caledonia|5\n1|1211969499255834|55.156273|38.307895|4|investpromvs|Russia|0\n1|1055464133799692|34.902608|-81.563401|1|rking|United States of America|1\n1|856982405434170|42.437447|-8.581054|0|sgonzalezd|Spain|0\n1|164546022266268|1.566566|30.234359|3|tojoaro|Democratic Republic of the Congo|3\n1|1498132388771162|-36.905303|174.721139|5|ralley|New Zealand|5\n1|1088486775399344|43.937950|2.165981|0|Remyv|France|0\n1|3019168518354118|48.530049|-122.139253|1|jacksoe|United States of America|1\n1|1462578521353019|35.825580|45.301875|4|flashkiwi|Iraq|4\n1|912939939550255|48.760709|-91.629472|1|amidave|Canada|1\n1|559824223190858|50.651972|-68.678810|1|zombiegraph|Canada|1\n1|4131591453828187|50.642443|17.846445|0|Davvid23|Poland|0\n1|1912504569135240|-26.704654|153.112838|5|LukeCWalton|Australia|5\n1|292783150376471|9.667042|13.224165|3|michael212|Cameroon|3\n1|771838897610861|44.034123|5.377196|0|Topbenbou|France|0\n1|1272291773676309|-35.723314|174.323916|5|ralley|New Zealand|5\n1|4427091694284328|-35.501508|174.331473|5|timwardWDC|New Zealand|5\n1|1802341153725660|47.037854|28.894115|0|Sku1255|Moldova|0\n1|1012619156798177|2.277344|31.687146|3|dilipshrikhande|Uganda|3\n1|4131630200461324|-35.476566|174.379286|5|timwardWDC|New Zealand|5\n1|1624603128363211|32.037579|-88.652012|1|hdmaps1|United States of America|1\n1|1559631324241156|-17.527653|177.927998|5|flashkiwi|Fiji|5\n1|484211579494208|56.891967|59.988589|4|urbanresearch|Russia|0\n1|2356053624566615|1.738892|40.054694|3|quantiscale|Kenya|3\n1|358161573656502|-6.758920|39.271160|3|OMDTZ1|Tanzania|3\n1|2583409542036582|-35.630684|-71.394799|2|Kaart Local|Chile|2\n1|811295096180153|42.475352|-73.244479|1|amidave|United States of America|1\n1|1057282059841119|32.648477|-16.931941|3|sanjorgepinho|Portugal|0\n1|699122843151631|44.894967|22.443950|0|grozsa11|Romania|0\n1|583720615926980|-6.007324|39.383243|3|federicodebetto|Tanzania|3\n1|529613601814618|34.678814|-76.938418|1|steer360network|United States of America|1\n1|1541101130514312|41.665806|-72.816483|1|ctroadway360|United States of America|1\n1|1595150728207432|7.795865|-72.203418|2|rolandovasq|Venezuela|2\n1|1033208587630473|-33.674336|26.673416|3|ovvio|South Africa|3\n1|3634255410048186|-34.157221|22.061541|3|Mossel Bay Municipality|South Africa|3\n1|1480605183148834|-0.922364|119.903455|5|benjidad|Indonesia|4\n1|425480223531962|50.478260|-114.900514|1|tomvh|Canada|1\n1|1576290313481099|-41.134441|175.055560|5|PhillCook|New Zealand|5\n1|822610568673448|48.877476|2.284207|0|geovelo|France|0\n1|1316919306697016|-20.345171|148.949532|5|HIPA|Australia|5\n1|2940798376138971|-9.458964|147.201257|5|jthnz|Papua New Guinea|5\n1|1916508392277997|-35.700199|174.408372|5|timwardWDC|New Zealand|5\n0|d00d8c5e-a765-4855-ad7b-4b455d632edb|53.426173|14.568608|0|n8aktiver|Poland|0\n0|ef5c4549-f45a-4661-8d53-7209d10aba7f|4.280849|-8.456351|3|b unicycling|Liberia|3\n1|864624736007371|-36.842456|174.763283|5|mapconcierge|New Zealand|5\n1|3344794595764613|-11.054838|-51.842845|2|gmancilla|Brazil|2\n1|1056355565563036|-34.674216|150.856836|5|TanaponL|Australia|5\n1|1326740039360436|-45.221214|170.258178|5|skillsy|New Zealand|5\n1|783488242626913|48.935865|-66.119208|1|chelseabrian|Canada|1\n1|511054276716622|-20.047213|148.229173|5|esriau 1topo|Australia|5\n1|609211761592596|-33.476555|-70.655547|2|kaart 360|Chile|2\n1|1198743400623474|-36.089675|174.589426|5|ralley|New Zealand|5\n1|1080854750635744|-15.838050|-48.967217|2|helmert engenharia|Brazil|2\n1|526050209625944|20.847025|71.322088|4|tranzitnotes|India|4\n1|2178998685915838|36.061531|14.231964|0|richlv|Malta|0\n1|1803317626856639|-32.772928|26.805959|3|Infratec2024|South Africa|3\n1|1185377442140651|54.381247|-105.829403|1|boxer123|Canada|1\n1|2846884455550371|53.257445|0.296480|0|lennartvdhorst|United Kingdom|0\n1|1287150522745962|-11.579055|-61.741612|2|jaderbavaresco|Brazil|2\n1|1199444847301623|5.208831|5.803621|3|michael212|Nigeria|3\n1|1149260852957344|21.008915|105.865652|4|theonenetwork|Vietnam|4\n1|1031943061130940|49.312369|-124.205422|1|Mitchmiller|Canada|1\n1|607382788550768|-8.606738|120.033065|5|rgtm ryuiki|Indonesia|4\n1|781937187422966|33.189956|-90.411144|1|hdmaps1|United States of America|1\n1|4085935361444527|55.709382|21.422789|0|lakd|Lithuania|0\n1|971482754717162|-32.441231|152.538085|5|Eucalyptus|Australia|5\n1|678016405226699|50.619759|-63.256059|1|CorenitnL|Canada|1\n1|1463101444579459|-9.348192|147.030970|5|PNGDOWH|Papua New Guinea|5\n1|1046868476439732|50.515225|-119.244930|1|amneimne|Canada|1\n1|871758643552739|6.878490|79.872981|4|gazaly|Sri Lanka|4\n1|1231883721070719|37.575421|121.288656|4|recklessxpy|China|4\n1|602468416076834|-11.960625|-60.696634|2|jaderbavaresco|Brazil|2\n1|247625460485977|54.123645|42.690946|4|investproekt|Russia|0\n1|1534186931646101|-16.451216|-54.672181|2|PMR|Brazil|2\n1|1549896559977411|-35.523700|174.305575|5|timwardWDC|New Zealand|5\n1|889160055280991|43.461903|-80.841722|1|msingh|Canada|1\n1|224326729126209|-17.455797|140.873319|5|coreagc|Australia|5\n1|299744759517194|-19.207487|-46.241187|2|smarzaro|Brazil|2\n1|1824037461388969|-40.978048|-73.210198|2|Kaart Local|Chile|2\n1|2849567995217500|-8.657043|119.536303|5|rgtm ryuiki|Indonesia|4\n1|1516233229399590|-0.916292|119.899114|5|benjidad|Indonesia|4\n1|458453031906130|31.067239|-8.393531|3|sige|Morocco|3\n0|184a9aca-724a-49b0-8a9a-51a697501325|34.774560|32.405259|3|nave88|Cyprus|4\n1|947660242675153|-35.070547|138.496608|5|unisageoscience|Australia|5\n1|487644604330479|5.361415|-3.989542|3|yangcedrick|Côte d’Ivoire|3\n1|1323140675012854|-0.046771|18.197877|3|CTSteward|Democratic Republic of the Congo|3\n1|451386539605808|36.745694|138.312255|4|kojiroucircle|Japan|4\n1|936658979376307|-8.687879|115.200769|5|Kaart 360|Indonesia|4\n1|767064213950756|47.267051|-117.370437|1|jacksoe|United States of America|1\n1|1479507479140731|13.777656|100.340337|4|VPTest|Thailand|4\n1|533795205748449|-26.725339|153.069742|5|LukeCWalton|Australia|5\n1|2296818704016532|45.077009|21.887551|0|panovisual|Romania|0\n0|a4ed2006-a433-43ca-ada7-ebf6ae27fa2e|-36.608897|174.899132|5|Alixun|New Zealand|5\n1|1069467251301289|39.935027|-88.953838|1|hmhtb|United States of America|1\n1|390068189109148|46.719630|26.705850|0|bogdancandrea|Romania|0\n1|1218648346953448|37.923410|-1.289620|0|AdgobaAlvac|Spain|0\n1|613109538076835|-8.830975|120.213166|5|rgtm ryuiki|Indonesia|4\n1|429052776683298|-34.607957|-58.367660|2|kaart 360|Argentina|2\n1|1209742461306230|-45.461731|-72.813545|2|contactoacve|Chile|2\n1|359015280128028|-12.782380|45.229242|3|SIGMDZ|France|0\n1|1684166136213171|41.058264|-124.148184|1|marker geo1|United States of America|1\n1|1012582478193630|-41.065995|175.198680|5|PhillCook|New Zealand|5\n1|231588963030271|-20.353443|-40.294727|2|360|Brazil|2\n1|327813592038813|-22.263000|166.472155|5|flashkiwi|New Caledonia|5\n1|1437729547650501|-20.889968|-45.282466|2|IGTECH|Brazil|2\n1|988514966195309|59.927698|10.772151|0|BYM OlaJuulHolm|Norway|0\n1|626831906461958|32.647811|-117.057740|1|marker geo1|United States of America|1\n1|1409089663544215|37.564442|126.992305|4|lisbethw1130|South Korea|4\n1|722536462449434|-1.283743|29.695761|3|jfrek|Uganda|3\n1|1062412432544037|-14.833274|-39.321393|2|helmert engenharia|Brazil|2\n1|1001433831837641|-31.676220|-71.286090|2|AMYT|Chile|2\n1|2554370091536523|30.531283|-9.589289|3|afmk|Morocco|3\n1|1651124102710430|-15.805877|-48.059698|2|MuitoAlemdasFronteiras|Brazil|2\n1|1473501653906650|25.876669|84.410235|4|balu geo|India|4\n1|661900903056116|-28.756750|-70.484814|2|Kaart Local|Chile|2\n1|662991579407763|-29.153790|26.289841|3|Infratec2024|South Africa|3\n1|800146758706217|-36.949536|149.939908|5|Echidna|Australia|5\n1|1769423257575275|40.618853|-111.799684|1|rking|United States of America|1\n1|985379840290893|5.552154|95.319266|4|rgtm ryuiki|Indonesia|4\n1|1375801943218973|47.686961|-122.360919|1|uwrapid|United States of America|1\n1|3962909430650728|39.684890|-105.370651|1|HKocen|United States of America|1\n1|1472480893155213|-24.611849|-53.416845|2|byte2bit|Brazil|2\n1|1021768792876236|45.082143|7.690402|0|canfe|Italy|0\n1|843228398247019|56.450777|67.695576|4|catherinegautier|Russia|4\n1|244414554645954|-0.160143|-78.436735|2|kaart 2|Ecuador|2\n1|2495341890863821|-19.113628|33.481260|3|renaldoflor|Mozambique|3\n1|1625362641513201|50.643046|-63.270825|1|MarikaD|Canada|1\n1|380907043390157|-10.750090|142.609582|5|coreagc|Australia|5\n1|1399123220529437|44.730945|-116.072797|1|rking|United States of America|1\n1|499264807849489|31.954935|35.036638|3|360ms|Palestine|4\n1|172237945682352|-29.057138|167.941903|5|flashkiwi|Norfolk Island|5\n1|1414934162542705|-36.991166|149.924120|5|Echidna|Australia|5\n1|1085495253224768|-25.793231|-56.424219|2|ArtzaiPY|Paraguay|2\n1|149415210992580|32.254758|35.527546|3|noamroze|Palestine|4\n1|2819739838367013|11.487582|105.093767|4|vteck|Cambodia|4\n1|816369382643690|37.008552|140.976262|4|loglogy|Japan|4\n1|688898373294248|-36.810128|149.936018|5|Echidna|Australia|5\n1|328990716130196|-43.496752|172.704778|5|blackmapsmaksym|New Zealand|5\n0|7cf83e0a-8cd5-4a5d-b8bb-d80c799cfda7|38.751163|27.623493|0|burakonder|Turkey|0\n1|1181181575933662|-0.180851|-78.445245|2|kaart 2|Ecuador|2\n1|650217882796331|-43.583124|146.893268|5|coreagc|Australia|5\n1|859236147962918|-27.730634|153.170316|5|ianstephenson|Australia|5\n1|1564402485201624|-9.769405|-66.617959|2|jaderbavaresco|Brazil|2\n1|992339236478839|33.512735|126.519988|4|monotaxism|South Korea|4\n1|1728286578424642|-16.379830|-40.542286|2|MuitoAlemdasFronteiras|Brazil|2\n1|1274011894762371|-8.179696|-63.082739|2|jaderbavaresco|Brazil|2\n1|607490851435783|-26.905840|-55.061292|2|santiagoperalta|Argentina|2\n0|5f7e070f-f805-4703-9946-1bf7f44f5d98|38.983500|1.294227|0|Jean Louis Stanus|Spain|0\n1|475200738552853|20.863743|106.785961|4|theonenetwork|Vietnam|4\n1|1454163412289300|-2.407707|-44.417963|2|MuitoAlemdasFronteiras|Brazil|2\n1|945174142897918|48.898756|6.058586|0|pgehin|France|0\n1|948756551041362|36.314054|8.623085|0|ayoubbenhcin|Tunisia|3\n1|789086539691561|-37.194363|150.017338|5|Echidna|Australia|5\n1|839603534961919|52.640080|-7.272673|0|annekaro|Ireland|0\n1|487392130596175|14.692897|120.980591|4|kaartcam|Philippines|4\n1|735023758692827|-16.396393|30.882490|3|Kennedy Jomokela|Zimbabwe|3\n1|1138859374786620|-11.707758|43.252276|3|Harsake|Comoros|3\n1|1099106764562050|35.082347|-85.314147|1|rking|United States of America|1\n1|386062480842193|40.822025|-97.984910|1|Mosaic51 Dylan|United States of America|1\n1|944339739657153|43.119899|131.876408|4|trolleway|Russia|4\n1|787859923303372|-36.805481|174.639703|5|ralley|New Zealand|5\n1|405397654374756|55.824396|37.252933|4|Krasnogorsk360|Russia|0\n1|891477968580835|-36.535106|146.059811|5|radiotrefoil|Australia|5\n1|619601273214577|46.072345|-84.128792|1|networklanman|United States of America|1\n1|1425039692562278|24.463341|39.609289|3|mahmoud12|Saudi Arabia|4\n1|163366139123699|18.803587|95.288211|4|taroo|Myanmar|4\n1|888689865801977|-12.142006|-76.995781|2|kaart5|Peru|2\n1|380622074390840|49.476833|-119.610750|1|pavlohladysh|Canada|1\n1|1097575221408005|41.963826|43.830442|4|bumbeishvili|Georgia|4\n0|1e26ac1f-227c-437e-9ef9-41db4cee5bea|54.030322|14.767394|0|dominik88|Poland|0\n1|980010744968549|50.857069|8.816630|0|tim3003|Germany|0\n1|290142779717764|-16.824770|145.641642|5|coreagc|Australia|5\n1|113684750883906|-11.362949|142.402364|5|coreagc|Australia|5\n1|747327278057290|6.028408|80.217342|4|gazaly|Sri Lanka|4\n1|416757851261231|4.090427|-72.963881|2|juanmelo|Colombia|2\n1|1269786295142663|-20.100949|-44.414077|2|clovisslmb|Brazil|2\n1|477091833621153|59.422134|24.772996|0|ESTmapper1001|Estonia|0\n1|2390271611135542|-8.365394|-78.869924|2|kaart 2|Peru|2\n1|1240732944086518|-17.791994|-63.179403|2|Wakamolee|Bolivia|2\n1|990981163907954|44.096646|11.841967|0|mircozorzo|Italy|0\n1|1576675023885977|35.752738|-78.502563|1|NagendraMokkapati|United States of America|1\n1|180087737332681|33.588367|-7.642747|3|immergismap|Morocco|3\n1|860028414718004|32.805302|34.972072|3|trigSkarim|Israel|4\n1|563238256004817|54.428353|-105.797411|1|boxer123|Canada|1\n1|487465225703586|46.804809|-71.225783|1|BPRSTC|Canada|1\n1|1059214109053109|45.709181|4.851747|0|Yann Lyteco|France|0\n1|612353569742188|26.294938|50.213841|4|mahmoud12|Saudi Arabia|4\n1|827155331517987|33.356197|-7.094389|3|immergismap|Morocco|3\n1|791232890692489|-42.144722|-73.719220|2|Gines Agurto|Chile|2\n1|1458414128251176|-0.533692|166.940048|5|flashkiwi|Nauru|5\n1|769572470428637|52.247749|-7.079250|0|dave683|Ireland|0\n1|2768471303403114|55.752627|52.391214|4|vovenarg|Russia|0\n1|186139900048923|3.767358|34.725855|3|brunosan|Kenya|3\n1|443509810413582|46.620960|74.331932|4|Arystan|Kazakhstan|4\n1|458594445828154|1.420286|32.186420|3|federicodebetto|Uganda|3\n1|814168703512346|40.187513|44.509999|4|vlivyur|Armenia|4\n1|3015878212026733|40.847348|-115.800149|1|rking|United States of America|1\n1|2185414248500430|-37.822042|145.227298|5|ozmarksmatthew|Australia|5\n1|1339184587158308|-26.124694|28.071887|3|abarnes|South Africa|3\n1|1989680935259570|40.905647|29.274666|0|burakonder|Turkey|4\n1|739361105503685|14.512267|104.090746|4|ThailandCambodia|Thailand|4\n1|3922212677864457|-35.671692|-64.940106|2|jdieser|Argentina|2\n1|994617805848047|43.535235|-0.747228|0|sogefi|France|0\n1|1685783726113093|-11.734149|43.249510|3|Harsake|Comoros|3\n1|306033767591519|21.486164|39.185472|3|iahmed|Saudi Arabia|4\n1|887997788960928|-29.055868|167.958837|5|flashkiwi|Norfolk Island|5\n1|4395755457316340|15.369248|99.680084|4|kasidetma|Thailand|4\n1|1494139628098671|34.285756|-118.534219|1|schpok|United States of America|1\n1|1460109115731923|10.269382|123.839715|4|Kaart 360|Philippines|4\n0|34c29f5d-48e5-4018-b18e-8069bd859d3b|40.715778|30.568106|4|burakonder|Turkey|4\n1|1209461921052335|7.122436|125.614030|4|kaart 360|Philippines|4\n1|2121632648790854|4.610092|-74.158563|2|cgalindop|Colombia|2\n1|792005439059523|-0.094922|34.278561|3|quantiscale|Kenya|3\n1|1368642274559305|-41.111905|-73.065701|2|Kaart Local|Chile|2\n1|1197163484625186|-0.638788|-72.350950|2|juanmelo|Colombia|2\n1|1708914222625615|40.849214|48.388847|4|westbam|Azerbaijan|4\n1|499675234494214|55.786898|49.173004|4|ngeos|Russia|0\n1|1588170398580611|-32.002988|152.565661|5|Eucalyptus|Australia|5\n1|1028740724953259|-26.821956|153.059236|5|LukeCWalton|Australia|5\n1|924054095114435|54.941778|82.887951|4|obivankenobi|Russia|4\n1|495303695240764|43.871365|10.813726|0|klimakas|Italy|0\n1|3023325987951844|31.879360|-102.508519|1|rking|United States of America|1\n1|467306001027363|59.419764|24.767377|0|svimik|Estonia|0\n1|595547178502567|6.588791|3.958332|3|moriwo|Nigeria|3\n1|410807678686949|58.157862|22.189492|0|richlv|Estonia|0\n1|391886428561690|47.935395|107.427305|4|l1ndemann|Mongolia|4\n1|3734863733392566|42.551629|-114.429850|1|bbuddha|United States of America|1\n1|2311421355957525|27.290107|81.257623|4|vishalneogeo|India|4\n1|3270109206636393|46.779771|-89.054432|1|networklanman|United States of America|1\n1|2435622190267149|47.555864|-94.884977|1|cartographer|United States of America|1\n1|917918573480699|41.681892|44.859843|4|bumbeishvili|Georgia|4\n1|502612578474565|40.268773|-83.379442|1|opsstreetscan|United States of America|1\n1|5667890693318625|49.160910|72.731698|4|kazrap|Kazakhstan|4\n1|116856791037481|58.957659|5.588155|0|catoandersen|Norway|0\n1|696664286143731|-6.052528|155.404288|5|PNGDOWH|Papua New Guinea|5\n1|1016158769989564|40.933677|-90.364827|1|hmhtb|United States of America|1\n1|957079526312250|33.080796|-96.857110|1|eyoung wsb|United States of America|1\n1|1600254864198820|-33.458736|-70.674733|2|kaart 360|Chile|2\n1|893284721249538|15.778881|78.056892|4|geomannar|India|4\n1|705623752371523|-30.591157|-69.331720|2|contactoacve|Argentina|2\n1|1327147908032549|52.152070|-106.620562|1|sbailey|Canada|1\n1|169953625534036|-29.008615|167.931146|5|flashkiwi|Norfolk Island|5\n1|1248685103285442|49.019007|-97.975812|1|EnduiCA|Canada|1\n1|478628217969109|50.258538|9.296384|0|Planungsgesellschaft RV|Germany|0\n1|4396339103921731|45.856132|-97.626062|1|GIS ISG|United States of America|1\n1|1331231475889537|-8.824002|115.142005|5|Kaart 360|Indonesia|4\n1|675187538140533|45.580567|-106.625315|1|adamroads|United States of America|1\n1|945789071023261|45.613416|-75.637347|1|Moathe|Canada|1\n1|777701157326217|45.973684|24.147066|0|Pill0r360|Romania|0\n1|4265420430225915|18.459604|109.857027|4|adirricor|China|4\n1|1280390316676309|43.385189|77.089753|4|kazrap|Kazakhstan|4\n1|959058246701529|-45.208995|170.251931|5|skillsy|New Zealand|5\n1|1630904581387610|51.761174|-9.843369|0|annekaro|Ireland|0\n1|853737126594734|13.442670|-16.686941|3|GambiaStreetView|Gambia|3\n1|728736519883544|-37.750861|145.082104|5|andpen|Australia|5\n1|795896864392807|-6.190317|39.208083|3|federicodebetto|Tanzania|3\n1|302566534865666|38.977570|68.762747|4|kavinda|Tajikistan|4\n1|2797644377113054|-16.431166|-40.120970|2|MuitoAlemdasFronteiras|Brazil|2\n1|871994608153961|-52.537370|-69.981365|2|jloaiza|Chile|2\n1|1116875182055062|-20.277082|148.697123|5|esriau 1topo|Australia|5\n1|361308222874716|24.603007|46.630027|3|GreenRiyadh|Saudi Arabia|4\n1|430573822954297|32.694481|-17.099595|3|geouma|Portugal|0\n1|2409226636126899|28.337506|-16.875813|3|trekviewed|Spain|0\n1|1129835926020388|33.092557|-16.335752|3|filipesilva|Portugal|0\n1|2052053655685650|10.396373|10.403980|3|bauchicea|Nigeria|3\n1|8027814100579151|32.759730|-16.799436|3|geouma|Portugal|0\n1|278328671781939|-21.935485|-48.015269|2|Softmapping|Brazil|2\n1|1887758855378372|25.404768|82.929634|4|subhash geo|India|4\n1|516549513089873|-17.785090|178.450335|5|flashkiwi|Fiji|5\n0|614af279-7ee8-43ca-a3b7-f993d3ce9287|39.419597|-82.529255|1|Lake e|United States of America|1\n1|1251663816153425|-34.532673|-58.509271|2|kaart 360|Argentina|2\n1|144692334881420|-28.337924|27.638682|3|infratec|South Africa|3\n1|2989633827940235|49.236665|-98.024343|1|spread9|Canada|1\n1|537938408942471|22.230907|104.921293|4|theonenetwork|Vietnam|4\n1|704716018461226|-43.503553|172.683722|5|blackmapsmaksym|New Zealand|5\n1|672028888599193|38.534357|-1.700297|0|AdgobaAlvac|Spain|0\n1|946182818247703|44.631995|-98.075716|1|GIS ISG|United States of America|1\n0|26e1f715-8e8f-4600-a198-696919b51da5|-43.805347|-65.496015|2|Bastian Greshake Tzovara|Argentina|2\n1|375608033718741|34.051506|-84.189018|1|nickoday|United States of America|1\n1|508584066958634|-20.839423|-41.116616|2|360|Brazil|2\n1|1229431841716005|31.679614|-116.511074|1|streetmaps|Mexico|1\n1|1085874375408590|42.481997|-8.617846|0|sgonzalezd|Spain|0\n1|2088356655273730|52.578035|5.543168|0|thewizard|Netherlands|0\n1|849035480458257|-37.257682|150.047073|5|Echidna|Australia|5\n1|1611965200345556|47.184997|26.741562|0|DARIUSDINCA|Romania|0\n1|2796692737246827|29.188740|47.886181|3|takethebuskw|Kuwait|4\n1|1050362364093915|-41.295348|174.897154|5|PhillCook|New Zealand|5\n1|352618964398710|45.646782|-106.533431|1|adamroads|United States of America|1\n1|154211397001248|44.914233|-93.136334|1|louckssurveying|United States of America|1\n1|549053187286252|47.288566|-88.254348|1|networklanman|United States of America|1\n1|1555864896028110|28.492849|-16.340552|3|MttoviarioAPIlalaguna|Spain|0\n1|2257925841307985|41.065177|-112.056782|1|flug32|United States of America|1\n1|1812103552667462|-6.453342|155.407963|5|PNGDOWH|Papua New Guinea|5\n1|847507430903195|-5.842371|144.532546|5|PNGDOWH|Papua New Guinea|5\n1|771515721342226|59.237052|17.987210|0|bruno360|Sweden|0\n1|618576439436527|7.106200|-73.124825|2|innerpace360|Colombia|2\n1|951919730704507|-41.130663|175.026240|5|PhillCook|New Zealand|5\n1|385946867843216|31.662354|-116.518129|1|streetmaps|Mexico|1\n1|163073133484286|-22.783357|-41.977754|2|360|Brazil|2\n1|617107824315467|-42.801944|-72.649293|2|Kaart Local|Chile|2\n1|1778910619301231|-36.813653|149.937535|5|Echidna|Australia|5\n1|215506453416517|53.250668|-113.190114|1|spread3|Canada|1\n1|3042134846057742|36.600244|-5.330842|0|javiersanp|Spain|0\n1|1030173400869242|-21.957916|-44.887537|2|prefeiturabaependimap|Brazil|2\n1|2058653747945859|39.940751|64.406434|4|thoughtspark|Uzbekistan|4\n1|1186767161767951|50.978781|5.784227|0|rpleupen|Netherlands|0\n1|1577638700414168|39.864906|4.145001|0|trekviewed|Spain|0\n1|469805794763502|18.286378|109.679340|4|adirricor|China|4\n1|1273796530671635|32.648145|-16.846281|3|PedroSantos|Portugal|0\n1|1401598570411031|35.687541|139.736592|4|mura|Japan|4\n0|69cf1d18-88db-4396-926e-4d9f9a6720cf|28.081736|-14.291639|3|Sylvain M|Spain|0\n1|703144798550981|-29.274889|141.988608|5|Kangaroo|Australia|5\n1|745192493321156|40.910139|37.483163|4|cbsordu|Turkey|4\n1|823530148954010|3.738033|34.750632|3|duncankebut|Kenya|3\n1|440888661110739|26.223997|-97.701958|1|rking|United States of America|1\n1|1456399162633628|33.025760|10.168084|3|ayoubbenhcin|Tunisia|3\n1|207447094728662|57.252798|37.151193|4|ivangeo|Russia|0\n1|289521079500854|49.340199|-98.693349|1|spread8|Canada|1\n1|1812457646334345|10.992961|106.749567|4|bemaps3 sg|Vietnam|4\n1|865595748571040|32.738405|-87.585754|1|jeffreymartin|United States of America|1\n1|1013502271331143|48.963465|-97.825037|1|GIS ISG|United States of America|1\n1|723886856801167|18.108603|83.162948|4|Catto|India|4\n1|1247478619994897|41.750212|44.802973|4|bumbeishvili|Georgia|4\n1|260618005798495|54.586213|25.169831|0|vms|Lithuania|0\n1|625403473065980|59.962770|10.772533|0|OsloGeo Ola Juul Holm|Norway|0\n1|285401673334605|51.165285|94.456356|4|survaero|Russia|4\n1|5440296632661398|-4.978577|39.853234|3|federicodebetto|Tanzania|3\n1|7943890242380472|-45.034983|-72.115789|2|Kaart Local|Chile|2\n1|1378385882619946|53.387662|-2.910596|0|markagreen14|United Kingdom|0\n1|221069399489670|35.772971|51.977949|4|behzad62elahi|Iran|4\n1|2193900620978968|10.701118|106.625893|4|bemaps3 sg|Vietnam|4\n1|271997204579926|59.839122|117.865344|4|trolleway|Russia|4\n1|928217774955572|-36.796004|174.717270|5|ralley|New Zealand|5\n1|1042132103392265|-22.765393|-41.941739|2|360|Brazil|2\n1|2169654306517740|52.367075|23.379090|0|PesDyuck|Belarus|0\n1|355638937138522|-34.634816|150.722589|5|Echidna|Australia|5\n1|1163234225390488|-8.667771|120.145258|5|rgtm ryuiki|Indonesia|4\n1|942306398775431|-45.221976|169.368496|5|skillsy|New Zealand|5\n1|1070292304507230|22.997721|72.665709|4|skysign|India|4\n0|6c3251bc-9722-4a56-b71a-f3e320e6f1b7|28.101961|-14.355667|3|gonnzo|Spain|0\n1|1590490951479898|31.951605|34.931589|3|jeffreymartin|Israel|4\n1|1427079536100336|-41.109235|175.152153|5|PhillCook|New Zealand|5\n1|1057368085738270|42.653165|23.170725|0|alexanderbtodorov|Bulgaria|0\n1|1948665852371175|45.767457|106.275131|4|INsta3600|Mongolia|4\n1|162193322387378|57.410788|107.603473|4|trolleway|Russia|4\n1|972068664955801|-1.438211|-48.483807|2|mapconcierge|Brazil|2\n1|7958671877530669|-32.330927|152.534452|5|Eucalyptus|Australia|5\n1|697659271936426|51.688967|73.337016|4|kazrap|Kazakhstan|4\n1|2107578366484295|-16.464978|-54.645207|2|PMR|Brazil|2\n1|625664580151919|52.776368|41.382129|4|kirikset|Russia|0\n1|1403137524041735|52.351582|-7.417460|0|annekaro|Ireland|0\n1|1027902152371827|-26.531607|153.092251|5|LukeCWalton|Australia|5\n1|820759886146394|-26.528009|29.966680|3|Infratec2024|South Africa|3\n1|2184633631889685|5.623389|-0.008244|3|office141k|Ghana|3\n1|398644619645880|41.406602|-83.453240|1|andy adn|United States of America|1\n1|1157707037990467|41.838916|-111.809884|1|rking|United States of America|1\n1|966763061486443|-8.568889|125.567278|5|NOD|Timor-Leste|4\n1|1413070813580421|8.475644|-13.238581|3|mohamedTuray|Sierra Leone|3\n1|487704166719338|5.158214|5.679547|3|michael212|Nigeria|3\n1|1390115594929439|-34.714013|143.608504|5|Kangaroo|Australia|5\n1|926913052677793|52.799388|-67.090158|1|zombiegraph|Canada|1\n1|986005387504381|-8.634798|115.223156|5|Kaart 360|Indonesia|4\n1|971695331236538|59.489390|8.644406|0|VegvesenITS|Norway|0\n1|1264392591984475|34.451559|8.096778|3|amorToun|Tunisia|3\n1|300587496256475|40.677817|-89.640472|1|hmhtb|United States of America|1\n1|459251650190681|54.111589|77.791638|4|Sonnik|Russia|4\n1|130034549569093|50.632536|-115.227969|1|tomvh|Canada|1\n1|1758548221555935|-0.416393|36.141532|3|danbomett|Kenya|3\n1|1031530991315481|37.643651|-77.521141|1|echostorm|United States of America|1\n1|915695209004235|29.326781|48.089808|3|takethebuskw|Kuwait|4\n1|2460521044091315|-1.623857|29.015812|3|tojoaro|Democratic Republic of the Congo|3\n1|249299040317409|55.603640|38.136215|4|trolleway|Russia|0\n1|531355901356934|37.515272|140.381186|4|jmmapiranger|Japan|4\n1|150867287458908|-25.648447|-48.452781|2|CTMGEO|Brazil|2\n1|1633755187781042|4.671667|-74.052351|2|cgalindop|Colombia|2\n1|1828926464651382|-3.970500|39.751306|3|GetFound Africa|Kenya|3\n1|1884374611712472|51.599252|43.075549|4|saramonitoring|Russia|0\n1|1993601287459958|-0.892811|29.777840|3|jfrek|Uganda|3\n1|968664195876772|42.658487|23.331539|0|elboertjie|Bulgaria|0\n1|1095744294617921|57.316764|32.087209|4|Otvertka|Russia|0\n1|1032615258687955|52.305523|-6.881038|0|annekaro|Ireland|0\n1|347375698320159|43.743172|-89.197961|1|greenline|United States of America|1\n1|1468665793904136|13.813485|100.081558|4|NAKHONPATHOM CITY STREET|Thailand|4\n1|1047984585060904|-37.809480|144.895794|5|skillsy|Australia|5\n1|1059596781711737|36.210412|29.505850|0|asturksever|Turkey|4\n1|208633861094618|-22.280055|166.443510|5|flashkiwi|New Caledonia|5\n1|2059490224798604|7.833959|6.084195|3|Newwaves123|Nigeria|3\n1|957751358229533|40.875102|37.515472|4|cbsordu|Turkey|4\n1|700224182974019|37.559908|127.006429|4|lisbethw1130|South Korea|4\n1|1875897506198895|-3.735822|-38.520768|2|matheusgomesms|Brazil|2\n1|2086770335233398|41.403513|-123.994332|1|MEW Utilities|United States of America|1\n1|547438121390425|-52.956944|-70.836673|2|jloaiza|Chile|2\n1|979651789437071|51.159174|94.478763|4|survaero|Russia|4\n1|1829080554578334|22.800881|104.981834|4|theonenetwork|Vietnam|4\n1|941411407227162|51.568560|-117.597789|1|jenningsanderson|Canada|1\n1|442335968113208|45.217835|-88.087066|1|Driver523|United States of America|1\n1|1428148164343068|12.674570|101.277883|4|syncnook|Thailand|4\n1|1190446099512738|-31.338215|-61.233582|2|gastonkees|Argentina|2\n1|1108556194393947|52.943782|-66.904545|1|zombiegraph|Canada|1\n1|914878343017441|51.701764|73.134194|4|kazrap|Kazakhstan|4\n1|1071719897075261|42.449615|-2.344780|0|alvacmri|Spain|0\n1|1294216249003529|-26.500894|28.349326|3|Infratec2026|South Africa|3\n1|3444897138994084|32.750917|-16.825912|3|geouma|Portugal|0\n1|312630097164299|43.127831|-70.929048|1|cholloway|United States of America|1\n1|530467042807611|39.976936|-86.096059|1|opsstreetscan|United States of America|1\n1|605790692179026|39.928351|64.374329|4|thoughtspark|Uzbekistan|4\n1|552245694298402|-41.972301|-72.471301|2|Kaart Local|Chile|2\n1|819229770610248|30.999171|130.659914|4|yasunari|Japan|4\n1|2005372110408760|40.804827|29.430834|0|burakonder|Turkey|4\n1|698276325472126|40.188467|44.513640|4|vlivyur|Armenia|4\n1|334101602104589|48.142785|-80.029983|1|opsstreetscan|Canada|1\n1|605885873704766|28.327738|-16.876487|3|javiersanp|Spain|0\n1|360526215513192|31.920742|-102.294564|1|rking|United States of America|1\n1|111099262023552|-41.662026|-73.197876|2|Kaart Local|Chile|2\n1|936357354203113|50.308341|-122.634602|1|networklanman|Canada|1\n1|2912524439058946|5.357964|-4.052565|3|cign|Côte d’Ivoire|3\n1|266670159356228|46.863195|19.924574|0|Antissimo|Hungary|0\n1|1352284685655691|21.013581|105.815597|4|bemaps2 hn|Vietnam|4\n1|184855400152520|-9.761473|147.511144|5|jthnz|Papua New Guinea|5\n1|850790127598860|-37.022371|-73.152827|2|SolutivaSistemas|Chile|2\n1|607754380600007|59.949033|10.883695|0|BYM OlaJuulHolm|Norway|0\n1|1936122186802982|-36.828868|149.934644|5|Echidna|Australia|5\n1|316492820831319|-26.677507|153.117450|5|LukeCWalton|Australia|5\n1|579364477986495|23.213605|105.197394|4|theonenetwork|Vietnam|4\n1|1058329082162907|-27.736729|152.990403|5|ianstephenson|Australia|5\n1|1355889572239682|-33.553048|-70.566916|2|kaart 360|Chile|2\n1|1342747513065171|-34.662070|143.526141|5|Kangaroo|Australia|5\n1|2035521163466731|-17.399946|-66.049630|2|kaart 2|Bolivia|2\n1|952100865555305|46.725365|-117.004331|1|ryanotto|United States of America|1\n1|2033840917510483|51.703202|73.120145|4|kazrap|Kazakhstan|4\n1|923521606672479|41.778368|13.344499|0|odiug|Italy|0\n1|833558655626712|36.567763|26.352154|0|supco survey|Greece|0\n1|1043744500156068|43.396047|76.800572|4|kazrap|Kazakhstan|4\n1|2286169931716601|55.758822|-3.998489|0|Walk Wheel Cycle Trust|United Kingdom|0\n1|876175116296952|14.782761|-17.378119|3|ismailaseye|Senegal|3\n1|943380743143870|52.434648|-7.233174|0|dave683|Ireland|0\n1|1651942252021832|-1.452236|-48.476475|2|mapconcierge|Brazil|2\n1|872155677993413|-43.512693|172.680211|5|blackmapsmaksym|New Zealand|5\n1|2590791074427327|-23.577473|-70.390994|2|Gduran|Chile|2\n1|4161507300841192|39.939418|3.825598|0|trekviewed|Spain|0\n1|787586050339558|27.198515|81.412281|4|vishalneogeo|India|4\n1|479180311004941|-29.046687|167.945252|5|flashkiwi|Norfolk Island|5\n1|583789050512132|35.696950|140.862470|4|mura|Japan|4\n1|281722410345419|6.607048|79.957962|4|chameera|Sri Lanka|4\n0|a30bf3cc-2026-466e-9107-ebb4faf59dae|56.026200|92.838431|4|coteyka|Russia|4\n1|3081034278881533|-16.834322|145.646831|5|coreagc|Australia|5\n1|105781549012322|53.326206|-3.124711|0|jg360|United Kingdom|0\n1|3275500779218900|35.715557|52.062340|4|behzad62elahi|Iran|4\n1|787286073376533|9.087133|-79.397159|2|kaart5|Panama|1\n1|1513049449934760|-16.078498|30.265743|3|Tadiwamachisi|Zimbabwe|3\n1|924603282956011|-44.129694|-72.457348|2|Kaart Local|Chile|2\n1|656698610182922|49.003386|8.830722|0|RadNETZ|Germany|0\n1|1022522669272406|32.653490|-16.817918|3|PedroSantos|Portugal|0\n1|1188353776303880|52.418496|-7.358328|0|annekaro|Ireland|0\n1|1096818515863034|3.933731|39.743305|3|GetFound Africa|Ethiopia|3\n1|1188146009093286|11.936168|108.446952|4|theonenetwork|Vietnam|4\n1|1043100514966219|36.600902|24.941749|0|trekviewed|Greece|0\n1|1644746493464289|-41.251398|174.911284|5|PhillCook|New Zealand|5\n1|935906233909211|-33.954781|151.135106|5|aharvey|Australia|5\n1|2305455709812502|5.339548|30.280082|3|Kennedy Jomokela|South Sudan|3\n1|1388625682170778|-26.212937|28.080041|3|abarnes|South Africa|3\n1|613562317319641|26.122257|-97.170399|1|rking|United States of America|1\n1|575217598781617|-20.326362|-69.728094|2|Kaart Local|Chile|2\n1|370756130909964|58.716004|110.890882|4|trolleway|Russia|4\n1|2119096941949483|41.327941|-72.989712|1|ctroadway360|United States of America|1\n1|1572414969917427|30.036255|30.975690|3|Alaa8|Egypt|3\n1|1205805837666691|-11.256198|-61.902124|2|jaderbavaresco|Brazil|2\n1|1014366041285242|53.739843|-78.573254|1|michelcouturemotomcm|Canada|1\n1|3061082674181637|50.848211|-114.856070|1|tomvh|Canada|1\n1|1521302485481671|11.443863|107.719719|4|LANG THANG KHAP PHO|Vietnam|4\n1|754979091837281|34.074143|-117.265719|1|rking|United States of America|1\n1|4523888311003729|-20.091412|-44.288264|2|Amplomap360|Brazil|2\n1|767974222225739|-20.383681|-70.168381|2|Kaart Local|Chile|2\n1|595815035142674|16.055635|103.652751|4|nuttawutbunta|Thailand|4\n1|1436482573619601|31.339916|35.387507|3|jeffreymartin|Israel|4\n1|308960504216643|25.552596|-103.427147|1|innerpace360|Mexico|1\n1|1336716951234087|-41.107125|175.155484|5|PhillCook|New Zealand|5\n1|815703745997232|55.793449|49.125999|4|kirillngeos|Russia|0\n1|3905558956226017|-9.663922|147.433216|5|jthnz|Papua New Guinea|5\n1|320865666046166|-54.435002|-36.188006|2|interact||-1\n1|1369001700153652|55.348327|21.583452|0|lakd|Lithuania|0\n1|307495620831658|18.305498|42.720856|3|ehabeid|Saudi Arabia|4\n1|1112102024279463|-5.015625|119.682657|5|rgtm ryuiki|Indonesia|4\n1|3797552363884613|47.051767|28.847633|0|Sku1255|Moldova|0\n1|982787019137033|46.911960|-124.115041|1|uwrapid|United States of America|1\n1|884865265572064|31.787652|-102.497243|1|rking|United States of America|1\n1|2425260841010651|10.892990|106.618319|4|bemaps3 sg|Vietnam|4\n1|331812083182943|-35.685964|150.295888|5|Echidna|Australia|5\n1|1043969421161377|-33.419895|-70.741175|2|AntonioValenzuela|Chile|2\n1|244451468065732|31.348608|-109.554956|1|rking|United States of America|1\n1|457737621960851|-32.139437|135.134796|5|josh g|Australia|5\n1|501504677669329|55.798028|49.141201|4|ngeos|Russia|0\n1|1205356597179309|43.420458|76.880827|4|kazrap|Kazakhstan|4\n1|827192458179954|-22.229148|166.520654|5|ratzillas|New Caledonia|5\n1|1555679865633678|-35.568174|174.359355|5|timwardWDC|New Zealand|5\n1|1104034633658523|-5.379928|39.683459|3|federicodebetto|Tanzania|3\n1|730397335524539|53.836487|-107.023334|1|boxer123|Canada|1\n1|1251006689891631|-36.597478|174.672590|5|ralley|New Zealand|5\n1|1585327015917721|-41.115622|175.223557|5|PhillCook|New Zealand|5\n1|183570740298936|45.849746|27.422341|0|bogdancandrea|Romania|0\n1|8539061256188520|-8.549284|125.540462|5|NOD|Timor-Leste|4\n1|1038566572461111|28.517972|-16.394692|3|MttoviarioAPIlalaguna|Spain|0\n1|2423877537756466|28.204228|83.945092|4|javiersanp|Nepal|4\n1|128954769491024|40.978061|29.180217|0|ademturkmen|Turkey|4\n1|1166634488639533|-35.334924|-62.446686|2|Ale011988|Argentina|2\n1|1134950760419021|43.958111|2.153503|0|Remyv|France|0\n0|e70f006a-cd59-48f6-813f-fce48f1b54ae|-3.745789|-38.578368|2|matheusgomesms|Brazil|2\n1|1138671880253619|-4.948451|39.742043|3|federicodebetto|Tanzania|3\n1|192869622673163|16.373826|95.267297|4|ckkw|Myanmar|4\n1|401594495972592|-36.674119|-72.286505|2|ClauMora|Chile|2\n1|1032375578611512|39.450321|20.360796|0|supco survey|Greece|0\n0|db3955e6-f45a-459d-94a1-1427b25ade73|42.340309|-3.705475|0|motocultrice|Spain|0\n1|379114941903519|-23.419789|-57.442919|2|juliaoporto|Paraguay|2\n0|0e433041-09d5-4ab6-849b-ff34839910e2|36.232833|36.139806|4|panovia360|Turkey|4\n1|357029266123605|57.756105|40.943903|4|Kostroma360|Russia|0\n1|1654748042615238|40.908337|29.287635|0|burakonder|Turkey|4\n1|1929346244617898|56.865971|24.256308|0|ursus|Latvia|0\n1|919987894177595|40.807290|-115.826044|1|rking|United States of America|1\n1|168708976161563|40.508868|0.333853|0|ildecoco|Spain|0\n1|9991566727578018|-20.911737|-45.263622|2|IGTECH|Brazil|2\n1|1689978438985328|-6.367212|23.825433|3|bmitto|Democratic Republic of the Congo|3\n1|824869104823724|-6.271072|39.503714|3|federicodebetto|Tanzania|3\n1|1378438733775253|-38.402762|146.182973|5|spatiali|Australia|5\n1|1070997797220397|-4.415370|-39.242708|2|Amplomap360|Brazil|2\n1|363271633489240|46.869342|11.479606|0|giubar|Italy|0\n1|1196129392566148|-16.108705|30.417358|3|Tadiwamachisi|Zimbabwe|3\n1|824254959439857|41.109611|-122.328324|1|marker geo1|United States of America|1\n1|488125669806647|27.373949|99.963956|4|adirricor|China|4\n1|136377598523723|31.398163|35.066971|3|360ms|Palestine|4\n1|1757562815684007|43.001500|-89.510372|1|vgxhc|United States of America|1\n1|1421169721579073|-9.542694|147.292180|5|jthnz|Papua New Guinea|5\n1|1393305938767792|47.510603|-92.505452|1|RS EH MAPR 1|United States of America|1\n1|279352720313505|-32.105862|135.274989|5|josh g|Australia|5\n1|2044357606140716|31.891957|-112.818063|1|mapillary01730|United States of America|1\n1|1349892452750117|52.048654|13.488773|0|Altnowaweser|Germany|0\n1|502574412550959|54.730788|25.213997|0|vms|Lithuania|0\n1|1514283516119922|51.646087|-68.217960|1|zombiegraph|Canada|1\n1|835982442864901|-45.499483|170.128044|5|skillsy|New Zealand|5\n1|1456239675034257|46.393104|-72.306760|1|SebCherrierEXP|Canada|1\n1|1349972776056625|45.983835|-91.574025|1|iandees|United States of America|1\n1|812714772692667|-31.432416|-64.187960|2|kjuanman|Argentina|2\n1|658051963102957|-12.758988|45.230683|3|SIGMDZ|France|0\n1|1658592545426618|48.015461|-97.623687|1|GIS ISG|United States of America|1\n1|423733646640103|19.088961|72.843607|4|tranzitnotes|India|4\n1|624119367304856|-14.477360|-39.036886|2|mauriciomensura|Brazil|2\n1|384207088022473|25.718782|32.657018|3|vlad p|Egypt|3\n1|431369085629630|24.611144|46.632343|3|GreenRiyadh|Saudi Arabia|4\n1|804815532164760|59.910303|30.495658|4|catherinegautier|Russia|0\n1|1594131324104869|-45.867599|170.515482|5|stefanie|New Zealand|5\n1|2035108283329418|-16.848899|145.674797|5|coreagc|Australia|5\n1|531455464931336|14.517855|78.135170|4|geomannar|India|4\n0|a6f40d39-4b06-4eae-b1d3-cd2418c3cc55|-20.556333|-54.566444|2|JoasC|Brazil|2\n1|959667353444607|41.311150|-123.521526|1|marker geo1|United States of America|1\n1|1956801735140656|40.760740|-7.922513|0|sanjorgepinho|Portugal|0\n1|1362911217413634|59.862667|29.924829|0|trolleway|Russia|0\n1|1523764588385064|28.681922|77.074753|4|AkashHeliware|India|4\n1|866032291919489|32.085741|34.777112|3|jeffreymartin|Israel|4\n1|1098740147719065|39.956517|-86.113961|1|opsstreetscan|United States of America|1\n1|2988243244757306|-10.910514|142.249301|5|coreagc|Australia|5\n1|809178766669909|-17.644891|177.416254|5|flashkiwi|Fiji|5\n1|1632314144103774|6.182944|-75.594498|2|Itagui FN360|Colombia|2\n1|1200434601723514|-6.686294|155.734029|5|PNGDOWH|Papua New Guinea|5\n1|1427648051524200|-1.444877|-48.495494|2|mapconcierge|Brazil|2\n1|1787313092291342|36.561261|29.132831|0|trekviewed|Turkey|4\n1|2062359790629024|-11.017021|-51.945566|2|gmancilla|Brazil|2\n1|1136182763566686|53.186707|-113.043843|1|spread3|Canada|1\n1|2617368865130525|11.151235|107.621414|4|LANG THANG KHAP PHO|Vietnam|4\n1|335532398455132|-16.820163|145.634687|5|coreagc|Australia|5\n1|1184413346852658|-18.482261|-70.326687|2|SolutivaSistemas|Chile|2\n1|1060714095275924|39.149255|-91.903097|1|hmhtb|United States of America|1\n1|1528021871739989|-3.969054|39.739489|3|GetFound Africa|Kenya|3\n1|867936798125010|23.623241|58.579957|4|malhajri|Oman|4\n1|383689886891618|-35.888689|174.429179|5|ralley|New Zealand|5\n1|764287379623932|-2.918492|-79.015586|2|Hopen111|Ecuador|2\n1|1378134986321256|54.898569|10.338846|0|jenspeterhansen|Denmark|0\n1|397950421724057|-27.717634|153.089148|5|mattfarmer|Australia|5\n1|1426653171183952|30.603786|104.158489|4|adirricor|China|4\n1|318262970811289|46.144941|4.109934|0|capmoustache|France|0\n1|1894658428090821|-38.328428|146.261065|5|spatiali|Australia|5\n1|1714158936630322|-41.209836|174.899624|5|PhillCook|New Zealand|5\n1|390384803231948|26.157699|-97.678684|1|rking|United States of America|1\n1|1343686682988397|-8.338414|-74.568201|2|johnarupire|Peru|2\n1|557849705553032|40.991302|29.076386|0|ademturkmen|Turkey|4\n1|1684187883034280|43.609844|15.984051|0|SilvioBasic|Croatia|0\n1|1247696996888908|49.189804|-97.933390|1|EnduiCA|Canada|1\n1|1946044866145158|49.708228|-68.679323|1|ArchambaultR|Canada|1\n1|2231456380617013|-16.081765|-48.032136|2|helmert engenharia|Brazil|2\n1|147360784025698|32.715801|-114.729068|1|carl0sgm|United States of America|1\n1|463149254749460|53.250670|-113.371324|1|spread3|Canada|1\n1|595597686073290|40.393411|-91.380918|1|rking|United States of America|1\n1|236118402130175|37.291727|-80.076254|1|echostorm|United States of America|1\n1|3073424242961377|3.769519|34.727733|3|duncankebut|Kenya|3\n0|9fbe1486-eac0-4c75-8bf9-bfbcae6e59ae|30.377159|-97.966613|1|DayGeckoArt|United States of America|1\n1|187686993879048|50.003921|-110.643557|1|networklanman|Canada|1\n1|589663894174885|36.452982|25.424141|0|trekviewed|Greece|0\n1|2354496978055914|57.714258|15.282013|0|roadroid|Sweden|0\n1|4110563578966860|32.450450|35.169264|3|360ms|Palestine|4\n1|1095628605937927|-19.113386|33.483145|3|renaldoflor|Mozambique|3\n1|1003654930999124|39.351524|20.291371|0|supco survey|Greece|0\n1|1513247419493759|39.952047|21.969537|0|efikour|Greece|0\n1|839034413628979|32.851335|-8.542589|3|immergismap|Morocco|3\n1|326007689769699|-16.395138|30.964699|3|Kennedy Jomokela|Zimbabwe|3\n1|2287672371660575|19.885322|99.822835|4|SoT|Thailand|4\n1|2029125417888493|42.907600|-7.289371|0|AdgobaAlvac|Spain|0\n1|1184587225321466|-34.902695|138.498662|5|didz|Australia|5\n1|1618801462368017|10.451942|107.112151|4|lyduchuy|Vietnam|4\n1|486294625950027|33.519767|-102.008940|1|rking|United States of America|1\n1|1866333690706664|-34.139578|22.091464|3|Mossel Bay Municipality|South Africa|3\n1|2419362361540554|18.302430|42.717857|3|ehabeid|Saudi Arabia|4";

/* ── generated GeoGuesser reveal tables (country names + credit keys) ── */
/* GENERATED by tools/build_geo_credit_tables.js from server/geo_pool.json - DO NOT EDIT. */
/* Reveal lookup tables. GEO_COUNTRY_NAMES is indexed by a place code (see geoPlaceCode);
   GEO_CREDIT_KEYS is "source|provider", matching the pool's own rows. Both orders MUST
   match panorama/scripts/mg_geo_credits.generated.js, which renders what these name. */
const GEO_COUNTRY_NAMES = ["Angola","Argentina","Armenia","Australia","Austria","Azerbaijan","Bahamas","Bangladesh","Belarus","Belgium","Benin","Bolivia","Botswana","Brazil","Bulgaria","Cambodia","Cameroon","Canada","Central African Republic","Chile","China","Colombia","Comoros","Croatia","Cyprus","Czechia","Côte d’Ivoire","Democratic Republic of the Congo","Denmark","Ecuador","Egypt","Estonia","Ethiopia","Fiji","France","Gambia","Georgia","Germany","Ghana","Greece","Guam","Guernsey","Guinea","Guyana","Hong Kong","Hungary","India","Indonesia","Iran","Iraq","Ireland","Israel","Italy","Japan","Kazakhstan","Kenya","Kuwait","Latvia","Liberia","Lithuania","Macao","Madagascar","Malaysia","Malta","Mauritania","Mexico","Moldova","Mongolia","Morocco","Mozambique","Myanmar","Nauru","Nepal","Netherlands","New Caledonia","New Zealand","Nigeria","Norfolk Island","Norway","Oman","Palau","Palestine","Panama","Papua New Guinea","Paraguay","Peru","Philippines","Poland","Portugal","Romania","Russia","Rwanda","Saudi Arabia","Senegal","Serbia","Sierra Leone","Somalia","South Africa","South Korea","South Sudan","Spain","Sri Lanka","Suriname","Sweden","Switzerland","Taiwan","Tajikistan","Tanzania","Thailand","Timor-Leste","Tunisia","Turkey","Uganda","Ukraine","United Arab Emirates","United Kingdom","United States of America","Uruguay","Uzbekistan","Venezuela","Vietnam","Zimbabwe"];
const GEO_CREDIT_KEYS = ["0|Alixun","0|Bastian Greshake Tzovara","0|BrackoNe","0|DayGeckoArt","0|Eric S","0|Evgeniy360","0|Hopen111","0|Jean Louis Stanus","0|JoasC","0|JokerNZ","0|Lake e","0|Nzau","0|Preben Vangberg","0|R mi","0|RichmondRob","0|Sylvain M","0|ZX Streetview","0|amcrepin","0|b unicycling","0|borovac","0|burakonder","0|chch parks","0|coteyka","0|dehtiarne","0|doakey3","0|dominik88","0|gonnzo","0|johnarupire","0|luppano","0|matheusgomesms","0|motocultrice","0|n8aktiver","0|nave88","0|panovia360","0|slinky309","1|1335","1|360","1|360 m5 by","1|360ms","1|4htet","1|58zarali","1|AMYT","1|ANTT","1|AdgobaAlvac","1|Africa360view","1|AkashHeliware","1|Alaa8","1|Ale011988","1|Aliebvandy","1|Altnowaweser","1|Amplomap360","1|Antissimo","1|Antoniam","1|AntonioValenzuela","1|ArchambaultR","1|Arifyabarokah123","1|ArtzaiPY","1|Arystan","1|Atemiki","1|BPRSTC","1|BYM OlaJuulHolm","1|BlizzardBorn42Car","1|Bwarrior","1|CAROA TOPOGRAFIA AGRIMEN","1|CMPCONSULTORIA","1|CTMGEO","1|CTSteward","1|Catto","1|ChronicHiker","1|Cicero101","1|ClauMora","1|Constanzavr","1|ContraBand","1|CorenitnL","1|DARIUSDINCA","1|DNC","1|DanTsg","1|DariusP","1|Davvid23","1|Desireespindler","1|Driver523","1|ESTmapper1001","1|Echidna","1|Eebie","1|EnduiCA","1|Eucalyptus","1|FalconUae","1|Fedor 1","1|FiftyPence","1|Franklyn 1","1|GHDEdmond","1|GIS ISG","1|GISCUU","1|GMINGENIEROS","1|GSPLMukundhan","1|GambiaStreetView","1|Gduran","1|GetFound Africa","1|Gines Agurto","1|GreenRiyadh","1|HIPA","1|HKocen","1|Harsake","1|Hikerandy","1|Hinojal","1|Hopen111","1|IGTECH","1|INsta3600","1|Infratec2023","1|Infratec2024","1|Infratec2025","1|Infratec2026","1|Itagui FN360","1|Itsmerobinnn","1|JRickard WGA","1|Jborg88","1|Jhostin270","1|Josebaeza","1|Kaart 360","1|Kaart Local","1|Kangaroo","1|Kennedy Jomokela","1|KingRam","1|Kostroma360","1|Krasnogorsk360","1|LANG THANG KHAP PHO","1|LTC","1|LTuropolec","1|LaEstrella FN360","1|LightChild","1|LukeCWalton","1|MEW Utilities","1|MElbonet81","1|MarcAurel2","1|MarikaD","1|Mitchmiller","1|Moathe","1|Mosaic51 Dylan","1|Mossel Bay Municipality","1|MttoviarioAPIlalaguna","1|MuitoAlemdasFronteiras","1|NAKHONPATHOM CITY STREET","1|NOD","1|NagendraMokkapati","1|Nepal FRES","1|NesoddenKommuneSamferdse","1|Newwaves123","1|OMDTZ1","1|Oderradler","1|OsloGeo Ola Juul Holm","1|Otvertka","1|PMR","1|PMU B","1|PNGDOWH","1|PedroSantos","1|PerspektywaLokalna","1|PesDyuck","1|PhilipBroughton Mills","1|PhillCook","1|Pill0r360","1|Planungsgesellschaft RV","1|Possum","1|Power01","1|Protezione Civile FVG Ri","1|RS EH MAPR 1","1|RadNETZ","1|RandyXu","1|Remyv","1|RoloRoldana","1|RuanZ","1|SIG 3CO","1|SIGMDZ","1|ScenicRimRC","1|SebCherrierEXP","1|Shindai","1|Shirley1","1|Sicart360","1|SilvioBasic","1|Sitetour","1|Sku1255","1|SoT","1|Softmapping","1|SolutivaSistemas","1|Sonnik","1|SunriseTraffic","1|TNG Engineering","1|Tadiwamachisi","1|TanaponL","1|ThailandCambodia","1|Tim1","1|TomBrough2024","1|TonyMummery","1|Topbenbou","1|TramperUser","1|Transporte DSS","1|Twospatial","1|UAS ISG","1|Urbanisme Mobilites","1|VPTest","1|VdM","1|VegvesenITS","1|Wakamolee","1|Walk Wheel Cycle Trust","1|Wallaby","1|Wattle","1|Westower Braedyn","1|Y Suzuki","1|YMtest","1|Yann Lyteco","1|ZXStreetview","1|ZealandiaStreamwalkView","1|abarnes","1|aboynton","1|adamroads","1|ademturkmen","1|adiiba25","1|adirricor","1|afmk","1|aharvey","1|ainali","1|ainguane","1|akom","1|alantgeo","1|alexanderbtodorov","1|alotaibiuop","1|altaaro","1|alvacmri","1|amidave","1|ammarpak","1|amneimne","1|amorToun","1|amsterdam","1|andpen","1|andy adn","1|angoca","1|annekaro","1|arc ttl","1|armaz","1|arturngeos","1|arudir","1|aslakm","1|asturksever","1|atd2019","1|ayoubbenhcin","1|balu geo","1|bauchicea","1|bbuddha","1|bccdelta","1|beat","1|bede","1|behzad62elahi","1|bemaps2 hn","1|bemaps3 sg","1|benjidad","1|blackmapsmaksym","1|bmitto","1|bogdancandrea","1|bonhdg","1|borovac","1|boxer123","1|brackone","1|bricev","1|bruno360","1|brunosan","1|buffoon","1|bumbeishvili","1|burakonder","1|bwyatt516","1|byte2bit","1|c64","1|canfe","1|capmoustache","1|carfran79","1|carl0sgm","1|cartographer","1|catherinegautier","1|catoandersen","1|cbailey03","1|cbsordu","1|ccapv germain","1|ccb","1|cedionysis","1|cgalindop","1|chameera","1|chelseabrian","1|cholloway","1|chowe ICT","1|chrisbeddow","1|cign","1|ckkw","1|clovismapping","1|clovisslmb","1|codeproquo","1|codgis","1|comradely","1|comtacti","1|contactoacve","1|coreagc","1|crabkilla","1|ctroadway360","1|dabohamda","1|danbomett","1|datagis","1|dave683","1|davipt","1|di0v0n","1|didz","1|dilipshrikhande","1|dkarkasina","1|dkazemi1364","1|dontv","1|dpu transport","1|duncankebut","1|echostorm","1|eechingng","1|efikour","1|ehabeid","1|elboertjie","1|emanuel alejandro maciel","1|eneerhut","1|engelbertus","1|epoc","1|eraticwanderer","1|erias","1|eric s","1|eserte","1|eskilstuna kommun","1|esriau 1topo","1|ev1velodyssee","1|evilbunny","1|eyoung wsb","1|farmer798","1|federicodebetto","1|felipeeugenio","1|filipesilva","1|filohipo","1|flashkiwi","1|flug32","1|fur1aje1","1|fur1ksw1","1|fur1nnj4","1|gabinete falzoni","1|gallimaps","1|garok","1|gastonkees","1|gazaly","1|gdenholm","1|geocid","1|geodzer","1|geomannar","1|geoprem","1|geouma","1|geovelo","1|gertcb","1|giscoregroup","1|giubar","1|gluhov55","1|gmancilla","1|goteview","1|graharg","1|greenline","1|grozsa11","1|gtaylor","1|guigandra","1|guilhermez","1|hdmaps1","1|helmert engenharia","1|hmhtb","1|hokiangahick","1|iahmed","1|iandees","1|ianstephenson","1|ildecoco","1|immergismap","1|infopgt","1|infratec","1|innerpace360","1|inspectorl3","1|interact","1|investproekt","1|investpromvs","1|inwazjamb","1|irvinfly","1|ismaeltthds","1|ismailaseye","1|ivangeo","1|jacksoe","1|jaderbavaresco","1|javiersanp","1|jcaruso","1|jcox","1|jcpablo","1|jdieser","1|jeffreymartin","1|jenningsanderson","1|jenspeterhansen","1|jesseakaraccoon","1|jfrek","1|jg360","1|jiipeefin","1|jloaiza","1|jmfaria","1|jmmapiranger","1|joaocsampayo","1|joaourbano","1|jocem58265","1|johnarupire","1|josh g","1|jpabloroots","1|jpinar","1|jthnz","1|juanmelo","1|juliaoporto","1|kaart 2","1|kaart 3","1|kaart 360","1|kaart 4","1|kaart5","1|kaartcam","1|kahbeng","1|kasidetma","1|kavinda","1|kazrap","1|keithbcoa","1|keke","1|kirikset","1|kirillngeos","1|kjuanman","1|klimakas","1|kmc streets","1|kojiroucircle","1|kolesajr","1|kotkota15","1|kou kita","1|kristianstad","1|krojasSDM","1|l1ndemann","1|lakd","1|laminendiaye","1|launceston","1|lennartvdhorst","1|lisbethw1130","1|lmuffato","1|loglogy","1|louckssurveying","1|lyduchuy","1|mahmoud12","1|makro360","1|malhajri","1|mapconcierge","1|mapillary01730","1|marcuscalabresus","1|markagreen14","1|marker geo","1|marker geo1","1|matheusgomesms","1|mattfarmer","1|mauriciomensura","1|mbobcekpoco","1|mcd3","1|mednis","1|meldig","1|meteolasenia","1|mghla","1|michael212","1|michaelroach","1|michelcouturemotomcm","1|micheldavitt","1|microfauna","1|microsoft","1|milk man","1|mircozorzo","1|mkhan","1|mohamedTuray","1|mohammedshibu","1|moltgeo","1|monotaxism","1|moriwo","1|msamme","1|msingh","1|muntz man","1|mura","1|mycota","1|mystershaw","1|navcities","1|nboland","1|neogeografen","1|neogeoinfo","1|networklanman","1|ngeos","1|nglf","1|niallain","1|nickoday","1|niimostov","1|noamroze","1|nunocaldeira","1|nupano","1|nuttawutbunta","1|obivankenobi","1|odiug","1|office141k","1|okadatsuneo","1|okhtis","1|opsstreetscan","1|osmplus org","1|ost360vr Joscelin","1|osunga","1|ovvio","1|oxelosund","1|ozmarksmatthew","1|panovisual","1|paul ggat","1|pavlohladysh","1|pdorrohcityofaikensc","1|penncohwy","1|peterleth","1|pgehin","1|photosofafrica","1|pixelpete","1|pmfox97","1|pottawattamie","1|prefeiturabaependimap","1|pt360","1|quadrotest","1|quantiscale","1|quickness805","1|radiotrefoil","1|raffael","1|ralley","1|ratzillas","1|rawaz85","1|raxpa","1|recklessxpy","1|renaldoflor","1|renovate","1|rgtm ryuiki","1|ricardomadridg","1|richlv","1|riddelleng","1|rifrif","1|ripram","1|rking","1|roadroid","1|rodolfohcp","1|rolandovasq","1|rpleupen","1|rskorzus","1|ryanotto","1|ryosatake527","1|sanjorgepinho","1|santiagoperalta","1|sarahantos","1|saramonitoring","1|sbailey","1|schpok","1|seraq","1|serfim cit y","1|severingeo","1|sgonzalezd","1|shinling","1|shipovnick","1|sidi","1|sig eerssa","1|sige","1|simon geovelo","1|skfd","1|skillsy","1|skysign","1|slaheddinefateh","1|smarzaro","1|smithwa","1|snranjan","1|sogefi","1|solcaceresf","1|spatiali","1|spectrestudios","1|spread3","1|spread8","1|spread9","1|spring","1|srdpmapping","1|steer360network","1|stefan RolfsRom","1|stefanie","1|stephanep","1|stilldavid","1|stmaryscounty1","1|streetmaps","1|subhash geo","1|sunkins","1|sunkist","1|supaplex030","1|supco survey","1|survaero","1|svimik","1|syncnook","1|takethebuskw","1|tannewt","1|taroo","1|tayefbarikoi","1|teambolivia","1|tereshhenko55","1|theonenetwork","1|thewizard","1|thohi","1|thoughtspark","1|tim3003","1|timwardWDC","1|tm3594","1|tmka","1|tojoaro","1|tomburnett","1|tomvh","1|tonypd","1|tpenerga","1|tranzitnotes","1|trekviewed","1|trigSkarim","1|tritaporn","1|trolleway","1|trpd","1|trujilorenza","1|tyraayala","1|unisageoscience","1|urbanresearch","1|ursus","1|uwrapid","1|vansteelandt","1|velostas","1|vememi9618","1|vgrosso","1|vgxhc","1|viniciusmap","1|vishalneogeo","1|vlad p","1|vlivyur","1|vms","1|vorpalblade","1|vovenarg","1|vteck","1|waldyrious","1|wangxiaojiao","1|wassaf","1|wata909","1|weseraue2022","1|westbam","1|wojciechwalus","1|wsp us","1|wwmajor","1|xnoise","1|yangcedrick","1|yasunari","1|yuki charo","1|yumechan","1|yzhao","1|zaf3kala","1|zebjohnson","1|zombiegraph"];

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
/* global CompressionStream, GEO_COUNTRY_NAMES, GEO_CREDIT_KEYS, GEO_POOL_PACKED, PX_ALPHA, PX_LAND_SPANS, PX_PALETTE, PX_VIEW_PALETTE, adminAssetResponse, atob */
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
 *   /api/create?game=G&tok=T[&solo=1]             -> dCode(code, host=false)     new PRIVATE lobby, host = seat 0
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
 *   /api/geostate?code=C&tok=T                     -> round + guess/reveal/ready masks
 *   /api/geoview?code=C&tok=T                      -> proxied equirectangular panorama image
 *   /api/geoguess?code=C&tok=T&cell=N              -> (1,1) accepted · (9,x) rejected
 *                                                     cell is 0..GEO_GRID_W*GEO_GRID_H-1 (512x256)
 *   /api/geonext?code=C&tok=T                      -> ready handshake for the next round
 *   /api/geotarget|geopick&axis=0|1                -> ONE axis of a reveal point (x, then y):
 *                                                     512x256 no longer fits two base-63 levels
 *   /api/geoscore|geoinfo|geocredit                -> reveal-only GeoGuesser data, each ONE
 *                                                     reply of two base-63 levels (h=63 = error):
 *                                                     geoinfo = place code (0..5 region only,
 *                                                     6+n = country n), geocredit = index into
 *                                                     the shipped credit table
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
        "Authorization": `Bearer ${tokenBody.access_token}`,
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
  constructor(state, env) {
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
    this.geoImageCache = new Map(); // "source:id" -> { bytes, type }; bounded LRU
    // Mapillary needs a token to resolve an image URL at reveal time. Absent (or on a fresh
    // install) the game still runs on the Panoramax rows of the prebuilt pool.
    this.geoMapillaryToken = String(env && env.MG_MAPILLARY_TOKEN || "").trim();
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
      await this.storage.put(`l:${code}`, lobby);
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
      if (p === "/api/geostate") {
        const access = await geoLobbyAccess(this, code, q.get("tok"));
        if (!access.ok) return d(9, access.code);
        return geoStateReply(access.lobby.state);
      }
      if (p === "/api/geoview") {
        const access = await geoLobbyAccess(this, code, q.get("tok"));
        if (!access.ok) return d(9, access.code);
        const st = access.lobby.state;
        if (!st || st.round < 0 || st.round >= GEO_ROUNDS) return d(6, 63);
        return await geoPanoramaResponse(this, st.locations[st.round]);
      }
      if (p === "/api/geoguess") {
        const access = await geoLobbyAccess(this, code, q.get("tok"));
        if (!access.ok) return d(9, access.code);
        if (access.lobby.solo && access.seat !== 0) return d(9, 3);
        const st = access.lobby.state;
        const cell = Number(q.get("cell"));
        if (!st || st.round < 0 || st.round >= GEO_ROUNDS || st.reveal ||
            !Number.isInteger(cell) || cell < 0 || cell >= GEO_GRID_W * GEO_GRID_H) return d(9, 2);
        if (st.guesses[access.seat] != null) {
          return st.guesses[access.seat] === cell ? d(1, 1) : d(9, 1);
        }
        st.guesses[access.seat] = cell;
        if (access.lobby.solo) {
          const location = st.locations[st.round];
          st.guesses[1] = geoLatY(location.lat) * GEO_GRID_W + geoLonX(location.lon);
        }
        if (st.guesses[0] != null && st.guesses[1] != null) geoRevealRound(st);
        access.lobby.t = nowSeq();
        await this.storage.put(`l:${code}`, access.lobby);
        return d(1, 1);
      }
      if (p === "/api/geonext") {
        const access = await geoLobbyAccess(this, code, q.get("tok"));
        if (!access.ok) return d(9, access.code);
        if (access.lobby.solo && access.seat !== 0) return d(9, 3);
        const st = access.lobby.state;
        if (!st || !st.reveal || st.round < 0 || st.round >= GEO_ROUNDS) return d(9, 2);
        st.ready[access.seat] = 1;
        if (access.lobby.solo) st.ready[1] = 1;
        if (st.ready[0] && st.ready[1]) geoAdvanceRound(st);
        access.lobby.t = nowSeq();
        await this.storage.put(`l:${code}`, access.lobby);
        return d(1, 1);
      }
      if (p === "/api/geotarget" || p === "/api/geopick" ||
          p === "/api/geoscore" || p === "/api/geoinfo" || p === "/api/geocredit") {
        const access = await geoLobbyAccess(this, code, q.get("tok"));
        // Every route in this group now answers with two base-63 levels and reserves h=63 for
        // errors. geoinfo/geocredit used to use the (9, code) sentinel instead, which stopped
        // being safe the moment their success replies became indices: place code 9 is a real
        // country, so a client could not tell it from "lobby gone".
        if (!access.ok) return d(access.code, 63);
        const st = access.lobby.state;
        if (!st || !st.reveal || st.round < 0 || st.round >= GEO_ROUNDS) {
          return d(1, 63);
        }
        if (p === "/api/geotarget") {
          const location = st.locations[st.round];
          return geoPointAxisReply(
            geoLatY(location.lat) * GEO_GRID_W + geoLonX(location.lon), geoAxis(q));
        }
        // Both of these are single-reply INDICES now (two base-63 levels, h=63 = error sentinel,
        // matching the geoscore codec). The client turns them into text from tables it ships.
        if (p === "/api/geoinfo") {
          const place = geoPlaceCode(st.locations[st.round]);
          return d(place % 63, Math.floor(place / 63));
        }
        if (p === "/api/geocredit") {
          const credit = geoCreditCode(st.locations[st.round]);
          if (credit < 0) return d(3, 63);
          return d(credit % 63, Math.floor(credit / 63));
        }
        const requestedSeat = Number(q.get("seat"));
        // Only geoscore and geopick take a seat; geoinfo/geocredit have already returned above.
        if (!Number.isInteger(requestedSeat) || requestedSeat < 0 || requestedSeat > 1) {
          return d(2, 63);
        }
        if (p === "/api/geopick") {
          const picked = st.guesses[requestedSeat];
          return picked == null ? d(1, 63) : geoPointAxisReply(picked, geoAxis(q));
        }
        const score = Math.max(0, Math.min(4095, st.scores[requestedSeat] | 0));
        return d(score % 63, Math.floor(score / 63));
      }

      if (p === "/api/create") {
        await this.maybeSweep();
        const game = clampInt(q.get("game"), 1, 1, 9);
        if (!SUPPORTED_GAMES[game]) return d(9, 6);      // unsupported by the generic two-seat lobby

        if (!validTok(q.get("tok"))) return d(9, 3);     // reject empty/garbage seat token
        const newCode = await this.freshCode();
        if (newCode < 0) return d(9, 5);                 // all 1024 lobby codes are occupied

        const tc = clockSecFor(game, q.get("tc"));         // 0 unless chess/checkers with a bank
        const cv = checkersVariantFor(game, q.get("cv"));
        const solo = game === 9 && q.get("solo") === "1";
        const geoState = game === 9 ? geoCreateState() : null;
        if (game === 9 && !geoState) return d(9, 5);
        const lobby = {
          game, players: solo ? 2 : 1, moves: [], pub: 0, t: nowSeq(),
          seats: [
            { tok: q.get("tok") || "" },
            solo ? { tok: randomBase64Url(24) } : null
          ],                                             // solo GeoGuesser gets an opaque server seat
          turn: 0,                                     // seat index whose turn it is
          tc: tc,                                      // per-seat bank in SECONDS (0 = no clock)
          cv: cv,                                      // Russian or English checkers (empty for other games)
          solo: solo ? 1 : 0,
          state: geoState || initState(game, cv)       // authoritative board/state
        };
        initClock(lobby);
        await this.storage.put(`l:${newCode}`, lobby);
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
          const w = await this.storage.get(`l:${waitCode}`);
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
        const geoState = game === 9 ? geoCreateState() : null;
        if (game === 9 && !geoState) return d(9, 5);
        const lobby = {
          game, players: 1, moves: [], pub: 1, t: nowSeq(),
          seats: [{ tok: q.get("tok") || "" }, null],
          turn: 0,
          tc: CLOCK_GAMES[game] && rawTc !== "any" ? clockSecFor(game, rawTc) : 0,
          qtcAny: CLOCK_GAMES[game] && rawTc === "any" ? 1 : 0,
          cv: cv,
          qcvAny: wantsAnyCheckersVariant(game, rawCv) ? 1 : 0,
          qk: quickQueueKey(game, hostTimeBucket, hostVariantBucket),
          state: geoState || initState(game, cv)
        };
        initClock(lobby);
        await this.storage.put(`l:${newCode}`, lobby);
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
                const w = await this.storage.get(`l:${waitCode}`);
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
        await this.storage.put(`l:${newCode}`, lobby);
        // HOST: +100 on the width flags the role, exactly like /api/quick.
        return dCode(newCode, true);
      }

      if (p === "/api/cancel") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        // Only a SEATED player (valid token) may cancel, and only while the lobby is still
        // waiting for the second player. Never let a 4-digit code-guesser nuke an active match.
        if (lobby && seatOf(lobby, q.get("tok")) >= 0 && lobby.players < 2) {
          await this.storage.delete(`l:${code}`);
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
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
            await this.storage.delete(`l:${code}`);
            await this.clearQueuesFor(lobby, code);
            return d(1, 1);
          }
          // Table plays on without the leaver: fold them out and log it.
          if (lobby.game === 3) durakLeave(lobby, seat);
          else pokerLeave(lobby, seat);
          lobby.t = nowSeq();
          await this.storage.put(`l:${code}`, lobby);
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
          await this.storage.put(`l:${code}`, lobby);
          return d(1, 1);
        }
        // A FINISHED GeoGuesser match must not be torn down under the player still reading it.
        // Both seats sit on the final screen (and the last reveal's score/place/credit reads may
        // still be in flight); whoever closes first used to delete the lobby, so the other one's
        // next poll answered (9,9) = "lobby gone" and the client kicked them to the menu with
        // "Opponent left." mid-scoreboard. Nothing is secret once the match is over, so keep the
        // lobby and just empty the seat - the remaining client keeps reading the done reply and
        // leaves on its own terms. The 30-minute sweep still collects it.
        if (lobby.game === 9 && lobby.state && lobby.state.round >= GEO_ROUNDS &&
            liveSeatCount(lobby) >= 1) {
          lobby.seats[seat] = null;
          lobby.t = nowSeq();
          await this.storage.put(`l:${code}`, lobby);
          return d(1, 1);
        }
        // Pair game, pre-start pair/host lobby, or the table just dropped to one player → tear it down.
        await this.storage.delete(`l:${code}`);
        await this.clearQueuesFor(lobby, code);
        return d(1, 1);
      }


      if (p === "/api/join") {
        if (!validTok(q.get("tok"))) return d(9, 3); // reject empty/garbage seat token
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${code}`, lobby);
        // height carries the time-control INDEX+1 (0..4 → 1..5) so the joiner learns the host's
        // chosen bank without picking it. Index (not raw seconds) keeps it inside one level dim.
        // tc=0 → index 0 → height 1 (no clock), a plain "which game" reply.
        return d(lobby.game, tcIndex(lobby.tc || 0) + 1); // w: game (1..9) · h: tc-index + 1
      }

      if (p === "/api/status") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby) return d(9, 1);              // gone
        if (!lobby.game) return d(9, 1);         // still-undecided mquick lobby: no game fixed yet
        const g = lobby.game;
        const ti = CLOCK_GAMES[g] ? tcIndex(lobby.tc || 0) : 0;
        const variantBit = g === 1 && checkersVariantFor(g, lobby.cv) === "english" ? 1 : 0;
        return d(g, ti * 2 + variantBit + 1);
      }

      if (p === "/api/move") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        if (clockCheckFlag(lobby) >= 0) { await this.storage.put(`l:${code}`, lobby); return d(9, 2); }
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
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);                          // accepted
      }


      if (p === "/api/poll") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby) return d(9, 9);              // gone
        if (!lobby.clkMs) return d(9, 8);        // untimed game → no clocks
        // Persist a freshly-detected flag so the outcome sticks for later polls / moves.
        if (clockCheckFlag(lobby) >= 0) await this.storage.put(`l:${code}`, lobby);
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
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
          if (lobby.game === 9) {
            const previousLocations = lobby.state && lobby.state.locations
              ? geoShuffle(lobby.state.locations.slice()) : [];
            lobby.state = geoCreateState() || geoNewState(previousLocations);
          } else {
            lobby.state = initState(lobby.game, lobby.cv, lobby.seats ? lobby.seats.length : 2);
          }
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
          await this.storage.put(`l:${code}`, lobby);
          return d(2, lobby.gen + 1);                     // everyone ready: reset done, gen bumped
        }
        await this.storage.put(`l:${code}`, lobby);
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
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby) return d(9, 1);                        // gone
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        const started = lobby.state && lobby.state.started ? 2 : 1; // h: 2 started, 1 waiting
        return d(lobby.players, started);
      }
      if (p === "/api/start") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = durakStart(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();                                  // keep-alive: TTL from last activity
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);
      }
      if (p === "/api/dact") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);
      }
      if (p === "/api/dlog") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby) return d(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.pub ? lobby.state.pub[since] : null;
        if (!ev) return d(1, 1);                           // nothing new (no event is (1,1))
        return d(ev.w, ev.h);
      }
      if (p === "/api/ddraw") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${newCode}`, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return dCode(newCode, true);
      }
      if (p === "/api/djoin") {
        if (!validTok(q.get("tok"))) return d(9, 3);
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${code}`, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return d(lobby.cap, (holeD >= 0 ? holeD : lobby.seats.length - 1) + 1);
      }
      if (p === "/api/droom") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${newCode}`, lobby);
        // HOST (+100 on width, like create) · height carries the seat cap so the joiner UI
        // can show "waiting 1/N" without another round-trip.
        return dCode(newCode, true);
      }
      if (p === "/api/pjoin") {
        if (!validTok(q.get("tok"))) return d(9, 3);
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
        await this.storage.put(`l:${code}`, lobby);
        // width = cap, height = the seat index this joiner took +1 (so it learns its seat)
        return d(lobby.cap || 4, (holeP >= 0 ? holeP : lobby.seats.length - 1) + 1);
      }
      if (p === "/api/proom") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby || lobby.game !== 6) return d(9, 1);    // gone
        await this.touchWaitingLobby(code, lobby, q.get("tok"));
        const started = lobby.state && lobby.state.started ? ROOM_STARTED : 0;
        // width = players PRESENT (+ROOM_STARTED band once started) · height = seat cap.
        // liveSeatCount, not `players` - see /api/droom.
        return d(liveSeatCount(lobby) + started, lobby.cap || 4);
      }
      if (p === "/api/pstart") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = pokerStart(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);
      }
      if (p === "/api/pact") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const a = clampInt(q.get("a"), 0, 0, 3);
        const to = clampInt(q.get("to"), 0, 0, 5000);
        const r = pokerAct(lobby, seat, a, to);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);
      }
      if (p === "/api/pnext") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const seat = seatOf(lobby, q.get("tok"));
        if (seat < 0) return d(9, 3);
        const r = pokerNext(lobby, seat);
        if (!r.ok) return d(9, r.code);
        lobby.t = nowSeq();
        await this.storage.put(`l:${code}`, lobby);
        return d(1, 1);
      }
      if (p === "/api/plog") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
        if (!lobby || lobby.game !== 6) return d(9, 9);
        const since = clampInt(q.get("since"), 0, 0, 100000);
        const ev = lobby.state && lobby.state.log ? lobby.state.log[since] : null;
        if (!ev) return d(1, 1);                           // nothing new
        return d(ev.w, ev.h);
      }
      if (p === "/api/pdraw") {
        const lobby = code !== "" ? await this.storage.get(`l:${code}`) : null;
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
      const existing = await this.storage.get(`l:${c}`);
      if (!existing) return c;
    }
    for (let c = 0; c <= CODE_MAX; c++) {
      const existing = await this.storage.get(`l:${c}`);
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
    if (!(w.game === 9 && w.state && w.state.locations && w.state.locations.length >= GEO_ROUNDS)) {
      w.state = initState(w.game, w.cv);
    }
    w.players = 2;
    w.seats = w.seats || [null, null];
    w.seats[1] = { tok: tok || "" };           // joiner takes seat 1
    initClock(w);                              // (re)anchor the bank to the JOIN moment, so a host that
                                               // waited in the public queue isn't billed for idle matchmaking
    autoStartDealerIfFull(w);                  // heads-up Durak starts as soon as matchmaking fills it
    await this.storage.put(`l:${waitCode}`, w);
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
  "/api/pstart": 1, "/api/pact": 1, "/api/pnext": 1, "/api/reset": 1,
  "/api/geostate": 1, "/api/geoview": 1, "/api/geoguess": 1, "/api/geonext": 1,
  "/api/geotarget": 1, "/api/geopick": 1, "/api/geoscore": 1, "/api/geoinfo": 1,
  "/api/geocredit": 1
};
const CODE_SCAN_EXEMPT_ROUTES = {
  "/api/leave": 1, "/api/cancel": 1
};

// Game ids the generic /api/create lobby accepts. 3 = durak creates its lobby here too, then
// switches to its own dealer routes (room/start/dact/…). 6 = poker is DELIBERATELY absent: it
// owns a fully separate route set (pcreate/pjoin/pstart/pact/…) because the generic lobby is
// hard-capped at 2 seats and poker seats 2–4. An id outside this set has no engine, so
// create/quick reject it up front and move never relays it.
const SUPPORTED_GAMES = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 9: 1 };

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
  out.sort((a, b) => { return a - b; });
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
function quickQueueKey(game, tc, cv) { return `pubq:q:${game}:${tc}:${cv}`; }
function multiQueueKey(game, tc, cv) { return `pubq:m:${game}:${tc}:${cv}`; }
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
  lobby.left = lobby.left.filter((leftSeat) => { return leftSeat !== seat; });
}

// Index of the first seat a pre-start leave vacated, or -1 if the table is dense. Seat 0 (the
// host) is never a hole - a host leaving pre-start tears the lobby down instead.
function seatHole(lobby) {
  if (!lobby.seats) return -1;
  for (let i = 1; i < lobby.seats.length; i++) if (!lobby.seats[i]) return i;
  return -1;
}

/* ─────────────────────── GeoGuesser authoritative rounds ───────────────────────
 * Panorama can display a remote equirectangular image, but it cannot run a fragment
 * shader to project one into a true perspective camera. The client therefore renders
 * a clipped/wrapped panorama strip and changes yaw/pitch locally. The location, guesses,
 * reveal gate and scores remain server-owned.
 *
 * Locations come from Panoramax's public federated STAC catalog. Only reusable CC-BY-SA
 * equirectangular pictures are accepted. They are deliberately server-proxied: the in-game
 * URL contains only the lobby code/token, never the picture id or hidden coordinates.
 */
// The authoritative guess resolution. The CLIENT's hit grid stays 64x32 panels, but it covers
// only the currently zoomed region, so at its 8x maximum those panels address 64*8 x 32*8 cells
// — hence 512x256 here. A cell is ~78km at the equator instead of the old 64x32's ~626km.
// The guess rides UP in the query string, which is unlimited (§2), so the finer resolution costs
// nothing on that path; only the reveal had to change (see geoPointReply).
const GEO_GRID_W = 512;
const GEO_GRID_H = 256;
const GEO_ROUNDS = 5;
// Panorama sources. The id shape differs per source and both are validated before use:
// Panoramax ids are UUIDs and its picture URL is CONSTRUCTED from them, so a catalog entry can
// never point the proxy at an arbitrary host. Mapillary ids are numeric and its image URL has to
// be fetched (see geoResolveImageUrl), so the answer is host-checked instead.
const GEO_SRC_PANORAMAX = 0;
const GEO_SRC_MAPILLARY = 1;
const GEO_MAPILLARY_GRAPH = "https://graph.mapillary.com/";
// Mapillary serves images off Facebook's CDN. Anchored to a leading dot so a lookalike host like
// "evilfbcdn.net" cannot match.
const GEO_MAPILLARY_IMAGE_HOST = ".fbcdn.net";
// ⚠ A resolved Mapillary URL is SIGNED and EXPIRES. Only the bytes may be cached, never the URL,
// so each cache miss re-resolves. That is one extra request per round, on the round that is about
// to download ~330 KiB anyway.
const GEO_URL_TIMEOUT_MS = 8000;

// The pool is PREBUILT (server/geo_pool.generated.js, refreshed by tools/build_geo_pool.js) and
// parsed once on first use. Starting a lobby therefore makes ZERO catalog requests: it picks five
// rows out of memory.
//
// It replaced a live per-region sweep that could not be made both fast and varied. Two measured
// facts killed it: Panoramax returns catalog frames in sequence order, so one wide bbox drains a
// single densely-mapped route (all of Europe = 1 sequence even at limit=1000), and Mapillary caps
// a bbox at 0.010 square degrees EVERYWHERE, so covering the inhabited world needs ~2.5M cells.
// Sweeping properly takes hours; sweeping cheaply gives five rounds on one street. Doing it
// offline is what makes "varied" and "instant" stop being a trade-off.
let geoPoolRows = null;

function geoPool() {
  if (geoPoolRows) return geoPoolRows;
  const rows = [];
  const lines = GEO_POOL_PACKED.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|");
    if (parts.length < 5) continue;
    const source = parts[0] === "1" ? GEO_SRC_MAPILLARY : GEO_SRC_PANORAMAX;
    const id = parts[1];
    const lat = Number(parts[2]), lon = Number(parts[3]);
    const region = Number(parts[4]);
    // The generator already validated every field; this is the cheap re-check that a corrupted
    // deploy artifact degrades the pool instead of feeding NaN coordinates into scoring.
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        !Number.isInteger(region) || region < 0 || region >= GEO_REGION_COUNT) continue;
    if (source === GEO_SRC_MAPILLARY ? !/^[0-9]{5,25}$/.test(id) : !/^[0-9a-f-]{36}$/i.test(id)) continue;
    // country/continent are the DISPLAY pair; `region` stays the coarse harvest bbox and is not
    // a substitute (it puts the Canaries in Africa and Vladivostok in Asia-the-bbox). A row the
    // builder could not place carries an empty country and continent -1, and the reveal then
    // names the region alone.
    const country = String(parts[6] || "");
    const continent = Number(parts[7]);
    const placed = country !== "" && Number.isInteger(continent) &&
      continent >= 0 && continent < GEO_REGION_COUNT;
    rows.push({
      source: source,
      id: id,
      lat: lat,
      lon: lon,
      region: region,
      provider: geoSafeProvider(parts[5]),
      country: placed ? country : "",
      continent: placed ? continent : -1
    });
  }
  geoPoolRows = rows;
  return rows;
}

const GEO_REGION_COUNT = 6;

function geoShuffle(values) {
  for (let i = values.length - 1; i > 0; i--) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const j = random[0] % (i + 1);
    const tmp = values[i]; values[i] = values[j]; values[j] = tmp;
  }
  return values;
}

// Keep in lockstep with safeName() in tools/build_geo_pool.js, INCLUDING the trailing trim: a
// 24-character slice can end on a space, and that space used to survive into the pool while each
// consumer trimmed it separately. With the credit line now a table lookup, the untrimmed form has
// no index and the reveal cannot name its own contributor.
function geoSafeProvider(value) {
  return String(value || "Contributor").replace(/[^ A-Za-z0-9.]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 24).trim() || "Contributor";
}

// ── Reveal labels are INDICES, not text ─────────────────────────────────────────────────────
// Both of these used to be prose on the wire. The credit line was transported two characters per
// request over the image-dimensions side channel: `?i=0` gave the length, then ceil(len/2) more
// requests each carried two characters. A 49-character line is 26 CHAINED round-trips, and the
// client held the reveal button on "LOADING RESULT…" until the last one landed - that was the
// whole reason the post-guess wait felt broken.
//
// Nothing about either string is dynamic: both come from fields the pool builder already decided.
// So the strings ship with the mod (panorama/scripts/mg_geo_credits.generated.js) and the wire
// carries the index into them. One request each, and the reveal renders instantly.
//
// The place code folds region, country AND display continent into ONE reply, since /api/geoinfo
// had 3969 codes and was spending six of them:
//
//   0..5                                  region only (the row could not be placed)
//   6 + countryIndex * 6 + continent      "continent · country"
//
// The continent has to travel too: a country does NOT determine it. Russia spans Europe and Asia
// (the pool has rows from Kaliningrad to Vladivostok), as do Turkey, Kazakhstan, Egypt and
// Indonesia, and lib/country.js resolves those per point. With 122 countries the top code is 737.
function geoPlaceCode(location) {
  if (!location) return 0;
  if (!location.country || location.continent < 0) {
    return Math.max(0, Math.min(GEO_REGION_COUNT - 1, location.region | 0));
  }
  const index = GEO_COUNTRY_NAMES.indexOf(location.country);
  // An unknown country means the two generated artifacts drifted. Degrade to the continent name
  // rather than name the wrong place.
  if (index < 0) return Math.max(0, Math.min(GEO_REGION_COUNT - 1, location.continent | 0));
  return GEO_REGION_COUNT + index * GEO_REGION_COUNT + location.continent;
}

// Index into GEO_CREDIT_KEYS ("source|provider"), which the client renders as
// "provider · source · CC BY-SA 4.0". -1 when the pair is missing from the table.
function geoCreditCode(location) {
  if (!location) return -1;
  const source = location.source === GEO_SRC_MAPILLARY ? 1 : 0;
  return GEO_CREDIT_KEYS.indexOf(source + "|" + geoSafeProvider(location.provider));
}

// Where the panorama bytes come from. Panoramax builds its URL from the validated UUID. Mapillary
// has to be asked, because thumb_2048_url is signed and time-limited - see GEO_URL_TIMEOUT_MS.
// Returns "" when the token is absent or the answer is not a Mapillary CDN URL, which the caller
// turns into the normal "no image" sentinel: no token simply means Mapillary rounds do not render,
// while Panoramax rounds keep working.
async function geoResolveImageUrl(location, token) {
  if (!location) return "";
  if (location.source !== GEO_SRC_MAPILLARY) {
    return `https://api.panoramax.xyz/api/pictures/${location.id}/sd.jpg`;
  }
  if (!token) return "";
  const fetcher = typeof globalThis.MG_GEO_CATALOG_FETCH === "function"
    ? globalThis.MG_GEO_CATALOG_FETCH : fetch;
  try {
    const response = await fetcher(
      GEO_MAPILLARY_GRAPH + location.id + "?fields=thumb_2048_url&access_token=" +
        encodeURIComponent(token),
      { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(GEO_URL_TIMEOUT_MS) }
    );
    if (!response.ok) return "";
    const body = await response.json();
    const raw = String(body && body.thumb_2048_url || "");
    if (!raw) return "";
    // Never hand the proxy a host the upstream chose. Same guarantee the constructed Panoramax
    // URL gets for free.
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return "";
    if (!parsed.hostname.endsWith(GEO_MAPILLARY_IMAGE_HOST)) return "";
    return parsed.href;
  } catch (error) {
    return "";
  }
}

// Five rounds, each from a different region where the pool allows it. No network, no TTL, no
// shared snapshot: the pool is a constant, so every lobby draws independently.
function geoLocationsForLobby() {
  const pool = geoPool();
  if (pool.length < GEO_ROUNDS) return null;

  const byRegion = [];
  for (let i = 0; i < GEO_REGION_COUNT; i++) byRegion.push([]);
  for (let i = 0; i < pool.length; i++) {
    if (byRegion[pool[i].region]) byRegion[pool[i].region].push(pool[i]);
  }
  const chosen = [], used = new Set();
  const regionOrder = geoShuffle([0, 1, 2, 3, 4, 5]);
  for (let i = 0; i < regionOrder.length && chosen.length < GEO_ROUNDS; i++) {
    const candidates = byRegion[regionOrder[i]];
    if (!candidates.length) continue;
    const pick = candidates[geoRandomIndex(candidates.length)];
    chosen.push(pick);
    used.add(pick.source + ":" + pick.id);
  }
  // Fewer than six populated regions, or fewer than five rounds filled: top up from anywhere.
  let guard = 0;
  while (chosen.length < GEO_ROUNDS && guard++ < 200) {
    const pick = pool[geoRandomIndex(pool.length)];
    const key = pick.source + ":" + pick.id;
    if (used.has(key)) continue;
    used.add(key);
    chosen.push(pick);
  }
  return chosen.length === GEO_ROUNDS ? chosen : null;
}

function geoRandomIndex(length) {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0] % length;
}

function geoNewState(locations) {
  return {
    round: 0,
    locations: (locations || []).slice(0, GEO_ROUNDS),
    guesses: [null, null],
    scores: [0, 0],
    ready: [0, 0],
    reveal: 0
  };
}

// Synchronous now that the pool is prebuilt: no catalog request stands between pressing Create
// and the first round.
function geoCreateState() {
  const locations = geoLocationsForLobby();
  return locations ? geoNewState(locations) : null;
}

async function geoLobbyAccess(hub, code, tok) {
  const lobby = code !== "" ? await hub.storage.get(`l:${code}`) : null;
  if (!lobby || lobby.game !== 9 || !lobby.state) return { ok: false, code: 9 };
  const seat = seatOf(lobby, tok);
  if (seat < 0) return { ok: false, code: 3 };
  // A FINISHED match is readable by whoever is still here. /api/leave keeps a completed lobby
  // alive and nulls the departing seat (see the leave route), so without this exemption the
  // remaining player's next poll would fail the two-seat check and get kicked off the scoreboard -
  // the same bug from the other direction. Everything a finished lobby can answer is already
  // public to both seats, so there is nothing to protect here.
  if (lobby.state.round >= GEO_ROUNDS) return { ok: true, lobby: lobby, seat: seat };
  if (presentCount(lobby) < 2) return { ok: false, code: 1 };
  return { ok: true, lobby: lobby, seat: seat };
}

function geoGuessMask(st) {
  return (st.guesses[0] != null ? 1 : 0) | (st.guesses[1] != null ? 2 : 0);
}

function geoReadyMask(st) {
  return (st.ready[0] ? 1 : 0) | (st.ready[1] ? 2 : 0);
}

function geoStateReply(st) {
  if (!st || st.round >= GEO_ROUNDS) return d(6, 40);
  const guessMask = geoGuessMask(st);
  if (st.reveal) return d(st.round + 1, 16 + (guessMask << 2) + geoReadyMask(st));
  return d(st.round + 1, 1 + guessMask);
}

// A point is read one AXIS per request. The downlink carries two base-63 levels = 3969 values,
// and the 512x256 grid needs 131072, so a linear cell no longer fits in a single reply. x (0..511)
// and y (0..255) each fit comfortably, so the caller asks twice: &axis=0 for x, &axis=1 for y.
// h=63 stays reserved for an error sentinel, matching the score codec.
function geoPointAxisReply(cell, axis) {
  const clamped = Math.max(0, Math.min(GEO_GRID_W * GEO_GRID_H - 1, cell | 0));
  const value = axis === 1
    ? Math.floor(clamped / GEO_GRID_W)
    : clamped % GEO_GRID_W;
  return d(value % 63, Math.floor(value / 63));
}

// Which half of a point this request wants: 1 = y (row), anything else = x (column).
function geoAxis(q) {
  return Number(q.get("axis")) === 1 ? 1 : 0;
}

function geoLonX(lon) {
  return Math.max(0, Math.min(GEO_GRID_W - 1, Math.floor((Number(lon) + 180) * GEO_GRID_W / 360)));
}

function geoLatY(lat) {
  return Math.max(0, Math.min(GEO_GRID_H - 1, Math.floor((90 - Number(lat)) * GEO_GRID_H / 180)));
}

function geoCellCoordinate(cell) {
  const x = cell % GEO_GRID_W;
  const y = Math.floor(cell / GEO_GRID_W);
  return {
    lon: (x + 0.5) * 360 / GEO_GRID_W - 180,
    lat: 90 - (y + 0.5) * 180 / GEO_GRID_H
  };
}

function geoDistanceKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const p1 = aLat * rad, p2 = bLat * rad;
  const dp = (bLat - aLat) * rad, dl = (bLon - aLon) * rad;
  const h = Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function geoRoundScore(location, cell) {
  const guess = geoCellCoordinate(cell);
  const km = geoDistanceKm(location.lat, location.lon, guess.lat, guess.lon);
  return Math.max(0, Math.min(750, Math.round(750 * Math.exp(-km / 2500))));
}

function geoRevealRound(st) {
  const location = st.locations[st.round];
  st.scores[0] += geoRoundScore(location, st.guesses[0]);
  st.scores[1] += geoRoundScore(location, st.guesses[1]);
  st.ready = [0, 0];
  st.reveal = 1;
}

function geoAdvanceRound(st) {
  st.round++;
  st.guesses = [null, null];
  st.ready = [0, 0];
  st.reveal = 0;
}

async function geoPanoramaResponse(hub, location) {
  if (!location) return d(6, 63);
  // Key by source as well as id. A Panoramax UUID and a Mapillary number cannot collide today,
  // but the pool carries both and an id-only key would silently serve the wrong bytes if that
  // ever stopped being true.
  const cacheKey = location.source + ":" + location.id;
  let cached = hub.geoImageCache.get(cacheKey);
  if (!cached) {
    try {
      // Resolved on every cache miss and never stored: a Mapillary URL is signed and expires.
      const url = await geoResolveImageUrl(location, hub.geoMapillaryToken);
      if (!url) return d(6, 63);
      const imageFetch = typeof globalThis.MG_GEO_IMAGE_FETCH === "function"
        ? globalThis.MG_GEO_IMAGE_FETCH : fetch;
      const response = await imageFetch(url, {
        headers: { "Accept": "image/jpeg,image/png", "User-Agent": "Deadlock-Minigames/1.0" },
        signal: AbortSignal.timeout(10000)
      });
      const type = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
      const declared = Number(response.headers.get("content-length") || 0);
      if (!response.ok || (type !== "image/jpeg" && type !== "image/png") ||
          declared > 8 * 1024 * 1024) return d(6, 63);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) return d(6, 63);
      cached = { bytes: bytes, type: type };
      if (hub.geoImageCache.size >= 12) {
        const oldest = hub.geoImageCache.keys().next().value;
        if (oldest !== undefined) hub.geoImageCache.delete(oldest);
      }
      hub.geoImageCache.set(cacheKey, cached);
    } catch (error) {
      return d(6, 63);
    }
  }
  return new Response(cached.bytes, {
    headers: {
      "content-type": cached.type,
      "cache-control": "private, max-age=300",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff"
    }
  });
}

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
  if (game === 9) return geoNewState();                                                            // GeoGuesser is normally created asynchronously
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
  return await hub.storage.get(`px:b:${account}`) || null;
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
  const key = `px:u:${account}`;
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
  return pixelStorageTransaction(hub, (txHub) => {
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
      await hub.storage.put(`px:t:${index}`, tile);
    } else {
      await hub.storage.delete(`px:t:${index}`);
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
    deltas: input.deltas.map((p) => {
      return [p.x, p.y, p.before, p.after, p.beforeOwnerActionId || ""];
    })
  };
  action.bounds = pixelDeltaBounds(action.deltas);
  await hub.storage.put(`px:a:${id}`, action);
  if (action.steamid) await hub.storage.put(`px:ua:${action.steamid}:${id}`, true);
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
      if (action.steamid) await hub.storage.delete(`px:ua:${action.steamid}:${action.id}`);
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
  const record = pixelOwnershipRecord(await hub.storage.get(`px:o:${location.tile}`));
  return pixelOwnerFromRecord(record, location.offset);
}

async function attachPixelOwners(hub, changed) {
  const records = new Map();
  for (let i = 0; i < changed.length; i++) {
    const p = changed[i], location = pixelOwnershipLocation(p.x, p.y);
    let record = records.get(location.tile);
    if (!record) {
      record = pixelOwnershipRecord(await hub.storage.get(`px:o:${location.tile}`));
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
    const key = `px:o:${tile}`;
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
  const prefix = steamid ? `px:ua:${steamid}:` : "px:a:";
  const options = { prefix: prefix, reverse: true, limit: limit + 1 };
  if (before) options.end = prefix + before;
  const listed = await hub.storage.list(options);
  const ids = [];
  for (const key of listed.keys()) ids.push(String(key).substring(prefix.length));
  const hasMore = ids.length > limit;
  if (hasMore) ids.length = limit;

  const actions = [];
  for (let i = 0; i < ids.length; i++) {
    const action = await hub.storage.get(`px:a:${ids[i]}`);
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
    const actionKey = `px:a:${actionId}`;
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
  const action = await hub.storage.get(`px:a:${actionId}`);
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
  let action = actionId ? await hub.storage.get(`px:a:${actionId}`) : null;
  if (!action) {
    action = await legacyPixelOwnerAction(hub, x, y);
    actionId = action ? action.id : "";
  }
  return adminJson({
    x: x,
    y: y,
    color: color,
    colorName: PX_ADMIN_COLOR_NAMES[color] || (`color ${color}`),
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
  const key = `px:b:${target.steamid}`;
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
  const bytes = await indexedPngBytes(PX_W, PX_H, PX_PALETTE, (x, y) => {
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
  return pngResponse(await indexedPngBytes(PX_W, PX_H, PX_VIEW_PALETTE, (x, y) => {
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
  const bytes = await indexedPngBytes(PX_VIEW_W, PX_VIEW_H, PX_VIEW_PALETTE, (x, y) => {
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
