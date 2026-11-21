# Tender Desk: handoff

Status as of 21 Nov 2026, late. Hackathon: QwenWork x Hashmeta AI One-Person Company. **Demo video (max 3 min) and submission due Mon 23 Nov 2026, 23:59 SGT.** Judging: innovation 25%, feasibility 25%, QwenWork use 20%, demo presentation 15%, Hashmeta website 15%.

Tender Desk is a one-person, self-service tender advisory for Singapore SMEs. The SME owner works only in QwenWork chat: they sign up through a public intake connector, get their own connector, and then scout, price and submit briefs. A deterministic backend enforces the rules. The admin is the only human inside Tender Desk and decides in the console from facts the code computes: verify projects (with a GeBIZ cross-check), resolve conflicts, approve or decline every brief, reveal backtest outcomes.

Design: `docs/superpowers/specs/2026-11-21-tender-desk-journey-design.md`. Build plan: `docs/superpowers/plans/2026-11-21-tender-desk-journey.md`.

## Where things stand

**Branch `journey-self-service`** holds the new journey (not merged, not deployed). 223 automated tests pass. The full demo storyline passes 12 of 12 steps end to end against a local Postgres with the real GeBIZ data (`npm run site:rehearse`).

**LIVE (old version):** `https://tender-desk-bz2oc52nag4.qoder.website` still runs the pre-branch code and schema. Deploying the branch requires the production reseed below, so the two happen together, with the admin's yes.

**QwenWork:** the old Amber/Birch/intake connectors stop working after the reseed (new keys). After it, paste the new `tender-desk-intake.json` and `tender-desk-birch.json` from `.local/site/connectors/`, and reinstall the four updated skills (zips from `npm run starter-pack`).

**Hashmeta site copy:** drafted in `docs/hashmeta/site-content.md` (article, product section, Get started, promo script) by a side session; review before publishing.

## The demo (guardrails firing, backtest as proof)

Demo tender: **DST000ETT26000005** ("Event Management Services for Brainhack", DSTA). Analyst query "event management" → 57 comparables, band S$208,800–S$1,153,108.63; the real award S$309,320 lands **inside** Cedar's band (the agency-level backtest band misses: an honest-reporting moment). Seed: Birch Events (fictional, one verified project). Cedar Markets is created live through intake.

| # | Who | Beat | Rule on screen |
|---|---|---|---|
| 0 | Hashmeta site | Article + Get started (5 s) | |
| 1 | Cedar, intake chat | Register; paste-ready connector shown once | projects unverified |
| 2 | Admin | `CLI…` → `PRJ…`: GeBIZ cross-check "No match", verify one with a note; the self-reported gala stays unverified | evidence on screen |
| 3 | Cedar | Scout shortlist, labelled backtest (short) | G6 |
| 4 | Cedar | Band for DST000ETT26000005 | G4 |
| 5 | Cedar | Brief citing the gala → **blocked G3**; resubmit with the verified project → pending | G3 |
| 6 | Birch | Same band, submits → **escalated G2** "already advises another client" | G2 |
| 7 | Admin | `CON…` keep advising the holder; `BRF…` risk facts → approve | G5 |
| 8 | Cedar | "Where's my brief?" → approved brief (short) | |
| 9 | Admin | Audit log filtered to the tender; backtest reveal: S$309,320 inside the band | append-only |

Practice runs on production use up the name "Cedar Markets" (names are unique) and write permanent audit rows; practise with another name or on a branch, and reset before recording.

## Production cut-over and reset (needs the admin's explicit yes, every time)

The old `demo-baseline` Neon branch is **retired**: it predates schema 002, so restoring it would roll the schema back.

