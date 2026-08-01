/*
 * Pixel Battle - one persistent public canvas.
 *
 * Deadlock does not expose GameUI.GetCursorPosition, so the editor uses a fixed
 * 64x32 hit grid. At overview zoom a click drills into that region; at 8x (the max) every
 * hit cell is exactly one 512x256 canvas pixel. This keeps the panel count bounded
 * while still allowing precise placement.
 */
(() => {
    "use strict";

    const MG = $.MG = $.MG || {};
    if (MG.PixelBattle) return;
    MG.PixelBattle = {};

    const MAP_W = 512, MAP_H = 256;
    // ⚠ 64x32 hit cells over a 768x384 viewport = exactly 12x12 screen px per cell. Both numbers
    // are load-bearing together: the grid divides the viewport EXACTLY, so a laid-out cell and the
    // click arithmetic address the same pixels (the GeoGuesser 7.8125px drift, ARCHITECTURE §8.11).
    // 800/64 would be 12.5 and reintroduce it. Doubling the grid from 32x16 is what lets 8x be
    // one-cell-per-canvas-pixel, so MAX_ZOOM drops from 16 to 8 and the editor is reachable a zoom
    // step earlier. 2048 panels, the same count GeoGuesser's map grid already ships.
    const GRID_COLS = 64, GRID_ROWS = 32;
    const VIEW_W = 768, VIEW_H = 384;
    const MAX_ZOOM = 8;
    const BANK_CAP = 100;
    const REGEN_MS = 30000;
    // UPLOAD is the ONLY thing that sends pixels. There was a debounced auto-flush here
    // (2026-08-01): placing a pixel scheduled its own upload, so paint committed itself ~1s after
    // the last click and the button was decorative. That removed the player's last chance to
    // change their mind and read in-game as "I never pressed UPLOAD and they placed themselves".
    // MIN_BATCH 1 stays - it must match PX_MIN_BATCH in worker.core.js, and a manual UPLOAD of a
    // single pixel is a legitimate batch.
    const MIN_BATCH = 1;
    const MAX_BATCH = 128;
    // The canvas version poll. 20s: the Cloudflare 100k/day bucket that forced the old 8/15/30s
    // backoff ladder is gone (the VPS is not metered per request), so a steady cadence is simpler,
    // and 20s is the maintainer's chosen trade between seeing other players' paint and traffic.
    const POLL_ACTIVE_S = 20, POLL_WARM_S = 20, POLL_IDLE_S = 20;
    // (world_map.vtex is no longer referenced from the client: the map is baked into the
    // server-rendered /api/pxview frame. tools/build_pixelbattle_map.js still reads the source
    // image to generate the land mask.)
    const PALETTE = MG.PixelBattlePalette || [];
    const PALETTE_NAMES = MG.PixelBattlePaletteNames || [];
    let accessCache = { accountId: "", status: "unknown", balance: BANK_CAP, callbacks: [] };

    function validAccountId(value) {
        const text = value === undefined || value === null ? "" : String(value).trim();
        return /^\d{5,12}$/.test(text) && text !== "0";
    }

    function accountIdFromPanel(panel) {
        if (!panel) return "";
        const candidates = [];
        try { candidates.push(panel.accountid); } catch (e0) {}
        try { candidates.push(panel.account_id); } catch (e1) {}
        try { candidates.push(panel.accountID); } catch (e2) {}
        try {
            if (panel.GetAttributeString) {
                candidates.push(panel.GetAttributeString("accountid", ""));
                candidates.push(panel.GetAttributeString("account_id", ""));
                candidates.push(panel.GetAttributeString("accountID", ""));
            }
        } catch (e3) {}
        for (let i = 0; i < candidates.length; i++) {
            if (validAccountId(candidates[i])) return String(candidates[i]).trim();
        }
        return "";
    }

    function findAccountId() {
        let root = $.GetContextPanel();
        try {
            while (root && root.GetParent && root.GetParent()) root = root.GetParent();
        } catch (e) {}
        if (!root || !root.FindChildTraverse) return "";
        try {
            const partyContainer = root.FindChildTraverse("CitadelPartyContainer");
            const party = partyContainer && partyContainer.FindChildTraverse("CitadelParty");
            const localPlayer = party && party.FindChildTraverse("LocalPlayer");
            const avatar = localPlayer && localPlayer.FindChildTraverse("AvatarImage");
            return accountIdFromPanel(avatar);
        } catch (e2) {
            return "";
        }
    }

    function finishAccess(status, accountId, balance) {
        accessCache.accountId = accountId || accessCache.accountId;
        accessCache.status = status;
        if (balance !== undefined) accessCache.balance = balance;
        const callbacks = accessCache.callbacks.slice();
        accessCache.callbacks = [];
        for (let i = 0; i < callbacks.length; i++) {
            callbacks[i]({
                status: accessCache.status,
                accountId: accessCache.accountId,
                balance: accessCache.balance
            });
        }
    }

    function checkAccess(callback, attempt) {
        attempt = attempt || 0;
        let accountId = findAccountId();
        if (!accountId) {
            // The party avatar (where the Steam32 id is read from) may not be mounted yet, so we
            // retry for ~10s. Queue the callers on the SHARED cache instead of giving each its own
            // retry loop: renderDetail re-runs on every card pick and every multi-select toggle, so
            // N picks during that window used to spawn N independent 10-second chains, each with
            // its own $.Schedule per second. The dedupe below only covered the has-id path.
            accessCache.callbacks.push(callback);
            if (accessCache.status === "waiting-id") return;   // a retry chain is already running
            accessCache.status = "waiting-id";
            (function retry(n) {
                if (findAccountId()) { accessCache.status = "unknown"; checkAccess(() => {}); return; }
                if (n >= 10) { accessCache.status = "unknown"; finishAccess("error", "", BANK_CAP); return; }
                $.Schedule(1, () => { retry(n + 1); });
            })(attempt);
            return;
        }
        if (accessCache.accountId && accessCache.accountId !== accountId) {
            accessCache = { accountId: accountId, status: "unknown", balance: BANK_CAP, callbacks: [] };
        }
        if (accessCache.status === "allowed" || accessCache.status === "banned") {
            callback({
                status: accessCache.status,
                accountId: accountId,
                balance: accessCache.balance
            });
            return;
        }
        accessCache.accountId = accountId;
        accessCache.callbacks.push(callback);
        if (accessCache.status === "checking") return;
        accessCache.status = "checking";
        MG.Net.request("/api/pxbank", { id: accountId }, (w, h) => {
            if (h === 63 && w === 5) {
                finishAccess("banned", accountId, 0);
                return;
            }
            const value = h * 64 + w;
            if (h !== 63 && value >= 0 && value <= BANK_CAP) {
                finishAccess("allowed", accountId, value);
                return;
            }
            finishAccess("error", accountId, BANK_CAP);
        }, () => {
            finishAccess("error", accountId, BANK_CAP);
        });
    }

    function markBanned(accountId) {
        if (!accountId || accessCache.accountId === accountId) finishAccess("banned", accountId, 0);
    }

    MG.PixelBattle.checkAccess = checkAccess;
    MG.PixelBattle.markBanned = markBanned;

    function addLabel(parent, cssClass, text) {
        const label = $.CreatePanel("Label", parent, "");
        label.AddClass(cssClass);
        label.text = text || "";
        return label;
    }

    function addButton(parent, cssClass, text, handler) {
        const button = $.CreatePanel("Button", parent, "");
        const classes = cssClass.split(" ");
        for (let i = 0; i < classes.length; i++) if (classes[i]) button.AddClass(classes[i]);
        addLabel(button, "mg-px-button-label", text);
        button.SetPanelEvent("onactivate", handler);
        return button;
    }

    function createPixelBattle(container, session) {
        session = session || {};
        let destroyed = false;
        let root = $.CreatePanel("Panel", container, "MG_PixelBattle");
        root.AddClass("mg-px");

        let zoom = 1;
        // Integer logical-pixel origin of the visible rectangle. Keeping origin
        // (instead of a half-pixel centre) is what makes max-zoom paint cells land exactly.
        let viewX = 0, viewY = 0;
        let selectedColor = 1;
        const pending = {};
        let pendingOrder = [];
        const pendingPanels = {};
        let accountId = "";
        let accessReady = false;
        let banned = false;
        let balance = BANK_CAP;
        let balanceAt = Date.now();
        let sending = false;
        let knownVersion = -1;
        let versionMisses = 0;
        let pollGeneration = 0;
        let lastOuterStatus = "";

        function outerStatus(text) {
            lastOuterStatus = text;
            if (!destroyed && session.onStatus) session.onStatus(text);
        }

        const topbar = $.CreatePanel("Panel", root, "");
        topbar.AddClass("mg-px-topbar");
        const bankLabel = addLabel(topbar, "mg-px-stat", "");
        bankLabel.AddClass("mg-px-stat-bank");
        const regenLabel = addLabel(topbar, "mg-px-stat", "");
        regenLabel.AddClass("mg-px-stat-regen");
        const queueLabel = addLabel(topbar, "mg-px-stat", "");
        queueLabel.AddClass("mg-px-stat-queue");
        const coordLabel = addLabel(topbar, "mg-px-coord", "Click the map to zoom in");

        const viewport = $.CreatePanel("Panel", root, "");
        viewport.AddClass("mg-px-viewport");

        // NOTE: there used to be a `stage` subtree here (a scaled/translated Panel holding a
        // base-map <Image> and a remote-overlay <Image>) for compositing the map locally. Rendering
        // moved entirely server-side - updateView set stage.visibility = "collapse" on every call
        // and nothing ever set it back, so the subtree was permanently invisible, remoteImage never
        // received a non-empty url, and baseImage still decoded world_map.vtex into memory for a
        // panel nobody could see. Removed with its CSS (.mg-px-stage/.mg-px-map-image).

        // The Worker returns this viewport already expanded to VIEW_W x VIEW_H.
        // Keep a stable first-child layer so newly loaded image panels can be swapped
        // underneath the pending-pixel/grid overlays without changing their z-order.
        const crispLayer = $.CreatePanel("Panel", viewport, "");
        crispLayer.AddClass("mg-px-crisp-view");
        let crispImage = $.CreatePanel("Image", crispLayer, "", { scaling: "none" });
        crispImage.style.width = VIEW_W + "px";
        crispImage.style.height = VIEW_H + "px";
        try { crispImage.SetAttributeString("hittest", "false"); } catch (e2) {}

        // Pending pixels are initially hosted here, then re-parented into the exact
        // 32x16 hit cell while editing. Keeping the fill inside its cell makes the
        // grid, hover target and local paint share one layout box at every UI scale.
        const pendingLayer = $.CreatePanel("Panel", viewport, "");
        pendingLayer.AddClass("mg-px-pending-layer");
        try { pendingLayer.SetAttributeString("hittest", "false"); } catch (e3) {}

        const grid = $.CreatePanel("Panel", viewport, "");
        grid.AddClass("mg-px-grid");
        const gridCells = [];

        const controls = $.CreatePanel("Panel", root, "");
        controls.AddClass("mg-px-controls");

        const navigation = $.CreatePanel("Panel", controls, "");
        navigation.AddClass("mg-px-navigation");
        const navigationZoom = $.CreatePanel("Panel", navigation, "");
        navigationZoom.AddClass("mg-px-navigation-group");
        const navigationTop = $.CreatePanel("Panel", navigationZoom, "");
        navigationTop.AddClass("mg-px-navigation-row");
        const navigationBottom = $.CreatePanel("Panel", navigationZoom, "");
        navigationBottom.AddClass("mg-px-navigation-row");
        addButton(navigationTop, "mg-px-tool", "−", () => { setZoom(zoom / 2); });
        addButton(navigationTop, "mg-px-tool", "+", () => { setZoom(zoom * 2); });
        addButton(navigationBottom, "mg-px-tool mg-px-tool-reset", "RESET", () => {
            zoom = 1;
            viewX = 0;
            viewY = 0;
            updateView();
        });
        const zoomLabel = addLabel(navigationBottom, "mg-px-zoom-label", "1×");

        const dpad = $.CreatePanel("Panel", navigation, "");
        dpad.AddClass("mg-px-dpad");
        const dpadTop = $.CreatePanel("Panel", dpad, "");
        dpadTop.AddClass("mg-px-dpad-row");
        const dpadTopSpacer = $.CreatePanel("Panel", dpadTop, "");
        dpadTopSpacer.AddClass("mg-px-dpad-spacer");
        addButton(dpadTop, "mg-px-tool", "↑", () => { pan(0, -1); });
        const dpadBottom = $.CreatePanel("Panel", dpad, "");
        dpadBottom.AddClass("mg-px-dpad-row");
        addButton(dpadBottom, "mg-px-tool", "←", () => { pan(-1, 0); });
        addButton(dpadBottom, "mg-px-tool", "↓", () => { pan(0, 1); });
        addButton(dpadBottom, "mg-px-tool", "→", () => { pan(1, 0); });

        const palette = $.CreatePanel("Panel", controls, "");
        palette.AddClass("mg-px-palette");
        const paletteButtons = [];
        for (let color = 1; color <= PALETTE.length; color++) {
            ((colorIndex) => {
                var swatch = $.CreatePanel("Button", palette, "");
                swatch.AddClass("mg-px-swatch");
                if (colorIndex > 16) swatch.AddClass("mg-px-swatch-terrain");
                swatch.style.backgroundColor = PALETTE[colorIndex - 1] || "#ffffff";
                swatch.SetPanelEvent("onmouseover", () => {
                    coordLabel.text = "COLOR  " +
                        String(PALETTE_NAMES[colorIndex - 1] || colorIndex).toUpperCase();
                });
                swatch.SetPanelEvent("onactivate", () => {
                    selectedColor = colorIndex;
                    updatePalette();
                });
                paletteButtons.push(swatch);
            })(color);
        }

        const actions = $.CreatePanel("Panel", controls, "");
        actions.AddClass("mg-px-editor-actions");
        const eraserButton = addButton(actions, "mg-px-action mg-px-eraser", "ERASE", () => {
            selectedColor = 0;
            updatePalette();
        });
        const clearButton = addButton(actions, "mg-px-action", "CLEAR", clearPending);
        const sendButton = addButton(actions, "mg-px-action mg-px-action-primary", "UPLOAD", uploadPending);
        const helpLabel = addLabel(root, "mg-px-help", "");

        function predictedBalance() {
            const gained = Math.floor((Date.now() - balanceAt) / REGEN_MS);
            return Math.min(BANK_CAP, balance + Math.max(0, gained));
        }

        function availableBalance() {
            return Math.max(0, predictedBalance() - pendingOrder.length);
        }

        function updateStats() {
            const current = predictedBalance();
            const available = availableBalance();
            const elapsed = Math.max(0, Date.now() - balanceAt);
            const until = current >= BANK_CAP ? 0 : Math.max(1, Math.ceil((REGEN_MS - (elapsed % REGEN_MS)) / 1000));
            bankLabel.text = `PIXELS  ${available} / ${BANK_CAP}`;
            regenLabel.text = until ? (`NEXT +1  ${until}s`) : "PIXELS FULL";
            // Pending pixels now wait for UPLOAD, so the label must say that the player still has
            // to act. "SAVING n" claimed an upload was already happening and made the button look
            // decorative, which is the confusion the auto-flush caused in the first place.
            queueLabel.text = pendingOrder.length === 0
                ? (sending ? "SAVING…" : "SAVED")
                : `READY  ${pendingOrder.length}  ·  PRESS UPLOAD`;
            queueLabel.SetHasClass("mg-px-stat-ready", pendingOrder.length === 0 && !sending);
            // UPLOAD is the only path that commits paint, and greys out when there is nothing to send.
            sendButton.SetHasClass("mg-px-action-disabled",
                pendingOrder.length === 0 || !accountId || sending);
            clearButton.SetHasClass("mg-px-action-disabled", pendingOrder.length === 0 || sending);
        }

        function updatePalette() {
            for (let i = 0; i < paletteButtons.length; i++) {
                paletteButtons[i].SetHasClass("mg-px-swatch-selected", i + 1 === selectedColor);
            }
            eraserButton.SetHasClass("mg-px-eraser-selected", selectedColor === 0);
        }

        function clampOrigin() {
            const visibleW = MAP_W / zoom;
            const visibleH = MAP_H / zoom;
            viewX = Math.max(0, Math.min(MAP_W - visibleW, Math.round(viewX)));
            viewY = Math.max(0, Math.min(MAP_H - visibleH, Math.round(viewY)));
        }

        function updateView() {
            if (!accessReady || banned) return;
            clampOrigin();
            // Every zoom uses a server-rasterised VIEW_W x VIEW_H frame. This avoids
            // Panorama's bilinear filtering in previews as well as in the editor.
            crispImage.style.visibility = "visible";
            grid.SetHasClass("mg-px-grid-edit", zoom === MAX_ZOOM);
            zoomLabel.text = zoom + "×";
            helpLabel.text = zoom === MAX_ZOOM
                ? "Pick a colour, then paint. Changes stay local until you press UPLOAD."
                : "Click a region to zoom in. At 8× each square is one canvas pixel.";
            refreshPendingGeometry();
            scheduleCrispView();      // coalesced: a burst of pan/zoom presses costs ONE fetch
        }

        function setZoom(value) {
            const next = Math.max(1, Math.min(MAX_ZOOM, value | 0));
            if (next !== 1 && next !== 2 && next !== 4 && next !== 8 && next !== 16) return;
            const centerX = viewX + MAP_W / zoom / 2;
            const centerY = viewY + MAP_H / zoom / 2;
            zoom = next;
            viewX = Math.round(centerX - MAP_W / zoom / 2);
            viewY = Math.round(centerY - MAP_H / zoom / 2);
            updateView();
        }

        function pan(dx, dy) {
            if (zoom <= 1) return;
            viewX += dx * Math.max(1, Math.floor(MAP_W / zoom / 4));
            viewY += dy * Math.max(1, Math.floor(MAP_H / zoom / 4));
            updateView();
        }

        function mapPoint(col, row) {
            const visibleW = MAP_W / zoom;
            const visibleH = MAP_H / zoom;
            return {
                x: Math.max(0, Math.min(MAP_W - 1, Math.floor(viewX + (col + 0.5) * visibleW / GRID_COLS))),
                y: Math.max(0, Math.min(MAP_H - 1, Math.floor(viewY + (row + 0.5) * visibleH / GRID_ROWS)))
            };
        }

        function drillInto(col, row) {
            const point = mapPoint(col, row);
            const next = Math.min(MAX_ZOOM, zoom * 2);
            zoom = next;
            viewX = Math.round(point.x - MAP_W / zoom / 2);
            viewY = Math.round(point.y - MAP_H / zoom / 2);
            updateView();
        }

        function pendingKey(x, y) {
            return x + "," + y;
        }

        function placePixel(x, y) {
            if (sending) {
                outerStatus("Wait for the current upload to finish.");
                return;
            }
            const key = pendingKey(x, y);
            let existing = pending[key];
            if (selectedColor === 0 && existing) {
                removePendingKeys([key]);
                updateStats();
                return;
            }
            if (!existing && availableBalance() <= 0) {
                outerStatus("No pixels available yet.");
                return;
            }

            if (!existing) {
                existing = pending[key] = { x: x, y: y, color: selectedColor };
                pendingOrder.push(key);
                const panel = $.CreatePanel("Panel", pendingLayer, "");
                panel.AddClass("mg-px-pending-pixel");
                try { panel.SetAttributeString("hittest", "false"); } catch (e) {}
                pendingPanels[key] = panel;
            } else {
                existing.color = selectedColor;
            }
            pendingPanels[key].SetHasClass("mg-px-pending-erase", selectedColor === 0);
            pendingPanels[key].style.backgroundColor =
                selectedColor === 0 ? "#00000000" : (PALETTE[selectedColor - 1] || "#ffffff");
            positionPending(existing, pendingPanels[key]);
            updateStats();
        }

        function positionPending(pixel, panel) {
            // At max zoom one logical canvas pixel is exactly one hit-grid cell. Do
            // not compute a separate px transform: ui-scale can round that
            // transform differently from the flowed grid (especially at 125%
            // and 150%). Parenting the fill to the cell makes divergence
            // impossible because both now use the same rounded rectangle.
            if (zoom !== MAX_ZOOM) {
                // Keep queued work visible in the overview. Precise editing is
                // disabled there, so this lightweight preview may use viewport
                // coordinates; the exact cell-parenting path below is reserved
                // for the max-zoom editor where alignment matters.
                try {
                    if (panel.GetParent && panel.GetParent() !== pendingLayer) panel.SetParent(pendingLayer);
                } catch (e0) {}
                const visibleW = MAP_W / zoom;
                const visibleH = MAP_H / zoom;
                const left = Math.floor((pixel.x - viewX) * VIEW_W / visibleW);
                const right = Math.floor((pixel.x + 1 - viewX) * VIEW_W / visibleW);
                const top = Math.floor((pixel.y - viewY) * VIEW_H / visibleH);
                const bottom = Math.floor((pixel.y + 1 - viewY) * VIEW_H / visibleH);
                panel.style.visibility = "visible";
                panel.style.width = Math.max(1, right - left) + "px";
                panel.style.height = Math.max(1, bottom - top) + "px";
                panel.style.transform = `translate3d(${left}px, ${top}px, 0px)`;
                return;
            }
            let col = pixel.x - viewX;
            let row = pixel.y - viewY;
            const cell = row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS
                ? gridCells[row][col] : null;
            if (!cell) {
                panel.style.visibility = "collapse";
                return;
            }
            try {
                if (panel.GetParent && panel.GetParent() !== cell) panel.SetParent(cell);
            } catch (e) {}
            panel.style.visibility = "visible";
            // Fills the cell minus its 1px margin on each side (see .mg-px-pending-pixel). Derived
            // from the geometry rather than hard-coded, so resizing the viewport or the grid cannot
            // leave this stale - it was a literal 23px against the old 25px cell.
            panel.style.width = (VIEW_W / GRID_COLS - 2) + "px";
            panel.style.height = (VIEW_H / GRID_ROWS - 2) + "px";
            panel.style.transform = "translate3d(0px, 0px, 0px)";
        }

        function refreshPendingGeometry() {
            for (let i = 0; i < pendingOrder.length; i++) {
                const key = pendingOrder[i];
                if (pending[key] && pendingPanels[key]) positionPending(pending[key], pendingPanels[key]);
            }
        }

        function removePendingKeys(keys) {
            const removed = {};
            for (let i = 0; i < keys.length; i++) {
                removed[keys[i]] = true;
                if (pendingPanels[keys[i]]) {
                    try { pendingPanels[keys[i]].DeleteAsync(0); } catch (e) {}
                }
                delete pendingPanels[keys[i]];
                delete pending[keys[i]];
            }
            const kept = [];
            for (let j = 0; j < pendingOrder.length; j++) {
                if (!removed[pendingOrder[j]]) kept.push(pendingOrder[j]);
            }
            pendingOrder = kept;
        }

        function clearPending() {
            if (sending || pendingOrder.length === 0) return;
            removePendingKeys(pendingOrder.slice());
            updateStats();
            outerStatus("Local pixel queue cleared.");
        }

        function decodeBank(w, h) {
            if (h === 63) return { ok: false, reason: w };
            const value = h * 64 + w;
            return value >= 0 && value <= BANK_CAP ? { ok: true, balance: value } : { ok: false, reason: 5 };
        }

        function setServerBalance(value) {
            balance = Math.max(0, Math.min(BANK_CAP, value | 0));
            balanceAt = Date.now();
            updateStats();
        }

        function uploadPending() {
            if (banned || sending || pendingOrder.length < MIN_BATCH) return;
            if (!accountId) {
                outerStatus("Steam account id is not available yet.");
                return;
            }
            sending = true;
            updateStats();
            sendNextBatch();
        }

        function sendNextBatch() {
            if (destroyed || banned) return;
            const remaining = pendingOrder.length;
            if (remaining === 0) {
                sending = false;
                // Re-read the AUTHORITATIVE version instead of refreshing straight away. `v` is the
                // Panorama cache key, so refreshing with the pre-upload number would just re-serve
                // the cached pre-upload bitmap and your own paint would stay invisible until the
                // next poll. (The old code got away with `refreshRemote()` here only because it had
                // just faked a +1 bump - which is the lie removed above.) pollVersion fetches the
                // real number and schedules the refresh itself when it actually differs, so a
                // zero-change batch correctly redraws nothing.
                // Bump the generation first: scheduleVersionPoll's pending timer is keyed on it, so
                // this both kills the in-flight tick and prevents a second parallel poll chain.
                pollGeneration++;
                pollVersion();
                updateStats();
                outerStatus("Pixels placed.");
                return;
            }
            // With MIN_BATCH at 1 there is no "leftover too small to send" case any more, and no
            // need to hold back a remainder so the NEXT batch can reach the old minimum of 10 -
            // that arithmetic (`count = remaining - MIN_BATCH`) existed only to satisfy the server's
            // 10-pixel floor. Every pixel goes now, MAX_BATCH at a time.
            const count = Math.min(MAX_BATCH, remaining);
            const keys = pendingOrder.slice(0, count);
            const encoded = [];
            for (let i = 0; i < keys.length; i++) {
                const pixel = pending[keys[i]];
                encoded.push(pixel.x + "," + pixel.y + "," + pixel.color);
            }

            MG.Net.request("/api/pxput", { id: accountId, b: encoded.join(";") }, (w, h) => {
                if (destroyed) return;
                const result = decodeBank(w, h);
                if (!result.ok) {
                    if (result.reason === 5) {
                        showBanned();
                        return;
                    }
                    sending = false;
                    updateStats();
                    const errors = {
                        1: "Steam account id was rejected.",
                        2: "The server rejected the pixel batch.",
                        3: "The server says there are not enough pixels available.",
                        4: "Too many uploads. Wait a moment.",
                        5: "You are banned from Pixel Battle."
                    };
                    outerStatus(errors[result.reason] || "Pixel upload failed.");
                    requestBank();
                    return;
                }
                removePendingKeys(keys);
                setServerBalance(result.balance);
                sendNextBatch();
            }, () => {
                if (destroyed) return;
                sending = false;
                updateStats();
                outerStatus("Couldn't upload pixels. The local queue was kept.");
            });
        }

        function requestBank() {
            if (!accountId || destroyed || banned) return;
            MG.Net.request("/api/pxbank", { id: accountId }, (w, h) => {
                if (destroyed) return;
                const result = decodeBank(w, h);
                if (result.ok) setServerBalance(result.balance);
                else if (result.reason === 5) showBanned();
            }, () => {
                if (!destroyed) outerStatus("Using the local pixel estimate until the server responds.");
            });
        }

        // Coalesce viewport fetches. Every D-pad press, zoom step and RESET calls updateView, and
        // each one used to fire its own /api/pxview.png - a full-viewport render, straight through
        // SetImage so it bypasses mg_net's request queue entirely. At max zoom a pan step is 16 canvas
        // pixels, so crossing the map is dozens of presses and dozens of full frames. Waiting a
        // frame-and-a-bit collapses a burst of presses into ONE fetch of the final position; a
        // single press still lands well inside the eye's tolerance.
        // ⚠ Do NOT collapse crispImage here. It used to be hidden the moment a refresh was
        // scheduled, but the replacement frame only arrives 0.12s later plus a full FIFO
        // round-trip to the VPS - so the viewport went black for roughly half a second on every
        // pan, zoom and version poll (the "map disappears during the update" report, 2026-08-01).
        // The swap in refreshCrispView is already atomic: the new panel is sized and parented
        // before the old one is deleted, so leaving the old frame up costs nothing and the
        // transition is seamless. This is NOT the hiding that trap 23 forbids - that one is about
        // the INCOMING panel being loaded (a zero-opacity <Image> is never loaded at all); this is
        // the OUTGOING one, already loaded, and the loader never looks at it again.
        // crispReady still goes false, so clicks stay blocked until the frame actually matches.
        let crispGen = 0;
        let crispReady = false;
        function scheduleCrispView() {
            if (destroyed) return;
            crispReady = false;
            crispGen++;
            const myGen = crispGen;
            $.Schedule(0.12, () => { if (!destroyed && myGen === crispGen) refreshCrispView(); });
        }

        function refreshRemote() {
            if (destroyed) return;
            refreshCrispView();
        }

        function refreshCrispView() {
            if (destroyed || banned || !accountId) return;
            crispReady = false;         // the visible frame stays up, but it may no longer match
            const myGen = ++crispGen;     // a direct call supersedes pending/superseded frames
            // `v` is a CLIENT-side cache key only: /api/pxview never reads it (worker.core.js
            // routes on x/y/z and renders whatever version the canvas is at), so it exists purely
            // to stop Panorama serving a stale bitmap for an unchanged URL. It must therefore
            // track the SERVER's version and nothing else.
            // ⚠ There used to be an optimistic +1 bump of knownVersion after an accepted upload.
            // Two ways that lied. (a) The server skips the version bump entirely
            // when a batch changes nothing (`changed.length === 0`, worker.core.js:2867) - e.g.
            // erasing an already-blank pixel - so the client moved ahead of a canvas that never
            // changed. (b) The client wrapped at 4096 while the server wraps at PX_VERSION_MOD =
            // 63*64 = 4032, so after a server wrap the two were permanently 64 apart. Once ahead,
            // `version !== knownVersion` in pollVersion is satisfied by the SERVER's real value, so
            // the poll fires a refresh - but the refresh below then requests the client's inflated
            // `v`, which it may already have cached from the bogus bump, and Panorama serves that
            // stale bitmap. Result: another player's paint silently never appeared until you panned.
            // The upload path now leaves knownVersion alone; the 20s poll owns it, and the refresh
            // it triggers carries the server's number.
            const version = knownVersion < 0 ? 0 : knownVersion;
            const url = MG.Net.getBaseUrl() + "/api/pxview.png?x=" + viewX +
                "&y=" + viewY + "&z=" + zoom + "&id=" + accountId +
                "&v=" + version;
            MG.Net.loadImage(url, (loaded, loadedW, loadedH) => {
                if (destroyed || banned || myGen !== crispGen) {
                    try { loaded.SetImage(""); } catch (e0) {}
                    try { loaded.DeleteAsync(0); } catch (e1) {}
                    return;
                }
                // A real viewport is VIEW_W x VIEW_H multiplied by one uniform UI scale (and some setups
                // swap the axes), so its orientation-independent aspect stays near 2:1. Allow a
                // broad band because the invisible 640px net host may clamp the source width.
                // The Worker uses a deliberately distant image sentinel when one IP is churning uncached
                // viewports. Reject it before crispReady becomes true: stretching that sentinel and
                // accepting clicks would map the visible image to the wrong logical coordinates.
                const shortSide = Math.min(Number(loadedW), Number(loadedH));
                const longSide = Math.max(Number(loadedW), Number(loadedH));
                const aspect = shortSide > 0 ? longSide / shortSide : 0;
                if (!(aspect >= 1.4 && aspect <= 2.5)) {
                    try { loaded.SetImage(""); } catch (e2) {}
                    try { loaded.DeleteAsync(0); } catch (e3) {}
                    outerStatus("Map server is busy. Retrying…");
                    $.Schedule(1.2, () => {
                        if (!destroyed && !banned && myGen === crispGen) refreshCrispView();
                    });
                    return;
                }
                try {
                    // ⚠ Size/position BEFORE re-parenting into the visible layer. The panel comes
                    // back from loadImage laid out at the source's intrinsic size, so parenting it
                    // first showed an unscaled frame at the layer's top-left for one frame (the
                    // "images flash in the corner" report, 2026-08-01). It cannot be fixed by
                    // hiding the panel during the load: a zero-opacity <Image> is never loaded at
                    // all - see imageRequestNow in mg_net.js.
                    loaded.style.position = "0px 0px 0px";
                    loaded.style.width = VIEW_W + "px";
                    loaded.style.height = VIEW_H + "px";
                    loaded.style.visibility = "visible";
                    try { loaded.SetAttributeString("hittest", "false"); } catch (e4) {}
                    loaded.SetParent(crispLayer);
                    const old = crispImage;
                    crispImage = loaded;
                    if (old && old !== loaded) {
                        try { old.SetImage(""); } catch (e5) {}
                        try { old.DeleteAsync(0); } catch (e6) {}
                    }
                    crispReady = true;
                    if (lastOuterStatus === "Map server is busy. Retrying…") {
                        outerStatus("Shared world loaded.");
                    }
                } catch (e7) {
                    try { loaded.SetImage(""); } catch (e8) {}
                    try { loaded.DeleteAsync(0); } catch (e9) {}
                    outerStatus("Couldn't display the pixel-perfect map viewport.");
                    scheduleCrispRetry(myGen);
                }
            }, () => {
                if (!destroyed && !banned && myGen === crispGen) {
                    outerStatus("Couldn't load the pixel-perfect map viewport.");
                    scheduleCrispRetry(myGen);
                }
            }, { scaling: "none" });
        }

        // Both failure paths above leave the PREVIOUS frame on screen (it is no longer blanked)
        // while crispReady stays false, so the map looks perfectly normal but every grid click is
        // refused with "Map view is still loading." forever. Before the blanking was removed the
        // player at least saw a black viewport and knew something was wrong; now the wedge is
        // invisible, so it has to self-heal. The busy-sentinel path already retried on its own
        // 1.2s timer - these two just never did. Same generation guard, slightly longer delay
        // because these follow a real transport failure (loadImage has already burned its own
        // retry plus an 8s timeout) rather than a deliberate server "come back later".
        function scheduleCrispRetry(gen) {
            $.Schedule(2.5, () => {
                if (!destroyed && !banned && gen === crispGen) refreshCrispView();
            });
        }

        function pollVersion() {
            if (destroyed || banned || !accountId) return;
            if (sending) {
                scheduleVersionPoll(POLL_ACTIVE_S);
                return;
            }
            MG.Net.request("/api/pxversion", { id: accountId }, (w, h) => {
                if (destroyed) return;
                if (h === 63 && w === 5) {
                    showBanned();
                    return;
                }
                const version = h * 64 + w;
                const firstVersion = knownVersion < 0;
                if (version !== knownVersion) {
                    knownVersion = version;
                    versionMisses = 0;
                    // The initial /pxview is always rendered from the Worker's
                    // current version, even though the client does not know its
                    // number yet. Do not download that same frame twice on open.
                    if (!firstVersion) $.Schedule(0.1, refreshRemote);
                } else {
                    versionMisses++;
                }
                const delay = versionMisses < 2 ? POLL_ACTIVE_S :
                    (versionMisses < 6 ? POLL_WARM_S : POLL_IDLE_S);
                scheduleVersionPoll(delay);
            }, () => {
                if (!destroyed) scheduleVersionPoll(POLL_IDLE_S);
            });
        }

        function scheduleVersionPoll(delay) {
            const generation = pollGeneration;
            $.Schedule(delay, () => {
                if (!destroyed && !banned && generation === pollGeneration) pollVersion();
            });
        }

        for (let row = 0; row < GRID_ROWS; row++) {
            var rowPanel = $.CreatePanel("Panel", grid, "");
            rowPanel.AddClass("mg-px-grid-row");
            gridCells[row] = [];
            for (let col = 0; col < GRID_COLS; col++) {
                ((cellCol, cellRow) => {
                    var cell = $.CreatePanel("Panel", rowPanel, "");
                    cell.AddClass("mg-px-grid-cell");
                    gridCells[cellRow][cellCol] = cell;
                    cell.SetPanelEvent("onmouseover", () => {
                        var point = mapPoint(cellCol, cellRow);
                        coordLabel.text = zoom === MAX_ZOOM
                            ? (`PIXEL  ${point.x}, ${point.y}`)
                            : (`REGION  ${point.x}, ${point.y}   ·   CLICK TO ZOOM`);
                    });
                    cell.SetPanelEvent("onactivate", () => {
                        // Grid geometry changes immediately on pan/zoom, while its matching
                        // server-rasterised frame arrives asynchronously. Never let a click
                        // target a blank or stale map while that frame is still in the FIFO.
                        if (!crispReady) {
                            outerStatus("Map view is still loading.");
                            return;
                        }
                        if (zoom < MAX_ZOOM) drillInto(cellCol, cellRow);
                        else {
                            var point = mapPoint(cellCol, cellRow);
                            placePixel(point.x, point.y);
                        }
                    });
                })(col, row);
            }
        }

        function showBanned() {
            if (destroyed || banned) return;
            banned = true;
            accessReady = false;
            sending = false;
            pollGeneration++;
            markBanned(accountId);
            try { crispImage.SetImage(""); } catch (e1) {}
            try { root.RemoveAndDeleteChildren(); } catch (e2) {}
            root.AddClass("mg-px-banned");
            addLabel(root, "mg-px-ban-title", "YOU ARE BANNED");
            addLabel(root, "mg-px-ban-copy", "Pixel Battle is unavailable for this Steam account.");
            outerStatus("You are banned from Pixel Battle.");
        }

        function tickStats() {
            if (destroyed || banned) return;
            updateStats();
            $.Schedule(1, tickStats);
        }

        updatePalette();
        updateStats();
        tickStats();
        outerStatus("Checking Pixel Battle access…");
        checkAccess((result) => {
            if (destroyed) return;
            accountId = result.accountId || "";
            if (result.status === "banned") {
                showBanned();
                return;
            }
            if (result.status !== "allowed") {
                outerStatus("Steam account id or Pixel Battle access could not be verified.");
                return;
            }
            accessReady = true;
            setServerBalance(result.balance);
            updateView();
            pollVersion();
            outerStatus("Shared world loaded. Click the map to zoom in.");
        });

        return {
            destroy: function () {
                destroyed = true;
                pollGeneration++;
                try { crispImage.SetImage(""); } catch (e3) {}
                try { root.DeleteAsync(0); } catch (e4) {}
            }
        };
    }

    if (MG.Games && MG.Games.register) {
        MG.Games.register({ id: 7, enabled: true, create: createPixelBattle });
    }
})();
