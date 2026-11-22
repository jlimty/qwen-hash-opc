# Tender Desk AI Tender Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a web-based AI tender assistant for Singapore SMEs. It offers:
- live GeBIZ open tenders and a free instant price check
- paid reviewed briefs: S$99, with a mock checkout, drafted by AI and approved by the admin in the console

It runs on the existing Qoder Sites function and Neon database.

**Architecture:** A new customer web app is served by the same Deno function under `/functions/v1/app/assistant/*`, next to the console and MCP. Like the console, it is server-rendered with no client JS.

New pure modules handle:
- the GeBIZ RSS feeds
- OpenRouter calls
- reading a tender into search terms
- price checks and fit facts
- brief drafting

The governance core (`createTenderDesk`) gains `customer` and `registerCustomer` entry points and four founder operations. All writes stay transactional with their audit row. The existing `submit_brief` workflow is reused to save drafts, so every guardrail still applies.

**Tech Stack:**
- Node ≥22 ESM (`.mjs`) for source and tests (`node --test`, PGlite)
- Deno edge runtime in production (built by `npm run site:build`)
- Postgres (Neon), zod 4, Neon Auth (Better Auth endpoints)
- OpenRouter chat completions with JSON-schema output

**Spec:** `docs/superpowers/specs/2026-11-22-tender-assistant-design.md` (approved 22 Nov 2026). Read it before starting any task.

## Global Constraints

- **Deadline:** working in production by Mon 23 Nov 2026, 23:59 SGT. The ship bar is the spec's "Definition of done" steps 1–8, plus a public Hashmeta site with no QwenWork, skills or starter-pack content.
- **Money:** always integer cents in SGD. The brief price is `9900`.
- **Payment status:** every payment is saved with `status = 'test'`. The checkout banner reads exactly: `Test mode: no card is charged`.
- **Figures:** every figure a customer sees comes from code (`buildStatsSnapshot`). Never show a win probability or a "winning price". Every price check shows the limits line: `Past awards from April 2021 to March 2026. Not a quote, and not a winning price. GeBIZ publishes winning amounts only.`
- **Client walls:** a customer never sees another client's data or learns who holds a tender. The refusal text is exactly: `Tender Desk already advises a client on this tender.`
- **Human approval:** a brief reaches a customer only after `reviewBrief(... 'approved')`.
- **Server-rendered pages:** no client JavaScript. Pages use the console's CSP (`default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`) and the console's visual system (`src/console-css.mjs`).
- **Secrets:**
  - `TD_OPENROUTER_KEY` is required for AI. Optional: `TD_MODEL_READ` (default `qwen/qwen3.7-flash`) and `TD_MODEL_DRAFT` (default `qwen/qwen3.7-plus`).
  - Never log or audit keys, tokens or passwords.
- **Live tender data:** only the official GeBIZ RSS feeds. Never fetch GeBIZ detail pages.
- **Production:** never wiped. Migration `003` is applied in place, and the admin approves the cut-over.
- **Commits:** as the admin only, with no Claude co-author trailer (user memory). Work on branch `tender-assistant`, not `main`.

## Review Focus

1. **GeBIZ slow, down, or answering an unknown feed with an HTML "Page not found" at status 200.** The page still renders from the database, shows "Tenders last updated <time>", and other feeds still load. (Task 2)
2. **Pasted text that is gibberish, very long, or matches fewer than 5 awards.** The customer gets an honest "too few comparable awards" state with the terms shown. It never errors, and text over 4000 characters is cut with a notice. (Tasks 3, 4)
3. **Checkout submitted twice** (double click, back then resubmit). This creates one request and one payment. (Task 5)
4. **A customer session cookie presented to the console, or an admin session presented to the assistant.** Both are rejected. (Tasks 7, 8)
5. **A tender whose closing date has passed.** It can't be requested, and the console flags it as `closed` on the request. (Tasks 5, 9)

---

### Task 0: Hashmeta site-update instructions (do first, so the admin can pass them on)

**Files:**
- Create: `docs/hashmeta/site-update-instructions.md`
- Modify: `docs/hashmeta/site-content.md` (sections 2, 3, 4)

**Interfaces:** none (copy only). The app URL is `https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/assistant`.

- [ ] **Step 1: Rewrite sections 2–4 of `site-content.md` around the assistant.**
  - **Section 1 (data article):** keep it unchanged. Its CTA becomes `[Try a free price check →](<app URL>)`.
  - **Section 2 (product):** the free instant check (any tender, no account); the S$99 reviewed brief (bid/no-bid with a suggested price position, approved by a person); the rules table, reworded for customers. Drop every mention of QwenWork, skills and connectors.
  - **Section 3 (`Get started`):** three short items:
    1. Try a free price check (link).
    2. Create an account and add your past projects (link to `/assistant/signup`).
    3. Ask for a reviewed brief on any open tender.

    Also include the line `Payments are in test mode while we launch: no card is charged.`
  - **Section 4 (promo script):** the last row ends on "Paste any tender, see what similar contracts were awarded for. Free." with on-screen text `Try a free price check`.
