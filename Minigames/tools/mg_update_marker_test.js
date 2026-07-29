"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var uiSource = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");
var relevantMatch = uiSource.match(/UPDATE_RELEVANT_MAX_RATIO = ([0-9.]+)/);
var outdatedMatch = uiSource.match(/UPDATE_OUTDATED_MIN_RATIO = ([0-9.]+)/);
if (!relevantMatch || !outdatedMatch)
    throw new Error("could not read update-marker ratio thresholds from mg_ui.js");
var RELEVANT_MAX = Number(relevantMatch[1]);
var OUTDATED_MIN = Number(outdatedMatch[1]);

function pngSize(name) {
    var bytes = fs.readFileSync(path.join(ROOT, "update-markers", name));
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
        throw new Error(name + " is not a PNG");
    }
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

function classify(w, h) {
    var ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio <= RELEVANT_MAX) return "current";
    if (ratio >= OUTDATED_MIN) return "outdated";
    return "invalid";
}

function verify(name, expected) {
    var raw = pngSize(name);
    var scales = [0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
    var cases = 0;
    for (var s = 0; s < scales.length; s++) {
        for (var ew = -2; ew <= 2; ew++) {
            for (var eh = -2; eh <= 2; eh++) {
                var w = Math.max(1, Math.round(raw.w * scales[s]) + ew);
                var h = Math.max(1, Math.round(raw.h * scales[s]) + eh);
                if (classify(w, h) !== expected || classify(h, w) !== expected) {
                    throw new Error(name + " misclassified at scale=" + scales[s] +
                        " error=(" + ew + "," + eh + ") dims=" + w + "x" + h);
                }
                cases += 2;
            }
        }
    }
    console.log("  \u2713 " + name + " " + raw.w + "x" + raw.h + ": " + cases + " simulated reads");
}

verify("relevant-template.png", "current");
verify("is-1-0-relevant.png", "current");
verify("outdated-template.png", "outdated");

// A malformed or unexpected image must never produce a false update notification.
if (classify(64, 32) !== "invalid" || classify(32, 64) !== "invalid")
    throw new Error("ambiguous 2:1 marker must be rejected");
if (!(RELEVANT_MAX < OUTDATED_MIN))
    throw new Error("update-marker ratio bands must not overlap");

console.log("update marker tests passed (current <= " + RELEVANT_MAX +
    ", outdated >= " + OUTDATED_MIN + ")");
