import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { setDefaultResultOrder } from "node:dns";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import worker, { Hub, statsRouteKey, statsSentinelKey } from "./worker.js";
import { SqliteStorage } from "./node_storage.js";

const DEFAULT_BODY_LIMIT = 512 * 1024;
const STATS_FLUSH_MS = 30000;
// Bound on distinct client IPs tracked per hour. Only the SIZE of this set is ever
// persisted - no address reaches SQLite or the daily backups. The cap means a spoofed-IP
// flood costs a fixed amount of memory and merely under-reports the unique count.
const STATS_MAX_IPS = 20000;

/**
 * In-memory request counters, flushed to storage as batched deltas.
 *
 * Counting inside the Hub would add a SQLite write to every /api/poll - one per player per
 * second. Instead each response updates plain objects here, and a timer hands the whole
 * batch to Hub.recordStats through the same serialized tail that lobby writes use.
 *
 * record() is called from the request handler's finally block, so it MUST NOT throw: an
 * exception there would surface to the client as a failed request on a route that actually
 * worked. Every field is defensive for that reason.
 */
class StatsCollector {
  constructor() {
    this.hour = "";
    this.batch = null;
    this.ips = null;
    // Batches closed by an hour rollover or returned by a failed flush. Drained ahead of
    // the live batch. A queue, not a single slot: two rollovers before a successful flush
    // (or a rollover plus a write failure) must not discard the earlier hour's counters.
    this.pending = [];
    this.resetBatch(new Date().toISOString().substring(0, 13));
  }

  resetBatch(hour) {
    this.hour = hour;
    this.batch = {
      hour: hour, total: 0, routes: {}, statuses: {}, sentinels: {},
      msSum: 0, msMax: 0, bytes: 0, ipCount: 0
    };
    this.ips = new Set();
  }

  record(entry) {
    try {
      const hour = new Date().toISOString().substring(0, 13);
      // Crossing an hour boundary starts a fresh unique-IP set, so the count is per hour
      // rather than cumulative. Any unflushed counters are carried into the new batch's
      // hour key by the flush that follows; totals are deltas, so nothing is lost.
      if (hour !== this.hour) {
        const carried = this.batch;
        this.resetBatch(hour);
        if (carried.total) this.pending.push(carried);
      }
      const batch = this.batch;
      batch.total++;
      const route = statsRouteKey(entry.pathname);
      batch.routes[route] = (batch.routes[route] || 0) + 1;
      const status = String(entry.status || 0);
      batch.statuses[status] = (batch.statuses[status] || 0) + 1;
      batch.msSum += entry.ms;
      if (entry.ms > batch.msMax) batch.msMax = entry.ms;
      batch.bytes += entry.bytes;
      if (entry.sentinel) {
        batch.sentinels[entry.sentinel] = (batch.sentinels[entry.sentinel] || 0) + 1;
      }
      if (entry.ip && this.ips.size < STATS_MAX_IPS) this.ips.add(entry.ip);
      batch.ipCount = this.ips.size;
    } catch (error) {
      // Statistics are never worth failing a request over.
    }
  }

  // Hand over everything accumulated so far and start clean. Counters are deltas, so a
  // failed write can be re-merged by the caller without double-counting anything else.
  drain() {
    const out = this.pending;
    this.pending = [];
    if (this.batch.total) {
      out.push(this.batch);
      this.resetBatchPreservingIps();
    }
    return out;
  }

  // Return unwritten batches to the front of the queue, preserving chronological order.
  requeue(batches) {
    if (batches.length) this.pending = batches.concat(this.pending);
  }

  // A flush mid-hour must not forget which IPs were already seen, or the next flush would
  // report a smaller unique count and the stored max would stay stale.
  resetBatchPreservingIps() {
    const ips = this.ips;
    this.batch = {
      hour: this.hour, total: 0, routes: {}, statuses: {}, sentinels: {},
      msSum: 0, msMax: 0, bytes: 0, ipCount: ips.size
    };
    this.ips = ips;
  }
}

// Read the PNG dimensions back out of a protocol reply so the sentinel can be named.
// Only the IHDR fields are touched, and only for small image responses.
function sentinelFromBody(route, contentType, body) {
  if (!body || body.length < 24 || body.length > 4096) return "";
  if (String(contentType || "").indexOf("image/png") < 0) return "";
  const width = body.readUInt32BE(16), height = body.readUInt32BE(20);
  return statsSentinelKey(route, width, height);
}

/**
 * systemd watchdog notifier (sd_notify over AF_UNIX, no dependency needed).
 *
 * Why this exists: on 2026-08-02 an infinite loop in the poker rules pinned a core at 100% and
 * the relay stopped answering for five hours. `Restart=always` never fired, because the process
 * had not died - systemd still saw it as active. Only a liveness signal can distinguish "running"
 * from "wedged".
 *
 * The heartbeat is deliberately routed through the Hub's serialized queue rather than sent
 * straight from the timer. A blocked event loop stops both, but a Hub tail that is stuck (the
 * actual failure mode here, since every request funnels through it) would otherwise keep looking
 * healthy while no player can be served.
 *
 * Silently inert when NOTIFY_SOCKET is unset, so local runs and tests are unaffected.
 */
