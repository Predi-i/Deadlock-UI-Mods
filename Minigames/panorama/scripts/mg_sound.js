"use strict";
// DL Arcade - sound facade ($.MG.Sound).
// Panorama can only play a REGISTERED soundevent by NAME (no file path, no volume arg):
//   $.DispatchEvent("PlaySoundEffect", "<EventName>")
// So volume is faked the QOLLOCK way: tools/gen_soundevents.js pre-generates one soundevent
// per (sound, volume-step) - MG.MoveSelf_V0 .. MG.MoveSelf_V20 - and we play the variant
// nearest the current slider value. See FEATURES_PLAN §5/§6.1 and ARCHITECTURE notes.
//
// Load order (base_hud.xml): mg_net -> mg_sound -> rules/* -> games, so controllers see $.MG.Sound.
// Settings are session-only (Panorama has no localStorage; persist is a separate task).
(function () {
    var MG = ($.MG = $.MG || {});
    if (MG.Sound) return;

    var vol = 70;      // 0..100, session-only
    var muted = false;
    var STEPS = 20;    // _V0.._V20 -> volume 0.00..1.00 in 0.05 steps (matches gen_soundevents.js)

    function clampVol(v) { return Math.max(0, Math.min(100, v | 0)); }
    function stepFor(v) { return Math.max(0, Math.min(STEPS, Math.round(v / 100 * STEPS))); }

    MG.Sound = {
        STEPS: STEPS,
        getVol: function () { return vol; },
        isMuted: function () { return muted; },
        setVol: function (v) { vol = clampVol(v); },
        setMuted: function (m) { muted = !!m; },
        toggleMute: function () { muted = !muted; return muted; },
        play: function (name) {
            if (muted || vol <= 0) return;
            var ev = "MG." + name + "_V" + stepFor(vol);
            try { $.DispatchEvent("PlaySoundEffect", ev); } catch (e) {}
        }
    };
})();
