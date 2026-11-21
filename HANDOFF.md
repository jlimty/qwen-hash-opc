# Tender Desk: handoff

Status as of 21 Nov 2026. Hackathon: QwenWork x Hashmeta AI One-Person Company. Demo video (max 3 min) and submission due **Mon 23 Nov 2026, 23:59 SGT**.

Tender Desk is a one-person tender advisory for Singapore SMEs. QwenWork agents do the work (intake, scouting, analysis, proposals). A deterministic backend holds the data and enforces the rules. The founder alone approves briefs, verifies clients' projects and resolves pricing conflicts.

## What exists and works (local only)

113 automated tests pass (`npm test`), `npm audit --omit=dev` reports 0 vulnerabilities. Everything runs on loopback with embedded PostgreSQL (PGlite). **Nothing is deployed, hosted or committed.**

| Piece | Files | State |
|---|---|---|
| GeBIZ importer, categories, historical search, price statistics | `src/tender-data.mjs`, `src/tender-catalog.mjs`, `src/tender-stats.mjs` | Done, tested on the real CSV |
| Governance schema (Postgres, schema `tender_desk`) | `db/001-governance.sql`, `src/governance-db.mjs` | Done; audit log and price snapshots are append-only by trigger |
| Governed agent tools and founder actions | `src/governance.mjs`, `src/governance-agent.mjs` | Done, independently reviewed |
| Business MCP endpoint (agents call this) | `src/mcp-business.mjs` | Done, independently reviewed |
| Founder console (approve, resolve, verify, audit) | `src/console.mjs`, `src/console-view.mjs`, `src/console-css.mjs` | Redesigned 21 Nov as a multi-screen SaaS app: sidebar shell, Overview inbox, Briefs list + detail, Conflicts, Clients, Backtest, Audit log. No client JavaScript. |
| Backtest prediction + reveal + scoreboard | `src/backtest.mjs`, reveal in `src/governance.mjs` | Done. Founder-only reveal (per tender or all), derived from the append-only audit log, honest hit rates (47% band / 5% incumbent on the full set), filters All/Inside/Outside |
| Launcher | `scripts/tender-desk-server.mjs` | Done |
| Scripted end-to-end demo (not QwenWork) | `scripts/governance-demo.mjs` (`npm run governance:demo`) | Done |
| Connection-check skill (private QwenWork skill) | `skills/tender-desk-connection-check/SKILL.md` | Installed and verified earlier |
| QwenWork agent skills (intake, scout, analyst, proposal, marketing) | `skills/tender-desk-*/SKILL.md` | Written 21 Nov, not yet uploaded to QwenWork or exercised there |
| Product record | `PRODUCT.md` | Written |

## Hosting on Qoder Sites (in progress, 21 Nov)

Decision: host on Qoder Sites, not local. Verified with a live probe site: functions run on the Supabase edge runtime (Deno 1.45 compatible), outbound HTTPS and raw TCP are open, and `npm:` imports of zod, csv-parse and postgres load. The gateway rejects non-browser POSTs without a same-site `Origin` header, and the admin confirmed QwenWork connectors can send that header. The Sites database is too restricted for the governance schema (no triggers, transactions or row locks), so the governance data lives in an external Postgres reached over TCP.

Built and tested locally (139 tests): `src/pg-database.mjs` (Postgres adapter, same interface as PGlite), `src/console-handler.mjs` (web-standard console with signed-cookie sessions, `src/console.mjs` is now a thin Node wrapper), `src/mcp-web.mjs` (hand-rolled MCP over fetch), `src/site-app.mjs` (routing and lazy boot), `scripts/site-build.mjs` (`npm run site:build` writes `site/`), `scripts/site-seed.mjs` (`npm run site:seed`, `-- --check` to test connectivity). Tests run the real wire protocol through `@electric-sql/pglite-socket`.

