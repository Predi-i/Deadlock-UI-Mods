# Anti-Toxic-Chat

In-game Deadlock mod that intercepts toxic insults or frustrated messages typed into chat on Enter, immediately closes the chat input bar, transforms the text via AI into wholesome gamer compliments or friendly encouragement, and submits the converted message to the appropriate channel (`ALL`, `TEAM`, or `PARTY`).

## Features

- **Instant Chat Bar Dismissal**: The moment you press Enter, the input box is cleared and closed. You return immediately to gameplay without seeing the old insult sent.
- **Smart Style Matching**:
  - **Case Matching**: If you typed in all lowercase, the output is strictly all lowercase. If all caps, output is all caps.
  - **Word Count Matching**: Keeps roughly the same length (~3-7 words) — no long AI essays or lecturing.
  - **Natural Gamer Tone**: Wholesome antonyms or encouraging banter without emojis, asterisks, or quotes.
  - **Bilingual**: Understands Russian and English naturally.
- **Cloud AI**: The Worker tries Groq, OpenRouter and then Cloudflare Workers AI; provider configuration stays on the server.
  - No personal API keys exposed in the VPK.
  - 100% cloud-based: zero local background scripts or bridges needed.
- **Seamless Chat Submission**: Automatically detects the active chat channel (`ChatTarget_GameAll` vs `ChatTarget_GameAllies` vs `ChatTarget_Party`) and dispatches the converted text using Deadlock's internal input event flow.

## Architecture

```
[ Player types in chat & presses Enter ]
                     │
                     ▼
[ chat.xml: oninputsubmit="OnAntiToxicSubmit()" ]
  - Reads text & clears #ChatInput.text
  - Dispatches CitadelChatInputBlur & DropInputFocus (closes chat bar)
                     │
                     ▼
[ anti_toxic_chat.js ]
  - Uplink via invisible CitadelHTMLPanel: SetURL("https://<worker>/bridge#" + encoded request)
                     │
                     ▼
[ HTTPS Chromium CEF Page served by the Worker ]
  - fetch("https://anti-toxic-chat.predi.workers.dev/api/transform")
                     │
                     ▼
[ Cloudflare Worker /api/transform ]
  - Converts: "ты конченый фидер удали игру" -> "ты отличный стрелок тащи игру"
  - Converts: "you are a fucking dork" -> "you are a great teammate"
                     │
                     ▼
[ Downlink: document.title write -> HTMLTitle event in Panorama ]
                     │
                     ▼
[ Panorama Chat Dispatch ]
  - Opens target channel for 1 tick (say_chat / say_chat_team)
  - Writes converted text into #ChatInput
  - Dispatches CitadelChatInputSubmitted & closes chat
```

## Local Testing / Building

1. Repack the mod into VPK using your Deadlock modding tools.
2. Launch Deadlock, open Sandbox / Hero Testing.
3. Press Enter, type any frustrated message (e.g. `ты конченый фидер удали игру`), and press Enter.
4. Watch it instantly close and reappear as a wholesome compliment!

## October 2026 transport update

The game no longer accepts the old `data:`/`javascript:` bridge navigation.
`worker/src/bridge.js` serves an HTTPS page at `/bridge`. Panorama sends a versioned
hello and serialized transform requests as URL fragments; the page fetches the
existing same-origin `/api/transform` route and returns JSON through `HTMLTitle`.
The handshake checks the page URL, protocol version and per-instance session.
Timed-out queued requests are skipped and stale replies never resend chat.
The existing timeout and original-message fallback are preserved.

Deploy the updated Worker before installing the updated mod. A mod-only repack
cannot add `/bridge` to the live service. Deployment is separate from the GitHub
mod packaging workflow. No live deployment or in-game verification is implied by
the offline hash-change round-trip test:

```text
node tools/tests/runtime_regressions.cjs
```
