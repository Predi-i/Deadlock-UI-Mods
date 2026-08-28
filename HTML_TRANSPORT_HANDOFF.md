# HTML transport migration — handoff

**Status:** research complete, implementation not started.
**Date:** 2026-08-23. **Branch:** `feat/html-transport-probe`. **Probe commit:** `63cfa0c`.

Everything below marked PROVEN was measured **in-game across five VPK repacks**. Nothing in
this mod can be verified from a shell, so anything not marked PROVEN is explicitly flagged.
The probe that established it is committed at `HTML-Probe/panorama/scripts/html_probe.js`;
its header carries the same facts next to the code that produced them.

---

## 1. Why this migration exists

DL Arcade's downlink is the `<Image>` intrinsic-size side channel: **~12 bits per request**
(two 6-bit levels read off `actuallayoutwidth`/`actuallayoutheight`). A far larger channel
was available the whole time and nobody knew, because it is not a networking API — it is the
news-popup widget, and the bridge is an *event*, not a method.

**New downlink: 4096 chars per push.** That is ~2700x more per delivery.

### Why it was missed (both traps are load-bearing, do not re-learn them)

- **Grepping `client_strings.txt` gives false negatives for Panorama APIs.** The `$` bindings
  and script-side event names live in `panorama.dll`, which GameTracking does not dump. Worse,
  the script event is `HTMLTitle` while the C++ struct is `HTML_ChangedTitle_t`, so searching
  for `HTMLChangedTitle` / `RunJavascript` / `postMessage` returns clean-looking nothing.
  → For "does Panorama have X?", the answer comes from a **runtime probe in-game**, never from
  a binary string search. State grep results as "not in client_strings.txt", never "absent".
- **There are TWO JS engines.** Panorama JS is Valve's own tiny V8 embedding. The page inside
  `CitadelHTMLPanel` is full Chromium. `typeof fetch` in a Panorama script is a correct answer
  *about the wrong engine*. No amount of testing `fetch`/`WebSocket`/`AsyncWebRequest` in
  Panorama leads to `document.title` on a news widget.

---

## 2. PROVEN facts

### 2.1 Panorama has no networking (so the old design was not a mistake)

Complete global list: `Promise`, `JSON`, `globalThis`, `$`, `panorama`.
Absent: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `window`,
`document`, `location`, `localStorage`, `setTimeout`, `setInterval`, `atob`/`btoa`,
`TextDecoder`, `GameUI`, `GameEvents`, `Game`, `Players`, `Entities`, `CitadelUI`,
`SteamUtils`, `SteamHTML`, `LoadKeyValues`, `FileSystem`, `Application`.

`$.AsyncWebRequest` exists as a binding but calling it logs verbatim:
`ERROR: AsyncWebRequest has been removed.` Valve pulled it.

`$` has exactly: `RegisterEventHandler`, `RegisterForUnhandledEvent`,
`UnregisterForUnhandledEvent`, `DispatchEvent`, `DispatchEventAsync`, `CreatePanel`,
`CreatePanelWithProperties`, `GetContextPanel`, `Schedule`, `CancelScheduled`, `Msg`,
`Warning`, `Localize`, `LocalizePlural`, `HTMLEscape`, `Language`, `Each`,
`FindChildInContext`.

`$.persistentStorage` is **absent** (independently confirmed in QOLLOCK,
`ql_core.js:2336`, 2026-06-11).

### 2.2 The panel

`$.CreatePanel("CitadelHTMLPanel", …)` works **in the HUD context** (ctx = `CitadelHudRoot`).

Valid paneltypes: `Panel Label Image TextEntry Button MoviePanel CitadelHTMLPanel HTML`.
`CreatePanel` throws for: `HTMLPanel WebPanel CefPanel CitadelWebPanel SteamHTMLPanel`.

### 2.3 The page is a full browser

Measured from inside a `data:` URL page:

```
typeof fetch=function  WebSocket=function  XMLHttpRequest=function  EventSource=function
fetch(<this mod's worker>/api/ping.png)  -> 60/60 ok, 0 errors, 72 bytes each
new WebSocket('wss://ws.postman-echo.com/raw') -> open at 733ms, held 62s, 12 ping / 12 echo
VERDICT=fetchOk=60=fetchErr=0=wsSent=12=wsRecv=12=wsDead=false
location.href -> readable, so a SetURL query string is the uplink INTO the page
```

`data:` URLs load **and run their scripts** (verified to 1938 chars of URL). The Chrome-60
top-level `data:` navigation block does not apply to an embedder calling `SetURL`.

### 2.4 The downlink

