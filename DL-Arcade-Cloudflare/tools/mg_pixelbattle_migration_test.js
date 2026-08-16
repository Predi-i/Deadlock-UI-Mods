"use strict";

const fs = require("fs");
const path = require("path");
const v8 = require("v8");

let source = fs.readFileSync(path.join(__dirname, "..", "server", "worker.js"), "utf8");
source = source.replace("export default", "const Worker =").replace("export class Hub", "class Hub");
source = source.replace(/^export function /gm, "function ");
source += "\n;return { Worker, Hub };";
const { Worker, Hub } = new Function(source)();

class FakeStorage {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.has(key) ? this.values.get(key) : undefined; }
    async put(key, value) { this.values.set(String(key), v8.deserialize(v8.serialize(value))); }
    async delete(key) { return this.values.delete(String(key)); }
    async list(options) {
        const prefix = String(options?.prefix || "");
        const entries = [...this.values.entries()].filter(([key]) => key.startsWith(prefix));
        entries.sort((a, b) => a[0].localeCompare(b[0]));
        if (options?.limit) entries.length = Math.min(entries.length, options.limit);
        return new Map(entries);
    }
    async transaction(callback) {
        const copy = new FakeStorage();
        for (const [key, value] of this.values) await copy.put(key, value);
        const result = await callback(copy);
        this.values = copy.values;
        return result;
    }
}

let passed = 0;
function ok(condition, message) {
    if (!condition) throw new Error(message);
    passed++;
    console.log(`  ✓ ${message}`);
}

function encoded(bytes, kind) {
    return {
        $typed: kind,
        base64: Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    };
}

async function hubCall(hub, body, authorized) {
    const response = await hub.fetch(new Request("https://test/internal/pixel-migration", {
        method: "POST",
        headers: authorized === false ? {} : { "X-MG-Pixel-Migration": "authorized" },
        body: JSON.stringify(body)
    }));
    return { status: response.status, body: await response.json() };
}

(async () => {
    const storage = new FakeStorage(), hub = new Hub({ storage }, {});
    const id = "a".repeat(64);
    let result = await hubCall(hub, { action: "begin", id, total: 3 }, false);
    ok(result.status === 403, "direct Durable Object migration access is rejected");

    result = await hubCall(hub, { action: "begin", id, total: 3 });
    ok(result.status === 201 && result.body.next === 0, "empty target accepts a migration manifest");
    result = await hubCall(hub, { action: "chunk", id, start: 0, records: [
        { key: "px:t:0", value: encoded([0, 2, 3, 0], "u8") },
        { key: "px:o:0", value: { entries: ["action"], refs: encoded([1, 0, 2, 0], "u16") } }
    ] });
    ok(result.status === 200 && result.body.next === 2, "typed Pixel Battle records import transactionally");
    result = await hubCall(hub, { action: "chunk", id, start: 0, records: [
        { key: "px:t:0", value: encoded([0, 2, 3, 0], "u8") },
        { key: "px:o:0", value: { entries: ["action"], refs: encoded([1, 0, 2, 0], "u16") } }
    ] });
    ok(result.body.duplicate === true && result.body.next === 2, "a retried acknowledged chunk is idempotent");
    result = await hubCall(hub, { action: "finish", id });
    ok(result.status === 409, "an incomplete import cannot be finalized");
    result = await hubCall(hub, { action: "chunk", id, start: 2, records: [
        { key: "px:version", value: 37 }
    ] });
    ok(result.body.next === 3, "the final chunk advances the exact record cursor");
    result = await hubCall(hub, { action: "finish", id });
    ok(result.body.status === "complete", "complete import is sealed with a durable marker");
    ok((await storage.get("px:t:0")) instanceof Uint8Array, "canvas tile remains Uint8Array");
    ok((await storage.get("px:o:0")).refs instanceof Uint16Array, "ownership refs remain Uint16Array");

    const occupiedStorage = new FakeStorage();
    await occupiedStorage.put("px:version", 1);
    const occupiedHub = new Hub({ storage: occupiedStorage }, {});
    result = await hubCall(occupiedHub, { action: "begin", id: "b".repeat(64), total: 1 });
    ok(result.status === 409, "non-empty target refuses an accidental overwrite");

    const secret = "migration-secret-that-is-longer-than-32-characters";
    const env = {
        PIXEL_MIGRATION_SECRET: secret,
        HUB: { idFromName: () => "hub", get: () => hub }
    };
    const requestBody = JSON.stringify({ action: "status", id });
    let response = await Worker.fetch(new Request("https://test/internal/pixel-migration", {
        method: "POST", body: requestBody, headers: { Authorization: "Bearer wrong" }
    }), env);
    ok(response.status === 401, "outer Worker rejects a wrong migration secret");
    response = await Worker.fetch(new Request("https://test/internal/pixel-migration", {
        method: "POST", body: requestBody, headers: { Authorization: `Bearer ${secret}` }
    }), env);
    ok(response.status === 200 && (await response.json()).status === "complete",
        "outer Worker authorizes and forwards the one-time migration request");

    console.log(`Pixel Battle migration tests passed (${passed} checks)`);
})().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
