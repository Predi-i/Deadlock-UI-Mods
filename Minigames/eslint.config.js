"use strict";

// Flat ESLint config (ESLint 9). PURPOSE: one cheap static guard against the class of bug
// that keeps shipping green past `node --check` + the rules tests — a call to a name that
// isn't defined in that scope (e.g. `sfx` used in the TTT controller that never declared it;
// `Net.pollDelay` where no `Net` alias exists). `node --check` only parses syntax and never
// runs the offending branch; the test harnesses exercise the pure engines + worker, NOT the
// Panorama controllers (they can't run outside the game). So `no-undef` is the net that would
// have caught both. See memory: controllers-zero-coverage-eslint.
//
// Deliberately NARROW: this is a bug net, not a style linter. Only correctness rules that
// can't false-positive on the existing (working, in-game-verified) code are enabled as errors.
// Everything stylistic stays off so `npm run lint` is signal, not noise.

const js = require("@eslint/js");

// Panorama's JS runtime globals (NOT a browser). `$` is the shared per-panel object every
// script hangs state off; the others are the engine bridges the mod actually references.
// Read-only: the mod never reassigns them, and flagging an accidental reassignment is useful.
const PANORAMA_GLOBALS = {
    $: "readonly",
    panorama: "readonly",
    Game: "readonly",
    GameUI: "readonly",
    GameEvents: "readonly",
};

// Node globals for the dev-only tools + the authored worker (run/bundled with `node`).
const NODE_GLOBALS = {
    require: "readonly",
    module: "writable",
    exports: "writable",
    process: "readonly",
    console: "readonly",
    __dirname: "readonly",
    __filename: "readonly",
    Buffer: "readonly",
    // Cloudflare Worker runtime bits worker.core.js references directly.
    Response: "readonly",
    Request: "readonly",
    Headers: "readonly",
    URL: "readonly",
    URLSearchParams: "readonly",
    TextEncoder: "readonly",
    TextDecoder: "readonly",
    fetch: "readonly",
    atob: "readonly",
};

// ES built-ins used across BOTH environments. Listed explicitly so the config doesn't depend
// on an `env`/ecmaVersion combo silently including or dropping one of them.
const SHARED_GLOBALS = {
    globalThis: "readonly",
    crypto: "readonly",
    Math: "readonly",
    JSON: "readonly",
    Date: "readonly",
    Array: "readonly",
    Object: "readonly",
    String: "readonly",
    Number: "readonly",
    Boolean: "readonly",
    RegExp: "readonly",
    Error: "readonly",
    Promise: "readonly",
    Map: "readonly",
    Set: "readonly",
    Function: "readonly",
    Uint8Array: "readonly",
    Uint32Array: "readonly",
    parseInt: "readonly",
    parseFloat: "readonly",
    isFinite: "readonly",
    isNaN: "readonly",
    encodeURIComponent: "readonly",
    decodeURIComponent: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
};

// The one rule set that matters here. `no-undef` is the guard; the rest defend against silent
// mistakes that also survive `node --check` (an unreachable `return`, a duplicate key/case,
// a comparison that's always false). All as errors so `npm run lint` fails CI-style.
const BUG_RULES = {
    "no-undef": "error",
    "no-unreachable": "error",
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-duplicate-case": "error",
    "no-func-assign": "error",
    "no-cond-assign": ["error", "except-parens"],
    "no-constant-condition": ["error", { checkLoops: false }],
    "no-self-assign": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-sparse-arrays": "error",
    "no-fallthrough": "error",
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-shadow-restricted-names": "error",
    "no-unsafe-negation": "error",
    "no-compare-neg-zero": "error",
    "no-irregular-whitespace": "error",
    "no-template-curly-in-string": "error",
    "getter-return": "error",
    "no-obj-calls": "error",
    "no-unmodified-loop-condition": "error",
    "no-unsafe-finally": "error",
    "no-const-assign": "error",
    "no-dupe-class-members": "error",
    // WARN, not error: admin_panel.js defines helpers that worker.core.js calls only AFTER
    // build_worker.js concatenates them, so ESLint sees them as unused in isolation.
    "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
};

module.exports = [
    { ignores: ["node_modules/**", "server/worker.js"] },

    // Shipped Panorama scripts (controllers + rules + net + sound + ui).
    {
        files: ["panorama/scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script",
            globals: Object.assign({}, SHARED_GLOBALS, PANORAMA_GLOBALS),
        },
        rules: BUG_RULES,
    },

    // Dev-only Node tools (CommonJS: require/module.exports) + this config file.
    {
        files: ["tools/**/*.js", "eslint.config.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "script",
            globals: Object.assign({}, SHARED_GLOBALS, NODE_GLOBALS),
        },
        rules: BUG_RULES,
    },

    // The AUTHORED worker source is an ES MODULE (export default {} / export class Hub).
    // worker.js is the generated artifact → ignored above. Same Node/Worker globals, but
    // sourceType:module so the top-level `export` parses.
    {
        files: ["server/worker.core.js", "server/admin_panel.js"],
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: "module",
            globals: Object.assign({}, SHARED_GLOBALS, NODE_GLOBALS),
        },
        rules: BUG_RULES,
    },

    // SHIPPED scripts only: never start a continuation line with a binary operator. Valve's
    // Panorama minifier does a naive ASI pass and inserts a ';' before a line beginning with
    // ( [ + - / — which already broke a public build once (mg_games.js:665-667). Keeping
    // operators at the END of the line makes the whole class impossible.
    // `?` and `:` are EXEMPT: they are not in the minifier's trigger set, and the codebase
    // consistently writes multi-line ternaries with the operator leading. Generated files are
    // exempt too (machine-written, and the word list redeclares `$`).
    {
        files: ["panorama/scripts/**/*.js"],
        ignores: ["panorama/scripts/**/*.generated.js"],
        rules: {
            "operator-linebreak": ["error", "after", { overrides: { "?": "ignore", ":": "ignore" } }],
        },
    },
];
