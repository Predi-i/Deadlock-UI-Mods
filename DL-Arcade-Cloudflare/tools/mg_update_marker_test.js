"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const uiSource = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");
const relevantMatch = uiSource.match(/UPDATE_RELEVANT_MAX_RATIO = ([0-9.]+)/);
const outdatedMatch = uiSource.match(/UPDATE_OUTDATED_MIN_RATIO = ([0-9.]+)/);
if (!relevantMatch || !outdatedMatch)
    throw new Error("could not read update-marker ratio thresholds from mg_ui.js");
const RELEVANT_MAX = Number(relevantMatch[1]);
const OUTDATED_MIN = Number(outdatedMatch[1]);

function pngSize(name) {
    const bytes = fs.readFileSync(path.join(ROOT, "update-markers", name));
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
        throw new Error(name + " is not a PNG");
    }
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

function classify(w, h) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio <= RELEVANT_MAX) return "current";
    if (ratio >= OUTDATED_MIN) return "outdated";
    return "invalid";
}

function verify(name, expected) {
    const raw = pngSize(name);
    const scales = [0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    let cases = 0;
    for (let s = 0; s < scales.length; s++) {
        for (let ew = -2; ew <= 2; ew++) {
            for (let eh = -2; eh <= 2; eh++) {
                const w = Math.max(1, Math.round(raw.w * scales[s]) + ew);
                const h = Math.max(1, Math.round(raw.h * scales[s]) + eh);
                if (classify(w, h) !== expected || classify(h, w) !== expected) {
                    throw new Error(name + " misclassified at scale=" + scales[s] +
                        " error=(" + ew + "," + eh + ") dims=" + w + "x" + h);
                }
                cases += 2;
            }
        }
    }
    console.log(`  \u2713 ${name} ${raw.w}x${raw.h}: ${cases} simulated reads`);
}

verify("relevant-template.png", "current");
verify("outdated-template.png", "outdated");
// 1.2 is the shipped release; 1.3 is staged so the next bump only has to retire this one.
verify("is-1-2-relevant.png", "current");
verify("is-1-3-relevant.png", "current");
// 1.0 shipped the poker leaveSeat infinite loop (rules/poker.js runout) and is retired, so its
// players get the update popup.
verify("is-1-0-relevant.png", "outdated");
// 1.1 is retired by the 1.2 release (the 34-colour Pixel Battle palette + eyedropper). Retiring
// the OUTGOING marker is the step that actually notifies anyone - see update-markers/README.md.
verify("is-1-1-relevant.png", "outdated");

// The shipped MG_VERSION must have a marker on disk, or every client's update check silently
// fails ("Couldn't verify the update marker") instead of reporting up to date. Nothing tied the
// constant to the files before, so a version bump could ship without its marker.
(() => {
    const versionMatch = uiSource.match(/MG_VERSION = "([^"]+)"/);
    if (!versionMatch) throw new Error("could not read MG_VERSION from mg_ui.js");
    const shipped = versionMatch[1];
    const markerName = "is-" + shipped.replace(/\./g, "-") + "-relevant.png";
    if (!fs.existsSync(path.join(ROOT, "update-markers", markerName)))
        throw new Error("MG_VERSION is " + shipped + " but " + markerName + " does not exist");
    const raw = pngSize(markerName);
    if (classify(raw.w, raw.h) !== "current")
        throw new Error(markerName + " must classify as current for the shipped version");
    console.log("  ✓ MG_VERSION " + shipped + " has a current marker (" + markerName + ")");
})();

// A malformed or unexpected image must never produce a false update notification.
if (classify(64, 32) !== "invalid" || classify(32, 64) !== "invalid")
    throw new Error("ambiguous 2:1 marker must be rejected");
if (!(RELEVANT_MAX < OUTDATED_MIN))
    throw new Error("update-marker ratio bands must not overlap");

console.log("update marker tests passed (current <= " + RELEVANT_MAX +
    ", outdated >= " + OUTDATED_MIN + ")");
