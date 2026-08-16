# DL Arcade — Cloudflare edition

DL Arcade is a set of online mini-games inside Deadlock's pause menu. This copy is isolated from
the original `Minigames` folder and uses Cloudflare Workers plus one SQLite-backed Durable Object
as its authoritative backend.

Games: Checkers, Tic-Tac-Toe, Chess, Connect Four, Durak, Poker, Pixel Battle, Wordle and
GeoGuesser. Wordle and bot modes stay offline; online rooms, shared state, Pixel Battle and
GeoGuesser use the Worker.

The empty production Worker is deployed at
`https://dl-arcade-cloudflare.predi-i.workers.dev`. `BASE_URL` intentionally
remains blank until the final Pixel Battle snapshot is imported and verified.

## Start here

Follow **[`CLOUDFLARE_SETUP.md`](CLOUDFLARE_SETUP.md)**. It covers Cloudflare login, the first
deployment, secrets, GitHub OAuth, the Panorama endpoint, local testing, a custom domain and
rollback. It also contains the VPS Pixel Battle backup/import and zero-loss cutover procedure.

The short developer loop is:

```powershell
npm install
npm run lint
npm test
npm run deploy:worker:dry
npm run deploy:worker
```

After the first deploy, paste the printed `https://...workers.dev` URL (or a Custom Domain) into
`BASE_URL` at the top of `panorama/scripts/mg_net.js`, then build the VPK from the repository root:

```powershell
.\tools\build_mod_strip_comments.ps1 dl-arcade-cloudflare
```

## Runtime layout

```text
panorama/                    files packed into the Deadlock mod
server/worker.core.js        authored Worker routes and Durable Object
server/worker.js             generated deploy artifact; do not edit directly
server/wrangler.jsonc        Cloudflare project, binding and DO export
server/admin_panel.js        GitHub-authenticated Pixel Battle admin
tools/                       build and test harnesses; not packed into the VPK
```

The client still uses the image-dimension side channel described in `ARCHITECTURE.md`: requests
go out in image URLs and two response integers are encoded in PNG width and height. Hosting and
storage changed; the protocol and shared game rules did not.

## Important Free-plan limit

Workers Free and Durable Objects Free each allow 100,000 requests per day. The client uses the
older quota-aware polling cadence, but this is still a hard capacity ceiling, not an unlimited
production tier. Cloudflare returns an error after the quota is exhausted; it does not silently
charge a Free account. Monitor usage in Workers & Pages → `dl-arcade-cloudflare` → Metrics.

## Verification boundary

`npm run lint`, `npm test`, Wrangler dry-run and local Worker smoke tests verify source, protocol,
rules and deployment configuration. Panorama layout, drag/drop and image-loader behavior still
require a real VPK build and an in-game check.
