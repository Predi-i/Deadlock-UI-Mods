# Deadlock Minigames — VPS relay

This directory contains the authoritative backend for the in-game minigames. Production runs
directly on the Aéza VPS at `https://178.236.246.13`; Cloudflare Workers and Durable Objects are
no longer in the request path.

Panorama still uses the same image side-channel protocol: protocol replies are PNGs whose intrinsic
width and height encode two integers. GeoGuesser's authenticated `/api/geoview` is the deliberate
exception and returns the current panorama image itself. The migration changes hosting and storage,
not the shared game rules.

## Runtime layout

- `worker.core.js` — authored routes, validation, matchmaking, Pixel Battle, GeoGuesser and PNG encoding.
- `worker.js` — generated rules + map + admin assets + `worker.core.js`; never edit by hand.
- `node_server.js` — Node HTTP adapter, trusted Nginx client-IP injection and serialized Hub execution.
- `node_storage.js` — Durable Object storage-compatible SQLite adapter.
- `package.json` — marks this directory as ESM and pins the minimum Node major.
- `deploy/` — systemd, Nginx, backup, certificate-renewal and hardening configuration.
- `wrangler.jsonc` — retained only as historical/rollback configuration; production does not use it.

The Node adapter calls the same exported Worker entry point used previously. Its local `HUB`
binding owns one `Hub` instance and serializes requests exactly as the single Durable Object did.
Values are stored in SQLite using V8 structured serialization, so typed Pixel Battle tiles and
plain lobby objects round-trip without JSON conversion.

Production paths:

```text
/opt/deadlock-minigames/                         immutable application files
/var/lib/deadlock-minigames/minigames.sqlite    live SQLite database
/var/backups/deadlock-minigames/                 daily compressed backups (14-day retention)
/etc/deadlock-minigames.env                      optional GitHub OAuth secrets
/etc/letsencrypt/live/178.236.246.13/            short-lived IP certificate
```

## Build and verify

From the repository root:

```bash
npm run build:worker
npm run lint
npm test
```

`npm test` includes `mg_vps_server_test.js`, which starts the real Node HTTP adapter against a
temporary SQLite file and verifies protocol dimensions, restart persistence, Pixel Battle state
and fail-closed admin authentication. `mg_server_test.js` covers GeoGuesser's hidden target,
authenticated image proxy, guess/reveal/score flow, all five ready-gated rounds and server-filled
Play Solo sessions.

## Production service

The app listens only on `127.0.0.1:8787`. Nginx owns public ports 80/443, redirects normal HTTP to
HTTPS and forwards HTTPS requests to Node. The service is intentionally a single Node process:
the original Hub is a single consistency domain, and its small state updates benefit more from
strict ordering than from multiple workers contending over the same SQLite file.
Nginx overwrites `X-Real-IP` from the public socket; Node accepts it only from a loopback peer and
replaces any caller-supplied `CF-Connecting-IP`, keeping per-IP abuse controls trustworthy.

Useful commands:

```bash
systemctl status deadlock-minigames
journalctl -u deadlock-minigames -f
systemctl restart deadlock-minigames

curl -fsS https://178.236.246.13/api/ping.png -o /dev/null
sqlite3 /var/lib/deadlock-minigames/minigames.sqlite 'PRAGMA integrity_check;'
```

From the repository root, `node tools/mg_geo_live_smoke.js https://178.236.246.13`
exercises real two-seat and solo GeoGuesser lobbies, panorama proxy, reveal, round advance and
cleanup over HTTPS.

Deployment of a source update:

```bash
scp server/{worker.js,node_server.js,node_storage.js,package.json} \
  root@178.236.246.13:/opt/deadlock-minigames/
ssh root@178.236.246.13 'systemctl restart deadlock-minigames'
```

The generated `worker.js` must always be rebuilt when a rule module, Pixel Battle map/admin asset
or `worker.core.js` changes.

## HTTPS directly on the IP

Let’s Encrypt issues publicly trusted IPv4 certificates using its `shortlived` profile. They are
valid for about six days and free of charge. Certbot checks twice daily and Nginx reloads only
after a successful renewal.

```bash
systemctl status deadlock-minigames-certbot.timer
systemctl start deadlock-minigames-certbot.service

# Safe end-to-end renewal simulation:
/opt/certbot/bin/certbot renew --dry-run --run-deploy-hooks \
  --no-random-sleep-on-renew
```

The ACME challenge remains available over port 80 at
`/.well-known/acme-challenge/`; every other HTTP path redirects to HTTPS.

## Database and backups

SQLite runs in WAL mode with `synchronous=NORMAL` and a five-second busy timeout. The process
keeps the original all-or-nothing Pixel Battle transactions and serializes all Hub requests, so
no second writer can interleave a lobby or tile update.

The daily backup timer uses SQLite's online `.backup` command, compresses the result and retains
14 days:

```bash
systemctl status deadlock-minigames-backup.timer
systemctl start deadlock-minigames-backup.service
ls -lh /var/backups/deadlock-minigames/
```

Do not copy only the live `.sqlite` file with plain `cp` while the service is running; use the
backup command or stop the service first so WAL state cannot be missed.

## Admin OAuth

**Пошаговый гайд по включению: [`ADMIN_SETUP.md`](ADMIN_SETUP.md)** — там же объяснено, чем это
заменило `npx wrangler secret put`, и команда для генерации 32+-символьного секрета.