- [ ] **Step 2: Write `site-update-instructions.md` for a Qoder agent with no other context.** It should cover:
  - the site URL `https://tenderdesk.geo.hashmeta.tech`
  - for each section, the exact block to replace and its full new copy (taken from `site-content.md`)
  - to remove: every QwenWork, skill, connector and starter-pack mention, and the media files `tender-desk-intake.zip`, `tender-desk-scout.zip`, `tender-desk-analyst.zip`, `tender-desk-proposal.zip` and `tender-desk-intake.json` (both the links and the files in the media library)
  - a final checklist: page search for "QwenWork", "skill", "connector" and ".zip" returns nothing, and every new link opens the app
- [ ] **Step 3: Check it.** Run `grep -inE "qwenwork|skill|connector|\.zip|\.json" docs/hashmeta/site-content.md`. Expected: matches only in the instructions' removal list, not in the site copy.
- [ ] **Step 4: Commit.** `git add docs/hashmeta && git commit -m "Rewrite the Hashmeta copy around the tender assistant and add Qoder update instructions"`

---

### Task 1: Migration 003 and keeping live tender numbers in the audit log

**Files:**
- Create: `db/003-assistant.sql`
- Modify: `src/governance-db.mjs` (register 003), `src/governance.mjs` (the `record()` tender filter)
- Test: `test/governance-schema.test.mjs`, `test/governance.test.mjs`

**Interfaces:**
- Produces these tables, all in schema `tender_desk`:
  - **`open_tenders`:**
    - `tender_no text PK`, `title text NOT NULL`, `agency text NOT NULL`
    - `published_on date`, `closes_at timestamptz`
    - `gebiz_url text NOT NULL`, `source_feed text NOT NULL`, `category text NOT NULL`
    - `terms text[]` (nullable until read)
    - `first_seen timestamptz NOT NULL DEFAULT now()`, `last_seen timestamptz NOT NULL DEFAULT now()`
  - **`feed_state`:** `id int PK CHECK (id = 1)`, `refreshed_at timestamptz`
  - **`customers`:** `user_id text PK CHECK (user_id ~ '^[A-Za-z0-9_-]{8,64}$')`, `client_id uuid NOT NULL UNIQUE REFERENCES clients(id)`, `created_at timestamptz NOT NULL DEFAULT now()`
  - **`brief_requests`:**
    - `id uuid PK DEFAULT gen_random_uuid()`, `reference_number bigint` (sequence `request_ref_seq`, reference prefix `REQ`)
    - `client_id uuid NOT NULL REFERENCES clients(id)`, `tender_no text NOT NULL`
    - `source text NOT NULL CHECK (source IN ('feed','pasted'))`
    - `title text NOT NULL`, `agency text`, `pasted_text text CHECK (length(pasted_text) <= 4000)`
    - `terms text[] NOT NULL`, `stat_id text NOT NULL`
    - `status text NOT NULL CHECK (status IN ('requested','drafted','approved','declined','cancelled'))`
    - `brief_id uuid REFERENCES briefs(id)`, `last_error text`
    - `created_at` and `updated_at timestamptz NOT NULL DEFAULT now()`
    - a partial unique index on `(client_id, tender_no)` WHERE `status IN ('requested','drafted')`
  - **`payments`:**
    - `id uuid PK`, `request_id uuid NOT NULL UNIQUE REFERENCES brief_requests(id)`
    - `amount_cents bigint NOT NULL CHECK (amount_cents > 0)`, `currency text NOT NULL DEFAULT 'SGD'`
    - `status text NOT NULL CHECK (status IN ('test','paid','refunded'))`
    - `created_at timestamptz NOT NULL DEFAULT now()`
- `governance-db.mjs`: add `{ file: '003-assistant.sql', present: "SELECT to_regclass('tender_desk.brief_requests') IS NOT NULL AS present" }`.
- `record()` keeps `tender_no` when `tenderNumbers.has(t) || /^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/.test(t)`, otherwise `null`. Add `request_id`, `request_reference` and `payment_status` to the summary keys.
- `references.mjs`: add the `REQ` prefix wherever `CLI/PRJ/BRF/CON/AUD` are listed.

- [ ] **Step 1: Write the failing tests.**
  - `governance-schema.test.mjs › 'migration 003 creates the assistant tables and keeps 001-002 data'`: create a client on a 001+002 database, run `initializeGovernance` again, and assert that the five tables exist and the client row is still there.
  - `governance.test.mjs › 'audit keeps a live GeBIZ tender number that is not in the dataset'`: call `founder.revealBacktest({ tender_no: 'RPO000ETQ26000129' })`, which is blocked G6, and assert that the newest audit row has `tender_no === 'RPO000ETQ26000129'`.
  - `'a second active request for the same client and tender violates the partial unique index'`: two raw inserts; the second throws code `23505`.
