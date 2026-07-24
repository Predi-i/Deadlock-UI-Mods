"use strict";

/*
 * mg_ttt.js — Tic-Tac-Toe CONTROLLER for the Deadlock Minigames mod.
 *
 * Split out of mg_games.js (2026-07-24). The pure rules live in rules/ttt.js (shared
 * byte-for-byte with the authoritative worker). Wire format reuses the checkers move
 * transport: a placement in cell 0..8 is sent as move(code, cell, 9, end=1). to=9 is a
 * fixed non-cell marker so from!=to always holds and validation is trivial. Board is
 * Array(9) (0 empty, 1 = X, 2 = O). Host plays X and moves first. Marks are panel-drawn
 * (fonts lack ✕/◯ glyphs — see ARCHITECTURE trap 6).
 *
 * Self-registers game id 2 like mg_durak / mg_connectfour / mg_poker. Loads AFTER
 * mg_games.js so MG.Rules.ttt, MG.Widgets.createTurnTimer and the MG.Games registry exist.
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG._tttLoaded) return;
    MG._tttLoaded = true;

    // Alias the shared pure engine (rules/ttt.js, loaded first) to the same local names the
    // old inline copy used, so the controller body below is byte-for-byte unchanged.
    var RT = MG.Rules.ttt;
    var tttWinner = RT.tttWinner, tttFull = RT.tttFull, tttBotMove = RT.tttBotMove;

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
        var pollMisses = 0;            // consecutive empty polls this turn (drives the adaptive cadence)
        var destroyed = false;
        var gameOver = false;

        function status(t) { if (session.onStatus) session.onStatus(t); }
        function sfx(n) { if (MG.Sound) MG.Sound.play(n); }
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
            status("Time expired. You lose.");
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
                sfx("GameEnd");
                status(w.mark === myMark ? "🏆 You win!" : "You lose.");
                if (session.onGameOver) session.onGameOver(w.mark === myMark ? "win" : "lose");
                return true;
            }
            if (tttFull(board)) {
                gameOver = true;
                render(null);
                sfx("GameEnd");
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
                if (myTurn()) status("Move rejected. Resynced, your turn.");
                else { status("Move rejected. Resyncing…"); startPolling(); }
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
            pollMisses = 0;              // fresh wait → poll fast again (see MG.Net.pollDelay)
            pollOnce(pollToken);
        }

        function pollOnce(myToken) {
            if (destroyed || myToken !== pollToken || gameOver) return;
            if (turn === myMark) return; // our move; nothing to poll
            Api.poll(code, appliedSeq, function (mv) {
                if (destroyed || myToken !== pollToken) return;
                if (mv) {
                    pollMisses = 0;
                    var oppMark = (myMark === X ? O : X);
                    if (!board[mv.from]) place(mv.from, oppMark); // from = the cell played
                    appliedSeq++;
                    turn = myMark;
                    render(null);
                    if (checkEnd()) return;
                    status("Your turn.");
                } else {
                    $.Schedule(MG.Net.pollDelay(pollMisses++), function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(MG.Net.pollDelay(pollMisses++), function () { pollOnce(myToken); });
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

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 2, create: createTicTacToe });
    }
})();
