# Tender Desk: handoff

Status as of 21 Nov 2026, evening. Hackathon: QwenWork x Hashmeta AI One-Person Company. **Demo video (max 3 min) and submission due Mon 23 Nov 2026, 23:59 SGT.** Judging: innovation 25%, feasibility 25%, QwenWork use 20%, demo presentation 15%, Hashmeta website 15%.

Tender Desk is a one-person tender advisory for Singapore SMEs. QwenWork agents do the work (intake, scouting, analysis, proposals) through a governed MCP endpoint. A deterministic backend enforces the rules; the admin alone approves briefs, verifies projects, resolves pricing conflicts and reveals backtest outcomes.

## Where things stand

**LIVE:** `https://tender-desk-bz2oc52nag4.qoder.website` (public; the root redirects straight to the console). Admin: the original admin email, signed in successfully. Hosted on Qoder Sites (Deno function) with Neon Postgres and Neon Auth.

**QwenWork:** three connectors imported from JSON config (`tender-desk-amber`, `-birch`, `-intake`, all verified live: correct tool sets per role) and the five skills imported (intake, scout, analyst, proposal, marketing). **Not yet exercised end-to-end by QwenWork agents** — that practice run is the next step.

**Code:** 167 automated tests pass, `npm audit --omit=dev` clean, two local commits (`dc650d6`, `70848f7`), **no remote push** (GitHub is optional for the submission).

**Demo state:** production's demo beats were spent by console exploration at 05:40 UTC (roadshow project verified; "Reveal all 512" clicked — irreversible by design). A pristine snapshot exists; reset before recording (below).

## The demo (guardrails firing, backtest as proof)

Demo tender: **DST000ETT26000005** ("Event Management Services for Brainhack", DSTA). Analyst query "event management" → 57 comparables, band S$208,800–S$1,153,109; real award S$309,320 lands **inside** (the agency-level backtest band narrowly misses — a good honest-reporting moment). Amber and Birch are both events companies, so both shortlist it and the G2 conflict happens naturally.

Storyline for the recording: article (Hashmeta) → intake (Cedar Markets, fictional) → scout shortlist → Amber prices and submits a brief → Birch hits the same tender → **escalated G2** → brief citing an unverified project → **blocked G3** → admin verifies, resolves, approves → audit log → backtest reveal.

Practice-run prompts (one chat per step, connector noted) were given to the admin on 21 Nov; they are reproduced in git history if needed. The scripted rehearsal covers the same ground: `npm run site:rehearse -- --db-file .local/site/rehearsal-db.url --yes-this-is-disposable` — 15 of 15 steps passed on a clean branch. It refuses to run without the disposable flag and refuses the production database.

### Reset production before recording (needs the admin's explicit yes, every time)

Every QwenWork practice run leaves permanent audit rows, and reveals cannot be undone. Neon branch `demo-baseline` holds production exactly as of 21 Nov 05:39:30 UTC (14 audit rows, no reveal, roadshow unverified, admin present, stray `you@example.com` account present). Does not expire.

```bash
neon branches restore production demo-baseline --preserve-under-name production-before-reset
```

Afterwards: sign in again (the rewind includes `neon_auth`), delete the stray account again (`neon neon-auth user delete 9b5651fa-7b0e-44cd-a353-c9a7e25faa2f`), and expect the audit log to start from row 14.

## Remaining work

| # | Item | Owner |
|---|---|---|
| 1 | QwenWork practice run through the storyline (prompts already drafted); fix any skill-following issues | The admin, with agent debugging |
| 2 | Approve + run the production reset just before recording | The admin approves, agent runs |
| 3 | Record the video — QwenWork-made, ≤3 min, guardrails-centred | The admin (agent drafts script/shot list on request) |
| 4 | Hashmeta site (15%): data article from `npm run data:report -- --category events-community`; marketing skill turns that JSON into the article/promo script | The admin builds; agent drafts content |
| 5 | Submit via the form (YouTube link, title, one-sentence description, project description) | The admin |
| 6 | Optional: push the repo to GitHub; delete the stray `you@example.com` Neon account | The admin decides |

## Architecture

- **Governance core** (`src/governance.mjs`, `src/governance-agent.mjs`, `db/001-governance.sql`): bearer-token identity (hashed credentials; a supplied `client_id` is G1-blocked), exclusive pricing holds (G2, one holder wins, escalation reveals neither price nor holder), verified-citation briefs (G3), snapshot-exact price bands (G4), admin-only decisions (G5), hold-out secrecy (G6, no winner/amount until revealed), append-only audit and snapshots (Postgres triggers), every write transactional with its audit row.
- **MCP** for agents: `src/mcp-web.mjs` (fetch-native, deployed) and `src/mcp-business.mjs` (SDK-based, local). Tools: `get_policies`, `get_client_context`, `get_incoming_tenders`, `search_tenders`, `save_shortlist`, `request_pricing`, `submit_brief`, `create_client` (intake only). No admin tool is ever exposed to agents.
- **Console** (`src/console-handler.mjs` + `console-view.mjs` + `console-css.mjs`): server-rendered, zero client JavaScript, CSP `default-src 'none'`, screens: Overview inbox, Briefs + detail, Conflicts, Clients, Backtest (rates + filters + reveal), Audit log. Admin sign-in via Neon Auth email/password allowlisted by user ID (`TD_ADMIN_USER_ID`); CSRF double-submit cookie; "Forgot password?" email reset through Neon Auth.
- **Site** (`src/site-app.mjs`, built by `npm run site:build` into `site/`): one Deno function serves console + MCP + `/health`; root `/` is an instant redirect to the console. Seeds/migrates with `npm run site:seed` (`-- --check` first). Admin setup: `npm run site:admin -- --email <email>`; break-glass password reset: `npm run site:admin-password` (asks twice, signs out all sessions).
- **Local fallback** (works offline, used for early testing): `npm run server -- --seed-demo` → MCP on 8788, console on 8789, secret-file login. Keep as the recording fallback if the hosted site has issues.

