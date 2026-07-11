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

    // Route through MG.debug so nothing hits the console unless debug mode is ON.
    function log(m) {
        try { if (MG.debug) MG.debug("[ui] " + m); } catch (e) {}
    }

    var overlay = null, modalBody = null, statusLabel = null, titleLabel = null;
    // UI-scale control (dropdown left of the close X): scales the WHOLE modal — picker,
    // boards, Durak felt & cards — via pre-transform-scale2d on .mg-modal. Kept for the
    // session; the drag maths in the games are already relative so any scale is safe.
    var modalPanel = null, uiScalePct = 100, scaleMenu = null, scaleLabel = null;
    // In the MENU view the status text lives on the LEFT of the footer row (same line as the
    // dev tools) instead of on its own line below — shorter panel, and the message sits level
    // with Test Connection / Self-Test. Other views keep the centred bottom statusLabel.
    var footerStatus = null;
    var overlayShown = false;     // our modal is up (independent of the menu's own state)
    var view = "menu";
    var selectedGameId = 1;
    var activeGame = null;        // { destroy }
    var currentCode = 0;
    var currentTok = "";          // seat token for the CURRENT online game (see mg_net MG.Session)
    var statusPollToken = 0;
    var selfTestToken = 0;
    var cardEls = [];        // [{ id, panel }] — picker cards, so selection can re-skin them without a full rebuild
    var detailPanel = null;  // right-column detail container (title + description + action buttons)

    // Short blurb shown in the right-hand detail column for each game.
    // Keep each ≤ ~80 chars: .mg-detail-desc is a fixed 2-line (52px) box, so a longer blurb
    // spills onto a clipped 3rd line. The original 80-char lines are the proven envelope.
    var GAME_DESC = {
        checkers:    "Draughts with flying kings and forced jumps. Capture every enemy piece to win.",
        tictactoe:   "The classic 3×3 duel. Line up three of your marks in a row to win.",
        durak:       "The beloved Eastern European card game. Be the first to shed all your cards.",
        chess:       "The timeless game of strategy. Full rules, against a friend or the bot.",
        connectfour: "Drop your discs down the grid and be the first to line up four in a row."
    };

    // Opens the maintainer's Boosty donate page in the external browser. Proven Panorama
    // channel (same call QOLLOCK uses for its Ko-fi / Discord links) — no fetch needed.
    function openSupport() {
        try { $.DispatchEvent("ExternalBrowserGoToURL", "https://boosty.to/predi_1/donate"); }
        catch (e) { setStatus("Couldn't open the browser."); }
    }

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
        modalPanel = modal;

        var header = $.CreatePanel("Panel", modal, "");
        header.AddClass("mg-header");
        // Left cluster: the mod NAME + a small "by Predi_i" credit right beside it.
        var headerLeft = $.CreatePanel("Panel", header, "");
        headerLeft.AddClass("mg-header-left");
        titleLabel = $.CreatePanel("Label", headerLeft, "");
        titleLabel.AddClass("mg-title");
        titleLabel.text = "Minigames";
        var credit = $.CreatePanel("Button", headerLeft, "");
        credit.AddClass("mg-header-credit");
        var creditLbl = $.CreatePanel("Label", credit, ""); creditLbl.text = "by Predi_i";
        credit.SetPanelEvent("onactivate", function () { openSupport(); });
        // Support pill sits just right of the credit (thumbsup icon + label) → Boosty.
        var supportBtn = $.CreatePanel("Button", headerLeft, "");
        supportBtn.AddClass("mg-support-btn");
        var sIcon = $.CreatePanel("Panel", supportBtn, "");
        sIcon.AddClass("mg-support-icon");   // background-image = icon_thumbsup.vsvg (CSS)
        var sLbl = $.CreatePanel("Label", supportBtn, ""); sLbl.AddClass("mg-support-label"); sLbl.text = "Support";
        supportBtn.SetPanelEvent("onactivate", function () { openSupport(); });
        // UI-scale dropdown sits between the header's flexible left cluster and the close X.
        buildScaleControl(header);
        // Close button, pushed to the far right by the header's flow.
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
        applyUiScale();
    }

    function setStatus(t) {
        // In the menu, the footer carries the status inline (left of the dev tools); keep the
        // separate bottom line empty AND collapsed so it reserves no height. Elsewhere the
        // centred bottom line is used and shown.
        if (footerStatus && footerStatus.IsValid && footerStatus.IsValid()) {
            footerStatus.text = t || "";
            if (statusLabel) { statusLabel.text = ""; statusLabel.style.visibility = "collapse"; }
            return;
        }
        if (statusLabel) {
            statusLabel.text = t || "";
            statusLabel.style.visibility = (t ? "visible" : "collapse");
        }
    }
    function setTitle(t) { if (titleLabel) titleLabel.text = t; }

    // ── UI-scale dropdown ─────────────────────────────────────────────────────
    // A tiny custom dropdown (button + popup list) — a native <DropDown> is fragile in the
    // HUD context, and panels + onactivate are the proven idiom. The wrapper is
    // flow-children:none so the popup can overlap the body below (overlap idiom, §6.1), NOT
    // position:absolute (which Panorama ignores).
    var SCALE_STEPS = [100, 125, 150, 175, 200];
    function buildScaleControl(parent) {
        var wrap = $.CreatePanel("Panel", parent, "MG_ScaleWrap");
        wrap.AddClass("mg-scale");
        var btn = $.CreatePanel("Button", wrap, "MG_ScaleBtn");
        btn.AddClass("mg-scale-btn");
        scaleLabel = $.CreatePanel("Label", btn, "");
        scaleLabel.AddClass("mg-scale-label");
        scaleLabel.text = uiScalePct + "%";
        var caret = $.CreatePanel("Label", btn, "");
        caret.AddClass("mg-scale-caret");
        caret.text = "v";                                   // plain ASCII: no chevron glyph in the font
        var menu = $.CreatePanel("Panel", wrap, "MG_ScaleMenu");
        menu.AddClass("mg-scale-menu");
        menu.style.visibility = "collapse";
        scaleMenu = menu;
        for (var i = 0; i < SCALE_STEPS.length; i++) {
            (function (pct) {
                var row = $.CreatePanel("Button", menu, "");
                row.AddClass("mg-scale-opt");
                var l = $.CreatePanel("Label", row, ""); l.text = pct + "%";
                row.SetPanelEvent("onactivate", function () { setUiScale(pct); hideScaleMenu(); });
            })(SCALE_STEPS[i]);
        }
        btn.SetPanelEvent("onactivate", function () {
            var open = scaleMenu && scaleMenu.BHasClass && scaleMenu.BHasClass("mg-scale-open");
            if (open) hideScaleMenu(); else showScaleMenu();
        });
    }
    function showScaleMenu() { if (scaleMenu) { scaleMenu.style.visibility = "visible"; scaleMenu.AddClass("mg-scale-open"); } }
    function hideScaleMenu() { if (scaleMenu) { scaleMenu.style.visibility = "collapse"; scaleMenu.RemoveClass("mg-scale-open"); } }
    function setUiScale(pct) {
        uiScalePct = pct;
        if (scaleLabel) scaleLabel.text = pct + "%";
        applyUiScale();
    }
    // pre-transform-scale2d scales the modal in place (around its centre) AFTER layout, so the
    // full-screen dim behind it stays put. Every child (board/cards) scales with it.
    function applyUiScale() {
        if (modalPanel && modalPanel.IsValid && modalPanel.IsValid()) {
            try { modalPanel.style.preTransformScale2d = (uiScalePct / 100).toFixed(3); } catch (e) {}
        }
    }

    function cleanupCurrentView(cancelServer) {
        // Stop any background polling and drop pending requests from the queue
        statusPollToken++;
        selfTestToken++;
        if (MG.Net && MG.Net.clearQueue) try { MG.Net.clearQueue(); } catch (e) {}
        
        // Only cancel the server lobby if the player explicitly left or closed the menu
        if (cancelServer && currentCode && (view === "waiting" || view === "room" || view === "game")) {
            try { MG.Api.cancel(currentCode, currentTok); } catch (e) {}

        }
        
        // Destroy active game if any
        if (activeGame) { 
            try { activeGame.destroy(); } catch (e) {} 
            activeGame = null; 
        }
    }

    function clearBody() {
        // footerStatus is a child of modalBody's footer, so it's about to be deleted — drop the
        // reference so setStatus falls back to the centred bottom line until the menu rebuilds it.
        footerStatus = null;
        if (modalBody) modalBody.RemoveAndDeleteChildren();
    }

    // ── card art ────────────────────────────────────────────────────────────
    // Each picker card's motif is a compiled .vtex image set as the art panel's
    // background (see renderMenu). The maintainer draws these; PNG→VTEX is compiled
    // externally into panorama/images/cards/<key>.vtex. The old pure-panel motifs
    // (mini board / X-O / card fan) were removed in favour of real card art.

    // ── views ───────────────────────────────────────────────────────────────
    // The lobby is a two-column layout: LEFT is the game picker grid, RIGHT is the
    // detail + action panel for whichever card is selected. Selecting a card only
    // re-skins the cards and rebuilds the right column (renderDetail) — no full
    // teardown — so the pick feels instant and the right side can fade between games.
    function renderMenu() {
        cleanupCurrentView(true);
        view = "menu";
        setTitle("Minigames");
        clearBody();

        var cols = $.CreatePanel("Panel", modalBody, "");
        cols.AddClass("mg-columns");

        // ── LEFT: picker grid ──
        var left = $.CreatePanel("Panel", cols, "");
        left.AddClass("mg-col-left");
        var picker = $.CreatePanel("Panel", left, "");
        picker.AddClass("mg-picker");

        cardEls = [];
        var games = MG.Games.list;
        for (var i = 0; i < games.length; i++) {
            (function (g) {
                var card = $.CreatePanel("Button", picker, "");
                card.AddClass("mg-game-card");
                if (!g.enabled) card.AddClass("mg-disabled");
                if (g.id === selectedGameId) card.AddClass("mg-selected");
                // Card = motif art layer (fills the card) with a name plate overlaid at the
                // bottom. flow-children:none stacks them; the plate's bottom gradient keeps
                // the name legible over the art.
                var art = $.CreatePanel("Panel", card, "");
                art.AddClass("mg-card-art");
                // Custom card image (compiled .vtex). soon1-4 have no art → plain bg.
                if (g.key.indexOf("soon") !== 0)
                    art.style.backgroundImage = "url('s2r://panorama/images/cards/" + g.key + ".vtex')";

                var bar = $.CreatePanel("Panel", card, "");
                bar.AddClass("mg-card-namebar");
                var nm = $.CreatePanel("Label", bar, "");
                nm.AddClass("mg-game-name");
                nm.text = g.name;
                if (!g.enabled) {
                    // A centred plate over the dimmed art reads as "locked" far better
                    // than the old tiny yellow "coming soon" line under the name.
                    var lock = $.CreatePanel("Panel", card, "");
                    lock.AddClass("mg-lock-badge");
                    var ll = $.CreatePanel("Label", lock, "");
                    ll.text = "IN DEVELOPMENT";
                }
                card.SetPanelEvent("onactivate", function () { selectGame(g.id); });
                cardEls.push({ id: g.id, panel: card });
            })(games[i]);
        }

        // ── RIGHT: detail + actions for the selected game ──
        var right = $.CreatePanel("Panel", cols, "");
        right.AddClass("mg-col-right");
        detailPanel = $.CreatePanel("Panel", right, "");
        detailPanel.AddClass("mg-detail");
        renderDetail();

        // ── FOOTER: status (left) + discreet tools (right) ──
        buildFooter();
        // Now that footerStatus exists, route the initial message into it (or clear it).
        setStatus(MG.Net.isConfigured() ? "" : "⚠ Server not configured: set BASE_URL in mg_net.js.");
    }

    // Re-skin the cards for the new selection and rebuild the right column. No full
    // renderMenu() so the left grid doesn't flicker on every pick.
    function selectGame(id) {
        if (id === selectedGameId) return;
        selectedGameId = id;
        for (var i = 0; i < cardEls.length; i++) {
            if (cardEls[i].id === id) cardEls[i].panel.AddClass("mg-selected");
            else cardEls[i].panel.RemoveClass("mg-selected");
        }
        renderDetail();
    }

    // Right column: game title + blurb, then either the action buttons (enabled
    // game) or a "locked" notice (disabled placeholder). Fades in on each switch.
    function renderDetail() {
        if (!detailPanel) return;
        detailPanel.RemoveAndDeleteChildren();
        var g = MG.Games.byId(selectedGameId);
        if (!g) return;

        var title = $.CreatePanel("Label", detailPanel, "");
        title.AddClass("mg-detail-title");
        title.text = g.name;

        var desc = $.CreatePanel("Label", detailPanel, "");
        desc.AddClass("mg-detail-desc");
        desc.text = GAME_DESC[g.key] || "";

        if (!g.enabled) {
            var locked = $.CreatePanel("Label", detailPanel, "");
            locked.AddClass("mg-detail-locked");
            locked.text = "IN DEVELOPMENT";
            var lockedSub = $.CreatePanel("Label", detailPanel, "");
            lockedSub.AddClass("mg-detail-locked-sub");
            lockedSub.text = "This game isn't playable yet. Pick another to start.";
            fadeInDetail();
            return;
        }

        // Durak online is wired for 2 players only for now. 3–4-player seating/throw-in UI is
        // deliberately deferred; the normal Create/Join/Quick buttons enter a 2-seat room.
        var onlineReady = true;

        if (onlineReady) {
            // Primary: one-button public matchmaking. Wrapped in a .mg-btn-row so it uses
            // fill-parent-flow width, NOT width:100% — the latter makes Panorama clip the button's
            // right border (the PLAY VS BOT / QUICK MATCH "no right border" bug). Same structure as
            // the working CREATE/JOIN row.
            var quickRow = $.CreatePanel("Panel", detailPanel, "");
            quickRow.AddClass("mg-btn-row");
            var quickBtn = $.CreatePanel("Button", quickRow, "");
            quickBtn.AddClass("mg-btn"); quickBtn.AddClass("mg-btn-primary"); quickBtn.AddClass("mg-btn-quick"); quickBtn.AddClass("mg-btn-solo");
            var ql = $.CreatePanel("Label", quickBtn, ""); ql.text = "QUICK MATCH";
            quickBtn.SetPanelEvent("onactivate", function () { startQuickMatch(); });
            var quickCap = $.CreatePanel("Label", detailPanel, "");
            quickCap.AddClass("mg-caption");
            quickCap.text = "Public match against anyone online.";

            // Secondary: private match with a friend via a shared code.
            var friendLbl = $.CreatePanel("Label", detailPanel, "");
            friendLbl.AddClass("mg-section-label");
            friendLbl.text = "Play with a friend";
            var friendRow = $.CreatePanel("Panel", detailPanel, "");
            friendRow.AddClass("mg-btn-row");
            var createBtn = $.CreatePanel("Button", friendRow, "");
            createBtn.AddClass("mg-btn");
            var cl = $.CreatePanel("Label", createBtn, ""); cl.text = "CREATE";
            createBtn.SetPanelEvent("onactivate", function () { startCreate(); });
            var joinBtn = $.CreatePanel("Button", friendRow, "");
            joinBtn.AddClass("mg-btn"); joinBtn.AddClass("mg-btn-2nd");
            var jl = $.CreatePanel("Label", joinBtn, ""); jl.text = "JOIN";
            joinBtn.SetPanelEvent("onactivate", function () { renderJoin(); });
        }

        // Offline practice vs the bot.
        var practiceLbl = $.CreatePanel("Label", detailPanel, "");
        practiceLbl.AddClass("mg-section-label");
        practiceLbl.text = "Practice";
        // Wrapped in a row for the same fill-parent-flow-vs-width:100% reason as QUICK MATCH.
        var botRow = $.CreatePanel("Panel", detailPanel, "");
        botRow.AddClass("mg-btn-row");
        var botBtn = $.CreatePanel("Button", botRow, "");
        botBtn.AddClass("mg-btn"); botBtn.AddClass("mg-btn-solo");
        var bl = $.CreatePanel("Label", botBtn, ""); bl.text = "PLAY VS BOT";
        botBtn.SetPanelEvent("onactivate", function () { startBotGame(); });

        if (g.key === "durak") {
            var durakNote = $.CreatePanel("Label", detailPanel, "");
            durakNote.AddClass("mg-caption");
            durakNote.text = "Online Durak is 2-player now; 3–4 players are deferred.";
        }

        fadeInDetail();
    }

    // Nudge opacity 0→1 one frame after the rebuild so the column fades in on each
    // pick. Same one-frame-delay trick the pieces use to arm their transition.
    function fadeInDetail() {
        if (!detailPanel) return;
        detailPanel.style.opacity = "0.0";
        $.Schedule(0.0, function () {
            if (detailPanel && detailPanel.IsValid && detailPanel.IsValid()) detailPanel.style.opacity = "1.0";
        });
    }

    // Footer: the dev tools (connection test / self-test / debug log) live here as
    // small, low-contrast text links so they no longer compete with the play buttons.
    // A Support link sits at the far right. (Tools get hidden wholesale near release.)
    // Footer: only the discreet dev tools now (Support moved up to the header). The Debug
    // toggle no longer spawns an on-screen panel — it just routes logs to the dev console.
    function buildFooter() {
        var footer = $.CreatePanel("Panel", modalBody, "");
        footer.AddClass("mg-footer");

        // Status text on the LEFT of the footer, level with the dev tools (п2). Replaces the
        // old separate line under the footer, so the bottom strip is one row shorter.
        footerStatus = $.CreatePanel("Label", footer, "");
        footerStatus.AddClass("mg-footer-status");
        footerStatus.text = "";

        // spacer takes the slack so the tools sit at the right edge
        var spacer = $.CreatePanel("Panel", footer, "");
        spacer.AddClass("mg-footer-spacer");

        var tools = $.CreatePanel("Panel", footer, "");
        tools.AddClass("mg-tools");

        function mkTool(text, onClick) {
            var b = $.CreatePanel("Button", tools, "");
            b.AddClass("mg-tool");
            var l = $.CreatePanel("Label", b, ""); l.text = text;
            b.SetPanelEvent("onactivate", onClick);
            return l;
        }

        mkTool("Test Connection", function () {
            if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first."); return; }
            setStatus("Pinging server…");
            MG.Api.ping(function (ms) {
                setStatus("✅ Ping: " + ms + "ms. Connection is working!");
            }, function () {
                setStatus("❌ Ping failed. Server unreachable.");
            });
        });
        mkTool("Self-Test", function () { runSelfTest(); });
        // Debug toggle: flips console logging on/off (no on-screen panel anymore).
        function dbgText() { return MG.Net.isDebug && MG.Net.isDebug() ? "Debug: ON" : "Debug: OFF"; }
        var dbgLbl = mkTool(dbgText(), function () {
            if (!MG.Net.setDebug) return;
            MG.Net.setDebug(!MG.Net.isDebug());
            dbgLbl.text = dbgText();
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

        // Two tokens: this one client fills both seats to drive the full protocol solo.
        var hostTok = MG.Session.newToken(), joinTok = MG.Session.newToken();
        // A legal white checkers opener: (5,0)->(4,1) = squares 40 -> 33.
        var mFrom = 40, mTo = 33;
        step(1, "ping…");
        MG.Api.ping(function (ms) {
            if (!alive()) return;
            step(2, "creating a test lobby…");
            MG.Api.create(1, hostTok, function (code) {
                if (!alive()) return;
                // Always tidy up the test lobby, pass or fail.
                function cleanup() { try { MG.Api.cancel(code, hostTok); } catch (e) {} }

                step(3, "reading lobby status…");
                MG.Api.status(code, function (st) {
                    if (!alive()) return;
                    if (st.gone || st.players !== 1) { cleanup(); fail("status (got " + st.players + " players, expected 1)"); return; }
                    step(4, "joining own lobby…");
                    MG.Api.join(code, joinTok, function (res) {
                        if (!alive()) return;
                        if (!res.ok || res.game !== 1) { cleanup(); fail("join (" + (res.reason || "game=" + res.game) + ")"); return; }
                        step(5, "relaying a test move…");
                        // White (host seat) plays first; authorise with the host token.
                        MG.Api.move(code, mFrom, mTo, 1, hostTok, function (r) {
                            if (!alive()) return;
                            if (!r.ok) { cleanup(); fail("move (rejected: " + r.reason + ")"); return; }
                            step(6, "polling the move back…");
                            MG.Api.poll(code, 0, function (mv) {
                                cleanup();
                                if (!alive()) return;
                                if (mv && mv.from === mFrom && mv.to === mTo && mv.end === 1) {
                                    setStatus("✅ Self-test passed: lobby, join, authorised move & poll all work. Ping " + ms + "ms.");
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

    // Bot games alternate your side each time so you don't always open as white/X.
    // Even count → you're host (white/X, move first); odd → joiner (black/O, bot opens).
    var botGamesStarted = 0;

    function startBotGame() {
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        var iAmHost = (botGamesStarted % 2) === 0;
        botGamesStarted++;
        log("startBotGame game=" + selectedGameId + " iAmHost=" + iAmHost);
        renderGame(selectedGameId, 0, iAmHost, true);
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
            hint.text = "Share this code with your friend, then they click Join.";
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

    function renderGame(gameId, code, isHost, bot, opts) {
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
            tok: currentTok,          // seat token: authorises this client's moves (unused offline)
            seat: opts && opts.seat,
            numPlayers: opts && opts.numPlayers,
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
    function isDurakOnlineGame(id) { return id === 3; }

    function startCreate() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        setStatus("Creating lobby…");
        currentTok = MG.Session.newToken();   // one seat token for this whole game
        log("startCreate game=" + selectedGameId + " base=" + MG.Net.getBaseUrl());
        MG.Api.create(selectedGameId, currentTok, function (code) {
            log("create ok, code=" + code);
            currentCode = code;
            if (isDurakOnlineGame(selectedGameId)) { renderRoom(code, true, false); return; }
            renderWaiting(code);
            waitForJoiner(code);
        }, function () {
            log("create FAILED (request errored)");
            setStatus("Couldn't create lobby. Check the server.");
        });
    }

    function renderRoom(code, isHost, isPublic) {
        cleanupCurrentView(false);
        view = "room";
        setTitle(isHost ? "Durak Room" : "Joined Durak Room");
        clearBody();
        currentCode = code;

        if (isPublic) {
            var searching = $.CreatePanel("Label", modalBody, "");
            searching.AddClass("mg-searching");
            searching.text = isHost ? "Waiting for a Durak opponent…" : "Matched. Waiting for host start…";
        } else {
            var box = $.CreatePanel("Panel", modalBody, "");
            box.AddClass("mg-code-box");
            var cap = $.CreatePanel("Label", box, ""); cap.AddClass("mg-code-cap"); cap.text = "Durak lobby code:";
            var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = String(code);
            var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint");
            hint.text = "2-player online Durak. Host starts after the second player joins.";
        }

        var seats = $.CreatePanel("Panel", modalBody, "");
        seats.AddClass("mg-room-seats");
        var seat0 = $.CreatePanel("Label", seats, ""); seat0.AddClass("mg-room-seat"); seat0.text = isHost ? "Seat 1: You (host)" : "Seat 1: Host";
        var seat1 = $.CreatePanel("Label", seats, ""); seat1.AddClass("mg-room-seat"); seat1.text = isHost ? "Seat 2: Waiting…" : "Seat 2: You";

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        if (isHost) {
            var start = $.CreatePanel("Button", row, "");
            start.AddClass("mg-btn"); start.AddClass("mg-btn-primary");
            var sl = $.CreatePanel("Label", start, ""); sl.text = "Start";
            start.SetPanelEvent("onactivate", function () {
                setStatus("Starting Durak…");
                MG.Api.start(code, currentTok, function (r) {
                    if (r.ok) { renderGame(3, code, true, false, { seat: 0, numPlayers: 2 }); return; }
                    if (r.reason === "players") setStatus("Need a second player before starting.");
                    else if (r.reason === "host") setStatus("Only the host can start.");
                    else setStatus("Couldn't start Durak (" + (r.reason || "error") + ").");
                }, function () { setStatus("Server unavailable."); });
            });
        }
        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Cancel";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });

        setStatus(isHost ? "Waiting for player 2…" : "Waiting for host to start…");
        pollDurakRoom(code, isHost, seat1);
    }

    function pollDurakRoom(code, isHost, seat1Label) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken || view !== "room") return;
            MG.Api.room(code, function (r) {
                if (token !== statusPollToken || view !== "room") return;
                if (r.gone) { renderMenu(); setStatus("⚠ Lobby closed."); return; }
                if (seat1Label && seat1Label.IsValid && seat1Label.IsValid()) {
                    seat1Label.text = isHost ? (r.players >= 2 ? "Seat 2: Player joined" : "Seat 2: Waiting…") : "Seat 2: You";
                }
                if (r.started) { renderGame(3, code, isHost, false, { seat: isHost ? 0 : 1, numPlayers: 2 }); return; }
                if (isHost) setStatus(r.players >= 2 ? "Player 2 joined. Press Start." : "Waiting for player 2…");
                else setStatus("Waiting for host to start…");
                $.Schedule(1.0, tick);
            }, function () { $.Schedule(1.5, tick); });
        }
        tick();
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
        currentTok = MG.Session.newToken();
        log("startQuickMatch game=" + selectedGameId);
        MG.Api.quick(selectedGameId, currentTok, function (res) {
            if (res.role === "joiner") {
                log("quick joined, code=" + res.code);
                currentCode = res.code;
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, false, true); return; }
                renderGame(selectedGameId, res.code, false); // seated by the server; we play black
            } else {
                log("quick hosting, code=" + res.code);
                currentCode = res.code;
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, true, true); return; }
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
        currentTok = MG.Session.newToken();
        MG.Api.join(code, currentTok, function (res) {
            if (res.ok) {
                // The game id must decode to a real, playable game — mounting a
                // disabled stub would leave the host playing against a ghost.
                var g = MG.Games.byId(res.game);
                if (!g || !g.enabled) { setStatus("Couldn't read the lobby. Please try again."); return; }
                currentCode = code;
                if (res.game === 3) { renderRoom(code, false, false); return; }
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
