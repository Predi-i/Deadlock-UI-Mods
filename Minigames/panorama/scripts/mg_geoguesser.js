/*
 * GeoGuesser - five server-authoritative panorama rounds for online or solo play.
 *
 * The VPS chooses the hidden location and proxies a fixed open-licensed 2:1
 * equirectangular image. Panorama has no projection shader, so the view is a
 * clipped, wrapped image strip. Native DragStart/DragEnd (the chess/checkers
 * recipe) turns a release displacement into yaw/pitch. Panorama does not expose
 * a global pointer-move callback, so native Sliders provide continuous heading
 * and pitch updates while their thumbs are being dragged.
 */
(() => {
    "use strict";

    const MG = $.MG = $.MG || {};
    if (MG.GeoGuesser) return;
    MG.GeoGuesser = {};

    // GRID_W/H is the size of the on-screen hit grid (panel count), NOT the guess resolution.
    // At zoom Z it covers 1/Z of the world, so the addressable resolution is GRID_W*Z x GRID_H*Z.
    const GRID_W = 64, GRID_H = 32, ROUNDS = 5;
    // FULL_W/H is the AUTHORITATIVE guess space and must match GEO_GRID_W/H in worker.core.js
    // (mirrored on MG.Net so there is one number to change). GRID_* x MAP_ZOOM_MAX lands exactly
    // here: 64*8 = 512, 32*8 = 256.
    const FULL_W = 512, FULL_H = 256;
    const MARKER_SZ = 9;
    // ⚠ Must match .mg-geo-viewport in mg.css. The viewport is 860 wide so it lines up with the
    // map row below it (all four GeoGuesser rows are 860).
    const VIEW_W = 860, VIEW_H = 360;
    // ⚠ Must match .mg-geo-map / .mg-geo-map-zoom.
    const MAP_W = 500, MAP_H = 250, MAP_ZOOM_MAX = 8;
    // Two clicks inside this window are a double-click. The engine has no ondblclick event.
    const MULTI_CLICK_MS = 400;
    const PANO_W = 2880, PANO_H = 1440, PANO_STEP = PANO_W - 2;
    // ⚠ Declared AFTER PANO_H, not before: `var` hoists the name but not the value, so reading
    // PANO_H one line earlier yields undefined and this constant silently becomes NaN — which
    // would break tilt entirely while every syntax check still passed.
    // The strip is 1440px tall for 180° of pitch, i.e. 8px per degree. The old hard-coded 4
    // moved the image at half the rate the geometry calls for.
    const PITCH_PX_PER_DEG = PANO_H / 180;
    // ⚠ `"stretch-to-fit"` is NOT a token this engine accepts. Grepping every <Image> in
    // G:\GameTracking-Deadlock yields only: stretch-to-fit-preserve-aspect (31), cover (4),
    // stretch-to-fit-y-preserve-aspect (3), stretch-to-cover-preserve-aspect (2), contain (2)
    // (`stretch` exists but only on MoviePanel). An unknown token silently falls back to the
    // DEFAULT — native size, centred in the panel — it does NOT error. With a 2048x1024 Panoramax
    // SD source in this 2880x1440 box that left a (2880-2048)/2 = 416px dead margin each side and
    // (1440-1024)/2 = 208px top and bottom: exactly the black frame, and exactly the "only about
    // 95°..270° looks right" window the maintainer measured in-game (2026-07-31).
    // `cover` is the right choice: it always fills the box, so the yaw/pitch maths can rely on the
    // strip being exactly PANO_W x PANO_H. For the 2:1 equirectangular sources it is a pixel-exact
    // fill with zero cropping; a preserve-aspect token would re-introduce letterboxing (and this
    // whole class of bug) the instant a source is not exactly 2:1.
    const PANO_SCALING = "cover";
    const REGIONS = ["Europe", "North America", "South America", "Africa", "Asia", "Oceania"];

    // Render the reveal's place code (see MG.Api.geoPlace). Codes at or above 6 pack a country
    // index and its display continent, both decided offline at pool build time; below 6 the
    // panorama could not be placed and only the region is known.
    function placeLabel(place) {
        if (place < 6) return REGIONS[place] || "Location revealed";
        const packed = place - 6;
        const names = MG.GeoCountries || [];
        const country = names[Math.floor(packed / 6)];
        const region = REGIONS[packed % 6];
        if (!country) return region || "Location revealed";
        return region ? region + " · " + country : country;
    }

    function addLabel(parent, cls, text) {
        let label = $.CreatePanel("Label", parent, "");
        const classes = String(cls || "").split(/\s+/);
        for (let i = 0; i < classes.length; i++) if (classes[i]) label.AddClass(classes[i]);
        label.text = text || "";
        return label;
    }

    function addButton(parent, cls, text, callback) {
        const button = $.CreatePanel("Button", parent, "");
        const classes = String(cls || "").split(/\s+/);
        for (let i = 0; i < classes.length; i++) if (classes[i]) button.AddClass(classes[i]);
        button._mgLabel = addLabel(button, "mg-geo-button-label", text);
        button.SetPanelEvent("onactivate", callback);
        return button;
    }

    function createGeoGuesser(container, session) {
        session = session || {};
        let destroyed = false;
        const root = $.CreatePanel("Panel", container, "MG_GeoGuesser");
        root.AddClass("mg-geo");
        const code = session.code;
        const tok = session.tok || "";
        const mySeat = session.isHost ? 0 : 1;
        const solo = !!session.solo;
        let currentRound = -1;
        let revealRound = -1;
        let selectedCell = -1;
        let yaw = 0, pitch = 0;
        let panoramaGen = 0;
        let panoramaReady = false;
        let pollMisses = 0;
        let sendingGuess = false;
        // Set once this seat's guess is accepted by the server. Distinct from sendingGuess (in
        // flight) and from the reveal: between locking in and the opponent answering, the round is
        // still open but this player is done, so the clock must be off.
        let guessLocked = false;
        let sendingNext = false;
        let finished = false;
        let revealReadsPending = 0;
        const scores = [0, 0];
        const cells = [];
        let panoImages = [];
        let dragGhost = null, dragStartPos = null;
        let syncingCameraSliders = false;
        let lastStageX = null;
        let mapZoomLevel = 1, clickRun = 0, lastClickAt = 0;
        let panX = 0, panY = 0;
        let markers = [];
        const cityLabels = [];

        const stats = $.CreatePanel("Panel", root, "");
        stats.AddClass("mg-geo-stats");
        const roundLabel = addLabel(stats, "mg-geo-stat", "Round 1 / " + ROUNDS);
        const viewLabel = addLabel(stats, "mg-geo-view-label", "Drag to look around");
        const scoreLabel = addLabel(stats, "mg-geo-stat mg-geo-score",
            solo ? "Score 0" : "You 0 · Opponent 0");

        const viewport = $.CreatePanel("Panel", root, "");
        viewport.AddClass("mg-geo-viewport");
        const stage = $.CreatePanel("Panel", viewport, "");
        stage.AddClass("mg-geo-stage");
        // Arm the transition a frame after creation, the .mg-piece/.mg-dk-anim idiom: the stage's
        // first committed transform is its baseline and must not slide in from the corner.
        $.Schedule(0.0, () => {
            if (!destroyed && stage && stage.IsValid && stage.IsValid()) stage.AddClass("mg-geo-anim");
        });
        const loading = addLabel(viewport, "mg-geo-loading", "Loading panorama…");
        const dragHandle = $.CreatePanel("Panel", viewport, "");
        dragHandle.AddClass("mg-geo-drag-handle");

        const cameraControls = $.CreatePanel("Panel", root, "");
        cameraControls.AddClass("mg-geo-camera-controls");
        addLabel(cameraControls, "mg-geo-slider-label", "LOOK");
        addButton(cameraControls, "mg-geo-camera-button", "◀", () => { turn(-20, 0); });
        const yawSlider = $.CreatePanel("Slider", cameraControls, "", { direction: "horizontal" });
        yawSlider.AddClass("HorizontalSlider");
        yawSlider.AddClass("mg-geo-yaw-slider");
        yawSlider.min = 0;
        yawSlider.max = 359;
        yawSlider.value = 0;
        addButton(cameraControls, "mg-geo-camera-button", "▶", () => { turn(20, 0); });
        addLabel(cameraControls, "mg-geo-slider-label mg-geo-pitch-label", "TILT");
        addButton(cameraControls, "mg-geo-camera-button", "▼", () => { turn(0, -10); });
        const pitchSlider = $.CreatePanel("Slider", cameraControls, "", { direction: "horizontal" });
        pitchSlider.AddClass("HorizontalSlider");
        pitchSlider.AddClass("mg-geo-pitch-slider");
        pitchSlider.min = -30;
        pitchSlider.max = 30;
        pitchSlider.value = 0;
        addButton(cameraControls, "mg-geo-camera-button", "▲", () => { turn(0, 10); });
        addButton(cameraControls, "mg-geo-camera-button mg-geo-reset-button", "RESET", () => {
            yaw = 0; pitch = 0; applyCamera();
        });

        // ── round timer ───────────────────────────────────────────────────────────────────
        // 60s per location, not the shared 25s default: a GeoGuesser round is explore-then-place,
        // and 25s is barely enough to spin the panorama once. The widget takes a per-call override.
        //
        // Attached to `container` (.mg-game-host, flow-children:none), NOT to the .mg-geo column:
        // the bar positions itself with vertical-align, which a flow-children:down parent ignores,
        // and inside the column it would push the panorama down instead of floating beside it.
        // No boardW either - GeoGuesser is 860 wide against an 844 inner zone, so the board-edge
        // shove clamps back to the gutter anyway (poker/durak omit it for the same reason).
        const ROUND_SECS = 60;
        const roundTimer = (MG.Widgets && MG.Widgets.createTurnTimer)
            ? MG.Widgets.createTurnTimer(container, {}) : null;
        let timerOn = false;

        // On the clock only while this seat can still act: a round is live once the panorama is up
        // and stays live until the guess is in or the reveal lands.
        function refreshTimer() {
            if (!roundTimer) return;
            const live = !destroyed && !finished && currentRound >= 0 &&
                revealRound !== currentRound && !sendingGuess && !guessLocked;
            if (live === timerOn) return;
            timerOn = live;
            if (!live) { roundTimer.stop(); return; }
            roundTimer.start(onRoundTimeout, ROUND_SECS);
        }

        // Timeout must not stall the other seat: the server reveals only once BOTH have guessed, so
        // running out submits whatever is selected, or cell 0 when nothing is - a deliberate
        // maximum-distance answer rather than a dead lobby.
        function onRoundTimeout() {
            timerOn = false;
            if (destroyed || finished || revealRound === currentRound || sendingGuess) return;
            if (selectedCell < 0) selectedCell = 0;
            prompt.text = "Time expired. Your guess was submitted.";
            submitGuess();
        }

        const lower = $.CreatePanel("Panel", root, "");
        lower.AddClass("mg-geo-lower");
        const mapCol = $.CreatePanel("Panel", lower, "");
        mapCol.AddClass("mg-geo-map-col");
        const map = $.CreatePanel("Panel", mapCol, "");
        map.AddClass("mg-geo-map");
        // ⚠ ONLY the image, the city labels and the reveal markers live in the zoom wrapper, so
        // they pan and scale with the map. The hit grid is deliberately a SIBLING (below), fixed
        // over the window: if it scaled too, zooming would just enlarge the same 64x32 cells and
        // buy no precision at all — which is exactly how it behaved before.
        const mapZoom = $.CreatePanel("Panel", map, "");
        mapZoom.AddClass("mg-geo-map-zoom");
        const mapImage = $.CreatePanel("Image", mapZoom, "", { scaling: "stretch-to-fit-preserve-aspect" });
        mapImage.AddClass("mg-geo-map-image");
        mapImage.SetImage("s2r://panorama/images/geoguesser/world_map.vtex");
        try { mapImage.SetAttributeString("hittest", "false"); } catch (e0) {}
        const labelLayer = $.CreatePanel("Panel", mapZoom, "");
        labelLayer.AddClass("mg-geo-label-layer");
        try { labelLayer.SetAttributeString("hittest", "false"); } catch (e0b) {}
        const markerLayer = $.CreatePanel("Panel", mapZoom, "");
        markerLayer.AddClass("mg-geo-marker-layer");
        try { markerLayer.SetAttributeString("hittest", "false"); } catch (e0c) {}

        // The hit grid: 64x32 transparent buttons pinned to the 500x250 window. At zoom Z they
        // span 1/Z of the world, so the addressable resolution is 64Z x 32Z — 512x256 at 8x.
        const grid = $.CreatePanel("Panel", map, "");
        grid.AddClass("mg-geo-grid");
        for (let row = 0; row < GRID_H; row++) {
            var rowPanel = $.CreatePanel("Panel", grid, "");
            rowPanel.AddClass("mg-geo-grid-row");
            for (let col = 0; col < GRID_W; col++) {
                ((r, c) => {
                    var hit = $.CreatePanel("Button", rowPanel, "");
                    hit.AddClass("mg-geo-cell");
                    hit.SetPanelEvent("onactivate", () => { clickCell(r, c); });
                    cells.push(hit);
                })(row, col);
            }
        }
        const mapHint = addLabel(mapCol, "mg-geo-map-hint",
            "Double-click to zoom in · triple-click to reset");

        const side = $.CreatePanel("Panel", lower, "");
        side.AddClass("mg-geo-side");
        const prompt = addLabel(side, "mg-geo-prompt", "Explore the panorama, then choose a point on the map.");
        const revealPlace = addLabel(side, "mg-geo-place", "");
        const revealCredit = addLabel(side, "mg-geo-credit", "");
        // Eats the slack so the action button still sits on the bottom edge now that the labels
        // above are fit-children (an empty reveal label collapses to zero instead of holding 88px).
        $.CreatePanel("Panel", side, "").AddClass("mg-geo-side-spacer");
        const actionButton = addButton(side, "mg-btn mg-btn-primary mg-geo-action", "SUBMIT GUESS", submitGuess);

        function outerStatus(text) {
            if (session.onStatus) session.onStatus(text);
        }

        function setAction(text, enabled, callback) {
            let label = actionButton._mgLabel;
            if (label) label.text = text;
            actionButton.SetHasClass("mg-btn-inert", !enabled);
            try { actionButton.enabled = !!enabled; } catch (e) {}
            actionButton.SetPanelEvent("onactivate", enabled ? callback : () => {});
        }

        function turn(dx, dy) {
            if (!panoramaReady) return;
            yaw += dx;
            pitch += dy;
            applyCamera();
        }

        function applyCamera() {
            while (yaw < 0) yaw += 360;
            while (yaw >= 360) yaw -= 360;
            pitch = Math.max(-30, Math.min(30, pitch));
            syncingCameraSliders = true;
            yawSlider.value = Math.round(yaw);
            pitchSlider.value = Math.round(pitch);
            syncingCameraSliders = false;
            const point = PANO_STEP + yaw * PANO_STEP / 360;
            const x = VIEW_W / 2 - point;
            const y = -(PANO_H - VIEW_H) / 2 + pitch * PITCH_PX_PER_DEG;
            // A 359°→0° step re-centres the strip by a whole PANO_STEP. Left animated, that 2878px
            // slide plays out over the 0.04s transition and looks like a full-speed spin. Detect it
            // by size (any genuine turn moves far less than half a strip) and commit that one frame
            // with the transition class removed.
            const wrapped = lastStageX !== null && Math.abs(x - lastStageX) > PANO_STEP / 2;
            if (wrapped) stage.RemoveClass("mg-geo-anim");
            stage.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            lastStageX = x;
            if (wrapped) {
                $.Schedule(0.0, () => {
                    if (!destroyed && stage && stage.IsValid && stage.IsValid()) stage.AddClass("mg-geo-anim");
                });
            }
            viewLabel.text = "Heading " + Math.round(yaw) + "° · pitch " + Math.round(pitch) + "°";
        }

        // ── map zoom + coordinate mapping ─────────────────────────────────────────────────
        // panX/panY are the top-left of the visible window in WORLD fractions (0..1). The hit
        // grid is fixed over the window, so a grid cell (r,c) addresses the world fraction
        // panX + (c + 0.5) / GRID_W / zoom — i.e. the finer the zoom, the finer the guess.
        // The authoritative cell index is always in FULL_W x FULL_H space, matching the server.
        function worldFractionOf(row, col) {
            return {
                x: panX + (col + 0.5) / (GRID_W * mapZoomLevel),
                y: panY + (row + 0.5) / (GRID_H * mapZoomLevel)
            };
        }

        function cellFromFraction(fx, fy) {
            const x = Math.max(0, Math.min(FULL_W - 1, Math.floor(fx * FULL_W)));
            const y = Math.max(0, Math.min(FULL_H - 1, Math.floor(fy * FULL_H)));
            return y * FULL_W + x;
        }

        // Inverse: where a world cell sits inside the CURRENT window, in grid units. Returns null
        // when it is scrolled out of view, so a marker off-window is simply not drawn.
        function fractionToWindow(fx, fy) {
            const wx = (fx - panX) * mapZoomLevel;
            const wy = (fy - panY) * mapZoomLevel;
            if (wx < 0 || wx >= 1 || wy < 0 || wy >= 1) return null;
            return { x: wx * MAP_W, y: wy * MAP_H };
        }

        function setMapZoom(level, focusFx, focusFy) {
            mapZoomLevel = Math.max(1, Math.min(MAP_ZOOM_MAX, level));
            const w = MAP_W * mapZoomLevel, h = MAP_H * mapZoomLevel;
            mapZoom.style.width = Math.round(w) + "px";
            mapZoom.style.height = Math.round(h) + "px";
            if (mapZoomLevel <= 1 || focusFx == null) {
                panX = 0; panY = 0;
            } else {
                // Centre the focus, then clamp so the window never runs past the map edge.
                const span = 1 / mapZoomLevel;
                panX = Math.max(0, Math.min(1 - span, focusFx - span / 2));
                panY = Math.max(0, Math.min(1 - span, focusFy - span / 2));
            }
            mapZoom.style.transform = "translate3d(" +
                Math.round(-panX * w) + "px, " + Math.round(-panY * h) + "px, 0px)";
            mapHint.text = mapZoomLevel > 1
                ? "Zoom " + mapZoomLevel + "× · cell ~" + Math.round(40000 / (GRID_W * mapZoomLevel)) +
                  " km · triple-click to reset"
                : "Double-click to zoom in · triple-click to reset";
            refreshCityLabels();
            refreshMarkers();
        }

        function clickCell(row, col) {
            const now = Date.now();
            clickRun = (now - lastClickAt < MULTI_CLICK_MS) ? clickRun + 1 : 1;
            lastClickAt = now;
            const f = worldFractionOf(row, col);
            // Always select first: the guess must respond on the very first click, with no
            // debounce delay waiting to find out whether a second one is coming.
            selectCell(cellFromFraction(f.x, f.y));
            if (clickRun === 2) setMapZoom(mapZoomLevel * 2, f.x, f.y);
            else if (clickRun >= 3) setMapZoom(1, null, null);
        }

        // ── city labels ───────────────────────────────────────────────────────────────────
        // Drawn as Panorama Labels rather than baked into the PNG (the build's encoder has no
        // font renderer), so the text stays crisp at every zoom.
        //
        // Two gates decide what shows. The RANK gate keeps the world view sparse: at 1x only the
        // 27 rank-0 capitals are candidates (rank<=1 put 68 names on a 500px map and the Balkans
        // became an unreadable pile). The OVERLAP gate then drops any label whose box would touch
        // one already placed - which is what a real atlas does, and the only thing that actually
        // fixes clusters, since no rank threshold can separate Ljubljana from Zagreb.
        function cityRankLimit() {
            if (mapZoomLevel >= 8) return 9;
            if (mapZoomLevel >= 4) return 4;
            if (mapZoomLevel >= 2) return 3;
            return 0;
        }

        // Panorama cannot measure a Label before it lays out, so estimate: radiance at 11px runs
        // about 5.6px per character. Only relative sizes matter here - the estimate decides
        // spacing, not painting.
        const CITY_CHAR_W = 5.6, CITY_LABEL_H = 13, CITY_PAD_X = 3, CITY_PAD_Y = 2;

        function refreshCityLabels() {
            const list = MG.GeoCities || [];
            const limit = cityRankLimit();
            const placed = [];
            // The window's own rectangle in the zoom layer's px space. Labels outside it are
            // culled BEFORE the overlap test: the layer is far wider than the 500px window once
            // zoomed, and an off-screen name must not win a slot from a visible one.
            const viewLeft = panX * MAP_W * mapZoomLevel;
            const viewTop = panY * MAP_H * mapZoomLevel;
            const viewRight = viewLeft + MAP_W;
            const viewBottom = viewTop + MAP_H;
            for (let i = 0; i < list.length; i++) {
                const city = list[i];
                let label = cityLabels[i];
                let show = city.r <= limit;
                let left = 0, top = 0;
                if (show) {
                    // The manifest is sorted by rank, so the first fit wins and a more prominent
                    // city always beats a lesser one for the same patch of map.
                    left = city.x * MAP_W * mapZoomLevel + 4;
                    top = city.y * MAP_H * mapZoomLevel - 7;
                    const right = left + city.n.length * CITY_CHAR_W;
                    const bottom = top + CITY_LABEL_H;
                    if (right < viewLeft || left > viewRight ||
                        bottom < viewTop || top > viewBottom) {
                        show = false;
                    }
                    for (let p = 0; show && p < placed.length; p++) {
                        const other = placed[p];
                        if (left - CITY_PAD_X < other[2] && right + CITY_PAD_X > other[0] &&
                            top - CITY_PAD_Y < other[3] && bottom + CITY_PAD_Y > other[1]) {
                            show = false;
                        }
                    }
                    if (show) placed.push([left, top, right, bottom]);
                }
                if (show && !label) {
                    label = $.CreatePanel("Label", labelLayer, "");
                    label.AddClass("mg-geo-city");
                    label.text = city.n;
                    try { label.SetAttributeString("hittest", "false"); } catch (e) {}
                    cityLabels[i] = label;
                }
                if (!label) continue;
                label.visible = show;
                if (!show) continue;
                // Positioned in the zoom layer's own space, so it pans and scales with the map.
                label.style.transform = "translate3d(" +
                    Math.round(left) + "px, " + Math.round(top) + "px, 0px)";
            }
        }

        // ── markers ───────────────────────────────────────────────────────────────────────
        // A marker is a world position, not a grid cell: it must stay put when the player zooms
        // or pans (the old code tagged a grid button, which pointed at a different place the
        // moment the window moved).
        function addMarker(cell, cls) {
            if (cell == null || cell < 0) return;
            markers.push({
                x: (cell % FULL_W + 0.5) / FULL_W,
                y: (Math.floor(cell / FULL_W) + 0.5) / FULL_H,
                cls: cls,
                panel: null
            });
            refreshMarkers();
        }

        function refreshMarkers() {
            for (let i = 0; i < markers.length; i++) {
                const m = markers[i];
                if (!m.panel) {
                    m.panel = $.CreatePanel("Panel", markerLayer, "");
                    m.panel.AddClass("mg-geo-marker");
                    m.panel.AddClass(m.cls);
                    try { m.panel.SetAttributeString("hittest", "false"); } catch (e) {}
                }
                const at = fractionToWindow(m.x, m.y);
                m.panel.visible = !!at;
                if (!at) continue;
                m.panel.style.transform = "translate3d(" +
                    Math.round(m.x * MAP_W * mapZoomLevel - MARKER_SZ / 2) + "px, " +
                    Math.round(m.y * MAP_H * mapZoomLevel - MARKER_SZ / 2) + "px, 0px)";
            }
        }

        function clearMarkers() {
            for (let i = 0; i < markers.length; i++) {
                if (markers[i].panel) { try { markers[i].panel.DeleteAsync(0); } catch (e) {} }
            }
            markers = [];
        }

        yawSlider.SetPanelEvent("onvaluechanged", () => {
            if (syncingCameraSliders || !panoramaReady) return;
            const nextYaw = Number(yawSlider.value);
            if (!isFinite(nextYaw)) return;
            yaw = nextYaw;
            applyCamera();
        });
        pitchSlider.SetPanelEvent("onvaluechanged", () => {
            if (syncingCameraSliders || !panoramaReady) return;
            const nextPitch = Number(pitchSlider.value);
            if (!isFinite(nextPitch)) return;
            pitch = nextPitch;
            applyCamera();
        });

        function clearPanorama() {
            for (let i = 0; i < panoImages.length; i++) {
                try { panoImages[i].SetImage(""); } catch (e) {}
                try { panoImages[i].DeleteAsync(0); } catch (e2) {}
            }
            panoImages = [];
        }

        function configurePanoImage(image, offset) {
            image.SetParent(stage);
            image.AddClass("mg-geo-pano-image");
            image.style.width = PANO_W + "px";
            image.style.height = PANO_H + "px";
            image.style.transform = "translate3d(" + offset + "px, 0px, 0px)";
            try { image.SetAttributeString("hittest", "false"); } catch (e) {}
            panoImages.push(image);
        }

        // The two side copies MUST come through MG.Net.loadImage, i.e. the same strict FIFO as
        // every other image (§5 "Request discipline"). ⚠ The previous version created its own
        // <Image> and called SetImage(url) directly: two independent loads fired 60ms and 120ms
        // after the centre copy, overlapping each other AND the running polls. That is exactly
        // the documented wedge - the pending loads stall at dims 0 and never paint - so the side
        // copies were simply absent. Symptom in-game: a mostly BLACK viewport whose visible
        // strip is only the centre copy, and a near-empty frame once heading walks onto a
        // missing neighbour (maintainer's 182°/349° screenshots). Not a projection bug.
        // The URL is identical for all three, so the engine serves the neighbours from cache.
        function addCachedCopy(url, offset, myGen, done) {
            if (destroyed || myGen !== panoramaGen) return;
            MG.Net.loadImage(url, (copy) => {
                if (destroyed || myGen !== panoramaGen) {
                    try { copy.SetImage(""); copy.DeleteAsync(0); } catch (e) {}
                    return;
                }
                configurePanoImage(copy, offset);
                if (done) done();
            }, () => {
                // A missing neighbour only costs the wrap at that edge; the round stays playable,
                // so surface nothing and let the centre copy carry the view.
                if (!destroyed && myGen === panoramaGen && done) done();
            }, { scaling: PANO_SCALING });
        }

        function loadPanorama(round) {
            panoramaReady = false;
            loading.text = "Loading panorama…";
            loading.style.visibility = "visible";
            clearPanorama();
            const myGen = ++panoramaGen;
            const url = MG.Net.getBaseUrl() + "/api/geoview.png?code=" + code +
                "&tok=" + encodeURIComponent(tok) + "&round=" + round + "&rnd=" + Math.random();
            MG.Net.loadImage(url, (image, loadedW, loadedH) => {
                if (destroyed || myGen !== panoramaGen) {
                    try { image.SetImage(""); image.DeleteAsync(0); } catch (e) {}
                    return;
                }
                // The shared request host is 640px wide and may report its clamped layout rather
                // than the source's intrinsic size. That is still a successful image;
                // layout dimensions cannot validate intrinsic aspect here. Reject only a small
                // level-encoded Worker error PNG, whose calibrated dimensions are 0..63.
                if (MG.Net.isLevelEncodedSize(loadedW, loadedH)) {
                    try { image.SetImage(""); image.DeleteAsync(0); } catch (e2) {}
                    loading.text = "Panorama unavailable. Retrying…";
                    $.Schedule(1.5, () => {
                        if (!destroyed && myGen === panoramaGen) loadPanorama(round);
                    });
                    return;
                }
                // Panoramax SD sources are consistently 2:1 and are stretched into the exact
                // 2880x1440 stage size. Keep the already-loaded panel as the centre copy, then
                // add two cached neighbours with a 2px overlap. The old 2160px spacing around a
                // 1920px source created the visible 240px black band at every seam.
                configurePanoImage(image, PANO_STEP);
                // Chain the neighbours through the FIFO instead of racing three fixed $.Schedule
                // timers: the old 0.06/0.12/0.18s ladder assumed each load finished inside its
                // slot, so `panoramaReady` (and the first applyCamera) fired while the side copies
                // were still loading - or never loaded at all. Now the left copy is requested,
                // then the right one, and only then is the viewport revealed.
                addCachedCopy(url, 0, myGen, () => {
                    addCachedCopy(url, PANO_STEP * 2, myGen, () => {
                        if (destroyed || myGen !== panoramaGen) return;
                        panoramaReady = true;
                        loading.style.visibility = "collapse";
                        applyCamera();
                    });
                });
            }, () => {
                if (destroyed || myGen !== panoramaGen) return;
                loading.text = "Couldn't load panorama. Retrying…";
                $.Schedule(1.5, () => {
                    if (!destroyed && myGen === panoramaGen) loadPanorama(round);
                });
            }, { scaling: PANO_SCALING });
        }

        function clearMapMarkers() {
            clearMarkers();
        }

        function selectCell(cell) {
            if (finished || revealRound === currentRound || sendingGuess) return;
            selectedCell = cell;
            // One pending-guess marker at a time; the reveal adds its own on top later.
            for (let i = markers.length - 1; i >= 0; i--) {
                if (markers[i].cls !== "mg-geo-selected") continue;
                if (markers[i].panel) { try { markers[i].panel.DeleteAsync(0); } catch (e) {} }
                markers.splice(i, 1);
            }
            addMarker(cell, "mg-geo-selected");
            setAction("SUBMIT GUESS", true, submitGuess);
            prompt.text = "Guess placed. Submit when ready.";
        }

        function submitGuess() {
            if (selectedCell < 0 || sendingGuess || finished || revealRound === currentRound) return;
            sendingGuess = true;
            refreshTimer();
            setAction("SUBMITTING…", false, submitGuess);
            MG.Api.geoGuess(code, tok, selectedCell, (result) => {
                if (destroyed) return;
                sendingGuess = false;
                if (!result.ok) {
                    prompt.text = "The server rejected that guess. Pick again.";
                    setAction("SUBMIT GUESS", true, submitGuess);
                    refreshTimer();
                    return;
                }
                guessLocked = true;
                refreshTimer();
                prompt.text = solo ? "Calculating result…" : "Guess locked. Waiting for the opponent…";
                setAction(solo ? "CALCULATING…" : "WAITING FOR OPPONENT", false, submitGuess);
                pollMisses = 0;
            }, () => {
                if (destroyed) return;
                sendingGuess = false;
                prompt.text = "Couldn't submit. Try again.";
                setAction("SUBMIT GUESS", true, submitGuess);
                // The guess never landed, so the round is still this player's to answer: put them
                // back on the clock rather than leaving a stalled seat with no deadline.
                refreshTimer();
            });
        }

        function beginRound(round) {
            currentRound = round;
            revealRound = -1;
            selectedCell = -1;
            sendingGuess = false;
            sendingNext = false;
            guessLocked = false;
            yaw = Math.floor(Math.random() * 24) * 15;
            pitch = 0;
            clearMapMarkers();
            // A new round must start on the full world map: a leftover 8x zoom from the previous
            // guess would drop the player into an unrelated region with no way to tell.
            setMapZoom(1, null, null);
            // The next frame is a different location, so there is nothing to animate FROM — clear
            // the wrap reference so the first applyCamera of the round can't be mistaken for a
            // seam crossing (and suppress its own transition for nothing).
            lastStageX = null;
            roundLabel.text = "Round " + (round + 1) + " / " + ROUNDS;
            revealPlace.text = "";
            revealCredit.text = "";
            prompt.text = "Explore the panorama, then choose a point on the map.";
            setAction("SELECT A MAP POINT", false, submitGuess);
            loadPanorama(round);
            // Force a restart rather than calling refreshTimer alone: the previous round may still
            // read as "live", and refreshTimer is edge-triggered, so it would see no change and
            // leave the old countdown running into the new round.
            timerOn = false;
            if (roundTimer) roundTimer.stop();
            // Start the clock with the round, not with the image: the panorama is proxied and can
            // take a second, and a timer that only began on load would hand a slow connection
            // extra thinking time.
            refreshTimer();
            outerStatus("GeoGuesser round " + (round + 1) + " of " + ROUNDS + ".");
        }

        function updateScoreText() {
            scoreLabel.text = solo ? "Score " + scores[mySeat]
                : "You " + scores[mySeat] + " · Opponent " + scores[1 - mySeat];
        }

        function revealReadDone(round) {
            if (destroyed || revealRound !== round || currentRound !== round) return;
            revealReadsPending = Math.max(0, revealReadsPending - 1);
            updateScoreText();
            if (revealReadsPending === 0) {
                setAction(currentRound + 1 >= ROUNDS ? "FINISH" : "NEXT ROUND", true, readyNext);
            }
        }

        function readReveal(fetcher, apply) {
            const round = currentRound;
            function attempt() {
                if (destroyed || revealRound !== round || currentRound !== round) return;
                fetcher((value) => {
                    if (destroyed || revealRound !== round || currentRound !== round) return;
                    apply(value);
                    revealReadDone(round);
                }, () => {
                    if (!destroyed && revealRound === round && currentRound === round) {
                        $.Schedule(0.8, attempt);
                    }
                });
            }
            attempt();
        }

        // A point now costs TWO reads (x then y): the 512x256 grid overflows the two-level
        // base-63 reply, so each axis comes back on its own request. Chain them so the marker is
        // only placed once both halves are in — a half-decoded point would land at the equator.
        function readPoint(fetch, cls) {
            readReveal((ok, fail) => { fetch(0, ok, fail); }, (x) => {
                readReveal((ok2, fail2) => { fetch(1, ok2, fail2); }, (y) => {
                    addMarker(y * FULL_W + x, cls);
                });
            });
        }

        function showReveal() {
            if (revealRound === currentRound) return;
            revealRound = currentRound;
            // The round is decided; nothing this seat does can change it, so take them off the
            // clock before the reveal reads start.
            refreshTimer();
            // Reads per reveal: target (2 axes) + my pick (2) [+ opponent pick (2)] + score
            // + place + credit. Place and credit are ONE request each now - the credit used to
            // arrive two characters per request, up to 26 chained round-trips, which is what made
            // this button sit on "LOADING RESULT…".
            revealReadsPending = solo ? 7 : 10;
            sendingGuess = false;
            prompt.text = "Round complete. Loading the authoritative reveal…";
            setAction("LOADING RESULT…", false, readyNext);
            readPoint((axis, ok, fail) => {
                MG.Api.geoTarget(code, tok, axis, ok, fail);
            }, "mg-geo-target");
            readPoint((axis, ok, fail) => {
                MG.Api.geoPick(code, tok, mySeat, axis, ok, fail);
            }, "mg-geo-me");
            if (!solo) {
                readPoint((axis, ok, fail) => {
                    MG.Api.geoPick(code, tok, 1 - mySeat, axis, ok, fail);
                }, "mg-geo-them");
            }
            readReveal((ok, fail) => { MG.Api.geoScore(code, tok, mySeat, ok, fail); }, (score) => {
                scores[mySeat] = score;
            });
            if (!solo) {
                readReveal((ok, fail) => { MG.Api.geoScore(code, tok, 1 - mySeat, ok, fail); }, (score) => {
                    scores[1 - mySeat] = score;
                });
            }
            readReveal((ok, fail) => { MG.Api.geoPlace(code, tok, ok, fail); }, (place) => {
                revealPlace.text = placeLabel(place);
                prompt.text = solo ? "Round complete. The exact cell and your guess are shown."
                    : "Round complete. The exact cell and both guesses are shown.";
            });
            readReveal((ok, fail) => { MG.Api.geoCredit(code, tok, ok, fail); }, (text) => {
                revealCredit.text = text;
            });
        }

        function readyNext() {
            if (sendingNext || finished || revealRound !== currentRound) return;
            sendingNext = true;
            setAction(solo ? "LOADING NEXT ROUND…" : "WAITING FOR OPPONENT", false, readyNext);
            MG.Api.geoNext(code, tok, (result) => {
                if (destroyed) return;
                if (!result.ok) {
                    sendingNext = false;
                    setAction(currentRound + 1 >= ROUNDS ? "FINISH" : "NEXT ROUND", true, readyNext);
                    return;
                }
                prompt.text = solo ? "Loading next round…" : "Ready. Waiting for the opponent…";
                pollMisses = 0;
            }, () => {
                if (destroyed) return;
                sendingNext = false;
                setAction(currentRound + 1 >= ROUNDS ? "FINISH" : "NEXT ROUND", true, readyNext);
            });
        }

        function finishGame() {
            if (finished) return;
            finished = true;
            refreshTimer();
            const mine = scores[mySeat], theirs = scores[1 - mySeat];
            if (solo) {
                roundLabel.text = "Solo complete";
                prompt.text = "Final score: " + mine + " / " + (ROUNDS * 750) + ".";
                setAction("SOLO COMPLETE", false, readyNext);
                outerStatus("GeoGuesser solo finished: " + mine + " / " + (ROUNDS * 750) + ".");
                if (session.onGameOver) session.onGameOver("win");
                return;
            }
            roundLabel.text = "Match complete";
            prompt.text = mine > theirs ? "You win!" : mine < theirs ? "Opponent wins." : "Draw.";
            setAction("MATCH COMPLETE", false, readyNext);
            outerStatus("GeoGuesser finished: " + mine + "–" + theirs + ".");
            if (session.onGameOver) session.onGameOver(mine > theirs ? "win" : mine < theirs ? "lose" : "draw");
        }

        function handleState(state) {
            if (state.done) { finishGame(); return; }
            if (state.round !== currentRound) beginRound(state.round);
            const myBit = 1 << mySeat;
            if (state.reveal) {
                showReveal();
            } else if (state.guessMask & myBit) {
                prompt.text = solo ? "Calculating result…" : "Guess locked. Waiting for the opponent…";
                setAction(solo ? "CALCULATING…" : "WAITING FOR OPPONENT", false, submitGuess);
            }
        }

        function pollState() {
            if (destroyed || finished) return;
            MG.Api.geoState(code, tok, (state) => {
                if (destroyed) return;
                handleState(state);
                pollMisses = state.reveal ? Math.min(pollMisses + 1, 20) : pollMisses + 1;
                $.Schedule(MG.Net.pollDelay(pollMisses), pollState);
            }, () => {
                if (destroyed) return;
                pollMisses++;
                $.Schedule(MG.Net.pollDelay(pollMisses), pollState);
            });
        }

        function cleanupDrag() {
            if (dragGhost) {
                try { dragGhost.DeleteAsync(0); } catch (e) {}
            }
            dragGhost = null;
            dragStartPos = null;
        }

        try {
            dragHandle.SetDraggable(true);
            $.RegisterEventHandler("DragStart", dragHandle, (_panel, dragEvent) => {
                if (destroyed) return;
                cleanupDrag();
                dragGhost = $.CreatePanel("Panel", root, "");
                dragGhost.AddClass("mg-geo-drag-ghost");
                try { dragGhost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragEvent.displayPanel = dragGhost;
                dragEvent.removePositionBeforeDrop = false;
                dragGhost.style.align = "left top";
                $.Schedule(0.0, () => {
                    if (!destroyed && dragGhost) dragStartPos = MG.Widgets.winPos(dragGhost);
                });
            });
            $.RegisterEventHandler("DragEnd", dragHandle, () => {
                if (destroyed || !dragGhost) { cleanupDrag(); return; }
                const end = MG.Widgets.winPos(dragGhost);
                let start = dragStartPos;
                if (!start) {
                    const viewPos = MG.Widgets.winPos(viewport);
                    if (viewPos) start = { x: viewPos.x + VIEW_W / 2, y: viewPos.y + VIEW_H / 2 };
                }
                if (start && end) {
                    const dx = end.x - start.x, dy = end.y - start.y;
                    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                        // Drag 1:1 with the image: the strip spans 360° over PANO_W px, so one
                        // dragged pixel is exactly 360 / PANO_W degrees, and the grabbed point
                        // stays under the cursor. The old constants (120 / 60) were tuned for a
                        // different viewport and over-rotated.
                        yaw -= dx * 360 / PANO_W;
                        pitch += dy / PITCH_PX_PER_DEG;
                        applyCamera();
                    }
                }
                cleanupDrag();
            });
        } catch (dragError) {
            viewLabel.text = "Use the arrow controls to look around";
        }

        updateScoreText();
        if (code === null || code === undefined || !tok) {
            loading.text = "GeoGuesser requires a server-backed session.";
            prompt.text = "Return to the picker and choose Play Solo, Quick Match or a private room.";
            setAction("UNAVAILABLE", false, submitGuess);
        } else {
            pollState();
        }

        return {
            destroy: function () {
                destroyed = true;
                panoramaGen++;
                // Before the panel goes: the timer owns $.Schedule callbacks that would otherwise
                // keep firing against a deleted panel after the player leaves.
                if (roundTimer) roundTimer.destroy();
                cleanupDrag();
                clearPanorama();
                try { root.DeleteAsync(0); } catch (e) {}
            }
        };
    }

    MG.GeoGuesser.create = createGeoGuesser;
    MG.Games.register({ id: 9, create: createGeoGuesser, enabled: true });
})();
