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
cd Minigames/server

# 1. Log in to Cloudflare (opens a browser). Free account is fine.
npx wrangler login

# 2. Deploy.
npx wrangler deploy
```

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

## Verify it works (in a normal browser)

- `<URL>/api/probe` → a **600×1000** pixel PNG (the client uses it to calibrate swap+scale).
- `<URL>/api/create?game=1` → a small PNG like **45×92** — that encodes lobby code
  `4591` (`width*100 + (height-1)` = `45*100 + 91`).
- `<URL>/api/status?code=4591` → **1×1** (1 player so far).

If you can see those images with the right dimensions, the server is good.

---

## Protocol reference

All routes are GET, all return a PNG. Always append `&rnd=<random>` to defeat the
engine's image cache. Responses are read as `(width, height)`:

| Route | Response `(w, h)` |
|---|---|
| `/api/probe` | `(4, 8)` — used once on startup to detect swap + UI scale factor |
| `/api/create?game=G` | `(CODE_HI, CODE_LO+1)` — new lobby; caller is host / player 0 |
| `/api/join?code=C` | `(G, 1)` joined · `(20, 1)` not found · `(21, 1)` full |
| `/api/status?code=C` | `(players, 1)` · `(9, 1)` gone — host polls until players == 2 |
| `/api/move?code=C&from=F&to=T&end=E` | `(1, 1)` ok · `(9, 9)` fail |
| `/api/poll?code=C&since=S` | `(from+1 [+100 if end], to+1)` · `(1, 1)` nothing new |
| `/api/reset?code=C&game=G` | `(1, 1)` — restart the same lobby |

- Image dimensions are always ≥ 1, so 0 can never be read back — every sentinel above
  is non-zero.
- `CODE = CODE_HI*100 + CODE_LO` (4-digit). Client decodes `width*100 + (height-1)`.
- Squares are `0..63` (full 8×8 grid). `from != to` always, so a real move never
  decodes to `(1,1)` — that is why `(1,1)` is the safe "nothing new" marker.
- The client polls with `since = last applied seq`; the returned move is implicitly
  `seq = since+1`, so seq is not echoed.
- `END = 1` means "turn passes to the other player" (multi-jumps send `END=0` per hop).
- Every dimension stays ≤ ~128 px, so each returned image is only a few hundred bytes.

Game rules live entirely on the **client**. The server never validates a move — it
just relays them in order. Fine for a friendly game; do not treat it as cheat-proof.

---

## Data & limits

- Lobbies live in one Durable Object. They are not garbage-collected yet; codes are
  reused only when free. For a small friend group this is irrelevant. (A TTL sweep
  can be added later if needed.)
- Free plan: 100k requests/day. Polling every ~1.5s uses ~2.4k requests/hour per
  active pair — comfortably within free limits.
