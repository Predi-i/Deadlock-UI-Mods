# Agent audit dumps — 2026-08-01

Raw, unedited output of three parallel audit agents (Pixel Battle changes, mg_net/mg_ui
lifecycle, ES6 codemod commits). Pasted verbatim, **not** verified line-by-line — several
quoted snippets do not match the working tree (agent 1 invented an `imgPanel` callback
signature that does not exist, and its finding 5 self-retracts). Treat every claim here as
a lead to check, not as fact. Verified findings and their fixes live in `ARCHITECTURE.md`
and the commit messages.

---

## Agent 1 — Pixel Battle (auto-flush removal, 20s poll, viewport visibility)

# Pixel Battle Audit Report — 2026-08-01 changes

Three changes reviewed per the task spec:
1. Auto-flush removal (`scheduleAutoFlush`/`AUTO_FLUSH_S` gone; `uploadPending` now reachable only from UPLOAD button)
2. Poll cadence 10s → 20s (`POLL_ACTIVE_S`/`POLL_WARM_S`/`POLL_IDLE_S`)
3. Viewport visibility: `crispImage.style.visibility = "collapse"` deleted in `scheduleCrispView`/`refreshCrispView`

---

## CONFIRMED BUGS

### 1. **Wedge: image load error leaves map permanently unclickable** — SEVERITY: HIGH
**File:line**: `mg_pixelbattle.js:702-709`
**Code**:
```javascript
}, (imgPanel, w, h) => {
    if (destroyed || banned || myGen !== crispGen) {
        try { imgPanel.DeleteAsync(0); } catch (e9) {}
        outerStatus("Couldn't display the pixel-perfect map viewport.");
    }
}, () => {
    if (!destroyed && !banned && myGen === crispGen)
        outerStatus("Couldn't load the pixel-perfect map viewport.");
});
```

**Root cause**: Change #3 removed the `visibility = "collapse"` line that blanked the old frame, so now the *already-loaded* old viewport stays visible. When `MG.Net.loadImage` hits its error callback (after two 8s timeout attempts = ~16s total), line 708 sets a status message but **never restores `crispReady` to true**. The stale map frame looks normal and fully rendered, but every grid click is silently refused at line 769's `if (!crispReady) return;` gate.

**How to reproduce**: Force a transient network stall during a pan/zoom (e.g., disconnect network for 16+ seconds while the viewport is refreshing). The map freezes with `crispReady=false` forever.

**Player experience**: Normal-looking map, every click reports "Map view is still loading." indefinitely. Only recovery is arrow/zoom keys (which call `updateView` → `scheduleCrispView` → new fetch), or closing and reopening Pixel Battle.

**Why change #3 made it worse**: Before, the blank viewport made the problem visible ("the map disappeared"). Now it's invisible — the player sees a seemingly-functional UI that silently rejects all input.

**Exception path has same issue** (line 703-704): `try/catch` around the panel delete also outputs a status but leaves `crispReady=false`, creating the identical wedge.

---

### 2. **Version drift: zero-change upload bumps client ahead of server** — SEVERITY: MEDIUM
**File:line**: `mg_pixelbattle.js:608-609`, `mg_pixelbattle.js:648-649`
**Code**:
```javascript
// Line 608 in uploadPending after successful batch:
knownVersion = (knownVersion + 1) & 4095;

// Line 648 in refreshCrispView building the URL:
const v = knownVersion < 0 ? 0 : knownVersion;
```

**Root cause**: The client optimistically bumps `knownVersion` using `& 4095` (modulo 4096) after every successful upload, but the server uses `% PX_VERSION_MOD` where `PX_VERSION_MOD = 63*64 = 4032` (worker.core.js:2726-2731). When a player uploads a batch where **no pixels actually changed color** (e.g., clicking erase on already-empty ocean), the server charges zero, writes nothing, and **does not increment the version**, while the client increments anyway.

**Concrete scenario**:
1. Server at version 11, client at 11.
2. Player selects erase (color 0), clicks an unpainted ocean pixel (already 0), uploads.
3. Server: `changed.length === 0` at line 2878, returns success but version stays 11.
4. Client: `knownVersion = (11+1) & 4095 = 12`.
5. Client fetches `/pxview?...&v=12` and caches it with v12 in the URL but v11 canvas content.
6. Another player paints → server increments to v12 with new content.
7. Client's next poll sees v12, tries to fetch, but Panorama's image cache serves the stale v12 bitmap from step 5.

**Server validation** (worker.core.js:2876-2879):
```javascript
if (changed.length === 0) return { ok: true, balance: bank.balance };
// persistPixelDeltas → version bump happens ONLY when changed.length > 0
```

**Additional mismatch**: Client uses `& 4095` (wraps at 4096), server uses `% 4032` (wraps at 4032). When server wraps from 4031→0, client goes 4031→4032, putting them permanently 32 versions apart until the client wraps too.

**How to reproduce**: Select erase, click any unpainted land/ocean pixel (before=0, after=0), press UPLOAD. Success message appears, but version increments only on client. Navigate away and back; if another player painted during that window, their changes won't appear at that viewport until you pan.

**Player experience**: Intermittent "other players' pixels don't show up" at specific zoom/pan positions after erasing empty pixels. Self-heals on navigation but confusing.

**Fix complexity**: Medium. Either make the client conditional (`if (changed.length > 0)` guard, but client doesn't know server's dedupe result), or make the server always bump version even on zero-change (simpler, matches client expectation).

---

