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
    var overlayShown = false;     // our modal is up (independent of the menu's own state)
    var view = "menu";
    var selectedGameId = 1;
    var activeGame = null;        // { destroy }
    var currentCode = 0;
    var statusPollToken = 0;
    var selfTestToken = 0;

    // ── escape-menu button injection ────────────────────────────────────────
    function topRoot() {
        var root = $.GetContextPanel();
        // climb to the very top so FindChildTraverse can reach the escape-menu subtree
        for (var i = 0; i < 40 && root && root.GetParent && root.GetParent(); i++) root = root.GetParent();
        return root;
    }
    function findAnchor() {
        var root = topRoot();
        if (!root || !root.FindChildTraverse) return null;
        // SubOptions holds Settings/Quit; fall back to the Menu container.
        return root.FindChildTraverse("SubOptions") || root.FindChildTraverse("Menu");
    }

    // The native escape menu panel (id="EscapeMenu", type CitadelHudEscapeMenu). It
    // always exists in hud.xml; ".ShowEscapeMenu" is toggled on an ancestor to open it.
    function findEscapeMenu() {
        var root = topRoot();
        return root && root.FindChildTraverse ? root.FindChildTraverse("EscapeMenu") : null;
    }
    function isEscapeOpen() {
        var p = findEscapeMenu();
        for (var i = 0; i < 40 && p; i++) {
            if (p.BHasClass && p.BHasClass("ShowEscapeMenu")) return true;
            p = p.GetParent ? p.GetParent() : null;
        }
        return false;
    }
    // #EscapeBackground is a full-screen click-catcher with onactivate=CitadelResumePlaying().
    // Our overlay lives in a separate HUD tree and can't reliably sit above it for input,
    // so a misclick over the game area closed the menu. Disable its hit-testing while our
    // modal is open, restore it when we're done.
    function setEscapeBackgroundActive(active) {
        var root = topRoot();
        var bg = root && root.FindChildTraverse ? root.FindChildTraverse("EscapeBackground") : null;
        if (bg) { try { bg.SetAttributeString("hittest", active ? "true" : "false"); } catch (e) {} }
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
        // Leave it appended (bottom of the list); CSS lifts it up and out of the way of
        // the native items — forcing it to the top made it overlap "Swap Hero".
        log("escape button injected");
    }

    function startInjectionLoop() {
        ensureEscapeButton();
        $.Schedule(1.5, startInjectionLoop);
    }

    // ── overlay construction ────────────────────────────────────────────────
    function buildOverlay() {
        if (overlay && overlay.IsValid && overlay.IsValid()) return;
        // Must stay in OUR panel context: mg.css is loaded via base_hud.xml, so panels
        // created under the native #EscapeMenu (a different XML context) render unstyled.
        var ctx = $.GetContextPanel();
        overlay = $.CreatePanel("Panel", ctx, "MG_Overlay");
        overlay.AddClass("mg-overlay");
        overlay.style.visibility = "collapse";

        // Backdrop: blocks clicks from reaching the game behind, but does NOT close
        // on click — a misclick (e.g. missing a checker) must not kick you out. The
        // no-op onactivate makes the panel explicitly consume the click so it can't
        // fall through to the menu's EscapeBackground (which would resume/close).
        var dim = $.CreatePanel("Panel", overlay, "MG_Dim");
        dim.AddClass("mg-dim");
        dim.SetPanelEvent("onactivate", function () { });

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

    function cleanupCurrentView(cancelServer) {
        // Stop any background polling and drop pending requests from the queue
        statusPollToken++;
        selfTestToken++;
        if (MG.Net && MG.Net.clearQueue) try { MG.Net.clearQueue(); } catch (e) {}
        
        // Only cancel the server lobby if the player explicitly left or closed the menu
        if (cancelServer && currentCode && (view === "waiting" || view === "game")) {
            try { MG.Api.cancel(currentCode); } catch (e) {}
        }
        
        // Destroy active game if any
        if (activeGame) { 
            try { activeGame.destroy(); } catch (e) {} 
            activeGame = null; 
        }
    }

    function clearBody() {
        if (modalBody) modalBody.RemoveAndDeleteChildren();
    }

    // ── views ───────────────────────────────────────────────────────────────
    function renderMenu() {
        cleanupCurrentView(true);
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

        // ── Public: one-button quick match against anyone. ──
        var pubRow = $.CreatePanel("Panel", modalBody, "");
        pubRow.AddClass("mg-actions");
        var quickBtn = $.CreatePanel("Button", pubRow, "");
        quickBtn.AddClass("mg-btn");
        quickBtn.AddClass("mg-btn-primary");
        quickBtn.AddClass("mg-btn-quick");
        var ql = $.CreatePanel("Label", quickBtn, ""); ql.text = "Quick Match";
        quickBtn.SetPanelEvent("onactivate", function () { startQuickMatch(); });

        var pubCap = $.CreatePanel("Label", modalBody, "");
        pubCap.AddClass("mg-caption");
        pubCap.text = "public — get matched with anyone online";

        // ── Private: play with a friend using a shared code. ──
        var friendDiv = $.CreatePanel("Label", modalBody, "");
        friendDiv.AddClass("mg-divider");
        friendDiv.text = "— or play with a friend —";

        var actions = $.CreatePanel("Panel", modalBody, "");
        actions.AddClass("mg-actions");

        var createBtn = $.CreatePanel("Button", actions, "");
        createBtn.AddClass("mg-btn");
        var cl = $.CreatePanel("Label", createBtn, ""); cl.text = "Create Game";
        createBtn.SetPanelEvent("onactivate", function () { startCreate(); });

        var joinBtn = $.CreatePanel("Button", actions, "");
        joinBtn.AddClass("mg-btn");
        var jl = $.CreatePanel("Label", joinBtn, ""); jl.text = "Join";
        joinBtn.SetPanelEvent("onactivate", function () { renderJoin(); });

        // ── Offline: vs bot. ──
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

        // ── Tools: connection tester, online self-test, debug log toggle ──
        var toolsDiv = $.CreatePanel("Label", modalBody, "");
        toolsDiv.AddClass("mg-divider");
        toolsDiv.text = "— tools —";

        var toolsRow = $.CreatePanel("Panel", modalBody, "");
        toolsRow.AddClass("mg-actions");

        var pingBtn = $.CreatePanel("Button", toolsRow, "");
        pingBtn.AddClass("mg-btn");
        pingBtn.AddClass("mg-btn-bot"); // Reuse the dark green bot styling for tools
        var plbl = $.CreatePanel("Label", pingBtn, "");
        plbl.text = "Test Connection";
        pingBtn.SetPanelEvent("onactivate", function () {
            if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first."); return; }
            setStatus("Pinging server…");
            MG.Api.ping(function (ms) {
                setStatus("✅ Ping: " + ms + "ms. Connection is working!");
            }, function () {
                setStatus("❌ Ping failed — server unreachable.");
            });
        });

        var stBtn = $.CreatePanel("Button", toolsRow, "");
        stBtn.AddClass("mg-btn");
        stBtn.AddClass("mg-btn-bot");
        var stlbl = $.CreatePanel("Label", stBtn, "");
        stlbl.text = "Self-Test";
        stBtn.SetPanelEvent("onactivate", function () { runSelfTest(); });

        var dbgBtn = $.CreatePanel("Button", toolsRow, "");
        dbgBtn.AddClass("mg-btn");
        dbgBtn.AddClass("mg-btn-bot");
        var dbglbl = $.CreatePanel("Label", dbgBtn, "");
        function dbgText() { return MG.Net.isDebug && MG.Net.isDebug() ? "Hide Debug Log" : "Debug Log"; }
        dbglbl.text = dbgText();
        dbgBtn.SetPanelEvent("onactivate", function () {
            if (!MG.Net.setDebug) return;
            MG.Net.setDebug(!MG.Net.isDebug());
            dbglbl.text = dbgText();
        });
    }

    // ── online self-test ──────────────────────────────────────────────────────
    // Exercises the full lobby protocol against the REAL server from one client:
    // ping → create → status → join own lobby → move → poll the move back → cancel.
    // Verifies exactly the paths a two-player game uses, no second person needed.
    // (Actual gameplay can be tested offline via Play vs Bot.)
    function runSelfTest() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first."); return; }
        var t = ++selfTestToken;
        function alive() { return t === selfTestToken; }
        function fail(what) { if (alive()) setStatus("❌ Self-test failed at: " + what); }
        function step(n, what) { if (alive()) setStatus("Self-test " + n + "/6: " + what); }

        step(1, "ping…");
        MG.Api.ping(function (ms) {
            if (!alive()) return;
            step(2, "creating a test lobby…");
            MG.Api.create(1, function (code) {
                if (!alive()) return;
                // Always tidy up the test lobby, pass or fail.
                function cleanup() { try { MG.Api.cancel(code); } catch (e) {} }
                step(3, "reading lobby status…");
                MG.Api.status(code, function (st) {
                    if (!alive()) return;
                    if (st.gone || st.players !== 1) { cleanup(); fail("status (got " + st.players + " players, expected 1)"); return; }
                    step(4, "joining own lobby…");
                    MG.Api.join(code, function (res) {
                        if (!alive()) return;
                        if (!res.ok || res.game !== 1) { cleanup(); fail("join (" + (res.reason || "game=" + res.game) + ")"); return; }
                        step(5, "relaying a test move…");
                        MG.Api.move(code, 8, 17, 1, function (ok) {
                            if (!alive()) return;
                            if (!ok) { cleanup(); fail("move (rejected)"); return; }
                            step(6, "polling the move back…");
                            MG.Api.poll(code, 0, function (mv) {
                                cleanup();
                                if (!alive()) return;
                                if (mv && mv.from === 8 && mv.to === 17 && mv.end === 1) {
                                    setStatus("✅ Self-test passed — lobby, join, move & poll all work. Ping " + ms + "ms.");
                                } else {
                                    fail("poll (move came back wrong)");
                                }
                            }, function () { cleanup(); fail("poll (no response)"); });
                        }, function () { cleanup(); fail("move (no response)"); });
                    }, function () { cleanup(); fail("join (no response)"); });
                }, function () { cleanup(); fail("status (no response)"); });
            }, function () { fail("create (server unreachable or bad decode)"); });
        }, function () { fail("ping (server unreachable)"); });
    }

    function startBotGame() {
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        // Offline: no lobby, no server. You are white (host); the bot plays black.
        log("startBotGame game=" + selectedGameId);
        renderGame(selectedGameId, 0, true, true);
    }

    function renderJoin() {
        cleanupCurrentView(true);
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

    function renderWaiting(code, isPublic) {
        cleanupCurrentView(false);
        view = "waiting";
        setTitle(isPublic ? "Finding a Match" : "Waiting for Opponent");
        clearBody();

        if (isPublic) {
            // Public: no code to share — the server pairs us with whoever comes next.
            var searching = $.CreatePanel("Label", modalBody, "");
            searching.AddClass("mg-searching");
            searching.text = "Looking for an opponent…";
        } else {
            var box = $.CreatePanel("Panel", modalBody, "");
            box.AddClass("mg-code-box");
            var cap = $.CreatePanel("Label", box, ""); cap.AddClass("mg-code-cap"); cap.text = "Lobby code:";
            var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = String(code);
            var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint");
            hint.text = "Share this code with your friend — they click \"Join\".";
        }

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        var cancel = $.CreatePanel("Button", row, "");
        cancel.AddClass("mg-btn");
        var cl = $.CreatePanel("Label", cancel, ""); cl.text = "Cancel";
        cancel.SetPanelEvent("onactivate", function () {
            // cleanupCurrentView() inside renderMenu() will handle the cancellation
            renderMenu();
        });

        setStatus(isPublic ? "Searching for an opponent…" : "Waiting for a player…");
    }

    function renderGame(gameId, code, isHost, bot) {
        cleanupCurrentView(false);
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
                if (st.players === 2) { renderGame(selectedGameId, code, true); return; }
                $.Schedule(1.5, tick);
            }, function () { $.Schedule(2.0, tick); });
        }
        tick();
    }

    function startQuickMatch() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        setStatus("Finding a match…");
        log("startQuickMatch game=" + selectedGameId);
        MG.Api.quick(selectedGameId, function (res) {
            if (res.role === "joiner") {
                log("quick joined, code=" + res.code);
                currentCode = res.code;
                renderGame(selectedGameId, res.code, false); // seated by the server; we play black
            } else {
                log("quick hosting, code=" + res.code);
                currentCode = res.code;
                renderWaiting(res.code, true);
                waitForJoiner(res.code);
            }
        }, function () {
            log("quick FAILED (request errored)");
            setStatus("Couldn't reach matchmaking. Check the server.");
        });
    }

    function doJoin(code) {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        setStatus("Connecting to " + code + "…");
        MG.Api.join(code, function (res) {
            if (res.ok) {
                // The game id must decode to a real, playable game — mounting a
                // disabled stub would leave the host playing against a ghost.
                var g = MG.Games.byId(res.game);
                if (!g || !g.enabled) { setStatus("Couldn't read the lobby — please try again."); return; }
                currentCode = code;
                renderGame(res.game, code, false);
                return;
            }
            if (res.reason === "missing") setStatus("Lobby " + code + " not found.");
            else if (res.reason === "full") setStatus("Lobby is already full.");
            else setStatus("Connection error.");
        }, function () { setStatus("Server unavailable."); });
    }

    // ── show / hide ───────────────────────────────────────────────────────────
    function showOverlay() {
        buildOverlay();
        overlay.style.visibility = "visible";
        overlayShown = true;
        setEscapeBackgroundActive(false); // stop the menu's backdrop from closing on a misclick
        renderMenu();
    }

    function hideOverlay() {
        cleanupCurrentView(true);
        clearBody();
        if (overlay) overlay.style.visibility = "collapse";
        overlayShown = false;
        setEscapeBackgroundActive(true);  // restore normal click-to-resume behavior
        view = "menu";
    }

    // The escape menu can close under us (Esc / Resume / clicking a native item).
    // Nothing notifies us, and our overlay — now a child of #EscapeMenu — would
    // otherwise linger (hittest-active, only faded by opacity) over the game. Poll the
    // menu's open state and tear our modal down the moment the menu is gone.
    function watchEscape() {
        if (overlayShown && !isEscapeOpen()) {
            log("escape menu closed — hiding overlay");
            hideOverlay();
        }
        $.Schedule(0.3, watchEscape);
    }

    function kickToMenu(reason) {
        if (view !== "game" && view !== "waiting") return;
        log("kicked to menu: " + reason);
        currentCode = 0; // Prevent sending cancel back to the server
        renderMenu();
        if (reason) setStatus("⚠ " + reason);
    }

    MG.UI = { show: showOverlay, hide: hideOverlay, kickToMenu: kickToMenu };

    // boot
    $.Schedule(1.0, startInjectionLoop);
    $.Schedule(1.0, watchEscape);
    log("loaded");
})();
