"use strict";

// Flat ESLint config (ESLint 9/10) adapted from QOLLOCK for Deadlock-Fly.
// Static bug net against undefined variables (no-undef), dead code, syntax hazards,
// and Panorama ASI continuation-line pitfalls.

const PANORAMA_GLOBALS = {
	$: "readonly",
	panorama: "readonly",
	Game: "readonly",
	GameUI: "readonly",
	GameEvents: "readonly",
	CitadelConCommand: "readonly",
	DropInputFocus: "readonly",
};

const FLY_GLOBALS = {
	FLY_MOD: "writable",
};

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
	setInterval: "readonly",
	clearInterval: "readonly",
};

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
	"no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
};

module.exports = [
	{
		ignores: [
			"node_modules/**",
			"*.png",
			"*.svg",
		],
	},

	// Deadlock-Fly Panorama scripts (core & features)
	{
		files: ["panorama/scripts/**/*.js"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "script",
			globals: Object.assign({}, SHARED_GLOBALS, PANORAMA_GLOBALS, FLY_GLOBALS),
		},
		rules: BUG_RULES,
	},

	// Valve minifier ASI protection
	{
		files: ["panorama/scripts/**/*.js"],
		rules: {
			"operator-linebreak": ["error", "after", { overrides: { "?": "ignore", ":": "ignore" } }],
		},
	},
];
