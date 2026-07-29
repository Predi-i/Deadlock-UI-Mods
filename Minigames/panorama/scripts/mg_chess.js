"use strict";

/*
 * mg_chess.js - Chess CONTROLLER for the Deadlock Minigames mod.
 *
 * Split out of mg_games.js (2026-07-24). Pure rules live in rules/chess.js (shared
 * byte-for-byte with the authoritative worker). The RX alias block (RC.idx re-export
 * plus chess-specific helpers) is preserved verbatim from the original inline copy.
 *
 * Self-registers game id 4 like mg_durak / mg_connectfour / mg_poker. Loads AFTER
 * mg_games.js so MG.Rules.checkers (for RC.idx), MG.Widgets.createClock and the
 * MG.Games registry exist.
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG._chessLoaded) return;
    MG._chessLoaded = true;

    // The two-side game clock and the shared <Image> face-setter live in mg_games.js
    // (this file can't see that closure), exposed via MG.Widgets.
    var createClock = MG.Widgets.createClock;
    // State-free board/nav helpers, likewise shared with mg_checkers.js. The rest of the drag and
    // review stacks stay local: they read this controller's own closure, and a few that LOOK
    // identical to the checkers copies are not (sqName uses cCol vs colOf, clockNames compares
    // myColor against 1 vs WHITE).
    var winPos = MG.Widgets.winPos, parsePx = MG.Widgets.parsePx;
    var squareFromPanel = MG.Widgets.squareFromPanel;
    var makeNavBtn = MG.Widgets.makeNavBtn, setNavState = MG.Widgets.setNavState;

    // ══ CHESS ═══════════════════════════════════════════════════════════════════
    // ── chess: shared pure rules (single source of truth: rules/chess.js) ──────────
    // Same alias idiom as checkers/ttt above: the engine lives in rules/chess.js (loaded
    // before this file and shared byte-for-byte with the authoritative server); here we
    // just bind local names identical to the old inline copies so the controller is
    // untouched. Colour is +1 (white) / -1 (black) - the sign of the piece.
    var RX = MG.Rules.chess;
    var C_PAWN = RX.C_PAWN, C_KNIGHT = RX.C_KNIGHT, C_BISHOP = RX.C_BISHOP;
    var C_ROOK = RX.C_ROOK, C_QUEEN = RX.C_QUEEN, C_KING = RX.C_KING;
    var cSq = RX.cSq, cRow = RX.cRow, cCol = RX.cCol, cSign = RX.cSign, cType = RX.cType;
    var initialChessBoard = RX.initialChessBoard, initialChessState = RX.initialChessState;
    var makeMove = RX.makeMove, legalMoves = RX.legalMoves, inCheck = RX.inCheck;
    var findKing = RX.findKing, chessResult = RX.chessResult, chessBotMove = RX.chessBotMove;
    var positionKey = RX.positionKey;
    var chessBotMovePrep = RX.chessBotMovePrep;

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
        var pollMisses = 0;            // consecutive empty polls this turn (drives the adaptive cadence)
        var selected = -1;
        var legalTargets = [];         // [{to}] - shape kept identical to checkers so the drag code is shared
        var pollToken = 0;
        var destroyed = false;
        var gameOver = false;
        var lastFrom = -1, lastTo = -1;   // opponent's (or last applied) move, for board highlight

        // Premove (online only, ONE queued move), mirrors createCheckers: while it's the opponent's
        // turn you click your piece then a destination; we remember {from,to}, glow both cells, and
        // the instant the opponent's move lands (turn flips to us) we validate against the NEW
        // position via targetsFor and play it, or silently discard it if it's no longer legal.
        var premove = null;            // { from, to } or null
        var preSelected = -1;          // my piece picked for a premove, awaiting a destination click

        // Move history + local review (§8 commit 2.2), mirrors createCheckers. Each move pushes
        // one entry { from, to, boardAfter, label }. reviewIndex === null = live; -1 = initial
        // position; 0..history.length-1 = the position after that move. Review is read-only.
        var history = [];
        var reviewIndex = null;

        // Time control (§8 commit 2.3), mirrors createCheckers. session.timeControl = seconds per
        // side (0 = untimed). Authoritative on the SERVER online; offline (bot) it ticks locally.
        // seat 0 = white/host, seat 1 = black/joiner - the clock indexes by seat.
        var timeControl = session.timeControl || 0;
        var clock = null;              // createClock handle, built in buildSidePanel

        var dragActive = false, dragGhost = null, dragOverSq = -1, dragEnterCount = 0;
        var dragSourcePiece = null;    // the real piece being dragged (un-dim even if it's since been deleted)
        var dragFromSq = -1;           // square the current drag STARTED on (set in DragStart regardless of turn → a drag during the opponent's turn can queue a premove)
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
        function sfx(n) { if (MG.Sound) MG.Sound.play(n); }
        // Pick the one sound a chess move should play, highest priority first. `fx` is
        // applyChessMove's return ({promoted, captured, castled}); `checkNow` is whether
        // the move leaves the side-to-move in check. Check trumps everything (it's the most
        // important cue), then promote/castle (rare, distinct events), then capture, then a
        // plain move. `self` picks the move sound for MY move vs the opponent's.
        function moveSound(fx, checkNow, self) {
            if (checkNow) return "Check";
            if (fx.promoted) return "Promote";
            if (fx.castled) return "Castle";
            if (fx.captured) return "Capture";
            return self ? "MoveSelf" : "MoveOpp";
        }
                // parsePx: shared, see MG.Widgets in mg_games.js


        // Black sees the board rotated 180° so its own pieces sit at the bottom.
        function toDisplay(i) { return myColor === 1 ? i : 63 - i; }
        function fromDisplay(i) { return myColor === 1 ? i : 63 - i; }

        function pieceUrl(v) {
            var name = (v > 0 ? "White" : "Black") + ["", "Pawn", "Knight", "Bishop", "Rook", "Queen", "King"][cType(v)];
            return "s2r://panorama/images/" + name + ".vtex";
        }
        // Piece sprites are drawn by a CHILD <Image>, not the container's background: a Panel
        // background paints the .vtex at its NATIVE size (250²) until the panel is re-laid-out.
        // The piece panel keeps its transform/anim/drag-source state; the Image just fills it and
        // is transparent to input. Shared implementation: MG.Widgets.setFace (mg_games.js).
        var setFace = MG.Widgets.setFace;

        var root = $.CreatePanel("Panel", container, "MG_ChessRoot");
        root.AddClass("mg-chess");
        // Two-column game screen (see createCheckers): board left, move list right.
        var twoCol = $.CreatePanel("Panel", root, "MG_ChessCols");
        twoCol.AddClass("mg-game-2col");
        var boardWrap = $.CreatePanel("Panel", twoCol, "MG_ChessWrap");
        boardWrap.AddClass("mg-board-wrap");
        var boardPanel = $.CreatePanel("Panel", boardWrap, "MG_ChessBoard");
        boardPanel.AddClass("mg-board");
        // Move-list side panel + Prev/Next/Live navigation bar (see createCheckers). The nav
        // steps a purely LOCAL review of past positions; the live game runs underneath.
        var moveListRows = null, navPrevBtn = null, navNextBtn = null, navLiveBtn = null;
        (function buildSidePanel() {
            var panel = $.CreatePanel("Panel", twoCol, "MG_ChessMoves");
            panel.AddClass("mg-movelist");
            // Clocks at the top of the side panel (untimed → builds nothing; see createClock).
            clock = createClock(panel, timeControl, !session.bot, code, onFlag, clockNames(), clockSeatFor(myColor));
            var head = $.CreatePanel("Label", panel, "");
            head.AddClass("mg-movelist-head");
            head.text = "Moves";
            moveListRows = $.CreatePanel("Panel", panel, "");
            moveListRows.AddClass("mg-movelist-rows");
            var nav = $.CreatePanel("Panel", panel, "");
            nav.AddClass("mg-movelist-nav");
            navPrevBtn = makeNavBtn(nav, "< Prev", function () { navPrev(); });
            navLiveBtn = makeNavBtn(nav, "Live", function () { navLive(); });
            navNextBtn = makeNavBtn(nav, "Next >", function () { navNext(); });
            renderMoveList();
        })();
                // makeNavBtn: shared, see MG.Widgets in mg_games.js

        // Clock rows are indexed by SERVER seat (0 = host = white, 1 = joiner = black).
        function clockNames() {
            return session.bot
                ? [myColor === 1 ? "You" : "Bot", myColor === 1 ? "Bot" : "You"]
                : ["White", "Black"];
        }
        // Chess colour → server seat: white (+1) is always the host (seat 0).
        function clockSeatFor(color) { return color === 1 ? 0 : 1; }
        function syncClockTurn() { if (clock && clock.isTimed) clock.setTurn(clockSeatFor(turn)); }
        // A side flagged (ran out of time): that seat loses. Map seat → colour and finish.
        function onFlag(seat) {
            if (gameOver) return;
            var loserColor = seat === 0 ? 1 : -1;
            finish(loserColor === 1 ? -1 : 1, "time");
        }

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
            // Shoved into the bottom-right corner so the letter clears the piece. Chess sprites are
            // 56px (nearly the whole 60px cell) but transparent in the corners, so (51,46) tucks the
            // glyph past the visible figure - knights/rooks/bishops no longer cover it (maintainer
            // 2026-07-16). Matches createCheckers.addCoord.
            var ox = kind === "file" ? (SQ - 9) : 3;       // rank → top-left; file → bottom-right
            var oy = kind === "file" ? (SQ - 14) : 2;
            lbl.style.transform = "translate3d(" + (x + ox) + "px, " + (y + oy) + "px, 0px)";
        }

        function makePiece(realIdx, v, interactive) {
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
            if (interactive !== false) setupPieceInput(piece);
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
                if (destroyed || reviewIndex !== null) return; // no dragging while reviewing history
                var sq = piece._sq;
                // Only start a drag on a square that STILL holds one of my pieces. A piece the
                // opponent just captured lingers ~0.22s as a shrinking panel that is still
                // draggable (draggability is fixed at creation); grabbing it during that fade
                // built a ghost from the OPPONENT's piece now on `sq`, and when the fade deleted
                // the panel mid-drag the engine never fired DragEnd → the ghost leaked on screen
                // forever. Gating on "sq is still mine" refuses that grab. My own pieces stay mine
                // through the opponent's turn, so premoves are unaffected.
                if (cSign(board[sq]) !== myColor) return;
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
                dragFromSq = sq;                  // where this drag began (used by the premove drop path)
                piece.AddClass("mg-drag-source");

                if (!destroyed && myTurn() && selected !== sq) onCellClick(sq);
            });

            $.RegisterEventHandler("DragEnd", piece, function (_p, droppedPanel) {
                if (!myTurn() && canPremove()) {
                    // Dragged during the opponent's turn → queue a PREMOVE to the dropped square.
                    var pmTo = dropSquare(droppedPanel);
                    if (pmTo >= 0 && pmTo !== dragFromSq) {
                        if (premoveGeometryOk(dragFromSq, pmTo)) { premove = { from: dragFromSq, to: pmTo }; preSelected = -1; sfx("Premove"); }
                        else sfx("Illegal");   // impossible shape for this piece - don't queue it
                    }
                    clearDrag();
                    refreshHighlights();
                    return;
                }
                // The turn flipped to me WHILE this piece was held: the drag began during the
                // opponent's turn (a premove-grab, so DragStart set no selection), but the polled
                // move landed before I released. Without this, DragEnd falls through to
                // commitDropMultimethod, which bails on `selected < 0` and snaps the piece back -
                // the "premove teleports back instead of moving" bug. Promote the grab to a live
                // move: select dragFromSq and let the normal drop path validate + play it.
                if (selected < 0 && dragFromSq >= 0 && cSign(board[dragFromSq]) === myColor) {
                    var liveTg = targetsFor(dragFromSq);
                    if (liveTg.length > 0) { selected = dragFromSq; legalTargets = liveTg; }
                }
                commitDropMultimethod(droppedPanel);
                clearDrag();
            });
        }

        // ── drop resolution (verbatim from checkers: proven in-game 2026-07-07) ──────
        function isLegalTarget(sq) {
            for (var t = 0; t < legalTargets.length; t++) if (legalTargets[t].to === sq) return true;
            return false;
        }
                // squareFromPanel: shared, see MG.Widgets in mg_games.js

                // winPos: shared, see MG.Widgets in mg_games.js

        // Render scale = WINDOW px per LAYOUT px - see the checkers copy for the full rationale.
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

        // Raw dropped square (any of 0..63) with NO legal-target filter - used to queue a premove
        // while it's the opponent's turn (validated later by tryPremove). Same channels as
        // commitDropMultimethod, first valid one wins.
        function dropSquare(droppedPanel) {
            var cands = [squareFromWindow(), squareFromPanel(droppedPanel), dragOverSq, squareFromGhost()];
            for (var k = 0; k < cands.length; k++) if (cands[k] >= 0) return cands[k];
            return -1;
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
            if (reviewIndex !== null) return;   // renderReview() owns the cells while reviewing
            for (var i = 0; i < 64; i++) {
                var cell = cells[i];
                if (!cell) continue;
                cell.RemoveClass("mg-lastmove");
                cell.RemoveClass("mg-lastmove-to");
                cell.RemoveClass("mg-sel");
                cell.RemoveClass("mg-target");
                cell.RemoveClass("mg-check");
                cell.RemoveClass("mg-premove");
            }
            // FROM = light wash, TO = darker wash (maintainer: the destination must read darker).
            if (lastFrom >= 0 && cells[lastFrom]) cells[lastFrom].AddClass("mg-lastmove");
            if (lastTo >= 0 && cells[lastTo]) cells[lastTo].AddClass("mg-lastmove-to");
            if (selected >= 0 && cells[selected]) cells[selected].AddClass("mg-sel");
            for (var t = 0; t < legalTargets.length; t++) {
                var tc = cells[legalTargets[t].to];
                if (tc) tc.AddClass("mg-target");
            }
            // Queued premove (opponent's turn): glow the picked piece and, once set, both ends.
            if (preSelected >= 0 && cells[preSelected]) cells[preSelected].AddClass("mg-premove");
            if (premove) {
                if (cells[premove.from]) cells[premove.from].AddClass("mg-premove");
                if (cells[premove.to]) cells[premove.to].AddClass("mg-premove");
            }
            if (!gameOver && inCheck(board, turn)) {
                var ks = findKing(board, turn);
                if (ks >= 0 && cells[ks]) cells[ks].AddClass("mg-check");
            }
        }

        // ── move history + local review (mirrors createCheckers) ─────────────
        function sqName(i) { return String.fromCharCode(97 + cCol(i)) + (8 - cRow(i)); }
        function moveLabel(from, to, cap) { return sqName(from) + (cap ? "x" : "-") + sqName(to); }
        // Capture test on the CURRENT (pre-move) board: an occupied target, or a pawn stepping
        // diagonally onto an empty square (en passant). Call before applyChessMove replaces board.
        function isCaptureMove(from, to) {
            if (board[to] !== 0) return true;
            if (cType(board[from]) === C_PAWN && cCol(from) !== cCol(to) && board[to] === 0) return true;
            return false;
        }
        // Threefold repetition needs the whole game's position list, which rules/chess.js
        // deliberately does NOT carry (it would copy an array into every search node). Count the
        // keys here instead: pushHistory runs in all three live move paths (local, bot, polled)
        // AFTER board/cst/turn are updated, so the key always describes the position that the side
        // to move now faces. rejectAndResync drops the counts along with history.
        var posCounts = {};
        function notePosition() {
            var k = positionKey(board, cst, turn);
            posCounts[k] = (posCounts[k] || 0) + 1;
        }
        function countRepeat() { return posCounts[positionKey(board, cst, turn)] || 0; }
        function pushHistory(from, to, cap) {
            history.push({ from: from, to: to, boardAfter: board.slice(), label: moveLabel(from, to, cap) });
            notePosition();
            renderMoveList();
        }
        function renderMoveList() {
            if (!moveListRows || !(moveListRows.IsValid && moveListRows.IsValid())) return;
            moveListRows.RemoveAndDeleteChildren();
            if (history.length === 0) {
                var e = $.CreatePanel("Label", moveListRows, "");
                e.AddClass("mg-move-empty");
                e.text = "No moves yet.";
            } else {
                var cur = (reviewIndex === null) ? history.length - 1 : reviewIndex;
                for (var i = 0; i < history.length; i++) {
                    (function (idx) {
                        var row = $.CreatePanel("Label", moveListRows, "");
                        row.AddClass("mg-move-row");
                        if (idx === cur) row.AddClass("mg-move-current");
                        row.text = (idx + 1) + ". " + history[idx].label;
                        row.SetPanelEvent("onactivate", function () { gotoReview(idx); });
                    })(i);
                }
            }
            updateNav();
            if (reviewIndex === null) { try { moveListRows.ScrollToBottom(); } catch (e2) {} }
        }
                // setNavState: shared, see MG.Widgets in mg_games.js

        function updateNav() {
            var shown = (history.length === 0) ? -2 : (reviewIndex === null ? history.length - 1 : reviewIndex);
            setNavState(navPrevBtn, shown > -1);
            setNavState(navNextBtn, reviewIndex !== null);
            setNavState(navLiveBtn, reviewIndex !== null);
        }
        function layoutPiecesFrom(src) {
            if (!piecesLayer) return;
            clearDrag();
            piecesLayer.RemoveAndDeleteChildren();
            pieceEls = {};
            for (var i = 0; i < 64; i++) { if (src[i] !== 0) makePiece(i, src[i], false); }
        }
        function renderReview() {
            var idx = reviewIndex;
            var snap = (idx < 0) ? initialChessBoard() : history[idx].boardAfter;
            layoutPiecesFrom(snap);
            for (var i = 0; i < 64; i++) {
                var c = cells[i];
                if (!c) continue;
                c.RemoveClass("mg-sel"); c.RemoveClass("mg-target"); c.RemoveClass("mg-lastmove"); c.RemoveClass("mg-check");
            }
            if (idx >= 0) {
                var e = history[idx];
                if (cells[e.from]) cells[e.from].AddClass("mg-lastmove");
                if (cells[e.to]) cells[e.to].AddClass("mg-lastmove");
            }
        }
        function shownIndex() { return reviewIndex === null ? history.length - 1 : reviewIndex; }
        function setReview(idx) { reviewIndex = idx; renderReview(); renderMoveList(); }
        function gotoReview(idx) { if (idx >= 0 && idx < history.length) setReview(idx); }
        function navPrev() { if (history.length === 0) return; var t = shownIndex() - 1; if (t < -1) return; setReview(t); }
        function navNext() {
            if (reviewIndex === null) return;
            var t = reviewIndex + 1;
            if (t >= history.length - 1) { navLive(); return; }
            setReview(t);
        }
        function navLive() {
            reviewIndex = null;
            layoutPieces();
            refreshHighlights();
            renderMoveList();
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
            // While reviewing, the pieces layer shows a past snapshot - advance the MODEL only and
            // skip all visuals; navLive() rebuilds the current position from the model on return.
            if (reviewIndex !== null) {
                var wasPawnEdge = cType(board[from]) === C_PAWN && (cRow(to) === 0 || cRow(to) === 7);
                var wasCap = isCaptureMove(from, to);
                var wasCastle = cType(board[from]) === C_KING && Math.abs(cCol(to) - cCol(from)) === 2;
                var rr = makeMove(board, cst, from, to);
                board = rr[0]; cst = rr[1];
                return { promoted: wasPawnEdge, captured: wasCap, castled: wasCastle };
            }
            var mover = board[from], t = cType(mover), color = cSign(mover);
            var fr = cRow(from), fc = cCol(from), tr = cRow(to), tc = cCol(to);
            var capSq = -1;
            if (t === C_PAWN && tc !== fc && board[to] === 0) capSq = cSq(fr, tc);   // en passant
            else if (board[to] !== 0) capSq = to;
            var castled = (t === C_KING && Math.abs(tc - fc) === 2);
            // A move arriving mid-drag (you're queuing a premove during the opponent's turn) must
            // NOT yank your held piece back - that was the "premove teleports back" bug. Only tear
            // the drag down when this move actually DELETES the piece you're holding (it captures
            // on dragFromSq): its panel + DragEnd handler vanish, which would otherwise leak the
            // ghost, and the premove is impossible anyway. Any other move leaves the drag intact so
            // the premove keeps tracking the cursor. (For your own/bot move the drag already ended,
            // so dragActive is false and this is a no-op.)
            if (dragActive && capSq === dragFromSq) { clearPremove(); clearDrag(); }

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
            var promoted = false;
            if (t === C_PAWN && (tr === 0 || tr === 7)) {
                promoted = true;
                var pp = pieceEls[to];
                if (pp && pp.IsValid && pp.IsValid()) setFace(pp, pieceUrl(color * C_QUEEN));
            }
            if (t === C_KING && Math.abs(tc - fc) === 2) {
                if (tc - fc === 2) slidePiece(cSq(fr, 7), cSq(fr, 5));   // O-O  rook h→f
                else slidePiece(cSq(fr, 0), cSq(fr, 3));                 // O-O-O rook a→d
            }
            return { promoted: promoted, captured: capSq >= 0, castled: castled };
        }

        // ── input / move flow ────────────────────────────────────────────────────────
        function myTurn() { return turn === myColor && !gameOver; }
        function clearSelection() { selected = -1; legalTargets = []; }

        function targetsFor(i) {
            var all = legalMoves(board, cst, myColor), out = [];
            for (var k = 0; k < all.length; k++) if (all[k].from === i) out.push({ to: all[k].to });
            return out;
        }

        // Premove (online only): pick a piece then a destination while it's the opponent's turn.
        // Occupancy isn't validated now (the position changes after the opponent moves); tryPremove
        // replays it when it's actually my turn and drops it if illegal on the new board. But we DO
        // gate on the piece's MOVEMENT GEOMETRY up-front - a knight's L, a bishop's diagonal etc. -
        // so you can't queue a shape the piece can never make (the "premove anywhere" complaint).
        // Mirrors createCheckers.
        function canPremove() { return !gameOver && !destroyed && reviewIndex === null && !myTurn(); }
        function clearPremove() { premove = null; preSelected = -1; refreshHighlights(); }
        // True if `to` is a geometrically reachable square for whatever of my pieces sits on `from`
        // RIGHT NOW, ignoring occupancy/pins/check (those depend on the post-opponent board and are
        // re-checked by tryPremove). Sliding pieces pass on direction alone - blockers may clear.
        function premoveGeometryOk(from, to) {
            var v = board[from];
            if (cSign(v) !== myColor || from === to) return false;
            var t = cType(v);
            var dr = cRow(to) - cRow(from), dc = cCol(to) - cCol(from);
            var adr = Math.abs(dr), adc = Math.abs(dc);
            if (t === C_KNIGHT) return (adr === 1 && adc === 2) || (adr === 2 && adc === 1);
            if (t === C_BISHOP) return adr === adc;
            if (t === C_ROOK)   return dr === 0 || dc === 0;
            if (t === C_QUEEN)  return adr === adc || dr === 0 || dc === 0;
            if (t === C_KING)   return (adr <= 1 && adc <= 1) || (dr === 0 && adc === 2);   // step or castle
            // pawn: forward push (1 or 2 on the home row) or a diagonal capture step. White (+1)
            // moves toward row 0, so its forward row delta is -1; black's is +1 → forward = -color.
            var fwd = -myColor;
            if (dc === 0) return dr === fwd || (dr === 2 * fwd && cRow(from) === (myColor === 1 ? 6 : 1));
            return adc === 1 && dr === fwd;
        }
        function premoveClick(i) {
            if (cSign(board[i]) === myColor) { preSelected = i; premove = null; refreshHighlights(); return; }
            if (preSelected >= 0 && i !== preSelected) {
                if (!premoveGeometryOk(preSelected, i)) { sfx("Illegal"); return; }   // keep the piece picked; let them retry
                premove = { from: preSelected, to: i }; preSelected = -1; sfx("Premove"); refreshHighlights(); return;
            }
            clearPremove();
        }
        // A bare source pick with no destination (preSelected set, premove null) is cleared here too,
        // else the orange "pending" wash on the picked cell would survive the turn flip forever.
        function tryPremove() {
            if (!premove) { if (preSelected >= 0) { preSelected = -1; refreshHighlights(); } return; }
            var pm = premove; premove = null; preSelected = -1;
            if (!myTurn()) { refreshHighlights(); return; }
            var tg = targetsFor(pm.from);
            for (var t = 0; t < tg.length; t++) {
                if (tg[t].to === pm.to) {
                    selected = pm.from; legalTargets = tg; refreshHighlights();
                    doLocalMove(pm.from, pm.to);
                    return;
                }
            }
            refreshHighlights();   // premove no longer legal - just drop it
        }

        function onCellClick(i) {
            if (destroyed || reviewIndex !== null) return;
            if (!myTurn()) { if (canPremove()) premoveClick(i); return; }
            if (selected >= 0) {
                for (var t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalMove(selected, i); return; }
                }
                // A selection is up and this isn't one of its targets: if it's not a re-select
                // of another of my pieces, it's an illegal attempt - sound feedback (no forced
                // capture in chess, so no flash).
                if (cSign(board[i]) !== myColor) { sfx("Illegal"); return; }
            }
            if (cSign(board[i]) === myColor) {
                var tg = targetsFor(i);
                if (tg.length === 0) { status("That piece has no legal move."); sfx("Illegal"); return; }
                selected = i;
                legalTargets = tg;
                refreshHighlights();
            }
        }

        function onCellDrop(i) {
            if (destroyed || reviewIndex !== null || !myTurn() || !dragActive || selected < 0) return;
            for (var t = 0; t < legalTargets.length; t++) {
                if (legalTargets[t].to === i) { doLocalMove(selected, i); return; }
            }
            sfx("Illegal");   // dropped on a non-target square
        }

        function doLocalMove(from, to) {
            var cap = isCaptureMove(from, to);   // test BEFORE the board mutates
            var fx = applyChessMove(from, to);
            lastFrom = from; lastTo = to;
            clearSelection();
            turn = -myColor;               // hand off locally
            syncClockTurn();               // opponent's bank starts draining
            refreshHighlights();
            pushHistory(from, to, cap);
            sfx(moveSound(fx, inCheck(board, turn), true));

            if (session.bot) {
                if (!checkEnd()) { status("Bot is thinking…"); scheduleBotTurn(); }
                return;
            }
            status("Move sent. Waiting for opponent…");
            checkEnd();                    // may end the game (and set the win/draw status)
            sendChessMove(from, to);       // always relay - the opponent must see even a mating move
        }

        // ── bot (offline) ─────────────────────────────────────────────────────────────
        function scheduleBotTurn() { $.Schedule(0.45, botTurn); }
        // Drive the resumable search ONE root move per frame so the HUD never freezes (the
        // "лаги при ходе бота") and a premove can be grabbed while the bot thinks. Same depth-3
        // alpha-beta, same strength - only the scheduling changed. Falls back to the one-shot
        // chessBotMove if the prep driver isn't present (older rules bundle).
        function botTurn() {
            if (destroyed || gameOver) return;
            var botColor = -myColor;
            if (!chessBotMovePrep) { botApply(chessBotMove(board, cst, botColor)); return; }
            var driver = chessBotMovePrep(board, cst, botColor);
            (function stepOnce() {
                if (destroyed || gameOver) return;
                if (driver.done()) { botApply(driver.result()); return; }
                driver.step();
                $.Schedule(0.0, stepOnce);   // yield a frame between root moves
            })();
        }
        function botApply(mv) {
            if (destroyed || gameOver) return;
            if (!mv) { checkEnd(); return; }
            var cap = isCaptureMove(mv.from, mv.to);
            var fx = applyChessMove(mv.from, mv.to);
            lastFrom = mv.from; lastTo = mv.to;
            turn = myColor;
            syncClockTurn();
            refreshHighlights();
            pushHistory(mv.from, mv.to, cap);
            sfx(moveSound(fx, inCheck(board, myColor), false));
            if (!checkEnd()) { status(inCheck(board, myColor) ? "Check! Your turn." : "Your turn."); tryPremove(); }
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

        // Server rejected our move - rebuild the position from the accepted log (which
        // encodes castling / en passant / promotion via makeMove) and resume polling.
        function rejectAndResync(reason) {
            sfx("Illegal");
            gameOver = false;
            clearSelection();
            board = initialChessBoard();
            cst = initialChessState();
            turn = 1;
            // The rejected move was optimistically pushed to history (doLocalMove pushes BEFORE
            // sendChessMove), so the rebuilt board no longer matches those entries - reviewing one
            // would render an impossible position. createCheckers already drops the list here;
            // this copy had drifted and kept the stale rows.
            history = []; reviewIndex = null;
            posCounts = {};
            notePosition();          // rebuilt from the initial position → that is occurrence #1 again
            replayAccepted(0);
        }
        function replayAccepted(seq) {
            if (destroyed) return;
            if (seq >= appliedSeq) {
                layoutPieces();
                refreshHighlights();
                renderMoveList();
                if (myTurn()) status("Move rejected. Resynced, your turn.");
                else { status("Move rejected. Resyncing…"); startPolling(); }
                return;
            }
            Api.poll(code, seq, function (mv) {
                if (destroyed) return;
                if (mv) {
                    var r = makeMove(board, cst, mv.from, mv.to);
                    board = r[0]; cst = r[1];
                    turn = -turn;
                    notePosition();          // resync path bypasses pushHistory; keep the repeat count honest
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
            pollMisses = 0;                 // fresh wait → poll fast again (see MG.Net.pollDelay)
            pollOnce(pollToken);
        }
        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken) return;
            if (turn === myColor) return;
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    pollMisses = 0;
                    appliedSeq++;
                    var oppCap = isCaptureMove(mv.from, mv.to);   // test the pre-move board
                    var fx = applyChessMove(mv.from, mv.to);
                    lastFrom = mv.from; lastTo = mv.to;
                    turn = myColor;                 // every chess move ends the turn (end always 1)
                    syncClockTurn();
                    refreshHighlights();
                    pushHistory(mv.from, mv.to, oppCap);
                    sfx(moveSound(fx, inCheck(board, myColor), false));
                    if (!checkEnd()) { status(inCheck(board, myColor) ? "Check! Your turn." : "Your turn."); tryPremove(); }
                } else {
                    $.Schedule(MG.Net.pollDelay(pollMisses++), function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(MG.Net.pollDelay(pollMisses++), function () { pollOnce(myToken); });
            }, function (from, to) {
                return from >= 0 && from < 64 && to >= 0 && to < 64 && from !== to;
            });
        }

        // ── end of game ─────────────────────────────────────────────────────────────────
        // Evaluates the side whose turn it now is. Returns true if the game ended.
        function checkEnd() {
            var res = chessResult(board, cst, turn, countRepeat());
            if (res === "checkmate") { finish(-turn); return true; }
            if (res === "stalemate") { finishDraw("Stalemate. It's a draw."); return true; }
            if (res === "draw50") { finishDraw("Draw by the fifty-move rule."); return true; }
            if (res === "repetition") { finishDraw("Draw by threefold repetition."); return true; }
            if (res === "insufficient") { finishDraw("Draw: insufficient material."); return true; }
            return false;
        }
        // `reason` is optional: "time" when the game ended on a flag-fall (shown in the status).
        function finish(winner, reason) {
            if (gameOver) return;      // a flag-fall + a checkmate can race; first one wins
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            var win = winner === myColor;
            var how = reason === "time" ? (win ? "🏆 Opponent flagged. You win!" : "You lose on time.")
                                        : (win ? "🏆 Checkmate. You win!" : "Checkmate. You lose.");
            status(how);
            sfx("GameEnd");
            if (session.onGameOver) session.onGameOver(win ? "win" : "lose");
        }
        function finishDraw(text) {
            if (gameOver) return;
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            status(text || "It's a draw.");
            sfx("GameEnd");
            if (session.onGameOver) session.onGameOver("draw");
        }

        // ── boot ──────────────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
        notePosition();           // the starting position is occurrence #1 for repetition counting
        syncClockTurn();          // white (seat 0) is on the move at the start
        sfx("GameStart");
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
            destroy: function () { destroyed = true; pollToken++; if (clock) clock.stop(); clearDrag(); try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 4, create: createChess });
    }
})();
