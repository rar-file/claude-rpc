# claude-rpc worker

The Cloudflare Worker behind every network feature of `claude-rpc`:

- **Community totals** — anonymous session/token counters from CLI installs
  (on by default for fresh installs, `claude-rpc community off` opts out),
  served as the **community · sessions** / **community · tokens** badges on the
  main README.
- **Public profiles + leaderboard** (opt-in, `claude-rpc profile`), with GitHub
  verification via a public gist or the web login, and machine linking so
  several installs count as one identity.
- **Live per-user images** — `/badge`, `/card`, `/heatmap` and `/stats` SVGs
  rendered from a published profile.
- **Squads** — private mini-leaderboards among friends.
- **Claude Wrapped** — the opt-in, one-shot year-in-review publish.
- **Referral counters** for the landing page.

The source lives in this repo so the privacy story is auditable: this is the
only server the project runs, and everything `claude-rpc` sends to the project
lands here. [`SECURITY.md`](../SECURITY.md) lists every outbound call the CLI
makes, including the few that go elsewhere (Anthropic's usage endpoint with
your own token, GitHub for gists).

## Routes

All 31 routes — path, params, request and response shapes, caching, CORS and
rate limits — are documented in [`docs/WORKER-API.md`](../docs/WORKER-API.md).
The router itself is the `fetch` handler at the bottom of
[`src/index.js`](src/index.js), and the file header carries a one-line map of
every route.

## Trust model

Everything here is **self-reported and best-effort**. Anyone can `POST /report`
or `POST /profile`, so the numbers are a community vanity metric, not an
audited figure. The defenses are about bounding abuse, not proving honesty:

- **Community totals** take forward *deltas* only, with per-report magnitude
  caps (`MAX_DELTA_*`). The increment is a KV read-modify-write (no atomic
  increment), so under concurrency a report can rarely be lost; treat the
  totals as approximate.
- **Profiles** *set* absolute lifetime totals per machine (not deltas) — a
  re-send is idempotent. Values are validated and clamped to plausibility
  ceilings (`MAX_PF_*`); a linked identity's displayed totals are the sum
  across its machines (streak: the max).
- **Verified profiles rank above every unverified one**, and unverified token
  counts are capped for ranking, so a fake entry can't top the board.
  Verification ties the ✓ to a real, attributable GitHub account.
- **Rate limits:** a per-IP fixed window (20 accepted requests per IP per
  minute, shared across routes) plus a one-per-minute per-instance window on
  the write routes. Which route gets which is listed in
  [`docs/WORKER-API.md`](../docs/WORKER-API.md#post-routes).

## What it stores

A single KV namespace bound as `TOTALS`. The exact key layout is an internal
detail (it is listed at the top of [`src/index.js`](src/index.js)); in short:

| Keys | What | TTL |
| ---- | ---- | --- |
| `total:counters` | the community `{sessions, tokens}` totals | none |
| `seen:<instanceId>` | last-seen `{ts, version, osFamily}` (active-install marker, refreshed at most daily) | 30 days |
| `rate:<scope>:<instanceId>`, `rate:ip:<ip>:<window>` | rate-limiter markers / counters | 60s |
| `ref:<source>` | referral count per allowlisted source | none |
| `pf:`, `handle:`, `alias:`, `board:index`, `gh:` | opt-in profiles (per-machine slices, optional per-day series), handle ownership, machine links, the leaderboard index, GitHub login links | unverified profiles 90 days, otherwise none |
| `verify:`, `pair:` | pending gist verification / one-time link codes | 1h / 10 min |
| `squad:`, `sqcode:`, `sqmember:`, `sqbase:` | squads, invite codes, membership index, weekly baselines | baselines 35 days |
| `wrapped:<id>:<year>` | published Claude Wrapped (per-machine slices + the merge) | ~14 months |

No prompts, paths, file contents, models or repos are stored. The anonymous
`/report` payload is exactly what `validateReport` accepts (see
[`docs/WORKER-API.md`](../docs/WORKER-API.md#post-routes)); the per-IP
limiter derives a short-lived KV key from `CF-Connecting-IP` purely for abuse
mitigation — it carries only a count and expires within a minute.

## Deploy

```sh
cd worker
npm ci                                       # pulls wrangler as a devDep
npx wrangler login                           # one-time OAuth (browser)
npm run kv:create                            # first deploy only: paste the returned id into wrangler.toml
npx wrangler secret put GITHUB_CLIENT_SECRET # from the GitHub OAuth app
npx wrangler secret put SESSION_SECRET       # any long random string
npm run deploy
```

Deploys are manual — nothing in CI runs `wrangler deploy`.

The secrets are set once per deployment and survive redeploys.
`GITHUB_CLIENT_ID` is public and lives in `wrangler.toml` `[vars]`, next to
`SITE_ORIGIN`; register the OAuth app's callback URL as
`https://<your-worker>.workers.dev/auth/callback`. Without the two secrets
`/auth/login` and `/auth/callback` answer `503` and Bearer sessions are
ignored (so `/auth/me` is a `401`); the CLI-facing routes still work, and the
gist checks fall back to unauthenticated GitHub API calls (a much lower GitHub
rate limit).

The CLI's default endpoint (`community.endpoint` in
[`src/default-config.js`](../src/default-config.js)) already points at the
production worker, `https://claude-rpc-totals.claude-rpc.workers.dev`. For a
deployment of your own, set `community.endpoint` in your `config.json`.

## Local dev

```sh
npx wrangler kv namespace create TOTALS --preview   # or: npm run kv:create:preview
# paste the preview_id into wrangler.toml
npx wrangler dev
```

`wrangler dev` runs the worker locally on `http://127.0.0.1:8787`. For the
web-login routes, put `GITHUB_CLIENT_SECRET` / `SESSION_SECRET` in a
`.dev.vars` file next to `wrangler.toml` (don't commit it).

## Tests

```sh
npm test        # from worker/ — or `npm --prefix worker test` from the repo root
```

- `test/index.test.js` — `/report` validation and totals, the community and
  per-user badges/cards, referrals, profiles and the leaderboard, gist
  verification, Wrapped, the heatmap/stats series.
- `test/squads.test.js` — web-login tokens and OAuth routes, squads, machine
  pairing/linking and identity merges.

Both drive the route handlers directly against an in-memory KV stub — no
wrangler, miniflare or network needed, just Node's built-in test runner. The
`npm test` script reuses the root's cross-platform runner
(`../scripts/run-tests.mjs`) instead of a shell glob, so it works on Windows
too.