Register with `$.RegisterEventHandler(name, panel, cb)`. 24 of 41 probed `HTML*` names are
known to the engine. **`SetPanelEvent` delivers NOTHING.** `RegisterForUnhandledEvent` works
but only duplicates every `RegisterEventHandler` delivery, so use one path or the log doubles.

| Event | Args |
|---|---|
| `HTMLTitle` | `arg1` = `document.title` — **the payload** |
| `HTMLFinishRequest` | `arg1` = url, `arg2` = title |
| `HTMLJSAlert` / `HTMLJSAlertV8` | `arg1` = alert text, both fire |
| `HTMLURLChanged` | `arg1` = full url, `#fragment` included |
| `HTMLStatusText` | **never fires.** `window.status` is dead. |

- **Capacity: exactly 4096 chars, truncated silently.** 64/256/1024/4096 arrive whole;
  16384 and 65536 both arrive cut to exactly 4096.
- **Cadence: 12 of 12 rewrites at 250ms, zero loss, ~1% drift**
  (257/506/753/1002/1264/1512/1760/2008/2255/2503/2753/3002). 4 updates/sec is comfortable.
- Payloads arrive **only in event arguments**. Never on the panel: no property, no getter,
  no attribute. Do not scrape it.
- `HTMLTitle` fires **2x per navigation** → dedup on **content**, not length. (Keying on
  (channel, length) collapsed five distinct 24-char stream ticks into one row and read as
  "the stream never fired".)
- Events that merely **echo the URL you set** — `HTMLStartRequest`, `HTMLURLChanged`,
  `HTMLLoadPage`, `HTMLFinishRequest.arg1` — are not downlink. Filter them or they look like
  received data. `HTMLBackForwardState` fires ~2x per navigation with two booleans.
  `HTMLNeedsPaint` fires every CEF repaint: never do real work in its handler.

### 2.5 The uplink, with no reload

`javascript:` URLs execute in the **CURRENT document**, not a fresh one. A page planted
`window.MGPLANT` and `window.mgEcho`; a subsequent `javascript:` URL read both back
(`CTX|readback|planted_ok|fn|function`), and that `SetURL` fired **no** `HTMLURLChanged` and
**no** `HTMLStartRequest` — only `HTMLTitle`. So an open WebSocket survives an uplink action.

```
Panorama -> page   : SetURL("javascript:mgSend('…')")   no reload, socket intact
page -> server     : fetch / WebSocket / XHR / EventSource
page -> Panorama   : document.title, 4096 chars, push
```

### 2.6 Cost

Frame time with CEF live: **1.2%–2.2% of frames over 17.5ms** across runs (it improved as the
run went on: 7.2% → 2.2% → 1.2%). ⚠ The baseline **without** CEF was never measured, so read
this as "no visible cost", not "free". Measuring the baseline is a 2-minute job and worth
doing before shipping.

---

## 3. Decisions already made

- **Approach (в2): everything through the page.** One `CitadelHTMLPanel`: uplink via
  `SetURL("javascript:…")`, downlink via `document.title`. This deletes the image FIFO and the
  host panel too, not just the codec. Chosen over the hybrid because every piece is now
  individually proven in-game.
- **Full state, not deltas.** Idempotent: a lost update self-heals on the next push, no
  sequence numbers, no gap-fill logic.
- **4096 is not a constraint.** Measured from the shipped engines:

  | State | Size |
  |---|---|
  | durak 4 players, full server state | **310 chars JSON** |
  | durak 4 players, one client's view | **121 chars** |
  | chess / checkers board (64 squares) | **64 chars** |
  | limit | **4096** |

  13x headroom on the worst multi-hand game, as raw JSON with no compact encoding. Do **not**
  build chunking. (If it ever is needed, chunking rests on an **unverified** property: whether
  back-to-back title writes coalesce. Cadence was measured at 250ms gaps, not 0ms.)
  Two payloads genuinely exceed 4096 and neither should use this channel: the Pixel Battle
  canvas (it is an image, keep it an image) and the GeoGuesser pool (already a generated file).

---

## 4. What the migration deletes

The controllers do **not** see the codec. They call the facade — `Api.poll`, `Api.move`,
`Api.dlog`, `Api.pdraw` and friends, **118 call sites over ~30 methods**; `mg_checkers.js:52`
and `mg_chess.js:53` just do `const Api = MG.Api`. So `MG.Api`'s shape is the contract to
preserve, and most of the work is deletion:

