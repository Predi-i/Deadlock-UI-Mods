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

    // ── shared pure rules (single source of truth: rules/checkers.js + rules/ttt.js) ─
    // The rules engines load BEFORE this file (base_hud.xml order: net → rules/* →
    // games) and hang off MG.Rules. We alias each function to a local name IDENTICAL
    // to the old inline copy, so every controller below is untouched — but the bytes
    // now come from the exact same files the authoritative server runs. This is what
    // guarantees the client predictor and the server authority can never disagree.
    var RC = MG.Rules.checkers, RT = MG.Rules.ttt;
    var WHITE = RC.WHITE, BLACK = RC.BLACK;
    var idx = RC.idx, rowOf = RC.rowOf, colOf = RC.colOf, isDark = RC.isDark;
    var colorOf = RC.colorOf, isKing = RC.isKing;
    var initialBoard = RC.initialBoard;
    var simpleMoves = RC.simpleMoves, captureMoves = RC.captureMoves;
    var anyCaptureFor = RC.anyCaptureFor, applyHop = RC.applyHop, hasAnyMove = RC.hasAnyMove;
    var legalSequences = RC.legalSequences, chooseBotMove = RC.chooseBotMove;
    var tttWinner = RT.tttWinner, tttFull = RT.tttFull, tttBotMove = RT.tttBotMove;

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
        var dragSourcePiece = null;    // the real piece being dragged (so we can un-dim it even if it's since been deleted)

        // Tear the drag state down from ANY exit path, not just DragEnd. The DragEnd handler is
        // bound to the PIECE panel; if the opponent captures that piece while you hold it (a
        // polled hop → animateHop deletes the panel), the panel — and its DragEnd handler — is
        // gone, the engine never synthesises DragEnd on a dead panel, and the ghost + dragActive
        // leak forever (the "zависший ghost при съедении" bug). Calling clearDrag() from the
        // capture/rebuild paths covers that. Idempotent: a no-op once already cleared (own move,
        // click move), so it's safe to call unconditionally.
        function clearDrag() {
            if (dragGhost) { try { dragGhost.DeleteAsync(0); } catch (e) {} dragGhost = null; }
            dragActive = false;
            dragOverSq = -1;
            if (dragSourcePiece) { try { dragSourcePiece.RemoveClass("mg-drag-source"); } catch (e) {} dragSourcePiece = null; }
        }

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
            // Coordinate labels (lichess style): files a–h along the bottom row, ranks 1–8 down
            // the left column, each tucked into the cell corner and coloured the OPPOSITE of the
            // square so it reads on either shade. Built on its own hittest:false overlay (created
            // BEFORE the pieces layer so pieces paint over it) and positioned by transform, so it
            // never interferes with cell clicks. File/rank come from the REAL square (fromDisplay),
            // so the labels flip automatically when the board is drawn from Black's side.
            buildCoords();
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

        // Draw the a–h / 1–8 coordinate labels on a dedicated overlay. SQ=60; a label sits in
        // the cell corner (file: bottom-right of the bottom row; rank: top-left of the left col).
        function buildCoords() {
            var layer = $.CreatePanel("Panel", boardWrap, "MG_CoordsLayer");
            layer.AddClass("mg-coords-layer");
            try { layer.SetAttributeString("hittest", "false"); } catch (e) {}
            for (var d = 0; d < 64; d++) {
                var dr = (d / 8) | 0, dc = d % 8;
                if (dr !== 7 && dc !== 0) continue;           // only bottom row + left column
                var i = fromDisplay(d);
                var onDark = isDark(rowOf(i), colOf(i));
                if (dc === 0) {                                // rank number, top-left corner
                    addCoord(layer, dc * SQ, dr * SQ, String(8 - rowOf(i)), onDark, "rank");
                }
                if (dr === 7) {                                // file letter, bottom-right corner
                    addCoord(layer, dc * SQ, dr * SQ, String.fromCharCode(97 + colOf(i)), onDark, "file");
                }
            }
        }
        function addCoord(layer, x, y, text, onDark, kind) {
            var lbl = $.CreatePanel("Label", layer, "");
            lbl.AddClass("mg-coord");
            lbl.AddClass(onDark ? "mg-coord-ondark" : "mg-coord-onlight");
            lbl.text = text;
            // Place the small glyph directly in the cell corner by transform (flow:none parent,
            // same idiom as the pieces). rank → top-left; file → bottom-right of the 60px cell.
            var ox = kind === "file" ? (SQ - 14) : 3;
            var oy = kind === "file" ? (SQ - 17) : 2;
            lbl.style.transform = "translate3d(" + (x + ox) + "px, " + (y + oy) + "px, 0px)";
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
                dragSourcePiece = piece;
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

                // Tear the ghost + dim + drag state down regardless of outcome. A drop on empty
                // space (no legal target) just snaps back — the real piece never moved.
                clearDrag();
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

        // Render scale = WINDOW px per LAYOUT px. Panorama scales the whole UI by one uniform
        // factor, but a panel's actuallayoutwidth stays in LAYOUT px while GetPositionWithinWindow
        // returns WINDOW px. The old squareFromWindow divided a window-px delta by a layout-px cell
        // size (=60) — they only agree at 100% UI scale; at 125% the drop landed a square or two off
        // (the maintainer's "DROP MISS win=30 … targets=[21]" trace: 1.25× off). We DERIVE the scale
        // from two board cells a known layout distance apart, using ONLY GetPositionWithinWindow
        // (proven in-game 2026-07-07). actualuiscale_x IS in the engine property table but neither
        // the game nor QOLLOCK reads it from JS, so we measure instead of trusting it (property
        // fallback only if the cell measurement fails).
        function uiScale() {
            var a = cells[fromDisplay(0)];   // display (row 0, col 0)
            var b = cells[fromDisplay(7)];   // display (row 0, col 7) — 7 cells to the right
            var pa = winPos(a), pb = winPos(b);
            if (pa && pb) {
                var dx = Math.abs(pb.x - pa.x);       // = 7 * SQ * scale in window px
                if (dx > 1) return dx / (7 * SQ);
            }
            var s = piecesLayer ? Number(piecesLayer.actualuiscale_x) : NaN;
            if (isFinite(s) && s > 0.1 && s < 10) return s;
            return 1;
        }

        // Map the ghost's window position to a board square. Convert the window-space ghost→layer
        // delta into LAYOUT-space cells via uiScale(): cell size in window px = SQ * scale, the
        // ghost's half-width in window px = PIECE_SZ * scale (its layout size scaled up). Ghost
        // centre relative to the layer origin ÷ the window cell size → display col/row → real square.
        function squareFromWindow() {
            var lp = winPos(piecesLayer);
            var gp = winPos(dragGhost);
            if (!lp || !gp) return -1;
            var scale = uiScale();
            var cellW = SQ * scale;                 // one cell, in window px
            var half = (PIECE_SZ * scale) / 2;      // ghost half-width, in window px
            var cx = (gp.x - lp.x) + half;
            var cy = (gp.y - lp.y) + half;
            var dcol = Math.floor(cx / cellW), drow = Math.floor(cy / cellW);
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
            clearDrag();                 // a full rebuild deletes the ghost with the layer; also reset the vars
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
            // ANY hop can capture the very piece you're mid-drag on (an opponent's polled hop, or
            // a bot move). That capture deletes the piece panel, taking its DragEnd handler with
            // it, so the ghost would hang forever. Clear the drag up front. For your OWN move the
            // drag already ended (ghost null), so this is a harmless no-op.
            clearDrag();
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
            Api.move(code, hop.from, hop.to, hop.end, session.tok, function (r) {
                if (r.ok) {
                    appliedSeq++; // our own hop is now in the shared server list
                    sendHops(hops, i + 1);
                    return;
                }
                // The AUTHORITATIVE server rejected this hop (illegal / not-our-turn /
                // bad token). Our optimistic prediction is now wrong — roll the whole
                // turn back to the last server-confirmed state and resync via poll.
                rejectAndResync(r.reason);
            }, function () {
                $.Schedule(0.6, function () { sendHops(hops, i); }); // transport hiccup: retry same hop
            });
        }

        // Server said no. Discard the predicted turn, rebuild the board from the moves
        // the server HAS accepted (0..appliedSeq), and drop back into polling so the
        // authoritative sequence drives us again. A cheat's illegal hop dies here; an
        // honest desync self-heals instead of wedging.
        function rejectAndResync(reason) {
            pendingHops = [];
            chaining = false;
            clearSelection();
            board = initialBoard();
            turn = WHITE;
            replayAccepted(0);
        }

        // Re-fetch and re-apply the server's accepted moves from `seq` up to appliedSeq,
        // rebuilding the local board, then resume the normal turn/poll loop.
        function replayAccepted(seq) {
            if (destroyed) return;
            if (seq >= appliedSeq) {
                layoutPieces();
                refreshHighlights();
                if (myTurn()) status("Move rejected — resynced. Your turn.");
                else { status("Move rejected — resyncing…"); startPolling(); }
                return;
            }
            Api.poll(code, seq, function (mv) {
                if (destroyed) return;
                if (mv) {
                    applyHop(board, mv.from, mv.to);
                    if (mv.end) turn = (turn === WHITE ? BLACK : WHITE);
                    replayAccepted(seq + 1);
                } else {
                    // fewer accepted moves than expected — trust what we have
                    appliedSeq = seq;
                    replayAccepted(seq);
                }
            }, function () { $.Schedule(0.4, function () { replayAccepted(seq); }); });
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
            destroy: function () { destroyed = true; pollToken++; clearDrag(); try { root.DeleteAsync(0); } catch (e) {} }
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
            Api.move(code, cell, 9, 1, session.tok, function (r) {
                if (r.ok) {
                    appliedSeq++;          // our own placement is now in the shared server list
                    if (!gameOver) startPolling();
                    return;
                }
                rejectAndResync(r.reason); // server refused (occupied / not our turn / bad token)
            }, function () {
                $.Schedule(0.6, function () { sendMove(cell, (attempt || 0) + 1); }); // transport retry
            });
        }

        // Server rejected our placement — discard the optimistic mark, rebuild the board
        // from the accepted log, and resume polling so the authoritative order drives us.
        function rejectAndResync(reason) {
            gameOver = false;
            for (var q = 0; q < 9; q++) board[q] = 0;
            turn = X;
            replayAccepted(0);
        }
        function replayAccepted(seq) {
            if (destroyed) return;
            if (seq >= appliedSeq) {
                render(null);
                if (myTurn()) status("Move rejected — resynced. Your turn.");
                else { status("Move rejected — resyncing…"); startPolling(); }
                return;
            }
            Api.poll(code, seq, function (mv) {
                if (destroyed) return;
                if (mv) {
                    var mk = (seq % 2 === 0) ? X : O; // X placed the even-indexed moves
                    if (!board[mv.from]) place(mv.from, mk);
                    turn = (mk === X ? O : X);
                    replayAccepted(seq + 1);
                } else { appliedSeq = seq; replayAccepted(seq); }
            }, function () { $.Schedule(0.4, function () { replayAccepted(seq); }); },
            function (from, to) { return from >= 0 && from <= 8 && to === 9; });
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
    // ── chess: shared pure rules (single source of truth: rules/chess.js) ──────────
    // Same alias idiom as checkers/ttt above: the engine lives in rules/chess.js (loaded
    // before this file and shared byte-for-byte with the authoritative server); here we
    // just bind local names identical to the old inline copies so the controller is
    // untouched. Colour is +1 (white) / -1 (black) — the sign of the piece.
    var RX = MG.Rules.chess;
    var C_PAWN = RX.C_PAWN, C_QUEEN = RX.C_QUEEN, C_KING = RX.C_KING;
    var cSq = RX.cSq, cRow = RX.cRow, cCol = RX.cCol, cSign = RX.cSign, cType = RX.cType;
    var initialChessBoard = RX.initialChessBoard, initialChessState = RX.initialChessState;
    var makeMove = RX.makeMove, legalMoves = RX.legalMoves, inCheck = RX.inCheck;
    var findKing = RX.findKing, chessResult = RX.chessResult, chessBotMove = RX.chessBotMove;

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
        var dragSourcePiece = null;    // the real piece being dragged (un-dim even if it's since been deleted)
        var DRAG_DEBUG = false;        // drag path is the proven checkers recipe; flip on only to debug

        // Tear the drag state down from ANY exit path, not just DragEnd (bound to the piece panel).
        // If the opponent captures the piece you're holding (a polled move → applyChessMove deletes
        // the panel), the panel and its DragEnd handler vanish, the engine never fires DragEnd on a
        // dead panel, and the ghost + dragActive leak forever. clearDrag() from the capture/rebuild
        // paths covers that. Idempotent, so safe to call unconditionally (own/click move = no-op).
        function clearDrag() {
            if (dragGhost) { try { dragGhost.DeleteAsync(0); } catch (e) {} dragGhost = null; }
            dragActive = false;
            dragOverSq = -1;
            if (dragSourcePiece) { try { dragSourcePiece.RemoveClass("mg-drag-source"); } catch (e) {} dragSourcePiece = null; }
        }

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function parsePx(v) {
            if (typeof v !== "string" || !v.length) return null;
            var m = v.match(/-?\d+(\.\d+)?/);
            return m ? parseFloat(m[0]) : null;
        }

        // Black sees the board rotated 180° so its own pieces sit at the bottom.
        function toDisplay(i) { return myColor === 1 ? i : 63 - i; }
        function fromDisplay(i) { return myColor === 1 ? i : 63 - i; }

        function pieceUrl(v) {
            var name = (v > 0 ? "White" : "Black") + ["", "Pawn", "Knight", "Bishop", "Rook", "Queen", "King"][cType(v)];
            return "s2r://panorama/images/" + name + ".vtex";
        }
        // Draw a piece sprite with a CHILD <Image> (SetImage + scaling), NOT the container's
        // style.backgroundImage. A Panel background paints the .vtex at its NATIVE pixel size
        // (250²) until the panel is re-laid-out, the same first-frame zoom the cards hit. An
        // <Image> fills its CSS box from frame 1 (game idiom: hud_ability_icon.xml). The piece
        // panel keeps its transform/anim/drag-source state; the Image just fills it and is
        // transparent to input. SetImage takes the BARE s2r:// url.
        function setFace(container, url) {
            var img = container._faceImg;
            if (!img) {
                img = $.CreatePanel("Image", container, "", { scaling: "stretch-to-fit-preserve-aspect" });
                img.AddClass("mg-face-img");
                try { img.SetAttributeString("hittest", "false"); } catch (e) {}
                container._faceImg = img;
            }
            img.SetImage(url);
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
            buildCoords();     // a–h / 1–8 labels, opposite-shade, on their own hittest:false overlay
            piecesLayer = $.CreatePanel("Panel", boardWrap, "MG_ChessPieces");
            piecesLayer.AddClass("mg-pieces-layer");
            try { piecesLayer.SetAttributeString("hittest", "false"); } catch (e) {}
        }

        // lichess-style coordinates: files a–h on the bottom row, ranks 1–8 down the left column,
        // coloured opposite the square. File/rank derive from the REAL square (fromDisplay) so the
        // labels flip with the board when drawn from Black's side. See createCheckers.buildCoords.
        function buildCoords() {
            var layer = $.CreatePanel("Panel", boardWrap, "MG_ChessCoordsLayer");
            layer.AddClass("mg-coords-layer");
            try { layer.SetAttributeString("hittest", "false"); } catch (e) {}
            for (var d = 0; d < 64; d++) {
                var dr = (d / 8) | 0, dc = d % 8;
                if (dr !== 7 && dc !== 0) continue;
                var i = fromDisplay(d);
                var onDark = ((cRow(i) + cCol(i)) & 1) === 1;   // same parity test buildCells uses
                if (dc === 0) addCoord(layer, dc * SQ, dr * SQ, String(8 - cRow(i)), onDark, "rank");
                if (dr === 7) addCoord(layer, dc * SQ, dr * SQ, String.fromCharCode(97 + cCol(i)), onDark, "file");
            }
        }
        function addCoord(layer, x, y, text, onDark, kind) {
            var lbl = $.CreatePanel("Label", layer, "");
            lbl.AddClass("mg-coord");
            lbl.AddClass(onDark ? "mg-coord-ondark" : "mg-coord-onlight");
            lbl.text = text;
            var ox = kind === "file" ? (SQ - 14) : 3;      // rank → top-left; file → bottom-right
            var oy = kind === "file" ? (SQ - 17) : 2;
            lbl.style.transform = "translate3d(" + (x + ox) + "px, " + (y + oy) + "px, 0px)";
        }

        function makePiece(realIdx, v) {
            var piece = $.CreatePanel("Panel", piecesLayer, "");
            piece.AddClass("mg-piece");
            piece.AddClass("mg-chess-piece");
            setFace(piece, pieceUrl(v));
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
                setFace(ghost, pieceUrl(board[sq]));
                try { ghost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragGhost = ghost;
                dragEvent.displayPanel = ghost;
                dragEvent.removePositionBeforeDrop = false;
                ghost.style.align = "left top";

                dragActive = true;
                dragOverSq = -1;
                dragEnterCount = 0;
                dragSourcePiece = piece;
                piece.AddClass("mg-drag-source");

                if (!destroyed && myTurn() && selected !== sq) onCellClick(sq);
            });

            $.RegisterEventHandler("DragEnd", piece, function (_p, droppedPanel) {
                commitDropMultimethod(droppedPanel);
                clearDrag();
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
        // Render scale = WINDOW px per LAYOUT px — see the checkers copy for the full rationale.
        // GetPositionWithinWindow is window px; actuallayoutwidth is layout px; dividing one by the
        // other only agreed at 100% UI scale, so drops landed off at 125%. Derive scale from two
        // board cells a known layout distance apart, via the proven GetPositionWithinWindow only.
        function uiScale() {
            var a = cells[fromDisplay(0)];
            var b = cells[fromDisplay(7)];
            var pa = winPos(a), pb = winPos(b);
            if (pa && pb) {
                var dx = Math.abs(pb.x - pa.x);
                if (dx > 1) return dx / (7 * SQ);
            }
            var s = piecesLayer ? Number(piecesLayer.actualuiscale_x) : NaN;
            if (isFinite(s) && s > 0.1 && s < 10) return s;
            return 1;
        }
        function squareFromWindow() {
            var lp = winPos(piecesLayer);
            var gp = winPos(dragGhost);
            if (!lp || !gp) return -1;
            var scale = uiScale();
            var cellW = SQ * scale;
            var half = (PIECE_SZ * scale) / 2;
            var cx = (gp.x - lp.x) + half;
            var cy = (gp.y - lp.y) + half;
            var dcol = Math.floor(cx / cellW), drow = Math.floor(cy / cellW);
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
            clearDrag();                 // a full rebuild deletes the ghost with the layer; also reset the vars
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
            // Any move (opponent's polled move or bot) can capture the piece you're mid-drag on,
            // deleting its panel + DragEnd handler and leaking the ghost. Clear the drag first;
            // for your own move the drag already ended (no-op).
            clearDrag();
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
                if (pp && pp.IsValid && pp.IsValid()) setFace(pp, pieceUrl(color * C_QUEEN));
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
            Api.move(code, from, to, 1, session.tok, function (r) {
                if (r.ok) {
                    appliedSeq++;
                    afterTurnSwitch();
                    return;
                }
                rejectAndResync(r.reason); // authoritative server refused this move
            }, function () {
                $.Schedule(0.6, function () { sendChessMove(from, to); });
            });
        }

        // Server rejected our move — rebuild the position from the accepted log (which
        // encodes castling / en passant / promotion via makeMove) and resume polling.
        function rejectAndResync(reason) {
            gameOver = false;
            clearSelection();
            board = initialChessBoard();
            cst = initialChessState();
            turn = 1;
            replayAccepted(0);
        }
        function replayAccepted(seq) {
            if (destroyed) return;
            if (seq >= appliedSeq) {
                layoutPieces();
                refreshHighlights();
                if (myTurn()) status("Move rejected — resynced. Your turn.");
                else { status("Move rejected — resyncing…"); startPolling(); }
                return;
            }
            Api.poll(code, seq, function (mv) {
                if (destroyed) return;
                if (mv) {
                    var r = makeMove(board, cst, mv.from, mv.to);
                    board = r[0]; cst = r[1];
                    turn = -turn;
                    replayAccepted(seq + 1);
                } else { appliedSeq = seq; replayAccepted(seq); }
            }, function () { $.Schedule(0.4, function () { replayAccepted(seq); }); },
            function (from, to) { return from >= 0 && from < 64 && to >= 0 && to < 64 && from !== to; });
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
            destroy: function () { destroyed = true; pollToken++; clearDrag(); try { root.DeleteAsync(0); } catch (e) {} }
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
