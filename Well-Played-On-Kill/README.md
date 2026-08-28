# Well Played On Kill

Automatically sends `Well Played!` to ALL chat the moment you get a kill. Kill assists are
ignored, and a 3-second cooldown collapses multikills into a single message.

## How it works

**Kill detection** — `hud_damage_impact.css` puts `.killed` on a `.damageImpactInstance` panel for
a kill and `.assist` for a kill assist. The script polls the children of `#damageImpactInfo` every
`POLL_RATE` seconds for `killed && !assist` and fires once per panel.

Panorama exposes no kill event to scripts, so polling is the only option — the entire client string
dump contains just `CitadelHudBossKilled` (the mid-boss), and there is no `GameEvents` /
`SubscribeToGameEvent` API. The cost is bounded:

- `$.Schedule` is frame-bound, so a callback cannot run more than once per frame. `POLL_RATE: 0.01`
  means "every frame" and the ceiling is the frame rate, not 100 scans per second.
- Panel lookups are cached in `State` (`#damageImpactInfo`, `#ChatInput`, `#ChatTargetLabel`).
  `FindChildTraverse` runs on first resolve, or again only if a panel goes invalid.
- An idle tick is three calls across the JS/C++ boundary. `#damageImpactInfo` has zero children
  unless you are actively hitting a hero, so the scan loop body does not execute at all most of the
  time. In a fight it adds 3-4 calls per panel across 1-3 panels.

**Chat sending** — Panorama has no scriptable `say`, so the stock chat panel is driven directly:

1. `$.DispatchEvent('CitadelConCommand', <open command>)` to open the chat input
2. write the message into `#ChatInput`
3. `$.DispatchEvent('CitadelChatInputSubmitted', input)`
4. clear the text, then `CitadelChatInputBlur` + `DropInputFocus` to close

End-to-end latency is roughly two frames (~30 ms) after the HUD flags the kill.

**Multikill guard** — the cooldown timestamp is stamped when a kill is *accepted*, not when its
send completes. Two kills landing in the same frame are both walked by the same scan tick, so the
second one sees a zero-age timestamp and is dropped. Extra kills are discarded outright rather than
queued, so nothing arrives in chat seconds after the fact.

## Files

| File | Role |
| --- | --- |
| `panorama/layout/hud_damage_impact.xml` | Stock layout plus a `<scripts>` include. Unchanged otherwise. |
| `panorama/scripts/well_played_on_kill.js` | Kill detection and chat sending. |

Everything tunable lives in the `CONFIG` block at the top of the script — message text, poll rate,
retry delays, `COOLDOWN_MS`, and `DEBUG` for `$.Msg` output in the Panorama debugger console.

## Not yet verified in game

- **The ALL-chat console command.** `say_chat_team` is the confirmed team-chat command; the ALL
  variant is inferred from the `Chat` / `ChatTeam` keybind pair in `popup_settings.xml`.
  `CONFIG.OPEN_COMMANDS` therefore holds three candidates (`say_chat`, `say_chat_all`, `chat_all`)
  and the script tries each until one yields an ALL target, then caches the winner. Turn on
  `DEBUG` to see which one wins, and trim the list once it is known.
- **Trooper and creep kills.** The mod assumes only hero kills produce a `killed` damage-impact
  panel. If chat floods on lane creeps, filter on a non-empty `.playerName` inside the instance.
- **Focus theft.** Opening the chat input grabs keyboard focus for the ~30 ms it takes to submit.
  Whether that is disruptive mid-fight is exactly what needs a play test.

## Notes

`CitadelDamageImpact` is persistent for the whole HUD lifetime — only its snippet children are
created and destroyed per hit, and snippets do not re-run layout scripts. So the script loads once,
not once per kill. A generation token in `GameUI.CustomUIConfig()` still guards against two poll
loops racing after a HUD reload: the newer instance bumps the token and older loops retire on their
next tick.
