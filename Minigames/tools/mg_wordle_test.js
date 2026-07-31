"use strict";

// Pure duplicate-letter scoring checks for panorama/scripts/mg_wordle.js.
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
    path.join(__dirname, "..", "panorama", "scripts", "mg_wordle.js"), "utf8"
);
const wordsSource = fs.readFileSync(
    path.join(__dirname, "..", "panorama", "scripts", "mg_wordle_words.generated.js"), "utf8"
);
const layoutSource = fs.readFileSync(
    path.join(__dirname, "..", "panorama", "layout", "base_hud.xml"), "utf8"
);
const panorama = { MG: {} };
new Function("$", wordsSource)(panorama);
const wordLists = panorama.MG.WordleWords;
const startMarker = "// ── wordle pure scoring ──";
const endMarker = "// ── end wordle pure scoring ──";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error("Wordle scoring markers not found");
const body = source.slice(start + startMarker.length, end);
const scoreGuess = new Function(body + "\nreturn scoreGuess;")();

let failed = 0;
function check(condition, label) {
    console.log("  " + (condition ? "PASS " : "FAIL ") + label);
    if (!condition) failed++;
}
function same(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log("  " + (ok ? "✓ " : "✗ ") + label);
    if (!ok) {
        console.log("    expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
        failed++;
    }
}

check(wordLists.answers.length >= 3000, "dictionary has at least 3,000 possible answers");
check(wordLists.guesses.length >= 10000, "dictionary has at least 10,000 extra guesses");
check(wordLists.answers.indexOf("APPLE") >= 0, "common answer APPLE is present");
check(wordLists.guesses.indexOf("AAHED") >= 0, "extended valid guesses are present");
check(source.indexOf("ANSWERS = MG.WordleWords.answers") >= 0,
    "controller replaces its fallback with the full answer list");
check(layoutSource.indexOf("mg_wordle_words.generated.vjs_c") <
    layoutSource.indexOf("mg_wordle.vjs_c"), "dictionary loads before the controller");
const allWords = wordLists.answers.concat(wordLists.guesses);
check(allWords.every((word) => { return /^[A-Z]{5}$/.test(word); }),
    "every dictionary entry is exactly five ASCII letters");
check(new Set(allWords).size === allWords.length, "dictionary entries are unique");

same(scoreGuess("APPLE", "APPLE"), [2, 2, 2, 2, 2], "all exact letters score green");
same(scoreGuess("APPLE", "ALLEY"), [2, 1, 0, 1, 0],
    "a duplicate guess cannot consume one answer letter twice");
same(scoreGuess("LEVEL", "HELLO"), [0, 2, 1, 1, 0],
    "two remaining duplicate letters may both score present");
same(scoreGuess("BANAL", "ALARM"), [1, 1, 1, 0, 0],
    "present-letter counts are consumed independently");

if (failed) {
    console.error("\n" + failed + " WORDLE FAILURE(S)");
    process.exitCode = 1;
} else {
    console.log("\nAll Wordle scoring tests passed.");
}
