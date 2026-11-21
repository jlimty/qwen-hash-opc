# Tender Desk Self-Service Journey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tender Desk a coherent self-service product: SMEs sign up and work in QwenWork chat, the exclusive rule guards advice instead of public numbers, the admin decides from code-computed facts, and the console gets grouped navigation, readable references and deep links.

**Architecture:** Extend the existing system. One additive schema file (`db/002-journey.sql`) applied after `001` on a freshly wiped `tender_desk` schema. New pure modules for references, connector configs, brief risk facts and the GeBIZ cross-check; the governance core and MCP tools call them. The zero-JS server-rendered console gains reference-keyed routes and detail pages, split into a second view file.

**Tech Stack:** Node ≥ 22 ESM, `node:test`, PGlite (tests), Postgres on Neon, zod 4, MCP over fetch (`src/mcp-web.mjs`), Qoder Sites Deno function.

**Spec:** `docs/superpowers/specs/2026-11-21-tender-desk-journey-design.md` (read it first; this plan implements it and uses its section numbers §1–§8).

## Global Constraints

- Money is integer cents SGD everywhere in storage and tool I/O.
- Every write runs in one transaction with its audit row (`record()` in `src/governance.mjs`). Audit log and `stats_snapshots` stay append-only.
- A connector token never appears in the audit log, server logs, the console, or any tool result other than the one `create_client` call that issued it.
- No agent tool returns risk level, risk facts, another client's identity, or any hold-out supplier/amount.
- Console: server-rendered, **zero client JavaScript**, CSP unchanged, every POST checks CSRF; filters use plain GET forms with an explicit "Apply" button.
- No LLM calls in this code.
- Agent-facing copy says "admin", never "founder". Internal function names may keep "founder".
- Reference format `PREFIX00001` (5-digit zero pad); prefixes `CLI`, `PRJ`, `BRF`, `CON`, `AUD`.
- Risk thresholds: `thin_evidence` n < 15; `wide_band` high > 4 × low; level 0 → low, 1–2 → medium, 3+ → high.
- Production writes (reseed) happen only with the admin's explicit yes at the time. The implementer never runs a production reseed.
- `npm test` must pass at the end of every task.

## Review Focus

1. **Band figures written the normal ways** ("S$208,800", "S$208,800.00", "$1.15m", "208800") must not fire `unmatched_numbers`; years and percentages must. → Task 5 test `band figures in common formats are matched`.
2. **A client resubmitting on its own tender** after a decline or a G3 block must save a new brief, never escalate against itself. → Task 4 test `holder resubmits after decline`.
3. **Client names with regex characters** ("A+B Events (Pte.) Ltd") in the G1 whole-word check must not throw and must still match. → Task 4 test `G1 tolerates regex characters`.
4. **Bad reference URLs** (`/briefs/brf00001`, `/briefs/BRF99999`, `/briefs/BRF1`, `/projects/../x`) return the 404 page, not a 500 or a redirect loop. → Task 8 test `bad references 404`.
5. **A GeBIZ tender with several supplier rows** matches when any supplier normalises to the client's name and shows that supplier's amount. → Task 7 test `multi-supplier tender matches on any row`.

---

### Task 1 (P0): Schema 002 and the migration runner

**Files:**
- Create: `db/002-journey.sql`
- Modify: `src/governance-db.mjs`
- Test: `test/governance-schema.test.mjs`

**Interfaces:**
- Produces: `initializeGovernance(database)` applies `001` when `tender_desk.clients` is absent and `002` when `tender_desk.clients.reference_number` is absent. New columns (all later tasks rely on these names):
  - `clients.reference_number bigint NOT NULL UNIQUE DEFAULT nextval('tender_desk.client_ref_seq')`; likewise `projects` (`project_ref_seq`), `briefs` (`brief_ref_seq`), `conflicts` (`conflict_ref_seq`). Backfill existing rows in `created_at,id` order (projects by `id`) before setting NOT NULL.
  - `projects.gebiz_tender_no text NULL`, `projects.verification_note text NULL`, `projects.verified_at timestamptz NULL`.
  - `briefs.risk_facts jsonb NOT NULL DEFAULT '[]'`, `briefs.risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high'))`, `briefs.decided_at timestamptz NULL`, `briefs.decline_reason text NULL`.
  - `agent_credentials.created_at timestamptz NOT NULL DEFAULT now()`.
  - `REVOKE ALL` on the new sequences from PUBLIC, as `001` does.

