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
authenticated image proxy, guess/reveal/score flow and all five ready-gated rounds.

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
exercises a real two-seat GeoGuesser lobby, panorama proxy, reveal and cleanup over HTTPS.

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

The browser admin remains fail-closed until `/etc/deadlock-minigames.env` supplies:

```text
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ADMIN_GITHUB_ID=...
ADMIN_SESSION_SECRET=at-least-32-random-characters
```

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

Never commit or paste these secrets into source files.

## Security and capacity notes

- UFW exposes only SSH, HTTP and HTTPS.
- SSH password authentication is disabled; root accepts the dedicated deployment key only.
- fail2ban protects SSH.
- The Node listener is loopback-only and overwrites `CF-Connecting-IP` with the real socket IP,
  so a direct caller cannot bypass per-IP rate limits with a forged header.
- Node resolves outbound hosts IPv4-first because this VPS has IPv4 egress but no routed IPv6;
  this keeps GeoGuesser's fixed Wikimedia image fetches from selecting an unreachable AAAA record.
- A 1 GiB swap file with low swappiness protects the 2 GiB VPS from transient OOM conditions.
- Dimension-only PNGs use native synchronous zlib on Node. This reduced a typical clock response
  from roughly 81 KiB to about 449 bytes and raised the measured clock-route throughput from
  about 89 to 872 requests/second on the NLs-1 VPS.
- GeoGuesser proxies only seven fixed Wikimedia Commons URLs, validates image type and size, and
  keeps one bounded in-memory copy per location. No request parameter can become an upstream URL.
- Pixel Battle starts with a clean database after the Cloudflare migration; old Worker canvas,
  audit, bank and ban records were deliberately not imported.
