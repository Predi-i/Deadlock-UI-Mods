"use strict";

/*
 * mg_checkers.js - Checkers (draughts) CONTROLLER for the Deadlock Minigames mod.
 *
 * Split out of mg_games.js (2026-07-24). The pure rules live in rules/checkers.js
 * (shared byte-for-byte with the authoritative worker); here we render the board +
 * pieces overlay, take click + drag input, predict + poll online moves, and run the
 * offline bot. Two variants ride the SAME controller: session.variant "english" picks
 * MG.Rules.checkersEnglish, anything else Russian (see RCv below) - exactly how the
 * server switches on lobby.cv.
 *
 * Board cell values: 0 empty · 1 white man · 2 white king · 3 black man · 4 black king.
 * White = host (seat 0), rows 5-7, moves UP, moves first. Black = joiner, rows 0-2.
 *
 * Self-registers game id 1 like mg_durak / mg_connectfour / mg_poker. Loads AFTER
 * mg_games.js (base_hud.xml order) so MG.Rules.*, MG.Widgets.createClock and the
 * MG.Games registry all exist. NONE of the rendering/input is shell-verifiable -
 * reasoned from the game's CSS idioms, confirmed only after a VPK repack.
 */

(() => {
    const MG = ($.MG = $.MG || {});
    if (MG._checkersLoaded) return;
    MG._checkersLoaded = true;

    // Alias the shared pure engine (loaded before this file, hangs off MG.Rules) to local
    // names IDENTICAL to the old inline copies in mg_games.js, so the controller body below is
    // byte-for-byte unchanged. The variant switch (Russian vs English) happens per-game inside
    // createCheckers via RCv; RC is the Russian default + the fallback.
    const RC = MG.Rules.checkers;
    const WHITE = RC.WHITE, BLACK = RC.BLACK;
    const idx = RC.idx, rowOf = RC.rowOf, colOf = RC.colOf, isDark = RC.isDark;
    const colorOf = RC.colorOf, isKing = RC.isKing;
    const initialBoard = RC.initialBoard;
    const simpleMoves = RC.simpleMoves, captureMoves = RC.captureMoves;
    const anyCaptureFor = RC.anyCaptureFor, applyHop = RC.applyHop, hasAnyMove = RC.hasAnyMove;
    const legalSequences = RC.legalSequences, chooseBotMove = RC.chooseBotMove, chooseBotMovePrep = RC.chooseBotMovePrep;

    // The two-side game clock lives in mg_games.js and is shared via MG.Widgets (this file
    // can't see that closure). Same handle the old inline createClock returned.
    const createClock = MG.Widgets.createClock;
    // State-free board/nav helpers, likewise shared with mg_chess.js. The rest of the drag and
    // review stacks stay local: they read this controller's own closure (board, cells, history,
    // myColor), and a few that LOOK identical to the chess copies are not (sqName uses colOf vs
    // cCol, clockNames compares against WHITE vs 1).
    const winPos = MG.Widgets.winPos, parsePx = MG.Widgets.parsePx;
    const squareFromPanel = MG.Widgets.squareFromPanel;
    const makeNavBtn = MG.Widgets.makeNavBtn, setNavState = MG.Widgets.setNavState;

    function createCheckers(container, session) {
        const Api = MG.Api;
        const code = session.code;
        // Pick the rules engine for this game's variant. English draughts (kings step one square,
        // men capture forward only) lives in MG.Rules.checkersEnglish; anything else = Russian.
        // Shadow the module-level aliases with the chosen engine so every helper below (board init,
        // legal moves, bot search) routes through it - the server does the same via lobby.cv.
        const RCv = (session.variant === "english" && MG.Rules.checkersEnglish) ? MG.Rules.checkersEnglish : RC;
        const initialBoard = RCv.initialBoard;
        const simpleMoves = RCv.simpleMoves, captureMoves = RCv.captureMoves;
        const anyCaptureFor = RCv.anyCaptureFor, applyHop = RCv.applyHop, hasAnyMove = RCv.hasAnyMove;
        const drawReason = RCv.drawReason;
        const legalSequences = RCv.legalSequences, chooseBotMove = RCv.chooseBotMove, chooseBotMovePrep = RCv.chooseBotMovePrep;
        const myColor = session.isHost ? WHITE : BLACK;
        let board = initialBoard();
        let turn = WHITE;              // white (host) moves first
        // Consecutive turns with no capture and no man move - the Russian 15-move draw rule's
        // counter. rules/checkers.js can't track it (it is per-position, not per-game), so the
        // controller owns it and feeds it to drawReason(). Reset by turnResetsIdle().
        let idleTurns = 0;
        let appliedSeq = 0;            // total hops consumed from the shared server list
        let selected = -1;             // selected square during my turn
        let legalTargets = [];         // [{to, cap}]
        let chaining = false;          // mid multi-jump
        let pollToken = 0;             // invalidates stale poll loops
        let destroyed = false;
        let gameOver = false;
        let lastFrom = -1, lastTo = -1; // last COMPLETED move's endpoints (for the last-move wash)
        let oppSeqFrom = -1;            // first `from` of the opponent's in-progress (multi-hop) turn

        // Time control (§8 commit 2.3). session.timeControl = seconds per side (0 = untimed).
        // The clock is authoritative on the SERVER online; offline (bot) it ticks locally. seat
        // 0 = white/host, seat 1 = black/joiner - the clock indexes by seat, so map colour→seat.
        const timeControl = session.timeControl || 0;
        let clock = null;               // createClock handle, built in buildSidePanel

        // Move history + local review (§8 commit 2.2). Each finished TURN pushes one entry
        // { from, to, cap, boardAfter, label }. reviewIndex === null means "live" (board shows
        // the real position); an integer k means we are REVIEWING: -1 = initial position,
        // 0..history.length-1 = the position right after that turn. Reviewing is read-only -
        // input handlers bail while reviewing and live moves keep updating the model + list
        // silently without disturbing the shown snapshot.
        let history = [];
        let reviewIndex = null;
        // Captures accumulate across the multi-hop chain of ONE turn (a turn's label is "x" if
        // any hop in it was a capture). Reset when each side begins a fresh turn.
        let myTurnCapture = false, oppTurnCapture = false, botTurnCapture = false;

        // Premove (online only, ONE queued move): while it's the opponent's turn you may click/drag
        // your piece to a square; we remember {from,to}, glow both cells orange, and the instant the
        // opponent's move lands (turn flips to us) we try to play it. It's validated against the NEW
        // position via targetsFor - an illegal queued move (piece captured, target blocked, a forced
        // jump elsewhere) is simply discarded. preSelected holds the from-square mid-selection.
        let premove = null;            // { from, to } or null
        let preSelected = -1;          // my piece picked for a premove, awaiting a destination click

        // Drag-and-drop state (native Panorama drag; recipe proven in QOLLOCK):
        // a piece is a drag SOURCE, each cell a drop TARGET. While dragging, a throwaway
        // "ghost" panel follows the cursor and the real piece is dimmed in place.
        let dragActive = false;        // a real grab is in flight (ghost exists)
        let dragGhost = null;          // panel that follows the cursor
        let dragOverSq = -1;           // square the cursor is currently over (DragEnter / mouseover)
        let dragEnterCount = 0;        // how many DragEnter events landed this drag (is that channel alive?)
        let dragSourcePiece = null;    // the real piece being dragged (so we can un-dim it even if it's since been deleted)
        let dragFromSq = -1;           // square the current drag STARTED on (set in DragStart regardless of turn, so a drag made during the opponent's turn can queue a premove)

        // Tear the drag state down from ANY exit path, not just DragEnd. The DragEnd handler is
        // bound to the PIECE panel; if the opponent captures that piece while you hold it (a
        // polled hop → animateHop deletes the panel), the panel - and its DragEnd handler - is
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
        // produced to the on-screen status line - so ONE in-game test reveals which signal
        // the engine really populates, instead of guessing a 5th time. Flip to false (or
        // delete the status() call in commitDropMultimethod) once drag is confirmed working.
        const DRAG_DEBUG = false;        // drag confirmed working in-game - silence the per-drop status trace

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function sfx(n) { if (MG.Sound) MG.Sound.play(n); }

// parsePx: shared, see MG.Widgets in mg_games.js


        // Display transform: black sees the board rotated 180° so its pieces sit at the bottom.
        function toDisplay(i) { return myColor === WHITE ? i : 63 - i; }
        function fromDisplay(i) { return myColor === WHITE ? i : 63 - i; }

        const root = $.CreatePanel("Panel", container, "MG_CheckersRoot");
        root.AddClass("mg-checkers");
        // Two-column game screen: the board on the left, a move-list panel on the right (the
        // modal is 900px, the board only 486px, so ~360px sit unused to its right). The columns
        // flow right; the board keeps its own centred/flow:none internals unchanged.
        const twoCol = $.CreatePanel("Panel", root, "MG_CheckersCols");
        twoCol.AddClass("mg-game-2col");
        // The board grid and the pieces overlay must OCCUPY THE SAME SPACE. Panorama has
        // no `position: absolute`; instead the wrap uses `flow-children: none` so both its
        // children stack at the top-left, and the pieces layer (added last) paints on top.
        const boardWrap = $.CreatePanel("Panel", twoCol, "MG_BoardWrap");
        boardWrap.AddClass("mg-board-wrap");
        const boardPanel = $.CreatePanel("Panel", boardWrap, "MG_Board");
        boardPanel.AddClass("mg-board");
        // Move-list side panel (right column): a header, a scrollable list of completed turns,
        // and a Prev/Next/Live navigation bar. renderMoveList() fills the list; the nav buttons
        // step a purely LOCAL review of past positions (see navPrev/navNext/navLive) - the live
        // game keeps running underneath and the model board is never touched by a review.
        let moveListRows = null, navPrevBtn = null, navNextBtn = null, navLiveBtn = null;
        (function buildSidePanel() {
            const panel = $.CreatePanel("Panel", twoCol, "MG_CheckersMoves");
            panel.AddClass("mg-movelist");
            // Clocks sit at the TOP of the side panel (opponent above, you below - see clockSeat).
            // secs=0 → the module builds nothing and every call is a no-op, so an untimed game is
            // visually unchanged. Server seat 0 = host = white; clockSeat maps that to my view.
            clock = createClock(panel, timeControl, !session.bot, code, onFlag, clockNames(), clockSeatFor(myColor));
            const head = $.CreatePanel("Label", panel, "");
            head.AddClass("mg-movelist-head");
            head.text = "Moves";
            moveListRows = $.CreatePanel("Panel", panel, "");
            moveListRows.AddClass("mg-movelist-rows");
            const nav = $.CreatePanel("Panel", panel, "");
            nav.AddClass("mg-movelist-nav");
            navPrevBtn = makeNavBtn(nav, "< Prev", () => { navPrev(); });
            navLiveBtn = makeNavBtn(nav, "Live", () => { navLive(); });
            navNextBtn = makeNavBtn(nav, "Next >", () => { navNext(); });
            renderMoveList();
        })();
        // Clock rows are indexed by SERVER seat (0 = host = white, 1 = joiner = black). Name them
        // by colour so both players read the same labels regardless of who they are.
        function clockNames() {
            return session.bot
                ? [myColor === WHITE ? "You" : "Bot", myColor === WHITE ? "Bot" : "You"]
                : ["White", "Black"];
        }
        // The server clock seat for a checkers colour: white always host (seat 0).
        function clockSeatFor(color) { return color === WHITE ? 0 : 1; }
        // A side ran out of time: that seat loses, so the OTHER colour wins. seat 0 = white.
        function onFlag(seat) {
            if (gameOver) return;
            const winnerColor = seat === 0 ? BLACK : WHITE;   // loser is white(0)/black(1) → winner is the other
            finish(winnerColor, "time");
        }
        function syncClockTurn() { if (clock && clock.isTimed) clock.setTurn(clockSeatFor(turn)); }
                // makeNavBtn: shared, see MG.Widgets in mg_games.js


        // ── board geometry (must match mg.css: 60px cells, 46px pieces) ──────
        const SQ = 60, PIECE_SZ = 46, INSET = (SQ - PIECE_SZ) / 2;
        function transformFor(realIdx) {
            let d = toDisplay(realIdx);
            let dr = (d / 8) | 0, dc = d % 8;
            return `translate3d(${dc * SQ + INSET}px, ${dr * SQ + INSET}px, 0px)`;
        }

        let cells = [];
        let piecesLayer = null;
        let pieceEls = {};     // realSquare -> piece panel (its current visual position)

        function buildCells() {
            boardPanel.RemoveAndDeleteChildren();
            cells = [];
            pieceEls = {};
            // Build 8 explicit rows of 8 cells. Row layout can't mis-wrap the grid the
            // way flow:right-wrap does when a border shaves a pixel off the width.
            for (let dr = 0; dr < 8; dr++) {
                const rowPanel = $.CreatePanel("Panel", boardPanel, `row_${dr}`);
                rowPanel.AddClass("mg-board-row");
                for (let dc = 0; dc < 8; dc++) {
                    let d = dr * 8 + dc;
                    let i = fromDisplay(d);
                    const r = rowOf(i), c = colOf(i);
                    var cell = $.CreatePanel("Panel", rowPanel, `cell_${i}`);
                    cell.AddClass("mg-cell");
                    cell.AddClass(isDark(r, c) ? "mg-cell-dark" : "mg-cell-light");
                    ((square) => {
                        cell.SetPanelEvent("onactivate", () => { onCellClick(square); });
                        // Drop target for drag-and-drop. In Panorama a panel only becomes a
                        // valid drop target when its DragEnter handler returns true - without
                        // it, DragDrop never fires on the cell (that was why the drop didn't
                        // land). DragEnter also lets us remember which square the cursor is
                        // over, so DragEnd can commit the move even if DragDrop is flaky.
                        $.RegisterEventHandler("DragEnter", cell, () => {
                            if (dragActive) { dragOverSq = square; dragEnterCount++; }
                            return true; // accept the drop
                        });
                        $.RegisterEventHandler("DragLeave", cell, () => {
                            if (dragActive && dragOverSq === square) dragOverSq = -1;
                        });
                        $.RegisterEventHandler("DragDrop", cell, () => { onCellDrop(square); });
                        // Second, independent source for the hovered square: plain mouse-over.
                        // If the engine suppresses DragEnter mid-drag but still updates hover,
                        // this keeps dragOverSq current so DragEnd can commit from it.
                        cell.SetPanelEvent("onmouseover", () => { if (dragActive) dragOverSq = square; });
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
            // wrap - NOT a child of boardPanel (whose flow:down would push it below the
            // rows). CSS positions it inside the board's 3px border so it aligns to cells.
            //
            // hittest=false makes the LAYER itself transparent to input, so a click on an
            // empty square passes through to the cell beneath (which owns destination
            // clicks + '.mg-target' highlighting). hittestchildren stays default (true) so
            // the PIECES do receive input - required for drag-and-drop and click-to-select.
            // Destination squares are always empty, so no piece ever blocks a target cell.
            piecesLayer = $.CreatePanel("Panel", boardWrap, "MG_PiecesLayer");
            piecesLayer.AddClass("mg-pieces-layer");
            try { piecesLayer.SetAttributeString("hittest", "false"); } catch (e) {}
        }

        // Draw the a–h / 1–8 coordinate labels on a dedicated overlay. SQ=60; a label sits in
        // the cell corner (file: bottom-right of the bottom row; rank: top-left of the left col).
        function buildCoords() {
            const layer = $.CreatePanel("Panel", boardWrap, "MG_CoordsLayer");
            layer.AddClass("mg-coords-layer");
            try { layer.SetAttributeString("hittest", "false"); } catch (e) {}
            for (let d = 0; d < 64; d++) {
                let dr = (d / 8) | 0, dc = d % 8;
                if (dr !== 7 && dc !== 0) continue;           // only bottom row + left column
                let i = fromDisplay(d);
                const onDark = isDark(rowOf(i), colOf(i));
                if (dc === 0) {                                // rank number, top-left corner
                    addCoord(layer, dc * SQ, dr * SQ, String(8 - rowOf(i)), onDark, "rank");
                }
                if (dr === 7) {                                // file letter, bottom-right corner
                    addCoord(layer, dc * SQ, dr * SQ, String.fromCharCode(97 + colOf(i)), onDark, "file");
                }
            }
        }
        function addCoord(layer, x, y, text, onDark, kind) {
            const lbl = $.CreatePanel("Label", layer, "");
            lbl.AddClass("mg-coord");
            lbl.AddClass(onDark ? "mg-coord-ondark" : "mg-coord-onlight");
            lbl.text = text;
            // Place the small glyph directly in the cell corner by transform (flow:none parent,
            // same idiom as the pieces). rank → top-left; file → bottom-right of the 60px cell.
            // The file letter is shoved HARD into the bottom-right corner: the piece is a 46px
            // circle centred in the 60px cell (radius 23 about (30,30)); the old (46,43) offset put
            // the glyph ~20px from that centre - INSIDE the circle - so the piece painted over it and
            // the letter vanished under knights/rooks/bishops (maintainer 2026-07-16: "букв не видно").
            // (51,46) lands the glyph ~32px out, clear of the circle, and still inside the 60px cell.
            const ox = kind === "file" ? (SQ - 9) : 3;
            const oy = kind === "file" ? (SQ - 14) : 2;
            lbl.style.transform = `translate3d(${x + ox}px, ${y + oy}px, 0px)`;
        }

        // interactive defaults to true (live board). Review renders pass false so the snapshot
        // pieces are inert (no drag/select) - you're looking at a past position, not playing it.
        function makePiece(realIdx, v, interactive) {
            const piece = $.CreatePanel("Panel", piecesLayer, "");
            piece.AddClass("mg-piece");
            piece.AddClass(colorOf(v) === WHITE ? "mg-white" : "mg-black");
            if (isKing(v)) piece.AddClass("mg-king");
            // Set the start position WITHOUT the transition (base .mg-piece has none), so a
            // fresh piece snaps onto its square instead of sliding in from the corner. Add
            // the animating class one frame later, once this position is committed - from
            // then on every transform/opacity/scale change animates. This is the same idiom
            // the game uses (transition on a class, toggled after the value is set).
            piece.style.transform = transformFor(realIdx);
            $.Schedule(0.0, () => {
                if (piece && piece.IsValid && piece.IsValid()) piece.AddClass("mg-anim");
            });
            piece._sq = realIdx;          // live square this piece sits on (updated on slide)
            pieceEls[realIdx] = piece;
            if (interactive !== false) setupPieceInput(piece);
            return piece;
        }

        // Wire one piece for BOTH interaction styles the user asked for:
        //  • click-to-select  (onactivate → onCellClick on its own square)
        //  • drag-and-drop     (native SetDraggable + DragStart/DragEnd - QOLLOCK recipe)
        // Because the pieces layer now lets pieces receive input (hittest passes through
        // only on empty squares), the click that used to fall through to the cell beneath
        // is delivered to the PIECE - so the piece must forward it to the same handler.
        function setupPieceInput(piece) {
            // A tap on a piece selects it (or, if it's already a legal target square of
            // the current selection, plays the hop) - identical to clicking its cell.
            piece.SetPanelEvent("onactivate", () => {
                if (piece._sq === undefined) return;
                onCellClick(piece._sq);
            });

            // Only my own pieces are ever grabbable; opponent pieces stay non-draggable.
            if (colorOf(board[piece._sq]) !== myColor) return;
            piece.SetDraggable(true);

            $.RegisterEventHandler("DragStart", piece, (_p, dragEvent) => {
                if (destroyed || reviewIndex !== null) return; // no dragging while reviewing history
                // Allow a drag both on my turn (a real move) AND on the opponent's turn (to queue a
                // premove). Only block it when neither is possible (game over etc.).
                if (!myTurn() && !canPremove()) return;
                const sq = piece._sq;
                // Only ever start a drag on a square that STILL holds one of MY pieces. A piece
                // the opponent just captured lingers ~0.22s as a shrinking, still-draggable panel;
                // grabbing it would (a) build the ghost from board[sq] - now the opponent's piece,
                // so a wrong-colour ghost - and (b) leak that ghost forever, because the fade
                // deletes the panel mid-drag and the engine never fires DragEnd on a dead panel.
                // My own pieces stay mine throughout the opponent's turn, so premove-drags pass.
                if (colorOf(board[sq]) !== myColor) return;
                // ALWAYS provide a ghost as the drag visual so the engine never drags the
                // real piece around (QOLLOCK sets dragEvent.displayPanel for exactly this).
                const ghost = $.CreatePanel("Panel", piecesLayer, "");
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
                dragFromSq = sq;                  // remember where this drag began (used by the premove drop path)
                piece.AddClass("mg-drag-source"); // dim the real piece while it's "lifted"

                // Light up this piece's legal targets as drop hints - but only when it may
                // actually move now (my turn, and mid-chain only the chaining piece). If it
                // can't, we leave no selection, so any drop is a harmless snap-back.
                if (!destroyed && myTurn() && !(chaining && sq !== selected)) {
                    if (selected !== sq) onCellClick(sq);
                }
            });

            $.RegisterEventHandler("DragEnd", piece, (_p, droppedPanel) => {
                // THE hard part. Every single-channel drop scheme we tried failed in-game.
                // Don't trust any ONE signal - gather EVERY candidate square we can and
                // commit the first that is a legal target. A wrong/garbage candidate simply
                // isn't in legalTargets, so it's ignored; if none match, the piece snaps
                // back. No false move is possible, and nothing here touches the server.
                // `droppedPanel` is DragEnd's 2nd arg: the panel released onto (native,
                // authoritative when present - this is how QOLLOCK's ql_hero_testing works).
                if (!myTurn() && canPremove()) {
                    // Dragged during the opponent's turn → queue a PREMOVE to the dropped square.
                    const pmTo = dropSquare(droppedPanel);
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
                if (selected < 0 && dragFromSq >= 0 && colorOf(board[dragFromSq]) === myColor) {
                    const liveTg = targetsFor(dragFromSq);
                    if (liveTg.length > 0) { selected = dragFromSq; legalTargets = liveTg; }
                }
                commitDropMultimethod(droppedPanel);

                // Tear the ghost + dim + drag state down regardless of outcome. A drop on empty
                // space (no legal target) just snaps back - the real piece never moved.
                clearDrag();
            });
        }

        // ── drop resolution: try many mappings, commit the first legal one ─────
        // NOTE: GameUI.GetCursorPosition is CONFIRMED ABSENT in Deadlock (see QOLLOCK
        // ql_settings.js / ql_core.js), so no method here may depend on reading the OS
        // cursor. Everything below works from panel signals only.

        // Is `sq` currently a legal target of the selected piece?
        function isLegalTarget(sq) {
            for (let t = 0; t < legalTargets.length; t++) if (legalTargets[t].to === sq) return true;
            return false;
        }

// squareFromPanel: shared, see MG.Widgets in mg_games.js


// winPos: shared, see MG.Widgets in mg_games.js


        // Render scale = WINDOW px per LAYOUT px. Panorama scales the whole UI by one uniform
        // factor, but a panel's actuallayoutwidth stays in LAYOUT px while GetPositionWithinWindow
        // returns WINDOW px. The old squareFromWindow divided a window-px delta by a layout-px cell
        // size (=60) - they only agree at 100% UI scale; at 125% the drop landed a square or two off
        // (the maintainer's "DROP MISS win=30 … targets=[21]" trace: 1.25× off). We DERIVE the scale
        // from two board cells a known layout distance apart, using ONLY GetPositionWithinWindow
        // (proven in-game 2026-07-07). actualuiscale_x IS in the engine property table but neither
        // the game nor QOLLOCK reads it from JS, so we measure instead of trusting it (property
        // fallback only if the cell measurement fails).
        function uiScale() {
            const a = cells[fromDisplay(0)];   // display (row 0, col 0)
            const b = cells[fromDisplay(7)];   // display (row 0, col 7) - 7 cells to the right
            const pa = winPos(a), pb = winPos(b);
            if (pa && pb) {
                const dx = Math.abs(pb.x - pa.x);       // = 7 * SQ * scale in window px
                if (dx > 1) return dx / (7 * SQ);
            }
            const s = piecesLayer ? Number(piecesLayer.actualuiscale_x) : NaN;
            if (isFinite(s) && s > 0.1 && s < 10) return s;
            return 1;
        }

        // Map the ghost's window position to a board square. Convert the window-space ghost→layer
        // delta into LAYOUT-space cells via uiScale(): cell size in window px = SQ * scale, the
        // ghost's half-width in window px = PIECE_SZ * scale (its layout size scaled up). Ghost
        // centre relative to the layer origin ÷ the window cell size → display col/row → real square.
        function squareFromWindow() {
            const lp = winPos(piecesLayer);
            const gp = winPos(dragGhost);
            if (!lp || !gp) return -1;
            const scale = uiScale();
            const cellW = SQ * scale;                 // one cell, in window px
            const half = (PIECE_SZ * scale) / 2;      // ghost half-width, in window px
            const cx = (gp.x - lp.x) + half;
            const cy = (gp.y - lp.y) + half;
            const dcol = Math.floor(cx / cellW), drow = Math.floor(cy / cellW);
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
        // writes the drop position into the display panel's style.x/style.y - this is exactly
        // what QOLLOCK's ReadPanelPosition reads FIRST, and it's the channel we had never used.
        // actualxoffset is only the fallback.
        function ghostPos() {
            const g = dragGhost;
            if (!g || (g.IsValid && !g.IsValid())) return null;
            try { if (g.GetParent && g.GetParent() !== piecesLayer) g.SetParent(piecesLayer); } catch (e) {}
            const sx = parsePx(g.style ? g.style.x : null);
            const sy = parsePx(g.style ? g.style.y : null);
            const ax = (typeof g.actualxoffset === "number" && isFinite(g.actualxoffset)) ? g.actualxoffset : null;
            const ay = (typeof g.actualyoffset === "number" && isFinite(g.actualyoffset)) ? g.actualyoffset : null;
            const x = (sx !== null) ? sx : ax;
            const y = (sy !== null) ? sy : ay;
            if (x === null || y === null) return null;
            return { x: x, y: y, sx: sx, sy: sy, ax: ax, ay: ay };
        }

        function squareFromGhost() {
            const p = ghostPos();
            if (!p) return -1;
            if (p.x === 0 && p.y === 0) return -1; // suspicious origin → let other methods try
            const cx = p.x + PIECE_SZ / 2, cy = p.y + PIECE_SZ / 2;
            const dcol = Math.floor(cx / SQ), drow = Math.floor(cy / SQ);
            if (dcol < 0 || dcol > 7 || drow < 0 || drow > 7) return -1;
            return fromDisplay(drow * 8 + dcol);
        }

        // Resolve the raw board square a drop landed on (no legal-target filter - used by the
        // premove path, which validates later against the post-opponent board). Same multi-channel
        // geometry as commitDropMultimethod: window position first, then the native drop panel.
        function dropSquare(droppedPanel) {
            const wSq = squareFromWindow();
            if (wSq >= 0) return wSq;
            const aPanel = squareFromPanel(droppedPanel);
            if (aPanel >= 0) return aPanel;
            if (dragOverSq >= 0) return dragOverSq;
            return squareFromGhost();
        }

        // Try each candidate in priority order; commit the first that is a legal target.
        // `droppedPanel` is DragEnd's authoritative 2nd arg (the panel released onto).
        function commitDropMultimethod(droppedPanel) {
            if (destroyed || !myTurn() || selected < 0) {
                if (DRAG_DEBUG) status(`drop ignored: myTurn=${myTurn()} selected=${selected}`);
                return;
            }
            // Capture window positions FIRST, before squareFromGhost() reparents the ghost
            // (reparenting would invalidate the window reading).
            const lw = winPos(piecesLayer);
            const gw = winPos(dragGhost);
            const wSq = squareFromWindow();               // W: absolute window geometry (new primary)
            const aPanel = squareFromPanel(droppedPanel); // A: native drop panel (proven = the ghost, no id)
            const bOver = dragOverSq;                     // B: last cell hovered (DragEnter/mouseover - dead in-game)
            const cGhost = squareFromGhost();             // C: ghost layout geometry (FLT_MAX in-game)
            const candidates = [wSq, aPanel, bOver, cGhost];
            const names = ["win", "panel", "over", "ghost"];
            let matched = -1, via = "none";
            for (let k = 0; k < candidates.length; k++) {
                if (candidates[k] >= 0 && isLegalTarget(candidates[k])) { matched = candidates[k]; via = names[k]; break; }
            }

            if (DRAG_DEBUG) {
                let dpid = "null";
                try { dpid = droppedPanel ? (droppedPanel.id || "noid") : "null"; } catch (e) { dpid = "err"; }
                const tg = [];
                for (let t = 0; t < legalTargets.length; t++) tg.push(legalTargets[t].to);
                const lwS = lw ? (Math.round(lw.x) + "," + Math.round(lw.y)) : "null";
                const gwS = gw ? (Math.round(gw.x) + "," + Math.round(gw.y)) : "null";
                const lwd = (piecesLayer && piecesLayer.actuallayoutwidth) || "?";
                status("DROP " + (matched >= 0 ? (`OK via ${via}->${matched}`) : "MISS") +
                    " | win=" + wSq + " g(" + gwS + ") L(" + lwS + ") lw=" + lwd +
                    " | panel=" + dpid + "->" + aPanel + " over=" + bOver + "(" + dragEnterCount + "e) ghost=" + cGhost +
                    " | targets=[" + tg.join(",") + "]");
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
            for (let i = 0; i < 64; i++) { if (board[i]) makePiece(i, board[i]); }
        }

        // Selection + legal-target highlighting only (cheap; touches no pieces). Suppressed
        // while reviewing - renderReview() owns the cell classes then, and a live move landing
        // during a review must not repaint the board the player is studying.
        function refreshHighlights() {
            if (reviewIndex !== null) return;
            for (let i = 0; i < 64; i++) {
                const cell = cells[i];
                if (!cell) continue;
                cell.RemoveClass("mg-sel");
                cell.RemoveClass("mg-target");
                cell.RemoveClass("mg-lastmove");
                cell.RemoveClass("mg-lastmove-to");
                cell.RemoveClass("mg-premove");
            }
            // FROM = light wash, TO = darker wash (maintainer: the destination must read darker).
            if (lastFrom >= 0 && cells[lastFrom]) cells[lastFrom].AddClass("mg-lastmove");
            if (lastTo >= 0 && cells[lastTo]) cells[lastTo].AddClass("mg-lastmove-to");
            if (selected >= 0 && cells[selected]) cells[selected].AddClass("mg-sel");
            for (let t = 0; t < legalTargets.length; t++) {
                const tc = cells[legalTargets[t].to];
                if (tc) tc.AddClass("mg-target");
            }
            // Queued premove (opponent's turn): glow the picked piece and, once a destination is
            // set, both ends. A distinct class from the live selection so it reads as "pending".
            if (preSelected >= 0 && cells[preSelected]) cells[preSelected].AddClass("mg-premove");
            if (premove) {
                if (cells[premove.from]) cells[premove.from].AddClass("mg-premove");
                if (cells[premove.to]) cells[premove.to].AddClass("mg-premove");
            }
        }

        // ── move history + local review ──────────────────────────────────────
        // Coordinate name of a REAL square (a1..h8). rank counts up from White's side; matches
        // the board coordinate labels (buildCoords), so a move reads the same as the printed grid.
        function sqName(i) { return String.fromCharCode(97 + colOf(i)) + (8 - rowOf(i)); }
        function moveLabel(from, to, cap) { return sqName(from) + (cap ? "x" : "-") + sqName(to); }

        // Record one COMPLETED turn (checkers: the whole multi-hop sequence collapses to
        // first-from → last-to). Snapshots the resulting board so the position can be replayed
        // read-only later. Called from every turn-completion path (own move, opponent, bot).
        function pushHistory(from, to, cap) {
            // Idle counter for the 15-move draw rule, updated BEFORE the new entry is pushed so
            // the previous entry still holds the pre-move board (the first turn's pre-move board is
            // the initial one). pushHistory runs exactly once per COMPLETED turn in all three paths
            // (local, bot, polled), which is precisely the granularity the rule counts.
            const pre = history.length ? history[history.length - 1].boardAfter : initialBoard();
            const mover = pre[from];
            idleTurns = (cap || mover === 1 || mover === 3) ? 0 : idleTurns + 1;
            history.push({ from: from, to: to, boardAfter: board.slice(), label: moveLabel(from, to, cap) });
            renderMoveList();
        }

        // Rebuild the move list. Highlights the row for the position currently shown (the last
        // row while live). Rows are clickable to jump to that position. Auto-scrolls to the
        // newest row while live so the latest move stays visible.
        function renderMoveList() {
            if (!moveListRows || !(moveListRows.IsValid && moveListRows.IsValid())) return;
            moveListRows.RemoveAndDeleteChildren();
            if (history.length === 0) {
                const e = $.CreatePanel("Label", moveListRows, "");
                e.AddClass("mg-move-empty");
                e.text = "No moves yet.";
            } else {
                const cur = (reviewIndex === null) ? history.length - 1 : reviewIndex;
                for (let i = 0; i < history.length; i++) {
                    ((idx) => {
                        var row = $.CreatePanel("Label", moveListRows, "");
                        row.AddClass("mg-move-row");
                        if (idx === cur) row.AddClass("mg-move-current");
                        row.text = (idx + 1) + ". " + history[idx].label;
                        row.SetPanelEvent("onactivate", () => { gotoReview(idx); });
                    })(i);
                }
            }
            updateNav();
            if (reviewIndex === null) { try { moveListRows.ScrollToBottom(); } catch (e2) {} }
        }

                // setNavState: shared, see MG.Widgets in mg_games.js

        function updateNav() {
            const shown = (history.length === 0) ? -2 : (reviewIndex === null ? history.length - 1 : reviewIndex);
            setNavState(navPrevBtn, shown > -1);           // something earlier to step back to
            setNavState(navNextBtn, reviewIndex !== null); // only meaningful while reviewing
            setNavState(navLiveBtn, reviewIndex !== null);
        }

        // Render the pieces of an ARBITRARY board snapshot as inert (non-interactive) pieces.
        function layoutPiecesFrom(src) {
            if (!piecesLayer) return;
            clearDrag();
            piecesLayer.RemoveAndDeleteChildren();
            pieceEls = {};
            for (let i = 0; i < 64; i++) { if (src[i]) makePiece(i, src[i], false); }
        }

        // Show the position after review move `idx` (idx === -1 = initial position). Read-only:
        // no selection, only that move's from/to washed. Does NOT touch the live model.
        function renderReview() {
            const idx = reviewIndex;
            const snap = (idx < 0) ? initialBoard() : history[idx].boardAfter;
            layoutPiecesFrom(snap);
            for (let i = 0; i < 64; i++) {
                const c = cells[i];
                if (!c) continue;
                c.RemoveClass("mg-sel"); c.RemoveClass("mg-target"); c.RemoveClass("mg-lastmove");
            }
            if (idx >= 0) {
                const e = history[idx];
                if (cells[e.from]) cells[e.from].AddClass("mg-lastmove");
                if (cells[e.to]) cells[e.to].AddClass("mg-lastmove");
            }
        }

        function shownIndex() { return reviewIndex === null ? history.length - 1 : reviewIndex; }
        function setReview(idx) { reviewIndex = idx; renderReview(); renderMoveList(); }
        // ⚠ Jumping to the LAST row is "go live", not "review the live position". Reported by a
        // player 2026-08-03 as a softlock: the newest row is the highlighted "you are here" row, so
        // it is the most natural one to click - and clicking it used to call setReview(last), which
        // renders history[last].boardAfter. That snapshot IS the live position, so absolutely
        // nothing changed on screen and the status line still read "Your turn." - but reviewIndex
        // was now set, and onCellClick / onCellDrop / DragStart all bail on `reviewIndex !== null`.
        // The board went dead while looking and claiming to be live, with the Live button the only
        // way out and no reason on screen to press it ("its not letting me move any other checkers
        // either. im softlocked"). Reviewing the live position is meaningless in every case, so
        // route it to navLive() instead: same picture, but the board stays playable.
        function gotoReview(idx) {
            if (idx < 0 || idx >= history.length) return;
            if (idx === history.length - 1) { navLive(); return; }
            setReview(idx);
        }
        function navPrev() { if (history.length === 0) return; let t = shownIndex() - 1; if (t < -1) return; setReview(t); }
        function navNext() {
            if (reviewIndex === null) return;              // already live (latest)
            let t = reviewIndex + 1;
            if (t >= history.length - 1) { navLive(); return; }
            setReview(t);
        }
        // Resume following the live game: drop review, rebuild the interactive board + highlights.
        function navLive() {
            reviewIndex = null;
            layoutPieces();
            refreshHighlights();
            renderMoveList();
        }

        // Apply a hop to the model AND report the captured square (for the fade fx).
        function applyHopFx(from, to) {
            const before = board.slice();
            const res = applyHop(board, from, to);
            let capIdx = -1;
            if (res.captured) {
                for (let i = 0; i < 64; i++) {
                    if (before[i] && !board[i] && i !== from && i !== to) { capIdx = i; break; }
                }
            }
            return { captured: res.captured, promoted: res.promoted, capIdx: capIdx };
        }

        // Derive the turn-hand-off flag `end` for a polled hop WITHOUT the server sending it
        // (it no longer fits the level-quantised downlink). Mirrors worker.core.js
        // validateCheckers EXACTLY: apply the hop to a COPY, then the turn continues (end=0)
        // only if this same piece just captured, wasn't crowned, and still has a capture
        // available; otherwise the turn hands off (end=1). Uses a copy so the live board is
        // untouched - the caller applies the real hop itself.
        function deriveMoveEnd(from, to) {
            const copy = board.slice();
            const res = applyHop(copy, from, to);
            const more = res.captured && (!res.promoted || !RCv.promotionEndsTurn) && captureMoves(copy, to).length > 0;
            return more ? 0 : 1;
        }

        // Slide the piece from->to; shrink-fade a captured piece; crown on promotion.
        function animateHop(from, to, capIdx, promoted) {
            // While reviewing, the pieces layer shows a past snapshot, not the live model -
            // so skip the visual (the model already advanced via applyHopFx). navLive() rebuilds
            // the current position from the model when the player returns to the live game.
            if (reviewIndex !== null) { clearDrag(); return; }
            // A hop arriving mid-drag (you're queuing a premove during the opponent's turn) must
            // NOT yank your held piece back - that snap-back was the checkers copy of the chess
            // "premove teleports back" bug. Only tear the drag down when this hop actually DELETES
            // the piece you're holding (it captures on dragFromSq): its panel + DragEnd handler
            // vanish, which would otherwise leak the ghost, and the premove is impossible anyway.
            // Any other hop leaves the drag intact so the premove keeps tracking the cursor. (For
            // your OWN hop the drag already ended, so dragActive is false and this is a no-op.)
            if (dragActive && capIdx === dragFromSq) { clearPremove(); clearDrag(); }
            if (capIdx >= 0 && pieceEls[capIdx]) {
                const dead = pieceEls[capIdx];
                delete pieceEls[capIdx];
                // Keep the translate3d that holds the piece on its square, and shrink it
                // IN PLACE with pre-transform-scale2d (the game's idiom - it scales before
                // the translate, so the piece stays put). scale3d INSIDE the transform
                // multiplied the translate offset and hurled the piece toward (0,0) - that
                // was the "flies up-left" artifact. opacity + scale animate via .mg-piece.
                dead.AddClass("mg-captured");
                dead.style.preTransformScale2d = "0.2";
                ((d) => { $.Schedule(0.22, () => { try { d.DeleteAsync(0); } catch (e) {} }); })(dead);
            }
            const piece = pieceEls[from];
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

        // Illegal-move feedback (maintainer 2026-07-15): a wrong click/drop plays the Illegal
        // cue and, when a capture is available, briefly flashes the piece(s) that MUST jump -
        // Russian checkers forces the capture and it isn't always obvious which piece is obliged.
        // The flash is a JS-toggled class (.mg-mustcap) removed after ~0.9s; a background-color
        // transition eases the amber in/out (mg.css). Squares with a mandatory capture right now, for my colour.
        function mustCaptureSquares() {
            if (!anyCaptureFor(board, myColor)) return [];
            const out = [];
            for (let i = 0; i < 64; i++) {
                if (colorOf(board[i]) === myColor && captureMoves(board, i).length > 0) out.push(i);
            }
            return out;
        }
        let mustCapToken = 0;
        function flashMustCapture() {
            const sqs = mustCaptureSquares();
            if (sqs.length === 0) return;
            mustCapToken++;
            const tok = mustCapToken;
            for (let k = 0; k < sqs.length; k++) if (cells[sqs[k]]) cells[sqs[k]].AddClass("mg-mustcap");
            $.Schedule(0.9, () => {
                if (destroyed || tok !== mustCapToken) return;
                for (let j = 0; j < sqs.length; j++) if (cells[sqs[j]]) cells[sqs[j]].RemoveClass("mg-mustcap");
            });
        }
        // A click/drop that couldn't be a legal move: sound + (if forced) the must-capture flash.
        function rejectMove() { sfx("Illegal"); flashMustCapture(); }

        // A premove can be queued only online (a bot moves instantly, so there's no waiting
        // window), when the game's live and it's NOT my turn yet.
        function canPremove() { return !gameOver && !destroyed && reviewIndex === null && !myTurn(); }
        function clearPremove() { premove = null; preSelected = -1; refreshHighlights(); }
        // A click while it's the opponent's turn: pick one of my pieces as the premove source,
        // then a second click sets the destination. We DON'T validate against the current board
        // (the position will change after the opponent moves - e.g. a recapture lands on a square
        // that's still occupied by my own piece right now); the queued {from,to} is validated when
        // it's actually my turn (tryPremove) and silently dropped if it's no longer legal.
        // We DO gate on the piece's MOVEMENT GEOMETRY, though: occupancy changes after the
        // opponent moves but a man can never step sideways and a piece never leaves a diagonal,
        // so an impossible shape is rejected up-front (sound feedback) instead of being painted
        // orange only to be silently discarded - the "premove anywhere" complaint.
        function premoveGeometryOk(from, to) {
            const v = board[from];
            if (colorOf(v) !== myColor || from === to) return false;
            if (!isDark(rowOf(to), colOf(to))) return false;          // checkers lives on dark squares
            let dr = rowOf(to) - rowOf(from), dc = colOf(to) - colOf(from);
            if (Math.abs(dr) !== Math.abs(dc)) return false;          // off a diagonal → impossible
            if (isKing(v)) return true;                                // flying king: any diagonal distance
            const dist = Math.abs(dr);
            if (dist === 2) return true;                               // man capture hop (jumps any direction)
            if (dist === 1) return dr === (v === 1 ? -1 : 1);          // simple step: forward only
            return false;
        }
        function premoveClick(i) {
            if (colorOf(board[i]) === myColor) { preSelected = i; premove = null; refreshHighlights(); return; }
            if (preSelected >= 0 && i !== preSelected) {
                if (!premoveGeometryOk(preSelected, i)) { sfx("Illegal"); return; }   // keep the piece picked; let them retry
                premove = { from: preSelected, to: i }; preSelected = -1; sfx("Premove"); refreshHighlights(); return;
            }
            clearPremove();
        }
        // Called the instant the turn flips to me (opponent's move just landed). Replays the
        // queued premove if it's legal on the NEW board, else discards it. A bare source pick with
        // no destination (preSelected set, premove null) is ALSO cleared here - else the orange
        // "pending" wash on the picked cell would survive the turn flip forever (the stuck-orange bug).
        function tryPremove() {
            if (!premove) { if (preSelected >= 0) { preSelected = -1; refreshHighlights(); } return; }
            const pm = premove; premove = null; preSelected = -1;
            if (!myTurn()) { refreshHighlights(); return; }
            const tg = targetsFor(pm.from);
            for (let t = 0; t < tg.length; t++) {
                if (tg[t].to === pm.to) {
                    selected = pm.from; legalTargets = tg; refreshHighlights();
                    doLocalHop(pm.from, tg[t]);
                    return;
                }
            }
            refreshHighlights();   // premove no longer legal - just drop it
        }

        function onCellClick(i) {
            if (destroyed) return;
            // Reviewing a PAST position: the board is a read-only snapshot, so a click can't be a
            // move. Say so instead of swallowing it silently - a dead board with no explanation is
            // indistinguishable from a broken game (that is how the review softlock was reported).
            if (reviewIndex !== null) { status("Reviewing an earlier move. Press Live to play on."); sfx("Illegal"); return; }
            if (!myTurn()) { if (canPremove()) premoveClick(i); return; }

            // Clicking a legal target of the currently selected piece = execute a hop.
            if (selected >= 0) {
                for (let t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalHop(selected, legalTargets[t]); return; }
                }
                // A selection is up but this square isn't one of its targets. If it's not a
                // re-select of another of my movable pieces either, it's an illegal attempt.
                if (colorOf(board[i]) !== myColor) { rejectMove(); return; }
            }
            if (chaining) { rejectMove(); return; } // during a chain only its targets are clickable

            // Otherwise (re)select one of my pieces that actually has a legal move.
            if (colorOf(board[i]) === myColor) {
                const tg = targetsFor(i);
                if (tg.length === 0) { status("That piece has no legal move."); rejectMove(); return; }
                selected = i;
                legalTargets = tg;
                refreshHighlights();
            }
        }

        // A piece was dropped onto square `i`. Play the hop if `i` is a legal target of
        // the piece we're dragging; otherwise it's a no-op and the ghost just snaps back.
        function onCellDrop(i) {
            if (destroyed || reviewIndex !== null || !myTurn() || !dragActive || selected < 0) return;
            for (let t = 0; t < legalTargets.length; t++) {
                if (legalTargets[t].to === i) {
                    doLocalHop(selected, legalTargets[t]);
                    return;
                }
            }
            // Dropped on a non-target: reject (sound + forced-capture flash), keep the selection
            // so its hints stay up for a click.
            rejectMove();
        }

        let pendingHops = [];

        function doLocalHop(from, mv) {
            if (pendingHops.length === 0) myTurnCapture = false; // first hop of a fresh turn
            const res = applyHopFx(from, mv.to);
            if (res.captured) myTurnCapture = true;
            animateHop(from, mv.to, res.capIdx, res.promoted);
            sfx(res.promoted ? "Promote" : res.captured ? "Capture" : "MoveSelf");
            pendingHops.push({ from: from, to: mv.to });

            // Can the same piece keep jumping? Russian canon: a man crowned mid-capture keeps
            // capturing as a flying king; English: promotion ends the turn (promotionEndsTurn).
            const more = res.captured && (!res.promoted || !RCv.promotionEndsTurn) && captureMoves(board, mv.to).length > 0;
            if (more) {
                chaining = true;
                selected = mv.to;
                legalTargets = captureMoves(board, mv.to);
                refreshHighlights();
                status("Keep jumping!");
                return;
            }

            // Turn complete - mark last hop as turn-ending and relay the whole sequence.
            chaining = false;
            clearSelection();
            const hops = pendingHops.slice();
            pendingHops = [];
            lastFrom = hops[0].from; lastTo = hops[hops.length - 1].to; // first from, last to
            refreshHighlights();
            pushHistory(lastFrom, lastTo, myTurnCapture);
            for (let h = 0; h < hops.length; h++) hops[h].end = (h === hops.length - 1) ? 1 : 0;

            turn = (myColor === WHITE ? BLACK : WHITE); // hand off locally right away
            syncClockTurn();                            // opponent's bank starts draining

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

        // Drive the resumable bot search ONE root move per frame, yielding with $.Schedule(0)
        // between steps. The old chooseBotMove() ran the whole depth-5 minimax in one blocking
        // call, which froze the HUD (the "лаги при ходе бота") AND swallowed the window in which a
        // premove could be grabbed. Stepping keeps the board live the whole time the bot "thinks".
        function botTurn() {
            if (destroyed || gameOver) return;
            const botColor = (myColor === WHITE ? BLACK : WHITE);
            if (!chooseBotMovePrep) {   // older rules bundle: one-shot fallback
                const s = chooseBotMove(board, botColor);
                if (!s) { checkEnd(); return; }
                botTurnCapture = false; applyBotSeq(s, 0); return;
            }
            const driver = chooseBotMovePrep(board, botColor);
            (function drive() {
                if (destroyed || gameOver) return;
                if (!driver.done()) { driver.step(); $.Schedule(0.0, drive); return; }
                const seq = driver.result();
                if (!seq) { checkEnd(); return; } // no legal move → checkEnd declares winner
                botTurnCapture = false;
                applyBotSeq(seq, 0);
            })();
        }

        function applyBotSeq(seq, h) {
            if (destroyed) return;
            if (h >= seq.length) {
                turn = myColor;
                syncClockTurn();
                lastFrom = seq[0].from; lastTo = seq[seq.length - 1].to;
                refreshHighlights();
                pushHistory(lastFrom, lastTo, botTurnCapture);
                checkEnd();
                if (!gameOver) { status("Your turn."); tryPremove(); }
                return;
            }
            const res = applyHopFx(seq[h].from, seq[h].to);
            if (res.captured) botTurnCapture = true;
            animateHop(seq[h].from, seq[h].to, res.capIdx, res.promoted);
            sfx(res.promoted ? "Promote" : (res.captured ? "Capture" : "MoveOpp"));
            $.Schedule(0.35, () => { applyBotSeq(seq, h + 1); }); // step hops for visibility
        }

        function sendHops(hops, i) {
            if (destroyed) return;
            if (i >= hops.length) { afterTurnSwitch(); return; }
            const hop = hops[i];
            Api.move(code, hop.from, hop.to, hop.end, session.tok, (r) => {
                if (r.ok) {
                    appliedSeq++; // our own hop is now in the shared server list
                    sendHops(hops, i + 1);
                    return;
                }
                // The AUTHORITATIVE server rejected this hop (illegal / not-our-turn /
                // bad token). Our optimistic prediction is now wrong - roll the whole
                // turn back to the last server-confirmed state and resync via poll.
                rejectAndResync(r.reason);
            }, () => {
                $.Schedule(0.6, () => { sendHops(hops, i); }); // transport hiccup: retry same hop
            });
        }

        // Server said no. Discard the predicted turn, rebuild the board from the moves
        // the server HAS accepted (0..appliedSeq), and drop back into polling so the
        // authoritative sequence drives us again. A cheat's illegal hop dies here; an
        // honest desync self-heals instead of wedging.
        function rejectAndResync(reason) {
            sfx("Illegal");
            pendingHops = [];
            chaining = false;
            clearSelection();
            board = initialBoard();
            turn = WHITE;
            // The rejected turn was optimistically pushed to history; the rebuilt board no longer
            // matches it. Rather than reconstruct multi-hop labels from raw hops (this path is a
            // rare cheat/desync recovery), drop the list and let it repopulate from live turns.
            history = []; reviewIndex = null;
            idleTurns = 0;             // rebuilt from move 1; pushHistory recounts as it replays
            replayAccepted(0);
        }

        // Re-fetch and re-apply the server's accepted moves from `seq` up to appliedSeq,
        // rebuilding the local board, then resume the normal turn/poll loop.
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
            Api.poll(code, seq, (mv) => {
                if (destroyed) return;
                if (mv) {
                    applyHop(board, mv.from, mv.to);
                    if (mv.end) turn = (turn === WHITE ? BLACK : WHITE);
                    replayAccepted(seq + 1);
                } else {
                    // fewer accepted moves than expected - trust what we have
                    appliedSeq = seq;
                    replayAccepted(seq);
                }
            }, () => { $.Schedule(0.4, () => { replayAccepted(seq); }); },
            function (from, to) {
                const fr = (from / 8) | 0, fc = from % 8, tr = (to / 8) | 0, tc = to % 8;
                return Math.abs(tr - fr) === Math.abs(tc - fc);
            }, deriveMoveEnd);
        }

        // ── opponent polling ────────────────────────────────────────────────
        function afterTurnSwitch() {
            checkEnd();
            if (gameOver) return;
            startPolling();
        }

        // Consecutive empty polls in the CURRENT wait - drives the adaptive cadence
        // (MG.Net.pollDelay): fast for the first few, then slower while the opponent thinks.
        let pollMisses = 0;
        function startPolling() {
            pollToken++;
            pollMisses = 0;
            const myToken = pollToken;
            pollOnce(myToken);
        }

        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken) return;
            if (turn === myColor) return; // it's our turn; nothing to poll
            Api.poll(code, appliedSeq, (mv) => {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    pollMisses = 0;                             // real move → next wait starts fast
                    if (oppSeqFrom < 0) oppTurnCapture = false; // first hop of this opponent turn
                    const res = applyHopFx(mv.from, mv.to);
                    appliedSeq++;
                    animateHop(mv.from, mv.to, res.capIdx, res.promoted);
                    sfx(res.promoted ? "Promote" : res.captured ? "Capture" : "MoveOpp");
                    if (res.captured) oppTurnCapture = true;
                    if (oppSeqFrom < 0) oppSeqFrom = mv.from; // first hop of this opponent turn
                    if (mv.end) {
                        turn = myColor;
                        syncClockTurn();
                        lastFrom = oppSeqFrom; lastTo = mv.to;
                        pushHistory(oppSeqFrom, mv.to, oppTurnCapture);
                        oppSeqFrom = -1;
                        checkEnd();
                        if (!gameOver) { refreshHighlights(); status("Your turn."); tryPremove(); }
                        return; // stop polling; wait for player input
                    }
                    $.Schedule(0.05, () => { pollOnce(myToken); }); // drain chain fast
                } else {
                    $.Schedule(MG.Net.pollDelay(pollMisses++), () => { pollOnce(myToken); });
                }
            }, () => {
                $.Schedule(MG.Net.pollDelay(pollMisses++), () => { pollOnce(myToken); });
            }, (from, to) => {
                // A real hop is always a diagonal between two board squares; anything
                // else is a mis-scaled read and must never reach applyHop.
                const fr = (from / 8) | 0, fc = from % 8, tr = (to / 8) | 0, tc = to % 8;
                return Math.abs(tr - fr) === Math.abs(tc - fc);
            }, deriveMoveEnd);
        }

        function checkEnd() {
            // count pieces first: no pieces left is terminal for either side regardless of turn
            let wc = 0, bc = 0;
            for (let i = 0; i < 64; i++) { if (colorOf(board[i]) === WHITE) wc++; else if (colorOf(board[i]) === BLACK) bc++; }
            if (wc === 0) { finish(BLACK); return; }
            if (bc === 0) { finish(WHITE); return; }
            // Draughts: you lose when YOU have no move ON YOUR TURN. Testing both colours
            // unconditionally declared a side lost while it wasn't even on the clock - the
            // opponent still has to move and may well unblock the position first (self-play
            // showed 48 premature game-overs in 4000 games).
            if (!hasAnyMove(board, turn)) { finish(turn === WHITE ? BLACK : WHITE); return; }
            // Draws. Without these a king-vs-king endgame shuffles forever and an untimed game
            // (the default) never ends at all.
            let dr = drawReason ? drawReason(board, idleTurns) : "";
            if (dr === "idle") finishDraw("Draw: 15 moves with no capture.");
            else if (dr === "kings") finishDraw("Draw: king against king.");
        }

        // `reason` is optional: "time" when the game ended on a flag-fall (shown in the status).
        function finish(winner, reason) {
            if (gameOver) return;      // a flag-fall + a board end can race; first one wins
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            const lost = reason === "time" ? " (on time)" : "";
            status(winner === myColor ? (`🏆 You win!${lost}`) : (`You lose.${lost}`));
            sfx("GameEnd");
            if (session.onGameOver) session.onGameOver(winner === myColor ? "win" : "lose");
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

        // ── boot ────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
        syncClockTurn();          // white (seat 0) is on the move at the start
        sfx("GameStart");
        if (myTurn()) {
            status(`Your turn. You play ${myColor === WHITE ? "white (bottom)." : "black (bottom)."}`);
        } else if (session.bot) {
            // Offline and it's white's turn but I'm black → the bot (white) opens.
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
        MG.Games.register({ id: 1, create: createCheckers });
    }
})();