- [ ] **Step 2: Run them.** `node --test test/governance-schema.test.mjs test/governance.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Write `db/003-assistant.sql`** (wrapped in `BEGIN; … COMMIT;`, ending with `REVOKE ALL ON ALL SEQUENCES IN SCHEMA tender_desk FROM PUBLIC;`), then register it and change `record()` and `references.mjs`.
- [ ] **Step 4: Run the whole suite.** `npm test`. Expected: all pass, including the 227 existing tests.
- [ ] **Step 5: Commit.** `git commit -am "Add migration 003 for the tender assistant and keep live tender numbers in the audit log"` (`git add db/003-assistant.sql` first).

---

### Task 2: GeBIZ open-tender feeds

**Files:**
- Create: `src/gebiz-feed.mjs`
- Test: `test/gebiz-feed.test.mjs`, with fixture `test/fixtures/gebiz-professional.xml` (copy of the real feed fetched 22 Nov, at `<local-path>`; re-fetch it if that is gone)

**Interfaces:**
- **`export const feeds`:** a frozen array of `{ name, url, category }`. Start with these, confirmed live on 22 Nov:

  | Feed | URL path | Category |
  |---|---|---|
  | Event Organising | `Event_Organising` | `events-community` |
  | Catering Services | `Catering_Services` | `catering` |
  | Cleaning Services | `Cleaning_Services` | `cleaning-facilities` |
  | Security Services | `Security_Services` | `security` |
  | IT Services & Software Development | `IT_Services_%26_Software_Development` | `ict-services` |
  | Courses | `Courses` | `training-consultancy` |
  | General Building & Minor Construction Works | `General_Building_%26_Minor_Construction_Works` | `construction-renovation` |
  | Professional Services | `Professional_Services` | `other` |

  Every URL is `https://www.gebiz.gov.sg/rss/<path>-CREATE_BO_FEED.xml`.
- **`export function parseFeed(xml: string, feed) -> Array<{ tender_no, title, agency, published_on, closes_at, gebiz_url, source_feed, category }>`.**
  - Throw `Error('not a GeBIZ feed')` when the body has no `<rss`.
  - Parse each `<item>` with regexes (there is no XML library in Deno or Node core). Decode `&amp; &lt; &gt; &quot; &#39;`.
  - From the description `ITQ: X | Published Date: 20/11/2026 | Closing Date: 04/12/2026 13:00:00 | Calling Entity: Y |`, take: tender_no = X (after the first `: `); `published_on` as an ISO date; `closes_at` as ISO in `+08:00`; agency = Y.
  - Skip items with a missing tender number.
- **`export async function refreshOpenTenders(database, { fetchImpl = fetch, now = new Date(), maxAgeMs = 3600000, timeoutMs = 4000 }) -> { refreshed: boolean, feeds: Array<{ name, ok, count, error? }> }`.**
  - In one transaction: `SELECT pg_try_advisory_xact_lock(hashtext('td_feed_refresh'))`; return `{ refreshed:false }` if the lock is taken, or if `feed_state.refreshed_at` is newer than `maxAgeMs`.
  - Otherwise fetch every feed in parallel, each with `AbortSignal.timeout(timeoutMs)`.
  - Upsert rows: on conflict update title, agency, dates and `last_seen`, and keep `terms`.
  - Set `feed_state.refreshed_at = now`.
  - A failing feed is recorded in the result and never throws.
- **`export async function listOpenTenders(database, { categories?: string[], now = new Date(), limit = 50 }) -> rows`:** returns rows with `closes_at > now`, ordered by `published_on DESC, tender_no`.

- [ ] **Step 1: Write the failing tests.**
  - `'parseFeed reads the real Professional Services feed'`: the fixture gives 8 items. The first item has `tender_no 'RPO000ETQ26000129'`, `agency 'Republic Polytechnic'`, `closes_at '2026-12-04T13:00:00+08:00'`, `published_on '2026-11-20'`, and its `gebiz_url` starts with `https://www.gebiz.gov.sg/ptn/opportunity/`.
  - `'parseFeed rejects the HTML Page not found body'`: input `'<!DOCTYPE html><title>GeBIZ | Page not found</title>'` throws `/not a GeBIZ feed/`.
  - `'refreshOpenTenders isolates a failing feed and keeps terms on upsert'`: on PGlite with 003, give a `fetchImpl` that returns the fixture for one URL, the HTML body for another, and rejects for the rest. Assert `refreshed === true`, one feed `ok` with `count 8`, the others `ok:false`, and 8 rows. Set `terms` on one row and refresh again with `maxAgeMs: 0`; the terms are kept.
  - `'refreshOpenTenders skips when fresh'`: a second call with the default `maxAgeMs` returns `{ refreshed:false }` and makes no fetch.
  - `'listOpenTenders hides closed tenders'`: with `now` after 4 Dec 2026 14:00 SGT, `RPO000ETQ26000129` is absent.
- [ ] **Step 2: Run** `node --test test/gebiz-feed.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/gebiz-feed.mjs` to the interfaces above.
- [ ] **Step 4: Run** `node --test test/gebiz-feed.test.mjs`. Expected: PASS.
- [ ] **Step 5: Live smoke (manual, one time).** Run `node -e "import('./src/gebiz-feed.mjs').then(async m=>{for(const f of m.feeds){const r=await fetch(f.url);const t=await r.text();try{console.log(f.name,m.parseFeed(t,f).length)}catch(e){console.log(f.name,'FAIL',e.message)}}})"`. Expected: every feed prints a count. Remove any feed that prints FAIL, and note it in the commit message.
- [ ] **Step 6: Commit.** `git add src/gebiz-feed.mjs test/gebiz-feed.test.mjs test/fixtures && git commit -m "Read GeBIZ open tenders from the official RSS feeds"`

---

### Task 3: OpenRouter client and reading a tender

**Files:**
- Create: `src/openrouter.mjs`, `src/tender-reading.mjs`
- Test: `test/openrouter.test.mjs`, `test/tender-reading.test.mjs`

