"use strict";

/*
 * mg_games.js — game logic + rendering for the Deadlock Minigames mod.
 *
 * Currently ships online Checkers (English draughts rules: men move/capture forward
 * only, non-flying kings, forced capture, multi-jump). Tic-tac-toe and Durak are
 * registered as disabled placeholders in the picker.
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

    // Movement directions for a piece value: men forward only, kings all four.
    function moveDirs(v) {
        if (v === 1) return [[-1, -1], [-1, 1]];             // white man up
        if (v === 3) return [[1, -1], [1, 1]];              // black man down
        return [[-1, -1], [-1, 1], [1, -1], [1, 1]];        // king
    }

    function simpleMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var r = rowOf(i), c = colOf(i), dirs = moveDirs(v), out = [];
        for (var k = 0; k < dirs.length; k++) {
            var nr = r + dirs[k][0], nc = c + dirs[k][1];
            if (inBounds(nr, nc) && b[idx(nr, nc)] === 0) out.push({ to: idx(nr, nc) });
        }
        return out;
    }

    function captureMoves(b, i) {
        var v = b[i]; if (!v) return [];
        var color = colorOf(v), r = rowOf(i), c = colOf(i), dirs = moveDirs(v), out = [];
        for (var k = 0; k < dirs.length; k++) {
            var mr = r + dirs[k][0], mc = c + dirs[k][1];       // enemy square
            var lr = r + 2 * dirs[k][0], lc = c + 2 * dirs[k][1]; // landing square
            if (!inBounds(lr, lc)) continue;
            if (b[idx(lr, lc)] !== 0) continue;
            if (isEnemy(b[idx(mr, mc)], color)) out.push({ to: idx(lr, lc), cap: idx(mr, mc) });
        }
        return out;
    }

    function anyCaptureFor(b, color) {
        for (var i = 0; i < 64; i++) {
            if (colorOf(b[i]) === color && captureMoves(b, i).length > 0) return true;
        }
        return false;
    }

    // Apply a single hop in place. Returns {captured, promoted}.
    function applyHop(b, from, to) {
        var v = b[from];
        b[from] = 0;
        var captured = false;
        if (Math.abs(rowOf(to) - rowOf(from)) === 2) {
            var mid = idx((rowOf(from) + rowOf(to)) / 2, (colOf(from) + colOf(to)) / 2);
            b[mid] = 0;
            captured = true;
        }
        var promoted = false;
        if (v === 1 && rowOf(to) === 0) { v = 2; promoted = true; }
        else if (v === 3 && rowOf(to) === 7) { v = 4; promoted = true; }
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
            var val = isKing(v) ? 18 : 10;
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

        function status(t) { if (session.onStatus) session.onStatus(t); }

        // Display transform: black sees the board rotated 180° so its pieces sit at the bottom.
        function toDisplay(i) { return myColor === WHITE ? i : 63 - i; }
        function fromDisplay(i) { return myColor === WHITE ? i : 63 - i; }

        var root = $.CreatePanel("Panel", container, "MG_CheckersRoot");
        root.AddClass("mg-checkers");
        var boardPanel = $.CreatePanel("Panel", root, "MG_Board");
        boardPanel.AddClass("mg-board");

        var cells = [];
        function buildCells() {
            boardPanel.RemoveAndDeleteChildren();
            cells = [];
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
                    })(i);
                    cells[i] = cell;
                }
            }
        }

        function render() {
            for (var i = 0; i < 64; i++) {
                var cell = cells[i];
                if (!cell) continue;
                cell.RemoveClass("mg-sel");
                cell.RemoveClass("mg-target");
                cell.RemoveAndDeleteChildren();
                var v = board[i];
                if (v) {
                    var piece = $.CreatePanel("Panel", cell, "");
                    piece.AddClass("mg-piece");
                    piece.AddClass(colorOf(v) === WHITE ? "mg-white" : "mg-black");
                    if (isKing(v)) piece.AddClass("mg-king");
                }
            }
            if (selected >= 0) cells[selected].AddClass("mg-sel");
            for (var t = 0; t < legalTargets.length; t++) {
                var tc = cells[legalTargets[t].to];
                if (tc) tc.AddClass("mg-target");
            }
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
                if (tg.length === 0) { status("Эта шашка не может ходить."); return; }
                selected = i;
                legalTargets = tg;
                render();
            }
        }

        var pendingHops = [];

        function doLocalHop(from, mv) {
            var res = applyHop(board, from, mv.to);
            pendingHops.push({ from: from, to: mv.to });

            // Can the same piece keep jumping? (only after a capture, and not if just crowned)
            var more = res.captured && !res.promoted && captureMoves(board, mv.to).length > 0;
            if (more) {
                chaining = true;
                selected = mv.to;
                legalTargets = captureMoves(board, mv.to);
                render();
                status("Продолжайте взятие!");
                return;
            }

            // Turn complete — mark last hop as turn-ending and relay the whole sequence.
            chaining = false;
            clearSelection();
            render();
            var hops = pendingHops.slice();
            pendingHops = [];
            for (var h = 0; h < hops.length; h++) hops[h].end = (h === hops.length - 1) ? 1 : 0;

            turn = (myColor === WHITE ? BLACK : WHITE); // hand off locally right away

            if (session.bot) {
                checkEnd();
                if (!gameOver) { status("Ход бота…"); scheduleBotTurn(); }
                return;
            }
            status("Ход отправлен. Ждём соперника…");
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
                if (!gameOver) status("Ваш ход.");
                return;
            }
            applyHop(board, seq[h].from, seq[h].to);
            render();
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
                    applyHop(board, mv.from, mv.to);
                    appliedSeq++;
                    render();
                    if (mv.end) {
                        turn = myColor;
                        checkEnd();
                        if (!gameOver) status("Ваш ход.");
                        return; // stop polling; wait for player input
                    }
                    $.Schedule(0.05, function () { pollOnce(myToken); }); // drain chain fast
                } else {
                    $.Schedule(0.4, function () { pollOnce(myToken); });
                }
            }, function () {
                $.Schedule(0.6, function () { pollOnce(myToken); });
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
            render();
            status(winner === myColor ? "🏆 Вы победили!" : "Вы проиграли.");
        }

        // ── boot ────────────────────────────────────────────────────────────
        buildCells();
        render();
        if (myTurn()) status("Ваш ход. Вы играете " + (myColor === WHITE ? "белыми (снизу)." : "чёрными (снизу)."));
        else { status("Ход соперника…"); startPolling(); }

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
        l.text = (name || "Эта игра") + " — скоро.";
        return { destroy: function () { try { root.DeleteAsync(0); } catch (e) {} } };
    }

    MG.Games = {
        list: [
            { id: 1, key: "checkers", name: "Шашки", enabled: true },
            { id: 2, key: "tictactoe", name: "Крестики-нолики", enabled: false },
            { id: 3, key: "durak", name: "Дурак", enabled: false }
        ],
        byId: function (id) {
            var l = this.list;
            for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
            return null;
        },
        mount: function (gameId, container, session) {
            if (gameId === 1) return createCheckers(container, session);
            var g = this.byId(gameId);
            return createStub(container, session, g ? g.name : null);
        }
    };
})();
