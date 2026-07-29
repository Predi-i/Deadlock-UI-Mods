"use strict";

/*
 * mg_ui.js - menu shell for the Deadlock Minigames mod.
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

    // Mod version, shown bottom-left of the footer. Bump on a user-facing release.
    var MG_VERSION = "1.0";
    // Each shipped version checks its own marker on the public main branch. A square marker means
    // the release is still relevant; changing that marker to a wide image marks it outdated.
    // Aspect ratio is intentional: Panorama may UI-scale or swap the reported dimensions.
    var UPDATE_MARKER_BASE = "https://raw.githubusercontent.com/Predi-i/Deadlock-UI-Mods/main/Minigames/update-markers/";
    // Accept only the two deliberately distant marker shapes. A square is current and the 8:1
    // template is outdated; anything in the large gap between them is malformed/ambiguous, not an
    // update. This avoids turning an unexpected image placeholder into a false update notice.
    var UPDATE_RELEVANT_MAX_RATIO = 1.35;
    var UPDATE_OUTDATED_MIN_RATIO = 4.0;

    // Route through MG.debug so nothing hits the console unless debug mode is ON.
    function log(m) {
        try { if (MG.debug) MG.debug("[ui] " + m); } catch (e) {}
    }

    var overlay = null, modalBody = null, statusLabel = null, titleLabel = null;
    var headerCredit = null, updatePopup = null, updatePopupBody = null;
    // UI-scale control (dropdown left of the close X): scales the WHOLE modal - picker,
    // boards, Durak felt & cards - via the `ui-scale` LAYOUT-scale on .mg-modal (crisp re-layout,
    // NOT the blurry pre-transform raster; see applyUiScale). Kept for the session; the drag maths
    // in the games are already relative so any scale is safe.
    var modalPanel = null, uiScalePct = 100, scaleDropdown = null;
    // In the MENU view the status text lives on the LEFT of the footer row (same line as the
    // dev tools) instead of on its own line below - shorter panel, and the message sits level
    // with Test Connection / Check Updates. Other views keep the centred bottom statusLabel.
    var footerStatus = null;
    var overlayShown = false;     // our modal is up (independent of the menu's own state)
    var view = "menu";
    var selectedGameId = 1;
    var activeGame = null;        // { destroy }
    var currentCode = null;
    var currentTok = "";          // seat token for the CURRENT online game (see mg_net MG.Session)
    // Every user-initiated Create/Join/Quick flow gets an immutable generation. Image requests
    // cannot be aborted once active, so callbacks must prove they still belong to the latest flow.
    var uiActionGen = 0;
    var currentAction = null;
    function beginOnlineAction(gameId) {
        var ctx = { gen: ++uiActionGen, gameId: gameId, tok: MG.Session.newToken() };
        currentAction = ctx;
        currentCode = null;
        currentTok = ctx.tok;
        rematchGen = 0;
        return ctx;
    }
    function actionAlive(ctx) { return !!ctx && currentAction === ctx && ctx.gen === uiActionGen; }
    function bindActionCode(ctx, code) {
        if (!actionAlive(ctx)) return false;
        ctx.code = code;
        currentCode = code;
        currentTok = ctx.tok;
        return true;
    }
    function discardStaleSeat(ctx, code, waitingHost) {
        if (code === null || code === undefined) return;
        try {
            if (waitingHost) MG.Api.cancel(code, ctx.tok);
            else MG.Api.leave(code, ctx.tok);
        } catch (e) {}
    }
    // Lobby codes live in 0..1023 (the level-quantised downlink can't carry a bigger int - see
    // mg_net dCode). That means most codes are 3 digits and a few are 4 (1000..1023). Pad the
    // DISPLAYED code to a stable 4 digits so it always looks like a code; the join input strips
    // non-digits and validCode() parseInt's it, so "0838" and "838" resolve to the same lobby
    // (a padded and an unpadded client still interoperate).
    function codeStr(code) { var s = "" + (code | 0); while (s.length < 4) s = "0" + s; return s; }
    var statusPollToken = 0;
    var rematchGen = 0;           // our view of the online lobby's rematch generation (0 = fresh)
    var rematchPollToken = 0;     // guards the rematch poll loop, like statusPollToken
    var selfTestToken = 0;
    var updateCheckToken = 0;
    var autoUpdateCheckStarted = false;
    var cardEls = [];        // [{ id, panel }] - picker cards, so selection can re-skin them without a full rebuild
    var detailPanel = null;  // right-column detail container (title + description + action buttons)
    // Quick Match "Select Multiple": when ON, the right panel shows a checkbox list over the
    // multi-capable games and ONE Quick Match button that searches all ticked games at once
    // (server /api/mquick pairs on set intersection). A Durak match is always a two-seat pair
    // and switches into its normal dealer room. State persists while browsing.
    var multiSelect = false;
    var multiChecked = {};   // { gameId: true } - games ticked for the multi-search
    // Time control (§8 commit 2.3), chess/checkers only. selectedTimeControl = seconds per side:
    // a concrete 60/180/300/600, or -1 = "Any" (quick-match wildcard). For Create / vs-Bot the
    // room needs a concrete bank so "Any" collapses to TC_ANY_DEFAULT (5 min); the joiner reads
    // the host's bank back from join(). For Quick Match a concrete pick pools by that bank and
    // "Any" rides up as tc="any" (server pairs it with any waiter, else 5 min). Online clients no
    // longer need tc up-front - the clock is discovered from the authoritative /api/clocks poll.
    var TC_GAMES = { 1: true, 4: true };            // checkers=1, chess=4 (mirror server CLOCK_GAMES)
    var TC_CHOICES = [60, 180, 300, 600];           // 1 / 3 / 5 / 10 minutes
    var TC_ANY_DEFAULT = 300;                       // "Any" collapses to 5 min where a concrete bank is required
    var selectedTimeControl = -1;                   // host's pick (persists while browsing); default "Any"
    function isTimedGame(id) { return !!TC_GAMES[id]; }
    // Concrete bank for a room that must fix one now (Create / vs-Bot): map "Any"(-1) → 5 min.
    function concreteTc(sec) { return sec === -1 ? TC_ANY_DEFAULT : sec; }
    // Checkers variant (checkers only). Russian draughts (flying kings, men capture any direction)
    // vs English draughts (kings step one square, men capture forward only). "any" is the quick-
    // match wildcard: pair with any waiting variant, else Russian. A room that must fix one now
    // (Create / vs-Bot) collapses "any" → Russian (CV_ANY_DEFAULT), exactly like tc's 5-min fallback.
    var CV_GAMES = { 1: true };                     // checkers only (mirror server: variant applies to game 1)
    var CV_ANY_DEFAULT = "russian";
    var selectedVariant = "any";                    // host's pick (persists while browsing); default "Any"
    function hasVariant(id) { return !!CV_GAMES[id]; }
    function concreteVariant(v) { return v === "any" ? CV_ANY_DEFAULT : v; }
    // Games supported by the public multi-quick endpoint. Durak (3) participates heads-up;
    // Poker remains private-table only.
    var MULTI_GAME_IDS = [1, 2, 3, 4, 5];

    function isMultiGame(id) { for (var i = 0; i < MULTI_GAME_IDS.length; i++) if (MULTI_GAME_IDS[i] === id) return true; return false; }


    // Short blurb shown in the right-hand detail column for each game.
    // Keep each ≤ ~80 chars: .mg-detail-desc is a fixed 2-line (52px) box, so a longer blurb
    // spills onto a clipped 3rd line. The original 80-char lines are the proven envelope.
    var GAME_DESC = {
        checkers:    "Russian or English draughts. Jump and chain-capture every enemy piece to win.",
        tictactoe:   "The classic 3×3 duel. Line up three of your marks in a row to win.",
        durak:       "The beloved Eastern European card game. Be the first to shed all your cards.",
        chess:       "The classic game of kings. Trap the enemy king with the full rules in play.",
        connectfour: "Drop your discs down the grid and be the first to line up four in a row.",
        poker:       "No-Limit Texas Hold'em. Read your table, bet your chips, and take the pot.",
        pixelbattle: "One persistent world map. Paint it together, ten or more pixels at a time.",
        wordle:      "Find the hidden five-letter word in six guesses using colour-coded clues."
    };

    // Opens the maintainer's Boosty donate page in the external browser. Proven Panorama
    // channel (same call QOLLOCK uses for its Ko-fi / Discord links) - no fetch needed.
    function openSupport() {
        try { $.DispatchEvent("ExternalBrowserGoToURL", "https://boosty.to/predi_1/donate"); }
        catch (e) { setStatus("Couldn't open the browser."); }
    }

    // Opens the community Discord invite in the external browser (same proven channel as
    // openSupport - no fetch in Panorama).
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

    // Cached handle to the injected button. The loop below runs for the WHOLE match, and
    // ensureEscapeButton's early-out only fires after findAnchor has already walked up to 40
    // parents and run two FindChildTraverse sweeps of the entire HUD tree - every 1.5 s, for
    // every player, including those who never open the mod. One IsValid check skips all of it.
    // The engine rebuilds the escape menu on some transitions, which invalidates the panel; that
    // is exactly when the handle goes stale and the full search runs again.
    var escBtn = null;

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
        escBtn = btn;
        // Leave it appended (bottom of the list); CSS lifts it up and out of the way of
        // the native items - forcing it to the top made it overlap "Swap Hero".
        log("escape button injected");
    }

    // Cached handle to the injected button. The loop below runs for the WHOLE match, and
    // ensureEscapeButton's early-out only fires after findAnchor has already walked up to 40
    // parents and run two FindChildTraverse sweeps of the entire HUD tree - every 1.5 s, for
    // every player, including those who never open the mod. One IsValid check skips all of it.
    // The engine rebuilds the escape menu on some transitions, which invalidates the panel; that
    // is exactly when the handle goes stale and the full search runs again.
    function startInjectionLoop() {
        if (!(escBtn && escBtn.IsValid && escBtn.IsValid())) ensureEscapeButton();
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
        // on click - a misclick (e.g. missing a checker) must not kick you out. The
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
        // Left cluster: the mod name + credit + community buttons. The credit is hidden only in
        // the long-title waiting room so the fixed right controls stay inside the modal.
        var headerLeft = $.CreatePanel("Panel", header, "");
        headerLeft.AddClass("mg-header-left");
        titleLabel = $.CreatePanel("Label", headerLeft, "");
        titleLabel.AddClass("mg-title");
        titleLabel.text = "DL Arcade";
        headerCredit = $.CreatePanel("Button", headerLeft, "");
        headerCredit.AddClass("mg-header-credit");
        var creditLbl = $.CreatePanel("Label", headerCredit, ""); creditLbl.text = "by Predi_i";
        headerCredit.SetPanelEvent("onactivate", function () { openSupport(); });
        // Support pill sits just right of the credit (thumbsup icon + label) → Boosty.
        var supportBtn = $.CreatePanel("Button", headerLeft, "");
        supportBtn.AddClass("mg-support-btn");
        var sIcon = $.CreatePanel("Panel", supportBtn, "");
        sIcon.AddClass("mg-support-icon");   // background-image = icon_thumbsup.vsvg (CSS)
        var sLbl = $.CreatePanel("Label", supportBtn, ""); sLbl.AddClass("mg-support-label"); sLbl.text = "Support";
        supportBtn.SetPanelEvent("onactivate", function () { openSupport(); });
        // Discord pill sits just right of Support - same shape, Discord blurple palette. The
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
        // (horizontal-align:right is IGNORED on a child of a flow-children:right parent - the controls
        // just flow in a row and stay stuck next to the left cluster. A fill-parent-flow spacer is the
        // reliable way to push them right, mirroring the footer's status+spacer+tools layout.)
        var headerSpacer = $.CreatePanel("Panel", header, "");
        headerSpacer.AddClass("mg-header-spacer");
        // ⚠ RIGHT CONTROLS: scale dropdown (in a fixed 80px WRAPPER), then close X - both in flow.
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

        // A small persistent notice for a newer release. It is a sibling of the main modal so it
        // paints above every lobby/game view and survives view rebuilds. Visibility is controlled
        // by a same-panel class (the reliable Panorama popup pattern); only its close button hides
        // it, and there is deliberately no timer.
        updatePopup = $.CreatePanel("Panel", overlay, "MG_UpdatePopup");
        updatePopup.AddClass("mg-update-popup");
        var updatePopupHeader = $.CreatePanel("Panel", updatePopup, "");
        updatePopupHeader.AddClass("mg-update-popup-header");
        var updatePopupTitle = $.CreatePanel("Label", updatePopupHeader, "");
        updatePopupTitle.AddClass("mg-update-popup-title");
        updatePopupTitle.text = "UPDATE AVAILABLE";
        var updatePopupSpacer = $.CreatePanel("Panel", updatePopupHeader, "");
        updatePopupSpacer.AddClass("mg-update-popup-spacer");
        var updatePopupClose = $.CreatePanel("Button", updatePopupHeader, "");
        updatePopupClose.AddClass("mg-update-popup-close");
        var updatePopupCloseLbl = $.CreatePanel("Label", updatePopupClose, "");
        updatePopupCloseLbl.text = "X";
        updatePopupClose.SetPanelEvent("onactivate", function () {
            if (updatePopup) updatePopup.RemoveClass("mg-open");
        });
        updatePopupBody = $.CreatePanel("Label", updatePopup, "");
        updatePopupBody.AddClass("mg-update-popup-body");

        applyUiScale();
        // Cache the natural (100%) modal height next frame so the >100% clamp has a baseline. Runs
        // once; the height is view-independent (fixed-height columns), so no per-view remeasure.
        $.Schedule(0.0, measureNaturalH);
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
    function setTitle(t) {
        if (titleLabel) titleLabel.text = t;
        // The long waiting-room title needs the reclaimed width; all other views keep the credit.
        if (headerCredit && headerCredit.IsValid && headerCredit.IsValid())
            headerCredit.SetHasClass("mg-credit-hidden", view === "waiting");
    }

    // ── UI-scale control (NATIVE DropDown, QOLLOCK Default-Hero recipe) ────────
    // Uses the game's own `DropDown` widget - the SAME control QOLLOCK ships for "Default Hero".
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
        // SetSelected wants the option-panel ID (NOT an index) - this is what puts the real
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
    // The volume picker is a native `DropDown` - the SAME proven recipe as the UI-scale control
    // (buildScaleControl): the custom click-segment popup didn't reliably open in our HUD context,
    // so we reuse the widget the engine opens/closes itself. No separate icon (maintainer
    // 2026-07-15): the "0%" option IS the mute, so the dropdown alone is the whole control.
    var VOL_STEPS = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]; // options, loud→silent (0 = off)
    var VOL_DD_ID = "MG_VolDropDown";            // popup auto-id = VOL_DD_ID + "DropDownMenu"
    var soundWrapEl = null, soundDropdown = null;
    function buildSoundControl(wrap) {
        soundWrapEl = wrap;
        // native DropDown for the level - mirrors buildScaleControl exactly. 0% = muted.
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
        wrap.SetHasClass("mg-vol-muted", curVol === 0);   // match the state we opened with
        dd.SetPanelEvent("oninputsubmit", function () {
            var sel = null;
            try { sel = dd.GetSelected ? dd.GetSelected() : null; } catch (e) {}
            if (!sel) return;
            var pctNum = parseInt(String(sel.id || "").replace("MG_Vol_", ""), 10);
            if (isFinite(pctNum) && pctNum >= 0 && MG.Sound) {
                // 0% = mute; any positive level sets the volume and unmutes.
                if (pctNum === 0) { MG.Sound.setMuted(true); }
                else { MG.Sound.setVol(pctNum); MG.Sound.setMuted(false); }
                // Dim the label while muted. mg.css has always carried
                // `.mg-vol-muted .mg-vol-dd Label` for this, but nothing ever set the class, so
                // picking "Off" looked identical to a live volume.
                if (soundWrapEl && soundWrapEl.IsValid && soundWrapEl.IsValid())
                    soundWrapEl.SetHasClass("mg-vol-muted", pctNum === 0);
            }
        });
    }


    // ⚠ SCALE with `ui-scale`, NOT `pre-transform-scale2d`. pre-transform-scale2d is a member of
    // the TRANSFORM family - it runs AFTER layout and stretches the panel's already-rendered
    // texture, so text and .vtex art blow up as a blurry bitmap when scaled >100% (the "растровое
    // мыло" the maintainer saw). `ui-scale` scales at the LAYOUT level: the modal is re-laid-out at
    // the new size and fonts/vectors/.vtex are re-rasterised crisply. This is the game's own idiom
    // for sizing text UI - CitadelButton.Large/Medium/Small/XSmall are just ui-scale 125/100/80/65%
    // (citadel_base_styles.css) - and QOLLOCK sets it from JS the same way (panel.style.uiScale).
    // The full-screen dim (#MG_Dim) is a separate sibling, and the modal stays centre-aligned in the
    // overlay, so growing the modal's layout box keeps it centred. Drag maths read window px and
    // divide by the rendered layer width, so the scale cancels either way (unchanged from before).
    //
    // ⚠ CLAMP TO VIEWPORT. `ui-scale` grows the modal's LAYOUT box by the factor, and the modal is
    // vertical-align:center in the full-screen overlay, so once (natural height × scale) exceeds the
    // viewport height the top AND bottom clip OFF-SCREEN - the maintainer's 200% screenshot with
    // "PLAY WITH A FRIEND" cut off. `max-height: 92%` on .mg-modal can NOT stop it: that cap is in
    // LOGICAL px, evaluated BEFORE ui-scale multiplies. Width never overflows (900px even at 200% is
    // < the canvas), so only height is clamped.
    //
    // The modal's natural height is NOT constant across views, and assuming it was is what made
    // 125% eat the poker LEAVE button. The menu is ~640 logical px (header + the 500px columns);
    // the poker view is ~838 (a 520px felt + a fixed 104px controls row + LEAVE + status). So the
    // height is measured per VIEW, cached per view, and the largest measurement seen wins -
    // clamping for the tallest view we know about is safe for the shorter ones (they just sit a bit
    // further from the edge), whereas clamping for the shortest lets the tallest clip.
    //
    // ⚠ The modal must NOT have a percentage CSS max-height. Even a nominally looser 99% cap is
    // evaluated in the SCALED space. On the first menu→Poker switch at 150% it clips the 838px
    // natural view to ~713px BEFORE this function can measure it; dividing that clipped height
    // by 1.5 then permanently teaches the clamp the wrong "natural" height. CSS therefore leaves
    // height uncapped and the JS measurement/clamp is the single authority. A newly-tall view can
    // extend off-screen for one layout frame, then its full height is measured and fitted.
    //
    // ⚠ CONSEQUENCE, not a bug: on 1080p the poker view can't show much past ~125%, and the menu
    // past ~160%. Higher dropdown steps clamp to those. That is the physical ceiling - a taller
    // modal cannot be shown without cutting content off, which is the whole point of the clamp.
    // On a 1440p+ display the higher steps open up.
    var FIT_MARGIN = 0.98;                 // scaled modal may fill up to this fraction of viewport height
    var naturalModalH = 0;                 // tallest unscaled modal height measured so far (layout px)
    function fittedScalePct(pct) {
        if (pct <= 100 || !naturalModalH) return pct;             // ≤100% always fits; no cache yet → don't clamp
        var vpH = (overlay && overlay.IsValid && overlay.IsValid()) ? Number(overlay.actuallayoutheight) : NaN;
        if (!(isFinite(vpH) && vpH > 0)) return pct;
        var maxPct = Math.floor((vpH * FIT_MARGIN / naturalModalH) * 100);
        return (maxPct >= 100 && pct > maxPct) ? maxPct : pct;    // clamp; never below 100 (natural fits)
    }
    // Measure the modal's UNSCALED height and keep the tallest value seen. Runs after every view
    // switch, not once per session: the poker felt is ~200px taller than the menu, and clamping
    // against the menu's height is what let 125% cut the LEAVE button off.
    //
    // Reads actuallayoutheight and divides by the CURRENT scale, so it works at any scale instead of
    // only at 100% - the old version bailed unless uiScalePct was 100, which meant a player whose
    // saved scale was already >100% never got a measurement at all and never got a clamp.
    //
    // RETRIES until the engine has laid the modal out: a fresh view is built and measured in the
    // same frame, so the first read can legitimately be 0. On a 0 read the old code rescheduled
    // nothing, so naturalModalH stayed 0 for the session and fittedScalePct silently stopped
    // clamping - the exact clipped modal the clamp exists to prevent, with no symptom to notice.
    var naturalTries = 0;
    function measureNaturalH() {
        if (!(modalPanel && modalPanel.IsValid && modalPanel.IsValid())) return;
        var h = Number(modalPanel.actuallayoutheight);
        if (isFinite(h) && h > 0) {
            // actuallayoutheight is in WINDOW px, i.e. already multiplied by the applied scale.
            // Divide it back out to get the layout-space height the clamp reasons about.
            var applied = fittedScalePct(uiScalePct) / 100;
            var natural = (applied > 0) ? (h / applied) : h;
            if (natural > naturalModalH + 1) {   // +1: ignore sub-pixel jitter between identical views
                naturalModalH = natural;
                applyUiScale();                  // a taller view may need a tighter scale right now
            }
            naturalTries = 0;
            return;
        }
        if (naturalTries++ < 40) $.Schedule(0.05, measureNaturalH);   // ~2s of frames, then give up quietly
    }
    function applyUiScale() {
        if (modalPanel && modalPanel.IsValid && modalPanel.IsValid()) {
            try { modalPanel.style.uiScale = fittedScalePct(uiScalePct) + "%"; } catch (e) {}
        }
    }

    function cleanupCurrentView(cancelServer) {
        // Stop any background polling and drop pending requests from the queue
        statusPollToken++;
        selfTestToken++;
        if (MG.Net && MG.Net.clearQueue) try { MG.Net.clearQueue(); } catch (e) {}
        
        // Tell the server the player is leaving. A lobby still WAITING (waiting/room) is cancelled
        // - it only exists to be torn down before anyone's committed. A live game uses leave
        // instead: cancel is a no-op once players ≥ 2, so it never reached a mid-match opponent -
        // leave folds this seat out (3–4-seat durak/poker) or ends the match (pair games) at once.
        if (cancelServer) {
            var oldCode = currentCode, oldTok = currentTok, oldView = view;
            currentAction = null;
            uiActionGen++;
            currentCode = null;
            currentTok = "";
            rematchGen = 0;
            if (oldCode !== null && oldCode !== undefined) {
                if (oldView === "waiting") { try { MG.Api.cancel(oldCode, oldTok); } catch (e) {} }
                else if (oldView === "room" || oldView === "game") { try { MG.Api.leave(oldCode, oldTok); } catch (e) {} }
            }
        }
        
        // Destroy active game if any
        if (activeGame) { 
            try { activeGame.destroy(); } catch (e) {} 
            activeGame = null; 
        }
    }

    function clearBody() {
        // footerStatus is a child of modalBody's footer, so it's about to be deleted - drop the
        // reference so setStatus falls back to the centred bottom line until the menu rebuilds it.
        footerStatus = null;
        // Same reason: detailPanel and every entry in cardEls are children of modalBody. Leaving
        // the references behind meant renderDetail/updateCardSkins held handles to deleted panels,
        // and neither checks IsValid - the exact shape of the two ReferenceErrors this codebase has
        // already shipped once. Nothing calls them from outside the menu today; this keeps it that
        // way by construction rather than by luck.
        detailPanel = null;
        cardEls = [];
        if (modalBody) modalBody.RemoveAndDeleteChildren();
        // Re-measure on the NEXT frame, once the incoming view has been built and laid out. This is
        // NOT the old per-view re-fit that caused the button jitter: that one forced the scale back
        // to 100% for a frame to take a clean reading. This only reads a height and divides the
        // applied scale out, so nothing moves unless the new view is genuinely TALLER than anything
        // seen so far (poker's felt vs the menu's columns - the difference that made 125% clip the
        // LEAVE button). The scale itself lives on modalPanel, which we did not clear.
        naturalTries = 0;
        $.Schedule(0.0, measureNaturalH);
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
    // maintainer kept seeing. An <Image> sizes to its CSS box from frame 1 - the game's
    // own idiom (hud_ability_icon.xml, QOLLOCK ArcadeFlappyBird). SetImage wants the BARE
    // s2r:// url, never a url('…') wrapper. Shared implementation: MG.Widgets.setFace.
    var setFace = MG.Widgets.setFace;

    // ── views ───────────────────────────────────────────────────────────────
    // The lobby is a two-column layout: LEFT is the game picker grid, RIGHT is the
    // detail + action panel for whichever card is selected. Selecting a card only
    // re-skins the cards and rebuilds the right column (renderDetail) - no full
    // teardown - so the pick feels instant and the right side can fade between games.
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
                // state (shown by the card's own accent highlight - no corner badge, per the
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
        if (!(detailPanel && detailPanel.IsValid && detailPanel.IsValid())) return;
        detailPanel.RemoveAndDeleteChildren();
        var g = MG.Games.byId(selectedGameId);
        if (!g) return;
        if (g.id === 1) detailPanel.AddClass("mg-detail-checkers");
        else detailPanel.RemoveClass("mg-detail-checkers");

        var title = $.CreatePanel("Label", detailPanel, "");
        title.AddClass("mg-detail-title");
        title.text = g.name;

        var desc = $.CreatePanel("Label", detailPanel, "");
        desc.AddClass("mg-detail-desc");
        desc.text = GAME_DESC[g.key] || "";

        if (!g.enabled) {
            // Call to action FIRST (maintainer: the Discord request button sits ABOVE the
            // "IN DEVELOPMENT" notice): request this game in the community Discord - same
            // external-browser channel as the header Discord pill.
            var reqBtn = $.CreatePanel("Button", detailPanel, "");
            reqBtn.AddClass("mg-request-btn");
            var reqIcon = $.CreatePanel("Panel", reqBtn, "");
            reqIcon.AddClass("mg-request-icon");
            setFace(reqIcon, "s2r://panorama/images/discord_logo.vtex");
            var reqLbl = $.CreatePanel("Label", reqBtn, "");
            reqLbl.AddClass("mg-request-label");
            reqLbl.text = "Request a game in my Discord";
            reqBtn.SetPanelEvent("onactivate", function () { openDiscord(); });

            var locked = $.CreatePanel("Label", detailPanel, "");
            locked.AddClass("mg-detail-locked");
            locked.text = "IN DEVELOPMENT";
            var lockedSub = $.CreatePanel("Label", detailPanel, "");
            lockedSub.AddClass("mg-detail-locked-sub");
            lockedSub.text = "This game isn't playable yet. Pick another to start.";
            fadeInDetail();
            return;
        }

        // Pixel Battle is one persistent public world, not a match. It bypasses
        // Quick/Create/Join/Bot and mounts the shared canvas directly.
        if (g.id === 7) {
            var pixelNote = $.CreatePanel("Label", detailPanel, "");
            pixelNote.AddClass("mg-caption");
            pixelNote.text = "One shared canvas. Zoom in, queue your pixels, then upload them together.";

            var pixelSpacer = $.CreatePanel("Panel", detailPanel, "");
            pixelSpacer.AddClass("mg-pixel-detail-spacer");

            var pixelRow = $.CreatePanel("Panel", detailPanel, "");
            pixelRow.AddClass("mg-btn-row");
            var pixelBtn = $.CreatePanel("Button", pixelRow, "");
            pixelBtn.AddClass("mg-btn"); pixelBtn.AddClass("mg-btn-inert"); pixelBtn.AddClass("mg-btn-solo");
            var pixelLbl = $.CreatePanel("Label", pixelBtn, ""); pixelLbl.text = "CHECKING ACCESS…";

            var pixelCap = $.CreatePanel("Label", detailPanel, "");
            pixelCap.AddClass("mg-caption");
            pixelCap.text = "Checking this Steam account before loading the shared canvas.";
            if ($.MG.PixelBattle && $.MG.PixelBattle.checkAccess) {
                $.MG.PixelBattle.checkAccess(function (result) {
                    if (!pixelBtn || !pixelBtn.IsValid || !pixelBtn.IsValid()) return;
                    if (result.status === "banned") {
                        pixelBtn.RemoveClass("mg-btn-inert");
                        pixelBtn.AddClass("mg-btn-banned");
                        pixelLbl.text = "YOU ARE BANNED";
                        pixelCap.text = "Pixel Battle is blocked for this Steam account.";
                        return;
                    }
                    if (result.status !== "allowed") {
                        pixelLbl.text = "ACCESS UNAVAILABLE";
                        pixelCap.text = "Could not verify your Steam account. Reopen this game card to retry.";
                        return;
                    }
                    pixelBtn.RemoveClass("mg-btn-inert");
                    pixelBtn.AddClass("mg-btn-primary");
                    pixelLbl.text = "OPEN WORLD MAP";
                    pixelCap.text = "100 stored pixels · +1 every 30 seconds · minimum upload: 10";
                    pixelBtn.SetPanelEvent("onactivate", function () {
                        renderGame(7, 0, true, false, {});
                    });
                });
            } else {
                pixelLbl.text = "ACCESS UNAVAILABLE";
                pixelCap.text = "Pixel Battle access check is not loaded.";
            }
            fadeInDetail();
            return;
        }

        // Wordle is intentionally offline and self-contained. It has no room, bot,
        // matchmaking, or Worker traffic, so mount it directly like Pixel Battle.
        if (g.id === 8) {
            var wordleNote = $.CreatePanel("Label", detailPanel, "");
            wordleNote.AddClass("mg-caption");
            wordleNote.text = "Six tries. Green is exact, gold is elsewhere, dark is absent.";

            var wordleSpacer = $.CreatePanel("Panel", detailPanel, "");
            wordleSpacer.AddClass("mg-pixel-detail-spacer");

            var wordleRow = $.CreatePanel("Panel", detailPanel, "");
            wordleRow.AddClass("mg-btn-row");
            var wordleBtn = $.CreatePanel("Button", wordleRow, "");
            wordleBtn.AddClass("mg-btn"); wordleBtn.AddClass("mg-btn-primary"); wordleBtn.AddClass("mg-btn-solo");
            var wordleLbl = $.CreatePanel("Label", wordleBtn, ""); wordleLbl.text = "PLAY WORDLE";
            wordleBtn.SetPanelEvent("onactivate", function () {
                // `bot=true` selects the existing local Play Again flow; Wordle has no bot.
                renderGame(8, 0, true, true, {});
            });

            var wordleCap = $.CreatePanel("Label", detailPanel, "");
            wordleCap.AddClass("mg-caption");
            wordleCap.text = "Offline · no account or server required";
            fadeInDetail();
            return;
        }

        // Durak public Quick is heads-up; private Create/Join uses the dedicated 2–4-seat room.
        var onlineReady = true;

        // "Select multiple games" toggle - ALWAYS visible, a single check. When ON, you TICK
        // games directly on the LEFT picker; Quick Match searches the whole set and Create picks
        // a random one. Durak may be ticked and resolves to a heads-up auto-start dealer room.
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
        // for every game and never jumps as you browse - maintainer 2026-07-18). Which picker:
        //   • chess/checkers → time-control bank (governs Create + vs-Bot; Quick Match forces 5 min)
        //   • durak          → private N-seat table size (governs Create; Quick Match stays heads-up)
        //   • poker          → table size (governs Create; poker has no public Quick Match)
        // Previously durak/poker rendered their picker AFTER Quick Match, which shoved Quick Match
        // down for those two games only - the "jump" the maintainer flagged.
        if (!multiSelect && onlineReady) {
            if (isTimedGame(selectedGameId)) renderTimeControl();
            else if (isDurakOnlineGame(selectedGameId)) renderDurakSeatPicker();
            else if (isPokerOnlineGame(selectedGameId)) renderPokerSeatPicker();
            if (hasVariant(selectedGameId)) renderCheckersVariant();
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
            // fill-parent-flow width, NOT width:100% - the latter makes Panorama clip the button's
            // right border (the PLAY VS BOT / QUICK MATCH "no right border" bug). Same structure as
            // the working CREATE/JOIN row.
            // Poker has NO public matchmaking (its lobby seats 2–4 on its own routes), but we still
            // show the button DISABLED for visual parity - a game with no Quick Match button at all
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
            quickCap.text = isPoker ? "Poker is private-table only. Create or Join a code below."
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
    // "Any" (value -1: quick-match wildcard - pair with any waiting bank, else 5 min). The picked
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

    // Checkers variant segmented control (checkers only), same skin/idiom as renderTimeControl.
    // Russian / English / "Any" (the quick-match wildcard). selectedVariant persists while
    // browsing. For Create / vs-Bot a room needs a concrete variant, so "Any" collapses to
    // Russian (concreteVariant); for Quick Match "Any" rides up as cv="any" and the server pairs
    // it with any waiting variant (else Russian). Mirrors server checkersVariantFor.
    function renderCheckersVariant() {
        var label = $.CreatePanel("Label", detailPanel, "");
        label.AddClass("mg-section-label");
        label.AddClass("mg-tc-label");
        label.text = "Variant";
        var seg = $.CreatePanel("Panel", detailPanel, "");
        seg.AddClass("mg-tc-seg");
        var opts = [
            { cv: "russian", text: "Russian" },
            { cv: "english", text: "English" },
            { cv: "any", text: "Any" }
        ];
        opts.forEach(function (o) {
            var b = $.CreatePanel("Button", seg, "");
            b.AddClass("mg-tc-opt");
            if (selectedVariant === o.cv) b.AddClass("mg-on");
            var l = $.CreatePanel("Label", b, ""); l.text = o.text;
            b.SetPanelEvent("onactivate", function () {
                if (selectedVariant === o.cv) return;
                selectedVariant = o.cv;
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

    // Footer: the discreet tools (connection test / update check / debug log) live here as
    // small, low-contrast text links so they no longer compete with the play buttons.
    // A Support link sits at the far right. (Tools get hidden wholesale near release.)
    // Footer: only the discreet dev tools now (Support moved up to the header). The Debug
    // toggle no longer spawns an on-screen panel - it just routes logs to the dev console.
    function buildFooter() {
        var footer = $.CreatePanel("Panel", modalBody, "");
        footer.AddClass("mg-footer");

        // Mod version, pinned bottom-LEFT of the footer. A discreet build stamp; the status text
        // (below) floats CENTERED over the whole footer as an align-override, so the version and the
        // status don't fight for the same corner.
        var version = $.CreatePanel("Label", footer, "");
        version.AddClass("mg-footer-version");
        version.text = "v" + MG_VERSION;   // MG_VERSION defined at the top of the IIFE

        // Status text CENTERED over the footer (align-override child), level with the dev tools.
        // Replaces the old separate line under the footer, so the bottom strip is one row shorter.
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
        mkTool("Check Updates", function () { checkUpdates(false); });
        // Debug toggle: flips console logging on/off (no on-screen panel anymore).
        function dbgText() { return MG.Net.isDebug && MG.Net.isDebug() ? "Debug: ON" : "Debug: OFF"; }
        var dbgLbl = mkTool(dbgText(), function () {
            if (!MG.Net.setDebug) return;
            MG.Net.setDebug(!MG.Net.isDebug());
            dbgLbl.text = dbgText();
        });
    }

    // ── update check / legacy online self-test ───────────────────────────────
    // Legacy self-test notes (the footer entry is disabled; implementation remains below):
    // Exercises the full lobby protocol against the REAL deployed server from ONE client
    // (fills both seats with two tokens), so it's the only check that validates the live
    // transport under the actual in-game UI scale. Beyond the happy path it now drives the
    // three AUTHORITATIVE REJECTIONS a real game relies on - a foreign token, an out-of-turn
    // move, and an illegal move must each be refused with the right reason - so a mis-deployed
    // worker or a decode regression is caught in-game, not just offline. Steps run sequentially
    // (a small runner, not nested callbacks); any failure aborts and cleans the lobby up.
    // (Full rules coverage lives offline in tools/mg_*_test.js + Play-vs-Bot.)
    // The marker comes straight from GitHub, but its image load still goes through MG.Net's
    // global image FIFO. Panorama wedges when that load overlaps a Worker response image, so
    // first-open update checking, matchmaking and game polling must share one lane. A square
    // means this version is current; a deliberately wide marker means a newer release superseded
    // it. We compare aspect ratio because UI scale multiplies both dimensions and some setups
    // report them swapped. Ratios between the two intentional shapes are rejected.
    function classifyUpdateMarker(w, h) {
        if (!(isFinite(w) && isFinite(h) && w > 0 && h > 0)) return "invalid";
        var ratio = Math.max(w, h) / Math.min(w, h);
        if (ratio <= UPDATE_RELEVANT_MAX_RATIO) return "current";
        if (ratio >= UPDATE_OUTDATED_MIN_RATIO) return "outdated";
        return "invalid";
    }
    function showUpdatePopup() {
        if (!(updatePopup && updatePopup.IsValid && updatePopup.IsValid())) return;
        if (updatePopupBody && updatePopupBody.IsValid && updatePopupBody.IsValid())
            updatePopupBody.text = "A newer version of DL Arcade is available. You are using v" +
                MG_VERSION + ".";
        updatePopup.AddClass("mg-open");
    }
    function checkUpdates(automatic) {
        if (!(MG.Net && MG.Net.loadImage)) {
            if (!automatic) setStatus("Couldn't check for updates.");
            return;
        }

        var token = ++updateCheckToken;
        var versionSlug = MG_VERSION.replace(/\./g, "-");
        var url = UPDATE_MARKER_BASE + "is-" + versionSlug + "-relevant.png?rnd=" + Math.random();

        function alive() { return token === updateCheckToken; }
        function cleanup(img) {
            if (!img) return;
            try { img.SetImage(""); } catch (e) {}
            try { img.DeleteAsync(0); } catch (e2) {}
        }
        function fail() {
            if (alive() && !automatic && view === "menu") setStatus("Couldn't check for updates.");
        }

        if (!automatic) setStatus("Checking for updates...");
        MG.Net.loadImage(url, function (img, w, h) {
            cleanup(img);
            if (!alive()) return;
            var marker = classifyUpdateMarker(w, h);
            if (marker === "outdated") {
                showUpdatePopup();
                if (!automatic && view === "menu")
                    setStatus("An update is available for v" + MG_VERSION + ".");
            } else if (marker === "current") {
                if (!automatic && view === "menu")
                    setStatus("v" + MG_VERSION + " is up to date.");
            } else if (!automatic && view === "menu") {
                setStatus("Couldn't verify the update marker.");
            }
        }, fail);
    }

    // Legacy dev-only self-test, intentionally not linked from the footer.
    function runSelfTest() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first."); return; }
        var t = ++selfTestToken;
        function alive() { return t === selfTestToken; }

        // Three tokens: host (white/seat 0), joiner (black/seat 1), and a stranger seated
        // in neither - used to prove a foreign token can't move.
        var hostTok = MG.Session.newToken(), joinTok = MG.Session.newToken(), foreignTok = MG.Session.newToken();
        var code = null, pingMs = 0;
        var mFrom = 40, mTo = 33;   // legal white checkers opener (5,0)->(4,1) = squares 40 -> 33
        var illFrom = 40, illTo = 41;   // (5,0)->(5,1): sideways, never a legal checkers move
        var blkFrom = 17, blkTo = 24;   // a black man's square - used to test moving out of turn

        function cleanup() { if (code) { try { MG.Api.cancel(code, hostTok); } catch (e) {} } }
        function fail(what) { if (alive()) { cleanup(); setStatus("❌ Self-test failed at: " + what); } }
        function netFail(label) { return function () { fail(label + " (no response)"); }; }

        // Each step calls next() on success or fail(...) on a bad result; the runner advances
        // through them one at a time and reports "N/total" progress as it goes.
        var steps = [
            ["pinging the server", function () {
                MG.Api.ping(function (ms) { pingMs = ms; next(); }, netFail("ping"));
            }],
            ["creating a test lobby", function () {
                MG.Api.create(1, hostTok, function (c) { code = c; next(); },
                    function () { fail("create (server unreachable or bad decode)"); });
            }],
            ["reading lobby status", function () {
                MG.Api.status(code, hostTok, function (st) {
                    if (st.gone || st.players !== 1) { fail("status (got " + st.players + " players, expected 1)"); return; }
                    next();
                }, netFail("status"));
            }],
            ["joining own lobby", function () {
                MG.Api.join(code, joinTok, function (res) {
                    if (!res.ok || res.game !== 1) { fail("join (" + (res.reason || "game=" + res.game) + ")"); return; }
                    next();
                }, netFail("join"));
            }],
            ["rejecting a foreign-token move", function () {
                // A token seated in neither seat must be refused with reason "token".
                MG.Api.move(code, mFrom, mTo, 1, foreignTok, function (r) {
                    if (r.ok || r.reason !== "token") { fail("foreign-token move not rejected (" + (r.reason || "accepted") + ")"); return; }
                    next();
                }, netFail("foreign move"));
            }],
            ["rejecting an out-of-turn move", function () {
                // It's white's turn; the joiner (black) moving must be refused with reason "turn".
                MG.Api.move(code, blkFrom, blkTo, 1, joinTok, function (r) {
                    if (r.ok || r.reason !== "turn") { fail("out-of-turn move not rejected (" + (r.reason || "accepted") + ")"); return; }
                    next();
                }, netFail("out-of-turn move"));
            }],
            ["rejecting an illegal move", function () {
                // A sideways (non-diagonal) hop by the correct player must be refused as "illegal".
                MG.Api.move(code, illFrom, illTo, 1, hostTok, function (r) {
                    if (r.ok || r.reason !== "illegal") { fail("illegal move not rejected (" + (r.reason || "accepted") + ")"); return; }
                    next();
                }, netFail("illegal move"));
            }],
            ["relaying a legal move", function () {
                MG.Api.move(code, mFrom, mTo, 1, hostTok, function (r) {
                    if (!r.ok) { fail("legal move rejected (" + r.reason + ")"); return; }
                    next();
                }, netFail("legal move"));
            }],
            ["polling the move back", function () {
                MG.Api.poll(code, 0, function (mv) {
                    if (!mv || mv.from !== mFrom || mv.to !== mTo) { fail("poll (move came back wrong)"); return; }
                    next();
                }, netFail("poll"));
            }]
        ];

        var i = 0;
        function next() {
            if (!alive()) return;
            if (i >= steps.length) {
                cleanup();
                setStatus("✅ Self-test passed (" + steps.length + " checks). Ping " + pingMs + "ms.");
                return;
            }
            var s = steps[i++];
            setStatus("Self-test " + i + "/" + steps.length + ": " + s[0] + "…");
            try { s[1](); } catch (e) { fail(s[0] + " (exception)"); }
        }
        next();
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
        if (hasVariant(selectedGameId)) opts.variant = concreteVariant(selectedVariant);
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
            var rawCode = String(entry.text || "").replace(/[^0-9]/g, "");
            var code = parseInt(rawCode, 10);
            if (!/^\d{1,4}$/.test(rawCode) || code < 0 || code > 1023) {
                setStatus("The code is between 0000 and 1023.");
                return;
            }
            doJoin(code);
        });

        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Back";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });
    }

    function renderWaiting(code, isPublic, ctx) {
        cleanupCurrentView(false);
        view = "waiting";
        if (ctx) { ctx.code = code; ctx.phase = "waiting"; currentCode = code; currentTok = ctx.tok; }
        setTitle(isPublic ? "Finding a Match" : "Waiting for Opponent");
        clearBody();

        if (isPublic) {
            // Public: no code to share - the server pairs us with whoever comes next.
            var searching = $.CreatePanel("Label", modalBody, "");
            searching.AddClass("mg-searching");
            searching.text = "Looking for an opponent…";
        } else {
            var box = $.CreatePanel("Panel", modalBody, "");
            box.AddClass("mg-code-box");
            var cap = $.CreatePanel("Label", box, ""); cap.AddClass("mg-code-cap"); cap.text = "Lobby code:";
            var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = codeStr(code);
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

    function renderGame(gameId, code, isHost, bot, opts, ctx) {
        cleanupCurrentView(false);
        view = "game";
        var g = MG.Games.byId(gameId);
        setTitle((g ? (g.short || g.name) : "Game") + (bot && gameId !== 8 ? " (bot)" : ""));
        clearBody();
        rematchPollToken++;   // invalidate any handshake from the previous game

        var host = $.CreatePanel("Panel", modalBody, "");
        host.AddClass("mg-game-host");

        // The controller calls onGameOver(result) the moment its game ends (win/lose/draw).
        // We use it only to reveal Play Again - the result string is not needed for the flow.
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
            tok: ctx ? ctx.tok : currentTok, // immutable action token; unused offline
            seat: opts && opts.seat,
            numPlayers: opts && opts.numPlayers,
            // Time control in SECONDS (0 = untimed). Only chess/checkers ever set it. Offline the
            // controller ticks it locally; online it's advisory - the controller polls the
            // server-authoritative /api/clocks - but we still pass it so the clock UI is built.
            timeControl: (opts && opts.timeControl) | 0,
            // Checkers variant: "russian" (default) or "english". Concrete by mount time - the
            // picker's "Any" is resolved to a real variant before we get here (offline: collapsed
            // to Russian; online: read back from /api/match once the lobby is settled).
            variant: (opts && opts.variant) || "russian",
            onStatus: setStatus,
            onGameOver: onGameOver
        });

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");

        // Play Again: hidden until the game ends. Bot = instant restart with sides flipped;
        // online = a server rematch handshake (every present player must ask; see startRematch).
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

    // Mount an ONLINE game once its lobby is settled. Checkers carries a server-resolved variant
    // (the picker's "Any" may have paired with either engine), and the 2-int join/quick replies
    // can't carry it - so for checkers we first read /api/match to learn the chosen variant, then
    // mount. Every other game has no variant, so it mounts straight away. Never guess the variant
    // after a transport/decode failure: an English lobby mounted with Russian rules disagrees with
    // the authoritative server on king range, backward captures and promotion-chain turn endings.
    function mountOnlineGame(gameId, code, isHost, opts, ctx) {
        opts = opts || {};
        if (ctx && !actionAlive(ctx)) return;
        if (gameId !== 1) { renderGame(gameId, code, isHost, false, opts, ctx); return; }
        var misses = 0;
        function retryMatch() {
            if (ctx && !actionAlive(ctx)) return;
            setStatus("Syncing match settings…");
            $.Schedule(MG.Net.waitDelay(misses++), readMatch);
        }
        function readMatch() {
            if (ctx && !actionAlive(ctx)) return;
            MG.Api.match(code, function (m) {
                if (ctx && !actionAlive(ctx)) return;
                if (m.gone) { kickToMenu("Lobby closed."); return; }
                if (!m.variant) { retryMatch(); return; }
                opts.variant = m.variant;
                renderGame(gameId, code, isHost, false, opts, ctx);
            }, retryMatch);
        }
        readMatch();
    }

    // Online rematch: every present seat polls /api/rematch from the game-over screen. The server
    // bumps its `gen` and resets/redeals once all present seats have asked.
    // We pass our current gen up so a stale poll from before a restart can't re-arm the next
    // rematch. When state==2 (our poll completed consensus) OR the server's gen outran ours
    // (another player completed it), the lobby state is already fresh - re-mount the SAME game, same
    // seat/side; the sides never swap online (host stays seat 0).
    function startRematch(gameId, code, isHost, opts, btn) {
        rematchPollToken++;
        var token = rematchPollToken;
        var baseGen = rematchGen;
        if (btn && btn.IsValid && btn.IsValid()) btn.style.visibility = "collapse"; // one press
        setStatus("Rematch: waiting for the other players…");

        function restart() {
            if (token !== rematchPollToken || view !== "game") return;
            if (MG.Sound) MG.Sound.play("GameStart");
            renderGame(gameId, code, isHost, false, opts);
        }
        var misses = 0;
        function tick() {
            if (token !== rematchPollToken || view !== "game") return;
            MG.Api.rematch(code, currentTok, baseGen, function (r) {
                if (token !== rematchPollToken || view !== "game") return;
                if (r.state === 9) { kickToMenu("Opponent left."); return; } // (9,9) gone / (9,3) bad token
                if (r.state === 2 || r.gen > baseGen) { rematchGen = r.gen; restart(); return; }
                $.Schedule(MG.Net.waitDelay(misses++), tick);   // still waiting for consensus
            }, function () {
                $.Schedule(MG.Net.waitDelay(misses++), tick);   // transport hiccup: retry
            });
        }
        tick();
    }

    // ── lobby flow ────────────────────────────────────────────────────────────
    function isDurakOnlineGame(id) { return id === 3; }
    // Poker online is PRIVATE-CODE only (2–4 seats via its own pcreate/pjoin/proom routes -
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
        var ctx = beginOnlineAction(selectedGameId);
        // The host's time-control pick rides the create request (chess/checkers only); the joiner
        // learns it back from join(). A private room must fix a concrete bank, so "Any"(-1)
        // collapses to 5 min here. Untimed games send 0 (server ignores it anyway).
        // Poker owns its route set (2–4 seats) - pcreate, not the generic 2-cap create.
        if (isPokerOnlineGame(selectedGameId)) {
            MG.Api.pcreate(pokerSeatCap, ctx.tok, function (res) {
                if (!bindActionCode(ctx, res.code)) { discardStaleSeat(ctx, res.code, true); return; }
                renderPokerRoom(res.code, true, pokerSeatCap, 0, ctx);
            }, function (why) {
                if (!actionAlive(ctx)) return;
                setStatus(why === "token" ? "Session error, please retry." : "Couldn't create the poker table.");
            });
            return;
        }
        // Durak's private lobby seats 2–4 on its own routes (dcreate/djoin/droom), so Create
        // routes through dcreate - never the generic 2-cap create - exactly like poker.
        if (isDurakOnlineGame(selectedGameId)) {
            MG.Api.dcreate(durakSeatCap, ctx.tok, function (res) {
                if (!bindActionCode(ctx, res.code)) { discardStaleSeat(ctx, res.code, true); return; }
                renderDurakRoom(res.code, true, durakSeatCap, 0, ctx);
            }, function (why) {
                if (!actionAlive(ctx)) return;
                setStatus(why === "token" ? "Session error, please retry." : "Couldn't create the Durak table.");
            });
            return;
        }
        var tc = isTimedGame(selectedGameId) ? concreteTc(selectedTimeControl) : 0;
        var cv = hasVariant(selectedGameId) ? concreteVariant(selectedVariant) : "";
        log("startCreate game=" + selectedGameId + " base=" + MG.Net.getBaseUrl() + " tc=" + tc + " cv=" + cv);
        MG.Api.create(ctx.gameId, ctx.tok, function (code) {
            log("create ok, code=" + code);
            if (!bindActionCode(ctx, code)) { discardStaleSeat(ctx, code, true); return; }
            renderWaiting(code, false, ctx);
            waitForJoiner(code, tc, ctx);
        }, function () {
            if (!actionAlive(ctx)) return;
            log("create FAILED (request errored)");
            setStatus("Couldn't create lobby. Check the server.");
        }, tc, cv);
    }

    // ── shared lobby-room view ───────────────────────────────────────────────
    // ONE implementation behind the three rooms that used to be copy-pasted (2-seat durak
    // quick-match, N-seat poker table, N-seat durak table). They differed only in strings, in
    // which room/start route they call, and in whether the seat list is 2 fixed labels or `cap`
    // generated ones - everything structural (ctx/token binding, the poll loop, the started
    // hand-off, the gone/kick path) was identical, which is exactly how the copies drifted:
    // the `gone` handling and the stray-leave fix had to be applied three times.
    //
    // cfg = {
    //   code, isHost, ctx,
    //   gameId,                  // for renderGame on start
    //   cap,                     // seat count (2 for the quick-match room)
    //   seat,                    // this client's seat index
    //   title, joinedTitle,      // modal title, host / joiner
    //   codeCaption, hint,       // code box; omitted entirely when `searching` is set
    //   searching,               // public matchmaking: show this line instead of a code
    //   startLabel,              // "Start" / "Deal"
    //   autoStartOnly,           // hide host button when a full quick pair starts server-side
    //   startingMsg, startVerb,  // "Starting Durak…" / "deal"
    //   waitHost, waitJoiner,    // status while waiting
    //   readyMsg,                // fn(players) → host status once ≥2 are seated
    //   roomApi, startApi,       // fn(code, tok, cb, err)
    //   closedMsg                // kickToMenu text when the lobby is gone
    // }
    function renderLobbyRoom(cfg) {
        cleanupCurrentView(false);
        view = "room";
        setTitle(cfg.isHost ? cfg.title : cfg.joinedTitle);
        clearBody();
        // Bind the globals to THIS action's ctx. A create/join is async (~1.5s image load); if the
        // user fired another one meanwhile, the globals would hold the OTHER lobby's token and
        // Start/Deal would send it → server seatOf miss → (9,3). Closing over roomTok keeps the
        // room self-consistent regardless of later churn; the ctx guard drops a stale room's
        // callbacks entirely.
        if (cfg.ctx) { cfg.ctx.code = cfg.code; cfg.ctx.phase = "room"; }
        currentCode = cfg.code;
        var roomTok = cfg.ctx ? cfg.ctx.tok : currentTok;
        currentTok = roomTok;

        var code = cfg.code, isHost = cfg.isHost, ctx = cfg.ctx;
        var cap = Math.max(2, cfg.cap | 0);
        var seat = isHost ? 0 : (cfg.seat | 0);

        if (cfg.searching) {
            var searching = $.CreatePanel("Label", modalBody, "");
            searching.AddClass("mg-searching");
            searching.text = cfg.searching;
        } else {
            var box = $.CreatePanel("Panel", modalBody, "");
            box.AddClass("mg-code-box");
            var capL = $.CreatePanel("Label", box, ""); capL.AddClass("mg-code-cap"); capL.text = cfg.codeCaption;
            var big = $.CreatePanel("Label", box, ""); big.AddClass("mg-code-big"); big.text = codeStr(code);
            var hint = $.CreatePanel("Label", box, ""); hint.AddClass("mg-code-hint"); hint.text = cfg.hint;
        }

        var seats = $.CreatePanel("Panel", modalBody, "");
        seats.AddClass("mg-room-seats");
        var seatLabels = [];
        for (var s = 0; s < cap; s++) {
            var lbl = $.CreatePanel("Label", seats, ""); lbl.AddClass("mg-room-seat");
            lbl.text = "Seat " + (s + 1) + ": " +
                (s === seat ? ("You" + (isHost ? " (host)" : "")) : (s === 0 ? "Host" : "Waiting…"));
            seatLabels.push(lbl);
        }

        var row = $.CreatePanel("Panel", modalBody, "");
        row.AddClass("mg-actions");
        if (isHost && !cfg.autoStartOnly) {
            var startBtn = $.CreatePanel("Button", row, "");
            startBtn.AddClass("mg-btn"); startBtn.AddClass("mg-btn-primary");
            var sl = $.CreatePanel("Label", startBtn, ""); sl.text = cfg.startLabel;
            startBtn.SetPanelEvent("onactivate", function () {
                setStatus(cfg.startingMsg);
                cfg.startApi(code, roomTok, function (r) {
                    if (ctx && !actionAlive(ctx)) return;
                    if (r.ok) {
                        currentTok = roomTok;
                        renderGame(cfg.gameId, code, true, false, { seat: 0, numPlayers: cap }, ctx);
                        return;
                    }
                    if (r.reason === "players") setStatus("Need at least two players before " + cfg.startVerb + ".");
                    else if (r.reason === "host") setStatus("Only the host can " + cfg.startVerb + ".");
                    else if (r.reason === "token") setStatus("Session desync - please recreate the table.");
                    else setStatus("Couldn't " + cfg.startVerb + " (" + (r.reason || "error") + ").");
                }, function () { if (!ctx || actionAlive(ctx)) setStatus("Server unavailable."); });
            });
        }
        var back = $.CreatePanel("Button", row, "");
        back.AddClass("mg-btn");
        var bl = $.CreatePanel("Label", back, ""); bl.text = "Cancel";
        back.SetPanelEvent("onactivate", function () { renderMenu(); });

        setStatus(isHost ? cfg.waitHost : cfg.waitJoiner);
        pollLobbyRoom(cfg, cap, seat, seatLabels);
    }

    function pollLobbyRoom(cfg, cap, seat, seatLabels) {
        statusPollToken++;
        var token = statusPollToken;
        var misses = 0;
        var code = cfg.code, isHost = cfg.isHost, ctx = cfg.ctx;
        function tick() {
            if (token !== statusPollToken || view !== "room" || (ctx && !actionAlive(ctx))) return;
            cfg.roomApi(code, ctx ? ctx.tok : currentTok, function (r) {
                if (token !== statusPollToken || view !== "room" || (ctx && !actionAlive(ctx))) return;
                // kickToMenu, not renderMenu: it clears currentCode first, so cleanupCurrentView
                // does not fire /api/leave at a lobby the server has already reported gone.
                if (r.gone) { kickToMenu(cfg.closedMsg); return; }
                for (var s = 0; s < cap; s++) {
                    if (s === seat) continue;   // never overwrite "You"
                    if (!seatLabels[s] || !seatLabels[s].IsValid || !seatLabels[s].IsValid()) continue;
                    seatLabels[s].text = "Seat " + (s + 1) + ": " + (s < r.players ? "Player joined" : "Waiting…");
                }
                if (r.started) {
                    renderGame(cfg.gameId, code, isHost, false, { seat: seat, numPlayers: cap }, ctx);
                    return;
                }
                if (isHost) setStatus(r.players >= 2 ? cfg.readyMsg(r.players) : cfg.waitHost);
                else setStatus(cfg.waitJoiner);
                $.Schedule(MG.Net.waitDelay(misses++), tick);
            }, function () { $.Schedule(MG.Net.waitDelay(misses++), tick); });
        }
        tick();
    }

    // 2-seat Durak room reached from single- or multi-Quick. Matchmaking fills both declared
    // seats, so the server starts it automatically; there is no need to flash a Start button.
    function renderRoom(code, isHost, isPublic, ctx) {
        renderLobbyRoom({
            code: code, isHost: isHost, ctx: ctx, gameId: 3, cap: 2, seat: isHost ? 0 : 1,
            title: "Durak Room", joinedTitle: "Joined Durak Room",
            searching: isPublic
                ? (isHost ? "Waiting for a Durak opponent…" : "Matched. Starting Durak…")
                : null,
            codeCaption: "Durak lobby code:",
            hint: "2-player online Durak. Starts automatically when matched.",
            startLabel: "Start", startingMsg: "Starting Durak…", startVerb: "start",
            autoStartOnly: true,
            waitHost: "Waiting for player 2…", waitJoiner: "Match found. Starting Durak…",
            readyMsg: function () { return "Player 2 joined. Starting Durak…"; },
            roomApi: MG.Api.room, startApi: MG.Api.start,
            closedMsg: "Lobby closed."
        });
    }

    // Poker table: 2–4 seats, private code, host deals.
    function renderPokerRoom(code, isHost, cap, mySeat, ctx) {
        renderLobbyRoom({
            code: code, isHost: isHost, ctx: ctx, gameId: 6, cap: cap, seat: mySeat,
            title: "Poker Table", joinedTitle: "Joined Poker Table",
            codeCaption: "Poker table code:",
            hint: cap + "-seat No-Limit Hold'em. Auto-deals when full; host may deal early.",
            startLabel: "Deal", startingMsg: "Dealing…", startVerb: "deal",
            waitHost: "Waiting for players…", waitJoiner: "Waiting for the host to deal…",
            readyMsg: function (n) { return n + "/" + cap + " seated. Press Deal or wait until full."; },
            roomApi: MG.Api.proom, startApi: MG.Api.pstart,
            closedMsg: "Table closed."
        });
    }

    // Durak private table: 2–4 seats on durak's own routes (the 2-seat quick-match room above
    // goes through the generic room/start pair instead).
    function renderDurakRoom(code, isHost, cap, seat, ctx) {
        renderLobbyRoom({
            code: code, isHost: isHost, ctx: ctx, gameId: 3, cap: cap, seat: seat,
            title: "Durak Table", joinedTitle: "Joined Durak Table",
            codeCaption: "Durak table code:",
            hint: cap + "-player online Durak. Auto-starts when full; host may start early.",
            startLabel: "Start", startingMsg: "Starting Durak…", startVerb: "start",
            waitHost: "Waiting for players…", waitJoiner: "Waiting for the host to start…",
            readyMsg: function (n) { return n + "/" + cap + " seated. Press Start or wait until full."; },
            roomApi: MG.Api.droom, startApi: MG.Api.start,
            closedMsg: "Table closed."
        });
    }


    // `tc` (seconds) is the host's chosen time control, threaded through so the host mounts its
    // clock with the same bank the joiner will read from the server. 0 for untimed / non-clock games.
    function waitForJoiner(code, tc, ctx) {
        statusPollToken++;
        var token = statusPollToken;
        var misses = 0;
        function tick() {
            if (token !== statusPollToken || (ctx && !actionAlive(ctx))) return;
            MG.Api.status(code, ctx ? ctx.tok : currentTok, function (st) {
                if (token !== statusPollToken || (ctx && !actionAlive(ctx))) return;
                if (st.players === 2) { mountOnlineGame(selectedGameId, code, true, { timeControl: tc | 0 }, ctx); return; }
                // A swept or cancelled lobby answers `gone`. Without this the host sat on
                // "Searching for an opponent…" forever, polling a dead code at the slowest
                // cadence - waitForMultiMatch has always handled it; this copy had not.
                if (st.gone) { kickToMenu("Lobby closed."); return; }
                $.Schedule(MG.Net.waitDelay(misses++), tick);
            }, function () { $.Schedule(MG.Net.waitDelay(misses++), tick); });
        }
        tick();
    }

    function startQuickMatch() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var g = MG.Games.byId(selectedGameId);
        if (!g || !g.enabled) { setStatus("Pick an available game."); return; }
        setStatus("Finding a match…");
        var ctx = beginOnlineAction(selectedGameId);
        // Quick Match time control (chess/checkers only): a concrete pick pools with same-bank
        // searchers; "Any"(-1) rides up as tc="any" and the server pairs it with any waiter (or
        // 5 min if two "Any" seekers meet). The server resolves the final bank when both seats are
        // present, so the client no longer knows it up-front - the online clock is poll-discovered
        // from /api/clocks, hence renderGame gets timeControl:0 (untimed games send it too, no-op).
        var tcArg = isTimedGame(selectedGameId) ? (selectedTimeControl === -1 ? "any" : selectedTimeControl) : 0;
        var cvArg = hasVariant(selectedGameId) ? selectedVariant : "";   // "any"/"russian"/"english"
        log("startQuickMatch game=" + selectedGameId + " tc=" + tcArg + " cv=" + cvArg);
        MG.Api.quick(selectedGameId, ctx.tok, function (res) {
            if (!bindActionCode(ctx, res.code)) { discardStaleSeat(ctx, res.code, res.role !== "joiner"); return; }
            if (res.role === "joiner") {
                log("quick joined, code=" + res.code);
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, false, true, ctx); return; }
                mountOnlineGame(selectedGameId, res.code, false, { timeControl: 0 }, ctx); // seated by the server; we play black
            } else {
                log("quick hosting, code=" + res.code);
                if (isDurakOnlineGame(selectedGameId)) { renderRoom(res.code, true, true, ctx); return; }
                renderWaiting(res.code, true, ctx);
                waitForJoiner(res.code, 0, ctx);
            }
        }, function () {
            if (!actionAlive(ctx)) return;
            log("quick FAILED (request errored)");
            setStatus("Couldn't reach matchmaking. Check the server.");
        }, tcArg, cvArg);
    }

    // ── multi-select quick match ──────────────────────────────────────────────
    // Reflect the ticked set on the LEFT picker: a ticked multi-capable game gets the accent
    // highlight (.mg-ticked). NO corner badge - the maintainer didn't want the round tick.
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
    // ticked on the LEFT picker, so there's no checkbox list here - just the count + actions.
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

    function startMultiQuick() {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        var ids = multiCheckedIds();
        if (ids.length === 0) { setStatus("Tick at least one game to search."); return; }
        setStatus("Finding a match…");
        // A multi-search's game is server-decided, so seed the action with a placeholder id; the
        // resolved game arrives via waitForMultiMatch and drives the mount.
        var ctx = beginOnlineAction(0);
        // The multi-search carries the SAME time-control + variant preferences as single Quick
        // Match (they apply only to the clock/checkers games in the ticked set; the server ignores
        // them for the others). "Any"(-1) → tc="any"; the variant picker's value rides as-is.
        var tcArg = selectedTimeControl === -1 ? "any" : selectedTimeControl;
        var cvArg = selectedVariant;   // "any"/"russian"/"english"
        log("startMultiQuick games=" + ids.join(",") + " tc=" + tcArg + " cv=" + cvArg);
        MG.Api.mquick(ids, ctx.tok, function (res) {
            if (!bindActionCode(ctx, res.code)) { discardStaleSeat(ctx, res.code, res.role !== "joiner"); return; }
            if (res.role === "joiner") {
                // We were paired instantly; the server FIXED the game. Resolve it via status,
                // then mount as the joiner (seat 1). A short searching view covers the lookup.
                log("mquick joined, code=" + res.code);
                renderWaiting(res.code, true, ctx);
                waitForMultiMatch(res.code, false, ctx);
            } else {
                log("mquick hosting, code=" + res.code);
                renderWaiting(res.code, true, ctx);
                waitForMultiMatch(res.code, true, ctx);
            }
        }, function (why) {
            if (!actionAlive(ctx)) return;
            log("mquick FAILED (" + why + ")");
            setStatus(why === "games" ? "Pick at least one valid game." : "Couldn't reach matchmaking. Check the server.");
        }, tcArg, cvArg);
    }

    // Poll status until the lobby fills AND the game is fixed (game > 0). Works for both
    // roles: a HOST waits for a joiner to arrive and pick the game; a JOINER already
    // triggered the fix, so its first tick resolves. Then mount that game.
    function waitForMultiMatch(code, isHost, ctx) {
        statusPollToken++;
        var token = statusPollToken;
        var misses = 0;
        function tick() {
            if (token !== statusPollToken || (ctx && !actionAlive(ctx))) return;
            MG.Api.status(code, ctx ? ctx.tok : currentTok, function (st) {
                if (token !== statusPollToken || (ctx && !actionAlive(ctx))) return;
                if (st.gone) { renderMenu(); setStatus("⚠ Lobby closed."); return; }
                if (st.players === 2 && st.game > 0) {
                    ctx.gameId = st.game;
                    if (isDurakOnlineGame(st.game)) {
                        renderRoom(code, isHost, true, ctx);
                        return;
                    }
                    mountOnlineGame(st.game, code, isHost, {}, ctx);
                    return;
                }
                $.Schedule(MG.Net.waitDelay(misses++), tick);
            }, function () { $.Schedule(MG.Net.waitDelay(misses++), tick); });
        }
        tick();
    }

    function doJoin(code) {
        if (!MG.Net.isConfigured()) { setStatus("⚠ Configure the server first (BASE_URL in mg_net.js)."); return; }
        setStatus("Connecting to " + codeStr(code) + "…");
        var ctx = beginOnlineAction(selectedGameId);
        // Poker lobbies live on their own routes; join via pjoin (which learns our seat + the
        // table cap) rather than the generic 2-seat join. The Join screen is shared, so we try
        // pjoin first ONLY when the user is browsing poker - otherwise fall through to join.
        if (isPokerOnlineGame(selectedGameId)) {
            MG.Api.pjoin(code, ctx.tok, function (res) {
                if (res.ok) {
                    if (!bindActionCode(ctx, code)) { discardStaleSeat(ctx, code, false); return; }
                    renderPokerRoom(code, false, res.cap, res.seat, ctx); return;
                }
                if (!actionAlive(ctx)) return;
                if (res.reason === "missing") setStatus("Table " + codeStr(code) + " not found.");
                else if (res.reason === "full") setStatus("That table is full.");
                else if (res.reason === "started") setStatus("That hand has already started.");
                else setStatus("Couldn't join the table.");
            }, function () { if (actionAlive(ctx)) setStatus("Server unavailable."); });
            return;
        }
        // Durak private tables (2–4 seats) live on their own routes too; join via djoin so the
        // joiner learns its seat + the table cap. Same shape as poker's pjoin branch above.
        if (isDurakOnlineGame(selectedGameId)) {
            MG.Api.djoin(code, ctx.tok, function (res) {
                if (res.ok) {
                    if (!bindActionCode(ctx, code)) { discardStaleSeat(ctx, code, false); return; }
                    renderDurakRoom(code, false, res.cap, res.seat, ctx); return;
                }
                if (!actionAlive(ctx)) return;
                if (res.reason === "missing") setStatus("Table " + codeStr(code) + " not found.");
                else if (res.reason === "full") setStatus("That table is full.");
                else if (res.reason === "started") setStatus("That game has already started.");
                else setStatus("Couldn't join the table.");
            }, function () { if (actionAlive(ctx)) setStatus("Server unavailable."); });
            return;
        }
        MG.Api.join(code, ctx.tok, function (res) {
            if (res.ok) {
                // The game id must decode to a real, playable game - mounting a
                // disabled stub would leave the host playing against a ghost.
                var g = MG.Games.byId(res.game);
                if (!g || !g.enabled) { if (actionAlive(ctx)) setStatus("Couldn't read the lobby. Please try again."); return; }
                if (!bindActionCode(ctx, code)) { discardStaleSeat(ctx, code, false); return; }
                if (res.game === 3) { renderRoom(code, false, false, ctx); return; }
                // res.tc = the host's time control (seconds), decoded from the join reply. The
                // clock itself is server-authoritative; we pass tc only so the clock UI is built.
                // Checkers also carries a variant - mountOnlineGame reads it from /api/match.
                mountOnlineGame(res.game, code, false, { timeControl: res.tc | 0 }, ctx);
                return;
            }
            if (!actionAlive(ctx)) return;
            if (res.reason === "missing") setStatus("Lobby " + codeStr(code) + " not found.");
            else if (res.reason === "full") setStatus("Lobby is already full.");
            else setStatus("Connection error.");
        }, function () { if (actionAlive(ctx)) setStatus("Server unavailable."); });
    }

    // ── show / hide ───────────────────────────────────────────────────────────
    function showOverlay() {
        buildOverlay();
        overlay.style.visibility = "visible";
        overlayShown = true;
        setEscapeBackgroundActive(false); // stop the menu's backdrop from closing on a misclick
        renderMenu();
        // One automatic request per loaded HUD session, on the first explicit DL Arcade open.
        // Later opens do not touch GitHub; the footer action remains available for a manual retry.
        if (!autoUpdateCheckStarted) {
            autoUpdateCheckStarted = true;
            checkUpdates(true);
        }
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
    // Nothing notifies us, and our overlay - now a child of #EscapeMenu - would
    // otherwise linger (hittest-active, only faded by opacity) over the game. Poll the
    // menu's open state and tear our modal down the moment the menu is gone.
    function watchEscape() {
        if (overlayShown && !isEscapeOpen()) {
            log("escape menu closed - hiding overlay");
            hideOverlay();
        }
        $.Schedule(0.3, watchEscape);
    }

    function kickToMenu(reason) {
        if (view !== "game" && view !== "waiting" && view !== "room") return;
        log("kicked to menu: " + reason);
        // 0 is now a VALID lobby code (0..1023 space), so null - not 0 - is the "no lobby" sentinel
        // that stops cleanupCurrentView from firing a stray cancel/leave at a real lobby.
        currentCode = null;
        currentAction = null;
        renderMenu();
        if (reason) setStatus("⚠ " + reason);
    }

    MG.UI = { show: showOverlay, hide: hideOverlay, kickToMenu: kickToMenu };

    // boot
    $.Schedule(1.0, startInjectionLoop);
    $.Schedule(1.0, watchEscape);
    log("loaded");
})();
