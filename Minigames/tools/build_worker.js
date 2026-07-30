"use strict";
/*
 * build_worker.js - generate the deploy artifact server/worker.js.
 *
 * Concatenates the SHARED rule engines (panorama/scripts/rules/*.js) in front of the
 * authored core (server/worker.core.js). The rule IIFEs see no `$` in the Worker
 * runtime, so they attach to globalThis.MGRules; the core then reads move validators
 * from there. This is what makes the server authority and the client predictor run
 * byte-for-byte identical rules - no hand-copied second source of truth.
 *
 * Run: node tools/build_worker.js   (then restart the Node VPS service after deployment).
 * Run: node tools/build_worker.js --check   to VERIFY the committed worker.js matches its
 * sources without writing anything (exit 1 on drift). `npm test` does this first, because a
 * stale worker.js is otherwise invisible: the rule tests read the sources directly and the
 * server test reads only the generated file, so neither notices a missed rebuild.
 * The generated worker.js carries a "DO NOT EDIT" banner and is committed so a clone
 * can run without the build step, but the SOURCE of truth is worker.core.js + rules.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const rulesDir = path.join(root, "panorama", "scripts", "rules");
const RULES = ["checkers.js", "ttt.js", "chess.js", "connectfour.js", "durak.js", "poker.js"];
const corePath = path.join(root, "server", "worker.core.js");
const pixelMapPath = path.join(root, "server", "pixelbattle_map.generated.js");
const adminPanelPath = path.join(root, "server", "admin_panel.js");
const outPath = path.join(root, "server", "worker.js");

function read(p) { return fs.readFileSync(p, "utf8"); }

const banner =
    "/* ============================================================================\n" +
    " * GENERATED FILE - DO NOT EDIT BY HAND.\n" +
    " * Produced by `node tools/build_worker.js` from:\n" +
    " *   panorama/scripts/rules/*.js                              (shared with client)\n" +
    " *   server/pixelbattle_map.generated.js                     (generated land mask)\n" +
    " *   server/admin_panel.js                                   (browser admin assets)\n" +
    " *   server/worker.core.js                                    (authored core)\n" +
    " * Edit those sources, then rebuild. See server/README.md.\n" +
    " * ============================================================================ */\n\n";

let out = banner;
out += "/* ── shared rules (from panorama/scripts/rules/*.js; attach to globalThis.MGRules) ── */\n";
for (const name of RULES) {
    out += "// ---- rules/" + name + " ----\n";
    out += read(path.join(rulesDir, name)).replace(/\s*$/, "") + "\n\n";
}
out += "/* ── generated Pixel Battle land mask ── */\n";
out += read(pixelMapPath).replace(/\s*$/, "") + "\n\n";
out += "/* ── authored Pixel Battle browser admin assets ── */\n";
out += read(adminPanelPath).replace(/\s*$/, "") + "\n\n";
out += "/* ── authored core (from server/worker.core.js) ── */\n";
out += read(corePath).replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, ""); // drop the core's leading banner comment; keep the code

if (process.argv.indexOf("--check") !== -1) {
    const current = fs.existsSync(outPath) ? read(outPath) : null;
    if (current === out) {
        console.log("worker.js is in sync with its sources");
        process.exit(0);
    }
    console.log("STALE worker.js - it does not match its sources. Run: node tools/build_worker.js");
    if (current !== null) console.log("  (committed " + current.length + " bytes, sources produce " + out.length + ")");
    process.exit(1);
}

fs.writeFileSync(outPath, out, "utf8");
console.log("wrote " + path.relative(root, outPath) + " (" + out.length + " bytes) from " +
    RULES.length + " rule files + Pixel Battle map/admin + worker.core.js");
