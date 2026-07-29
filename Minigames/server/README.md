# Deadlock Minigames — relay server (Cloudflare Workers)

This is the tiny backend that lets two Deadlock clients talk to each other.
It stores lobby state and answers every request with a **PNG image whose width ×
height encode the response** — because Panorama UI can only read data back through
an image's pixel size (no fetch, no websockets).

The whole thing runs on the **free** Cloudflare Workers plan (Durable Objects with
the SQLite backend are included for free).

---

## One-time deploy (≈3 minutes)

You need Node.js installed.

```bash
# 0. Build the deploy artifact (server/worker.js) from its sources. This concatenates
#    the SHARED rule engines (panorama/scripts/rules/*.js — the exact files the client
#    runs) in front of the authored core (server/worker.core.js), so the server validates
#    every move with byte-for-byte the same rules the client predicts with. Re-run this
#    whenever you edit worker.core.js OR any rules/*.js file.
node tools/build_worker.js

cd Minigames/server

# 1. Log in to Cloudflare (opens a browser). Free account is fine.
npx wrangler login

# 2. Deploy.
npx wrangler deploy
```

> **Sources vs artifact.** Edit `server/worker.core.js` (the relay + PNG encoder) and
> `panorama/scripts/rules/*.js` (the shared game rules). `server/worker.js` is a
> GENERATED file (it carries a "DO NOT EDIT" banner) — never hand-edit it; run the build.


After deploy, wrangler prints your URL, e.g.:

```
https://deadlock-minigames.<your-subdomain>.workers.dev
```

**Copy that URL.** Then open `Minigames/panorama/scripts/mg_net.js` and paste it into
the `BASE_URL` constant at the top:

```js
var BASE_URL = "https://deadlock-minigames.YOURNAME.workers.dev";
```

That's it. Redeploys later are just `npx wrangler deploy` again.

---

## Private Pixel Battle admin panel

The Worker serves a browser UI at `<URL>/admin`, but it deliberately fails closed until
GitHub OAuth and four deployment secrets are configured. There is no password, GitHub
token, allowed login, or secret URL in this repository.

1. Open **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**. Set:

   - Homepage URL: your Worker URL, for example
     `https://deadlock-minigames.<your-subdomain>.workers.dev`
   - Authorization callback URL: `<URL>/admin/auth/callback`

   The callback must match exactly. The app needs no extra OAuth scopes.

2. Find your stable numeric GitHub user ID. One simple way is to open
   `https://api.github.com/users/<your-login>` and copy the numeric `id` field. The Worker
   authorizes this ID, not a mutable login or email.

3. Store the OAuth App client ID, client secret, numeric ID, and a new random session-signing
   secret of at least 32 characters as Worker secrets:

   ```bash
   cd Minigames/server
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put ADMIN_GITHUB_ID
   npx wrangler secret put ADMIN_SESSION_SECRET
   npx wrangler deploy
   ```

4. Open `<URL>/admin`. The Worker redirects to GitHub, uses OAuth `state` plus PKCE, fetches
   the authenticated GitHub account, compares its exact numeric ID, discards the short-lived
   OAuth token, and issues its own eight-hour HttpOnly/Secure HMAC-signed session cookie.

The panel can paint unrestricted batches, inspect accepted actions by Steam32, and undo
them. A normal undo skips pixels overwritten by newer actions; **Force** is available when
overwriting those newer pixels is intentional. Admin mutations are also same-origin/CSRF
checked, and every admin paint/undo is itself audited. **Ban** blocks a Steam32 account at
the Worker and changes the in-game Pixel Battle button to a red `YOU ARE BANNED` state.
An already-open client sees the ban on its next version poll and stops all Pixel Battle
requests. Unbanning takes effect after that player reloads the mod.

Every paint row has an on-demand **Preview**: the editor zooms to its bounds and renders the
exact safe-undo result, marking newer conflicting pixels red before anything is changed.
**Inspect pixel** turns the canvas into an attribution tool; clicking a coordinate shows the
last action, Steam32/admin identity, timestamp, colour, and direct Preview/User actions/Ban
controls. New uploads update a compact attribution index per touched 32×32 tile. Old audited
pixels are resolved from the action log on their first inspection and cached.

This metadata does not add Panorama requests or change Pixel Battle polling. It adds at most
one internal Durable Object attribution read and write per 32×32 tile already touched by an
accepted upload. Preview and Inspect each make one admin request only when the owner clicks
them; action-list responses stay small because full pixel details are loaded on demand.

Steam32 is discovered and sent by the Panorama client; it is not a cryptographically
authenticated Steam identity. A modified client can therefore spoof another Steam32, and
any request still reaches Cloudflare before the Worker can reject it. Strong protection
against that requires an external edge gate or a verifiable Steam authentication ticket,
neither of which Panorama currently provides. The implementation still rejects every banned
write server-side and makes the normal client stop after its single access preflight.

---

## Verify it works (in a normal browser)

- `<URL>/api/probe` → a **600×1000** PNG. This one is LITERAL pixels: it is the calibration
  reference the client measures the UI scale against. Its all-zero payload is pre-compressed
  to well under 2 KiB; the large dimensions do not imply a large download.
- `<URL>/api/ping` → the encoding of `(1, 1)`, i.e. **24×24** (see below). If you get that, the
  Worker is up.

Every OTHER route answers a *level-encoded* PNG, so the dimensions are not the values:

```
dim = level * 9 + 15        (STEP = 9, BASE = 15)
```

So level 0 → 15px, level 1 → 24px, level 63 → 582px; the client decodes back with
`round((dim - 15) / 9)`. Reading a create/status response by eye means undoing that first — a
lobby code arrives as two 6-bit halves in a banded width plus a height, not as
`width*100 + height`.

---

## Protocol reference

**The authoritative reference is the header comment of `worker.core.js`** — the route table,
every `(w, h)` reply, every `(9, x)` rejection code, and the durak/poker public event logs.
§5 of `../ARCHITECTURE.md` mirrors it.

This file used to inline a route table of its own. It described the ORIGINAL `dim = int + 1`
encoding with a `+100` host flag and 4-digit codes in the 1000..9999 range — all three were
replaced on 2026-07-20 by the level encoding above, 10-bit codes in 0..1023, and dedicated
width bands for the host/joiner roles. Rather than keep a third copy that drifts again, it is
gone: read the source, which is also what `tools/mg_server_test.js` asserts against.

Two things worth knowing before poking at routes by hand:

- Always append a random query parameter to defeat the engine's image cache.
- Every state-changing route carries a per-seat token that only ever travels upward, in the
  query string. The server binds each seat to its token, so a guessed lobby code alone cannot
  act on a match. See §5.1 of `../ARCHITECTURE.md`.

---

## Data & limits

- Lobbies live in one Durable Object, keyed `l:<code>` over the 0..1023 code space. An
  opportunistic sweep (at most once a minute, and only off the lobby-creation paths) drops
  anything idle for over 30 minutes and clears its public matchmaking-queue slots.
- A lobby's move/event log is capped (`MOVE_CAP`) well below the Durable Object's 128 KiB
  per-value limit. No honest game comes close; the cap exists so deliberate bloating can't push
  a lobby past that limit, which would wedge it permanently.
- Free plan: 100k requests/day, shared between Worker and Durable Object requests. The in-game
  poll cadence is adaptive (fast for the first few empty polls, then slower) and the side clocks
  are interpolated locally rather than polled — that is what keeps a match in the low hundreds
  of requests rather than thousands.