**Interfaces:**
- **`export function createOpenRouterLlm({ apiKey, fetchImpl = fetch, timeoutMs = 25000, referer }) -> llm`**, where `llm = async ({ model, system, user, jsonSchema, name }) -> object`.
  - POST `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer <key>`, plus `HTTP-Referer: referer` and `X-Title: Tender Desk` when given.
  - Body: `{ model, messages:[{role:'system',content:system},{role:'user',content:user}], response_format:{ type:'json_schema', json_schema:{ name, strict:true, schema: jsonSchema } }, temperature: 0.2 }`.
  - Parse `choices[0].message.content` as JSON. Retry once on a 5xx, timeout or JSON parse failure.
  - Throw `Error('model unavailable')` otherwise. The error message never includes the key.
- **`export const readingSchema`:** a zod object `{ terms: string[1..3] (each 2–40 chars, letters/digits/spaces), category: enum(tenderCategories), agency: string|null }`.
- **`export function keywordTerms(text) -> { terms, category, agency: null }`:**
  - category from the existing `categoryRules` (export them from `tender-data.mjs` if needed)
  - terms: the first 2 tokens of length ≥4 that are not stopwords (`provision, services, service, supply, tender, quotation, invitation, period, years, option, extend, another, with, from, that, this, the, and, for`)
- **`export async function readTender({ title, text = '', agency }, { llm, model }) -> { terms, category, agency, source: 'model'|'keywords' }`.**
  - Cut input to 4000 characters.
  - Call `llm` and validate with `readingSchema`. On any throw or validation failure, return `keywordTerms(title + ' ' + text)` with `source: 'keywords'`.
  - With `llm` undefined, always use keywords.

- [ ] **Step 1: Write the failing tests.**
  - `openrouter`: a fake `fetchImpl` records the request. Assert the URL, the `Authorization` header and `response_format.type === 'json_schema'`, and that the parsed content is returned. A 500 then 200 returns content after 2 calls. Two 500s throw `/model unavailable/`, and the message doesn't contain the key.
  - `tender-reading`:
    - `'model output is validated and used'`: the fake llm returns `{terms:['exhibition design'],category:'events-community',agency:null}` → `source 'model'`.
    - `'invalid model output falls back to keywords'`: the fake returns `{terms:[],category:'nope'}` → `source 'keywords'`, and terms is non-empty for the title `'Conceptualisation & Production of School Corporate Video Clips'`.
    - `'gibberish and 10k-char input never throws'`: `readTender({title:'zzzz '.repeat(2500)}, {})` resolves with `source 'keywords'`.
- [ ] **Step 2: Run** `node --test test/openrouter.test.mjs test/tender-reading.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. The JSON schema for `readingSchema` comes from `z.toJSONSchema(readingSchema)` (the same call `mcp-business.mjs` uses).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/openrouter.mjs src/tender-reading.mjs test/openrouter.test.mjs test/tender-reading.test.mjs && git commit -m "Call Qwen through OpenRouter and read tenders into search terms with a keyword fallback"`

---

### Task 4: Price check and fit facts

**Files:**
- Create: `src/price-check.mjs`
- Modify: `src/tender-catalog.mjs` (`selectHistoricalContracts(dataset, options, { includeHoldout = false } = {})`), `src/tender-stats.mjs` (`buildStatsSnapshot(dataset, options, { includeHoldout = false } = {})`; when true, add `scope: 'all-awards'` to the snapshot so its `stat_id` differs from backtest snapshots)
- Test: `test/price-check.test.mjs`, plus one case in `test/tender-stats.test.mjs`

**Interfaces:**
- **`export function priceCheck(dataset, { terms: string[], category?, agency? }) -> { status: 'ready'|'insufficient_comparables', query_used: string|null, snapshot, comparables: Array<{ tender_no, description, agency, award_date, awarded_cents, suppliers }> (max 25, newest first), limits: string }`.**
  - Try queries in order: `terms.join(' ')`, then `terms[0]`, then category only. Use the first that reaches 5 comparables, always with `includeHoldout: true` and category when given.
  - If none reach 5, `status 'insufficient_comparables'`, and the snapshot is from the first try.
  - `limits` is the exact limits line in Global Constraints.
- **`export function fitFacts({ client, verifiedProjects, tender, check }) -> { category_match: boolean, within_capacity: boolean|null, related_projects: number }`.**
  - `within_capacity` is `null` when not ready; otherwise `check.snapshot.price_band.median_cents <= client.max_contract_cents`.
  - `related_projects` counts verified projects whose title shares a token (length ≥4) with `query_used`.
- **`export function pastedTenderNo({ title, agency }) -> 'PASTED-' + first 16 hex of sha256(lowercased, whitespace-collapsed agency + '|' + title)`.**

- [ ] **Step 1: Write the failing tests.** Use the test dataset style from `test/governance.test.mjs` (5 `OLD-*` awards plus `NEW-*` holdout rows).
  - `'priceCheck includes holdout awards and reports the query it used'`: `terms:['event management','zzz']` → `query_used 'event management'`, `status 'ready'`, and `snapshot.n` counts the OLD and NEW rows.
  - `'priceCheck reports too few comparables honestly'`: `terms:['submarine']` with no category → `status 'insufficient_comparables'`, no `price_band`, and `limits` equals the constant.
  - `'backtest snapshots are unchanged'`: `buildStatsSnapshot(ds, {category:'events-community'})` has the same `stat_id` before and after this change (pin the value computed before you edit).
  - `'fitFacts'`: `max_contract_cents` below the median → `within_capacity false`.
  - `'pastedTenderNo is stable across spacing and case'`.