Admin sign-in uses Neon Auth (managed Better Auth), not a shared secret: email and password are checked by the Neon Auth REST API (`src/neon-auth.mjs`), and only the single Neon user ID in `TD_ADMIN_USER_ID` is allowed, because Neon allows open sign-up (restricted sign-up is "coming soon"). Sessions are the Neon Auth session cookie, verified on every request and revoked at sign-out. CSRF is a double-submit cookie. The code's internal founder capability is a random value generated at boot and never stored. The local launcher still uses the secret login. Neon's own Functions, Storage, AI gateway and Realtime are not needed and stay off.

Site `Tender Desk` is prepared (project 01a1fc00-0331-71d8-8889-f9c1c96aca6d, latest draft action 3071148d-8f3f-4acf-92c2-af75d3c2bb81), host `tender-desk-bz2oc52nag4.qoder.website`, still private and unpublished. Blocked only on three values entered through Sites Settings: `TD_DB_URL`, `TD_AUTH_URL` and `TD_ADMIN_USER_ID`. The founder-token file in `.local/site/` is now only the local seeding capability, not a deployed secret.

Neon is set up (21 Nov): project `qwen-meta-opc` (`curly-surf-74518312`), branch `production`, Postgres 18 plus Neon Auth. `neon init` created `neon.ts` and `.neon` (git-ignored) and wrote `.env.local` (git-ignored) with `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL` and others; agent installs were skipped on purpose (`--no-agent-setup`). `neon deploy` changed nothing in the cloud project. The governance schema is migrated and the two fictional demo clients are seeded; connector credential files are in `.local/site/agent-tokens/`. The site's address is added as a Neon Auth trusted domain. Proof run against the real services (17 checks: TLS Postgres, row locks, append-only trigger, sign-up, sign-in, session check, refusal of a non-founder, sign-out revocation, every console screen, MCP handshake) passed.

Live (21 Nov): the site is published and public at `https://tender-desk-bz2oc52nag4.qoder.website`, latest draft action `9789a6a2-073b-4e19-920c-e14340437431`. The deployed function uses Neon's WebSocket driver (`@neondatabase/serverless`) because the raw-TCP `postgres` driver times out inside the Sites runtime; Node scripts still use `postgres`. 11 live checks passed (see the Neon memory note for the list). Admin is the original admin email, public sign-up is disabled, and a stray placeholder account you@example.com (ID 9b5651fa-7b0e-44cd-a353-c9a7e25faa2f) can be removed with `neon neon-auth user delete <id>`.

Browser sign-in bug (fixed 21 Nov): the console used `Referrer-Policy: no-referrer`, which makes browsers send `Origin: null` on same-site form posts, and the Sites gateway rejects that with `sites_gateway_origin_forbidden`. It is now `same-origin`, with a regression test. curl-based checks missed this because they set Origin by hand; `node scripts/browser-login-check.mjs <login URL>` drives real headless Chrome through the form (it cannot run against the live site, whose bot protection blocks headless browsers, so run it against a local console). The site root `/` is now an instant redirect to the console, with no landing page.

Password reset (break-glass, no email needed): `npm run site:admin-password` in a terminal. It shows which account it will change, asks for the new password twice, writes Better Auth's scrypt hash (`src/neon-password.mjs`, validated against the real Neon Auth with a throwaway user), and signs the admin out everywhere. The admin setup prompt now also asks twice; before 21 Nov it asked once, so a typo left an unknown password. The sign-in page also has a "Forgot password?" link (email reset through Neon Auth's shared email provider, sender auth@mail.myneon.app). The flow was verified against the real Neon Auth with a throwaway user, reading the token from `neon_auth.verification` instead of an inbox: request, link redirect, reset, single-use token, sign-in with the new password. Actual email delivery to the admin's inbox is unverified. Neon's "Revoke Sessions On Reset" setting is off, so a reset does not sign out other sessions (`neon neon-auth config email-password update --revoke-sessions-on-password-reset` turns it on; needs explicit approval).

