"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    console.log(`  ✓ ${message}`);
};

const wranglerText = read("server/wrangler.jsonc");
const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, ""));
const pkg = JSON.parse(read("package.json"));
const net = read("panorama/scripts/mg_net.js");
const pixel = read("panorama/scripts/mg_pixelbattle.js");
const worker = read("server/worker.core.js");

assert(wrangler.name === "dl-arcade-cloudflare", "Worker has its own Cloudflare service name");
assert(wrangler.main === "worker.js", "Wrangler deploys the generated Worker entry point");
assert(wrangler.workers_dev === true, "workers.dev is enabled for the first deployment");
assert(wrangler.durable_objects?.bindings?.some(
    (binding) => binding.name === "HUB" && binding.class_name === "Hub"),
"HUB binding targets the Hub Durable Object");
assert(wrangler.exports?.Hub?.type === "durable-object" &&
    wrangler.exports.Hub.storage === "sqlite", "Hub uses declarative SQLite Durable Object storage");
assert(!Object.hasOwn(wrangler, "migrations"), "new service does not use legacy migration tags");
assert(pkg.scripts["deploy:worker"]?.includes("build:worker"),
    "production deploy regenerates worker.js first");
assert(!fs.existsSync(path.join(root, "server", "node_server.js")) &&
    !fs.existsSync(path.join(root, "server", "node_storage.js")),
"VPS Node adapters are absent from the Cloudflare edition");
assert(/const BASE_URL = "";/.test(net) && /\^https:\\\/\\\/\[\^\/\]\+\$/.test(net),
    "client stays disabled until an HTTPS Worker host is configured");
assert(/POLL_ACTIVE_S = 8, POLL_WARM_S = 15, POLL_IDLE_S = 30/.test(pixel),
    "Pixel Battle uses the Cloudflare Free backoff profile");
assert(/DIMENSION_PNG_CACHE/.test(worker) && /new CompressionStream\("deflate"\)/.test(worker),
    "Worker PNG responses use native compression and dimension caching");

console.log("Cloudflare migration configuration checks passed");
