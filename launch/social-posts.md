# Launch posts — tailored per community

Post the **demo clip** with each. Then camp the thread for ~2 hrs and reply fast (use the reply playbook in issue #1). Don't cross-post the same text everywhere — each is written for its audience.

---

## Hacker News — Show HN
*Culture: technical, understated, zero hype/emoji, invite scrutiny. Post Tue–Thu ~8–10am ET.*

**Title:**
`Show HN: claude-rpc – Discord Rich Presence for Claude Code`

**Text:**
> claude-rpc puts your live Claude Code session on your Discord profile — current model, project, file, today's hours, lifetime tokens/cost — using the lifecycle hooks Claude Code already fires.
>
> The design is deliberately boring: a hook runs on each event (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd) and writes a small state file. A long-lived daemon holds Discord's local IPC socket, watches that file plus the on-disk transcript, and pushes presence frames. No polling between sessions; the SessionEnd hook clears the card instantly. A separate scanner walks ~/.claude/projects/\*\*/\*.jsonl for all-time aggregates (active time, tokens, cost, streaks, languages, churn), cached incrementally.
>
> Beyond the card it's also a local web dashboard, a terminal TUI, shareable SVG badges/cards, and a year-in-review ("Claude Wrapped").
>
> Privacy: Discord is local IPC only. The one thing that can leave your machine is opt-in, anonymous community totals — two integer counters and a random UUID, nothing else (off with `claude-rpc community off`; details in SECURITY.md).
>
> Install: `npx claude-rpc setup` (macOS/Linux/Node; portable .exe for Windows). MIT, built solo on weekends.
>
> Happy to dig into the hook→state→daemon→IPC design, the token de-dup that fixed a ~2–3× cost overcount, or the single-binary (Node SEA) packaging. Feedback welcome.

---

## Reddit — r/ClaudeAI
*Culture: visual-first, friendly, genuine. Lead with the GIF. Skim the sub's self-promo rules first.*

**Title:**
`I built claude-rpc — your live Claude Code session on your Discord profile (free, MIT)`

**Body:**
> *[drop the demo GIF here]*
>
> I wanted my Discord profile to show what I'm building when I'm deep in Claude Code, so I made **claude-rpc**. It hooks into the events Claude Code already fires and shows a live card: current model, project, the file/tool it's working on, today's hours, lifetime tokens & cost — and it flips to a "Just shipped 🚀" frame when you `git push`.
>
> It's more than a flex, though: there's a local web dashboard, a terminal stats view, and a "Claude Wrapped" year-in-review. Your data stays local (Discord uses local IPC); the only optional thing that leaves your machine is anonymous community totals, which you can turn off.
>
> One command to try it:
> `npx claude-rpc setup`
>
> Free + MIT: https://github.com/rar-file/claude-rpc — would genuinely love feedback, feature ideas, or bug reports. Happy to answer anything in the comments.

---

## Also good (same Reddit body, lightly adjusted)
- **r/SideProject**, **r/coolgithubprojects** — self-promo is expected; the Reddit body works as-is.
- **Discord** (Anthropic's server showcase + dev servers you're in) — use the shorter Discord blurb from issue #1.
