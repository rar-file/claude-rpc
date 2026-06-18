# claude-rpc worker — HTTP API reference

The community layer is a single Cloudflare Worker ([`worker/src/index.js`](../worker/src/index.js))
backed by one KV namespace. It holds anonymous community totals, the opt-in
public leaderboard, GitHub-verified profiles, squads (private mini-boards),
referral counters, and the live README badge/card images.

Production base URL: `https://claude-rpc-totals.claude-rpc.workers.dev`

This file documents every route. The **GET** routes are the ones people embed in
READMEs and dashboards, so they are spelled out in full. The base URL, the path,
and the response *shape* of every route below are a **stable, additive-only
contract** as of 1.0.0 — see [`../VERSIONING.md`](../VERSIONING.md). New fields
and new routes may appear; existing paths, parameters, and field meanings will
not change or disappear within a major version.

Notes that apply to every route:

- **CORS:** the read-only JSON/SVG GET routes send `Access-Control-Allow-Origin: *`.
- **Schema marker:** JSON responses carry a top-level `schemaVersion` (currently `1`).
- **Errors:** failures return `{ "ok": false, "error": "<message>" }` with a 4xx/5xx
  status. The image routes (`*.svg`) are the exception — they always return an SVG
  (a neutral placeholder for unknown input) so a README `<img>` never breaks.
- **Time:** JSON responses include a `ts` (epoch ms) where relevant.

---

## GET routes

### `GET /total.json`
Community-wide running totals. The canonical machine-readable feed.

Response:
```json
{ "schemaVersion": 1, "sessions": 123456, "tokens": 7890123456, "ts": 1718600000000 }
```
Cache: `public, max-age=60`.

### `GET /sessions.svg` &nbsp;·&nbsp; `GET /tokens.svg`
Shields-style community badges (the two at the top of the README). No params.
Returns `image/svg+xml`. Cache: `max-age=300`.

### `GET /badge/<handle>.svg`
Live per-user README badge rendered from a published public profile.

| Param | Where | Values | Default |
| ----- | ----- | ------ | ------- |
| `<handle>` | path | the profile handle (`/badge/rarfile.svg`) | — |
| `metric` | query | `tokens` \| `sessions` \| `hours` \| `streak` | `tokens` |
| `label` | query | custom left-side text (sanitized) | the metric's label |

Always returns an SVG. An unknown/unpublished handle renders a `no profile`
placeholder (short cache) so the image still resolves. Cache: `max-age=300`
(`60` for the placeholder).

### `GET /card/<handle>.svg`
Live per-user stat **card** — the richer sibling of the badge, showing the four
profile metrics (tokens, sessions, active hours, streak). Path param only.
Always returns an SVG; unknown handle renders a neutral placeholder card.
Cache: `max-age=300` (`60` placeholder).

### `GET /profile?handle=<handle>`
A single public profile (powers the `/u/<handle>` pages on the site).

Response:
```json
{
  "schemaVersion": 1,
  "profile": {
    "handle": "rarfile",
    "displayName": "Archer",
    "githubUser": "rar-file",
    "verified": true,
    "tokens": 0, "sessions": 0, "activeMs": 0, "streak": 0
  },
  "ts": 1718600000000
}
```
`404` if the handle is unknown. `githubUser` is only ever present on `verified`
rows. The internal per-machine map is never exposed. Cache: `max-age=60`.

### `GET /leaderboard?metric=<m>&limit=<n>`
Top-N public profiles, verified-first ranking.

| Param | Values | Default |
| ----- | ------ | ------- |
| `metric` | `tokens` \| `sessions` \| `activems` \| `streak` | `tokens` |
| `limit` | `1`..`100` | `50` |

Response:
```json
{
  "schemaVersion": 1, "metric": "tokens", "count": 2,
  "leaderboard": [ { "rank": 1, "handle": "...", "verified": true, "tokens": 0, "sessions": 0, "activeMs": 0, "streak": 0, "displayName": null, "githubUser": null } ],
  "ts": 1718600000000
}
```
Cache: `max-age=60`.

### `GET /squad?id=<id>`
Public standings for one squad (weekly deltas + lifetime). Knowing the
unguessable `id` grants viewing; the invite code never appears here. Weekly
baselines reset Monday 00:00 UTC and form lazily on first read of a new week.