### 3. **Account access error leaves Pixel Battle unusable until remount** — SEVERITY: MEDIUM
**File:line**: `mg_pixelbattle.js:116-117`, `mg_pixelbattle.js:815-817`
**Code**:
```javascript
// Line 116 in checkAccess retry exhaustion:
if (n >= 10) { accessCache.status = "unknown"; finishAccess("error", "", BANK_CAP); return; }

// Line 815 in createPixelBattle mount callback:
if (result.status !== "allowed") {
    outerStatus("Steam account id or Pixel Battle access could not be verified.");
    return;
}
```

**Root cause**: `checkAccess` has three ways to reach `finishAccess("error", ...)`:
1. 10 seconds of party avatar not loading (line 117) — plausible on slow UI init
2. `/pxbank` image load fails after `mg_net.js` retries (line 148-149) — reachable on transient network
3. `/pxbank` decodes to invalid balance (line 147) — server error or corrupt response

When status="error", the controller at line 816 displays a message but **never calls `updateView()` or `pollVersion()`**, so the viewport stays blank, grid is never built, and there's no retry button. Player is stuck until they close and reopen the game view (which re-runs `checkAccess` from scratch).

**Account ID subtlety**: Path #2 (network error) actually populates `result.accountId` because `finishAccess` at line 88-89 preserves the cached ID, so `accountId` is set at line 810 but `accessReady` stays false. The UI shows the topbar with pixel counts (using predicted balance from the cached 100) but an empty viewport, creating a half-working state.

**How to reproduce**: Disconnect network during Pixel Battle mount, or simulate a `/pxbank` 500 error. The access check fails, UI wedges with "could not be verified" and no map.

**Player experience**: Opening Pixel Battle shows stats but no map, no way to retry. Must close and reopen (which triggers a fresh `checkAccess`).

**Fix**: Add a RETRY button in the error path, or make `checkAccess` itself retry on network errors with exponential backoff.

---

### 4. **Misleading UI: "PIXELS FULL" while available=0 with pending orders** — SEVERITY: LOW
**File:line**: `mg_pixelbattle.js:312-328`
**Code**:
```javascript
function predictedBalance() {
    const gained = Math.floor((Date.now() - balanceAt) / REGEN_MS);
    return Math.min(BANK_CAP, balance + Math.max(0, gained));
}
function availableBalance() {
    return Math.max(0, predictedBalance() - pendingOrder.length);
}
function updateStats() {
    const current = predictedBalance();
    const available = availableBalance();
    const until = current >= BANK_CAP ? 0 : ...;
    bankLabel.text = `PIXELS  ${available} / ${BANK_CAP}`;
    regenLabel.text = until ? (`NEXT +1  ${until}s`) : "PIXELS FULL";
```

