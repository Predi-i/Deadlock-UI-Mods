"use strict";
// tools/gen_soundevents.js — generate soundevents/world_ambient_emitters.vsndevts
//
// WHY this file overrides world_ambient_emitters.vsndevts: it is an EXISTING base game
// soundevents file the engine already loads, so overriding it drops our events into the
// already-loaded manifest (the QOLLOCK trick, FEATURES_PLAN §5). We copy QOLLOCK's own
// events verbatim first, so a user who already runs QOLLOCK keeps their sounds, then append
// ours. We do NOT copy any QOLLOCK .wav/.vsnd — only the event manifest entries.
//
// Panorama's PlaySoundEffect takes an event NAME and no volume arg, so "volume" is faked by
// pre-generating one event per volume step: MG.<Name>_V0 .. MG.<Name>_V20 (volume 0.00..1.00,
// step 0.05). mg_sound.js plays the variant nearest the slider. STEPS here MUST match
// mg_sound.js (20).
//
// Run: node tools/gen_soundevents.js   (idempotent; overwrites the output file)

var fs = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");
var QOLLOCK_SRC = "D:/GitHub2/QOLLOCK/soundevents/world_ambient_emitters.vsndevts";
// Output at MOD-ROOT soundevents/ (not panorama/soundevents/): build_mod.ps1 keeps the path
// relative to the mod root, and the base game file lives at pak01 soundevents/, so this path
// is what overrides it — same placement QOLLOCK uses.
var OUT = path.join(ROOT, "soundevents", "world_ambient_emitters.vsndevts");

var HEADER = "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->";

var STEPS = 20;        // _V0.._V20 — MUST match mg_sound.js
var VOL_MAX = 4.0;     // volume at V20. The base WAVs are quiet, so 100% maps to ×4 gain
                       // (the vsndevts `volume` is a linear gain multiplier, >1 is allowed)
                       // — maintainer 2026-07-15: "too quiet even at 100%, 2× them" → still quiet,
                       //   doubled again 2026-07-16 (1.0 → 2.0 → 4.0).

// event-name suffix -> wav file (in panorama/sounds/mods/, compiled to .vsnd by build_mod.ps1)
var SOUNDS = [
    { name: "MoveSelf",   file: "move-self" },
    { name: "MoveOpp",    file: "move-opponent" },
    { name: "Check",      file: "move-check" },
    { name: "Illegal",    file: "illegal" },
    { name: "Premove",    file: "premove" },
    { name: "Promote",    file: "promote" },
    { name: "GameStart",  file: "game-start" },
    { name: "TenSeconds", file: "tenseconds" }
];

// vsnd path root — WAVs stay under panorama/sounds/mods/ (maintainer decision 2026-07-15).
var VSND_DIR = "panorama/sounds/mods/";

function f6(n) { return n.toFixed(6); }

// Extract QOLLOCK's event body: everything BETWEEN the root object's { and its final }.
// NOTE the "{" inside the KV3 header comment (version{...}) is NOT the root brace, so we
// skip the header comment line first, then take from the first "{" to the last "}".
function extractQollockBody(src) {
    var text = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
    // Drop a leading "<!-- ... -->" header comment so its inner "{" can't be mistaken for root.
    var afterHeader = text.replace(/^\s*<!--[\s\S]*?-->\s*/, "");
    var open = afterHeader.indexOf("{");
    var close = afterHeader.lastIndexOf("}");
    if (open < 0 || close < 0 || close <= open) {
        throw new Error("Could not find root braces in QOLLOCK soundevents: " + src);
    }
    // body is the inner content (without the outer braces), trimmed of surrounding blank lines.
    var body = afterHeader.slice(open + 1, close);
    body = body.replace(/^\n+/, "").replace(/\n+$/, "");
    return body;
}

// One soundevent block (KV3, tab-indented — matches QOLLOCK byte layout).
function eventBlock(eventName, volume, wavFile) {
    var vsnd = VSND_DIR + wavFile + ".vsnd";
    return [
        "\t" + eventName + " = ",
        "\t{",
        "\t\tbase = \"MG.SoundBase\"",
        "\t\tvolume = " + f6(volume),
        "\t\tvsnd_files = ",
        "\t\t[",
        "\t\t\t\"" + vsnd + "\",",
        "\t\t]",
        "\t}"
    ].join("\n");
}

function mgBaseBlock() {
    // 2D UI mix, no occlusion/positioning — same shape as QOLLOCK's BuffReminderBase.
    return [
        "\tMG.SoundBase = ",
        "\t{",
        "\t\tbase = \"Base.UI\"",
        "\t\tocclusion_scale = 0.000000",
        "\t\tocclusion_scale_non_player = 0.000000",
        "\t\tocclusion_min = 1.000000",
        "\t\tocclusion_volume_blend_distance_min = 0.000000",
        "\t\tocclusion_volume_blend_distance_max = 0.000000",
        "\t\tdistance_lpf_on = 0.000000",
        "\t}"
    ].join("\n");
}

function buildMgEvents() {
    var out = [];
    out.push(mgBaseBlock());
    for (var s = 0; s < SOUNDS.length; s++) {
        var snd = SOUNDS[s];
        for (var step = 0; step <= STEPS; step++) {
            var vol = VOL_MAX * (step / STEPS);
            out.push(eventBlock("MG." + snd.name + "_V" + step, vol, snd.file));
        }
    }
    return out.join("\n");
}

function main() {
    var qollockBody = "";
    var haveQollock = fs.existsSync(QOLLOCK_SRC);
    if (haveQollock) {
        qollockBody = extractQollockBody(QOLLOCK_SRC);
    } else {
        console.warn("[gen_soundevents] QOLLOCK source not found at " + QOLLOCK_SRC +
            " — writing MG events only (QOLLOCK users would lose their sounds; check the path).");
    }

    var mgEvents = buildMgEvents();

    var parts = [HEADER, "{"];
    if (qollockBody) parts.push(qollockBody);
    parts.push(mgEvents);
    parts.push("}");
    parts.push(""); // trailing newline
    var text = parts.join("\n");

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text, "utf8");

    var mgCount = SOUNDS.length * (STEPS + 1) + 1; // +1 for MG.SoundBase
    console.log("[gen_soundevents] wrote " + OUT);
    console.log("  QOLLOCK events copied: " + (haveQollock ? "yes" : "NO (file missing)"));
    console.log("  MG events appended:    " + mgCount + " (" + SOUNDS.length +
        " sounds × " + (STEPS + 1) + " volume steps + base)");
}

main();
