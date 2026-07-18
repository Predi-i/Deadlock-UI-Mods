#!/usr/bin/env node
/*
 * strip_comments.js — remove comments from a Public build's panorama/ tree.
 *
 * Strips comments IN PLACE from every .js / .css / .xml under the target dir:
 *   - JS  : // line and /* block *\/, string/template/regex aware (won't touch a
 *           "//" that lives inside a string or a /regex/).
 *   - CSS : /* block *\/  (CSS has no line comments).
 *   - XML : <!-- block -->
 *
 * Blank lines left behind by whole-line comments are collapsed so the files stay tidy.
 * Does NOT touch the source tree — point it at the SHIPPED copy.
 *
 * Usage:
 *   node tools/strip_comments.js "D:/Deadlock mod archive/Public DL Arcade/panorama"
 *   node tools/strip_comments.js <dir> --dry     # report only, write nothing
 */
"use strict";
var fs = require("fs");
var path = require("path");

var target = process.argv[2];
var dry = process.argv.indexOf("--dry") !== -1;
if (!target) {
    console.error('usage: node tools/strip_comments.js <panorama-dir> [--dry]');
    process.exit(1);
}
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    console.error("not a directory: " + target);
    process.exit(1);
}

// ── JS: comment-aware scanner ────────────────────────────────────────────────
// Walks char by char tracking whether we're inside a string ('...', "...", `...`),
// a regex literal, or a comment, so only genuine comment bytes get dropped.
function stripJs(src) {
    var out = "";
    var i = 0, n = src.length;
    // Whether a `/` at the current position begins a regex (vs a divide). True right
    // after tokens that can't end an expression. Good-enough heuristic used by many
    // minifiers; our code has no `/`-division ambiguity that would trip it.
    function regexAllowed() {
        for (var j = out.length - 1; j >= 0; j--) {
            var c = out[j];
            if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
            return "(,=:[!&|?{};+-*%^~<>".indexOf(c) !== -1;
        }
        return true; // start of file
    }
    while (i < n) {
        var c = src[i], d = src[i + 1];
        // line comment
        if (c === "/" && d === "/") {
            i += 2;
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        // block comment
        if (c === "/" && d === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        // string literals
        if (c === '"' || c === "'" || c === "`") {
            var q = c; out += c; i++;
            while (i < n) {
                var ch = src[i]; out += ch;
                if (ch === "\\") { out += src[i + 1] || ""; i += 2; continue; }
                i++;
                if (ch === q) break;
            }
            continue;
        }
        // regex literal
        if (c === "/" && regexAllowed()) {
            out += c; i++;
            var inClass = false;
            while (i < n) {
                var rc = src[i]; out += rc;
                if (rc === "\\") { out += src[i + 1] || ""; i += 2; continue; }
                if (rc === "[") inClass = true;
                else if (rc === "]") inClass = false;
                i++;
                if (rc === "/" && !inClass) break;
            }
            continue;
        }
        out += c; i++;
    }
    return collapseBlankLines(out);
}

function stripBlock(src, open, close) {
    var out = "";
    var i = 0, n = src.length;
    while (i < n) {
        if (src.substr(i, open.length) === open) {
            i += open.length;
            while (i < n && src.substr(i, close.length) !== close) i++;
            i += close.length;
            continue;
        }
        out += src[i]; i++;
    }
    return collapseBlankLines(out);
}

// Drop lines that are now blank (were comment-only), and squeeze runs of blank lines
// down to a single one so the output stays readable.
function collapseBlankLines(s) {
    var lines = s.split(/\r?\n/);
    var res = [];
    var prevBlank = false;
    for (var k = 0; k < lines.length; k++) {
        var blank = lines[k].trim() === "";
        if (blank && prevBlank) continue;
        res.push(lines[k].replace(/[ \t]+$/, ""));
        prevBlank = blank;
    }
    while (res.length && res[0].trim() === "") res.shift();
    while (res.length && res[res.length - 1].trim() === "") res.pop();
    return res.join("\n") + "\n";
}

function walk(dir, cb) {
    fs.readdirSync(dir).forEach(function (name) {
        var p = path.join(dir, name);
        var st = fs.statSync(p);
        if (st.isDirectory()) walk(p, cb);
        else cb(p);
    });
}

var totalBefore = 0, totalAfter = 0, touched = 0;
walk(target, function (file) {
    var ext = path.extname(file).toLowerCase();
    var stripper;
    if (ext === ".js") stripper = stripJs;
    else if (ext === ".css" || ext === ".vcss") stripper = function (s) { return stripBlock(s, "/*", "*/"); };
    else if (ext === ".xml" || ext === ".vxml") stripper = function (s) { return stripBlock(s, "<!--", "-->"); };
    else return;

    var before = fs.readFileSync(file, "utf8");
    var after = stripper(before);
    totalBefore += before.length;
    totalAfter += after.length;
    if (after !== before) {
        touched++;
        var rel = path.relative(target, file);
        var saved = before.length - after.length;
        console.log((dry ? "[dry] " : "") + rel + "  -" + saved + " bytes");
        if (!dry) fs.writeFileSync(file, after);
    }
});

console.log("\n" + (dry ? "would strip " : "stripped ") + touched + " files, " +
    (totalBefore - totalAfter) + " bytes removed" +
    (dry ? " (no files written)" : ""));
