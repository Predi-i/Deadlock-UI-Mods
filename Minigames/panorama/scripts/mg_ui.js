"use strict";

/*
 * mg_ui.js — menu shell for the Deadlock Minigames mod.
 *
 *  - Injects a "Minigames" button into the in-game escape menu (Esc), styled like the
 *    native menu items. The escape menu is created lazily, so we poll for its anchor.
 *  - Owns a full-screen overlay with the lobby flow: pick a game, Create (get a code)
 *    or Join (enter a code), then mount the game from $.MG.Games.
 *
 * Depends on mg_net.js ($.MG.Net / $.MG.Api) and mg_games.js ($.MG.Games).
 */

(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.UI) return;

    function log(m) {
        try { $.Msg("[MG.UI] " + m); } catch (e) {}
        try { if (MG.debug) MG.debug("[ui] " + m); } catch (e) {}
    }

    var overlay = null, modalBody = null, statusLabel = null, titleLabel = null;
    var view = "menu";
    var selectedGameId = 1;
    var activeGame = null;        // { destroy }
    var currentCode = 0;
    var statusPollToken = 0;

    // ── escape-menu button injection ────────────────────────────────────────
    function findAnchor() {
        var root = $.GetContextPanel();
        // climb to the very top so FindChildTraverse can reach the escape-menu subtree
        for (var i = 0; i < 40 && root && root.GetParent && root.GetParent(); i++) root = root.GetParent();
        if (!root || !root.FindChildTraverse) return null;
        // SubOptions holds Settings/Quit; fall back to the Menu container.
        return root.FindChildTraverse("SubOptions") || root.FindChildTraverse("Menu");
    }

    function ensureEscapeButton() {
        var anchor = findAnchor();
        if (!anchor) return;
        if (anchor.FindChild && anchor.FindChild("MG_EscapeButton")) return; // already there
        var existing = anchor.FindChildTraverse ? anchor.FindChildTraverse("MG_EscapeButton") : null;
        if (existing) return;

        var btn = $.CreatePanel("Button", anchor, "MG_EscapeButton");
        btn.AddClass("nav_menu_item");
        btn.AddClass("minor");
        btn.AddClass("mg-escape-button");
        var lbl = $.CreatePanel("Label", btn, "");
        lbl.AddClass("menuButtonLabel");
        lbl.text = "Minigames";
        btn.SetPanelEvent("onactivate", function () { showOverlay(); });
        // Put it near the top of the sub-options if we can.
        try { anchor.MoveChildBefore(btn, anchor.GetChild(0)); } catch (e) {}
        log("escape button injected");
    }

    function startInjectionLoop() {
        ensureEscapeButton();
        $.Schedule(1.5, startInjectionLoop);
    }

    // ── overlay construction ────────────────────────────────────────────────
    function buildOverlay() {
        if (overlay && overlay.IsValid && overlay.IsValid()) return;
        var ctx = $.GetContextPanel();
        overlay = $.CreatePanel("Panel", ctx, "MG_Overlay");
        overlay.AddClass("mg-overlay");
        overlay.style.visibility = "collapse";

        // Backdrop: blocks clicks from reaching the game behind, but does NOT close
        // on click — a misclick (e.g. missing a checker) must not kick you out.
        var dim = $.CreatePanel("Panel", overlay, "MG_Dim");
        dim.AddClass("mg-dim");

        var modal = $.CreatePanel("Panel", overlay, "MG_Modal");
        modal.AddClass("mg-modal");

        var header = $.CreatePanel("Panel", modal, "");
        header.AddClass("mg-header");
        titleLabel = $.CreatePanel("Label", header, "");
        titleLabel.AddClass("mg-title");
        titleLabel.text = "Minigames";
        var close = $.CreatePanel("Button", header, "");
        close.AddClass("mg-close");
        var closeLbl = $.CreatePanel("Label", close, "");
        closeLbl.text = "X"; // plain ASCII: the ✕ glyph isn't in the game font
        close.SetPanelEvent("onactivate", function () { hideOverlay(); });

        modalBody = $.CreatePanel("Panel", modal, "MG_Body");
        modalBody.AddClass("mg-body");

        statusLabel = $.CreatePanel("Label", modal, "MG_Status");
        statusLabel.AddClass("mg-status");
        statusLabel.text = "";
    }

    function setStatus(t) { if (statusLabel) statusLabel.text = t || ""; }
    function setTitle(t) { if (titleLabel) titleLabel.text = t; }

    function clearBody() {
        if (activeGame) { try { activeGame.destroy(); } catch (e) {} activeGame = null; }
        if (modalBody) modalBody.RemoveAndDeleteChildren();
    }

    // ── views ───────────────────────────────────────────────────────────────
    function renderMenu() {
        view = "menu";
        setTitle("Minigames");
        clearBody();
        setStatus(MG.Net.isConfigured() ? "" : "⚠ Server not configured: set BASE_URL in mg_net.js.");

        var subtitle = $.CreatePanel("Label", modalBody, "");
        subtitle.AddClass("mg-subtitle");
        subtitle.text = "Play a quick game without leaving the match.";

        var picker = $.CreatePanel("Panel", modalBody, "");
        picker.AddClass("mg-picker");
        var games = MG.Games.list;
        for (var i = 0; i < games.length; i++) {
            (function (g) {
                var card = $.CreatePanel("Button", picker, "");
                card.AddClass("mg-game-card");
                if (!g.enabled) card.AddClass("mg-disabled");
                if (g.id === selectedGameId) card.AddClass("mg-selected");
                // Inner wrapper is vertically centered, so the name (and optional "soon"
                // sublabel) stay centered whether or not the sublabel is present.
                var inner = $.CreatePanel("Panel", card, "");
                inner.AddClass("mg-game-card-inner");
                var nm = $.CreatePanel("Label", inner, "");
                nm.AddClass("mg-game-name");
                nm.text = g.name;
                if (!g.enabled) {
                    var soon = $.CreatePanel("Label", inner, "");
                    soon.AddClass("mg-game-soon");
                    soon.text = "soon";
                }
                card.SetPanelEvent("onactivate", function () {
                    if (!g.enabled) { setStatus("\"" + g.name + "\" is not available yet."); return; }
                    selectedGameId = g.id;
                    renderMenu();
                });
            })(games[i]);
        }

        // Online actions grouped on one centered row.
        var actions = $.CreatePanel("Panel", modalBody, "");
        actions.AddClass("mg-actions");

        var createBtn = $.CreatePanel("Button", actions, "");
        createBtn.AddClass("mg-btn");
        createBtn.AddClass("mg-btn-primary");
        var cl = $.CreatePanel("Label", createBtn, ""); cl.text = "Create Game";
        createBtn.SetPanelEvent("onactivate", function () { startCreate(); });

        var joinBtn = $.CreatePanel("Button", actions, "");
        joinBtn.AddClass("mg-btn");
        var jl = $.CreatePanel("Label", joinBtn, ""); jl.text = "Join";
        joinBtn.SetPanelEvent("onactivate", function () { renderJoin(); });

        // Offline play, visually separated below.
        var divider = $.CreatePanel("Label", modalBody, "");
        divider.AddClass("mg-divider");
        divider.text = "— offline —";

        var actions2 = $.CreatePanel("Panel", modalBody, "");
        actions2.AddClass("mg-actions");
        var botBtn = $.CreatePanel("Button", actions2, "");
        botBtn.AddClass("mg-btn");
        botBtn.AddClass("mg-btn-bot");
        var bl = $.CreatePanel("Label", botBtn, ""); bl.text = "Play vs Bot";
        botBtn.SetPanelEvent("onactivate", function () { startBotGame(); });
    }

    function startBotGame() {
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        // Offline: no lobby, no server. You are white (host); the bot plays black.
        log("startBotGame game=" + selectedGameId);
        renderGame(selectedGameId, 0, true, true);
    }

    function renderJoin() {
        view = "join";
        setTitle("Join Game");
        clearBody();
        setStatus("Enter your friend's lobby code.");

        var wrap = $.CreatePanel("Panel", modalBody, "");
        wrap.AddClass("mg-join-wrap");

        var entry = $.CreatePanel("TextEntry", wrap, "MG_CodeEntry");
        entry.AddClass("mg-code-entry");
        try { entry.SetAttributeString("placeholder", "0000"); } catch (e) {}
        try { entry.maxchars = 4; } catch (e) {}

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");

        var go = $.CreatePanel("Button", row, "");
        go.AddClass("mg-btn"); go.AddClass("mg-btn-primary");
        var gl = $.CreatePanel("Label", go, ""); gl.text = "Join";
        go.SetPanelEvent("onactivate", function () {
            var code = parseInt(String(entry.text || "").replace(/[^0-9]/g, ""), 10);
            if (!code || code < 1000 || code > 9999) { setStatus("The code is 4 digits."); return; }
            doJoin(code);
        });

        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Back";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });
    }

    function renderWaiting(code) {
        view = "waiting";
        setTitle("Waiting for Opponent");
        clearBody();

        var box = $.CreatePanel("Panel", modalBody, "");
        box.AddClass("mg-code-box");
        var cap = $.CreatePanel("Label", box, ""); cap.AddClass("mg-code-cap"); cap.text = "Lobby code:";
        var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = String(code);
        var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint");
        hint.text = "Share this code with your friend — they click \"Join\".";

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        var cancel = $.CreatePanel("Button", row, "");
        cancel.AddClass("mg-btn");
        var cl = $.CreatePanel("Label", cancel, ""); cl.text = "Cancel";
        cancel.SetPanelEvent("onactivate", function () { statusPollToken++; renderMenu(); });

        setStatus("Waiting for a player…");
    }

    function renderGame(gameId, code, isHost, bot) {
        view = "game";
        var g = MG.Games.byId(gameId);
        setTitle((g ? g.name : "Game") + (bot ? " (bot)" : ""));
        clearBody();

        var host = $.CreatePanel("Panel", modalBody, "");
        host.AddClass("mg-game-host");

        activeGame = MG.Games.mount(gameId, host, {
            code: code,
            isHost: isHost,
            bot: !!bot,
            onStatus: setStatus
        });

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        var leave = $.CreatePanel("Button", row, "");
        leave.AddClass("mg-btn");
        var ll = $.CreatePanel("Label", leave, ""); ll.text = "Leave";
        leave.SetPanelEvent("onactivate", function () { renderMenu(); });
    }

    // ── lobby flow ────────────────────────────────────────────────────────────
    function startCreate() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        setStatus("Creating lobby…");
        log("startCreate game=" + selectedGameId + " base=" + MG.Net.getBaseUrl());
        MG.Api.create(selectedGameId, function (code) {
            log("create ok, code=" + code);
            currentCode = code;
            renderWaiting(code);
            waitForJoiner(code);
        }, function () {
            log("create FAILED (request errored)");
            setStatus("Couldn't create lobby. Check the server.");
        });
    }

    function waitForJoiner(code) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken) return;
            MG.Api.status(code, function (st) {
                if (token !== statusPollToken) return;
                if (st.players >= 2) { renderGame(selectedGameId, code, true); return; }
                $.Schedule(1.5, tick);
            }, function () { $.Schedule(2.0, tick); });
        }
        tick();
    }

    function doJoin(code) {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        setStatus("Connecting to " + code + "…");
        MG.Api.join(code, function (res) {
            if (res.ok) { currentCode = code; renderGame(res.game, code, false); return; }
            if (res.reason === "missing") setStatus("Lobby " + code + " not found.");
            else if (res.reason === "full") setStatus("Lobby is already full.");
            else setStatus("Connection error.");
        }, function () { setStatus("Server unavailable."); });
    }

    // ── show / hide ───────────────────────────────────────────────────────────
    function showOverlay() {
        buildOverlay();
        overlay.style.visibility = "visible";
        renderMenu();
    }

    function hideOverlay() {
        statusPollToken++;
        clearBody();
        if (overlay) overlay.style.visibility = "collapse";
        view = "menu";
    }

    MG.UI = { show: showOverlay, hide: hideOverlay };

    // boot
    $.Schedule(1.0, startInjectionLoop);
    log("loaded");
})();