1. The admin says yes.
2. `npm run site:build` and redeploy the Sites function.
3. Wipe and reseed only the `tender_desk` schema (Neon Auth sign-in untouched):

   ```bash
   npm run site:reseed -- --db-file .local/site/db-unpooled.url --yes-wipe-tender-desk
   ```

   It prints the target host and what it is about to delete, moves the old credential files aside (`*.before-reseed-<time>`), and writes new ones plus QwenWork configs to `.local/site/connectors/`. The drop and both migrations run as one transaction (a failure leaves the old schema intact); if the seed step after it fails, re-run the same command.
4. `npm run starter-pack` → `.local/site/starter-pack/` (intake JSON + four skill zips + README) for the Hashmeta Get started section and for the admin's own QwenWork.
5. In QwenWork: paste the new intake and Birch connectors; reinstall the four skills.
6. Take the new baseline: `neon branches create --name demo-baseline-v2 --parent production`.
7. Before recording: `neon branches restore production demo-baseline-v2 --preserve-under-name production-before-reset`, then sign in again.

## Remaining work

| # | Item | Owner |
|---|---|---|
| 1 | Review and merge `journey-self-service`; production cut-over above | The admin approves, agent runs |
| 2 | QwenWork practice run of the storyline with the new skills; fix any skill-following issues | The admin, with agent debugging |
| 3 | Record the video (≤3 min, guardrails-centred) | The admin (agent drafts script/shot list on request) |
| 4 | Hashmeta site: publish the article and the Get started pack | The admin |
| 5 | Submit via the form | The admin |

## Architecture

- **Governance core** (`src/governance.mjs`, `src/governance-agent.mjs`, `db/001-governance.sql`, `db/002-journey.sql`): bearer-token identity (hashed; a supplied `client_id` is G1-blocked); **exclusive advice (G2) taken at `submit_brief`**, after G4 → G3 → G1 pass, so a blocked brief never takes the slot; pricing is open public statistics; verified-citation briefs (G3); snapshot-exact bands (G4); admin-only decisions (G5); hold-out secrecy (G6); append-only audit and snapshots; every write transactional with its audit row.
- **Self-service sign-up:** intake `create_client` issues the client's connector in the same transaction and returns a paste-ready QwenWork config once (`src/connector-config.mjs`); the token never reaches the audit log.
- **Risk facts** (`src/brief-risk.mjs`): deterministic signals stored on each brief (thin evidence, wide band, above ceiling, numbers in the text that are not band figures, no citations, thin history) and a level used only for sorting. Never returned to agents.
- **GeBIZ cross-check** (`src/gebiz-check.mjs`): exact normalised supplier-name match against the public awards; hold-out tenders are not checked until revealed. Verifying without a match needs a note.
- **Return path:** `get_client_context` returns the client's briefs with the admin's decision (approved text or decline reason) and tenders where advice was refused.
- **References** (`src/references.mjs`): `CLI/PRJ/BRF/CON/AUD` + 5 digits from Postgres sequences.
- **MCP:** `src/mcp-web.mjs` (deployed) and `src/mcp-business.mjs` (local). Tools: `get_policies`, `get_client_context`, `get_incoming_tenders`, `search_tenders`, `save_shortlist`, `request_pricing`, `submit_brief`, `create_client` (intake only). No admin tool is ever exposed.
- **Console** (`src/console-handler.mjs`, `console-view.mjs`, `console-records.mjs`, `console-css.mjs`): server-rendered, zero client JavaScript, CSP `default-src 'none'`. Grouped navigation (Decisions · Clients · Records); a page per record at its reference (`/briefs/BRF00012`, `/clients/CLI00003`, `/projects/PRJ00007`, `/conflicts/CON00002`, `/audit/AUD00042`, `/tenders/<no>`); old UUID brief links redirect; brief list filters (status, risk, sort) and audit filters (search, client, tender, rule, outcome) live in the URL; decline needs a reason; verify needs a note without a GeBIZ match; connectors can be revoked from the client page.
- **Site** (`src/site-app.mjs`, built by `npm run site:build` into `site/`): one Deno function serves console + MCP + `/health`.
- **Scripts:** `site:seed` (fresh database only), `site:reseed` (destructive, flag-guarded), `starter-pack`, `site:rehearse` (disposable databases only; refuses production).
- **Local fallback:** `npm run server -- --seed-demo` → MCP on 8788, console on 8789.