| Goes away | Evidence of its size |
|---|---|
| Level codec `STEP=9/BASE=15`, calibration (swap/scaleX/scaleY), `suspectDecode`, `isLevelEncodedSize`, sentinel-collision classification | 136 matches in `mg_net.js` |
| The image FIFO, `loadImage`, `MG_NetHost` panel and its hittest/hover traps | `mg_net.js` §request serialization |
| PNG encoder in the worker | 25 matches in `worker.core.js` |
| One-request-per-card loops | `ddraw` 24, `pdraw` 18 mentions |
| One-request-per-axis loops | `geopick` 8, `geotarget` 7 mentions |
| Index-into-shipped-table tables | `mg_geo_credits.generated.js`, `mg_geoguesser_cities.generated.js` |

Consolidation: `poll` + `dlog` + `ddraw` + `clocks` + `status` collapse into one
`/api/state` returning full state as JSON.

**Unchanged:** server authority, seat tokens (up only, never down), the client-side rules
predictor, the worker-as-dealer model for hidden hands. The architecture is not changing —
only the wire format.

---

## 5. Suggested plan

1. **Measure the CEF-free frame baseline** (2 min, closes the one open cost question).
2. **New module beside `mg_net.js`** (e.g. `mg_html_net.js`) implementing the same `MG.Api`
   surface. Do not modify `mg_net.js` yet — rollback stays one line.
3. **Port ONE route: `poll`.** Hottest path, so the request-count win and the channel's real
   behaviour both show up immediately in a live game.
4. Then `dlog`/`ddraw` (durak), then `pdraw`/`plog` (poker), then GeoGuesser's reveal reads
   (biggest win: 7-10 requests per reveal become one).
5. Delete the codec and the FIFO only once every route is off them.

### Hard-won process rules

- **A protocol change is TWO deploys and the tests cannot see the second.** `npm test` proves
  the client and `server/worker.js` agree *with each other*; nothing proves Cloudflare runs
  that `worker.js`. Verify against the running server. (`ARCHITECTURE.md` trap 25 — it caused
  GeoGuesser to name countries that were never right.)
- **Guard every page-side probe individually and emit a liveness beacon.** A `data:` document
  has an opaque origin where `typeof localStorage` **throws** (`SecurityError`, it is a
  throwing getter). One unguarded read of it in the first top-level statement aborted an
  entire page script: zero reports, including pure-`typeof` lines needing no network. The log
  read as "fetch is absent" when nothing had run.
- **The console buffer is ~3 MB and the game spams it.** Keep output lean or the summary at
  the end is pushed out. `con_filter_enable 1 ; con_filter_text HTMLPROBE`.
- Never hand-minify `.css`; never start a shipped-JS line with a binary operator.
- `node tools/build_worker.js --check` currently reports **STALE for a false reason**: the
  committed `worker.js` differs from a fresh build only in line endings (6759 vs 6715 CRLF)
  and is byte-identical after normalisation. Worth fixing separately, since a check that
  cries wolf trains people to ignore trap 25.

---

## 6. Open questions

- **Player identity is closed, not merely hard.** There is no Steam API in Panorama at all, so
  a client cannot even *read* its own SteamID, let alone prove it — and a client-supplied
  SteamID is a claim, not proof. `$.persistentStorage` is absent; `localStorage` in the page
  throws. The seat token stays the right primitive for "same player within a lobby"; there is
  nothing to bind it to a real identity. Do not design leaderboards or bans assuming otherwise.
- **Unexplained, not blocking:** `fetch('https://api.github.com/zen')` failed twice with
  `TypeError: Failed to fetch` while the worker and postman-echo both worked. Not CORS —
  GitHub returns `ACAO:*` even for `Origin: null` (checked with curl). Likely old-CEF TLS.
  Retry with `mode:'no-cors'` to separate "CORS rejected" from "unreachable" if it matters.
- **Untested:** does the socket survive alt-tab, a resolution change, or a full match? Does a
  `HTMLTitle` write from a page with a live socket ever coalesce under load?
- CEF panel visibility: the probe kept it opaque at 480x360 on purpose, because a
  zero-opacity/hidden panel is skipped by the engine's loader (documented for the `<Image>`
  transport). Whether a *hidden* CEF panel still loads and pushes is **unknown** and matters
  for shipping, since the real one must be invisible.

---

## 7. Reference

- Probe mod: `HTML-Probe/panorama/scripts/html_probe.js` — header holds every finding.
  Re-collect the API inventory by setting `RUN_INVENTORY = true`.
- Current transport: `DL-Arcade-Cloudflare/panorama/scripts/mg_net.js`,
  `ARCHITECTURE.md` §2 and §5.
- Worker: `server/worker.core.js` (authored), `server/worker.js` (generated — never edit).
  CORS already present at `worker.core.js:2216` (lowercase header name, so a case-sensitive
  grep misses it).
- Worker URL: `https://dl-arcade-cloudflare.predi-i.workers.dev`