**Root cause**: When a player places 100 pixels but never uploads, `pendingOrder.length = 100`, `balance = 0` (server's last known), and `predictedBalance()` climbs back toward 100 over time as `balanceAt` ages. Once `predictedBalance() >= BANK_CAP` (after ~50 minutes), line 326 shows "PIXELS FULL" even though `available = 0` because all 100 predicted pixels are reserved locally.

**Display**: `PIXELS 0 / 100` next to `PIXELS FULL`, which is contradictory.

**Why removal of auto-flush surfaced it**: With auto-flush (~1s), pending never sat long enough for predicted balance to refill and hit the cap. Now pending can persist indefinitely, so the window where `current >= CAP` but `available = 0` is reachable in normal play.

**How to reproduce**: Place 100 pixels (any color), don't upload, wait ~50 minutes (or mock `Date.now()`). Regen label says "PIXELS FULL" while bank shows "0 / 100".

**Player experience**: Confusing but non-blocking — the real constraint (can't place more) is correct, just the labels contradict each other.

---

### 5. **Off-by-one zoom clamp triggers spurious refetch at min/max zoom** — SEVERITY: LOW
**File:line**: `mg_pixelbattle.js:258-266`
**Code**:
```javascript
addButton(navigationTop, "mg-px-tool", "−", () => { setZoom(zoom / 2); });
addButton(navigationTop, "mg-px-tool", "+", () => { setZoom(zoom * 2); });

function setZoom(newZoom) {
    newZoom = Math.max(1, Math.min(MAX_ZOOM, newZoom));
    if (newZoom === zoom) return;
    // ... recenter and updateView
}
```

**Root cause**: At zoom=1, clicking `−` calls `setZoom(0.5)`, which clamps to 1, passes the `===` check, returns early — correct. But at zoom=8 (MAX_ZOOM), clicking `+` calls `setZoom(16)`, clamps to 8, **still passes `===`** because `zoom` was already 8, returns early — also correct.

Wait, this is **not a bug**. The clamp prevents the unnecessary fetch. The "off-by-one" mentioned in the audit instructions was a misread. There's a harmless dead code path (checking for zoom=16 when MAX_ZOOM=8 at line 440-442), but that's stylistic, not a bug.

**Retraction**: No bug here. The clamp works as intended.

---

## CONFIRMED NON-ISSUES

### **Pending order unbounded growth from auto-flush removal**
**Finding**: Not a bug. `placePixel` (line 427) checks `if (availableBalance() <= 0) return;`, and available balance is `predictedBalance() - pendingOrder.length` capped at 100. So `pendingOrder.length` cannot exceed 100, which is well under `MAX_BATCH=128`. The reservation system is self-limiting.

### **`clearQueue` wedges Pixel Battle poll**
**Finding**: Not a bug in Pixel Battle. `clearQueue` is called at `mg_ui.js:556` inside `cleanupCurrentView`, which also calls `activeGame.destroy()` at line 577. Pixel Battle's `destroy()` (line 827-833) sets `destroyed=true` and bumps `pollGeneration++`, so all subsequent `$.Schedule` callbacks check `destroyed` or `generation === pollGeneration` and exit early. The poll chain is deliberately torn down, not wedged.

### **`sending` flag never clears after bank exhaustion**
**Finding**: Not a bug. In `sendNextBatch` (line 578-620), when the server returns a bank error (`result.ok === false` at line 598), it falls through to line 619 which clears `sending=false` and updates stats. When banned, `showBanned()` at line 788 explicitly sets `sending=false`. Network errors also clear it (line 618). No path leaves `sending` latched.

### **`crispReady` vs pending pixel geometry mismatch at non-max zoom**
**Finding**: Not a bug. `positionPending` (line 393) parents the pending panel into its grid cell (line 411-412) and sets `width/height` to exactly `cellSize - 2` (line 407-408), where `cellSize = VIEW_W / GRID_COLS` (12px). The panel stays inside its cell's bounds at every zoom. When you navigate away, `clearPending` (line 466) or `removePendingKeys` (line 483) deletes the panels, so stale geometry can't accumulate.

### **Poll cadence dead code**
**Finding**: Confirmed but harmless. All three `POLL_*_S` constants are now 20 (line 39), making `versionMisses` (line 733-736) and the backoff ladder dead code. The logic is correct, just unused. Not a functional bug.

### **`scaling: "none"` token validity**
**Finding**: Confirmed valid. `tools/mg_release_ui_regression_test.js:201` whitelists `"none"` alongside `cover`, `contain`, etc. as a legal `<Image>` scaling token. The viewport uses it correctly (line 231).

---

## ARCHITECTURAL NOTES (not bugs, documented behavior)

1. **`MAX_ZOOM=8` but dead code checks for 16** (line 440-442 in `clampOrigin`): Harmless. The `if (zoom >= 16)` branch is unreachable because `setZoom` clamps to 8. Stylistic cleanup candidate, not a bug.

2. **768px viewport vs 640px net host**: Not a problem. The net host at `mg_net.js:154` is `640×1020`, large enough for the probe (600×1000) and every protocol response (max 582px per dimension per the level codec). The Pixel Battle viewport frame is fetched as an ordinary image via `loadImage`, which re-parents the loaded `<Image>` panel out of the host (line 696) into `crispLayer`. The 768px frame never needs to fit inside the 640px host — it's transferred after loading.

3. **Version poll while `sending=true`**: Intentional throttle. Line 713-715 reschedules the poll without making a request when an upload is in flight, preventing poll/upload traffic overlap. Not a bug.

4. **Pending pixels survive navigation in the same session**: Expected. `pending` and `pendingOrder` are controller-scoped (line 187-188), destroyed only when the player closes Pixel Battle (line 827-833) or switches games (line 577 in `mg_ui.js` calls `activeGame.destroy()`). If you leave the Escape menu open and switch to a different minigame, Pixel Battle is destroyed and pending state is lost. If you just close the menu, Pixel Battle pauses but stays mounted (no destroy call), so pending persists — which matches the "manual UPLOAD" design.

---

## SUMMARY

**Confirmed bugs**: 4 (1 high, 2 medium, 1 low)
**Retracted findings**: 1 (zoom clamp)
**Confirmed non-issues**: 5

**Change #3 fallout** (removing `visibility="collapse"`): The high-severity wedge (#1) is a direct consequence — the old frame staying visible hides the failure mode when `crispReady` gets stuck false.

**Change #1 fallout** (removing auto-flush): The low-severity UI contradiction (#4) only surfaces because pending can now sit for 50+ minutes. The design is correct (manual upload), but the stat display assumes pending clears quickly.

**Change #2 fallout** (poll 10s→20s): None. The ladder is now dead code but harmless.

**No leaks found**: `$.Schedule` callbacks all check `destroyed` or generation counters. No panel references leak after `showBanned()` or `destroy()`.

**No coordinate bugs found**: The 768/64 = 12px grid math is exact, enforced by the regression test. `mapPoint`, `positionPending`, and `clampOrigin` are correct.

**Server/client constant agreement**: All checked pairs match (VIEW_W/H, MIN_BATCH, palette length), except the version modulo mismatch in bug #2.

---

## Agent 2 — mg_net.js / mg_ui.js / mg_games.js lifecycle & decode guards

I've finished the audit. Here are the findings.

## Confirmed by reading the code

### 1. HIGH — `MG.Api.move` accepts any non-`w===9` decode as an accepted move, bypassing `suspectDecode`

`panorama/scripts/mg_net.js:750`

```js
move: function (code, from, to, end, tok, cb, err) {
    request("/api/move", { code: code, from: from, to: to, end: end ? 1 : 0, tok: tok },
        function (w, h) {
            if (!cb) return;
            if (w === 9) {
                const reason = h === 1 ? "turn" : h === 2 ? "illegal" : h === 3 ? "token" : "gone";
                cb({ ok: false, reason: reason });
            } else {
                cb({ ok: true });          // ← any (w,h) that isn't w===9
            }
        }, err);
},
```

**Root cause.** The server only ever answers `/api/move` with `d(1,1)`, `d(9,1)`, `d(9,2)`, `d(9,3)`, `d(9,9)` (`server/worker.core.js:963-993`), plus `d(9,3)` from the distinct-code scan guard (`CODE_SCAN_AUTH_ROUTES` includes `/api/move`, `worker.core.js:1535`). So the only legitimate success is exactly `(1,1)`. But this wrapper never checks for it — `else cb({ok:true})` swallows every other value. Compare its siblings, which all assert `(1,1)` and trip `suspectDecode` otherwise: `pact` (`mg_net.js:1192-1198`), `dact` (`:1018-1024`), `start` (`:1004-1010`), `pstart` (`:1177-1183`). `move` is the odd one out, and it is the single most safety-critical write in the mod.

The consequence is that `move` is the one write route that can never trigger recalibration. Every other route funnels an impossible decode into `suspectDecode` → `calibrated = false` → re-probe. On a stale scale, `decodeLevel` (`:468`) is monotonic in the true level, so a `(1,1)` reply that mis-decodes drifts to `(0,0)`, `(2,2)`, etc. — all of which land in the `else` branch and read as success. Worse, a genuine rejection `(9,2)` whose width mis-decodes to 8 or 10 is *also* reported as `{ok:true}`: the controller keeps its optimistic prediction for a move the server refused and never enters `rejectAndResync`.

**How it presents.** Affects the four 2-int games that call it — `mg_checkers.js:1018`, `mg_chess.js:771`, `mg_ttt.js:185`, `mg_connectfour.js:249`, all via `rejectAndResync(r.reason)`. Your piece moves and stays moved; the server's board never advanced. Your next `/api/poll` returns the opponent's move computed against a board one ply behind yours, so `deriveEnd` and `applyHopFx` replay it onto the wrong position — pieces jump to squares nothing came from, or vanish. Because `suspectDecode` never fires, the scale is never repaired, so it does not self-heal: it degrades until the desync is total. This is precisely the "corrupted moves that eat pieces" failure mode §5's calibration notes call out, arriving through the one door left unguarded.

**Fix shape** (not applied): mirror `pact` — `if (w === 1 && h === 1) { cb({ok:true}); return; }` then the `w===9` reason map, then `suspectDecode` + `cb({ok:false, reason:"decode"})`. Note `rejectAndResync` already handles an unknown reason string, so a `"decode"` reason needs no controller change.

---

### 2. HIGH — `MG.Api.rematch` range-checks nothing; a corrupt decode restarts one player's board unilaterally

`panorama/scripts/mg_net.js:973`

```js
rematch: function (code, tok, gen, cb, err) {
    request("/api/rematch", { code: code, tok: tok, gen: gen || 0 },
        function (w, h) { if (cb) cb({ state: w, gen: h - 1 }); }, err);
},
```

**Root cause.** No guard at all — `w` is passed through as `state` and `h-1` as `gen`. The server's vocabulary is narrow: `d(1, gen+1)` waiting, `d(2, gen+1)` consensus, `d(9,9)` gone, `d(9,3)` bad token (`worker.core.js:1051-1119`), plus `d(9,3)` from the scan guard. The consumer at `mg_ui.js:1519-1522` then does:

```js
if (r.state === 9) { kickToMenu("Opponent left."); return; }
if (r.state === 2 || r.gen > baseGen) { rematchGen = r.gen; restart(); return; }
```

Two independent ways a stale scale corrupts this. A `(1, gen+1)` "still waiting" whose width mis-decodes to 2 fires `restart()` — the client re-mounts a fresh board while the server lobby was never reset and the opponent is still on the game-over screen. And `r.gen > baseGen` is even more exposed: `gen` is a raw `h-1` with no bound, so *any* height inflation on a legitimate `(1, gen+1)` reply satisfies it and also fires `restart()`. Both paths then latch `rematchGen = r.gen` to a garbage value, so the next handshake sends a `gen` the server won't match at `worker.core.js:1070` (`if (callerGen === lobby.gen) lobby.rm[seat] = true`) — that seat can no longer arm a rematch at all.

**How it presents.** On the game-over screen after pressing Play Again in any online 2-int game or dealer game: your board resets to a fresh position and the clock restarts, while your opponent still sees the finished game. Your first move is then refused (or, per finding 1, silently "accepted") and the two clients are permanently disjoint. Subsequent Play Again presses do nothing because the latched `rematchGen` no longer matches the server's. There is no error text — it looks like the opponent rage-quit and the button broke.

**Fix shape:** validate `w ∈ {1,2,9}` and `h ∈ 1..63` before constructing the result, `suspectDecode` otherwise; `mg_ui.js` should additionally ignore a `gen` that exceeds the 6-bit space the server wraps into (`lobby.gen = (lobby.gen + 1) % 63`, `worker.core.js:1111`).

---

### 3. MEDIUM — `MG.Net.clearQueue` drops queued jobs without firing their callbacks, stalling any chained continuation

`panorama/scripts/mg_net.js:504-517`

```js
clearQueue: function () {
    const kept = [];
    for (let i = 0; i < reqQueue.length; i++) {
        if (reqQueue[i].path === "/api/probe") kept.push(reqQueue[i]);
    }
    reqQueue = kept;
},
```

**Root cause.** Dropped jobs get neither `onDone` nor `onError`. The comment justifies this as safe because "their callers are token-guarded, so silence is fine" — true for the *poll loops*, which re-arm from a `$.Schedule` chain, but not for callers whose next step lives **inside** the dropped callback. Two such callers exist:

- `MG.Api.clocks` (`mg_net.js:935-963`) is a two-request chain: `readSeat(0, …)` and only from inside its callback `readSeat(1, …)`. If `clearQueue` lands between them, seat 1's job is discarded silently — neither `next` nor `fail` runs, so `createClock`'s `resyncTick` (`mg_games.js:124-143`) never reschedules. Its error path `() => { if (!stopped) $.Schedule(…) }` is the only thing that re-arms the loop, and it is never reached.
- `mg_geoguesser.js:620-627` chains `addCachedCopy(url, 0, …)` → `addCachedCopy(url, PANO_STEP*2, …)` → `panoramaReady = true`. A drop between the two leaves `panoramaReady` false forever. (This one *is* covered on the error side — `addCachedCopy`'s `onError` calls `done()` at `mg_geoguesser.js:581` — but a silent drop invokes neither handler, so the guard doesn't help.)

The trigger is `cleanupCurrentView` → `clearQueue` (`mg_ui.js:556`), reached from `renderMenu`, `renderJoin`, `renderGame`, `renderWaiting`, `renderLobbyRoom` and `hideOverlay`. The dangerous caller is `startRematch` → `restart()` → `renderGame` (`mg_ui.js:1511-1514`): the *outgoing* controller is destroyed by the same `cleanupCurrentView`, so its stalled clock dies with it — but the **incoming** `renderGame` builds a new `createClock` whose first `resyncTick` is queued, and a second view switch arriving inside that window (Leave pressed during a rematch, or a `kickToMenu` racing the re-mount) drops it.

**How it presents.** In online chess or checkers after a rematch or a fast view switch: the clock panel stays collapsed and never appears — `wrap.style.visibility` is only flipped to visible on the first successful reply (`mg_games.js:129`) — or, if already revealed, both clocks freeze at their last-painted values while local interpolation keeps draining seat displays that never re-sync. The server still flags on time, so you lose on time with a clock that appeared to have minutes left. In GeoGuesser the same drop leaves "Loading panorama…" up permanently with no retry, because `loadPanorama`'s retry is also only wired to the error callback.

**Fix shape:** invoke `job.onError("cancelled")` for each dropped job before discarding it. Every existing `onError` handler already treats an unknown reason as a retryable transport failure, so this restores the loops without touching callers.

---

### 4. MEDIUM — `MG.Api.poll`'s `(9,9)` branch returns without calling either callback, wedging the caller when the kick is refused

`panorama/scripts/mg_net.js:774-779`

```js
if (w === 9 && h === 9) {
    log("opponent left (9x9 received)");
    if (MG.UI && MG.UI.kickToMenu) MG.UI.kickToMenu("Opponent left.");
    return;                       // ← neither cb nor err
}
```

**Root cause.** The early `return` fires no callback, on the assumption that `kickToMenu` always tears the view down so the poll loop is moot. But `kickToMenu` (`mg_ui.js:2053-2054`) is conditional:

```js
function kickToMenu(reason) {
    if (view !== "game" && view !== "waiting" && view !== "room") return;
```

When `view` is anything else the kick is a no-op, and the poll callback has already declined to call `cb` or `err` — so the controller's poll chain terminates with no reschedule. The reachable window: `MG.Api.poll` is issued by a live controller, then the player navigates (`renderJoin` sets `view = "join"`, `mg_ui.js:1330`) while the request is in flight. A started request always runs to completion by design (§5, no abort), so the reply lands with `view === "join"`. Normally the controller's own `destroyed`/`pollToken` guard makes that harmless — but `renderJoin` → `cleanupCurrentView(true)` destroys the controller, so this specific path is benign.

The path that is **not** benign is the same `(9,9)` handler in `dlog` (`mg_net.js:1032-1035`) and `plog` (`:1216-1219`), which are Durak's and Poker's *only* event streams. There, a `(9,9)` arriving while `view === "room"` does kick correctly — but during the `renderLobbyRoom` → `renderGame` transition (`mg_ui.js:1701`), `view` is momentarily `"room"` for the outgoing poll and `"game"` for the incoming one, and the mid-flight `dlog` reply is consumed by whichever fires first. If the kick wins, the freshly-mounted game is torn down immediately; if it loses, the log cursor is silently abandoned.

**How it presents.** Durak or Poker, on the transition from the lobby room into the dealt hand when the opponent leaves at almost the same moment: either the table is dealt and instantly yanked back to the picker with "Opponent left.", or the table stays up with a frozen event log — cards never arrive, no turn indicator, no error, and only Leave works. Distinguishing these two requires an in-game repack; the code path that produces both is unambiguous.

**Fix shape:** call `err("gone")` (or `cb(null)`) after the `kickToMenu` attempt in all three `(9,9)` handlers, so a refused kick still leaves the caller's retry logic armed.

---

### 5. LOW–MEDIUM — a failed recalibration can stall all traffic for ~48s, and `isLevelEncodedSize` fails open during it

Two coupled issues around the calibration latch.

**(a) Retry multiplication.** `probeOnce` retries up to `PROBE_ATTEMPTS = 3` (`mg_net.js:402, 411-420`), but each of those attempts is a `rawRequest` job that `drainQueue`'s `failure` handler independently retries once (`:229-235`, `if (job.tries < 2)`). With `REQ_TIMEOUT_MS = 8000` (`:62`) that is 3 × 2 × 8s = **48 seconds** of a wedged FIFO before `failCalib` runs, during which every game poll, clock resync and asset load sits behind the probe. The two retry layers were each reasonable in isolation; their product was not intended by either comment.

**(b) `isLevelEncodedSize` fails open while uncalibrated.** `mg_net.js:480-484`:

```js
function isLevelEncodedSize(w, hh) {
    if (!calibrated) return false;
    ...
}
```

`suspectDecode` sets `calibrated = false` (`:458`) before re-probing, and `failCalib` (`:388-394`) leaves it false. Its sole consumer is GeoGuesser's panorama loader (`mg_geoguesser.js:602`), which uses it to distinguish a real photograph from a small level-encoded error PNG:

```js
if (MG.Net.isLevelEncodedSize(loadedW, loadedH)) { …reject and retry… }
```

While uncalibrated it answers `false` for everything, so a `d(6,63)` error sentinel from `/api/geoview` (`worker.core.js:584`) or a `d(9,x)` access rejection (`:582`) is accepted as a valid panorama and handed to `configurePanoImage`. Note this is the *opposite* polarity from the documented `h=63` sentinel handling in the reveal routes — those check the sentinel explicitly and are unaffected.

**How it presents.** (a) During a server hiccup or a resolution change mid-match: the game freezes for up to ~48s with no status change — moves you make appear locally but nothing arrives, clocks drift, then everything errors at once and the controllers retry, potentially starting another 48s chain. (b) In GeoGuesser specifically, if a decode has already tripped `suspectDecode`, a round can render a stretched ~15×582px error PNG across the 2880×1440 strip instead of a photograph, with the camera controls live over it and the round timer running — the player is asked to guess a location from a solid smear. Both need an in-game repack to observe; the state machine that produces them is confirmed by reading.

**Fix shape:** cap the total probe budget (either drop the per-job retry for `/api/probe` or reduce `PROBE_ATTEMPTS`), and make `isLevelEncodedSize` fail *closed* — an uncalibrated transport cannot vouch for a payload, so returning `true` (reject the frame, let the existing 1.5s retry run) is the safe default.

---

### 6. LOW — `MG.Api.join` accepts game id 9 with a time-control index in the height, and `geoPointAxis`'s `w >= 63` guard is off by one against `h`

Two narrow decode-guard gaps, reported together as they are the same class.

`mg_net.js:694`: `if (w >= 1 && w <= 9) cb({ ok: true, game: w, tc: tcFromIndex(h) })`. The width range covers game 9 (GeoGuesser), but `worker.core.js:917` refuses to seat a GeoGuesser lobby through the generic join only when `lobby.cap || lobby.game === 6 || !lobby.game` — game 9 passes. `tcFromIndex` (`mg_net.js:578`) silently maps any `h` outside `0..4` to 0, so a corrupt height is absorbed rather than flagged. `doJoin`'s downstream `MG.Games.byId(res.game)` enabled-check (`mg_ui.js:2000-2001`) is what actually protects this today — the guard is load-bearing by accident, not by design.

`mg_net.js:848-858`: `geoPointAxis` guards `w < 0 || w >= 63` but never bounds `h` directly, relying on `value >= limit` to catch it. For `axis === 1` the limit is `GEO_GRID_H = 256`, so `h` is effectively bounded at 4 — but for `axis === 0` the limit is 512, admitting `h` up to 8 while the server only ever emits `h = value / 63 | 0` for `value < 512`, i.e. `h ≤ 8`. The guard happens to be tight here; the same pattern in `geoScore` (`:875`, `score > 4095`) admits `h` up to 63, which collides with the `h === 63` error sentinel checked one line earlier. Currently harmless because the sentinel test runs first, but the two bounds are derived independently and a future limit change breaks the coupling silently.

**How it presents.** Neither is reachable on a correctly calibrated client today. Reported as guard-hardening rather than live defects.

---

## Categories that are clean

- **Request-queue starvation / `reqActive` wedging.** `drainQueue` (`mg_net.js:206-244`) is correct. Both `success` and `failure` release `reqActive` from a `finally`, so a throwing callback cannot latch it; the retry path re-queues at the front and releases identically; `imageRequestNow` and `rawRequestNow` both guard their `check()` loop with a `finished` flag so timeout and success are mutually exclusive; the constructor `catch` blocks call `onError` on the same tick, which routes into `failure` normally. I could not construct a path that leaves `reqActive` true with an empty queue.
- **Double-invoked callbacks.** The `finished` latch in both `*RequestNow` functions is checked at the top of `check()` and set before every terminal branch. No path fires `onDone` and `onError`, or either twice.
- **Net host leaking over the native menu.** `ensureHost`/`releaseHost` (`:148-176`) are sound, and the structural fix trap 4 documents is intact: lazy calibration means no host exists until the first online request, and `drainQueue` calls `releaseHost()` on the idle transition (`:209`). The `hittest`/`hittestchildren` pair is set at construction (`:163-164`), as trap 4 requires. `releaseHost` uses `DeleteAsync(0)` and nulls the handle, so a request arriving before the deferred delete lands gets a fresh panel from `ensureHost`'s `IsValid` check rather than a stale one.
- **Generation counters in the UI shell.** `uiActionGen` / `currentAction` / `actionAlive` / `bindActionCode` / `discardStaleSeat` (`mg_ui.js:54-78`) are used consistently across all seven entry points (`startCreate`, `startQuickMatch`, `startMultiQuick`, `doJoin` ×3 branches, `startGeoSolo`), and every one disposes an orphaned seat on a lost race. `statusPollToken`, `rematchPollToken`, `selfTestToken` and `updateCheckToken` are each bumped before arming their loop and re-checked inside every callback. `createTurnTimer`'s `gen` (`mg_games.js:242`) is bumped on `start`, `stop` and `destroy`, and both the `arm` and `tick` continuations re-check it.
- **`$.Schedule` chains surviving a destroyed panel.** Every controller's `destroy` sets a `destroyed` flag and bumps its poll token, and all nine check it on entry to each scheduled continuation. `createTurnTimer.destroy` sets `dead` before deleting the wrap (`mg_games.js:343-346`); all five consumers call it from their own `destroy` (`mg_ttt.js:264`, `mg_durak.js:1033`, `mg_poker.js:641`, `mg_connectfour.js:322`, `mg_geoguesser.js:981`). `createClock`'s `stop()` is called from `destroy` in both consumers (`mg_checkers.js:1188`, `mg_chess.js:907`) and `stopped` is checked at the top of `interpTick` and `resyncTick`.
- **Controller mount/unmount ordering.** `renderGame` calls `cleanupCurrentView(false)` (`mg_ui.js:1400`) *before* `MG.Games.mount` (`:1420`), so the predecessor's `destroy` always runs first — no path mounts over a live controller. `clearBody` (`:582-602`) nulls `footerStatus`, `detailPanel` and `cardEls` before `RemoveAndDeleteChildren`, closing the stale-handle hazard its own comment describes. `activeGame` is nulled after `destroy` (`:576-579`).
- **UI-scale clamp.** `fittedScalePct` / `measureNaturalH` / `applyUiScale` (`mg_ui.js:507-550`) match trap 20 exactly: no CSS `max-height` dependency, the applied scale divided back out so the reading works at any current scale, the tallest-seen height retained, the retry loop bounded at 40 frames, and it never clamps below 100%.
- **Escape-menu polling and overlay lifecycle.** `watchEscape` (`:2045-2051`) unconditionally reschedules itself and is armed exactly once from boot (`:2068`); `showOverlay`/`hideOverlay` keep `overlayShown` and `setEscapeBackgroundActive` paired. `startInjectionLoop` (`:230-233`) reschedules unconditionally and its `escBtn.IsValid()` early-out is correct.
- **Calibration distortion detector.** `probeOnce`'s clamp check (`mg_net.js:434-439`) implements §5's ±15% divergence rule correctly, rejects rather than falling back to scale 1, and only latches `swap`/`scaleX`/`scaleY` after passing. `finishCalib`/`failCalib` both drain `calibWaiters` through a local copy, so a waiter re-entering `calibrate` cannot corrupt the list being iterated. No `calibrating`-latched-forever path exists — every `probeOnce` terminus reaches one of the two.

---

## Not reported as bugs (intentional, per ARCHITECTURE.md)

For the record, so a later pass doesn't re-flag them: no abort on in-flight requests (§5); the single front-of-queue retry as mitigation-not-fix (§5); `MG.Api.cancel` / `leave` ignoring their replies (fire-and-forget, `mg_net.js:674-684`); `clearQueue` preserving `/api/probe` (`:514`); the 2%-opacity oversized host (§5 / trap 4); `scaling: "none"` in `mg_pixelbattle.js:708` (whitelisted at `tools/mg_release_ui_regression_test.js:201`); the unused `lastResync` constant in `mg_games.js:50` (dead, harmless); and the equirectangular stretch (trap 23).

## Verification status

All findings above are **read-only static traces** through `mg_net.js`, `mg_ui.js`, `mg_games.js`, the nine consumers and `server/worker.core.js`. I did not render or run anything — this mod cannot execute outside the game, so no visual or runtime confirmation is claimed for any item. Findings 1–4 are decode-guard and callback-contract defects provable from the code alone; findings 5 and 6 are confirmed as state-machine gaps, but their *in-game presentation* is inferred and would need a VPK repack to observe. No files were modified.

---

## Agent 3 — ES6 codemod commits (var/let, arrows, templates)

The auto-flush revert is uncommitted work-in-progress, separate from the codemods. I have everything I need.

## Audit: ES6 codemods on `refactor/es6-const-let`

**Bottom line: the three codemods are clean.** I verified them by lockstep AST comparison, not by reading diffs, and found exactly one real defect — an ASI hazard the guard cannot see. `node tools/build_worker.js --check` → **`worker.js is in sync with its sources`**.

### Correction to my own method (affects how you should read this)

On Windows `execSync` routes through cmd.exe, where `^` is the escape character, so `git show SHA^:file` silently resolves to `SHA:file` — comparing every file **to itself**. My first pass "proved" the var codemod pure that way; it proved nothing. Everything below is redone with `~1` and reports non-zero conversion counts, which is the sanity check that the comparison actually ran.

---

## Finding 1 — CONFIRMED, HIGH: a shipped line starts with a backtick, past every guard

`panorama/scripts/mg_wordle.js:166-167`, introduced by **781b5bf**:

```js
status(won ? `Solved in ${row}${row === 1 ? " guess!" : " guesses!"}` :
    `The word was ${answer}.`);
```

Before that commit the continuation began with a `"`, which is inert:

```js
status(won ? "Solved in " + row + (row === 1 ? " guess!" : " guesses!") :
    "The word was " + answer + ".");
```

**Root cause, traced.** Three independent guards all encode the trigger set as `( [ + - /`, and none includes `` ` ``:

- `tools/es6_templates.js:301` — `const TRIGGER = new Set(["(", "[", "+", "-", "/"]);` — the codemod's own refusal check
- `tools/mg_es6_invariants_test.js:230` — `if (/^[([+\-/]/.test(t))` — the shipped-tree guard
- `eslint.config.js:173` — `"operator-linebreak": ["error", "after", …]` — a ternary `:` is `"ignore"`, and a template literal is not an operator at all, so ESLint is silent (`npx eslint panorama/scripts/mg_wordle.js` → exit 0)

The codemod's line-start check compares old vs new first characters. Old was `"`, new is `` ` `` — neither is in `TRIGGER`, so `!TRIGGER.has(y[0])` passes and the site converts. The invariants test then counts 62 vs a baseline of 62 and reports green, because it is counting a **character class that excludes the character that changed**. This is the one shape where a template conversion can create a hazardous line start, and it is precisely the shape the guard cannot represent.

**How it presents in-game.** Only if Valve's minifier treats `` ` `` as an ASI continuation trigger the way it treats `(`. If it does, line 166 and 167 join and `mg_wordle.js` fails to parse — Wordle's controller never registers, and `mg_load_smoke_test` would not see it because that test runs the unminified source under Node. If the minifier's trigger set really is only `( [ + - /`, this is inert.

**Status: the hazardous line start is confirmed by reading the code; whether the minifier breaks on a backtick specifically is SUSPECTED and needs a repack.** ARCHITECTURE §10.2 documents the set as `( [ + - /` and cites `mg_games.js:665` as the build that broke, so the backtick case appears never to have been tested. It is one line to make safe regardless of the answer — pull the continuation up, or parenthesise so the line starts with a character already known inert.

---

## The codemods themselves: clean, with counts

I walked the before/after ASTs of every `.js` file in each commit in lockstep and **bucketed every single difference** rather than sampling, so nothing hides behind a display cap.

**a3017d4 (var → const/let)** — 32 files, all differences:
- 1944 × `kind: "var" → "const"`, 962 × `kind: "var" → "let"`
- 14 × regex-literal widening in two *test* files (`/var X/` → `/\b(?:var|let|const) X/`)
- **Zero other AST changes.** No shipped file has anything but a declaration-kind flip.

**00f188d (arrows)** — 41 files: **139 × `FunctionExpression → ArrowFunctionExpression`**, plus 2 test-regex widenings and one added assertion line in `mg_release_ui_regression_test.js`. Nothing else.

**781b5bf (templates)** — 46 files: **809 × `BinaryExpression(+) → TemplateLiteral`**, plus one deliberate test change (`mg_geoguesser_map_test.js:60`, widened to accept either spelling — called out in the commit message). Nothing else.

### The specific hazards you named, each checked directly

**Arrow `this`/`arguments`/constructor** — clean. Of 509 anonymous function expressions converted, **zero** were named (self-recursion), a `.bind()` receiver, an object-literal property value, a `new` callee, or a prototype assignment. Independently, a whole-tree scan (71 files, panorama + server + tools) finds **no arrow anywhere reading `this` or `arguments`**, against a positive control of 156 real `this` sites, all inside `function`. The single hit is `tools/mg_release_ui_regression_test.js:39` — a `filter(child => child !== this)` inside a hand-written mock panel, authored in `fd500c4`, not by the codemod, and correct as written.

**Template arithmetic → concatenation** — clean, and this was the real risk. For all 809 conversions I checked (a) the leftmost operand of the old chain was a **string literal**, and (b) the operand sequence is preserved with parenthesised sub-expressions kept as **one** operand. Both zero violations. That second check is the `"translate3d(" + (dc * SQ + INSET) + "px"` → `${dc * SQ}${INSET}px` = `"00px"` bug the commit says its probe caught — the fix holds in the committed tree. Only 14 interpolations contain an operator at all, and each is a whole parenthesised group (`${dc * SQ + INSET}`, `${seat + 1}`, `${x + ox}`).

**`const`/`let` loop capture and TDZ** — clean. No closure anywhere in `panorama/scripts` captures a `let`/`const` loop binding, and the 25 surviving `var`s are exactly the IIFE-capture sites §10.2 describes (`((square) => {…})(i)`), so handlers close over a parameter. escope reports **zero unresolved references** in all shipped Panorama scripts — that is the check that would catch a `var` used outside the block `let` now scopes it, which is a runtime `ReferenceError` that `node --check` cannot see. Eleven backward references to `let`/`const` exist, but all eleven are inside deferred function bodies (`beginOnlineAction`, `startBotGame`, `onRoundTimeout`, `buildOverlay`, and the seat-picker arrows) that run long after the controller IIFE completes. No load-time TDZ.

**Behaviour smuggled into a "mechanical" commit** — none, per the exhaustive bucketing above. Every commit's non-mechanical edits are test-side and disclosed in its message.

`npm test` is green end to end (448 server checks, 63 load-smoke, all four ES6 harnesses), and `npx eslint` is clean.

---

## One thing that is not a regression but you should know

Your working tree is **dirty** and it partly reverts `6e97314`. `mg_pixelbattle.js` currently has `POLL_ACTIVE_S/WARM_S/IDLE_S = 20` where HEAD has `10`, and the debounced auto-flush is gone — the header comment now reads "UPLOAD is the ONLY thing that sends pixels… That removed the player's last chance to change their mind." So the shipped-at-HEAD behaviour and your on-disk behaviour differ. `ARCHITECTURE.md` and `mg_release_ui_regression_test.js` are modified to match. Uncommitted, so outside the audit scope, but worth not losing.

Also flagging trap 25 as it applies here: `6e97314` changed `PX_MIN_BATCH` and `PX_UPLOAD_MAX_HITS` in `worker.core.js`. `--check` proves the committed `worker.js` matches its sources; it says nothing about what the VPS is running. That is a deploy verification, not a repo one.
