# Commend Everyone Button

One controller belongs to `CitadelPostGameNew`; the MVP script include forwards
button clicks without starting another polling loop. The native page may be
hidden or destroyed: hidden pages check only page state once per second, while
a deleted page stops scheduling. Reload disposes the previous controller and
pending clicks. A different MatchID cancels pending clicks and clears match state.

Native `CommendPlayerButton` targets are resolved under
`ScreensCarousel/ScoreboardScreen/Scoreboard/.Player`, including the dynamically
created team rows. The old PlayerActionContainer no longer owns these buttons.
Local, already commended and totals rows are skipped. Clicks remain confined to
the current visible post-game page and are cancelled when it closes. Native
`CommendedPlayer` state is the acknowledgement; dispatch alone never marks success.
If the scoreboard has not been instantiated, open its tab and retry; no native
navigation or commend API is guessed for the MVP/team cards.

```text
node tools/tests/runtime_regressions.cjs
```

After repacking, check recent and historical matches, all screen tabs, local and
already commended rows, rapid close/reopen, switching match IDs, and native
acknowledgements. Offline tests exercise lifecycle and targets, not server-side
commend acceptance or whether C++ destroys the page on every navigation path.

Native activation uses `DispatchEvent("Activated", button, "mouse")`, the
source-qualified contract used by SecondEye/QOLLOCK for C++-bound panels.
`MouseActivate` is not a supported DispatchEvent name. The offline activation
double accepts only the confirmed event and requires its source argument.
