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
(function () {
    "use strict";

    var MG = $.MG = $.MG || {};
    if (MG.GeoGuesser) return;
    MG.GeoGuesser = {};

    var GRID_W = 64, GRID_H = 32, ROUNDS = 5;
    var VIEW_W = 720, VIEW_H = 324;
    var PANO_W = 2880, PANO_H = 1440, PANO_STEP = PANO_W - 2;
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
    var PANO_SCALING = "cover";
    var REGIONS = ["Europe", "North America", "South America", "Africa", "Asia", "Oceania"];

    function addLabel(parent, cls, text) {
        var label = $.CreatePanel("Label", parent, "");
        var classes = String(cls || "").split(/\s+/);
        for (var i = 0; i < classes.length; i++) if (classes[i]) label.AddClass(classes[i]);
        label.text = text || "";
        return label;
    }

    function addButton(parent, cls, text, callback) {
        var button = $.CreatePanel("Button", parent, "");
        var classes = String(cls || "").split(/\s+/);
        for (var i = 0; i < classes.length; i++) if (classes[i]) button.AddClass(classes[i]);
        button._mgLabel = addLabel(button, "mg-geo-button-label", text);
        button.SetPanelEvent("onactivate", callback);
        return button;
    }

    function createGeoGuesser(container, session) {
        session = session || {};
        var destroyed = false;
        var root = $.CreatePanel("Panel", container, "MG_GeoGuesser");
        root.AddClass("mg-geo");
        var code = session.code;
        var tok = session.tok || "";
        var mySeat = session.isHost ? 0 : 1;
        var solo = !!session.solo;
        var currentRound = -1;
        var revealRound = -1;
        var selectedCell = -1;
        var yaw = 0, pitch = 0;
        var panoramaGen = 0;
        var panoramaReady = false;
        var pollMisses = 0;
        var sendingGuess = false;
        var sendingNext = false;
        var finished = false;
        var revealReadsPending = 0;
        var scores = [0, 0];
        var cells = [];
        var panoImages = [];
        var dragGhost = null, dragStartPos = null;
        var syncingCameraSliders = false;

        var stats = $.CreatePanel("Panel", root, "");
        stats.AddClass("mg-geo-stats");
        var roundLabel = addLabel(stats, "mg-geo-stat", "Round 1 / " + ROUNDS);
        var viewLabel = addLabel(stats, "mg-geo-view-label", "Drag to look around");
        var scoreLabel = addLabel(stats, "mg-geo-stat mg-geo-score",
            solo ? "Score 0" : "You 0 · Opponent 0");

        var viewport = $.CreatePanel("Panel", root, "");
        viewport.AddClass("mg-geo-viewport");
        var stage = $.CreatePanel("Panel", viewport, "");
        stage.AddClass("mg-geo-stage");
        var loading = addLabel(viewport, "mg-geo-loading", "Loading panorama…");
        var dragHandle = $.CreatePanel("Panel", viewport, "");
        dragHandle.AddClass("mg-geo-drag-handle");

        var cameraControls = $.CreatePanel("Panel", root, "");
        cameraControls.AddClass("mg-geo-camera-controls");
        addLabel(cameraControls, "mg-geo-slider-label", "LOOK");
        addButton(cameraControls, "mg-geo-camera-button", "◀", function () { turn(-20, 0); });
        var yawSlider = $.CreatePanel("Slider", cameraControls, "", { direction: "horizontal" });
        yawSlider.AddClass("HorizontalSlider");
        yawSlider.AddClass("mg-geo-yaw-slider");
        yawSlider.min = 0;
        yawSlider.max = 359;
        yawSlider.value = 0;
        addButton(cameraControls, "mg-geo-camera-button", "▶", function () { turn(20, 0); });
        addLabel(cameraControls, "mg-geo-slider-label mg-geo-pitch-label", "TILT");
        addButton(cameraControls, "mg-geo-camera-button", "▼", function () { turn(0, -10); });
        var pitchSlider = $.CreatePanel("Slider", cameraControls, "", { direction: "horizontal" });
        pitchSlider.AddClass("HorizontalSlider");
        pitchSlider.AddClass("mg-geo-pitch-slider");
        pitchSlider.min = -30;
        pitchSlider.max = 30;
        pitchSlider.value = 0;
        addButton(cameraControls, "mg-geo-camera-button", "▲", function () { turn(0, 10); });
        addButton(cameraControls, "mg-geo-camera-button mg-geo-reset-button", "RESET", function () {
            yaw = 0; pitch = 0; applyCamera();
        });

        var lower = $.CreatePanel("Panel", root, "");
        lower.AddClass("mg-geo-lower");
        var map = $.CreatePanel("Panel", lower, "");
        map.AddClass("mg-geo-map");
        var mapImage = $.CreatePanel("Image", map, "", { scaling: "stretch-to-fit-preserve-aspect" });
        mapImage.AddClass("mg-geo-map-image");
        mapImage.SetImage("s2r://panorama/images/geoguesser/world_map.vtex");
        try { mapImage.SetAttributeString("hittest", "false"); } catch (e0) {}
        var grid = $.CreatePanel("Panel", map, "");
        grid.AddClass("mg-geo-grid");
        for (var row = 0; row < GRID_H; row++) {
            var rowPanel = $.CreatePanel("Panel", grid, "");
            rowPanel.AddClass("mg-geo-grid-row");
            for (var col = 0; col < GRID_W; col++) {
                (function (cell) {
                    var hit = $.CreatePanel("Button", rowPanel, "");
                    hit.AddClass("mg-geo-cell");
                    hit.SetPanelEvent("onactivate", function () { selectCell(cell); });
                    cells.push(hit);
                })(row * GRID_W + col);
            }
        }

        var side = $.CreatePanel("Panel", lower, "");
        side.AddClass("mg-geo-side");
        var prompt = addLabel(side, "mg-geo-prompt", "Explore the panorama, then choose a point on the map.");
        var revealPlace = addLabel(side, "mg-geo-place", "");
        var revealCredit = addLabel(side, "mg-geo-credit", "");
        var actionButton = addButton(side, "mg-btn mg-btn-primary mg-geo-action", "SUBMIT GUESS", submitGuess);

        function outerStatus(text) {
            if (session.onStatus) session.onStatus(text);
        }

        function setAction(text, enabled, callback) {
            var label = actionButton._mgLabel;
            if (label) label.text = text;
            actionButton.SetHasClass("mg-btn-inert", !enabled);
            try { actionButton.enabled = !!enabled; } catch (e) {}
            actionButton.SetPanelEvent("onactivate", enabled ? callback : function () {});
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
            var point = PANO_STEP + yaw * PANO_STEP / 360;
            var x = VIEW_W / 2 - point;
            var y = -(PANO_H - VIEW_H) / 2 + pitch * 4;
            stage.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0px)";
            viewLabel.text = "Heading " + Math.round(yaw) + "° · pitch " + Math.round(pitch) + "°";
        }

        yawSlider.SetPanelEvent("onvaluechanged", function () {
            if (syncingCameraSliders || !panoramaReady) return;
            var nextYaw = Number(yawSlider.value);
            if (!isFinite(nextYaw)) return;
            yaw = nextYaw;
            applyCamera();
        });
        pitchSlider.SetPanelEvent("onvaluechanged", function () {
            if (syncingCameraSliders || !panoramaReady) return;
            var nextPitch = Number(pitchSlider.value);
            if (!isFinite(nextPitch)) return;
            pitch = nextPitch;
            applyCamera();
        });

        function clearPanorama() {
            for (var i = 0; i < panoImages.length; i++) {
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
            MG.Net.loadImage(url, function (copy) {
                if (destroyed || myGen !== panoramaGen) {
                    try { copy.SetImage(""); copy.DeleteAsync(0); } catch (e) {}
                    return;
                }
                configurePanoImage(copy, offset);
                if (done) done();
            }, function () {
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
            var myGen = ++panoramaGen;
            var url = MG.Net.getBaseUrl() + "/api/geoview.png?code=" + code +
                "&tok=" + encodeURIComponent(tok) + "&round=" + round + "&rnd=" + Math.random();
            MG.Net.loadImage(url, function (image, loadedW, loadedH) {
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
                    $.Schedule(1.5, function () {
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
                addCachedCopy(url, 0, myGen, function () {
                    addCachedCopy(url, PANO_STEP * 2, myGen, function () {
                        if (destroyed || myGen !== panoramaGen) return;
                        panoramaReady = true;
                        loading.style.visibility = "collapse";
                        applyCamera();
                    });
                });
            }, function () {
                if (destroyed || myGen !== panoramaGen) return;
                loading.text = "Couldn't load panorama. Retrying…";
                $.Schedule(1.5, function () {
                    if (!destroyed && myGen === panoramaGen) loadPanorama(round);
                });
            }, { scaling: PANO_SCALING });
        }

        function clearMapMarkers() {
            for (var i = 0; i < cells.length; i++) {
                cells[i].RemoveClass("mg-geo-selected");
                cells[i].RemoveClass("mg-geo-target");
                cells[i].RemoveClass("mg-geo-me");
                cells[i].RemoveClass("mg-geo-them");
            }
        }

        function markPoint(point, cls) {
            if (!point) return;
            var cell = point.y * GRID_W + point.x;
            if (cell >= 0 && cell < cells.length) cells[cell].AddClass(cls);
        }

        function selectCell(cell) {
            if (finished || revealRound === currentRound || sendingGuess) return;
            selectedCell = cell;
            for (var i = 0; i < cells.length; i++) cells[i].SetHasClass("mg-geo-selected", i === cell);
            setAction("SUBMIT GUESS", true, submitGuess);
            prompt.text = "Guess placed. Submit when ready.";
        }

        function submitGuess() {
            if (selectedCell < 0 || sendingGuess || finished || revealRound === currentRound) return;
            sendingGuess = true;
            setAction("SUBMITTING…", false, submitGuess);
            MG.Api.geoGuess(code, tok, selectedCell, function (result) {
                if (destroyed) return;
                sendingGuess = false;
                if (!result.ok) {
                    prompt.text = "The server rejected that guess. Pick again.";
                    setAction("SUBMIT GUESS", true, submitGuess);
                    return;
                }
                prompt.text = solo ? "Calculating result…" : "Guess locked. Waiting for the opponent…";
                setAction(solo ? "CALCULATING…" : "WAITING FOR OPPONENT", false, submitGuess);
                pollMisses = 0;
            }, function () {
                if (destroyed) return;
                sendingGuess = false;
                prompt.text = "Couldn't submit. Try again.";
                setAction("SUBMIT GUESS", true, submitGuess);
            });
        }

        function beginRound(round) {
            currentRound = round;
            revealRound = -1;
            selectedCell = -1;
            sendingGuess = false;
            sendingNext = false;
            yaw = Math.floor(Math.random() * 24) * 15;
            pitch = 0;
            clearMapMarkers();
            roundLabel.text = "Round " + (round + 1) + " / " + ROUNDS;
            revealPlace.text = "";
            revealCredit.text = "";
            prompt.text = "Explore the panorama, then choose a point on the map.";
            setAction("SELECT A MAP POINT", false, submitGuess);
            loadPanorama(round);
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
            var round = currentRound;
            function attempt() {
                if (destroyed || revealRound !== round || currentRound !== round) return;
                fetcher(function (value) {
                    if (destroyed || revealRound !== round || currentRound !== round) return;
                    apply(value);
                    revealReadDone(round);
                }, function () {
                    if (!destroyed && revealRound === round && currentRound === round) {
                        $.Schedule(0.8, attempt);
                    }
                });
            }
            attempt();
        }

        function showReveal() {
            if (revealRound === currentRound) return;
            revealRound = currentRound;
            revealReadsPending = solo ? 5 : 7;
            sendingGuess = false;
            prompt.text = "Round complete. Loading the authoritative reveal…";
            setAction("LOADING RESULT…", false, readyNext);
            readReveal(function (ok, fail) { MG.Api.geoTarget(code, tok, ok, fail); }, function (point) {
                markPoint(point, "mg-geo-target");
            });
            readReveal(function (ok, fail) { MG.Api.geoPick(code, tok, mySeat, ok, fail); }, function (point) {
                markPoint(point, "mg-geo-me");
            });
            if (!solo) {
                readReveal(function (ok, fail) { MG.Api.geoPick(code, tok, 1 - mySeat, ok, fail); }, function (point) {
                    markPoint(point, "mg-geo-them");
                });
            }
            readReveal(function (ok, fail) { MG.Api.geoScore(code, tok, mySeat, ok, fail); }, function (score) {
                scores[mySeat] = score;
            });
            if (!solo) {
                readReveal(function (ok, fail) { MG.Api.geoScore(code, tok, 1 - mySeat, ok, fail); }, function (score) {
                    scores[1 - mySeat] = score;
                });
            }
            readReveal(function (ok, fail) { MG.Api.geoInfo(code, tok, ok, fail); }, function (index) {
                revealPlace.text = REGIONS[index] || "Location revealed";
                prompt.text = solo ? "Round complete. The exact cell and your guess are shown."
                    : "Round complete. The exact cell and both guesses are shown.";
            });
            readReveal(function (ok, fail) { MG.Api.geoCredit(code, tok, ok, fail); }, function (text) {
                revealCredit.text = text;
            });
        }

        function readyNext() {
            if (sendingNext || finished || revealRound !== currentRound) return;
            sendingNext = true;
            setAction(solo ? "LOADING NEXT ROUND…" : "WAITING FOR OPPONENT", false, readyNext);
            MG.Api.geoNext(code, tok, function (result) {
                if (destroyed) return;
                if (!result.ok) {
                    sendingNext = false;
                    setAction(currentRound + 1 >= ROUNDS ? "FINISH" : "NEXT ROUND", true, readyNext);
                    return;
                }
                prompt.text = solo ? "Loading next round…" : "Ready. Waiting for the opponent…";
                pollMisses = 0;
            }, function () {
                if (destroyed) return;
                sendingNext = false;
                setAction(currentRound + 1 >= ROUNDS ? "FINISH" : "NEXT ROUND", true, readyNext);
            });
        }

        function finishGame() {
            if (finished) return;
            finished = true;
            var mine = scores[mySeat], theirs = scores[1 - mySeat];
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
            var myBit = 1 << mySeat;
            if (state.reveal) {
                showReveal();
            } else if (state.guessMask & myBit) {
                prompt.text = solo ? "Calculating result…" : "Guess locked. Waiting for the opponent…";
                setAction(solo ? "CALCULATING…" : "WAITING FOR OPPONENT", false, submitGuess);
            }
        }

        function pollState() {
            if (destroyed || finished) return;
            MG.Api.geoState(code, tok, function (state) {
                if (destroyed) return;
                handleState(state);
                pollMisses = state.reveal ? Math.min(pollMisses + 1, 20) : pollMisses + 1;
                $.Schedule(MG.Net.pollDelay(pollMisses), pollState);
            }, function () {
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
            $.RegisterEventHandler("DragStart", dragHandle, function (_panel, dragEvent) {
                if (destroyed) return;
                cleanupDrag();
                dragGhost = $.CreatePanel("Panel", root, "");
                dragGhost.AddClass("mg-geo-drag-ghost");
                try { dragGhost.SetAttributeString("hittest", "false"); } catch (e) {}
                dragEvent.displayPanel = dragGhost;
                dragEvent.removePositionBeforeDrop = false;
                dragGhost.style.align = "left top";
                $.Schedule(0.0, function () {
                    if (!destroyed && dragGhost) dragStartPos = MG.Widgets.winPos(dragGhost);
                });
            });
            $.RegisterEventHandler("DragEnd", dragHandle, function () {
                if (destroyed || !dragGhost) { cleanupDrag(); return; }
                var end = MG.Widgets.winPos(dragGhost);
                var start = dragStartPos;
                if (!start) {
                    var viewPos = MG.Widgets.winPos(viewport);
                    if (viewPos) start = { x: viewPos.x + VIEW_W / 2, y: viewPos.y + VIEW_H / 2 };
                }
                if (start && end) {
                    var dx = end.x - start.x, dy = end.y - start.y;
                    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
                        yaw -= dx * 120 / VIEW_W;
                        pitch += dy * 60 / VIEW_H;
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
                cleanupDrag();
                clearPanorama();
                try { root.DeleteAsync(0); } catch (e) {}
            }
        };
    }

    MG.GeoGuesser.create = createGeoGuesser;
    MG.Games.register({ id: 9, create: createGeoGuesser, enabled: true });
})();
