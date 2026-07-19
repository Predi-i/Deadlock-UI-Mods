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
    var legalSequences = RC.legalSequences, chooseBotMove = RC.chooseBotMove, chooseBotMovePrep = RC.chooseBotMovePrep;
    var tttWinner = RT.tttWinner, tttFull = RT.tttFull, tttBotMove = RT.tttBotMove;

    // ── shared game clock (chess & checkers) ─────────────────────────────────
    // Two side clocks rendered above/below the board. There are two backing modes:
    //   ONLINE  — the SERVER owns the banks and even the CHOICE of whether there's a clock at
    //             all (Quick Match resolves the time control only once a joiner arrives). So the
    //             online clock is fully POLL-DISCOVERED: we build a hidden shell, poll
    //             /api/clocks ~1/s, reveal it on the first timed reply and render verbatim, or
    //             tear it down if the server says the lobby is untimed. `secs` is IGNORED online.
    //   OFFLINE (bot) — no server, so we tick locally from `secs`: the side to move drains, and
    //             when it hits 0 that side flags. secs=0 offline → no clock (a no-op stub).
    // onFlag(seat) fires once when a side runs out. seatNames labels each clock.
    function createClock(parent, secs, online, code, onFlag, seatNames) {
        if (!online && !secs) return { el: null, setTurn: function () {}, stop: function () {}, isTimed: false };
        var flagged = -1, running = -1, stopped = false, revealed = false;
        var localMs = [secs * 1000, secs * 1000];   // offline banks; online we render server values
        var lastTick = 0;

        var wrap = $.CreatePanel("Panel", parent, "");
        wrap.AddClass("mg-clocks");
        if (online) wrap.style.visibility = "collapse";   // hidden until the first timed poll reveals it
        var rows = [];
        for (var s = 0; s < 2; s++) {
            var row = $.CreatePanel("Panel", wrap, "");
            row.AddClass("mg-clock-row");
            var name = $.CreatePanel("Label", row, ""); name.AddClass("mg-clock-name");
            name.text = (seatNames && seatNames[s]) || ("Seat " + (s + 1));
            var time = $.CreatePanel("Label", row, ""); time.AddClass("mg-clock-time");
            rows.push({ row: row, time: time });
        }

        function fmt(sec) {
            sec = Math.max(0, Math.ceil(sec));
            var m = Math.floor(sec / 60), s = sec % 60;
            return m + ":" + (s < 10 ? "0" + s : s);
        }
        function paint(secArr) {
            for (var s = 0; s < 2; s++) {
                if (!rows[s].time.IsValid()) continue;
                rows[s].time.text = fmt(secArr[s]);
                rows[s].row.SetHasClass("mg-clock-active", s === running && flagged < 0);
                rows[s].row.SetHasClass("mg-clock-low", secArr[s] <= 10 && flagged < 0);
                rows[s].row.SetHasClass("mg-clock-flagged", s === flagged);
            }
        }
        function fireFlag(seat) {
            if (flagged >= 0) return;
            flagged = seat;
            if (onFlag) onFlag(seat);
        }

        // OFFLINE: drain the running side locally, once per ~250ms tick.
        function localTick() {
            if (stopped || flagged >= 0 || online) return;
            var now = Date.now();
            if (running >= 0 && lastTick) {
                localMs[running] = Math.max(0, localMs[running] - (now - lastTick));
                if (localMs[running] === 0) fireFlag(running);
            }
            lastTick = now;
            paint([localMs[0] / 1000, localMs[1] / 1000]);
            if (!stopped && flagged < 0) $.Schedule(0.25, localTick);
        }
        // ONLINE: poll the authoritative banks and render them; the server decides flag-fall.
        // A null reply = the lobby is untimed (or gone): before we ever revealed the clock, that
        // means "no clock for this game" → tear the shell down and stop. Guarded by `stopped`
        // (set from the controller's destroy), so it dies with the view.
        function onlineTick() {
            if (stopped) return;
            MG.Api.clocks(code, function (r) {
                if (stopped) return;
                if (r) {
                    if (!revealed && wrap.IsValid()) { wrap.style.visibility = "visible"; revealed = true; }
                    if (r.flag >= 0) running = -1;         // once flagged nobody is "active"
                    paint(r.sec);
                    if (r.flag >= 0) { fireFlag(r.flag); return; }
                    $.Schedule(1.0, onlineTick);
                } else {
                    // Server says this lobby has no clock — remove the empty shell and stop polling.
                    stopped = true;
                    if (!revealed) { try { wrap.DeleteAsync(0); } catch (e) {} }
                }
            }, function () { if (!stopped) $.Schedule(1.2, onlineTick); });
        }

        if (online) { onlineTick(); }
        else { lastTick = Date.now(); localTick(); }

        return {
            el: wrap,
            isTimed: true,
            // Set which seat's clock is running (the side to move). Offline this switches which
            // bank drains; online it's cosmetic (the server already knows) but keeps the active
            // highlight responsive between the ~1s polls.
            setTurn: function (seat) {
                if (!online && running >= 0 && lastTick) {
                    localMs[running] = Math.max(0, localMs[running] - (Date.now() - lastTick));
                }
                running = seat; lastTick = Date.now();
            },
            stop: function () { stopped = true; }
        };
    }

    // ── shared per-turn countdown timer (durak / poker / connect-four / tic-tac-toe) ──
    // A slim VERTICAL bar to the LEFT of the board that drains top→bottom over TURN_SECS,
    // with the whole-seconds remaining shown beneath it. Unlike the chess/checkers side
    // clocks (two banks, server-authoritative), this is a SINGLE bar that runs ONLY while
    // it's the LOCAL player's turn: the controller calls start(onExpire) when the human is
    // put on the clock and stop() the instant they act (or a bot / online opponent takes
    // over). If the bar empties, onExpire() fires exactly once — the controller turns that
    // into a forfeit / elimination (offline it decides locally; online it sends a forfeit).
    //
    // NO @keyframes (ARCHITECTURE §17 — a stray @keyframes rule silently BRICKS the whole
    // modded HUD stylesheet). The drain is ONE `transform: translate3d(0, H, 0)` write with
    // a TURN_SECS-long LINEAR transition that lives on the .mg-tt-anim class (the
    // .mg-piece "set the value, let CSS tween it" idiom): a single assignment starts a smooth
    // slide with zero per-frame JS. A ~200ms $.Schedule loop only refreshes the seconds
    // label + swaps the low/crit colour classes and arms the expiry — the motion is pure CSS.
    //
    // The wrap is ALWAYS laid out (never visibility:collapse) so the empty channel reserves its
    // footprint permanently — the widget never pops in/out and the modal never jumps height when
    // a turn changes hands. Only the FILL + the seconds label toggle (opacity/text) between "my
    // turn" (draining) and idle (blank channel). TRACK_H is kept shorter than the shortest board
    // (TTT ≈336px) so the flow:none host always measures its height from the board, not the bar.
    //
    // opts.boardW (px): attach the bar to that board's LEFT EDGE (centre-align + translateX left
    // by half the board + a gap) instead of the modal's far-left gutter. TTT/C4 pass it (their
    // boards are narrow and centred, so the gutter looked detached); durak/poker omit it and keep
    // the wide-felt gutter placement the maintainer already signed off on.
    var TURN_SECS = 25;                    // per-turn budget; matches .mg-tt-anim transition-duration in mg.css
    function createTurnTimer(parent, opts) {
        var TRACK_H = 280;                 // px; MUST match .mg-tt-track height in mg.css (drain distance)
        var wrap = $.CreatePanel("Panel", parent, "");
        wrap.AddClass("mg-turn-timer");
        // Attach to a specific board's left edge when a width is given (TTT/C4). GAP + TIMER_W/2
        // match the .mg-turn-timer width in mg.css; the wrap is centre-aligned by .mg-tt-attached
        // then shoved left of the board so its right edge sits GAP px before the board's left edge.
        if (opts && opts.boardW) {
            var GAP = 14, TIMER_W = 34;
            wrap.AddClass("mg-tt-attached");
            wrap.style.transform = "translate3d(" + (-(opts.boardW / 2 + GAP + TIMER_W / 2)) + "px, 0px, 0px)";
        }
        var track = $.CreatePanel("Panel", wrap, "");
        track.AddClass("mg-tt-track");
        var fill = $.CreatePanel("Panel", track, "");
        fill.AddClass("mg-tt-fill");
        fill.style.opacity = "0.0";           // idle: only the empty channel shows (footprint reserved)
        var num = $.CreatePanel("Label", wrap, "");
        num.AddClass("mg-tt-num");

        var gen = 0;                       // bumps on every start/stop/destroy → stale ticks bail
        var dead = false, running = false, deadline = 0, expireCb = null;

        // Snap the fill FULL (no transition) so a fresh turn starts from a full bar; the arm()
        // below then flips on the animated class and pushes it to empty, tweening over TURN_SECS.
        function snapFull() {
            fill.RemoveClass("mg-tt-anim");
            fill.RemoveClass("mg-tt-low");
            fill.RemoveClass("mg-tt-crit");
            fill.style.transform = "translate3d(0px, 0px, 0px)";
            fill.style.opacity = "1.0";       // reveal the drain for my turn
        }
        function arm() {
            fill.AddClass("mg-tt-anim");
            fill.style.transform = "translate3d(0px, " + TRACK_H + "px, 0px)";   // drain top→bottom over TURN_SECS
        }

        function tick(myGen) {
            if (dead || myGen !== gen || !running) return;
            var remain = (deadline - Date.now()) / 1000;
            if (remain <= 0) {
                running = false;
                if (num.IsValid()) num.text = "0";
                var cb = expireCb; expireCb = null;
                if (cb) cb();
                return;
            }
            if (num.IsValid()) num.text = String(Math.ceil(remain));
            fill.SetHasClass("mg-tt-low", remain <= 10);
            fill.SetHasClass("mg-tt-crit", remain <= 5);
            $.Schedule(0.2, function () { tick(myGen); });
        }

        return {
            el: wrap,
            // Put the human on the clock. onExpire fires once if the bar empties first.
            start: function (onExpire) {
                if (dead) return;
                gen++;
                var myGen = gen;
                running = true;
                expireCb = onExpire || null;
                deadline = Date.now() + TURN_SECS * 1000;
                snapFull();               // reveals the fill (opacity) — the wrap is always laid out
                num.text = String(TURN_SECS);
                // Arm the CSS drain one frame later (the .mg-piece/.mg-anim arming trick): the
                // full-snap must commit first, or the browser coalesces both writes and the bar
                // jumps straight to empty with no slide.
                $.Schedule(0.0, function () { if (!dead && gen === myGen && running) arm(); });
                $.Schedule(0.2, function () { tick(myGen); });
            },
            // Take the human off the clock (they acted, or it's someone else's turn). Fades the
            // fill + blanks the seconds (the empty channel stays, keeping the footprint) and
            // cancels the pending expiry so a slow action can't fire a stale timeout.
            stop: function () {
                gen++;                     // invalidate any in-flight tick + arm
                running = false;
                expireCb = null;
                fill.RemoveClass("mg-tt-anim");
                fill.RemoveClass("mg-tt-low");
                fill.RemoveClass("mg-tt-crit");
                fill.style.transform = "translate3d(0px, 0px, 0px)";
                fill.style.opacity = "0.0";   // idle: only the empty channel shows
                if (num.IsValid()) num.text = "";
            },
            destroy: function () {
                dead = true; gen++; running = false; expireCb = null;
                try { wrap.DeleteAsync(0); } catch (e) {}
            }
        };
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
        var lastFrom = -1, lastTo = -1; // last COMPLETED move's endpoints (for the last-move wash)
        var oppSeqFrom = -1;            // first `from` of the opponent's in-progress (multi-hop) turn

        // Time control (§8 commit 2.3). session.timeControl = seconds per side (0 = untimed).
        // The clock is authoritative on the SERVER online; offline (bot) it ticks locally. seat
        // 0 = white/host, seat 1 = black/joiner — the clock indexes by seat, so map colour→seat.
        var timeControl = session.timeControl || 0;
        var clock = null;               // createClock handle, built in buildSidePanel

        // Move history + local review (§8 commit 2.2). Each finished TURN pushes one entry
        // { from, to, cap, boardAfter, label }. reviewIndex === null means "live" (board shows
        // the real position); an integer k means we are REVIEWING: -1 = initial position,
        // 0..history.length-1 = the position right after that turn. Reviewing is read-only —
        // input handlers bail while reviewing and live moves keep updating the model + list
        // silently without disturbing the shown snapshot.
        var history = [];
        var reviewIndex = null;
        // Captures accumulate across the multi-hop chain of ONE turn (a turn's label is "x" if
        // any hop in it was a capture). Reset when each side begins a fresh turn.
        var myTurnCapture = false, oppTurnCapture = false, botTurnCapture = false;

        // Premove (online only, ONE queued move): while it's the opponent's turn you may click/drag
        // your piece to a square; we remember {from,to}, glow both cells orange, and the instant the
        // opponent's move lands (turn flips to us) we try to play it. It's validated against the NEW
        // position via targetsFor — an illegal queued move (piece captured, target blocked, a forced
        // jump elsewhere) is simply discarded. preSelected holds the from-square mid-selection.
        var premove = null;            // { from, to } or null
        var preSelected = -1;          // my piece picked for a premove, awaiting a destination click

        // Drag-and-drop state (native Panorama drag; recipe proven in QOLLOCK):
        // a piece is a drag SOURCE, each cell a drop TARGET. While dragging, a throwaway
        // "ghost" panel follows the cursor and the real piece is dimmed in place.
        var dragActive = false;        // a real grab is in flight (ghost exists)
        var dragGhost = null;          // panel that follows the cursor
        var dragOverSq = -1;           // square the cursor is currently over (DragEnter / mouseover)
        var dragEnterCount = 0;        // how many DragEnter events landed this drag (is that channel alive?)
        var dragSourcePiece = null;    // the real piece being dragged (so we can un-dim it even if it's since been deleted)
        var dragFromSq = -1;           // square the current drag STARTED on (set in DragStart regardless of turn, so a drag made during the opponent's turn can queue a premove)

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
        function sfx(n) { if (MG.Sound) MG.Sound.play(n); }

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
        // Two-column game screen: the board on the left, a move-list panel on the right (the
        // modal is 900px, the board only 486px, so ~360px sit unused to its right). The columns
        // flow right; the board keeps its own centred/flow:none internals unchanged.
        var twoCol = $.CreatePanel("Panel", root, "MG_CheckersCols");
        twoCol.AddClass("mg-game-2col");
        // The board grid and the pieces overlay must OCCUPY THE SAME SPACE. Panorama has
        // no `position: absolute`; instead the wrap uses `flow-children: none` so both its
        // children stack at the top-left, and the pieces layer (added last) paints on top.
        var boardWrap = $.CreatePanel("Panel", twoCol, "MG_BoardWrap");
        boardWrap.AddClass("mg-board-wrap");
        var boardPanel = $.CreatePanel("Panel", boardWrap, "MG_Board");
        boardPanel.AddClass("mg-board");
        // Move-list side panel (right column): a header, a scrollable list of completed turns,
        // and a Prev/Next/Live navigation bar. renderMoveList() fills the list; the nav buttons
        // step a purely LOCAL review of past positions (see navPrev/navNext/navLive) — the live
        // game keeps running underneath and the model board is never touched by a review.
        var moveListRows = null, navPrevBtn = null, navNextBtn = null, navLiveBtn = null;
        (function buildSidePanel() {
            var panel = $.CreatePanel("Panel", twoCol, "MG_CheckersMoves");
            panel.AddClass("mg-movelist");
            // Clocks sit at the TOP of the side panel (opponent above, you below — see clockSeat).
            // secs=0 → the module builds nothing and every call is a no-op, so an untimed game is
            // visually unchanged. Server seat 0 = host = white; clockSeat maps that to my view.
            clock = createClock(panel, timeControl, !session.bot, code, onFlag, clockNames());
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
            var winnerColor = seat === 0 ? BLACK : WHITE;   // loser is white(0)/black(1) → winner is the other
            finish(winnerColor, "time");
        }
        function syncClockTurn() { if (clock && clock.isTimed) clock.setTurn(clockSeatFor(turn)); }
        function makeNavBtn(parent, text, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-nav-btn");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return b;
        }

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
            // The file letter is shoved HARD into the bottom-right corner: the piece is a 46px
            // circle centred in the 60px cell (radius 23 about (30,30)); the old (46,43) offset put
            // the glyph ~20px from that centre — INSIDE the circle — so the piece painted over it and
            // the letter vanished under knights/rooks/bishops (maintainer 2026-07-16: "букв не видно").
            // (51,46) lands the glyph ~32px out, clear of the circle, and still inside the 60px cell.
            var ox = kind === "file" ? (SQ - 9) : 3;
            var oy = kind === "file" ? (SQ - 14) : 2;
            lbl.style.transform = "translate3d(" + (x + ox) + "px, " + (y + oy) + "px, 0px)";
        }

        // interactive defaults to true (live board). Review renders pass false so the snapshot
        // pieces are inert (no drag/select) — you're looking at a past position, not playing it.
        function makePiece(realIdx, v, interactive) {
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
            if (interactive !== false) setupPieceInput(piece);
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
                if (destroyed || reviewIndex !== null) return; // no dragging while reviewing history
                // Allow a drag both on my turn (a real move) AND on the opponent's turn (to queue a
                // premove). Only block it when neither is possible (game over etc.).
                if (!myTurn() && !canPremove()) return;
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
                dragFromSq = sq;                  // remember where this drag began (used by the premove drop path)
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
                if (!myTurn() && canPremove()) {
                    // Dragged during the opponent's turn → queue a PREMOVE to the dropped square.
                    var pmTo = dropSquare(droppedPanel);
                    if (pmTo >= 0 && pmTo !== dragFromSq) { premove = { from: dragFromSq, to: pmTo }; preSelected = -1; }
                    clearDrag();
                    refreshHighlights();
                    return;
                }
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

        // Resolve the raw board square a drop landed on (no legal-target filter — used by the
        // premove path, which validates later against the post-opponent board). Same multi-channel
        // geometry as commitDropMultimethod: window position first, then the native drop panel.
        function dropSquare(droppedPanel) {
            var wSq = squareFromWindow();
            if (wSq >= 0) return wSq;
            var aPanel = squareFromPanel(droppedPanel);
            if (aPanel >= 0) return aPanel;
            if (dragOverSq >= 0) return dragOverSq;
            return squareFromGhost();
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
                status("DROP " + (matched >= 0 ? ("OK via " + via + "->" + matched) : "MISS") +
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
            for (var i = 0; i < 64; i++) { if (board[i]) makePiece(i, board[i]); }
        }

        // Selection + legal-target highlighting only (cheap; touches no pieces). Suppressed
        // while reviewing — renderReview() owns the cell classes then, and a live move landing
        // during a review must not repaint the board the player is studying.
        function refreshHighlights() {
            if (reviewIndex !== null) return;
            for (var i = 0; i < 64; i++) {
                var cell = cells[i];
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
            for (var t = 0; t < legalTargets.length; t++) {
                var tc = cells[legalTargets[t].to];
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

        function setNavState(btn, enabled) {
            if (!btn) return;
            if (enabled) btn.RemoveClass("mg-nav-disabled"); else btn.AddClass("mg-nav-disabled");
        }
        function updateNav() {
            var shown = (history.length === 0) ? -2 : (reviewIndex === null ? history.length - 1 : reviewIndex);
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
            for (var i = 0; i < 64; i++) { if (src[i]) makePiece(i, src[i], false); }
        }

        // Show the position after review move `idx` (idx === -1 = initial position). Read-only:
        // no selection, only that move's from/to washed. Does NOT touch the live model.
        function renderReview() {
            var idx = reviewIndex;
            var snap = (idx < 0) ? initialBoard() : history[idx].boardAfter;
            layoutPiecesFrom(snap);
            for (var i = 0; i < 64; i++) {
                var c = cells[i];
                if (!c) continue;
                c.RemoveClass("mg-sel"); c.RemoveClass("mg-target"); c.RemoveClass("mg-lastmove");
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
            if (reviewIndex === null) return;              // already live (latest)
            var t = reviewIndex + 1;
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
            // While reviewing, the pieces layer shows a past snapshot, not the live model —
            // so skip the visual (the model already advanced via applyHopFx). navLive() rebuilds
            // the current position from the model when the player returns to the live game.
            if (reviewIndex !== null) { clearDrag(); return; }
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

        // Illegal-move feedback (maintainer 2026-07-15): a wrong click/drop plays the Illegal
        // cue and, when a capture is available, briefly flashes the piece(s) that MUST jump —
        // Russian checkers forces the capture and it isn't always obvious which piece is obliged.
        // The flash is a JS-toggled class (.mg-mustcap) removed after ~0.9s; a background-color
        // transition eases the amber in/out (mg.css). Squares with a mandatory capture right now, for my colour.
        function mustCaptureSquares() {
            if (!anyCaptureFor(board, myColor)) return [];
            var out = [];
            for (var i = 0; i < 64; i++) {
                if (colorOf(board[i]) === myColor && captureMoves(board, i).length > 0) out.push(i);
            }
            return out;
        }
        var mustCapToken = 0;
        function flashMustCapture() {
            var sqs = mustCaptureSquares();
            if (sqs.length === 0) return;
            mustCapToken++;
            var tok = mustCapToken;
            for (var k = 0; k < sqs.length; k++) if (cells[sqs[k]]) cells[sqs[k]].AddClass("mg-mustcap");
            $.Schedule(0.9, function () {
                if (destroyed || tok !== mustCapToken) return;
                for (var j = 0; j < sqs.length; j++) if (cells[sqs[j]]) cells[sqs[j]].RemoveClass("mg-mustcap");
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
        // (the position will change after the opponent moves — e.g. a recapture lands on a square
        // that's still occupied by my own piece right now); the queued {from,to} is validated when
        // it's actually my turn (tryPremove) and silently dropped if it's no longer legal.
        function premoveClick(i) {
            if (colorOf(board[i]) === myColor) { preSelected = i; premove = null; refreshHighlights(); return; }
            if (preSelected >= 0 && i !== preSelected) { premove = { from: preSelected, to: i }; preSelected = -1; refreshHighlights(); return; }
            clearPremove();
        }
        // Called the instant the turn flips to me (opponent's move just landed). Replays the
        // queued premove if it's legal on the NEW board, else discards it.
        function tryPremove() {
            if (!premove) return;
            var pm = premove; premove = null; preSelected = -1;
            if (!myTurn()) { refreshHighlights(); return; }
            var tg = targetsFor(pm.from);
            for (var t = 0; t < tg.length; t++) {
                if (tg[t].to === pm.to) {
                    selected = pm.from; legalTargets = tg; refreshHighlights();
                    doLocalHop(pm.from, tg[t]);
                    return;
                }
            }
            refreshHighlights();   // premove no longer legal — just drop it
        }

        function onCellClick(i) {
            if (destroyed || reviewIndex !== null) return;
            if (!myTurn()) { if (canPremove()) premoveClick(i); return; }

            // Clicking a legal target of the currently selected piece = execute a hop.
            if (selected >= 0) {
                for (var t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalHop(selected, legalTargets[t]); return; }
                }
                // A selection is up but this square isn't one of its targets. If it's not a
                // re-select of another of my movable pieces either, it's an illegal attempt.
                if (colorOf(board[i]) !== myColor) { rejectMove(); return; }
            }
            if (chaining) { rejectMove(); return; } // during a chain only its targets are clickable

            // Otherwise (re)select one of my pieces that actually has a legal move.
            if (colorOf(board[i]) === myColor) {
                var tg = targetsFor(i);
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
            for (var t = 0; t < legalTargets.length; t++) {
                if (legalTargets[t].to === i) {
                    doLocalHop(selected, legalTargets[t]);
                    return;
                }
            }
            // Dropped on a non-target: reject (sound + forced-capture flash), keep the selection
            // so its hints stay up for a click.
            rejectMove();
        }

        var pendingHops = [];

        function doLocalHop(from, mv) {
            if (pendingHops.length === 0) myTurnCapture = false; // first hop of a fresh turn
            var res = applyHopFx(from, mv.to);
            if (res.captured) myTurnCapture = true;
            animateHop(from, mv.to, res.capIdx, res.promoted);
            sfx(res.promoted ? "Promote" : "MoveSelf");
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
            var hops = pendingHops.slice();
            pendingHops = [];
            lastFrom = hops[0].from; lastTo = hops[hops.length - 1].to; // first from, last to
            refreshHighlights();
            pushHistory(lastFrom, lastTo, myTurnCapture);
            for (var h = 0; h < hops.length; h++) hops[h].end = (h === hops.length - 1) ? 1 : 0;

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
            var botColor = (myColor === WHITE ? BLACK : WHITE);
            if (!chooseBotMovePrep) {   // older rules bundle: one-shot fallback
                var s = chooseBotMove(board, botColor);
                if (!s) { checkEnd(); return; }
                botTurnCapture = false; applyBotSeq(s, 0); return;
            }
            var driver = chooseBotMovePrep(board, botColor);
            (function drive() {
                if (destroyed || gameOver) return;
                if (!driver.done()) { driver.step(); $.Schedule(0.0, drive); return; }
                var seq = driver.result();
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
            var res = applyHopFx(seq[h].from, seq[h].to);
            if (res.captured) botTurnCapture = true;
            animateHop(seq[h].from, seq[h].to, res.capIdx, res.promoted);
            sfx(res.promoted ? "Promote" : "MoveOpp");
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
                    if (oppSeqFrom < 0) oppTurnCapture = false; // first hop of this opponent turn
                    var res = applyHopFx(mv.from, mv.to);
                    appliedSeq++;
                    animateHop(mv.from, mv.to, res.capIdx, res.promoted);
                    sfx(res.promoted ? "Promote" : "MoveOpp");
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

        // `reason` is optional: "time" when the game ended on a flag-fall (shown in the status).
        function finish(winner, reason) {
            if (gameOver) return;      // a flag-fall + a board end can race; first one wins
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            var lost = reason === "time" ? " (on time)" : "";
            status(winner === myColor ? ("🏆 You win!" + lost) : ("You lose." + lost));
            if (session.onGameOver) session.onGameOver(winner === myColor ? "win" : "lose");
        }

        // ── boot ────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
        syncClockTurn();          // white (seat 0) is on the move at the start
        sfx("GameStart");
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
            destroy: function () { destroyed = true; pollToken++; if (clock) clock.stop(); clearDrag(); try { root.DeleteAsync(0); } catch (e) {} }
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

        // Per-turn countdown (left gutter of the modal). Parented on `container` (the flow:none game
        // host) so it parks in the left margin, clear of the centred board. Runs only while it's my
        // move; on expiry I forfeit (TTT is always heads-up with a MANDATORY move — maintainer's
        // ruling: timeout = loss). Online I also fire Leave so the opponent's poll learns at once.
        // boardW = 3 cells × (104 + 2×3 margin) + 2 × 3px border = 336 → pin the timer to the
        // board's left edge (narrow centred board; the far-left modal gutter looked detached).
        var turnTimer = (MG.Widgets && MG.Widgets.createTurnTimer) ? MG.Widgets.createTurnTimer(container, { boardW: 336 }) : null;
        var timerOn = false;
        function refreshTimer() {
            if (!turnTimer) return;
            var live = myTurn();
            if (live === timerOn) return;
            timerOn = live;
            if (!live) { turnTimer.stop(); return; }
            turnTimer.start(onTimerExpire);
        }
        function onTimerExpire() {
            timerOn = false;
            if (destroyed || gameOver || !myTurn()) return;
            gameOver = true;
            if (turnTimer) turnTimer.stop();
            if (!session.bot && code) { try { if (MG.Api && MG.Api.leave) MG.Api.leave(code, session.tok); } catch (e) {} }
            status("Time expired — you lose.");
            if (session.onGameOver) session.onGameOver("lose");
        }

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
            refreshTimer();
        }

        function place(i, mark) { board[i] = mark; }

        // Evaluate terminal state; announce and freeze if the game is decided.
        function checkEnd() {
            var w = tttWinner(board);
            if (w) {
                gameOver = true;
                render(w.line);
                status(w.mark === myMark ? "🏆 You win!" : "You lose.");
                if (session.onGameOver) session.onGameOver(w.mark === myMark ? "win" : "lose");
                return true;
            }
            if (tttFull(board)) {
                gameOver = true;
                render(null);
                status("Draw.");
                if (session.onGameOver) session.onGameOver("draw");
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
            destroy: function () { destroyed = true; pollToken++; if (turnTimer) turnTimer.destroy(); try { root.DeleteAsync(0); } catch (e) {} }
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
        var selected = -1;
        var legalTargets = [];         // [{to}] — shape kept identical to checkers so the drag code is shared
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
        // seat 0 = white/host, seat 1 = black/joiner — the clock indexes by seat.
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
            clock = createClock(panel, timeControl, !session.bot, code, onFlag, clockNames());
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
        function makeNavBtn(parent, text, onClick) {
            var b = $.CreatePanel("Button", parent, "");
            b.AddClass("mg-nav-btn");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return b;
        }
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
            // glyph past the visible figure — knights/rooks/bishops no longer cover it (maintainer
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
                    if (pmTo >= 0 && pmTo !== dragFromSq) { premove = { from: dragFromSq, to: pmTo }; preSelected = -1; }
                    clearDrag();
                    refreshHighlights();
                    return;
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

        // Raw dropped square (any of 0..63) with NO legal-target filter — used to queue a premove
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
        function pushHistory(from, to, cap) {
            history.push({ from: from, to: to, boardAfter: board.slice(), label: moveLabel(from, to, cap) });
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
        function setNavState(btn, enabled) {
            if (!btn) return;
            if (enabled) btn.RemoveClass("mg-nav-disabled"); else btn.AddClass("mg-nav-disabled");
        }
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
            // While reviewing, the pieces layer shows a past snapshot — advance the MODEL only and
            // skip all visuals; navLive() rebuilds the current position from the model on return.
            if (reviewIndex !== null) {
                var wasPawnEdge = cType(board[from]) === C_PAWN && (cRow(to) === 0 || cRow(to) === 7);
                var rr = makeMove(board, cst, from, to);
                board = rr[0]; cst = rr[1];
                return { promoted: wasPawnEdge };
            }
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
            return { promoted: promoted };
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
        // Not validated now (the position changes after the opponent moves); tryPremove replays it
        // when it's actually my turn and drops it if illegal on the new board. Mirrors createCheckers.
        function canPremove() { return !gameOver && !destroyed && reviewIndex === null && !myTurn(); }
        function clearPremove() { premove = null; preSelected = -1; refreshHighlights(); }
        function premoveClick(i) {
            if (cSign(board[i]) === myColor) { preSelected = i; premove = null; refreshHighlights(); return; }
            if (preSelected >= 0 && i !== preSelected) { premove = { from: preSelected, to: i }; preSelected = -1; refreshHighlights(); return; }
            clearPremove();
        }
        function tryPremove() {
            if (!premove) return;
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
            refreshHighlights();   // premove no longer legal — just drop it
        }

        function onCellClick(i) {
            if (destroyed || reviewIndex !== null) return;
            if (!myTurn()) { if (canPremove()) premoveClick(i); return; }
            if (selected >= 0) {
                for (var t = 0; t < legalTargets.length; t++) {
                    if (legalTargets[t].to === i) { doLocalMove(selected, i); return; }
                }
                // A selection is up and this isn't one of its targets: if it's not a re-select
                // of another of my pieces, it's an illegal attempt — sound feedback (no forced
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
            sfx(inCheck(board, turn) ? "Check" : (fx.promoted ? "Promote" : "MoveSelf"));

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
        // Drive the resumable search ONE root move per frame so the HUD never freezes (the
        // "лаги при ходе бота") and a premove can be grabbed while the bot thinks. Same depth-3
        // alpha-beta, same strength — only the scheduling changed. Falls back to the one-shot
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
            sfx(inCheck(board, myColor) ? "Check" : (fx.promoted ? "Promote" : "MoveOpp"));
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

        // Server rejected our move — rebuild the position from the accepted log (which
        // encodes castling / en passant / promotion via makeMove) and resume polling.
        function rejectAndResync(reason) {
            sfx("Illegal");
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
                renderMoveList();
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
                    var oppCap = isCaptureMove(mv.from, mv.to);   // test the pre-move board
                    var fx = applyChessMove(mv.from, mv.to);
                    lastFrom = mv.from; lastTo = mv.to;
                    turn = myColor;                 // every chess move ends the turn (end always 1)
                    syncClockTurn();
                    refreshHighlights();
                    pushHistory(mv.from, mv.to, oppCap);
                    sfx(inCheck(board, myColor) ? "Check" : (fx.promoted ? "Promote" : "MoveOpp"));
                    if (!checkEnd()) { status(inCheck(board, myColor) ? "Check! Your turn." : "Your turn."); tryPremove(); }
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
        // `reason` is optional: "time" when the game ended on a flag-fall (shown in the status).
        function finish(winner, reason) {
            if (gameOver) return;      // a flag-fall + a checkmate can race; first one wins
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            var win = winner === myColor;
            var how = reason === "time" ? (win ? "🏆 Opponent flagged — you win!" : "You lose on time.")
                                        : (win ? "🏆 Checkmate — you win!" : "Checkmate — you lose.");
            status(how);
            if (session.onGameOver) session.onGameOver(win ? "win" : "lose");
        }
        function finishDraw() {
            if (gameOver) return;
            gameOver = true;
            clearSelection();
            refreshHighlights();
            if (clock) clock.stop();
            status("Stalemate — it's a draw.");
            if (session.onGameOver) session.onGameOver("draw");
        }

        // ── boot ──────────────────────────────────────────────────────────────────────
        buildCells();
        layoutPieces();
        refreshHighlights();
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
            // `short` is the compact label for the game-screen HEADER only (setTitle); the picker
            // card keeps the full `name`. TTT / Connect 4 are long enough to want a shorter header.
            { id: 2, key: "tictactoe", name: "Tic-Tac-Toe", short: "TTT", enabled: true },
            { id: 3, key: "durak", name: "Durak", enabled: false },
            { id: 4, key: "chess", name: "Chess", enabled: true },
            { id: 5, key: "connectfour", name: "Connect Four", short: "Connect 4", enabled: false },
            { id: 6, key: "poker", name: "Poker", short: "Hold'em", enabled: true },
            { id: 7, key: "soon2", name: "Coming Soon", enabled: false },
            { id: 8, key: "soon3", name: "Coming Soon", enabled: false },
            { id: 9, key: "soon4", name: "Coming Soon", enabled: false },
            { id: 10, key: "soon5", name: "Coming Soon", enabled: false },
            { id: 11, key: "soon6", name: "Coming Soon", enabled: false },
            { id: 12, key: "soon7", name: "Coming Soon", enabled: false }
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

    // Shared widget factory reused by the separate game files (mg_durak / mg_poker /
    // mg_connectfour) via MG.Widgets — they can't see this file's closure otherwise.
    MG.Widgets = MG.Widgets || {};
    MG.Widgets.createTurnTimer = createTurnTimer;
    MG.Widgets.TURN_SECS = TURN_SECS;

    // Built-in games register their factories (their bodies live above in this file).
    MG.Games.register({ id: 1, create: createCheckers });
    MG.Games.register({ id: 2, create: createTicTacToe });
    MG.Games.register({ id: 4, create: createChess });
})();
