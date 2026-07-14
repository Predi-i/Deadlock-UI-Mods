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
    // boards, Durak felt & cards — via the `ui-scale` LAYOUT-scale on .mg-modal (crisp re-layout,
    // NOT the blurry pre-transform raster; see applyUiScale). Kept for the session; the drag maths
    // in the games are already relative so any scale is safe.
    var modalPanel = null, uiScalePct = 100, scaleDropdown = null;
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
    // Quick Match "Select Multiple": when ON, the right panel shows a checkbox list over the
    // multi-capable games and ONE Quick Match button that searches all ticked games at once
    // (server /api/mquick pairs on set intersection). Durak is excluded (it needs its own room
    // flow). State persists across card selection so the mode stays put while browsing.
    var multiSelect = false;
    var multiChecked = {};   // { gameId: true } — games ticked for the multi-search
    // Games that can be TICKED in Select-Multiple. Durak (3) is included so it can be picked
    // too (maintainer). Public mquick still can't pair durak — its online path is a room — so
    // ticking durak alone falls back to its Create/room flow; ticked alongside others it's just
    // highlighted and the server matches the non-durak games.
    var MULTI_GAME_IDS = [1, 2, 3, 4, 5];

    function isMultiGame(id) { for (var i = 0; i < MULTI_GAME_IDS.length; i++) if (MULTI_GAME_IDS[i] === id) return true; return false; }


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

    // Opens the community Discord invite in the external browser (same proven channel as
    // openSupport — no fetch in Panorama).
    function openDiscord() {
        try { $.DispatchEvent("ExternalBrowserGoToURL", "https://discord.gg/vY9PEAWHuh"); }
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
        lbl.text = "DL Arcade";
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
        titleLabel.text = "DL Arcade";
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
        // Discord pill sits just right of Support — same shape, Discord blurple palette. The
        // logo is a .vtex (raster), so it MUST be drawn by a child <Image> (setFace), NOT a
        // Panel background-image: a raster background paints at native px until relayout (the
        // ~300% first-frame zoom). The .vsvg thumbsup on Support is a vector and doesn't suffer
        // it, but this logo would.
        var discordBtn = $.CreatePanel("Button", headerLeft, "");
        discordBtn.AddClass("mg-discord-btn");
        var dIcon = $.CreatePanel("Panel", discordBtn, "");
        dIcon.AddClass("mg-discord-icon");
        setFace(dIcon, "s2r://panorama/images/discord_logo.vtex");
        var dLbl = $.CreatePanel("Label", discordBtn, ""); dLbl.AddClass("mg-discord-label"); dLbl.text = "Discord";
        discordBtn.SetPanelEvent("onactivate", function () { openDiscord(); });
        // Flexible spacer: eats the row's slack so the two right controls flow to the far right edge.
        // (horizontal-align:right is IGNORED on a child of a flow-children:right parent — the controls
        // just flow in a row and stay stuck next to the left cluster. A fill-parent-flow spacer is the
        // reliable way to push them right, mirroring the footer's status+spacer+tools layout.)
        var headerSpacer = $.CreatePanel("Panel", header, "");
        headerSpacer.AddClass("mg-header-spacer");
        // ⚠ RIGHT CONTROLS: scale dropdown (in a fixed 80px WRAPPER), then close X — both in flow.
        // The WRAPPER is the fix for the vanishing X: the native DropDown reports the game's base
        // width:352px as its PREFERRED size (citadel_base_styles.css); as a direct flow child that
        // phantom 352 advanced the cursor and shoved the trailing X off the modal's clipped edge
        // (ARCHITECTURE trap 15b). Boxed in an 80px `min/max-width` wrapper, the DropDown's flow
        // footprint is a fixed 80px, so the X flows right after it and stays on-screen. The X keeps a
        // higher z-index so the native widget can never paint over it (the "на месте крестика
        // дропдаун" symptom). Order: dropdown then X, so the X is the rightmost control.
        var scaleWrap = $.CreatePanel("Panel", header, "");
        scaleWrap.AddClass("mg-scale-wrap");
        buildScaleControl(scaleWrap);
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

    // ── UI-scale control (NATIVE DropDown, QOLLOCK Default-Hero recipe) ────────
    // Uses the game's own `DropDown` widget — the SAME control QOLLOCK ships for "Default Hero".
    // Earlier custom button+popup attempts never reliably opened in this HUD context; the native
    // widget opens itself (the engine toggles the popup's `DropDownMenuVisible` class on click)
    // and its popup is auto-created at the panel-context root with id `<dropdownId>DropDownMenu`.
    //
    // The two things that bit the previous native attempt, both fixed here:
    //   • "…" instead of the current %: the DropDown shows a CLONE of the SELECTED option Label.
    //     If SetSelected is never called with a VALID option-panel id, it renders the "…"
    //     placeholder. So each option Label is created with a unique id and we SetSelected the
    //     one matching uiScalePct.
    //   • paper-tile popup texture: killed in CSS by `background-image:none` on BOTH the control
    //     (`.mg-scale-dd`) AND the popup `#MG_ScaleDropDownMenu` + its Labels (mg.css).
    // Fixed width (set in CSS) so the close X keeps its place in the right cluster.
    var SCALE_STEPS = [100, 125, 150, 175, 200];
    var SCALE_DD_ID = "MG_ScaleDropDown";        // popup auto-id = SCALE_DD_ID + "DropDownMenu"
    function buildScaleControl(parent) {
        var dd = $.CreatePanel("DropDown", parent, SCALE_DD_ID);
        dd.AddClass("mg-scale-dd");
        scaleDropdown = dd;
        var selectedId = "";
        for (var i = 0; i < SCALE_STEPS.length; i++) {
            var pct = SCALE_STEPS[i];
            var optId = "MG_Scale_" + pct;
            var opt = $.CreatePanel("Label", dd, optId);
            opt.AddClass("mg-scale-opt");
            opt.text = pct + "%";
            dd.AddOption(opt);
            if (pct === uiScalePct) selectedId = optId;
        }
        // SetSelected wants the option-panel ID (NOT an index) — this is what puts the real
        // "100%" in the closed control instead of the "…" placeholder.
        try { dd.SetSelected(selectedId || ("MG_Scale_" + SCALE_STEPS[0])); } catch (e) {}
        // The engine fires oninputsubmit when the user picks an option. Read the % from the
        // selected option's id (the numeric suffix), apply it.
        dd.SetPanelEvent("oninputsubmit", function () {
            var sel = null;
            try { sel = dd.GetSelected ? dd.GetSelected() : null; } catch (e) {}
            if (!sel) return;
            var pctNum = parseInt(String(sel.id || "").replace("MG_Scale_", ""), 10);
            if (isFinite(pctNum) && pctNum > 0) setUiScale(pctNum);
        });
    }
    function setUiScale(pct) {
        uiScalePct = pct;
        applyUiScale();
    }


    // ⚠ SCALE with `ui-scale`, NOT `pre-transform-scale2d`. pre-transform-scale2d is a member of
    // the TRANSFORM family — it runs AFTER layout and stretches the panel's already-rendered
    // texture, so text and .vtex art blow up as a blurry bitmap when scaled >100% (the "растровое
    // мыло" the maintainer saw). `ui-scale` scales at the LAYOUT level: the modal is re-laid-out at
    // the new size and fonts/vectors/.vtex are re-rasterised crisply. This is the game's own idiom
    // for sizing text UI — CitadelButton.Large/Medium/Small/XSmall are just ui-scale 125/100/80/65%
    // (citadel_base_styles.css) — and QOLLOCK sets it from JS the same way (panel.style.uiScale).
    // The full-screen dim (#MG_Dim) is a separate sibling, and the modal stays centre-aligned in the
    // overlay, so growing the modal's layout box keeps it centred. Drag maths read window px and
    // divide by the rendered layer width, so the scale cancels either way (unchanged from before).
    function applyUiScale() {
        if (modalPanel && modalPanel.IsValid && modalPanel.IsValid()) {
            try { modalPanel.style.uiScale = uiScalePct + "%"; } catch (e) {}
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
    // Each picker card's motif is a compiled .vtex image drawn by a CHILD <Image> panel
    // (see renderMenu). The maintainer draws these; PNG→VTEX is compiled externally into
    // panorama/images/cards/<key>.vtex. The old pure-panel motifs (mini board / X-O /
    // card fan) were removed in favour of real card art.
    //
    // ⚠ We use an <Image> panel (SetImage + scaling), NOT Panel+style.backgroundImage.
    // A Panel background paints the .vtex at its NATIVE pixel size until the panel is
    // re-laid-out (hover = restyle = relayout), which is the ~300% first-frame zoom the
    // maintainer kept seeing. An <Image> sizes to its CSS box from frame 1 — the game's
    // own idiom (hud_ability_icon.xml, QOLLOCK ArcadeFlappyBird). SetImage wants the BARE
    // s2r:// url, never a url('…') wrapper.
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

    // ── views ───────────────────────────────────────────────────────────────
    // The lobby is a two-column layout: LEFT is the game picker grid, RIGHT is the
    // detail + action panel for whichever card is selected. Selecting a card only
    // re-skins the cards and rebuilds the right column (renderDetail) — no full
    // teardown — so the pick feels instant and the right side can fade between games.
    function renderMenu() {
        cleanupCurrentView(true);
        view = "menu";
        setTitle("DL Arcade");
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
                    setFace(art, "s2r://panorama/images/cards/" + g.key + ".vtex");

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
                // Click: in multi-select mode a multi-capable, enabled card TOGGLES its ticked
                // state (shown by the card's own accent highlight — no corner badge, per the
                // maintainer); otherwise it just selects the card.
                card.SetPanelEvent("onactivate", function () {
                    if (multiSelect && isMultiGame(g.id) && g.enabled) {
                        multiChecked[g.id] = !multiChecked[g.id];
                        if (g.id !== selectedGameId) selectGame(g.id); else renderDetail();
                        updateCardSkins();
                    } else {
                        selectGame(g.id);
                    }
                });
                cardEls.push({ id: g.id, panel: card });

            })(games[i]);
        }
        updateCardSkins();


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

        // "Select multiple games" toggle — ALWAYS visible (even on durak), a single check.
        // When ON, you TICK games directly on the LEFT picker (a corner check); Quick Match
        // searches the whole ticked set and Create picks a random one from it. Durak can't
        // join a multi-quick (its own room flow) so it's never ticked, but the toggle stays.
        var toggleRow = $.CreatePanel("Panel", detailPanel, "");
        toggleRow.AddClass("mg-multi-toggle-row");
        var toggle = $.CreatePanel("Button", toggleRow, "");
        toggle.AddClass("mg-multi-toggle");
        if (multiSelect) toggle.AddClass("mg-on");
        var tBox = $.CreatePanel("Panel", toggle, ""); tBox.AddClass("mg-check-box");
        if (multiSelect) { var tMark = $.CreatePanel("Label", tBox, ""); tMark.AddClass("mg-check-mark"); tMark.text = "x"; }
        var tLbl = $.CreatePanel("Label", toggle, ""); tLbl.AddClass("mg-multi-toggle-label");
        tLbl.text = "Select multiple games";
        toggle.SetPanelEvent("onactivate", function () {
            multiSelect = !multiSelect;
            if (multiSelect) {
                // Seed the ticked set with the current game if it's multi-capable and nothing
                // is ticked yet, so the button is usable immediately.
                var any = false;
                for (var k in multiChecked) { if (multiChecked[k]) { any = true; break; } }
                if (!any && isMultiGame(selectedGameId)) multiChecked[selectedGameId] = true;
            }
            updateCardSkins();     // reflect tick badges on the left picker
            renderDetail();
        });

        if (multiSelect) {
            renderMultiPanel();    // count + Quick Match(set) + Create(random) on the right
        } else if (onlineReady) {
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

        if (!multiSelect) {
            // Offline practice vs the bot (single-game mode only).
            var practiceLbl = $.CreatePanel("Label", detailPanel, "");
            practiceLbl.AddClass("mg-section-label");
            practiceLbl.text = "Practice";
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

    // ── multi-select quick match ──────────────────────────────────────────────
    // Reflect the ticked set on the LEFT picker: a ticked multi-capable game gets the accent
    // highlight (.mg-ticked). NO corner badge — the maintainer didn't want the round tick.
    // Called after every toggle.
    function updateCardSkins() {
        for (var i = 0; i < cardEls.length; i++) {
            var ce = cardEls[i];
            var on = multiSelect && isMultiGame(ce.id) && !!multiChecked[ce.id];
            if (on) ce.panel.AddClass("mg-ticked"); else ce.panel.RemoveClass("mg-ticked");
        }
    }



    // Right panel when Select-Multiple is ON: a hint, then QUICK MATCH (searches the whole
    // ticked set) and CREATE (a private lobby in ONE randomly-picked ticked game). Games are
    // ticked on the LEFT picker, so there's no checkbox list here — just the count + actions.
    function renderMultiPanel() {
        var ids = multiCheckedIds();
        var n = ids.length;

        var hint = $.CreatePanel("Label", detailPanel, "");
        hint.AddClass("mg-caption");
        hint.text = n > 0
            ? ("Tick games on the left. Searching " + n + ": " + multiCheckedNames().join(", ") + ".")
            : "Tick one or more games on the left to search.";

        var quickRow = $.CreatePanel("Panel", detailPanel, "");
        quickRow.AddClass("mg-btn-row");
        var quickBtn = $.CreatePanel("Button", quickRow, "");
        quickBtn.AddClass("mg-btn"); quickBtn.AddClass("mg-btn-primary"); quickBtn.AddClass("mg-btn-quick"); quickBtn.AddClass("mg-btn-solo");
        if (n === 0) quickBtn.AddClass("mg-btn-disabled");
        var ql = $.CreatePanel("Label", quickBtn, ""); ql.text = n > 0 ? ("QUICK MATCH (" + n + ")") : "PICK AT LEAST ONE";
        quickBtn.SetPanelEvent("onactivate", function () { startMultiQuick(); });
        var quickCap = $.CreatePanel("Label", detailPanel, "");
        quickCap.AddClass("mg-caption");
        quickCap.text = "Public match in any of the ticked games.";

        // Create a private lobby in a RANDOM ticked game (maintainer: "if you press create
        // with several selected, just a random one is picked").
        var friendLbl = $.CreatePanel("Label", detailPanel, "");
        friendLbl.AddClass("mg-section-label");
        friendLbl.text = "Play with a friend";
        var friendRow = $.CreatePanel("Panel", detailPanel, "");
        friendRow.AddClass("mg-btn-row");
        var createBtn = $.CreatePanel("Button", friendRow, "");
        createBtn.AddClass("mg-btn"); createBtn.AddClass("mg-btn-solo");
        if (n === 0) createBtn.AddClass("mg-btn-disabled");
        var cl = $.CreatePanel("Label", createBtn, ""); cl.text = "CREATE (RANDOM)";
        createBtn.SetPanelEvent("onactivate", function () { startCreateRandom(); });
    }

    function multiCheckedNames() {
        var ids = multiCheckedIds(), out = [];
        for (var i = 0; i < ids.length; i++) { var mg = MG.Games.byId(ids[i]); if (mg) out.push(mg.name); }
        return out;
    }

    // Create a private lobby in ONE randomly-chosen ticked game, then run the normal
    // single-game waiting flow (the lobby is a fixed game, so Join/host work unchanged).
    function startCreateRandom() {
        var ids = multiCheckedIds();
        if (ids.length === 0) { setStatus("Tick at least one game to create."); return; }
        var pick = ids[Math.floor(Math.random() * ids.length)];
        selectedGameId = pick;                 // the create flow uses selectedGameId
        setStatus("Creating a " + (MG.Games.byId(pick) || {}).name + " lobby…");
        startCreate();
    }

    function multiCheckedIds() {

        var ids = [];
        for (var i = 0; i < MULTI_GAME_IDS.length; i++) {
            var id = MULTI_GAME_IDS[i];
            var mg = MG.Games.byId(id);
            if (multiChecked[id] && mg && mg.enabled) ids.push(id);
        }
        return ids;
    }
    function multiCheckedCount() { return multiCheckedIds().length; }

    function startMultiQuick() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var ids = multiCheckedIds();
        if (ids.length === 0) { setStatus("Tick at least one game to search."); return; }
        setStatus("Finding a match…");
        currentTok = MG.Session.newToken();
        log("startMultiQuick games=" + ids.join(","));
        MG.Api.mquick(ids, currentTok, function (res) {
            currentCode = res.code;
            if (res.role === "joiner") {
                // We were paired instantly; the server FIXED the game. Resolve it via status,
                // then mount as the joiner (seat 1). A short searching view covers the lookup.
                log("mquick joined, code=" + res.code);
                renderWaiting(res.code, true);
                waitForMultiMatch(res.code, false);
            } else {
                log("mquick hosting, code=" + res.code);
                renderWaiting(res.code, true);
                waitForMultiMatch(res.code, true);
            }
        }, function (why) {
            log("mquick FAILED (" + why + ")");
            setStatus(why === "games" ? "Pick at least one valid game." : "Couldn't reach matchmaking. Check the server.");
        });
    }

    // Poll status until the lobby fills AND the game is fixed (game > 0). Works for both
    // roles: a HOST waits for a joiner to arrive and pick the game; a JOINER already
    // triggered the fix, so its first tick resolves. Then mount that game.
    function waitForMultiMatch(code, isHost) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken) return;
            MG.Api.status(code, function (st) {
                if (token !== statusPollToken) return;
                if (st.gone) { renderMenu(); setStatus("⚠ Lobby closed."); return; }
                if (st.players === 2 && st.game > 0) {
                    renderGame(st.game, code, isHost);
                    return;
                }
                $.Schedule(1.5, tick);
            }, function () { $.Schedule(2.0, tick); });
        }
        tick();
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
