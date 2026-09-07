# Anti-Toxic-Chat

In-game Deadlock mod that intercepts toxic insults or frustrated messages typed into chat on Enter, immediately closes the chat input bar, transforms the text via AI into wholesome gamer compliments or friendly encouragement, and submits the converted message to the appropriate channel (`ALL`, `TEAM`, or `PARTY`).

## Features

- **Instant Chat Bar Dismissal**: The moment you press Enter, the input box is cleared and closed. You return immediately to gameplay without seeing the old insult sent.
- **Smart Style Matching**:
  - **Case Matching**: If you typed in all lowercase, the output is strictly all lowercase. If all caps, output is all caps.
  - **Word Count Matching**: Keeps roughly the same length (~3-7 words) — no long AI essays or lecturing.
  - **Natural Gamer Tone**: Wholesome antonyms or encouraging banter without emojis, asterisks, or quotes.
  - **Bilingual**: Understands Russian and English naturally.
- **Dual AI Engine**: Powered by OpenRouter (MiniMax M3 Free) with automatic fallback to Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
  - No personal API keys exposed in the VPK.
  - Low latency (~0.8–1.2s round-trip).
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
  - Uplink via invisible CitadelHTMLPanel: SetURL("javascript:window.sendToWorker(...)")
                     │
                     ▼
[ Chromium CEF Page ]
  - fetch("https://anti-toxic-chat.predi.workers.dev/api/transform")
                     │
                     ▼
[ Cloudflare Worker (Workers AI Llama 3.3 70B) ]
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