- [ ] **Step 2: Run** `node --test test/price-check.test.mjs test/tender-stats.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -am "Add live price checks over all award history and computed fit facts"` (add the new files first).

---

### Task 5: Customer operations and request-time exclusivity

**Files:**
- Modify: `src/governance.mjs`, `src/governance-agent.mjs` (export the `submit_brief` run as `submitBrief(tx, actor, input)` for reuse; behaviour unchanged)
- Test: `test/assistant-governance.test.mjs`

**Interfaces** (all methods run in one transaction and write an audit row with actor `customer:<client_id>`):
- **`desk.registerCustomer(userId, profile)`** → `createClient` result plus `customers` insert.
  - Blocked `G1` if the userId already has a client.
  - Profile schema: `clientProfileSchema`.
- **`desk.customer(userId)`** → throws `Error('Unauthorized')` if no `customers` row. Otherwise it returns a frozen object with:
  - **`context()`** → `{ client, projects (all, with verified flag), requests (with status, brief content when approved, decline_reason when declined) }`.
  - **`canRequest(tender_no)`** → one of:
    - `{ ok: true }`
    - `{ ok:false, reason:'held', message:'Tender Desk already advises a client on this tender.' }` (held by another client, or the hold is stopped)
    - `{ ok:false, reason:'active' }` (this client already has an open request)
    - `{ ok:false, reason:'closed' }` (an `open_tenders` row with `closes_at <= now`)
  - **`requestBrief({ tender_no?, pasted?: { title, agency?, text? }, terms, category?, agency? }, { now })`** → `{ outcome:'allowed', request_id, request_reference, payment_status:'test' }` or a blocked result. Steps:
    1. Resolve the tender from `open_tenders` (feed) or `pastedTenderNo` (pasted).
    2. Re-run the `canRequest` checks under `SELECT … FOR UPDATE` on `pricing_holds`.
    3. Build `priceCheck`. If it's not ready, block with `G4`, `'At least five comparable awards are needed for a brief. Try broader terms.'`.
    4. Insert into `stats_snapshots`.
    5. Insert the hold (`INSERT … ON CONFLICT DO NOTHING`, then verify `client_id` matches, else block `G2` with the refusal text).
    6. Insert into `brief_requests` (`status 'requested'`) and `payments` (`9900`, `'test'`).

    A duplicate active request hits the partial unique index. Catch `23505` and return the existing request's result, so the checkout is idempotent.
  - **`cancelRequest(request_id)`** → only when `requested`. Sets `cancelled` and deletes the hold if this client holds it and no brief is approved.
- **Founder additions** (on the object `founder(token)` returns):
  - **`listBriefRequests()`** → rows joined with client name, the payment status, and `closed` (closes_at ≤ now).
  - **`prepareDraft(request_id)`** → `{ request, tender:{ tender_no, title, agency, closes_at }, snapshot, client, verifiedProjects, fit }`. Read only; not audited.
  - **`saveDraft(request_id, { recommendation, content, credentials_cited })`:**
    1. Call `submitBrief(tx, { client_id }, { tender_no, stat_id, price_band: snapshot.price_band, ... })`.
    2. On `allowed`, set the request to `drafted` with `brief_id`.
    3. On blocked, set `last_error` to the reason and return the blocked result.
  - **`recordDraftFailure(request_id, reason)`** → sets `last_error` (audited, outcome `blocked`, rule `G4`).
  - **`declineRequest(request_id, reason)`** → reason required. Sets the request to `declined`, releases the hold.
  - **`reviewBrief`** changes:
    - On `approved`, set the linked request to `approved`.
    - On `declined`, set it to `declined` and delete the hold when `hold.client_id = brief.client_id` and `state = 'held'`.
- **Releasing a hold:** `DELETE FROM tender_desk.pricing_holds WHERE tender_no=$1 AND client_id=$2 AND state='held'`.

- [ ] **Step 1: Write the failing tests** (PGlite, test dataset with ≥5 comparables, two customers A and B):
  - `'registerCustomer links a Neon user to one client'`, and a second registration for the same user is blocked `G1`.
  - `'customer() rejects an unknown user'`: throws `/Unauthorized/`.
  - `'requestBrief takes the hold and records a test payment of 9900'`.
  - `'a second customer is refused before checkout without learning the holder'`:
    - B `canRequest` → `reason 'held'`, and the message equals the refusal text.
    - B `requestBrief` → blocked `G2`.
    - B's audit rows and `JSON.stringify` of results don't contain A's name or id.
    - B has no payment row.
  - `'checkout twice creates one request and one payment'` (Review Focus 3).
  - `'a closed tender cannot be requested'`: an `open_tenders` row with a past `closes_at` → `reason 'closed'` (Review Focus 5).
  - `'declining a request or its brief releases the hold'`: after `declineRequest`, B can request. Repeat via `saveDraft` then `reviewBrief(declined)`.
  - `'saveDraft enforces G3 and leaves the request requested with last_error'`: citing an unverified project → blocked `G3`, `last_error` set.
  - `'approval marks the request approved and context() shows the brief content'`.
  - `'existing MCP submit_brief behaviour is unchanged'`: `npm test` keeps `test/governance.test.mjs` green.