## Platform facts learned the hard way (all verified)

- Sites functions run on the Supabase edge runtime (Deno 1.45-compatible). The **raw-TCP `postgres` driver times out** there; use `@neondatabase/serverless` (WebSocket) — `createPoolDatabase` in `src/pg-database.mjs`. Node scripts keep `postgres`.
- The Sites gateway rejects non-browser POSTs without a same-site `Origin` header (`sites_gateway_origin_forbidden`); QwenWork connectors can send it. Browsers send `Origin: null` under `Referrer-Policy: no-referrer` — the console uses `same-origin` (this bug broke live sign-in; regression-tested). `curl` with hand-set headers misses both classes of bug.
- The gateway rewrites function paths to a physical name (`/app-<hash>`); route on path suffixes. It also rewrites `Cache-Control` to `private, no-store`.
- The Sites database is a restricted SQL subset (no triggers/transactions/row locks) — unfit for the governance schema; that's why Neon holds the data.
- Sites Settings secrets are write-only; the app trims stray whitespace/quotes and logs only a bad value's scheme and length, never the value.
- Real-browser form testing: `node scripts/browser-login-check.mjs <login-url>` (headless Chrome via CDP; works locally only — the live site blocks automated browsers, which is correct behaviour).
- Neon Auth (managed Better Auth): open sign-up is **disabled** on production (verified HTTP 400); the site origin is a trusted domain; password hashes are scrypt `salt:key` (`src/neon-password.mjs`, validated against the real service). "Revoke Sessions On Reset" is off; enabling it needs the admin's approval.

## Secrets and credentials (paths only, never chat)

- `.env.local` — Neon URLs (from `neon init`; git-ignored). `~/.td-db-url`, `~/.td-auth-url` — copies for scripts.
- `.local/site/agent-tokens/{amber,birch,intake}.txt` — connector credentials (`Bearer …`, mode 0600).
- `.local/site/connectors/*.json` — QwenWork import configs with real tokens (mode 600).
- `.local/site/admin-user-id.txt` — the admin's Neon user ID `00000000-0000-4000-8000-000000000001` (the original admin email). `.local/site/db-unpooled.url`, `rehearsal-db.url`, `baseline-db.url` — connection strings (unpooled; rehearsal; demo-baseline).
- `.local/founder-token.txt` and `.local/agent-tokens/` — the LOCAL launcher's credentials (fallback mode only).

## Verified versus not verified

**Verified:** 167 automated tests (wire-protocol Postgres via PGlite-socket, MCP via the official SDK, console over HTTP, both database adapters). 17 checks against real Neon from Node. 11→8 live checks against the deployed site (health, login page, wrong password refused by real Neon Auth, session walls, MCP handshake with correct role tools, hold-out secrecy, spoofed `client_id` blocked, real DB write, 401s, sign-up closed). Forgot-password flow against real Neon Auth with a throwaway user. Rehearsal 15/15 on a branch.

**Not verified:** a full QwenWork agent run against the live connectors (connectors and tool catalogs are verified; skill-following is not). Real email delivery of a reset link to the admin's inbox. Console visuals as judged by a human (agent has no vision; screenshots in `.impeccable/review/`). Cold-start and CPU limits under load. Concurrency on Neon under contention (row-lock logic is tested; heavy parallel load is not).

## Decisions to know about

- Hosted on Qoder Sites + Neon (Vercel plan superseded); local launcher kept as recording fallback.
- Admin auth is Neon Auth allowlisted by user ID — email allowlisting is unsafe while any stranger can register an address; sign-up is disabled anyway.
- The admin role is called "admin", not "founder", in UI copy and config; internal function names still say founder.
- No LLM calls in this code — all reasoning happens in QwenWork.
- "Reveal all" requires a confirmation page and is recorded in the audit log; a reveal is forever (the scoreboard is honest, not re-runnable).
- Console design: Stripe Dashboard × Attio direction, cobalt accent, status colours only for guardrail outcomes; comps in `vibe_images/`.

## Known limitations

- Prose in briefs is not semantically checked (the admin reads it; the console says so).
- Public GeBIZ data allows inference; the system does not claim to prevent every form of collusion.
- A warm MCP call costs ~0.8 s, a cold one ~2.4 s; several calls per demo step are normal.
- Logout is best-effort across function instances; sessions expire after 8 h regardless.
- Two local launchers on one state folder are not locked against each other; a partway local seed needs `.local/db` and `.local/agent-tokens` removed together.
- `[UNDICI-EHPA] … experimental` warnings on every Node command are environment noise, not app errors.

## Dataset

`data/GovernmentProcurementviaGeBIZ.csv` — data.gov.sg `d_acde1106003906a75c3fa052592f2fcb` (Singapore Open Data Licence). 18,464 rows, 12,052 contracts, awards 2021-04-01→2026-03-31, SHA-256 `cff64371…faf30e`. 11,516 historical + 536 hold-out (2026) contracts; money in integer cents SGD. Submission form: https://survey.alibabacloud.com/uone/sg/survey/nXEUDcuj- (do not submit without the admin). Hub: https://one-person-company-hackathon-96f7yf4o51w.qoder.website/
