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
    var rematchGen = 0;           // our view of the online lobby's rematch generation (0 = fresh)
    var rematchPollToken = 0;     // guards the rematch poll loop, like statusPollToken
    var selfTestToken = 0;
    var cardEls = [];        // [{ id, panel }] — picker cards, so selection can re-skin them without a full rebuild
    var detailPanel = null;  // right-column detail container (title + description + action buttons)
    // Quick Match "Select Multiple": when ON, the right panel shows a checkbox list over the
    // multi-capable games and ONE Quick Match button that searches all ticked games at once
    // (server /api/mquick pairs on set intersection). Durak is excluded (it needs its own room
    // flow). State persists across card selection so the mode stays put while browsing.
    var multiSelect = false;
    var multiChecked = {};   // { gameId: true } — games ticked for the multi-search
    // Time control (§8 commit 2.3), chess/checkers only. selectedTimeControl = seconds per side:
    // a concrete 60/180/300/600, or -1 = "Any" (quick-match wildcard). For Create / vs-Bot the
    // room needs a concrete bank so "Any" collapses to TC_ANY_DEFAULT (5 min); the joiner reads
    // the host's bank back from join(). For Quick Match a concrete pick pools by that bank and
    // "Any" rides up as tc="any" (server pairs it with any waiter, else 5 min). Online clients no
    // longer need tc up-front — the clock is discovered from the authoritative /api/clocks poll.
    var TC_GAMES = { 1: true, 4: true };            // checkers=1, chess=4 (mirror server CLOCK_GAMES)
    var TC_CHOICES = [60, 180, 300, 600];           // 1 / 3 / 5 / 10 minutes
    var TC_ANY_DEFAULT = 300;                       // "Any" collapses to 5 min where a concrete bank is required
    var selectedTimeControl = 300;                  // host's pick (persists while browsing)
    function isTimedGame(id) { return !!TC_GAMES[id]; }
    // Concrete bank for a room that must fix one now (Create / vs-Bot): map "Any"(-1) → 5 min.
    function concreteTc(sec) { return sec === -1 ? TC_ANY_DEFAULT : sec; }
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
        connectfour: "Drop your discs down the grid and be the first to line up four in a row.",
        poker:       "No-Limit Texas Hold'em. Read your table, bet your chips, and take the pot."
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
        var soundWrap = $.CreatePanel("Panel", header, "");
        soundWrap.AddClass("mg-vol-wrap");
        buildSoundControl(soundWrap);
        var soundCap = $.CreatePanel("Label", soundWrap, "");
        soundCap.AddClass("mg-ctrl-caption"); soundCap.text = "Volume";
        var scaleWrap = $.CreatePanel("Panel", header, "");
        scaleWrap.AddClass("mg-scale-wrap");
        buildScaleControl(scaleWrap);
        var scaleCap = $.CreatePanel("Label", scaleWrap, "");
        scaleCap.AddClass("mg-ctrl-caption"); scaleCap.text = "UI Scale";
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

    // ── sound control (volume), left of the scale dropdown ─────────────────────────
    // The volume picker is a native `DropDown` — the SAME proven recipe as the UI-scale control
    // (buildScaleControl): the custom click-segment popup didn't reliably open in our HUD context,
    // so we reuse the widget the engine opens/closes itself. No separate icon (maintainer
    // 2026-07-15): the "0%" option IS the mute, so the dropdown alone is the whole control.
    var VOL_STEPS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]; // options, loud→silent (0 = off)
    var VOL_DD_ID = "MG_VolDropDown";            // popup auto-id = VOL_DD_ID + "DropDownMenu"
    var soundWrapEl = null, soundDropdown = null;
    function buildSoundControl(wrap) {
        soundWrapEl = wrap;
        // native DropDown for the level — mirrors buildScaleControl exactly. 0% = muted.
        var dd = $.CreatePanel("DropDown", wrap, VOL_DD_ID);
        dd.AddClass("mg-vol-dd");
        soundDropdown = dd;
        var curVol = MG.Sound ? (MG.Sound.isMuted() ? 0 : MG.Sound.getVol()) : 70;
        var selectedId = "";
        for (var s = 0; s < VOL_STEPS.length; s++) {
            var pct = VOL_STEPS[s];
            var optId = "MG_Vol_" + pct;
            var opt = $.CreatePanel("Label", dd, optId);
            opt.AddClass("mg-vol-opt");
            opt.text = pct === 0 ? "Off" : (pct + "%");
            dd.AddOption(opt);
            if (pct === curVol) selectedId = optId;
        }
        try { dd.SetSelected(selectedId || ("MG_Vol_" + VOL_STEPS[0])); } catch (e) {}
        dd.SetPanelEvent("oninputsubmit", function () {
            var sel = null;
            try { sel = dd.GetSelected ? dd.GetSelected() : null; } catch (e) {}
            if (!sel) return;
            var pctNum = parseInt(String(sel.id || "").replace("MG_Vol_", ""), 10);
            if (isFinite(pctNum) && pctNum >= 0 && MG.Sound) {
                // 0% = mute; any positive level sets the volume and unmutes.
                if (pctNum === 0) { MG.Sound.setMuted(true); }
                else { MG.Sound.setVol(pctNum); MG.Sound.setMuted(false); }
            }
        });
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
        
        // Tell the server the player is leaving. A lobby still WAITING (waiting/room) is cancelled
        // — it only exists to be torn down before anyone's committed. A live game uses leave
        // instead: cancel is a no-op once players ≥ 2, so it never reached a mid-match opponent —
        // leave folds this seat out (3–4-seat durak/poker) or ends the match (pair games) at once.
        if (cancelServer && currentCode) {
            if (view === "game") { try { MG.Api.leave(currentCode, currentTok); } catch (e) {} }
            else if (view === "waiting" || view === "room") { try { MG.Api.cancel(currentCode, currentTok); } catch (e) {} }
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

        // Top-cluster picker (rendered BEFORE the spacer, so Quick Match sits at the SAME height
        // for every game and never jumps as you browse — maintainer 2026-07-18). Which picker:
        //   • chess/checkers → time-control bank (governs Create + vs-Bot; Quick Match forces 5 min)
        //   • durak          → private N-seat table size (governs Create; Quick Match stays heads-up)
        //   • poker          → table size (governs Create; poker has no public Quick Match)
        // Previously durak/poker rendered their picker AFTER Quick Match, which shoved Quick Match
        // down for those two games only — the "jump" the maintainer flagged.
        if (!multiSelect && onlineReady) {
            if (isTimedGame(selectedGameId)) renderTimeControl();
            else if (isDurakOnlineGame(selectedGameId)) renderDurakSeatPicker();
            else if (isPokerOnlineGame(selectedGameId)) renderPokerSeatPicker();
        }

        // Flexible spacer between the top cluster (title/blurb/toggle/time-control) and the action
        // buttons. .mg-detail is a FIXED 500px column so the divider stays even and the modal never
        // jumps between games; untimed games have no time-control block, which used to leave a dead
        // strip UNDER the buttons. The spacer eats that slack into the MIDDLE instead, sinking the
        // buttons to the bottom (maintainer 2026-07-16: "огромный подбородок снизу … прижать кнопки
        // к низу"). Timed games have a taller top cluster, so the spacer just shrinks toward 0.
        var detailSpacer = $.CreatePanel("Panel", detailPanel, "");
        detailSpacer.AddClass("mg-detail-spacer");

        if (multiSelect) {
            renderMultiPanel();    // count + Quick Match(set) + Create(random) on the right
        } else if (onlineReady) {
            var isPoker = isPokerOnlineGame(selectedGameId);
            var isDurak = isDurakOnlineGame(selectedGameId);
            // Primary: one-button public matchmaking. Wrapped in a .mg-btn-row so it uses
            // fill-parent-flow width, NOT width:100% — the latter makes Panorama clip the button's
            // right border (the PLAY VS BOT / QUICK MATCH "no right border" bug). Same structure as
            // the working CREATE/JOIN row.
            // Poker has NO public matchmaking (its lobby seats 2–4 on its own routes), but we still
            // show the button DISABLED for visual parity — a game with no Quick Match button at all
            // looked broken (maintainer 2026-07-18). Its table-size picker lives in the top cluster.
            var quickRow = $.CreatePanel("Panel", detailPanel, "");
            quickRow.AddClass("mg-btn-row");
            var quickBtn = $.CreatePanel("Button", quickRow, "");
            quickBtn.AddClass("mg-btn"); quickBtn.AddClass("mg-btn-primary"); quickBtn.AddClass("mg-btn-quick"); quickBtn.AddClass("mg-btn-solo");
            var ql = $.CreatePanel("Label", quickBtn, ""); ql.text = "QUICK MATCH";
            if (isPoker) {
                quickBtn.AddClass("mg-btn-inert");
                try { quickBtn.enabled = false; } catch (e) {}
            } else {
                quickBtn.SetPanelEvent("onactivate", function () { startQuickMatch(); });
            }
            var quickCap = $.CreatePanel("Label", detailPanel, "");
            quickCap.AddClass("mg-caption");
            quickCap.text = isPoker ? "Poker is private-table only — Create or Join a code below."
                : isDurak ? "Public 2-player match against anyone online."
                : "Public match against anyone online.";

            // Secondary: private match with a friend via a shared code.
            var friendLbl = $.CreatePanel("Label", detailPanel, "");
            friendLbl.AddClass("mg-section-label");
            friendLbl.text = (isPoker || isDurak) ? "Play with friends" : "Play with a friend";
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
        }

        fadeInDetail();

    }

    // Time-control segmented control (chess/checkers). One row of 1/3/5/10-minute segments plus
    // "Any" (value -1: quick-match wildcard — pair with any waiting bank, else 5 min). The picked
    // one carries .mg-on. selectedTimeControl persists while browsing. For Create/vs-Bot a room
    // needs a concrete bank, so "Any" collapses to 5 min (TC_ANY_DEFAULT); for Quick Match "Any"
    // rides up as tc="any" and the server resolves the bank when a second searcher arrives.
    // Poker table-size picker (2–4 seats), reusing the time-control segmented control's skin.
    // The pick rides pcreate at Create time; it doesn't affect Join (the joiner learns the cap
    // back from pjoin). Persisted in pokerSeatCap while browsing.
    function renderPokerSeatPicker() {
        var label = $.CreatePanel("Label", detailPanel, "");
        label.AddClass("mg-section-label");
        label.AddClass("mg-tc-label");
        label.text = "Table size";
        var seg = $.CreatePanel("Panel", detailPanel, "");
        seg.AddClass("mg-tc-seg");
        [2, 3, 4].forEach(function (n) {
            var b = $.CreatePanel("Button", seg, "");
            b.AddClass("mg-tc-opt");
            if (pokerSeatCap === n) b.AddClass("mg-on");
            var l = $.CreatePanel("Label", b, ""); l.text = n + " seats";
            b.SetPanelEvent("onactivate", function () {
                if (pokerSeatCap === n) return;
                pokerSeatCap = n;
                renderDetail();     // re-skin the segments (cheap; whole column rebuilds)
            });
        });
        // No trailing caption: this picker now sits in the top cluster (next to where
        // time-control sits for chess/checkers), and the CREATE caption below explains the flow.
    }

    // Durak private-table size picker (2–4 seats), reusing the segmented-control skin. It ONLY
    // governs Create (the private N-seat lobby via dcreate); Quick Match stays heads-up and Join
    // learns the cap back from djoin. Persisted in durakSeatCap while browsing.
    function renderDurakSeatPicker() {
        var label = $.CreatePanel("Label", detailPanel, "");
        label.AddClass("mg-section-label");
        label.AddClass("mg-tc-label");
        label.text = "Private table size";
        var seg = $.CreatePanel("Panel", detailPanel, "");
        seg.AddClass("mg-tc-seg");
        [2, 3, 4].forEach(function (n) {
            var b = $.CreatePanel("Button", seg, "");
            b.AddClass("mg-tc-opt");
            if (durakSeatCap === n) b.AddClass("mg-on");
            var l = $.CreatePanel("Label", b, ""); l.text = n + " players";
            b.SetPanelEvent("onactivate", function () {
                if (durakSeatCap === n) return;
                durakSeatCap = n;
                renderDetail();     // re-skin the segments (cheap; whole column rebuilds)
            });
        });
        // No trailing caption: this picker now sits in the top cluster (where time-control sits
        // for chess/checkers). The "Play with friends" CREATE row below carries the private-table flow.
    }

    function renderTimeControl() {
        var label = $.CreatePanel("Label", detailPanel, "");
        label.AddClass("mg-section-label");
        label.AddClass("mg-tc-label");
        label.text = "Time control";
        var seg = $.CreatePanel("Panel", detailPanel, "");
        seg.AddClass("mg-tc-seg");
        var opts = [
            { sec: 60, text: "1 min" },
            { sec: 180, text: "3 min" },
            { sec: 300, text: "5 min" },
            { sec: 600, text: "10 min" },
            { sec: -1, text: "Any" }
        ];
        opts.forEach(function (o) {
            var b = $.CreatePanel("Button", seg, "");
            b.AddClass("mg-tc-opt");
            if (selectedTimeControl === o.sec) b.AddClass("mg-on");
            var l = $.CreatePanel("Label", b, ""); l.text = o.text;
            b.SetPanelEvent("onactivate", function () {
                if (selectedTimeControl === o.sec) return;
                selectedTimeControl = o.sec;
                renderDetail();     // re-skin the segments (cheap; whole column rebuilds)
            });
        });
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
        // Offline room needs a concrete bank now, so "Any"(-1) collapses to the 5-min default.
        var tc = isTimedGame(selectedGameId) ? concreteTc(selectedTimeControl) : 0;
        // Poker/Durak: honour the 2/3/4 seat picker so "vs Bot" fills that many seats with bots
        // (you + N-1 bots), instead of the controller's fixed default (poker 4 / durak 2). The
        // offline controller already drives every non-player seat, so this is all it needs.
        var opts = { timeControl: tc };
        if (isPokerOnlineGame(selectedGameId)) opts.numPlayers = pokerSeatCap;
        else if (isDurakOnlineGame(selectedGameId)) opts.numPlayers = durakSeatCap;
        renderGame(selectedGameId, 0, iAmHost, true, opts);
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
        setTitle((g ? (g.short || g.name) : "Game") + (bot ? " (bot)" : ""));
        clearBody();
        rematchPollToken++;   // invalidate any handshake from the previous game

        var host = $.CreatePanel("Panel", modalBody, "");
        host.AddClass("mg-game-host");

        // The controller calls onGameOver(result) the moment its game ends (win/lose/draw).
        // We use it only to reveal Play Again — the result string is not needed for the flow.
        var playAgainBtn = null;
        function onGameOver() {
            if (playAgainBtn && playAgainBtn.IsValid && playAgainBtn.IsValid()) {
                playAgainBtn.style.visibility = "visible";
            }
        }

        activeGame = MG.Games.mount(gameId, host, {
            code: code,
            isHost: isHost,
            bot: !!bot,
            tok: currentTok,          // seat token: authorises this client's moves (unused offline)
            seat: opts && opts.seat,
            numPlayers: opts && opts.numPlayers,
            // Time control in SECONDS (0 = untimed). Only chess/checkers ever set it. Offline the
            // controller ticks it locally; online it's advisory — the controller polls the
            // server-authoritative /api/clocks — but we still pass it so the clock UI is built.
            timeControl: (opts && opts.timeControl) | 0,
            onStatus: setStatus,
            onGameOver: onGameOver
        });

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");

        // Play Again: hidden until the game ends. Bot = instant restart with sides flipped;
        // online = a server rematch handshake (both players must ask; see startRematch).
        playAgainBtn = $.CreatePanel("Button", row, "");
        playAgainBtn.AddClass("mg-btn"); playAgainBtn.AddClass("mg-btn-primary");
        playAgainBtn.style.visibility = "collapse";
        var pal = $.CreatePanel("Label", playAgainBtn, ""); pal.text = "Play Again";
        playAgainBtn.SetPanelEvent("onactivate", function () {
            if (bot) {
                // Offline: no server, just re-mount the same game with the side flipped so the
                // player alternates who moves first (mirrors startBotGame's botGamesStarted parity).
                renderGame(gameId, 0, !isHost, true, opts);
                return;
            }
            startRematch(gameId, code, isHost, opts, playAgainBtn);
        });

        var leave = $.CreatePanel("Button", row, "");
        leave.AddClass("mg-btn");
        var ll = $.CreatePanel("Label", leave, ""); ll.text = "Leave";
        leave.SetPanelEvent("onactivate", function () { renderMenu(); });
    }

    // Online rematch: both seats poll /api/rematch from the game-over screen. The server bumps
    // its `gen` and resets the board once BOTH have asked (mg_net Api.rematch, worker.core.js).
    // We pass our current gen up so a stale poll from before a restart can't re-arm the next
    // rematch. When state==2 (we completed the pair) OR the server's gen outran ours (the
    // opponent completed it), the lobby state is already fresh — re-mount the SAME game, same
    // seat/side; the sides never swap online (host stays seat 0).
    function startRematch(gameId, code, isHost, opts, btn) {
        rematchPollToken++;
        var token = rematchPollToken;
        var baseGen = rematchGen;
        if (btn && btn.IsValid && btn.IsValid()) btn.style.visibility = "collapse"; // one press
        setStatus("Rematch: waiting for opponent…");

        function restart() {
            if (token !== rematchPollToken || view !== "game") return;
            if (MG.Sound) MG.Sound.play("GameStart");
            renderGame(gameId, code, isHost, false, opts);
        }
        function tick() {
            if (token !== rematchPollToken || view !== "game") return;
            MG.Api.rematch(code, currentTok, baseGen, function (r) {
                if (token !== rematchPollToken || view !== "game") return;
                if (r.state === 9) { kickToMenu("Opponent left."); return; } // (9,9) gone / (9,3) bad token
                if (r.state === 2 || r.gen > baseGen) { rematchGen = r.gen; restart(); return; }
                $.Schedule(0.6, tick);   // still waiting for the opponent
            }, function () {
                $.Schedule(0.8, tick);   // transport hiccup: retry
            });
        }
        tick();
    }

    // ── lobby flow ────────────────────────────────────────────────────────────
    function isDurakOnlineGame(id) { return id === 3; }
    // Poker online is PRIVATE-CODE only (2–4 seats via its own pcreate/pjoin/proom routes —
    // the generic create/join/quick paths are hard-capped at 2 and would clobber a poker
    // lobby). It has no public quick-match, so the detail view hides that button for it.
    function isPokerOnlineGame(id) { return id === 6; }
    var pokerSeatCap = 2;   // host's chosen table size for the next poker lobby (2..4)
    var durakSeatCap = 2;   // host's chosen table size for the next PRIVATE durak lobby (2..4)

    function startCreate() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        setStatus("Creating lobby…");
        currentTok = MG.Session.newToken();   // one seat token for this whole game
        // The host's time-control pick rides the create request (chess/checkers only); the joiner
        // learns it back from join(). A private room must fix a concrete bank, so "Any"(-1)
        // collapses to 5 min here. Untimed games send 0 (server ignores it anyway).
        // Poker owns its route set (2–4 seats) — pcreate, not the generic 2-cap create.
        if (isPokerOnlineGame(selectedGameId)) {
            MG.Api.pcreate(pokerSeatCap, currentTok, function (res) {
                currentCode = res.code;
                renderPokerRoom(res.code, true, pokerSeatCap);
            }, function (why) {
                setStatus(why === "token" ? "Session error, please retry." : "Couldn't create the poker table.");
            });
            return;
        }
        // Durak's private lobby seats 2–4 on its own routes (dcreate/djoin/droom), so Create
        // routes through dcreate — never the generic 2-cap create — exactly like poker.
        if (isDurakOnlineGame(selectedGameId)) {
            MG.Api.dcreate(durakSeatCap, currentTok, function (res) {
                currentCode = res.code;
                renderDurakRoom(res.code, true, durakSeatCap, 0);
            }, function (why) {
                setStatus(why === "token" ? "Session error, please retry." : "Couldn't create the Durak table.");
            });
            return;
        }
        var tc = isTimedGame(selectedGameId) ? concreteTc(selectedTimeControl) : 0;
        log("startCreate game=" + selectedGameId + " base=" + MG.Net.getBaseUrl() + " tc=" + tc);
        MG.Api.create(selectedGameId, currentTok, function (code) {
            log("create ok, code=" + code);
            currentCode = code;
            renderWaiting(code);
            waitForJoiner(code, tc);
        }, function () {
            log("create FAILED (request errored)");
            setStatus("Couldn't create lobby. Check the server.");
        }, tc);
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

    // Poker lobby room: 2–4 seats. Host sees the shared code + a Deal button (usable once ≥2
    // seats are filled); joiners wait for the host to deal. `cap` is the table size fixed at
    // create; `mySeat` is the joiner's seat (host = 0).
    function renderPokerRoom(code, isHost, cap, mySeat) {
        cleanupCurrentView(false);
        view = "room";
        setTitle(isHost ? "Poker Table" : "Joined Poker Table");
        clearBody();
        currentCode = code;
        var seat = isHost ? 0 : (mySeat | 0);

        var box = $.CreatePanel("Panel", modalBody, "");
        box.AddClass("mg-code-box");
        var capL = $.CreatePanel("Label", box, ""); capL.AddClass("mg-code-cap"); capL.text = "Poker table code:";
        var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = String(code);
        var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint");
        hint.text = cap + "-seat No-Limit Hold'em. Host deals once everyone's in.";

        var seats = $.CreatePanel("Panel", modalBody, "");
        seats.AddClass("mg-room-seats");
        var seatLabels = [];
        for (var s = 0; s < cap; s++) {
            var lbl = $.CreatePanel("Label", seats, ""); lbl.AddClass("mg-room-seat");
            lbl.text = "Seat " + (s + 1) + ": " + (s === seat ? "You" + (isHost ? " (host)" : "") : (s === 0 ? "Host" : "Waiting…"));
            seatLabels.push(lbl);
        }

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        if (isHost) {
            var startBtn = $.CreatePanel("Button", row, "");
            startBtn.AddClass("mg-btn"); startBtn.AddClass("mg-btn-primary");
            var sl = $.CreatePanel("Label", startBtn, ""); sl.text = "Deal";
            startBtn.SetPanelEvent("onactivate", function () {
                setStatus("Dealing…");
                MG.Api.pstart(code, currentTok, function (r) {
                    if (r.ok) { renderGame(6, code, true, false, { seat: 0, numPlayers: cap }); return; }
                    if (r.reason === "players") setStatus("Need at least two players before dealing.");
                    else if (r.reason === "host") setStatus("Only the host can deal.");
                    else setStatus("Couldn't deal (" + (r.reason || "error") + ").");
                }, function () { setStatus("Server unavailable."); });
            });
        }
        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Cancel";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });

        setStatus(isHost ? "Waiting for players…" : "Waiting for the host to deal…");
        pollPokerRoom(code, isHost, cap, seat, seatLabels);
    }

    function pollPokerRoom(code, isHost, cap, seat, seatLabels) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken || view !== "room") return;
            MG.Api.proom(code, function (r) {
                if (token !== statusPollToken || view !== "room") return;
                if (r.gone) { renderMenu(); setStatus("⚠ Table closed."); return; }
                for (var s = 0; s < cap; s++) {
                    if (s === seat) continue;   // never overwrite "You"
                    if (!seatLabels[s] || !seatLabels[s].IsValid || !seatLabels[s].IsValid()) continue;
                    seatLabels[s].text = "Seat " + (s + 1) + ": " + (s < r.players ? "Player joined" : "Waiting…");
                }
                if (r.started) { renderGame(6, code, isHost, false, { seat: seat, numPlayers: cap }); return; }
                if (isHost) setStatus(r.players >= 2 ? (r.players + "/" + cap + " seated. Press Deal.") : "Waiting for players…");
                else setStatus("Waiting for the host to deal…");
                $.Schedule(1.0, tick);
            }, function () { $.Schedule(1.5, tick); });
        }
        tick();
    }

    // Durak PRIVATE N-seat lobby room (2–4 seats). The 2-player public Quick Match still uses the
    // simpler renderRoom/pollDurakRoom above; this mirrors renderPokerRoom for the private table.
    // Host sees the shared code + a Start button (usable once ≥2 seats fill); joiners wait. `cap`
    // is the table size fixed at create; `seat` is this client's seat (host = 0).
    function renderDurakRoom(code, isHost, cap, seat) {
        cleanupCurrentView(false);
        view = "room";
        setTitle(isHost ? "Durak Table" : "Joined Durak Table");
        clearBody();
        currentCode = code;
        seat = seat | 0;

        var box = $.CreatePanel("Panel", modalBody, "");
        box.AddClass("mg-code-box");
        var capL = $.CreatePanel("Label", box, ""); capL.AddClass("mg-code-cap"); capL.text = "Durak table code:";
        var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = String(code);
        var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint");
        hint.text = cap + "-player online Durak. Host starts once everyone's in.";

        var seats = $.CreatePanel("Panel", modalBody, "");
        seats.AddClass("mg-room-seats");
        var seatLabels = [];
        for (var s = 0; s < cap; s++) {
            var lbl = $.CreatePanel("Label", seats, ""); lbl.AddClass("mg-room-seat");
            lbl.text = "Seat " + (s + 1) + ": " + (s === seat ? "You" + (isHost ? " (host)" : "") : (s === 0 ? "Host" : "Waiting…"));
            seatLabels.push(lbl);
        }

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        if (isHost) {
            var startBtn = $.CreatePanel("Button", row, "");
            startBtn.AddClass("mg-btn"); startBtn.AddClass("mg-btn-primary");
            var sl = $.CreatePanel("Label", startBtn, ""); sl.text = "Start";
            startBtn.SetPanelEvent("onactivate", function () {
                setStatus("Starting Durak…");
                MG.Api.start(code, currentTok, function (r) {
                    if (r.ok) { renderGame(3, code, true, false, { seat: 0, numPlayers: cap }); return; }
                    if (r.reason === "players") setStatus("Need at least two players before starting.");
                    else if (r.reason === "host") setStatus("Only the host can start.");
                    else setStatus("Couldn't start Durak (" + (r.reason || "error") + ").");
                }, function () { setStatus("Server unavailable."); });
            });
        }
        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Cancel";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });

        setStatus(isHost ? "Waiting for players…" : "Waiting for the host to start…");
        pollDurakTable(code, isHost, cap, seat, seatLabels);
    }

    function pollDurakTable(code, isHost, cap, seat, seatLabels) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken || view !== "room") return;
            MG.Api.droom(code, function (r) {
                if (token !== statusPollToken || view !== "room") return;
                if (r.gone) { renderMenu(); setStatus("⚠ Table closed."); return; }
                for (var s = 0; s < cap; s++) {
                    if (s === seat) continue;   // never overwrite "You"
                    if (!seatLabels[s] || !seatLabels[s].IsValid || !seatLabels[s].IsValid()) continue;
                    seatLabels[s].text = "Seat " + (s + 1) + ": " + (s < r.players ? "Player joined" : "Waiting…");
                }
                if (r.started) { renderGame(3, code, isHost, false, { seat: seat, numPlayers: cap }); return; }
                if (isHost) setStatus(r.players >= 2 ? (r.players + "/" + cap + " seated. Press Start.") : "Waiting for players…");
                else setStatus("Waiting for the host to start…");
                $.Schedule(1.0, tick);
            }, function () { $.Schedule(1.5, tick); });
        }
        tick();
    }

    // `tc` (seconds) is the host's chosen time control, threaded through so the host mounts its
    // clock with the same bank the joiner will read from the server. 0 for untimed / non-clock games.
    function waitForJoiner(code, tc) {
        statusPollToken++;
        var token = statusPollToken;
        function tick() {
            if (token !== statusPollToken) return;
            MG.Api.status(code, function (st) {
                if (token !== statusPollToken) return;
                if (st.players === 2) { renderGame(selectedGameId, code, true, false, { timeControl: tc | 0 }); return; }
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
        // Quick Match time control (chess/checkers only): a concrete pick pools with same-bank
        // searchers; "Any"(-1) rides up as tc="any" and the server pairs it with any waiter (or
        // 5 min if two "Any" seekers meet). The server resolves the final bank when both seats are
        // present, so the client no longer knows it up-front — the online clock is poll-discovered
        // from /api/clocks, hence renderGame gets timeControl:0 (untimed games send it too, no-op).
        var tcArg = isTimedGame(selectedGameId) ? (selectedTimeControl === -1 ? "any" : selectedTimeControl) : 0;
        log("startQuickMatch game=" + selectedGameId + " tc=" + tcArg);
        MG.Api.quick(selectedGameId, currentTok, function (res) {
            if (res.role === "joiner") {
                log("quick joined, code=" + res.code);
                currentCode = res.code;
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, false, true); return; }
                renderGame(selectedGameId, res.code, false, false, { timeControl: 0 }); // seated by the server; we play black
            } else {
                log("quick hosting, code=" + res.code);
                currentCode = res.code;
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, true, true); return; }
                renderWaiting(res.code, true);
                waitForJoiner(res.code, 0);
            }
        }, function () {
            log("quick FAILED (request errored)");
            setStatus("Couldn't reach matchmaking. Check the server.");
        }, tcArg);
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
        // Poker lobbies live on their own routes; join via pjoin (which learns our seat + the
        // table cap) rather than the generic 2-seat join. The Join screen is shared, so we try
        // pjoin first ONLY when the user is browsing poker — otherwise fall through to join.
        if (isPokerOnlineGame(selectedGameId)) {
            MG.Api.pjoin(code, currentTok, function (res) {
                if (res.ok) { currentCode = code; renderPokerRoom(code, false, res.cap, res.seat); return; }
                if (res.reason === "missing") setStatus("Table " + code + " not found.");
                else if (res.reason === "full") setStatus("That table is full.");
                else if (res.reason === "started") setStatus("That hand has already started.");
                else setStatus("Couldn't join the table.");
            }, function () { setStatus("Server unavailable."); });
            return;
        }
        // Durak private tables (2–4 seats) live on their own routes too; join via djoin so the
        // joiner learns its seat + the table cap. Same shape as poker's pjoin branch above.
        if (isDurakOnlineGame(selectedGameId)) {
            MG.Api.djoin(code, currentTok, function (res) {
                if (res.ok) { currentCode = code; renderDurakRoom(code, false, res.cap, res.seat); return; }
                if (res.reason === "missing") setStatus("Table " + code + " not found.");
                else if (res.reason === "full") setStatus("That table is full.");
                else if (res.reason === "started") setStatus("That game has already started.");
                else setStatus("Couldn't join the table.");
            }, function () { setStatus("Server unavailable."); });
            return;
        }
        MG.Api.join(code, currentTok, function (res) {
            if (res.ok) {
                // The game id must decode to a real, playable game — mounting a
                // disabled stub would leave the host playing against a ghost.
                var g = MG.Games.byId(res.game);
                if (!g || !g.enabled) { setStatus("Couldn't read the lobby. Please try again."); return; }
                currentCode = code;
                if (res.game === 3) { renderRoom(code, false, false); return; }
                // res.tc = the host's time control (seconds), decoded from the join reply. The
                // clock itself is server-authoritative; we pass tc only so the clock UI is built.
                renderGame(res.game, code, false, false, { timeControl: res.tc | 0 });
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