Remaining: (1) the admin signs in at `https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/` with his Neon password (not testable by the agent); (2) the admin updates QwenWork connectors to `https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/mcp` with the credential from `.local/site/agent-tokens/*.txt` as `Authorization` plus an `Origin: https://tender-desk-bz2oc52nag4.qoder.website` header; (3) upload the agent skills from `skills/` to QwenWork and run the demo journey; (4) delete the probe site `tender-desk-probe` and the `sites-probe/` folder. Secret values pasted into Settings are trimmed and validated; wrong values log only the scheme and length. Each MCP call costs about 1 s of database round trips on a warm instance.

## Run it

```bash
cd <local-path>
npm install
npm test
npm run server -- --seed-demo     # first run only; creates fictional clients and credential files
npm run server                    # later runs reuse the saved state
```

- MCP endpoint: `http://127.0.0.1:8788/mcp` (`TENDER_DESK_PORT`)
- Founder console: `http://127.0.0.1:8789/` (`TENDER_DESK_CONSOLE_PORT`)
- State folder: `.local/` (git-ignored; override with `TENDER_DESK_STATE_DIR`)

Do not delete `.local/db` without also deleting `.local/agent-tokens/`; the seed refuses to run over existing credential files.

### Secrets (never paste these into chat; paths only)

- `.local/founder-token.txt`: the founder console login secret (64 hex characters, mode 0600). Copy it with `pbcopy < .local/founder-token.txt`, paste into the console's login form.
- `.local/agent-tokens/{amber,birch,intake}.txt`: one `Bearer ...` credential per QwenWork connector (mode 0600). Copy each with `pbcopy < <file>`.
- `.local/mcp-authorization.txt`: credential for the old connection-check probe only (`npm run mcp:smoke`, port 8787).

### Connect QwenWork

Extensions → Connectors → Add → Streamable HTTP. Create one connector per credential, for example `tender-desk-amber` and `tender-desk-birch`, URL `http://127.0.0.1:8788/mcp`, header `Authorization` set to the file's contents. Each connector acts as exactly one client; the credential decides which. The founder secret is never accepted by the MCP endpoint.

Agent tools: `get_policies`, `get_client_context`, `get_incoming_tenders`, `search_tenders`, `save_shortlist`, `request_pricing`, `submit_brief` (and `create_client` for the intake credential). No founder tool is exposed to agents.

## The rules enforced in code

- **Identity:** the client comes from the stored, hashed credential, never from tool input. A supplied `client_id` is blocked (G1) and audited.
- **Exclusive pricing (G2):** the first client to call `request_pricing` on a tender holds it. A competitor is escalated, gets no price and no holder identity, and the founder decides: keep serving the holder, or stop pricing that tender. Advice already given is never transferred.
- **Verified credentials (G3):** briefs may cite only that client's founder-verified projects. Intake records every project as unverified.
- **Grounded numbers (G4):** the price band must exactly match a saved snapshot for that client and tender. Prose numbers are only flagged, not proven.
- **Founder approval (G5):** agents can only submit pending briefs. Approval re-checks the hold and the citations.
- **Hold-out secrecy (G6):** 2026 awards are shown to agents as "incoming" backtest tenders with no winner or amount.
- **Audit:** every action, allowed or blocked, is written in the same transaction as the change. Failed sign-ins are aggregated to one row a minute.

## Verified versus not verified

Verified by automated tests: all of the above, over real HTTP with the official MCP SDK client, plus restart persistence and rollback when an audit write fails. The console was also screenshot-checked at 1440px and 390px.

**Not verified:**
- The new business endpoint has not been called from QwenWork itself yet. The earlier connection-check probe and skill were verified from QwenWork.
- Hosted HTTPS (Vercel) compatibility with the QwenWork connector. Deferred by you.
- Concurrency on a real Postgres. PGlite serialises transactions, so the "one holder wins" test shows the logic, not behaviour under load.
- The redesigned console was screenshot-checked at 1440px and 390px and passed the Impeccable design detector, but this session's agent could not view images (no vision), so no human eyes have seen the redesign yet. Screenshots for review: `.impeccable/review/` (overview, briefs, brief, conflicts, clients, backtest, audit, login, mobile). The console has not been clicked through in a live browser by a person.