- [ ] **Step 1: Write failing tests** in `test/governance-schema.test.mjs`:
  - `002 adds reference numbers that increase per table`: create two clients via `founder.createClient`, assert `reference_number` values are 1 and 2.
  - `initializeGovernance is idempotent`: call it twice on one PGlite; no error; column count unchanged.
  - `002 backfills existing rows`: run only `001` SQL, insert a client row by SQL, then `initializeGovernance`; assert that row has `reference_number = 1`.
- [ ] **Step 2: Run** `node --test test/governance-schema.test.mjs` — expect FAIL (column missing).
- [ ] **Step 3: Write `db/002-journey.sql`** (wrapped in `BEGIN;…COMMIT;`) and extend `initializeGovernance` to apply the ordered list `[{ file: '001-governance.sql', present: "to_regclass('tender_desk.clients')" }, { file: '002-journey.sql', present: column check on information_schema.columns }]`.
- [ ] **Step 4: Run** `npm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add schema 002: references, risk, verification and decision columns"`

---

### Task 2 (P0): Readable references

**Files:**
- Create: `src/references.mjs`
- Test: `test/references.test.mjs`

**Interfaces:**
- Produces:
  - `referenceCode(prefix: 'CLI'|'PRJ'|'BRF'|'CON'|'AUD', n: number|bigint|string) → string` → `'BRF00012'`.
  - `parseReference(text: string) → { prefix, number } | null` — accepts only `^(CLI|PRJ|BRF|CON|AUD)(\d{5,})$` (uppercase, ≥5 digits); anything else is `null`.
  - `referenceLabel(prefix, n, subject?: string) → string` → `'BRF00012 - DST000ETT26000005'`, or the bare code when subject is empty.

- [ ] **Step 1: Write failing tests:** `referenceCode('BRF', 12) === 'BRF00012'`; `referenceCode('AUD', 123456) === 'AUD123456'`; `parseReference('BRF00012')` → `{ prefix: 'BRF', number: 12 }`; `parseReference('brf00012')`, `('BRF1')`, `('XYZ00001')`, `('BRF00012/x')` → `null`; `referenceLabel('CLI', 3, 'Cedar Markets') === 'CLI00003 - Cedar Markets'`; `referenceLabel('CLI', 3, '') === 'CLI00003'`.
- [ ] **Step 2: Run** `node --test test/references.test.mjs` — FAIL.
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `"Add readable record references"`

---

### Task 3 (P0): Self-service connector issued by `create_client`

**Files:**
- Create: `src/connector-config.mjs`
- Modify: `src/governance-agent.mjs` (`clientProfileSchema`, `createClient`, `agentWorkflows(dataset, options)`), `src/governance.mjs` (`createTenderDesk({ …, connector })`, pass to `agentWorkflows`), `src/site-app.mjs` (build `connector`), `scripts/tender-desk-server.mjs` (local `connector`)
- Test: `test/governance.test.mjs`, `test/site-app.test.mjs`

**Interfaces:**
- Produces:
  - `connectorConfig({ name: string, url: string, origin: string, timeout: number, token: string }) → { mcpServers: { [name]: { url, headers: { Authorization: 'Bearer <token>', Origin: origin }, timeout } } }`.
  - `connectorSlug(clientName: string) → string` — lowercase ASCII, non-alphanumerics → `-`, collapsed and trimmed, max 40 chars, prefixed `tender-desk-`; empty → `tender-desk-client`.
  - `createTenderDesk` option `connector: { url, origin, timeout }`. Site: `{ url: \`${origin}${publicBase}/mcp\`, origin, timeout: 60 }`. Local server: `{ url: 'http://127.0.0.1:<mcp port>/mcp', origin: 'http://127.0.0.1:<mcp port>', timeout: 60 }`. Tests: any fixed values.
  - Intake `create_client` result adds `client_reference` (`CLI…`), `connector_name`, `connector_config`. Founder `createClient` is unchanged (no credential).
  - `clientProfileSchema.past_projects[]` adds optional `gebiz_tender_no: text(100)`, stored in `projects.gebiz_tender_no`.
  - Duplicate name → `blocked('G1', 'That company name is not available. If this is your company, contact Tender Desk.')`.
  - Audit summary for `create_client` gains `client_reference` and `credential_id`; add both keys to the `record()` whitelist. The token key is never whitelisted.

