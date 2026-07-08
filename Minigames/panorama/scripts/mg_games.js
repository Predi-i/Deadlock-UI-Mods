"use strict";

/*
 * mg_games.js — game logic + rendering for the Deadlock Minigames mod.
 *
 * Ships online Checkers (Russian draughts: men move forward but capture in any
 * diagonal direction, flying kings, forced capture, multi-jump) and Tic-Tac-Toe.
 * Durak is registered as a disabled placeholder in the picker.
 *
 * Networking is client-authoritative: each player validates and applies moves locally,
 * then relays each hop through $.MG.Api (see mg_net.js). Squares are 0..63 on a fixed
 * canonical board; only rendering flips for the black player.
 *
 * Board cell values: 0 empty · 1 white man · 2 white king · 3 black man · 4 black king.
 * White = host (player 0), starts on rows 5-7, moves UP (decreasing row), moves first.
 * Black = joiner (player 1), starts on rows 0-2, moves DOWN.
 *
 * Public: $.MG.Games.list  and  $.MG.Games.mount(gameId, container, session) -> {destroy}
 *   session = { code, isHost, onStatus(text) }
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Games) return;

    var WHITE = "w", BLACK = "b";

    // ── pure board helpers ──────────────────────────────────────────────────
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

    // ── tic-tac-toe pure rules ────────────────────────────────────────────────
    // Board is a flat length-9 array: 0 empty, 1 = X, 2 = O. Cells index left→right,
    // top→bottom (0..8). These are UI-free so tools/mg_rules_test.js can slice them.
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

    // ── checkers controller ─────────────────────────────────────────────────
    function createCheckers(container, session) {
        var Api = MG.Api;
        var code = session.code;
        var myColor = session.isHost ? WHITE : BLACK;
        var board = initialBoard();
        var turn = WHITE;              // white (host) moves first
        var appliedSeq = 0;            // total hops consumed from the shared server list
        var selected = -1;             // selected square during my turn
        var legalTargets = [];         // [{to, cap}]
        var chaining = false;          // mid multi-jump
        var pollToken = 0;             // invalidates stale poll loops
        var destroyed = false;
        var gameOver = false;

        // Drag-and-drop state (native Panorama drag; recipe proven in QOLLOCK):
        // a piece is a drag SOURCE, each cell a drop TARGET. While dragging, a throwaway
        // "ghost" panel follows the cursor and the real piece is dimmed in place.
        var dragActive = false;        // a real grab is in flight (ghost exists)
        var dragGhost = null;          // panel that follows the cursor
        var dragOverSq = -1;           // square the cursor is currently over (DragEnter / mouseover)
        var dragEnterCount = 0;        // how many DragEnter events landed this drag (is that channel alive?)

        // TEMP diagnostic. When true, every DragEnd writes what each drop channel actually
        // produced to the on-screen status line — so ONE in-game test reveals which signal
        // the engine really populates, instead of guessing a 5th time. Flip to false (or
        // delete the status() call in commitDropMultimethod) once drag is confirmed working.
        var DRAG_DEBUG = true;

        function status(t) { if (session.onStatus) session.onStatus(t); }

        // Parse a Panorama px-like style value ("123px", "123.0px") to a number, else null.
        function parsePx(v) {
            if (typeof v !== "string" || !v.length) return null;
            var m = v.match(/-?\d+(\.\d+)?/);
            return m ? parseFloat(m[0]) : null;
        }

        // Display transform: black sees the board rotated 180° so its pieces sit at the bottom.
        function toDisplay(i) { return myColor === WHITE ? i : 63 - i; }
        function fromDisplay(i) { return myColor === WHITE ? i : 63 - i; }

        var root = $.CreatePanel("Panel", container, "MG_CheckersRoot");
        root.AddClass("mg-checkers");
        // The board grid and the pieces overlay must OCCUPY THE SAME SPACE. Panorama has
        // no `position: absolute`; instead the wrap uses `flow-children: none` so both its
        // children stack at the top-left, and the pieces layer (added last) paints on top.
        var boardWrap = $.CreatePanel("Panel", root, "MG_BoardWrap");
        boardWrap.AddClass("mg-board-wrap");
        var boardPanel = $.CreatePanel("Panel", boardWrap, "MG_Board");
        boardPanel.AddClass("mg-board");

        // ── board geometry (must match mg.css: 60px cells, 46px pieces) ──────
        var SQ = 60, PIECE_SZ = 46, INSET = (SQ - PIECE_SZ) / 2;
        function transformFor(realIdx) {
            var d = toDisplay(realIdx);
            var dr = (d / 8) | 0, dc = d % 8;
            return "translate3d(" + (dc * SQ + INSET) + "px, " + (dr * SQ + INSET) + "px, 0px)";
        }

        var cells = [];
        var piecesLayer = null;
        var pieceEls = {};     // realSquare -> piece panel (its current visual position)

        function buildCells() {
            boardPanel.RemoveAndDeleteChildren();
            cells = [];
            pieceEls = {};
            // Build 8 explicit rows of 8 cells. Row layout can't mis-wrap the grid the
            // way flow:right-wrap does when a border shaves a pixel off the width.
            for (var dr = 0; dr < 8; dr++) {
                var rowPanel = $.CreatePanel("Panel", boardPanel, "row_" + dr);
                rowPanel.AddClass("mg-board-row");
                for (var dc = 0; dc < 8; dc++) {
                    var d = dr * 8 + dc;
                    var i = fromDisplay(d);
                    var r = rowOf(i), c = colOf(i);
                    var cell = $.CreatePanel("Panel", rowPanel, "cell_" + i);
                    cell.AddClass("mg-cell");
                    cell.AddClass(isDark(r, c) ? "mg-cell-dark" : "mg-cell-light");
                    (function (square) {
                        cell.SetPanelEvent("onactivate", function () { onCellClick(square); });
                        // Drop target for drag-and-drop. In Panorama a panel only becomes a
                        // valid drop target when its DragEnter handler returns true — without
                        // it, DragDrop never fires on the cell (that was why the drop didn't
                        // land). DragEnter also lets us remember which square the cursor is
                        // over, so DragEnd can commit the move even if DragDrop is flaky.
                        $.RegisterEventHandler("DragEnter", cell, function () {
                            if (dragActive) { dragOverSq = square; dragEnterCount++; }
                            return true; // accept the drop
                        });
                        $.RegisterEventHandler("DragLeave", cell, function () {
                            if (dragActive && dragOverSq === square) dragOverSq = -1;
                        });
                        $.RegisterEventHandler("DragDrop", cell, function () { onCellDrop(square); });
                        // Second, independent source for the hovered square: plain mouse-over.
                        // If the engine suppresses DragEnter mid-drag but still updates hover,
                        // this keeps dragOverSq current so DragEnd can commit from it.
                        cell.SetPanelEvent("onmouseover", function () { if (dragActive) dragOverSq = square; });
                    })(i);
                    cells[i] = cell;
                }
            }
            // Pieces live in an overlay ABOVE the cells so they can slide across squares
            // (transform transition). It is a SIBLING of the board inside the flow:none
            // wrap — NOT a child of boardPanel (whose flow:down would push it below the
            // rows). CSS positions it inside the board's 3px border so it aligns to cells.
            //
            // hittest=false makes the LAYER itself transparent to input, so a click on an
            // empty square passes through to the cell beneath (which owns destination
            // clicks + '.mg-target' highlighting). hittestchildren stays default (true) so
            // the PIECES do receive input — required for drag-and-drop and click-to-select.
            // Destination squares are always empty, so no piece ever blocks a target cell.
            piecesLayer = $.CreatePanel("Panel", boardWrap, "MG_PiecesLayer");
            piecesLayer.AddClass("mg-pieces-layer");
            try { piecesLayer.SetAttributeString("hittest", "false"); } catch (e) {}
        }

        function makePiece(realIdx, v) {
            var piece = $.CreatePanel("Panel", piecesLayer, "");
            piece.AddClass("mg-piece");
            piece.AddClass(colorOf(v) === WHITE ? "mg-white" : "mg-black");
            if (isKing(v)) piece.AddClass("mg-king");
            // Set the start position WITHOUT the transition (base .mg-piece has none), so a
            // fresh piece snaps onto its square instead of sliding in from the corner. Add
            // the animating class one frame later, once this position is committed — from
            // then on every transform/opacity/scale change animates. This is the same idiom
            // the game uses (transition on a class, toggled after the value is set).
            piece.style.transform = transformFor(realIdx);
            $.Schedule(0.0, function () {
                if (piece && piece.IsValid && piece.IsValid()) piece.AddClass("mg-anim");
            });
            piece._sq = realIdx;          // live square this piece sits on (updated on slide)
            pieceEls[realIdx] = piece;
            setupPieceInput(piece);
            return piece;
        }

        // Wire one piece for BOTH interaction styles the user asked for:
        //  • click-to-select  (onactivate → onCellClick on its own square)
        //  • drag-and-drop     (native SetDraggable + DragStart/DragEnd — QOLLOCK recipe)
        // Because the pieces layer now lets pieces receive input (hittest passes through
        // only on empty squares), the click that used to fall through to the cell beneath
        // is delivered to the PIECE — so the piece must forward it to the same handler.
        function setupPieceInput(piece) {
            // A tap on a piece selects it (or, if it's already a legal target square of
            // the current selection, plays the hop) — identical to clicking its cell.
            piece.SetPanelEvent("onactivate", function () {
                if (piece._sq === undefined) return;
                onCellClick(piece._sq);
            });

            // Only my own pieces are ever grabbable; opponent pieces stay non-draggable.
            if (colorOf(board[piece._sq]) !== myColor) return;
            piece.SetDraggable(true);

            $.RegisterEventHandler("DragStart", piece, function (_p, dragEvent) {
                var sq = piece._sq;
                // ALWAYS provide a ghost as the drag visual so the engine never drags the
                // real piece around (QOLLOCK sets dragEvent.displayPanel for exactly this).
                var ghost = $.CreatePanel("Panel", piecesLayer, "");
                ghost.AddClass("mg-piece");
                ghost.AddClass(colorOf(board[sq]) === WHITE ? "mg-white" : "mg-black");
                if (isKing(board[sq])) ghost.AddClass("mg-king");
                ghost.AddClass("mg-dragging");
                // Ghost sits under the cursor; make it transparent to input so the DragDrop
                // lands on the cell beneath, not on the ghost itself.
                try { ghost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragGhost = ghost;
                dragEvent.displayPanel = ghost;
                dragEvent.removePositionBeforeDrop = false;
                // No transform on the ghost: the engine positions the displayPanel under the
                // cursor itself (QOLLOCK pattern). A transform here would offset it off-cursor.
                ghost.style.align = "left top";

                dragActive = true;
                dragOverSq = -1;
                dragEnterCount = 0;
                piece.AddClass("mg-drag-source"); // dim the real piece while it's "lifted"

                // Light up this piece's legal targets as drop hints — but only when it may
                // actually move now (my turn, and mid-chain only the chaining piece). If it
                // can't, we leave no selection, so any drop is a harmless snap-back.
                if (!destroyed && myTurn() && !(chaining && sq !== selected)) {
                    if (selected !== sq) onCellClick(sq);
                }
            });

            $.RegisterEventHandler("DragEnd", piece, function (_p, droppedPanel) {
                // THE hard part. Every single-channel drop scheme we tried failed in-game.
                // Don't trust any ONE signal — gather EVERY candidate square we can and
                // commit the first that is a legal target. A wrong/garbage candidate simply
                // isn't in legalTargets, so it's ignored; if none match, the piece snaps
                // back. No false move is possible, and nothing here touches the server.
                // `droppedPanel` is DragEnd's 2nd arg: the panel released onto (native,
                // authoritative when present — this is how QOLLOCK's ql_hero_testing works).
                commitDropMultimethod(droppedPanel);

                // Tear down the ghost + dim regardless of outcome.
                if (dragGhost) { try { dragGhost.DeleteAsync(0); } catch (e) {} dragGhost = null; }
                piece.RemoveClass("mg-drag-source");
                dragActive = false;
                dragOverSq = -1;
                // A drop on empty space (no legal target) just snaps back — the real piece
                // never moved, so there is nothing to restore.
            });
        }

        // ── drop resolution: try many mappings, commit the first legal one ─────
        // NOTE: GameUI.GetCursorPosition is CONFIRMED ABSENT in Deadlock (see QOLLOCK
        // ql_settings.js / ql_core.js), so no method here may depend on reading the OS
        // cursor. Everything below works from panel signals only.

        // Is `sq` currently a legal target of the selected piece?
        function isLegalTarget(sq) {
            for (var t = 0; t < legalTargets.length; t++) if (legalTargets[t].to === sq) return true;
            return false;
        }

        // Our cells are named "cell_<realSquare>". Recover the square from a panel id (or
        // from an ancestor's, since a drop may report a child). -1 if it isn't one of ours.
        function squareFromPanel(p) {
            for (var hops = 0; p && hops < 6; hops++) {
                var id = null;
                try { id = p.id; } catch (e) {}
                if (id && id.indexOf("cell_") === 0) {
                    var n = parseInt(id.substring(5), 10);
                    if (isFinite(n) && n >= 0 && n < 64) return n;
                }
                try { p = p.GetParent ? p.GetParent() : null; } catch (e2) { p = null; }
            }
            return -1;
        }

        // Absolute position of a panel in WINDOW pixels. GetPositionWithinWindow is a real
        // engine method (confirmed present in Deadlock's panorama_strings), and — unlike
        // actualxoffset (which returned FLT_MAX because the dragged ghost is culled out of
        // layout) — it's computed from the render tree, so it stays valid mid/post-drag and
        // needs no reparenting. Return shape is defended (object {x,y} or array). FLT_MAX-ish
        // magnitudes are rejected as the "invalid" sentinel.
        function winPos(panel) {
            if (!panel || !panel.GetPositionWithinWindow) return null;
            var r;
            try { r = panel.GetPositionWithinWindow(); } catch (e) { return null; }
            if (!r) return null;
            var x = (typeof r.x === "number") ? r.x : (typeof r[0] === "number" ? r[0] : null);
            var y = (typeof r.y === "number") ? r.y : (typeof r[1] === "number" ? r[1] : null);
            if (x === null || y === null || !isFinite(x) || !isFinite(y)) return null;
            if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null; // FLT_MAX sentinel
            return { x: x, y: y };
        }

        // Map the ghost's window position to a board square. Everything is in window pixels,
        // so the UI scale cancels: cell size in window px = pieces-layer rendered width / 8.
        // Ghost centre (top-left + half its RENDERED width) relative to the layer origin,
        // divided by the window cell size, gives the display col/row → real square.
        function squareFromWindow() {
            var lp = winPos(piecesLayer);
            var gp = winPos(dragGhost);
            if (!lp || !gp) return -1;
            var layerW = (piecesLayer && isFinite(piecesLayer.actuallayoutwidth) && piecesLayer.actuallayoutwidth > 0)
                ? piecesLayer.actuallayoutwidth : 480;
            var cellPx = layerW / 8;
            var pieceW = (dragGhost && isFinite(dragGhost.actuallayoutwidth) && dragGhost.actuallayoutwidth > 0
                          && dragGhost.actuallayoutwidth < 100000)
                ? dragGhost.actuallayoutwidth : (PIECE_SZ * cellPx / SQ);
            var cx = (gp.x - lp.x) + pieceW / 2;
            var cy = (gp.y - lp.y) + pieceW / 2;
            var dcol = Math.floor(cx / cellPx), drow = Math.floor(cy / cellPx);
            if (dcol < 0 || dcol > 7 || drow < 0 || drow > 7) return -1;
            return fromDisplay(drow * 8 + dcol);
        }

        // Read the ghost's released position in pieces-layer space. The engine may have
        // reparented the ghost into its own drag overlay; pull it back under the pieces
        // layer first (QOLLOCK's ql_hero_testing reparents before reading) so the numbers are
        // board-space again. Returns {x,y} of the ghost's top-left plus the raw channels for
        // diagnostics, or null.
        //
        // PRIMARY channel = style.x / style.y. With removePositionBeforeDrop=false the engine
        // writes the drop position into the display panel's style.x/style.y — this is exactly
        // what QOLLOCK's ReadPanelPosition reads FIRST, and it's the channel we had never used.
        // actualxoffset is only the fallback.
        function ghostPos() {
            var g = dragGhost;
            if (!g || (g.IsValid && !g.IsValid())) return null;
            try { if (g.GetParent && g.GetParent() !== piecesLayer) g.SetParent(piecesLayer); } catch (e) {}
            var sx = parsePx(g.style ? g.style.x : null);
            var sy = parsePx(g.style ? g.style.y : null);
            var ax = (typeof g.actualxoffset === "number" && isFinite(g.actualxoffset)) ? g.actualxoffset : null;
            var ay = (typeof g.actualyoffset === "number" && isFinite(g.actualyoffset)) ? g.actualyoffset : null;
            var x = (sx !== null) ? sx : ax;
            var y = (sy !== null) ? sy : ay;
            if (x === null || y === null) return null;
            return { x: x, y: y, sx: sx, sy: sy, ax: ax, ay: ay };
        }

        function squareFromGhost() {
            var p = ghostPos();
            if (!p) return -1;
            if (p.x === 0 && p.y === 0) return -1; // suspicious origin → let other methods try
            var cx = p.x + PIECE_SZ / 2, cy = p.y + PIECE_SZ / 2;
            var dcol = Math.floor(cx / SQ), drow = Math.floor(cy / SQ);
            if (dcol < 0 || dcol > 7 || drow < 0 || drow > 7) return -1;
            return fromDisplay(drow * 8 + dcol);
        }

        // Try each candidate in priority order; commit the first that is a legal target.
        // `droppedPanel` is DragEnd's authoritative 2nd arg (the panel released onto).
        function commitDropMultimethod(droppedPanel) {
            if (destroyed || !myTurn() || selected < 0) {
                if (DRAG_DEBUG) status("drop ignored: myTurn=" + myTurn() + " selected=" + selected);
                return;
            }
            // Capture window positions FIRST, before squareFromGhost() reparents the ghost
            // (reparenting would invalidate the window reading).
            var lw = winPos(piecesLayer);
            var gw = winPos(dragGhost);
            var wSq = squareFromWindow();               // W: absolute window geometry (new primary)
            var aPanel = squareFromPanel(droppedPanel); // A: native drop panel (proven = the ghost, no id)
            var bOver = dragOverSq;                     // B: last cell hovered (DragEnter/mouseover — dead in-game)
            var cGhost = squareFromGhost();             // C: ghost layout geometry (FLT_MAX in-game)
            var candidates = [wSq, aPanel, bOver, cGhost];
            var names = ["win", "panel", "over", "ghost"];
            var matched = -1, via = "none";
            for (var k = 0; k < candidates.length; k++) {
                if (candidates[k] >= 0 && isLegalTarget(candidates[k])) { matched = candidates[k]; via = names[k]; break; }
            }

            if (DRAG_DEBUG) {
                var dpid = "null";
                try { dpid = droppedPanel ? (droppedPanel.id || "noid") : "null"; } catch (e) { dpid = "err"; }
                var tg = [];
                for (var t = 0; t < legalTargets.length; t++) tg.push(legalTargets[t].to);
                var lwS = lw ? (Math.round(lw.x) + "," + Math.round(lw.y)) : "null";
                var gwS = gw ? (Math.round(gw.x) + "," + Math.round(gw.y)) : "null";
                var lwd = (piecesLayer && piecesLayer.actuallayoutwidth) || "?";
                status("DROP " + (matched >= 0 ? ("OK via " + via + "->" + matched) : "MISS")
                    + " | win=" + wSq + " g(" + gwS + ") L(" + lwS + ") lw=" + lwd
                    + " | panel=" + dpid + "->" + aPanel + " over=" + bOver + "(" + dragEnterCount + "e) ghost=" + cGhost
                    + " | targets=[" + tg.join(",") + "]");
            }

            if (matched >= 0) { onCellDrop(matched); return; }
            // Nothing matched → snap back (selection stays so the hints remain for a click).
        }

        // Full rebuild of the piece layer (initial deal, board flip, game end). No slide.
        function layoutPieces() {
            if (!piecesLayer) return;
            piecesLayer.RemoveAndDeleteChildren();
            pieceEls = {};
            for (var i = 0; i < 64; i++) { if (board[i]) makePiece(i, board[i]); }
        }

        // Selection + legal-target highlighting only (cheap; touches no pieces).
        function refreshHighlights() {
            for (var i = 0; i < 64; i++) {
                var cell = cells[i];
                if (!cell) continue;
                cell.RemoveClass("mg-sel");
                cell.RemoveClass("mg-target");
            }
            if (selected >= 0 && cells[selected]) cells[selected].AddClass("mg-sel");
            for (var t = 0; t < legalTargets.length; t++) {
                var tc = cells[legalTargets[t].to];
                if (tc) tc.AddClass("mg-target");
            }
        }

        // Apply a hop to the model AND report the captured square (for the fade fx).
        function applyHopFx(from, to) {
            var before = board.slice();
            var res = applyHop(board, from, to);
            var capIdx = -1;
            if (res.captured) {
                for (var i = 0; i < 64; i++) {
                    if (before[i] && !board[i] && i !== from && i !== to) { capIdx = i; break; }
                }
            }
            return { captured: res.captured, promoted: res.promoted, capIdx: capIdx };
        }

        // Slide the piece from->to; shrink-fade a captured piece; crown on promotion.
        function animateHop(from, to, capIdx, promoted) {
            if (capIdx >= 0 && pieceEls[capIdx]) {
                var dead = pieceEls[capIdx];
                delete pieceEls[capIdx];
                // Keep the translate3d that holds the piece on its square, and shrink it
                // IN PLACE with pre-transform-scale2d (the game's idiom — it scales before
                // the translate, so the piece stays put). scale3d INSIDE the transform
                // multiplied the translate offset and hurled the piece toward (0,0) — that
                // was the "flies up-left" artifact. opacity + scale animate via .mg-piece.
                dead.AddClass("mg-captured");
                dead.style.preTransformScale2d = "0.2";
                (function (d) { $.Schedule(0.22, function () { try { d.DeleteAsync(0); } catch (e) {} }); })(dead);
            }
            var piece = pieceEls[from];
            delete pieceEls[from];
            if (!piece || !piece.IsValid || !piece.IsValid()) {
                if (board[to]) makePiece(to, board[to]); // visual desync guard: rebuild from model
                return;
            }
            // No class toggle needed: the transition lives on .mg-piece, so simply
            // changing the transform animates the slide.
            if (promoted) piece.AddClass("mg-king");
            piece.style.transform = transformFor(to);
            piece._sq = to;               // keep the piece's live square in sync (click/drag)
            pieceEls[to] = piece;
        }

        function myTurn() { return turn === myColor && !gameOver; }

        function clearSelection() { selected = -1; legalTargets = []; }

        // What can this piece legally do right now (respecting forced capture)?
        function targetsFor(i) {
            if (chaining) return captureMoves(board, i); // must continue same piece
            if (anyCaptureFor(board, myColor)) return captureMoves(board, i);
            return simpleMoves(board, i);
        }

        function onCellClick(i) {
            if (destroyed || !myTurn()) return;

            // Clicking a legal target of the currently selected piece = execute a hop.
            if (selected >= 0) {
                for (var t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalHop(selected, legalTargets[t]); return; }
                }
            }
            if (chaining) return; // during a chain only its targets are clickable

            // Otherwise (re)select one of my pieces that actually has a legal move.
            if (colorOf(board[i]) === myColor) {
                var tg = targetsFor(i);
                if (tg.length === 0) { status("That piece has no legal move."); return; }
                selected = i;
                legalTargets = tg;
                refreshHighlights();
            }
        }

        // A piece was dropped onto square `i`. Play the hop if `i` is a legal target of
        // the piece we're dragging; otherwise it's a no-op and the ghost just snaps back.
        function onCellDrop(i) {
            if (destroyed || !myTurn() || !dragActive || selected < 0) return;
            for (var t = 0; t < legalTargets.length; t++) {
                if (legalTargets[t].to === i) {
                    doLocalHop(selected, legalTargets[t]);
                    return;
                }
            }
            // Dropped on a non-target: keep the selection so its hints stay up for a click.
        }

        var pendingHops = [];

        function doLocalHop(from, mv) {
            var res = applyHopFx(from, mv.to);
            animateHop(from, mv.to, res.capIdx, res.promoted);
            pendingHops.push({ from: from, to: mv.to });

            // Can the same piece keep jumping? (only after a capture, and not if just crowned)
            var more = res.captured && !res.promoted && captureMoves(board, mv.to).length > 0;
            if (more) {
                chaining = true;
                selected = mv.to;
                legalTargets = captureMoves(board, mv.to);
                refreshHighlights();
                status("Keep jumping!");
                return;
            }

            // Turn complete — mark last hop as turn-ending and relay the whole sequence.
            chaining = false;
            clearSelection();
            refreshHighlights();
            var hops = pendingHops.slice();
            pendingHops = [];
            for (var h = 0; h < hops.length; h++) hops[h].end = (h === hops.length - 1) ? 1 : 0;

            turn = (myColor === WHITE ? BLACK : WHITE); // hand off locally right away

            if (session.bot) {
                checkEnd();
                if (!gameOver) { status("Bot is thinking…"); scheduleBotTurn(); }
                return;
            }
            status("Move sent. Waiting for opponent…");
            sendHops(hops, 0);
        }

        // ── bot turn (offline mode) ─────────────────────────────────────────
        function scheduleBotTurn() { $.Schedule(0.45, botTurn); }

        function botTurn() {
            if (destroyed || gameOver) return;
            var botColor = (myColor === WHITE ? BLACK : WHITE);
            var seq = chooseBotMove(board, botColor);
            if (!seq) { checkEnd(); return; } // no legal move → checkEnd declares winner
            applyBotSeq(seq, 0);
        }

        function applyBotSeq(seq, h) {
            if (destroyed) return;
            if (h >= seq.length) {
                turn = myColor;
                checkEnd();
                if (!gameOver) status("Your turn.");
                return;
            }
            var res = applyHopFx(seq[h].from, seq[h].to);
            animateHop(seq[h].from, seq[h].to, res.capIdx, res.promoted);
            $.Schedule(0.35, function () { applyBotSeq(seq, h + 1); }); // step hops for visibility
        }

        function sendHops(hops, i) {
            if (destroyed) return;
            if (i >= hops.length) { afterTurnSwitch(); return; }
            var hop = hops[i];
            Api.move(code, hop.from, hop.to, hop.end, function (ok) {
                appliedSeq++; // our own hop is now in the shared list
                sendHops(hops, i + 1);
            }, function () {
                $.Schedule(0.6, function () { sendHops(hops, i); }); // retry same hop
            });
        }

        // ── opponent polling ────────────────────────────────────────────────
        function afterTurnSwitch() {
            checkEnd();
            if (gameOver) return;
            startPolling();
        }

        function startPolling() {
            pollToken++;
            var myToken = pollToken;
            pollOnce(myToken);
        }

        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken) return;
            if (turn === myColor) return; // it's our turn; nothing to poll
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    var res = applyHopFx(mv.from, mv.to);
                    appliedSeq++;
                    animateHop(mv.from, mv.to, res.capIdx, res.promoted);
                    if (mv.end) {
                        turn = myColor;
                        checkEnd();
                        if (!gameOver) status("Your turn.");
                        return; // stop polling; wait for player input
                    }
                    $.Schedule(0.05, function () { pollOnce(myToken); }); // drain chain fast
                } else {
                    $.Schedule(0.4, function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(0.6, function () { pollOnce(myToken); });
            }, function (from, to) {
                // A real hop is always a diagonal between two board squares; anything
                // else is a mis-scaled read and must never reach applyHop.
                var fr = (from / 8) | 0, fc = from % 8, tr = (to / 8) | 0, tc = to % 8;
                return Math.abs(tr - fr) === Math.abs(tc - fc);
            });
        }

        function checkEnd() {
            var opp = (myColor === WHITE ? BLACK : WHITE);
            if (!hasAnyMove(board, WHITE)) { finish(BLACK); return; }
            if (!hasAnyMove(board, BLACK)) { finish(WHITE); return; }
            // count pieces
            var wc = 0, bc = 0;
            for (var i = 0; i < 64; i++) { if (colorOf(board[i]) === WHITE) wc++; else if (colorOf(board[i]) === BLACK) bc++; }
            if (wc === 0) finish(BLACK);
            else if (bc === 0) finish(WHITE);
        }

        function finish(winner) {
            gameOver = true;
            clearSelection();
            refreshHighlights();
            status(winner === myColor ? "🏆 You win!" : "You lose.");
        }

        // ── boot ────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
        if (myTurn()) {
            status("Your turn. You play " + (myColor === WHITE ? "white (bottom)." : "black (bottom)."));
        } else if (session.bot) {
            // Offline and it's white's turn but I'm black → the bot (white) opens.
            status("Bot is thinking…");
            scheduleBotTurn();
        } else {
            status("Opponent's turn…");
            startPolling();
        }

        return {
            destroy: function () { destroyed = true; pollToken++; try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    // ── tic-tac-toe controller ───────────────────────────────────────────────
    // Wire format reuses the checkers move transport: a placement in cell 0..8 is sent
    // as move(code, cell, 9, end=1). `to`=9 is a fixed non-cell marker so from!=to
    // always holds (from==to is the "nothing new" sentinel) and validation is trivial.
    function createTicTacToe(container, session) {
        var Api = MG.Api;
        var code = session.code;
        var X = 1, O = 2;
        var myMark = session.isHost ? X : O;   // host plays X and moves first
        var board = new Array(9);
        for (var q = 0; q < 9; q++) board[q] = 0;
        var turn = X;                  // X always starts
        var appliedSeq = 0;            // placements consumed from the shared server list
        var pollToken = 0;
        var destroyed = false;
        var gameOver = false;

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function myTurn() { return turn === myMark && !gameOver; }

        // Marks are drawn with panels, NOT font glyphs: the game font has neither
        // ✕ nor ◯ (that's why X was invisible and O sat off-centre). X = two bars
        // crossed via rotateZ; O = a ring (bordered circle with a transparent hole).
        function drawMark(cell, v) {
            if (v === X) {
                var x = $.CreatePanel("Panel", cell, "");
                x.AddClass("mg-ttt-mark"); x.AddClass("mg-x");
                var b1 = $.CreatePanel("Panel", x, ""); b1.AddClass("mg-x-bar"); b1.AddClass("mg-x-bar-a");
                var b2 = $.CreatePanel("Panel", x, ""); b2.AddClass("mg-x-bar"); b2.AddClass("mg-x-bar-b");
            } else {
                var o = $.CreatePanel("Panel", cell, "");
                o.AddClass("mg-ttt-mark"); o.AddClass("mg-o");
            }
        }

        var root = $.CreatePanel("Panel", container, "MG_TttRoot");
        root.AddClass("mg-ttt");
        var boardPanel = $.CreatePanel("Panel", root, "MG_TttBoard");
        boardPanel.AddClass("mg-ttt-board");

        var cells = [];
        (function buildCells() {
            for (var r = 0; r < 3; r++) {
                var rowPanel = $.CreatePanel("Panel", boardPanel, "ttt_row_" + r);
                rowPanel.AddClass("mg-ttt-row");
                for (var c = 0; c < 3; c++) {
                    var i = r * 3 + c;
                    var cell = $.CreatePanel("Panel", rowPanel, "ttt_cell_" + i);
                    cell.AddClass("mg-ttt-cell");
                    (function (square) {
                        cell.SetPanelEvent("onactivate", function () { onCellClick(square); });
                    })(i);
                    cells[i] = cell;
                }
            }
        })();

        function render(winLine) {
            for (var i = 0; i < 9; i++) {
                var cell = cells[i];
                cell.RemoveClass("mg-ttt-win");
                cell.RemoveAndDeleteChildren();
                if (board[i]) drawMark(cell, board[i]);
            }
            if (winLine) for (var k = 0; k < winLine.length; k++) cells[winLine[k]].AddClass("mg-ttt-win");
        }

        function place(i, mark) { board[i] = mark; }

        // Evaluate terminal state; announce and freeze if the game is decided.
        function checkEnd() {
            var w = tttWinner(board);
            if (w) {
                gameOver = true;
                render(w.line);
                status(w.mark === myMark ? "🏆 You win!" : "You lose.");
                return true;
            }
            if (tttFull(board)) {
                gameOver = true;
                render(null);
                status("Draw.");
                return true;
            }
            return false;
        }

        function onCellClick(i) {
            if (destroyed || !myTurn() || board[i]) return;
            place(i, myMark);
            turn = (myMark === X ? O : X);   // hand off locally
            render(null);

            if (session.bot) {
                if (checkEnd()) return;
                status("Bot is thinking…");
                $.Schedule(0.4, botTurn);
                return;
            }
            if (checkEnd()) { sendMove(i, 0); return; } // still relay the winning move
            status("Move sent. Waiting for opponent…");
            sendMove(i, 0);
        }

        // ── bot (offline) ────────────────────────────────────────────────────
        function botTurn() {
            if (destroyed || gameOver) return;
            var botMark = (myMark === X ? O : X);
            var mv = tttBotMove(board, botMark);
            if (mv < 0) { checkEnd(); return; }
            place(mv, botMark);
            turn = myMark;
            render(null);
            if (checkEnd()) return;
            status("Your turn.");
        }

        // ── relay + polling ──────────────────────────────────────────────────
        function sendMove(cell, attempt) {
            if (destroyed) return;
            Api.move(code, cell, 9, 1, function () {
                appliedSeq++;              // our own placement is now in the shared list
                if (!gameOver) startPolling();
            }, function () {
                $.Schedule(0.6, function () { sendMove(cell, (attempt || 0) + 1); }); // retry
            });
        }

        function startPolling() {
            pollToken++;
            pollOnce(pollToken);
        }

        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken || gameOver) return;
            if (turn === myMark) return; // our move; nothing to poll
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    var oppMark = (myMark === X ? O : X);
                    if (!board[mv.from]) place(mv.from, oppMark); // from = the cell played
                    appliedSeq++;
                    turn = myMark;
                    render(null);
                    if (checkEnd()) return;
                    status("Your turn.");
                } else {
                    $.Schedule(0.4, function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(0.6, function () { pollOnce(myToken); });
            }, function (from, to) {
                // A placement is a single cell 0..8 with the fixed marker to=9.
                return from >= 0 && from <= 8 && to === 9;
            });
        }

        // ── boot ─────────────────────────────────────────────────────────────
        render(null);
        if (myTurn()) {
            status("Your turn. You play " + (myMark === X ? "✕ (X)." : "◯ (O)."));
        } else if (session.bot) {
            // Offline and it's X's turn but I'm O → the bot (X) opens.
            status("Bot is thinking…");
            $.Schedule(0.4, botTurn);
        } else {
            status("Opponent's turn…");
            startPolling();
        }

        return {
            destroy: function () { destroyed = true; pollToken++; try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    // ══ CHESS ═══════════════════════════════════════════════════════════════════
    // ── chess: pure rules ────────────────────────────────────────────────────────
    // Self-contained engine (NO deps on the checkers helpers above) so
    // tools/mg_chess_test.js can slice this whole section and run it standalone. Board is
    // a flat Array(64), index = row*8 + col, row 0 = TOP (black back rank), row 7 = BOTTOM
    // (white back rank). Piece value: 0 empty; SIGN = colour (white > 0, black < 0); ABS =
    // type 1=pawn 2=knight 3=bishop 4=rook 5=queen 6=king. "Colour" here is +1 (white) /
    // -1 (black) — the sign of the piece — NOT the checkers WHITE/BLACK strings.
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

    // ── chess controller ─────────────────────────────────────────────────────────
    // Mirrors createCheckers: same board geometry, same proven click+drag input, same
    // move/poll transport. Differences: pieces are .vtex sprites, colour is +1/-1 (sign of
    // the piece), and a turn is a single move (no multi-jump chains). Castling / en passant /
    // promotion are derived from board+state by makeMove, so from/to alone travels the wire.
    function createChess(container, session) {
        var Api = MG.Api;
        var code = session.code;
        var myColor = session.isHost ? 1 : -1;   // host = white (+1), joiner = black (-1)
        var board = initialChessBoard();
        var cst = initialChessState();
        var turn = 1;                  // white moves first
        var appliedSeq = 0;            // moves consumed from the shared server list
        var selected = -1;
        var legalTargets = [];         // [{to}] — shape kept identical to checkers so the drag code is shared
        var pollToken = 0;
        var destroyed = false;
        var gameOver = false;

        var dragActive = false, dragGhost = null, dragOverSq = -1, dragEnterCount = 0;
        var DRAG_DEBUG = false;        // drag path is the proven checkers recipe; flip on only to debug

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function parsePx(v) {
            if (typeof v !== "string" || !v.length) return null;
            var m = v.match(/-?\d+(\.\d+)?/);
            return m ? parseFloat(m[0]) : null;
        }

        // Black sees the board rotated 180° so its own pieces sit at the bottom.
        function toDisplay(i) { return myColor === 1 ? i : 63 - i; }
        function fromDisplay(i) { return myColor === 1 ? i : 63 - i; }

        function pieceImg(v) {
            var name = (v > 0 ? "White" : "Black") + ["", "Pawn", "Knight", "Bishop", "Rook", "Queen", "King"][cType(v)];
            return "url('s2r://panorama/images/" + name + ".vtex')";
        }

        var root = $.CreatePanel("Panel", container, "MG_ChessRoot");
        root.AddClass("mg-chess");
        var boardWrap = $.CreatePanel("Panel", root, "MG_ChessWrap");
        boardWrap.AddClass("mg-board-wrap");
        var boardPanel = $.CreatePanel("Panel", boardWrap, "MG_ChessBoard");
        boardPanel.AddClass("mg-board");

        var SQ = 60, PIECE_SZ = 56, INSET = (SQ - PIECE_SZ) / 2;
        function transformFor(realIdx) {
            var d = toDisplay(realIdx);
            var dr = (d / 8) | 0, dc = d % 8;
            return "translate3d(" + (dc * SQ + INSET) + "px, " + (dr * SQ + INSET) + "px, 0px)";
        }

        var cells = [];
        var piecesLayer = null;
        var pieceEls = {};

        function buildCells() {
            boardPanel.RemoveAndDeleteChildren();
            cells = [];
            pieceEls = {};
            for (var dr = 0; dr < 8; dr++) {
                var rowPanel = $.CreatePanel("Panel", boardPanel, "row_" + dr);
                rowPanel.AddClass("mg-board-row");
                for (var dc = 0; dc < 8; dc++) {
                    var d = dr * 8 + dc;
                    var i = fromDisplay(d);
                    var cell = $.CreatePanel("Panel", rowPanel, "cell_" + i);
                    cell.AddClass("mg-cell");
                    cell.AddClass(((cRow(i) + cCol(i)) & 1) === 1 ? "mg-cell-dark" : "mg-cell-light");
                    (function (square) {
                        cell.SetPanelEvent("onactivate", function () { onCellClick(square); });
                        $.RegisterEventHandler("DragEnter", cell, function () {
                            if (dragActive) { dragOverSq = square; dragEnterCount++; }
                            return true;
                        });
                        $.RegisterEventHandler("DragLeave", cell, function () {
                            if (dragActive && dragOverSq === square) dragOverSq = -1;
                        });
                        $.RegisterEventHandler("DragDrop", cell, function () { onCellDrop(square); });
                        cell.SetPanelEvent("onmouseover", function () { if (dragActive) dragOverSq = square; });
                    })(i);
                    cells[i] = cell;
                }
            }
            piecesLayer = $.CreatePanel("Panel", boardWrap, "MG_ChessPieces");
            piecesLayer.AddClass("mg-pieces-layer");
            try { piecesLayer.SetAttributeString("hittest", "false"); } catch (e) {}
        }

        function makePiece(realIdx, v) {
            var piece = $.CreatePanel("Panel", piecesLayer, "");
            piece.AddClass("mg-piece");
            piece.AddClass("mg-chess-piece");
            piece.style.backgroundImage = pieceImg(v);
            piece.style.transform = transformFor(realIdx);
            $.Schedule(0.0, function () {
                if (piece && piece.IsValid && piece.IsValid()) piece.AddClass("mg-anim");
            });
            piece._sq = realIdx;
            pieceEls[realIdx] = piece;
            setupPieceInput(piece);
            return piece;
        }

        function setupPieceInput(piece) {
            piece.SetPanelEvent("onactivate", function () {
                if (piece._sq === undefined) return;
                onCellClick(piece._sq);
            });
            if (cSign(board[piece._sq]) !== myColor) return;   // only my pieces are grabbable
            piece.SetDraggable(true);

            $.RegisterEventHandler("DragStart", piece, function (_p, dragEvent) {
                var sq = piece._sq;
                var ghost = $.CreatePanel("Panel", piecesLayer, "");
                ghost.AddClass("mg-piece");
                ghost.AddClass("mg-chess-piece");
                ghost.AddClass("mg-dragging");
                ghost.style.backgroundImage = pieceImg(board[sq]);
                try { ghost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragGhost = ghost;
                dragEvent.displayPanel = ghost;
                dragEvent.removePositionBeforeDrop = false;
                ghost.style.align = "left top";

                dragActive = true;
                dragOverSq = -1;
                dragEnterCount = 0;
                piece.AddClass("mg-drag-source");

                if (!destroyed && myTurn() && selected !== sq) onCellClick(sq);
            });

            $.RegisterEventHandler("DragEnd", piece, function (_p, droppedPanel) {
                commitDropMultimethod(droppedPanel);
                if (dragGhost) { try { dragGhost.DeleteAsync(0); } catch (e) {} dragGhost = null; }
                piece.RemoveClass("mg-drag-source");
                dragActive = false;
                dragOverSq = -1;
            });
        }

        // ── drop resolution (verbatim from checkers: proven in-game 2026-07-07) ──────
        function isLegalTarget(sq) {
            for (var t = 0; t < legalTargets.length; t++) if (legalTargets[t].to === sq) return true;
            return false;
        }
        function squareFromPanel(p) {
            for (var hops = 0; p && hops < 6; hops++) {
                var id = null;
                try { id = p.id; } catch (e) {}
                if (id && id.indexOf("cell_") === 0) {
                    var n = parseInt(id.substring(5), 10);
                    if (isFinite(n) && n >= 0 && n < 64) return n;
                }
                try { p = p.GetParent ? p.GetParent() : null; } catch (e2) { p = null; }
            }
            return -1;
        }
        function winPos(panel) {
            if (!panel || !panel.GetPositionWithinWindow) return null;
            var r;
            try { r = panel.GetPositionWithinWindow(); } catch (e) { return null; }
            if (!r) return null;
            var x = (typeof r.x === "number") ? r.x : (typeof r[0] === "number" ? r[0] : null);
            var y = (typeof r.y === "number") ? r.y : (typeof r[1] === "number" ? r[1] : null);
            if (x === null || y === null || !isFinite(x) || !isFinite(y)) return null;
            if (Math.abs(x) > 100000 || Math.abs(y) > 100000) return null;
            return { x: x, y: y };
        }
        function squareFromWindow() {
            var lp = winPos(piecesLayer);
            var gp = winPos(dragGhost);
            if (!lp || !gp) return -1;
            var layerW = (piecesLayer && isFinite(piecesLayer.actuallayoutwidth) && piecesLayer.actuallayoutwidth > 0)
                ? piecesLayer.actuallayoutwidth : 480;
            var cellPx = layerW / 8;
            var pieceW = (dragGhost && isFinite(dragGhost.actuallayoutwidth) && dragGhost.actuallayoutwidth > 0
                          && dragGhost.actuallayoutwidth < 100000)
                ? dragGhost.actuallayoutwidth : (PIECE_SZ * cellPx / SQ);
            var cx = (gp.x - lp.x) + pieceW / 2;
            var cy = (gp.y - lp.y) + pieceW / 2;
            var dcol = Math.floor(cx / cellPx), drow = Math.floor(cy / cellPx);
            if (dcol < 0 || dcol > 7 || drow < 0 || drow > 7) return -1;
            return fromDisplay(drow * 8 + dcol);
        }
        function ghostPos() {
            var g = dragGhost;
            if (!g || (g.IsValid && !g.IsValid())) return null;
            try { if (g.GetParent && g.GetParent() !== piecesLayer) g.SetParent(piecesLayer); } catch (e) {}
            var sx = parsePx(g.style ? g.style.x : null);
            var sy = parsePx(g.style ? g.style.y : null);
            var ax = (typeof g.actualxoffset === "number" && isFinite(g.actualxoffset)) ? g.actualxoffset : null;
            var ay = (typeof g.actualyoffset === "number" && isFinite(g.actualyoffset)) ? g.actualyoffset : null;
            var x = (sx !== null) ? sx : ax;
            var y = (sy !== null) ? sy : ay;
            if (x === null || y === null) return null;
            return { x: x, y: y };
        }
        function squareFromGhost() {
            var p = ghostPos();
            if (!p) return -1;
            if (p.x === 0 && p.y === 0) return -1;
            var cx = p.x + PIECE_SZ / 2, cy = p.y + PIECE_SZ / 2;
            var dcol = Math.floor(cx / SQ), drow = Math.floor(cy / SQ);
            if (dcol < 0 || dcol > 7 || drow < 0 || drow > 7) return -1;
            return fromDisplay(drow * 8 + dcol);
        }
        function commitDropMultimethod(droppedPanel) {
            if (destroyed || !myTurn() || selected < 0) return;
            var wSq = squareFromWindow();
            var aPanel = squareFromPanel(droppedPanel);
            var bOver = dragOverSq;
            var cGhost = squareFromGhost();
            var candidates = [wSq, aPanel, bOver, cGhost];
            for (var k = 0; k < candidates.length; k++) {
                if (candidates[k] >= 0 && isLegalTarget(candidates[k])) { onCellDrop(candidates[k]); return; }
            }
            if (DRAG_DEBUG) status("DROP MISS win=" + wSq + " panel=" + aPanel + " over=" + bOver + " ghost=" + cGhost);
        }

        // ── rendering ───────────────────────────────────────────────────────────────
        function layoutPieces() {
            if (!piecesLayer) return;
            piecesLayer.RemoveAndDeleteChildren();
            pieceEls = {};
            for (var i = 0; i < 64; i++) { if (board[i] !== 0) makePiece(i, board[i]); }
        }

        function refreshHighlights() {
            for (var i = 0; i < 64; i++) {
                var cell = cells[i];
                if (!cell) continue;
                cell.RemoveClass("mg-sel");
                cell.RemoveClass("mg-target");
                cell.RemoveClass("mg-check");
            }
            if (selected >= 0 && cells[selected]) cells[selected].AddClass("mg-sel");
            for (var t = 0; t < legalTargets.length; t++) {
                var tc = cells[legalTargets[t].to];
                if (tc) tc.AddClass("mg-target");
            }
            if (!gameOver && inCheck(board, turn)) {
                var ks = findKing(board, turn);
                if (ks >= 0 && cells[ks]) cells[ks].AddClass("mg-check");
            }
        }

        function slidePiece(from, to) {
            var piece = pieceEls[from];
            delete pieceEls[from];
            if (!piece || !piece.IsValid || !piece.IsValid()) { if (board[to] !== 0) makePiece(to, board[to]); return; }
            piece.style.transform = transformFor(to);
            piece._sq = to;
            pieceEls[to] = piece;
        }

        // Apply from→to to the model and mirror it visually: slide the mover, fade any capture
        // (incl. en passant), swap the sprite on promotion, and slide the rook on a castle.
        function applyChessMove(from, to) {
            var mover = board[from], t = cType(mover), color = cSign(mover);
            var fr = cRow(from), fc = cCol(from), tr = cRow(to), tc = cCol(to);
            var capSq = -1;
            if (t === C_PAWN && tc !== fc && board[to] === 0) capSq = cSq(fr, tc);   // en passant
            else if (board[to] !== 0) capSq = to;

            var r = makeMove(board, cst, from, to);
            board = r[0]; cst = r[1];

            if (capSq >= 0 && pieceEls[capSq]) {
                var dead = pieceEls[capSq];
                delete pieceEls[capSq];
                dead.AddClass("mg-captured");
                dead.style.preTransformScale2d = "0.2";
                (function (d) { $.Schedule(0.22, function () { try { d.DeleteAsync(0); } catch (e) {} }); })(dead);
            }
            slidePiece(from, to);
            if (t === C_PAWN && (tr === 0 || tr === 7)) {
                var pp = pieceEls[to];
                if (pp && pp.IsValid && pp.IsValid()) pp.style.backgroundImage = pieceImg(color * C_QUEEN);
            }
            if (t === C_KING && Math.abs(tc - fc) === 2) {
                if (tc - fc === 2) slidePiece(cSq(fr, 7), cSq(fr, 5));   // O-O  rook h→f
                else slidePiece(cSq(fr, 0), cSq(fr, 3));                 // O-O-O rook a→d
            }
        }

        // ── input / move flow ────────────────────────────────────────────────────────
        function myTurn() { return turn === myColor && !gameOver; }
        function clearSelection() { selected = -1; legalTargets = []; }

        function targetsFor(i) {
            var all = legalMoves(board, cst, myColor), out = [];
            for (var k = 0; k < all.length; k++) if (all[k].from === i) out.push({ to: all[k].to });
            return out;
        }

        function onCellClick(i) {
            if (destroyed || !myTurn()) return;
            if (selected >= 0) {
                for (var t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalMove(selected, i); return; }
                }
            }
            if (cSign(board[i]) === myColor) {
                var tg = targetsFor(i);
                if (tg.length === 0) { status("That piece has no legal move."); return; }
                selected = i;
                legalTargets = tg;
                refreshHighlights();
            }
        }

        function onCellDrop(i) {
            if (destroyed || !myTurn() || !dragActive || selected < 0) return;
            for (var t = 0; t < legalTargets.length; t++) {
                if (legalTargets[t].to === i) { doLocalMove(selected, i); return; }
            }
        }

        function doLocalMove(from, to) {
            applyChessMove(from, to);
            clearSelection();
            turn = -myColor;               // hand off locally
            refreshHighlights();

            if (session.bot) {
                if (!checkEnd()) { status("Bot is thinking…"); scheduleBotTurn(); }
                return;
            }
            status("Move sent. Waiting for opponent…");
            checkEnd();                    // may end the game (and set the win/draw status)
            sendChessMove(from, to);       // always relay — the opponent must see even a mating move
        }

        // ── bot (offline) ─────────────────────────────────────────────────────────────
        function scheduleBotTurn() { $.Schedule(0.45, botTurn); }
        function botTurn() {
            if (destroyed || gameOver) return;
            var botColor = -myColor;
            var mv = chessBotMove(board, cst, botColor);
            if (!mv) { checkEnd(); return; }
            applyChessMove(mv.from, mv.to);
            turn = myColor;
            refreshHighlights();
            if (!checkEnd()) status(inCheck(board, myColor) ? "Check! Your turn." : "Your turn.");
        }

        // ── networking ─────────────────────────────────────────────────────────────────
        function sendChessMove(from, to) {
            if (destroyed) return;
            Api.move(code, from, to, 1, function () {
                appliedSeq++;
                afterTurnSwitch();
            }, function () {
                $.Schedule(0.6, function () { sendChessMove(from, to); });
            });
        }
        function afterTurnSwitch() {
            if (gameOver) return;
            startPolling();
        }
        function startPolling() {
            pollToken++;
            pollOnce(pollToken);
        }
        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken) return;
            if (turn === myColor) return;
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    appliedSeq++;
                    applyChessMove(mv.from, mv.to);
                    turn = myColor;                 // every chess move ends the turn (end always 1)
                    refreshHighlights();
                    if (!checkEnd()) status(inCheck(board, myColor) ? "Check! Your turn." : "Your turn.");
                } else {
                    $.Schedule(0.4, function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(0.6, function () { pollOnce(myToken); });
            }, function (from, to) {
                return from >= 0 && from < 64 && to >= 0 && to < 64 && from !== to;
            });
        }

        // ── end of game ─────────────────────────────────────────────────────────────────
        // Evaluates the side whose turn it now is. Returns true if the game ended.
        function checkEnd() {
            var res = chessResult(board, cst, turn);
            if (res === "checkmate") { finish(-turn); return true; }
            if (res === "stalemate") { finishDraw(); return true; }
            return false;
        }
        function finish(winner) {
            gameOver = true;
            clearSelection();
            refreshHighlights();
            status(winner === myColor ? "🏆 Checkmate — you win!" : "Checkmate — you lose.");
        }
        function finishDraw() {
            gameOver = true;
            clearSelection();
            refreshHighlights();
            status("Stalemate — it's a draw.");
        }

        // ── boot ──────────────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
        if (myTurn()) {
            status("Your turn. You play " + (myColor === 1 ? "white (bottom)." : "black (bottom)."));
        } else if (session.bot) {
            status("Bot is thinking…");
            scheduleBotTurn();
        } else {
            status("Opponent's turn…");
            startPolling();
        }

        return {
            destroy: function () { destroyed = true; pollToken++; try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    // ── placeholder for not-yet-built games ─────────────────────────────────
    function createStub(container, session, name) {
        var root = $.CreatePanel("Panel", container, "MG_Stub");
        root.AddClass("mg-stub");
        var l = $.CreatePanel("Label", root, "");
        l.AddClass("mg-stub-label");
        l.text = (name || "This game") + ": coming soon.";
        return { destroy: function () { try { root.DeleteAsync(0); } catch (e) {} } };
    }

    // ── game registry ────────────────────────────────────────────────────────
    // The picker reads `list` (id/key/name/enabled); `mount` dispatches to a factory
    // registered under the game's id. Games self-register their factory via
    // `register(...)` so a new game (e.g. Durak in mg_durak.js) can live in its own
    // file: it just calls MG.Games.register(...) after this script has run — no edit
    // to the dispatch here. A game with no registered factory falls back to the stub.
    MG.Games = {
        list: [
            { id: 1, key: "checkers", name: "Checkers", enabled: true },
            { id: 2, key: "tictactoe", name: "Tic-Tac-Toe", enabled: true },
            { id: 3, key: "durak", name: "Durak", enabled: false },
            { id: 4, key: "chess", name: "Chess", enabled: true },
            { id: 5, key: "connectfour", name: "Connect Four", enabled: false },
            { id: 6, key: "soon1", name: "Coming Soon", enabled: false },
            { id: 7, key: "soon2", name: "Coming Soon", enabled: false },
            { id: 8, key: "soon3", name: "Coming Soon", enabled: false },
            { id: 9, key: "soon4", name: "Coming Soon", enabled: false }
        ],
        _factories: {},
        byId: function (id) {
            var l = this.list;
            for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
            return null;
        },
        // opts = { id, create, enabled? }. Registers the mount factory for a game and
        // optionally flips its `enabled` flag (so a game file can enable itself only
        // once its factory is actually present).
        register: function (opts) {
            if (!opts || opts.id == null || typeof opts.create !== "function") return;
            this._factories[opts.id] = opts.create;
            if (typeof opts.enabled === "boolean") {
                var g = this.byId(opts.id);
                if (g) g.enabled = opts.enabled;
            }
        },
        mount: function (gameId, container, session) {
            var f = this._factories[gameId];
            if (f) return f(container, session);
            var g = this.byId(gameId);
            return createStub(container, session, g ? g.name : null);
        }
    };

    // Built-in games register their factories (their bodies live above in this file).
    MG.Games.register({ id: 1, create: createCheckers });
    MG.Games.register({ id: 2, create: createTicTacToe });
    MG.Games.register({ id: 4, create: createChess });
})();
