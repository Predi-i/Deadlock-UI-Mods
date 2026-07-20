"use strict";

/*
 * mg_connectfour.js — "Connect Four" controller for the Deadlock Minigames mod.
 *
 * Full-information 2-player game, so it rides the EXISTING server-authoritative 2-int
 * transport unchanged: a move is a COLUMN 0..6 sent as move(code, col, 7, end=1) — the
 * fixed marker to=7 keeps from != to (like tic-tac-toe's to=9), and the SERVER derives the
 * gravity landing row and validates. The pure engine lives in rules/connectfour.js (shared
 * byte-for-byte with the worker); here we render, take input, predict + poll, and run the
 * offline bot. Self-registers game id 5 like mg_durak does.
 *
 * Board model matches the engine: Array(42), idx = row*7+col, row 0 = TOP. Values 0 empty,
 * 1 = host (red, seat 0, moves first), 2 = joiner (yellow).
 *
 * RENDERING: discs live on a single OVERLAY layer stacked over the grid (the checkers
 * .mg-board-wrap / .mg-pieces-layer idiom), positioned by transform:translate3d — NOT as
 * children of individual cells. A cell child is clipped by its own 60×60 box, which hid the
 * fall animation and made resting discs vanish (the maintainer's "no falling animation /
 * half the discs invisible" report). On the noclip overlay a disc is visible across the whole
 * column as it slides down.
 *
 * NONE of the rendering/input is verifiable from a shell — reasoned from the game's CSS
 * idioms + the checkers/ttt controllers, confirmed only after a VPK repack.
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG._c4Loaded) return;
    MG._c4Loaded = true;

    var C = MG.Rules && MG.Rules.connectfour;   // shared pure engine (rules/connectfour.js)
    var COLS = 7, ROWS = 6, CELL = 60, DISC = 50, INSET = (CELL - DISC) / 2;

    function createConnectFour(container, session) {
        var Api = MG.Api;
        var code = session.code;
        var RED = 1, YEL = 2;
        var myMark = session.isHost ? RED : YEL;    // host is red and moves first
        var board = C.initialBoard();
        var turn = RED;                              // red always opens
        var appliedSeq = 0;                          // drops consumed from the shared server log
        var pollToken = 0;
        var destroyed = false;
        var gameOver = false;

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function myTurn() { return turn === myMark && !gameOver; }

        var root = $.CreatePanel("Panel", container, "MG_C4Root");
        root.AddClass("mg-cf");

        // Per-turn countdown (left gutter of the modal). Parented on `container` (the flow:none game
        // host) so it parks in the left margin, clear of the centred plate. Runs only while it's my
        // move; on expiry I forfeit (Connect Four is always heads-up with a MANDATORY move —
        // maintainer's ruling: timeout = loss). Online I also fire Leave so the opponent learns.
        // boardW = 7 cols × 60px + 2 × 6px plate padding = 432 → the timer pins to the board's
        // left edge (narrow centred board; the far-left modal gutter looked detached).
        var turnTimer = (MG.Widgets && MG.Widgets.createTurnTimer) ? MG.Widgets.createTurnTimer(container, { boardW: 432 }) : null;
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
            status("Time expired. You lose.");
            if (session.onGameOver) session.onGameOver("lose");
        }
        // Grid + discs OVERLAY are stacked siblings under a flow-children:none wrap (checkers
        // .mg-board-wrap idiom). Discs sit on the overlay ABOVE the plate; the overlay is
        // overflow:clip and sized to the plate's inner window, so a falling disc is visible only
        // WITHIN the plate — it drops in from the top slot instead of flying above the modal (п3).
        var wrap = $.CreatePanel("Panel", root, "MG_C4Wrap");
        wrap.AddClass("mg-cf-wrap");
        var boardPanel = $.CreatePanel("Panel", wrap, "MG_C4Board");
        boardPanel.AddClass("mg-cf-board");

        // Explicit rows/cols (NOT flow-wrap, trap ARCHITECTURE §6.8). Each cell owns a click
        // that drops into its COLUMN + a hover tint; discs are placed on the overlay.
        var cells = [];       // cell index -> cell panel
        var discEls = {};     // cell index -> disc panel (persistent so we don't rebuild every render)
        (function buildCells() {
            for (var r = 0; r < ROWS; r++) {
                var rowPanel = $.CreatePanel("Panel", boardPanel, "c4_row_" + r);
                rowPanel.AddClass("mg-cf-row");
                for (var c = 0; c < COLS; c++) {
                    var i = r * COLS + c;
                    var cell = $.CreatePanel("Panel", rowPanel, "c4_cell_" + i);
                    cell.AddClass("mg-cf-cell");
                    var hole = $.CreatePanel("Panel", cell, "");   // the round "hole" the disc shows through
                    hole.AddClass("mg-cf-hole");
                    (function (col) {
                        cell.SetPanelEvent("onactivate", function () { onColClick(col); });
                    })(c);
                    cells[i] = cell;
                }
            }
        })();

        // Discs overlay: sibling ABOVE the grid, offset by the board's 6px padding (margin) so a
        // disc's translate3d(col*CELL+INSET, row*CELL+INSET) lands centred in its hole. hittest
        // off so clicks pass through to the cells below.
        var piecesLayer = $.CreatePanel("Panel", wrap, "MG_C4Pieces");
        piecesLayer.AddClass("mg-cf-pieces");
        try { piecesLayer.SetAttributeString("hittest", "false"); } catch (e) {}
        try { piecesLayer.SetAttributeString("hittestchildren", "false"); } catch (e) {}

        function discXY(i) {
            var r = (i / COLS) | 0, c = i % COLS;
            return { x: c * CELL + INSET, y: r * CELL + INSET };
        }

        // Place a disc on the OVERLAY at cell `i`. If animate, it starts one cell above the
        // plate's top edge and slides down into place. The overlay CLIPS to the plate window, so
        // the disc only becomes visible as it crosses the top slot and falls "inside" the board —
        // it is never seen above the plate or over the modal's dark windows (п3).
        //
        // ARMING (the checkers / durak .mg-anim idiom): set the OFF-SCREEN start transform (y ≈ -55,
        // one cell above the clip box), then ONE frame later add .mg-cf-anim and write the final
        // transform — the browser tweens between the two. Both writes MUST land in SEPARATE frames:
        // the earlier code did the flush + final in the SAME JS frame (reading actuallayoutheight to
        // "commit" the start), but Panorama coalesces same-frame transform writes so the disc SNAPPED
        // to final with NO fall (maintainer 2026-07-20: "ход оппонента не рендерится, фишки просто
        // спавнятся"). $.Schedule(0.0) is the fix. The old worry — that the bot's OPENING disc could
        // arm before the overlay's first layout and strand off-screen (invisible) — no longer bites:
        // botTurn is deferred $.Schedule(0.35, ...) so layout is long settled, and if the arm ever
        // fails to fire the disc still ends at its visible resting spot (never stranded off-screen).
        function placeDisc(i, mark, animate) {
            if (discEls[i]) return discEls[i];
            var disc = $.CreatePanel("Panel", piecesLayer, "");
            disc.AddClass("mg-cf-disc");
            disc.AddClass(mark === RED ? "mg-cf-red" : "mg-cf-yellow");
            discEls[i] = disc;
            var p = discXY(i);
            if (animate) {
                var startY = -CELL + INSET;   // one cell above the plate's top edge (above the clip box)
                disc.style.transform = "translate3d(" + p.x + "px, " + startY + "px, 0px)";
                $.Schedule(0.0, function () {
                    if (destroyed || !disc.IsValid()) return;
                    disc.AddClass("mg-cf-anim");
                    disc.style.transform = "translate3d(" + p.x + "px, " + p.y + "px, 0px)";
                });
            } else {
                disc.style.transform = "translate3d(" + p.x + "px, " + p.y + "px, 0px)";
            }
            return disc;
        }

        // Full rebuild of the disc layer from `board` (used on reset/resync). Clears then
        // repopulates without fall animation.
        function rebuildDiscs() {
            for (var k in discEls) if (discEls.hasOwnProperty(k)) { try { discEls[k].DeleteAsync(0); } catch (e) {} }
            discEls = {};
            for (var i = 0; i < board.length; i++) if (board[i]) placeDisc(i, board[i], false);
        }

        function clearWinHighlight() {
            for (var i = 0; i < cells.length; i++) cells[i].RemoveClass("mg-cf-win");
        }
        function highlightWin(mark) {
            var line = C.winningLine(board, mark);
            if (line) for (var k = 0; k < line.length; k++) {
                cells[line[k]].AddClass("mg-cf-win");
                if (discEls[line[k]]) discEls[line[k]].AddClass("mg-cf-win-disc");
            }
        }

        // Apply a drop into `col` for `mark`: returns the landed cell index, or -1 if the
        // column is full. Mutates `board` and drops a disc panel with a fall animation.
        function applyDrop(col, mark) {
            var row = C.dropRow(board, col);
            if (row < 0) return -1;
            var i = row * COLS + col;
            board[i] = mark;
            placeDisc(i, mark, true);
            return i;
        }

        function checkEnd() {
            var w = C.winner(board);
            if (w) {
                gameOver = true;
                highlightWin(w);
                status(w === myMark ? "🏆 You win!" : "You lose.");
                if (session.onGameOver) session.onGameOver(w === myMark ? "win" : "lose");
                return true;
            }
            if (C.isFull(board)) {
                gameOver = true;
                status("Draw.");
                if (session.onGameOver) session.onGameOver("draw");
                return true;
            }
            return false;
        }

        function onColClick(col) {
            if (destroyed || !myTurn()) return;
            if (C.dropRow(board, col) < 0) return;       // column full — ignore
            applyDrop(col, myMark);
            turn = (myMark === RED ? YEL : RED);
            refreshTimer();                              // I just acted → stop my clock
            if (session.bot) {
                if (checkEnd()) return;
                status("Bot is thinking…");
                $.Schedule(0.35, botTurn);
                return;
            }
            if (checkEnd()) { sendMove(col, 0); return; }  // still relay the winning drop
            status("Move sent. Waiting for opponent…");
            sendMove(col, 0);
        }

        // ── bot (offline) ────────────────────────────────────────────────────
        function botTurn() {
            if (destroyed || gameOver) return;
            var botMark = (myMark === RED ? YEL : RED);
            var col = C.cfBotMove(board, botMark);
            if (col < 0) { checkEnd(); return; }
            applyDrop(col, botMark);
            turn = myMark;
            if (checkEnd()) return;
            status("Your turn.");
            refreshTimer();                              // my turn opened → arm the clock
        }

        // ── relay + polling (mirrors tic-tac-toe) ────────────────────────────
        function sendMove(col, attempt) {
            if (destroyed) return;
            Api.move(code, col, 7, 1, session.tok, function (r) {
                if (r.ok) {
                    appliedSeq++;                        // our own drop is now in the shared log
                    if (!gameOver) startPolling();
                    return;
                }
                rejectAndResync(r.reason);               // server refused (full col / not our turn / bad token)
            }, function () {
                $.Schedule(0.6, function () { sendMove(col, (attempt || 0) + 1); });
            });
        }

        function rejectAndResync(reason) {
            gameOver = false;
            clearWinHighlight();
            board = C.initialBoard();
            turn = RED;
            replayAccepted(0);
        }
        function replayAccepted(seq) {
            if (destroyed) return;
            if (seq >= appliedSeq) {
                rebuildDiscs();
                refreshTimer();                          // resync settled → (re)arm or stop to match
                if (myTurn()) status("Move rejected. Resynced, your turn.");
                else { status("Move rejected. Resyncing…"); startPolling(); }
                return;
            }
            Api.poll(code, seq, function (mv) {
                if (destroyed) return;
                if (mv) {
                    var mk = (seq % 2 === 0) ? RED : YEL; // red placed the even-indexed drops
                    var row = C.dropRow(board, mv.from);
                    if (row >= 0) board[row * COLS + mv.from] = mk;
                    turn = (mk === RED ? YEL : RED);
                    replayAccepted(seq + 1);
                } else { appliedSeq = seq; replayAccepted(seq); }
            }, function () { $.Schedule(0.4, function () { replayAccepted(seq); }); },
            function (from, to) { return from >= 0 && from <= 6 && to === 7; });
        }

        function startPolling() { pollToken++; pollOnce(pollToken); }
        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken || gameOver) return;
            if (turn === myMark) return;                 // our move; nothing to poll
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    var oppMark = (myMark === RED ? YEL : RED);
                    applyDrop(mv.from, oppMark);          // from = the column the opponent dropped
                    appliedSeq++;
                    turn = myMark;
                    if (checkEnd()) return;
                    status("Your turn.");
                    refreshTimer();                       // my turn opened → arm the clock
                } else {
                    $.Schedule(0.4, function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(0.6, function () { pollOnce(myToken); });
            }, function (from, to) {
                return from >= 0 && from <= 6 && to === 7;
            });
        }

        // ── boot ─────────────────────────────────────────────────────────────
        if (myTurn()) {
            status("Your turn. You are " + (myMark === RED ? "RED." : "YELLOW."));
        } else if (session.bot) {
            status("Bot is thinking…");
            $.Schedule(0.35, botTurn);
        } else {
            status("Opponent's turn…");
            startPolling();
        }
        refreshTimer();                                  // arm if I open, else stay hidden

        return {
            destroy: function () { destroyed = true; pollToken++; if (turnTimer) turnTimer.destroy(); try { root.DeleteAsync(0); } catch (e) {} }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 5, enabled: true, create: createConnectFour });
    }
})();
