"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var uiSource = fs.readFileSync(path.join(ROOT, "panorama", "scripts", "mg_ui.js"), "utf8");
var thresholdMatch = uiSource.match(/if \(ratio <= ([0-9.]+)\)/);
if (!thresholdMatch) throw new Error("could not read update-marker ratio threshold from mg_ui.js");
var THRESHOLD = Number(thresholdMatch[1]);

function pngSize(name) {
    var bytes = fs.readFileSync(path.join(ROOT, "update-markers", name));
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
        throw new Error(name + " is not a PNG");
    }
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

function isRelevant(w, h) {
    return Math.max(w, h) / Math.min(w, h) <= THRESHOLD;
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
                if (isRelevant(w, h) !== expected || isRelevant(h, w) !== expected) {
                    throw new Error(name + " misclassified at scale=" + scales[s] +
                        " error=(" + ew + "," + eh + ") dims=" + w + "x" + h);
                }
                cases += 2;
            }
        }
    }
    console.log("  \u2713 " + name + " " + raw.w + "x" + raw.h + ": " + cases + " simulated reads");
}

verify("relevant-template.png", true);
verify("is-1-0-relevant.png", true);
verify("outdated-template.png", false);
console.log("update marker tests passed (threshold " + THRESHOLD + ")");