- [ ] **Step 1: Write failing tests** in `test/governance.test.mjs`:
  - `intake create_client returns a working connector`: intake agent creates a client; `connector_config.mcpServers[connector_name].headers.Authorization` starts with `Bearer `; `desk.agent(token)` works and `get_client_context` returns that client's name.
  - `connector token never reaches the audit log`: after the call, `SELECT * FROM tender_desk.audit_log` serialised does not contain the token string.
  - `gebiz_tender_no is stored`: project created with `gebiz_tender_no: 'OLD-1'` has that column set.
  - `duplicate name gets the neutral message`.
  - In `test/site-app.test.mjs`: `site connector url uses origin and publicBase`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `createClient`'s agent path, issue the credential with the same SQL `issueAgentCredential` uses, inside the same transaction; build the config with `connectorConfig`. Keep `createClient(tx, input)` for the founder path; add `createClientWithConnector(tx, input, connector)` for intake.
- [ ] **Step 4: Run** `npm test` — PASS (update any existing test that asserted the old duplicate message).
- [ ] **Step 5: Commit** `"Issue a client connector at intake"`

---

### Task 4 (P0): G2 exclusive advice moves to `submit_brief`; G1 whole-word

**Files:**
- Modify: `src/governance-agent.mjs` (`request_pricing`, `submit_brief`, `get_policies`, tool descriptions)
- Test: `test/governance.test.mjs`, `test/mcp-business.test.mjs` / `test/mcp-web.test.mjs` where they assert old G2 behaviour

**Interfaces:**
- `request_pricing`: no hold insert or check; same outputs as today minus escalation. Description drops the hold sentence and says the band is open to every client.
- `submit_brief` order: G4 → G3 → G1 → G2. G2 inserts the hold (`ON CONFLICT DO NOTHING`), locks it, then: own + `held` → save brief; `stopped` → `blocked('G2', 'Tender Desk has stopped advising on this tender.')`; other holder → upsert conflict as today, **no brief saved**, return `{ outcome: 'escalated', rule_id: 'G2', conflict_id, reason: 'Tender Desk already advises another client on this tender. The admin has been notified. No advice can be given to you on it.' }`.
- G1: `namesOtherClient(content: string, names: string[]) → boolean` exported from `governance-agent.mjs`: NFKC + lowercase both sides, escape regex metacharacters in the name, match with `(?<![\p{L}\p{N}])name(?![\p{L}\p{N}])` (`u` flag).
- `get_policies` G2 text exactly: title `Exclusive advice`, policy `Tender Desk advises only one client per tender. A second client is escalated to the admin; advice already given is never transferred.` Replace "founder" with "admin" in all six policies.

- [ ] **Step 1: Write failing tests:**
  - `two clients can both get the band`: A and B `request_pricing` on one tender → both `allowed`, identical `price_band`.
  - `second brief escalates and is not saved`: A submits → `pending_approval`; B submits → `escalated`, `G2`; `briefs` has no row for B; `conflicts` has one open row.
  - `blocked brief takes no hold`: A submits citing an unverified project → `G3`; then B submits valid → `pending_approval` (B is holder).
  - `holder resubmits after decline`: A submits, founder declines, A submits again → `pending_approval`, no conflict row.
  - `stopped tender refuses briefs but still prices`.
  - `G1 matches whole words only`: with another client named `Birch Events`, content `"Birch Eventsful planning"` → not blocked; content `"we met birch events last year"` → `blocked`, `G1`.
  - `G1 tolerates regex characters`: other client `A+B Events (Pte.) Ltd`; content containing that exact name → blocked; no throw.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS after updating old G2-at-pricing assertions (mcp tests, `scripts/governance-demo.mjs` test if it asserts escalation at pricing).
- [ ] **Step 5: Commit** `"Move the exclusive rule from pricing to advice"`

---

### Task 5 (P1): Deterministic brief risk facts

**Files:**
- Create: `src/brief-risk.mjs`
- Modify: `src/governance-agent.mjs` (`submit_brief` stores `risk_facts`, `risk_level`; drops `unverified_numeric_content`)
- Test: `test/brief-risk.test.mjs`, `test/governance.test.mjs`