Кратко: the browser admin stays fail-closed until `/etc/deadlock-minigames.env` supplies all four
of these. Secrets live in that file now, NOT in Cloudflare — `wrangler.jsonc` is rollback history
only and production never reads it.

```text
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ADMIN_GITHUB_ID=...            # numeric GitHub id, not the login (a login can be renamed/taken)
ADMIN_SESSION_SECRET=...       # >= 32 chars, else adminConfig() refuses and /admin stays 503
```

`EnvironmentFile` is read literally: no quotes around values, no spaces around `=`. Do not touch
`MG_MAPILLARY_TOKEN` in the same file — GeoGuesser's Mapillary panoramas depend on it.

The GitHub OAuth App callback is:

```text
https://178.236.246.13/admin/auth/callback
```

After changing the file:

```bash
chmod 0640 /etc/deadlock-minigames.env
chown root:minigames /etc/deadlock-minigames.env
systemctl restart deadlock-minigames
```

Verify the values reached the PROCESS, not just the file — the usual failure is a typo that leaves
`/admin` on 503:

```bash
PID=$(systemctl show -p MainPID --value deadlock-minigames)
for v in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET ADMIN_GITHUB_ID ADMIN_SESSION_SECRET; do
  tr '\0' '\n' < /proc/$PID/environ | grep -q "^$v=" && echo "$v: ok" || echo "$v: MISSING"
done
curl -s -o /dev/null -w '%{http_code}\n' -k https://127.0.0.1/admin   # 302 = configured, 503 = not
```

Never commit or paste these secrets into source files.

## Security and capacity notes

- UFW exposes only SSH, HTTP and HTTPS.
- SSH password authentication is disabled; root accepts the dedicated deployment key only.
- fail2ban protects SSH.
- The Node listener is loopback-only and overwrites `CF-Connecting-IP` with the real socket IP,
  so a direct caller cannot bypass per-IP rate limits with a forged header.
- Node resolves outbound hosts IPv4-first because this VPS has IPv4 egress but no routed IPv6;
  this keeps GeoGuesser's panorama fetches from selecting an unreachable AAAA record.
- A 1 GiB swap file with low swappiness protects the 2 GiB VPS from transient OOM conditions.
- Dimension-only PNGs use native synchronous zlib on Node. This reduced a typical clock response
  from roughly 81 KiB to about 449 bytes and raised the measured clock-route throughput from
  about 89 to 872 requests/second on the NLs-1 VPS.
- GeoGuesser draws from a PREBUILT worldwide pool (`server/geo_pool.generated.js`, compiled from
  `server/geo_pool.json` by `tools/build_geo_pool_module.js`), so **forming a lobby makes zero
  catalog requests** and starts instantly. The pool holds CC-BY-SA 4.0 equirectangular locations
  from two sources, balanced with an equal per-region quota and a 500 m minimum separation.
  Refresh it with `tools/build_geo_pool.js`, then rebuild the module and `worker.js`.
  Sweeping live was abandoned for measured reasons: Panoramax answers in sequence order, so one
  wide bbox drained a single dense route (all of Europe returned one sequence even at
  `limit=1000`), while Mapillary caps a bbox at 0.010 square degrees *everywhere*, putting a
  thorough worldwide sweep at roughly 2.5 M cells. Doing it offline is what lets the pool be both
  varied and instant.
- Mapillary is optional and needs `MG_MAPILLARY_TOKEN` in `/etc/deadlock-minigames.env`. The token
  never reaches a client: only the server calls Mapillary, because `thumb_2048_url` is signed and
  expires and therefore must be resolved per reveal (never cached, never stored in the pool).
  Without the token the game still runs on the pool's Panoramax rows. Resolved URLs are accepted
  only from `*.fbcdn.net`; Panoramax URLs are constructed from a validated UUID. Either way an
  upstream response cannot point the proxy at an arbitrary host. Proxied images are capped at
  8 MiB and the in-memory image LRU at 12 entries.
- Two facts about panorama sources that are easy to get wrong and were both measured:
  Mapillary reports `camera_type` as **`spherical` or `equirectangular`** (filtering on the latter
  alone reports zero coverage worldwide), and a catalog claiming 360° does **not** guarantee the
  delivered image is a 2:1 strip. Run `tools/build_geo_pool.js --verify-images` when refreshing:
  11 of 58 pooled Panoramax rows once delivered partial panoramas, up to 2048×267.
  `tools/mg_geo_source_check.js` samples the live pool and must be run **on the VPS** - some
  networks do not resolve `*.fbcdn.net`, which looks like a black round rather than a network fault.
- Reveal points and guesses use a 512×256 server-owned grid (~78km per cell). A guess arrives as
  one linear `cell` on the unlimited uplink, but a reveal point exceeds what two base-63 PNG levels
  can carry, so `/api/geotarget` and `/api/geopick` take an `axis` parameter and return one
  coordinate per request (height 63 stays reserved for errors). Scoring uses the picture's exact
  coordinates, not the cell. The place and the producer credit are each ONE reply: `/api/geoinfo`
  sends a place code (`0..5` region only, else `6 + country*6 + continent`) and `/api/geocredit` an
  index into the credit table the mod ships, so the reveal renders instantly and still names
  whichever project the location came from, preserving both attribution requirements.
- Pixel Battle starts with a clean database after the Cloudflare migration; old Worker canvas,
  audit, bank and ban records were deliberately not imported.