- [ ] **Step 2: Run** `node --test test/assistant-governance.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** in `governance.mjs`. Reuse `validate`, `record` and `founderOperation`, and add a `customerOperation(action, schema, handler)` that sets the actor.
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git add -A src test && git commit -m "Add customer operations: sign-up link, request-time exclusivity, test payments, draft and decline paths"`

---

### Task 6: Brief drafting

**Files:**
- Create: `src/brief-drafting.mjs`
- Modify: `src/brief-risk.mjs` (export the existing `unmatchedFigures`)
- Test: `test/brief-drafting.test.mjs`

**Interfaces:**
- **`export const draftSchema`:** zod `{ recommendation: enum('bid','no-bid'), reasons: string[1..6] (≤300 each), price_position: string ≤600, credentials_cited: uuid[] ≤10 }`.
- **`export function composeBrief(draft, facts) -> string`:** Markdown with these headings: `Recommendation`, `Why`, `Price position`, `Your verified projects cited`, `Comparable awards` (n, low/median/high via `formatSgd`, `query_used`), and `Limits` (the limits line). Code writes every figure; the model writes only the reasons and price-position prose.
- **`export async function draftBrief(facts, { llm, model }) -> { ok: true, draft: { recommendation, content, credentials_cited } } | { ok: false, reason }`.**
  - **Prompt:**
    - system: Tender Desk's adviser role; use only the facts given; never state a win probability or a winning price; describe price position relative to the comparable band (below the lower quartile, between quartile and median, and so on) without inventing numbers; cite only the given project ids.
    - user: JSON of the facts, with no client names other than this client's.
  - **Checks:**
    - `credentials_cited ⊆ facts.verifiedProjects.map(id)`, else `{ok:false, reason:'Draft cited a project that is not verified.'}`
    - `unmatchedFigures(reasons + price_position, band, n)` is empty, else `{ok:false, reason:'Draft contained figures not in the comparables: <list>'}`
    - the snapshot is `ready`
  - Model failure → `{ok:false, reason:'The model was unavailable. Try Redraft.'}`

- [ ] **Step 1: Write the failing tests** (fake llm):
  - `'a clean draft is composed with code-written figures'`: the content contains `formatSgd(median)` and the limits line.
  - `'a draft citing an unknown project is refused'`.
  - `'a draft inventing a figure is refused'`: reasons include `'S$123,456'` not in the band.
  - `'model failure returns a redraftable reason'`.