Response (abridged):
```json
{
  "schemaVersion": 1,
  "squad": { "id": "abc123...", "name": "Friends", "members": 3, "week": "2026-W24", "createdAt": 0 },
  "standings": [ { "rank": 1, "handle": "...", "owner": true, "weekTokens": 0, "weekSessions": 0, "weekActiveMs": 0, "tokens": 0, "sessions": 0, "activeMs": 0, "streak": 0 } ],
  "ts": 0
}
```
`404` for an unknown id. Cache: `max-age=30`.

### `GET /squad/bycode?code=<code>`
Minimal join-page preview for an invite code (`SQ-XXXXXX`): `{ squad: { id, name, members } }`.
`404` if the code matches no squad.

### `GET /refs.json`
Referral breakdown by allowlisted source: `{ schemaVersion, refs: { discord: 12, ... }, total, ts }`.
Cache: `max-age=60`.

### `GET /ref?s=<source>`
Fire-and-forget referral beacon. Counts one hit for an allowlisted `s` (e.g.
`discord`, `badge`, `readme`, `npm`, `hn`); ignores anything else. Always
returns `204 No Content`, never an error surface. `Cache-Control: no-store`.

### `GET /health`
Liveness check: `{ "ok": true, "schemaVersion": 1 }`.

### Web login (GitHub OAuth) — browser-driven

| Route | Purpose |
| ----- | ------- |
| `GET /auth/login?return=<path>` | Start the GitHub OAuth dance; 302 to GitHub. `return` must be a same-site path. |
| `GET /auth/callback` | OAuth redirect target; mints a stateless session token and 302s back to the site. |
| `GET /auth/me` | Who am I + linked profile. Requires `Authorization: Bearer <session>`. |

These require the deployment to be configured with `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET` / `SESSION_SECRET`; otherwise they return `503`. Sessions
carry only the public GitHub login — the browser never sees an `instanceId`.

---

## POST routes

All POST bodies are JSON. The CLI is the primary client; the site uses a subset
via Bearer sessions. Per-instance and per-IP rate limits apply.

| Route | Body (key fields) | What it does |
| ----- | ----------------- | ------------ |
| `POST /report` | `instanceId`, `sessionsDelta`, `tokensDelta`, `version`, `osFamily` | Add anonymous community deltas. This is the **entire telemetry payload** — see [`validateReport`](../worker/src/index.js) and [`SECURITY.md`](../SECURITY.md). |
| `POST /profile` | `instanceId`, `handle`, `tokens?`, `sessions?`, `activeMs?`, `streak?`, `displayName?`, `version`, `osFamily` | Upsert a public leaderboard profile (absolute totals, clamped). `verified`/`githubUser` are set only by the verify/link flow, never the client. |
| `POST /verify/start` | `instanceId`, `githubUser?` | Issue a one-time gist-verification token. |
| `POST /verify/check` | `instanceId`, `gistId` | Confirm the token appears in a public gist; grants the verified check (merges into the canonical identity if one exists). |
| `POST /pair/start` | Bearer session **or** verified `instanceId` | Mint a one-time machine-link code (10-min TTL). |
| `POST /pair/claim` | `instanceId`, `code` | Claim a link code on a new machine; grants the same verified check and merges machines into one identity. |
| `POST /squad/create` | session/`instanceId`, `name` | Create a squad; returns id + invite code. |
| `POST /squad/join` | session/`instanceId`, `code` | Join via invite code. |
| `POST /squad/leave` | session/`instanceId`, `squadId` | Leave (ownership transfers, or the squad dissolves when empty). |
| `POST /squad/update` | owner session/`instanceId`, `squadId`, `name?` / `regenCode?` / `removeMember?` | Owner tools. |
| `POST /squads/mine` | session **or** `instanceId` | List the caller's squads. |

`OPTIONS` on any route returns `204` with CORS preflight headers.

---

## What is NOT a contract

The KV storage layout behind these routes (key names like `total:counters`,
`pf:<id>`, `handle:<h>`, `board:index`, `squad:*`, `alias:<id>`, `gh:<login>`,
the rate-limit and seen keys) is an **internal implementation detail** and may
change between releases. Consume the HTTP responses, never the KV. The exact
pixels of the `*.svg` images (colors, layout) are presentation, not contract —
the routes and their inputs are stable; the rendering may be refined.