## Platform facts learned the hard way (all verified)

- Sites functions run on the Supabase edge runtime (Deno 1.45-compatible). The raw-TCP `postgres` driver times out there; use `@neondatabase/serverless` (WebSocket). Node scripts keep `postgres`.
- The Sites gateway rejects non-browser POSTs without a same-site `Origin` header; QwenWork connectors send it (it is in every generated config). The console uses `Referrer-Policy: same-origin`.
- The gateway rewrites function paths to `/app-<hash>`; route on path suffixes. It also rewrites `Cache-Control` to `private, no-store`.
- The Sites database is a restricted SQL subset; that is why Neon holds the data.
- Sites Settings secrets are write-only; the app trims stray whitespace/quotes and logs only a bad value's scheme and length.
- Neon Auth: open sign-up disabled on production; admin allowlisted by user ID.
- QwenWork installs a skill from a `SKILL.md` or a `.zip` containing it; connectors are pasted as JSON in Connectors settings.

## Secrets and credentials (paths only, never chat)

- `.env.local`, `~/.td-db-url`, `~/.td-auth-url`: Neon URLs.
- `.local/site/agent-tokens/*.txt`, `.local/site/connectors/*.json`: connector credentials and QwenWork configs (mode 0600).
- `.local/site/starter-pack/`: contains the public intake key; publish only on the Hashmeta site.
- `.local/site/admin-user-id.txt`, `.local/site/db-unpooled.url`, `rehearsal-db.url`.

## Verified versus not verified

**Verified:** 223 automated tests (wire-protocol Postgres via PGlite-socket, MCP via the official SDK, console over HTTP, both database adapters, seed/reseed/starter-pack scripts). The full storyline end to end on a local Postgres with the real dataset (12/12). The earlier live checks against the deployed site (old version).

**Not verified:** the new branch on the live site and Neon (not deployed yet). A full QwenWork agent run with the new skills. Console visuals as judged by a human. Real email delivery of a reset link.

## Decisions to know about

- SMEs are self-service subscribers; the chat is their UI. Billing is out of scope.
- The connector is issued immediately at intake and shown once; a lost connector needs the admin.
- G2 guards advice, not public numbers: anyone can get a band; only one client per tender gets Tender Desk's brief.
- Every brief needs the admin's approval; auto-release of low-risk briefs is roadmap.
- Risk and verification evidence are computed by code, never by an agent.
- Production is wiped and reseeded for the new schema (Amber retired; Birch gets a new key).
- No LLM calls in this code. Commits carry only the admin's identity.

## Known limitations

- The intake key is public: anyone can register companies; there is no rate limit.
- A refused duplicate company name hints that the company is already a client.
- A lost one-time connector needs the admin; there is no self-service reissue.
- Brief prose is not checked for meaning; risk facts are signals, not a verdict.
- Public GeBIZ data allows inference; the system does not claim to prevent every form of collusion.
- Conflicts, Clients and Projects lists have no filter forms (Briefs and Audit do).
- A warm MCP call costs ~0.8 s, a cold one ~2.4 s.
- Logout is best-effort across function instances; sessions expire after 8 h.

## Dataset

`data/GovernmentProcurementviaGeBIZ.csv` — data.gov.sg `d_acde1106003906a75c3fa052592f2fcb` (Singapore Open Data Licence). 18,464 rows, 12,052 contracts, awards 2021-04-01→2026-03-31. 11,516 historical + 536 hold-out (2026) contracts, of which the scoreable subset is what "Reveal all" counts; money in integer cents SGD. Submission form: https://survey.alibabacloud.com/uone/sg/survey/nXEUDcuj- (do not submit without the admin). Hub: https://one-person-company-hackathon-96f7yf4o51w.qoder.website/