- [ ] **Step 2: Run** `node --test test/brief-drafting.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `node --test test/brief-risk.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/brief-drafting.mjs src/brief-risk.mjs test/brief-drafting.test.mjs && git commit -m "Draft briefs from code-assembled facts with citation and figure checks"`

---

### Task 7: Customer sign-in through Neon Auth

**Files:**
- Create: `src/customer-auth.mjs`
- Test: `test/customer-auth.test.mjs`

**Interfaces:**
- **`export function createCustomerAuth({ baseUrl, origin, adminUserId, fetchImpl = fetch })`** returns the following. It reuses the `sessionFrom` and pack/unpack helpers; move them into a small shared module, `src/neon-session.mjs`, and import them in `neon-auth.mjs` too.
  - **`signUp({ email, password, name })`** → `{ ok:true, session, userId } | { ok:false, message }`. Calls `/sign-up/email`. A password under 8 characters is refused locally.
  - **`signIn({ email, password })`** → the same shape. Calls `/sign-in/email`, and **refuses `adminUserId`** (the admin can't use the assistant as a customer).
  - **`verify(packed)`** → `userId | undefined`. Calls `/get-session` and returns `undefined` for `adminUserId`.
  - **`signOut(packed)`**.
- The cookie name is `td_customer` with path `${publicBase}/assistant`. The console cookie is a different name and path, so neither handler ever reads the other's cookie.

- [ ] **Step 1: Write the failing tests** against a fake auth HTTP server, following the pattern in `test/site-app.test.mjs`:
  - sign up then verify returns the userId
  - a wrong password gives `ok:false`
  - the admin user signing in to the assistant gives `ok:false`
  - `verify` of the admin's session gives `undefined` (Review Focus 4, assistant side)
- [ ] **Step 2: Run** `node --test test/customer-auth.test.mjs test/neon-auth.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement**, including the shared-helper move.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/customer-auth.mjs src/neon-session.mjs src/neon-auth.mjs test/customer-auth.test.mjs && git commit -m "Add customer sign-up and sign-in through Neon Auth, separate from the admin"`

---

### Task 8: Customer web app

**Files:**
- Create: `src/customer-handler.mjs` (routing, forms, cookies, rate limit), `src/customer-view.mjs` (HTML)
- Modify: `src/console-css.mjs` (add a few assistant classes only if needed)
- Test: `test/customer-app.test.mjs`

**Interfaces:**
- **`export function createCustomerHandler({ desk, dataset, auth, llm, models, database, basePath, secureCookies, refresh, waitUntil })`** → `async (request, route) => Response`.
  - `route` is relative to `/assistant`.
  - `refresh` is `() => refreshOpenTenders(database)`. When stale, call it through `waitUntil(promise)` if provided, otherwise `await` it with a 5s overall timeout. Render from the database either way.
- **Routes:**

  | Route | Behaviour |
  |---|---|
  | `GET /` | Public. Open tenders (all categories, newest first, with closing date and "Tenders last updated <time>"), plus the paste form (title, agency, text ≤4000). Signed-in customers are redirected to `/home`. |
  | `POST /check` | Public, rate-limited to 20 per hour per `x-forwarded-for` (in memory). Either `tender_no` from the feed or pasted fields → `readTender` (feed tenders cache `terms` on the row) → `priceCheck` → result page: terms (editable form re-posting to `/check` with `terms`), median, middle half, n, the listed comparables, top agencies, supplier spread, the limits line, and "Ask for a reviewed brief (S$99)" leading to sign-up or checkout. |
  | `GET /signup`, `POST /signup` | Then `GET /profile` / `POST /profile`: the company profile form. Projects as up to 10 repeated rows (title, agency, value S$, GeBIZ tender no) → `desk.registerCustomer`. |
  | `GET /signin`, `POST /signin`, `POST /signout` | |
  | `GET /home` | "Good morning, <company>". Matched open tenders (customer categories) with the instant summary and `fitFacts`. "Your projects", with unverified ones labelled `Unverified: the admin checks these against GeBIZ before a brief can cite them`. "Your briefs", with each request's status and approved content or decline reason. |
  | `GET /checkout?tender=<no>` or `POST /checkout/start` (pasted) | `canRequest` first: a refusal shows its message and no pay button. Otherwise the test-mode checkout: amount S$99.00, tender, company, the banner text, and a `Pay S$99 (test mode)` button posting to `POST /checkout`. |
  | `POST /checkout` | `requestBrief` → redirects to `/requests/<REQ…>` showing `In review: usually within one business day`. |
  | `GET /requests/<REQ…>` | Only the owner's. |

- **Behaviour:** every POST needs a same-origin `Origin` header (as the console does), request bodies are capped at 16 KB, and every HTML response gets the security headers.

- [ ] **Step 1: Write the failing tests** (PGlite, fake auth server, fake llm, a fake `fetchImpl` serving the feed fixture), driving HTTP through `createSiteApp` the way `test/site-app.test.mjs` does:
  - `'anonymous visitor sees open tenders and runs a price check'`: the page lists `RPO000ETQ26000129` and the check result contains the limits line.
  - `'pasted gibberish gets the too-few-comparables state'` (Review Focus 2), and 5000 characters of text are cut with the notice `Only the first 4000 characters were read.`
  - `'the 21st anonymous check in an hour is refused with 429'`.
  - `'GeBIZ down still renders the page'` (Review Focus 1): the fake fetch rejects, `GET /` is 200, and the stored tenders are shown.
  - `'sign up, profile, home shows projects as unverified'`.
  - `'checkout shows the test-mode banner, and paying creates one request'`.
  - `'a second customer sees the refusal and no pay button'`.
  - `'a customer cookie does not open the console'` (Review Focus 4, console side): `GET ${publicBase}/` with the `td_customer` cookie only → the console login page.
  - `'a customer cannot open another customer's request'`: 404.
