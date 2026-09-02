# Good Game After Death

Automatically sends `Good Game!` to ALL chat the moment you die. 

## How it works

**Death detection** — The script polls for a visible `respawn_timer` (specifically `.respawn_number` or `.RespawnTimer` class) in the HUD every 0.3 seconds. When the timer appears and has a value > 0, it triggers a single chat message.

**Chat sending** — Driven via the stock chat panel similar to `Well-Played-On-Kill`:
1. `$.DispatchEvent('CitadelConCommand', <open command>)` to open the chat input
2. Write the message into `#ChatInput`
3. `$.DispatchEvent('CitadelChatInputSubmitted', input)`
4. Clear the text, then blur and drop focus.

**Injection hook** — It injects into `hud_modifiers.xml` (a very small core HUD file) so it stays independent and doesn't conflict with `Well-Played-On-Kill` which hooks `hud_damage_impact.xml`.

## Files

| File | Role |
| --- | --- |
| `panorama/layout/hud_modifiers.xml` | Stock layout plus a `<scripts>` include. Unchanged otherwise. |
| `panorama/scripts/good_game_after_death.js` | Death detection and chat sending logic. |

You can modify `MESSAGE`, `POLL_RATE`, and `DEBUG` at the top of the JS file.
