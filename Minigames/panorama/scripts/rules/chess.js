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