**Interfaces:**
- Produces `computeRiskFacts({ n: number, band: { low_cents, median_cents, high_cents }, maxContractCents: number, content: string, citedCount: number, verifiedProjectCount: number, priorBriefCount: number }) → { facts: Array<{ code, message }>, level: 'low'|'medium'|'high' }` and `formatSgd(cents) → string` (`S$612,000`; two decimals only when cents % 100 ≠ 0).
- Fact codes and exact messages (spec §4):
  - `thin_evidence`: `Only ${n} comparable contracts.`
  - `wide_band`: `Band is wide: top is ${ratio.toFixed(1)}× the bottom.` (fires also when low is 0; ratio text then `Band is wide: the bottom is S$0.`)
  - `above_ceiling`: `Median ${formatSgd(median)} is above the client's ${formatSgd(max)} ceiling.`
  - `unmatched_numbers`: `${k} figure${k===1?'':'s'} in the text ${k===1?'is':'are'} not band figures: ${first five distinct tokens joined by ', '}.`
  - `no_citations`: `No verified project cited.`
  - `thin_history`: `First brief from this client.` when `priorBriefCount === 0`, else `Only ${verifiedProjectCount} verified project on record.` when `verifiedProjectCount < 2`.
- Number matching: tokens `/\d[\d,]*(?:\.\d+)?\s*[kKmM%]?/g`. A token with `%` never matches. Strip commas; apply `k` ×1e3, `m` ×1e6. Allowed: band values in dollars and in cents, and `n`. Plain tokens match exactly; `k`/`m` tokens match within 0.5% of a band dollar value.

- [ ] **Step 1: Write failing tests** in `test/brief-risk.test.mjs` with band `{ low_cents: 20880000, median_cents: 45000000, high_cents: 115310900 }`, `n: 57`:
  - `band figures in common formats are matched`: content `"Band S$208,800 to S$1,153,109.00, median $450k, 57 comparables, about $1.15m top"` → no `unmatched_numbers`.
  - `years and percentages are unmatched`: content `"In 2026 we expect a 40% margin"` → fact with message `2 figures in the text are not band figures: 2026, 40%.`
  - one test per remaining fact code with its exact message; `level` low/medium/high at 0, 2, 3 facts.
  - In `test/governance.test.mjs`: `submit_brief stores risk facts and level`, and `risk is not returned to the agent` (result has no `risk_level`/`risk_facts`/`flags` keys).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; in `submit_brief` read `n` from the saved snapshot, counts by SQL before insert.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Compute deterministic risk facts for briefs"`

---

### Task 6 (P0): Decisions reach the client; decline needs a reason

**Files:**
- Modify: `src/governance.mjs` (`reviewBrief`), `src/governance-agent.mjs` (`get_client_context`), `src/console-handler.mjs` (`brief/decline` passes `reason` form field)
- Test: `test/governance.test.mjs`, `test/console.test.mjs`

**Interfaces:**
- `reviewBrief({ brief_id, decision, reason? })`: schema `reason: text(500)` required when `decision === 'declined'` (else `blocked('VALIDATION', 'A decline needs a reason.')`); sets `decided_at = now()`, `decline_reason`. Audit summary adds `brief_reference` and `decline_reason` (whitelist both).
- `get_client_context` adds:
  - `briefs`: newest first, max 20, `{ reference: 'BRF…', tender_no, recommendation, status, submitted_at, decided_at, decline_reason, content }`.
  - `advice_refused`: from this client's conflicts: `{ tender_no, status: 'awaiting_admin' | 'not_advised' }` (`open` → awaiting; resolved → not_advised).
  - Never includes `risk_*`, `flags`, `holder_client_id`.
- Console decline form gains `<textarea name="reason" required maxlength="500">`; `actions['brief/decline']` reads it.