- [ ] **Step 2: Run** `node --test test/customer-app.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the handler and views, following the console's `respond`/`html`/`redirect` helpers and its `withBase` link rewriting.
- [ ] **Step 4: Run** `node --test test/customer-app.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/customer-handler.mjs src/customer-view.mjs src/console-css.mjs test/customer-app.test.mjs && git commit -m "Add the customer web app: open tenders, free price check, sign-up, test-mode checkout, requests"`

---

### Task 9: Console brief-request queue

**Files:**
- Modify: `src/console-handler.mjs`, `src/console-view.mjs`, `src/console-records.mjs` (request page `/requests/REQ…`)
- Test: `test/console.test.mjs`

**Interfaces:**
- `createConsoleHandler` gains the optional `{ llm, models }`.
- New actions:
  - **`request/draft`** (also used for Redraft): `prepareDraft` → `draftBrief` → `saveDraft` or `recordDraftFailure`. Flash `Draft saved: review BRF…` or `Draft failed: <reason>`.
  - **`request/decline`** (reason required).
- New navigation item under Decisions: **Brief requests** (`/requests`), listing open requests oldest first with client, tender, title, paid status (`Test payment`), `closed` badge, last error, and a Draft or Redraft button.
- The request page links to its brief once drafted. The existing brief page and approve/decline actions are unchanged.
- Without an `llm`, the Draft button is replaced by `AI drafting is not configured (TD_OPENROUTER_KEY).`

- [ ] **Step 1: Write the failing tests:**
  - `'requests queue lists a paid request with Test payment'`
  - `'Draft with a clean fake llm creates a pending brief'`
  - `'Draft with a figure-inventing llm shows the failure and keeps the request open'`
  - `'decline needs a reason and frees the tender'`
  - `'a closed tender shows the closed badge'` (Review Focus 5)
  - `'without llm the Draft button explains the missing key'`
- [ ] **Step 2: Run** `node --test test/console.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -am "Add the brief-request queue to the console with draft, redraft and decline"`

---

### Task 10: Wiring, build, test customers and migration script

**Files:**
- Modify: `src/site-app.mjs`, `scripts/site-build.mjs` (pass `waitUntil: globalThis.EdgeRuntime?.waitUntil?.bind(globalThis.EdgeRuntime)` in the generated `index.ts`), `package.json` (scripts), `test/site-app.test.mjs`, `test/site-build.test.mjs`
- Create: `scripts/site-migrate.mjs`, `scripts/site-test-customers.mjs`
- Test: `test/site-migrate.test.mjs`

**Interfaces:**
- `createSiteApp(...)` reads `TD_OPENROUTER_KEY`, `TD_MODEL_READ` and `TD_MODEL_DRAFT`, builds `llm` only when the key is set, and routes `route.startsWith('/assistant')` to the customer handler (stripping the prefix), `/mcp` to the MCP handler, and everything else to the console.
  - `/health` adds `ai: Boolean(key)`.
  - It also accepts `waitUntil`.
- **`npm run site:migrate -- --db-file <path> [--check]`:** prints the host and the pending migrations. Without `--check`, it runs `initializeGovernance` (which never drops) and prints the client count before and after, which must be equal.
- **`npm run site:test-customers -- --db-file <path> --auth-url-file <path>`:**
  - Signs up three fictional users through `createCustomerAuth().signUp`, with emails `test+<label>@tenderdesk.invalid` and random 20-character passwords. Labels:
    - `aster`: events, all projects verified
    - `bramble`: cleaning, one verified and one unverified
    - `clover`: ICT, none verified
  - Registers each with `registerCustomer` (company names end in `(test)`) and verifies projects with the founder op, with the note `Seeded test customer (fictional).`
  - Writes `.local/site/test-customers.json` (mode 0600) with email, password and client reference.
  - Refuses to run if that file exists.

- [ ] **Step 1: Write the failing tests:**
  - `site-app`:
    - `'assistant routes are served and /health reports ai'`
    - `'without TD_OPENROUTER_KEY the app still serves checks via keywords'`
  - `site-build`: the generated `index.ts` contains `waitUntil`, and `site/functions/` contains `customer-handler.mjs`, `gebiz-feed.mjs` and `openrouter.mjs` (the import closure picks them up).
  - `site-migrate`: on a PGlite socket database at schema 002 with one client, the script applies 003 and the client count stays 1. `--check` changes nothing.
- [ ] **Step 2: Run** `node --test test/site-app.test.mjs test/site-build.test.mjs test/site-migrate.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the wiring and both scripts.
- [ ] **Step 4: Run** `npm test && npm run site:build`. Expected: all PASS, and the build writes `site/functions`.
- [ ] **Step 5: Commit.** `git add -A src scripts test package.json && git commit -m "Wire the assistant into the site function, add the in-place migration and test-customer scripts"`

---

### Task 11: Rehearsal, cut-over runbook and HANDOFF

**Files:**
- Modify: `scripts/site-rehearse.mjs` (or create `scripts/assistant-rehearse.mjs` if that file is storyline-specific), `HANDOFF.md`
- Test: run the rehearsal

**Interfaces:**
- **`npm run assistant:rehearse`** runs the spec's DoD steps 1–8 against a disposable local Postgres with the real dataset, live GeBIZ feeds and the real OpenRouter key from `~/.td-openrouter-key`. With `--fake-llm`, it runs offline. It prints one PASS/FAIL line per step, and refuses production URLs (copy the guard from `site-rehearse.mjs`).

- [ ] **Step 1: Write the rehearsal**, printing one line per DoD step.
- [ ] **Step 2: Run** `npm run assistant:rehearse -- --fake-llm`. Expected: 8/8 PASS.
- [ ] **Step 3: Run** `npm run assistant:rehearse` with the real key. Expected: 8/8 PASS. Read one drafted brief yourself and check that no sentence states a number that isn't in the comparables.
- [ ] **Step 4: Rewrite HANDOFF.md** for the new product. Add a **cut-over runbook** (the admin says yes first):
  1. `npm run site:build`
  2. In Sites Settings, set `TD_OPENROUTER_KEY` (the admin)
  3. In Neon Auth, enable email sign-up without email verification (the admin)
  4. Redeploy the Sites function
  5. `npm run site:migrate -- --db-file .local/site/db-unpooled.url`
  6. `npm run site:test-customers -- --db-file .local/site/db-unpooled.url --auth-url-file ~/.td-auth-url`
  7. `neon branches create --name assistant-baseline --parent production`
  8. Live DoD walkthrough with a test customer
  9. The admin passes `docs/hashmeta/site-update-instructions.md` to the Qoder agent, then checks the site

  Mark `demo-baseline-v2` as pre-003: never restore it. Record what is verified and what isn't.
- [ ] **Step 5: Commit.** `git add -A && git commit -m "Add the assistant rehearsal and the production cut-over runbook"`

---

## Execution notes

- Task 0 has no dependencies: do it first and send the instructions file to the admin as soon as it's committed.
- **Dependency chain:** 1 → (2, 3, 4 in any order) → 5 → 6 → (7) → 8 → 9 → 10 → 11. Task 7 depends only on Task 1.
- After Task 11, stop. The production cut-over runs only on the admin's explicit yes.
