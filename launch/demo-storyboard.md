# Demo capture — storyboard (the highest-converting asset)

Two ways to get a great clip. **Easiest:** screen-record the self-playing HTML promo. **Most authentic:** record the real card updating. Do both if you can — use the HTML one for ads/headers, the real one for "proof it works" in comment threads.

---

## Option A — the HTML promo (zero setup, deterministic)
1. Open **https://claude-rpc.vercel.app/promo** (or the local file) — it auto-plays a ~18s loop.
2. `?format=square` for a 1:1 (Instagram/X) version; default is 16:9.
3. Screen-record the centered stage for one full loop (it sits on black so it crops clean). Tools: macOS `⇧⌘5`, or [Kap](https://getkap.co)/ScreenStudio → export GIF + MP4.
4. Press **↺ replay** (bottom-right) to re-sync before recording; crop out that button.

Target: **≤15s, MP4 (for X/PH) + GIF (for README/Reddit), 1280×720 and a 1080×1080**.

---

## Option B — the real thing (≈10s, most credible)
**Frame:** Discord desktop card on the left half, your terminal on the right. Record both.

| t | terminal action | what the card does (capture this!) |
|---|---|---|
| 0:00 | already running: `claude-rpc start` done, Discord open | card idle/empty |
| 0:01 | open Claude Code, type a prompt | card flips to **working** — "Editing …" |
| 0:04 | let it run a tool / edit a file | line updates: tool + file + tokens tick up |
| 0:07 | (optional) `git commit` in the repo | card shows the **"Just shipped 🚀"** frame |
| 0:09 | hover the card in Discord | the **Get claude-rpc →** button shows |

Then a 2s tail on a clean shot of the card with stats (`3.2h today · … · 12🔥`).

**Tips**
- Hide secrets: run in a throwaway repo; the project name shows on the card.
- Use a real-ish project name (e.g. `claude-rpc`) so it reads as authentic.
- Zoom Discord to 100–110% so the card text is legible at small sizes.
- Keep it silent; add a one-line caption in post ("my Discord profile while I code with Claude").

## Where each clip goes
- **X / Product Hunt:** the MP4 (autoplays, looks pro).
- **README hero / Reddit:** the GIF (Option B feels most real on Reddit).
- **Landing page:** already uses `docs/demo.gif` — swap in the new one if it's better.