## Not built yet (in rough priority order)

1. **QwenWork agent skills:** written in `skills/` but need uploading to QwenWork and a real end-to-end run (intake → scout → analyst → brief → conflict → approval → backtest reveal). Marketing skill consumes `npm run data:report -- --category <cat>` output pasted into chat.
3. **Hashmeta marketing site** (15% of judging). Built by the admin in the Hashmeta AI Website Builder, not by code here. Needs data articles from `market_stats`-style output.
4. **Demo video** (max 3 minutes, made with QwenWork). Suggested flow: article, intake, shortlist, brief appears in console, second client escalated, unverified project blocked, founder resolves, audit log, backtest reveal.
5. **Hosting** (optional for the deadline): needs a fetch-style MCP handler, a real shared Postgres adapter replacing PGlite, a stored founder secret, TLS, rate limiting, and the real hostname in the Host/Origin allow-list.
6. **Client portal** `/c/[token]` and policies page (design doc "Should").
7. **Git:** the repository has no commits. Nothing has been committed or pushed.

## Decisions to know about

- **Stack:** the founder console is plain server-rendered Node with no client JavaScript, because the embedded database can only be opened by one process. Next.js on Vercel (original plan) is deferred until a hosted Postgres adapter exists; the console's render functions port over with mostly view changes. You asked about the tradeoffs and did not object.
- **No LLM calls in this code.** All reasoning and writing happens in QwenWork.
- **Taxonomy:** categories are ordered keyword rules (`keywords-v1`); the exclusive counts differ from the draft's overlapping estimates.
- **Zero citations allowed:** a brief may cite no projects (for example a no-bid). Cited projects must be verified.
- **Console design:** built from a generated mock-up (`vibe_images/founder-console-comp_*.png`). Light ledger-style surface, one accent colour, status colours reserved for guardrail outcomes.
- `.impeccable/config.json` records `buildPath: comp`. `PRODUCT.md` records the product facts for design work.
- **Console redesign direction (21 Nov):** app shell with separate screens, chosen by the admin; references Stripe Dashboard + Attio. Cool-grey sidebar, white work surface, one cobalt accent (#2457D6), status colours only for guardrail outcomes, system font stack, no shadows/gradients. Design comps in `vibe_images/td-overview-comp_*.png` and `vibe_images/td-backtest-comp_*.png`.

## Known limitations

- Prose in briefs is not semantically checked; the founder reads it. The console says so.
- Public historical data allows inference; the system does not claim to prevent every form of collusion.
- Two launchers pointed at the same state folder are not locked against each other.
- Seeding that stops partway needs `.local/db` and `.local/agent-tokens` deleted together before retrying.
- Bad tool arguments return a slightly verbose protocol error.
- Console login is a single shared secret with a global throttle (5 failures a minute); fine for local use only.

## Dataset

`data/GovernmentProcurementviaGeBIZ.csv`, data.gov.sg dataset `d_acde1106003906a75c3fa052592f2fcb` (Singapore Open Data Licence). 18,464 rows, 12,052 contracts, awards 2021-04-01 to 2026-03-31, SHA-256 `cff64371cb6d84348fb05f23068e9287a8bba6d7e7cb049c10226dc7f6afa30e`. 11,516 historical contracts and 536 hold-out contracts (2026 awards). All money is integer cents in SGD.

## Housekeeping

- The environment prints `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental` on every Node command. It is not an application error.
- Test and detector scratch files are in `/tmp` and outside the repo. `vibe_images/` contains the generated console mock-up and can be deleted or kept.
- The design draft this started from is at `<local-path>`.
- A newer Impeccable skill (v4.10.0) is available; not updated this session.
