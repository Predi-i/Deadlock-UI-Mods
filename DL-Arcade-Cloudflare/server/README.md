# DL Arcade Cloudflare backend

Production is an ES-module Cloudflare Worker with one named SQLite-backed Durable Object, `Hub`.
All lobby operations are serialized by that object, so the existing authoritative game model is
preserved without the former Node/Nginx/SQLite VPS adapter.

## Files

- `worker.core.js` — authored routes, validation, matchmaking, Pixel Battle, GeoGuesser and PNG encoding.
- `worker.js` — generated shared rules + maps + admin assets + `worker.core.js`; never edit by hand.
- `wrangler.jsonc` — Worker name, `HUB` binding, observability and declarative SQLite DO export.
- `admin_panel.js` — browser admin assets; authorization is enforced by `worker.core.js`.
- `.dev.vars.example` — names required for local OAuth/Mapillary testing, without real values.

## Commands

Run from `DL-Arcade-Cloudflare`:

```powershell
npm run build:worker
npm run deploy:worker:dry
npm run dev:worker
npm run deploy:worker
npm run tail:worker
```

Wrangler resolves paths relative to this directory's `wrangler.jsonc` even though the command is
run from the project root. The deploy script always regenerates `worker.js` first.

## State

`env.HUB.idFromName("hub")` selects one global consistency domain. Its SQLite-backed Durable
Object storage contains lobbies, Pixel Battle tiles/banks/audit/ownership/bans and admin data.
Ephemeral rate-limit and image caches are deliberately in memory and reset when Cloudflare evicts
the object.

Live lobbies are intentionally not migrated. Pixel Battle has an explicit one-time migration:
`tools/mg_pixelbattle_export.js` reads every `px:*` record from a consistent VPS SQLite backup,
and `tools/mg_pixelbattle_import.js` uploads canvas tiles, ownership, audit, banks and bans in
ordered chunks. The target must be empty, retries are idempotent, typed arrays retain their types,
and the importer verifies the public canvas SHA-256 after completion.

Cloudflare supplies trusted `CF-Connecting-IP`, so the existing per-IP soft abuse controls need no
proxy-header adapter. GeoGuesser uses outbound `fetch`; `MG_MAPILLARY_TOKEN` is optional because
Panoramax rows remain available without it.

## Secrets

The admin remains fail-closed until all four are present:

```text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
ADMIN_GITHUB_ID
ADMIN_SESSION_SECRET       # at least 32 characters
```

Optional:

```text
MG_MAPILLARY_TOKEN
PIXEL_MIGRATION_SECRET    # one-time only; delete immediately after a successful import
```

Use `npx wrangler secret put NAME --config server/wrangler.jsonc`. Never place production values
in `wrangler.jsonc`, `.dev.vars.example` or any committed file. See `ADMIN_SETUP.md` and the root
`CLOUDFLARE_SETUP.md`.

`/internal/pixel-migration` returns 503 unless `PIXEL_MIGRATION_SECRET` is configured. The outer
Worker checks its bearer token, strips it before forwarding, and injects an internal authorization
header. The Durable Object refuses direct access and refuses to begin when any `px:*` target data
already exists.

## Operational notes

- `https://<host>/api/ping.png` is the basic health check.
- `npm run tail:worker` streams Worker logs.
- Cloudflare Metrics is the authoritative request/quota view. The old VPS-only in-process request
  collector is not on the request path in this edition; `/admin/stats` may therefore be empty.
- Workers Free is capped at 100,000 requests/day and 10 ms CPU for the outer Worker invocation;
  the Durable Object has its own Free allowance and limits. Pixel Battle rendering happens inside
  the DO and uses native `CompressionStream` for PNG output.
- SQLite-backed DO point-in-time recovery is managed by Cloudflare. Do not delete or rename the
  `Hub` export casually: lifecycle changes can destroy or move the namespace.