- [ ] **Step 1: Write failing tests:** `client sees approval in context`; `client sees decline reason`; `decline without reason is blocked`; `escalated client sees awaiting_admin then not_advised`; `context never leaks holder or risk` (serialised context lacks `holder_client_id`, `risk_level`, other client's name); console test `decline form posts reason`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Return admin decisions to the client"`

---

### Task 7 (P1): GeBIZ cross-check and verification notes

**Files:**
- Create: `src/gebiz-check.mjs`
- Modify: `src/governance.mjs` (`verifyProject` schema and rules)
- Test: `test/gebiz-check.test.mjs`, `test/governance.test.mjs`

**Interfaces:**
- Consumes: `formatSgd(cents)` from `src/brief-risk.mjs` (Task 5).
- Produces:
  - `normaliseCompany(name: string) → string`: uppercase, remove punctuation, collapse whitespace, strip one trailing `PTE LTD` | `PTE. LTD.` | `PRIVATE LIMITED` | `LTD` (match after punctuation removal: `PTE LTD`, `PRIVATE LIMITED`, `LTD`).
  - `crossCheckProject(dataset, project: { gebiz_tender_no, agency, value_cents }, clientName: string, revealed: Set<string>) → { result: 'match'|'no_match'|'not_checked', lines: string[] }`. Lines (exact):
    - no number: `No GeBIZ tender number given.` → `no_match`
    - unknown: `Not found in GeBIZ awards 2021-04 to 2026-03.` → `no_match`
    - hold-out not revealed: `In the backtest hold-out; not checked until revealed.` → `not_checked`
    - else: `Tender ${no} exists · awarded ${last_award_date} · ${agency}`, `Agency claimed: ${claimed ?? 'not given'}`, `Supplier on record: ${names joined ' / '} — ${matches ? 'matches' : 'does not match'} "${clientName}"`, `Claimed ${formatSgd|'no value'} · awarded ${formatSgd(matching row or total)}` → `match` iff a supplier normalises equal.
  - `verifyProject({ project_id, verified, note? })`: `note: text(500)` optional in schema; the founder op computes the cross-check (needs `dataset` and revealed set, both already in `createTenderDesk`) and returns `blocked('G3', 'A note is required to verify a project without a GeBIZ match.')` when verifying, result ≠ `match`, and no note. Sets `verification_note`, `verified_at` (null on unverify). Audit summary adds `project_reference`, `check_result`, `note` (whitelist).

- [ ] **Step 1: Write failing tests** with a fixture dataset row `OLD-9` suppliers `CEDAR MARKETS PTE. LTD.` (S$90,000) and `OTHER CO` (S$10,000):
  - `normaliseCompany('Cedar Markets Pte. Ltd.') === normaliseCompany('CEDAR MARKETS')`.
  - `multi-supplier tender matches on any row`: client `Cedar Markets`, `OLD-9` → `match`, amount line shows `S$90,000`.
  - `no number`, `unknown number`, `hold-out unrevealed` → exact lines and results.
  - Governance: `verify without match needs a note`; `verify with note stores note and verified_at`; `unverify clears verified_at`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Cross-check projects against GeBIZ and require verification notes"`

---

### Task 8 (P1): Reference-keyed detail pages and deep links

**Files:**
- Create: `src/console-records.mjs` (detail renderers; imports shared helpers from `console-view.mjs`, which exports `renderShell`, `esc`, `money`, `form`, `plural`)
- Modify: `src/console-view.mjs` (export helpers; lists and overview show references and link to detail pages), `src/console-handler.mjs` (routes, `project/verify` reads `note`), `src/governance.mjs` (`readConsole` adds `credentials: id, client_id, created_at` (no hash) and `revealed: string[]`; new `readAuditEntry(n)`)
- Test: `test/console.test.mjs`

**Interfaces:**
- Routes (GET): `/briefs/:ref`, `/conflicts/:ref`, `/clients/:ref`, `/projects/:ref`, `/audit/:ref`; `:ref` parsed with `parseReference` and the prefix must match the route. `/briefs/<uuid>` → 303 to `/briefs/BRF…`. Unknown or malformed → `renderNotFound({ listHref, listLabel })` with status 404.
- Every record mention renders as `<a href="/<type>s/<REF>">REF - subject</a>` via one helper `recordLink(kind, row, subject)` in `console-records.mjs`.
- Brief detail order (spec §6): header `BRF… - <tender_no>`, risk chip, "Risk facts" list (or "No risk facts fired."), band + citations (linked `PRJ…`), "Agent's draft (not checked for meaning)", Approve / Decline-with-reason.
- Project detail: cross-check lines from Task 7, verify form with `note` textarea (label "Note (required without a GeBIZ match)"), unverify form, audit entries for this project.
- Client detail: profile, "Connector issued" dates from `credentials`, projects (linked), briefs, conflicts, shortlist.
- Conflict detail: tender, both clients (linked), hold state, resolution buttons. Copy: "Keep advising the holder" / "Stop advising on this tender".
- Audit detail: all columns; links to every reference in `summary` and the client.
- Status chip helper `chip(label, tone)` with tones `progress|done|warning|danger|neutral` (spec §6 mapping); always visible text.

- [ ] **Step 1: Write failing tests:** `brief detail by reference shows risk facts before draft` (index of "Risk facts" < index of "Agent's draft"); `uuid brief URL redirects to reference`; `bad references 404` for `/briefs/brf00001`, `/briefs/BRF99999`, `/briefs/BRF1`, `/clients/BRF00001`; `project detail shows cross-check and requires note`; `client page links to its projects and briefs`; `overview links records by reference`; `conflict detail resolves`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Keep `console-view.mjs` for shell, auth pages, overview, lists and backtest; detail pages live in `console-records.mjs`.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Give every console record a reference and its own page"`

---

### Task 9 (P2): Grouped navigation, list filters, audit filters, tender page, revoke

**Files:**
- Modify: `src/console-view.mjs` (nav groups, list filters, inbox sort), `src/console-records.mjs` (`/tenders/:no`), `src/console-handler.mjs` (query parsing, `/actions/credential/:id/revoke`), `src/governance.mjs` (`readAudit({ q, client, tender, rule, outcome, limit=200 })`), `src/console-css.mjs` (group headings, chips, filter form)
- Test: `test/console.test.mjs`

**Interfaces:**
- Nav: Overview; **Decisions** (Briefs · pending count, Conflicts · open count); **Clients** (Clients · count, Projects · awaiting-verification count); **Records** (Backtest, Audit log). Page header eyebrow = group name.
- `listQuery(searchParams, { statuses, sorts }) → { q (≤120 chars), status ('active' default | 'all' | one of statuses), sort, risk? }` and `listHref(path, query, overrides) → string` omitting defaults (port of atrip `collectionQuery.ts`). Detail pages receive `back` = the list href and render "Back to <list>".
- Briefs list: status `pending|approved|declined|all`, risk `high|medium|low|any`, sort `risk` (default: high→low then oldest) `|newest|oldest`. Overview inbox uses the `risk` sort.
- Audit list: filters `q` (matches references, actions, reasons), `client` (CLI ref), `tender`, `rule` (G1–G6), `outcome`.
- `/tenders/:tender_no`: briefs, conflict, hold state, revealed outcome if revealed (else "Not revealed").
- `POST /actions/credential/:id/revoke` → `ops.revokeAgentCredential`; flash "Connector revoked."

- [ ] **Step 1: Write failing tests:** `nav shows groups in order`; `briefs list filters round-trip in URL` (GET `/briefs?status=all&risk=high` renders those selected and links keep them); `detail back link keeps the filter`; `audit filter by tender`; `tender page hides unrevealed outcome`; `revoke connector stops the agent` (agent call after revoke throws Unauthorized).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Group console navigation and add list filters"`

---

### Task 10 (P0): Skills follow the new journey

**Files:**
- Modify: `skills/tender-desk-intake/SKILL.md`, `skills/tender-desk-analyst/SKILL.md`, `skills/tender-desk-scout/SKILL.md`, `skills/tender-desk-proposal/SKILL.md`
- Test: `test/skills.test.mjs` (create)

**Interfaces / required content:**
- Intake: ask for an optional GeBIZ tender number per government project; after `create_client`, show `connector_config` once in a ```json block followed by exactly `Paste this into QwenWork → Connectors. It will not be shown again.`; the "never display tokens" rule gains the exception "except the connector config returned to this user by create_client, shown once".
- Analyst: pricing is open (no hold, no confirmation needed for pricing); **confirm before `submit_brief`** with: "Submitting takes the advice slot for this tender. If Tender Desk already advises another client on it, you will be escalated to the admin and no advice can be given."; escalation handled on `submit_brief`; new section "Where's my brief?" → `get_client_context`, report status, show approved content or decline reason.
- Scout: remove "it takes an exclusive hold"; keep "Never call `request_pricing`".
- Proposal: if `get_client_context.briefs` has an approved brief for the tender, use its recommendation.
- All skills: "founder" → "admin".

- [ ] **Step 1: Write failing test** `test/skills.test.mjs`: each SKILL.md has frontmatter `name` matching its folder; no file contains `founder`; analyst contains `Where's my brief`; intake contains `It will not be shown again.`; scout does not contain `exclusive hold`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Edit the skills.**
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `"Update skills for the self-service journey"`

---

### Task 11 (P0): Seed, reseed, starter pack and rehearsal

**Files:**
- Modify: `scripts/lib/seed.mjs` (Birch only + public intake), `scripts/site-seed.mjs`, `scripts/site-rehearse.mjs`, `test/site-seed.test.mjs`
- Create: `scripts/site-reseed.mjs`, `scripts/starter-pack.mjs`; `package.json` scripts `site:reseed`, `starter-pack`

**Interfaces:**
- `seedClients` = Birch Events (demo) only, first project verified with note `Seeded demo client (fictional).`. `seedDemo` writes `intake.txt`, `birch.txt` and, when given `connector`, `connectors/tender-desk-intake.json` and `connectors/tender-desk-birch.json` via `connectorConfig` (mode 0600).
- `site:reseed -- --db-file <file> --yes-wipe-tender-desk [--state-dir]`: prints the target host and client/brief/audit counts; refuses without the flag; moves `<state>/agent-tokens` and `<state>/connectors` to `*.before-reseed-<UTC stamp>`; runs `DROP SCHEMA tender_desk CASCADE`, `initializeGovernance`, `seedDemo`. Never touches `neon_auth`.
- `starter-pack -- [--state-dir]`: writes `<state>/starter-pack/` (under git-ignored `.local/`) with `tender-desk-intake.json` (copied from connectors) and `tender-desk-{intake,scout,analyst,proposal}.zip`, each containing `SKILL.md` at the zip root (use the `zip` CLI via `execFileSync`), plus `README.txt` with the three steps from spec §1.
- `site-rehearse.mjs`: rewritten to the §8 storyline on a disposable DB: intake creates `Cedar Markets (rehearsal)` and uses the returned connector; admin verifies one project with a note; Cedar prices DST000ETT26000005; G3 block then pending; Birch prices (allowed) then submits → escalated; admin keeps holder, approves Cedar; Cedar context shows approved; reveal that tender, outcome inside the band. Keeps both safety refusals.

- [ ] **Step 1: Write failing tests** in `test/site-seed.test.mjs`: `seed creates Birch and a public intake only`; `seed writes connector JSON files with mode 600`; `reseed refuses without flag`; `reseed drops and rebuilds tender_desk only` (PGlite: create a table in another schema; it survives).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — PASS. Then on a disposable Neon branch (the admin creates it or approves creation): `npm run site:reseed -- --db-file <branch url file> --yes-wipe-tender-desk --state-dir .local/rehearsal` then `npm run site:rehearse -- --db-file <same> --tokens-dir .local/rehearsal/agent-tokens --yes-this-is-disposable` — expect every step PASS.
- [ ] **Step 5: Commit** `"Reseed, starter pack and rehearsal for the new journey"`

---

### Task 12 (P0): Docs and the gated production runbook

**Files:**
- Modify: `HANDOFF.md`, `PRODUCT.md`

- [ ] **Step 1:** Rewrite HANDOFF storyline to spec §8; replace the reset section with: (1) the admin's yes; (2) `npm run site:build` and redeploy; (3) `npm run site:reseed -- --db-file .local/site/db-unpooled.url --yes-wipe-tender-desk`; (4) re-paste Birch connector in QwenWork; (5) `neon branches create --name demo-baseline-v2 --parent production`; (6) reset before recording = `neon branches restore production demo-baseline-v2 --preserve-under-name production-before-reset`. Mark old `demo-baseline` retired. Add known limitations from spec.
- [ ] **Step 2:** PRODUCT.md: hosted, admin (not founder), backtest built, self-service SMEs in QwenWork chat, chat is the SME UI.
- [ ] **Step 3: Run** `npm test` — PASS.
- [ ] **Step 4: Commit** `"Update handoff and product docs for the self-service journey"`

Production deploy, reseed and new baseline are **not** part of implementation; they run only after the admin says yes.