function createWatchdog(onBeat) {
  const address = process.env.NOTIFY_SOCKET || "";
  if (!address) return { start: function () {}, stop: function () {} };
  // A leading '@' denotes a Linux abstract namespace socket, encoded as a leading NUL byte.
  const target = address.startsWith("@") ? `\0${address.substring(1)}` : address;
  // WATCHDOG_USEC is what systemd derived from WatchdogSec. Ping at a third of it so two
  // consecutive lost beats are still not fatal; a wedge misses every beat and trips it anyway.
  const microseconds = Number(process.env.WATCHDOG_USEC);
  const period = Number.isFinite(microseconds) && microseconds > 0 ?
    Math.max(1000, Math.floor(microseconds / 3000)) : STATS_FLUSH_MS;
  let socket = null, timer = null, inFlight = false;

  function send(payload) {
    if (!socket) return;
    socket.send(Buffer.from(payload), 0, Buffer.byteLength(payload), target, function (error) {
      // A failed notification must never take the relay down with it.
      if (error) console.error("watchdog notify failed:", error.message);
    });
  }

  function beat() {
    // Skip rather than queue if the previous probe has not come back: piling probes onto a
    // stalled tail would only add work, and missing the beats is exactly the signal we want.
    if (inFlight) return;
    inFlight = true;
    Promise.resolve().then(onBeat).then(function () {
      send("WATCHDOG=1");
    }, function (error) {
      // Deliberately no WATCHDOG=1: a failing probe should trip the watchdog.
      console.error("watchdog probe failed:", error);
    }).then(function () { inFlight = false; });
  }

  return {
    start: function () {
      socket = createSocket("unix_dgram");
      socket.on("error", function (error) {
        console.error("watchdog socket error:", error.message);
      });
      socket.unref();
      send("READY=1");
      timer = setInterval(beat, period);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop: function () {
      if (timer) clearInterval(timer);
      timer = null;
      if (socket) { send("STOPPING=1"); try { socket.close(); } catch (error) {} }
      socket = null;
    }
  };
}

// The production VPS has working IPv4 egress but no routed IPv6. Node's fetch can otherwise
// select upload.wikimedia.org's AAAA record first and fail GeoGuesser panorama proxying even
// though the same URL is reachable over IPv4.
setDefaultResultOrder("ipv4first");

// worker.core.js remains deployable to Cloudflare, where synchronous zlib does not
// exist. The VPS runtime supplies it explicitly for dimension-only PNG responses.
globalThis.MG_NODE_DEFLATE_SYNC = function (bytes) {
  return deflateSync(bytes, { level: 1 });
};

function envInteger(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function normaliseIp(value) {
  const ip = String(value || "");
  return ip.startsWith("::ffff:") ? ip.substring(7) : ip;
}

function trustedClientIp(request) {
  const peer = normaliseIp(request.socket.remoteAddress);
  const fromLoopback = peer === "127.0.0.1" || peer === "::1";
  const forwarded = String(request.headers["x-real-ip"] || "").trim();
  // Nginx is the only process that can reach the loopback-bound app in production
  // and overwrites X-Real-IP. Never trust a forwarding header from a direct peer.
  return fromLoopback && isIP(forwarded) ? forwarded : peer;
}

function readBody(request, limit) {
  return new Promise(function (resolveBody, rejectBody) {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(Object.assign(new Error("Request body is too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolveBody(chunks.length ? Buffer.concat(chunks) : null);
    });
    request.on("error", rejectBody);
  });
}

function copyResponseHeaders(response, outgoing) {
  const setCookies = typeof response.headers.getSetCookie === "function" ?
    response.headers.getSetCookie() : [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  if (setCookies.length) outgoing.setHeader("set-cookie", setCookies);
}

export function createMinigamesServer(options) {
  const opts = options || {};
  const databasePath = resolve(opts.databasePath ||
    process.env.MG_DATABASE_PATH || "./data/minigames.sqlite");
  const publicOrigin = String(opts.publicOrigin ||
    process.env.MG_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const bodyLimit = envInteger("MG_BODY_LIMIT", DEFAULT_BODY_LIMIT, 1024, 4 * 1024 * 1024);
  const storage = new SqliteStorage(databasePath);
  // Second argument mirrors the Durable Object contract (state, env). GeoGuesser reads
  // MG_MAPILLARY_TOKEN from it; without one, its Mapillary rounds cannot resolve an image URL and
  // the game falls back to the pool's Panoramax rows.
  const hub = new Hub({ storage: storage }, process.env);
  const stats = new StatsCollector();

  // A Durable Object processes one request at a time. Preserve that property here so
  // read-modify-write lobby updates and SQLite transactions cannot interleave.
  let hubTail = Promise.resolve();
  function serialHubFetch(request) {
    const current = hubTail.then(
      function () { return hub.fetch(request); },
      function () { return hub.fetch(request); }
    );
    hubTail = current.catch(() => {});
    return current;
  }

  // Persisting counters is a read-modify-write on the same storage the Hub owns, so it must
  // join the same queue rather than race it. On failure the batch is merged back so the next
  // flush retries it: counters are deltas, so a retry cannot double-count.
  function serialHubTask(task) {
    const current = hubTail.then(task, task);
    hubTail = current.catch(() => {});
    return current;
  }

  async function flushStats() {
    const batches = stats.drain();
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        await serialHubTask(function () { return hub.recordStats(batch); });
      } catch (error) {
        // Keep this batch AND every later one, so a transient write failure cannot
        // reorder or drop counters.
        console.error("stats flush failed:", error);
        stats.requeue(batches.slice(i));
        return;
      }
    }
  }

  const workerEnv = Object.assign({}, process.env, {
    HUB: {
      idFromName: function () { return "hub"; },
      get: function () {
        return { fetch: serialHubFetch };
      }
    }
  });

  const server = createServer(async function (incoming, outgoing) {
    const startedAt = Date.now();
    let statsPath = incoming.url || "/";
    let statsStatus = 500, statsBytes = 0, statsSentinel = "", statsIp = "";
    try {
      const host = incoming.headers.host || "127.0.0.1";
      const origin = publicOrigin || `http://${host}`;
      const url = new URL(incoming.url || "/", origin);
      statsPath = url.pathname;
      const headers = new Headers();
      for (const name of Object.keys(incoming.headers)) {
        const value = incoming.headers[name];
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) headers.append(name, value[i]);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }

      // Never trust a caller-supplied Cloudflare header. Production Nginx reaches this
      // loopback-only service and overwrites X-Real-IP with its socket's remote address.
      headers.delete("CF-Connecting-IP");
      const clientIp = trustedClientIp(incoming);
      statsIp = clientIp;
      headers.set("CF-Connecting-IP", clientIp);

      const method = incoming.method || "GET";
      const body = method === "GET" || method === "HEAD" ?
        null : await readBody(incoming, bodyLimit);
      const requestInit = { method: method, headers: headers };
      if (body) requestInit.body = body;
      const response = await worker.fetch(new Request(url, requestInit), workerEnv);
      const responseBody = Buffer.from(await response.arrayBuffer());
      statsStatus = response.status;
      statsBytes = responseBody.length;
      statsSentinel = sentinelFromBody(statsRouteKey(url.pathname),
        response.headers.get("content-type"), responseBody);

      outgoing.statusCode = response.status;
      copyResponseHeaders(response, outgoing);
      outgoing.setHeader("content-length", String(responseBody.length));
      outgoing.setHeader("x-content-type-options", "nosniff");
      outgoing.end(method === "HEAD" ? null : responseBody);
    } catch (error) {
      const status = error && error.statusCode ? error.statusCode : 500;
      const message = status === 413 ? "Request body too large" : "Internal server error";
      statsStatus = status;
      if (status >= 500) console.error("Request failed:", error);
      if (!outgoing.headersSent) {
        outgoing.statusCode = status;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
        outgoing.setHeader("cache-control", "no-store");
      }
      outgoing.end(message);
    } finally {
      stats.record({
        pathname: statsPath,
        status: statsStatus,
        ms: Date.now() - startedAt,
        bytes: statsBytes,
        sentinel: statsSentinel,
        ip: statsIp
      });
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 30000;
  server.on("clientError", (error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  // unref() so a pending flush timer can never hold the process open during shutdown.
  const flushTimer = setInterval(function () { flushStats(); }, STATS_FLUSH_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();

  // Liveness probe: an empty task through the same tail every request uses. It resolves only if
  // the event loop runs AND the Hub queue is draining, which is precisely "can serve a player".
  const watchdog = createWatchdog(function () {
    return serialHubTask(function () { return null; });
  });

  return {
    server: server,
    storage: storage,
    stats: stats,
    flushStats: flushStats,
    watchdog: watchdog,
    close: function () {
      clearInterval(flushTimer);
      watchdog.stop();
      return new Promise(function (resolveClose, rejectClose) {
        server.close(async (error) => {
          if (error) { rejectClose(error); return; }
          // Persist the final partial window before the database closes, so a deploy
          // restart does not silently drop up to STATS_FLUSH_MS of counters.
          try { await flushStats(); } catch (flushError) {
            console.error("final stats flush failed:", flushError);
          }
          storage.close();
          resolveClose();
        });
      });
    }
  };
}

function isMainModule() {
  return process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const port = envInteger("PORT", 8787, 0, 65535);
  const host = process.env.HOST || "127.0.0.1";
  const runtime = createMinigamesServer();
  runtime.server.listen(port, host, () => {
    const address = runtime.server.address();
    console.log(`deadlock-minigames listening on ${address.address}:${address.port}`);
    // Only announce readiness once the socket is actually accepting connections.
    runtime.watchdog.start();
  });

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`received ${signal}, shutting down`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error("shutdown failed:", error);
      process.exit(1);
    }
  }
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });
}
