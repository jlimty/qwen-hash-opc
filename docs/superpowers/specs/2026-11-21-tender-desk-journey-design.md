# Tender Desk: self-service journey and console refinement

Status: design for approval, 21 Nov 2026. Deadline: demo video and submission Mon 23 Nov 2026, 23:59 SGT.

## Why

The handoff's storyline breaks in three places: a client registered through intake can never act (no connector is issued), the client never learns what the admin decided on their brief, and project verification is a one-click approval with no evidence. The conflict rule (G2) also fires in the wrong place: it blocks a client from *public statistics* rather than stopping Tender Desk from *advising two competitors* on the same tender. A judge can ask "why can't Birch see public numbers?" and there is no good answer today.

This design turns Tender Desk into a coherent self-service subscription product: the SME owner works entirely in QwenWork chat, and the admin decides only in the console, from facts the code computes. The admin console also gets the organisation of a real operations tool: grouped navigation, a stable URL for every record, and short readable references.

## Who and where

- **SME owner (subscriber).** Their whole UI is QwenWork chat. They import a public *intake* connector and the Tender Desk skills, register, then paste a personal connector that acts for their company only.
- **Admin (the admin).** The only human inside Tender Desk. Decides in the console: verify projects, resolve conflicts, approve or decline every brief, reveal backtest outcomes. Never sits in a client's chat.
- **Hashmeta site.** The front door: article plus a "Get started" section with the starter pack.

## Goals

1. Close the loop: intake → own connector → scout → price → brief → admin decision → client reads the decision in chat.
2. Move the exclusive rule from pricing to advice (brief submission).
3. Give the admin deterministic facts, never agent judgement, for briefs (risk facts and level) and for projects (GeBIZ cross-check).
4. Console: grouped navigation, deep links for every record, readable references everywhere a record is shown.
5. A 3-minute demo storyline that follows this journey without a cut-away.

## Non-goals

- A web portal for SMEs. Chat is the SME UI.
- Billing, plans, or subscription management. The video may say "subscription"; nothing is built.
- Auto-release of low-risk briefs. Every brief goes to the admin; auto-release is the stated roadmap.
- Rate limiting on intake. Recorded as a known limitation.
- Client-side JavaScript in the console.

## Anti-goals (failure even if it works)

- Any risk level, verification hint, or score produced by an agent and shown to the admin as if it were a fact.
- A client learning anything about another client, including that a *named* competitor holds a tender.
- A backtest hold-out winner or amount reaching an agent, or reaching the admin before reveal through a side door (see cross-check).
- A connector key appearing in the audit log, server logs, or the console.
- Breaking the live site or spending the demo baseline without the admin's explicit yes.

## Constraints

- Live on Qoder Sites (Deno edge function) + Neon Postgres + Neon Auth. WebSocket driver in the function; `postgres` in Node scripts.
- Schema changes ship as `db/002-…sql`, applied after `001` on a fresh schema. **Production is wiped and reseeded, not migrated in place** (decided by the admin): drop the `tender_desk` schema only, run `001` then `002`, seed. The `neon_auth` schema (the admin's sign-in) is untouched. Rehearsed end-to-end on a disposable Neon branch first; run on production only with the admin's explicit yes at the time.
- Because the reseed starts from empty, no data written under the old G2 rule (pricing-only holds, pricing-time conflicts) survives, and `002` needs no data cleanup.
- **The old `demo-baseline` Neon branch is retired** (it predates the new schema). After the production reseed, take a new baseline branch and rewrite the reset runbook around it.
- Console stays server-rendered, zero client JS, CSP `default-src 'none'`, CSRF double-submit on every POST.
- All money in integer cents SGD. Every write transactional with its audit row. Audit log and snapshots stay append-only.
- No LLM calls in this code.

## Approaches considered

1. **Extend the existing system (chosen).** New and changed tools on the same MCP endpoint, an additive migration, new and changed console screens in the existing server-rendered style, updated skills. Keeps the tested security posture and fits the deadline.
2. **Separate SME web portal.** Rejected: chat is the SME's UI by decision; a portal adds a second login, session security, and screens for no demo gain.
3. **Rebuild the console as a client-side app (like the atrip reference's Next.js stack).** Rejected: discards the zero-JS, strict-CSP console that is live and tested. The reference repo is used for its *patterns* (groups, references, deep links, URL-held filters), not its stack.
4. **Agent-computed risk and verification hints.** Rejected by decision: the admin decides from facts code computes.

## Decisions (made with the admin)

- Self-service sign-up: the personal connector is issued **immediately** by `create_client`, shown once in the intake chat as paste-ready JSON.
- QwenWork import is *paste JSON into connector settings*.
- The exclusive hold moves from `request_pricing` to `submit_brief`. Price bands are open to every client.
- With one client on a tender there is no conflict and no admin involvement for G2; the brief still needs admin approval.
- Every brief needs admin approval. Auto-release is roadmap.
- Brief risk is deterministic facts plus a level computed from them. The agent's "risks if you bid" section stays as content and never sets the level.
- Project verification: GeBIZ cross-check facts plus an admin note.
- Admin console adopts grouped navigation, deep links, and readable references, following the atrip-all-in patterns.
- Production gets a wipe-and-reseed of the `tender_desk` schema. Amber is dropped; Birch is reseeded with a new key, so the admin re-pastes Birch's connector in QwenWork; a new intake key is issued for public use.
- QwenWork installs a skill from a `SKILL.md` file or a `.zip` containing `SKILL.md` (Install Skill dialog). The starter pack ships one file per skill.

### Builder-check calls (made by Claude, for the admin to check)

- G1 "names another client" matches the other client's **full name as whole words** (normalised, case-insensitive), not a substring, so registering a generic name like "Events" cannot block everyone's briefs.
- Duplicate company names at intake are refused with a neutral message ("That company name is not available. If this is your company, contact Tender Desk."). That this hints at an existing client is a known limitation.
- A client who loses their one-time connector contacts the admin; reissue is out of scope (it would show a key in the console). Known limitation.
- The starter pack is **content for the admin to publish on the Hashmeta site**, not code in this repo.

## Design

### 1. Sign-up and connectors

- **Starter pack** (published by the admin on the Hashmeta site; the repo produces it under `starter-pack/` via a script, with the key filled in only at generation time and the output git-ignored):
  - `tender-desk-intake.json`: intake connector (public key, intake role: `get_policies`, `create_client` only). Same shape as today's `.local/site/connectors/*.json`: `{ mcpServers: { "<name>": { url, headers: { Authorization, Origin }, timeout } } }`. Uses a **new intake credential issued at reseed for public use**.
  - `tender-desk-intake.zip`, `-scout.zip`, `-analyst.zip`, `-proposal.zip`: each a zip containing that skill's `SKILL.md`, matching QwenWork's Install Skill dialog.
  - Three-step instructions: install the four skills; paste the intake JSON into Connectors; start a chat with "Register my company".
- **`create_client`** additionally issues a `client`-role credential for the new client in the same transaction and returns `connector_config`: a complete paste-ready object named `tender-desk-<slug>` (slug from the client name, ASCII, max 40 chars) with the public MCP URL, `Authorization: Bearer <token>`, the site `Origin`, and the timeout. The server learns URL and Origin from configuration it already has (`publicBase` in `site-app.mjs`); the local launcher supplies its own.
- The token is returned to the caller **only**. The audit summary for `create_client` records `client_id`, client reference, project count and credential id, never the token. Add a test that asserts the token string appears in no audit row.
- Intake schema: each past project gains an optional `gebiz_tender_no` (validated as a tender-number string; existence is *not* checked at intake).
- Intake skill: asks for a GeBIZ tender number when a project was a government contract; shows the connector JSON once in a code block with "Paste this into QwenWork → Connectors. It will not be shown again."; drops the blanket "never display tokens" rule for this one output only.
- Known limitation: the intake key is public, so anyone can register companies. Admin can revoke a client's credential (button on the client page; backend `revokeAgentCredential` already exists).

### 2. Conflict rule G2: exclusive advice

- `request_pricing` no longer creates or checks a hold. It validates the tender is incoming, computes and saves the snapshot (unchanged), returns the band. If advice on the tender is `stopped`, pricing is still returned (public data); the brief will be refused.
- `submit_brief` check order: G4 (band matches saved snapshot) → G3 (citations verified and owned) → G1 (no other client's full name as whole words) → **G2 hold**. The hold is taken only after every other check passes, so a blocked brief never takes a hold.
- G2 at submit: insert hold if none (`ON CONFLICT DO NOTHING`), lock it. If held by this client and `held`: save the brief. If `stopped`: blocked, "Tender Desk has stopped advising on this tender." If held by another client: record the conflict (as today), **do not save the brief**, return `escalated` with "Tender Desk already advises another client on this tender. The admin has been notified. No advice can be given to you on it." No holder identity, no brief content of the holder.
- Rename in copy and policy: G2 "Exclusive advice": "Tender Desk advises only one client per tender. A second client is escalated to the admin; advice already given is never transferred." The table keeps its name `pricing_holds` (builder may rename via the migration if cheap).
- Resolution options unchanged: *keep advising the holder* (closes the conflict) or *stop advising on this tender* (holder's pending brief can no longer be approved; existing check).
- A declined brief keeps the hold; the client may resubmit.

### 3. Return path: the client sees decisions

`get_client_context` adds:

- `briefs`: for this client only, newest first, up to 20: `reference`, `tender_no`, `recommendation`, `status` (`pending_approval` | `approved` | `declined`), `submitted_at`, `decided_at`, `decline_reason`, and `content` (the client's own text; on approval it is the approved brief).
- `advice_refused`: tenders where this client was escalated or service stopped, with status (`awaiting_admin` | `not_advised`) and no other detail.

Risk level and risk facts are **not** returned to the client (internal view). Analyst skill gains a step: "Where's my brief?" → call `get_client_context`, report status; on approval present the approved brief; on decline give the admin's reason.

### 4. Brief risk facts (deterministic)

Computed in `submit_brief`, stored on the brief (`risk_facts jsonb`, `risk_level text`) so the admin sees what was true at submission. Each fact: `{ code, message }`. Thresholds are the builder's starting values, stated in one module so they are easy to change:

| Code | Fires when | Message example |
|---|---|---|
| `thin_evidence` | snapshot `n` < 15 | "Only 9 comparable contracts." |
| `wide_band` | high > 4 × low | "Band is wide: top is 5.5× the bottom." |
| `above_ceiling` | band median > client `max_contract_cents` | "Median S$612,000 is above the client's S$200,000 ceiling." |
| `unmatched_numbers` | any number in the text is not the band low/median/high (in S$ or cents, any common formatting) or `n` | "3 figures in the text are not band figures: 2026, 12, 40%." |
| `no_citations` | `credentials_cited` is empty | "No verified project cited." |
| `thin_history` | client has < 2 verified projects, or this is the client's first brief | "First brief from this client." |

Level: 0 facts → **Low**, 1–2 → **Medium**, 3+ → **High**. It is a sort key, not a verdict; the console says so. The old `unverified_numeric_content` flag is replaced by `unmatched_numbers`. `human_review_required` remains implicit (every brief).

Decline requires a reason (1–500 chars), stored as `decline_reason`, sent back to the client via §3, recorded in the audit summary.

### 5. Project verification with GeBIZ cross-check

- Projects gain `gebiz_tender_no text null`, `verification_note text null`, `verified_at timestamptz null`.
- The console computes the cross-check at render time from the dataset already loaded in the function (no storage, deterministic):
  - tender number given? If not: "No GeBIZ tender number given."
  - exists in the dataset? If not: "Not found in GeBIZ awards 2021-04 to 2026-03."
  - in the backtest hold-out and not yet revealed? Show only "In the backtest hold-out; not checked until revealed." (keeps the scoreboard honest).
  - otherwise show: agency on record vs claimed agency; supplier(s) on record and whether any **normalised** supplier name equals the normalised client name (uppercase, punctuation removed, whitespace collapsed, trailing `PTE LTD` / `PTE. LTD.` / `PRIVATE LIMITED` / `LTD` removed); awarded amount on record for the matching supplier row vs claimed value.
  - Result label: **Match** (exists, supplier matches) or **No match** (anything else). Exact equality after normalisation only; no fuzzy matching.
- Verify form: a note is **required** unless the result is Match; optional otherwise. Unverify also takes an optional note. Note, result label and tender number go into the audit summary.
- Demo clients are fictional, so their checks will honestly show "No match" or "No tender number given". That is a demo beat, not a bug.

### 6. Admin console refinement

Reference: `<local-path>` (`app/workspace/WorkspaceNav.tsx`, `reference.ts`, `collectionQuery.ts`, `CollectionHeader.tsx`, `StatusChip.tsx`). Patterns adopted, rendered as server HTML.

**Navigation groups** (sidebar, group label as a small uppercase heading; each page's header eyebrow names its group so page and rail agree):

- Home: **Overview** (inbox)
- **Decisions:** Briefs (count pending), Conflicts (count open)
- **Clients:** Clients (count), Projects (count awaiting verification)
- **Records:** Backtest, Audit log

**Readable references.** Postgres sequences per record type, assigned by column default, backfilled for existing rows in the migration. Format `PREFIX00001`, shown as `PREFIX00001 - Subject` where a subject exists:

| Record | Prefix | Subject |
|---|---|---|
| Client | `CLI` | client name |
| Project | `PRJ` | project title |
| Brief | `BRF` | tender number |
| Conflict | `CON` | tender number |
| Audit entry | `AUD` | action (from existing `bigserial` id) |

Tender numbers (`DST000ETT26000005`) are already readable and stay as they are. References appear in lists, detail headers, breadcrumbs, flash messages, audit rows, and in tool results returned to agents (for the client's own records only).

**Deep links.** Every record has a stable URL keyed by its reference; UUID URLs that exist today (`/briefs/<uuid>`) redirect to the reference URL.

- `/briefs/BRF00012`, `/conflicts/CON00002`, `/clients/CLI00003`, `/projects/PRJ00007`, `/audit/AUD00042`
- `/tenders/<tender_no>`: everything about one tender for the admin: briefs, conflict, hold state, and (after reveal) the outcome.
- Every mention of a record anywhere in the console is a link to its page: a brief links to its client, tender, cited projects and conflict; an audit row links to its record; a conflict links to both clients and the tender.
- Unknown references → 404 page with a link back to the list.

**Lists** (Briefs, Conflicts, Clients, Projects, Audit): a plain GET form (no JavaScript, explicit "Apply" button) with search `q`, `status`, and `sort`; defaults omitted from the URL; the detail page's "Back" link returns to the same filtered list (carry the query, as atrip's `returnHref`). Default status is "needs a decision" (pending / open / unverified), matching the rail counts.

- Briefs: status (pending, approved, declined, all), risk level, sort (risk then oldest | newest | oldest).
- Audit: filter by reference, client, tender, rule (G1–G6), outcome; search matches references.

**Status chips:** one shape, tone carries meaning: progress (pending, open), done (approved, verified, resolved), warning (Medium risk, escalated), danger (High risk, blocked, declined), neutral (Low risk, stopped). Always text plus tone, never colour alone.

**Screens that change:**

- *Overview inbox:* pending briefs sorted High → Low then oldest, each with reference, client, tender, risk chip and fact count; open conflicts; projects awaiting verification.
- *Brief detail:* header `BRF00012 - DST000ETT26000005`, risk level, then **Risk facts** list, then the band and citations (linked), then the agent's text under "Agent's draft (not checked for meaning)", then Approve / Decline with a required reason field for Decline.
- *Client detail (new):* profile, connector issued date, revoke credential, projects with cross-check results and verify forms, briefs, conflicts, shortlist.
- *Project detail (new):* cross-check facts, verify/unverify with note, history from the audit log.
- *Conflict detail (new):* tender, the two clients (admin view), hold state, resolution buttons.
- *Audit detail (new):* the full row and links to every record it names.

Visual direction stays as today (Stripe Dashboard × Attio, cobalt accent, status colours only for guardrail outcomes, readable on a compressed screen recording).

### 7. Skills

- **intake:** §1 changes (tender number, show connector once, paste instruction).
- **analyst:** pricing no longer takes a hold, so the confirmation moves to *before submitting the brief* ("submitting takes the advice slot for this tender; if another client already has it you'll be escalated"); the escalation message comes from `submit_brief`; adds "Where's my brief?".
- **scout:** remove the claim that pricing takes a hold; still never calls `request_pricing`.
- **proposal:** unchanged except reading approved briefs from `get_client_context` when present.
- `get_policies` text updated (G2 wording, "admin" not "admin" in agent-facing copy).

### 8. Demo storyline (≤ 3 min)

Seed (after the wipe): Birch Events (fictional) with one verified project and a client connector; a public intake credential; no Amber. Cedar Markets is created live via intake. Practice runs happen on a disposable branch or with a different company name, because names are unique and a production practice run would use up "Cedar Markets"; the reset runbook restores the new baseline before recording.

| # | Who | Beat | Rule on screen |
|---|---|---|---|
| 0 | Hashmeta site | Article + Get started (5 s) | |
| 1 | Cedar, intake chat | Register; paste-ready connector shown once | projects unverified |
| 2 | Admin | `CLI…` → `PRJ…`: cross-check "No match", verify one with a note; leave the self-reported gala unverified | evidence on screen |
| 3 | Cedar | Scout shortlist, labelled backtest (short) | G6 |
| 4 | Cedar | Band for DST000ETT26000005 (57 comps, S$208,800–S$1,153,109) | G4 |
| 5 | Cedar | Brief citing the gala → **blocked G3**; resubmit with the verified project → pending | G3 |
| 6 | Birch | Same band, submits → **escalated G2** "already advises another client" | G2 |
| 7 | Admin | `CON…` keep advising Cedar; `BRF…` risk facts → approve | G5 |
| 8 | Cedar | "Where's my brief?" → approved brief (short) | |
| 9 | Admin | Audit log filtered to the tender; backtest reveal: S$309,320 inside the band | append-only |

The rehearsal script (`npm run site:rehearse`) is updated to this sequence.

## Priorities and cut line (deadline-driven)

- **P0** (journey works): §1 connector issuance, §2 G2 move, §3 return path, §7 skills, migration + rehearsal, new demo baseline.
- **P1** (strength): §4 risk facts with brief detail and inbox sort; §5 cross-check + note; references and deep links for briefs, conflicts, clients, projects.
- **P2** (polish): nav groups, list filters, audit detail page, `/tenders/<no>`, revoke button, starter pack on the Hashmeta site.

If time runs out, P2 is cut first; the demo still works on P0 + P1.

## Known limitations (stated, not fixed)

- The intake key is public: anyone can register companies; no rate limit.
- A refused duplicate company name hints that the company is already a client.
- A lost one-time connector needs the admin; there is no self-service reissue.
- Brief prose is not checked for meaning; risk facts are signals, not a verdict.

## Left to the builder

- How the schema runner applies `001` + `002` on a fresh schema (local, PGlite tests, and the Node reseed script), and whether to rename `pricing_holds`.
- Number-matching rules for `unmatched_numbers` beyond "band figures and `n` in common formats".
- Slug rules for connector names and collision handling.
- Exact copy for console labels and agent messages within the wording above.
- Test updates across the existing 167 tests, plus new tests: token never in audit; G2 hold not taken when a brief is blocked; risk facts per threshold; cross-check normalisation and hold-out suppression; reference URLs and UUID redirects; GET filters round-trip.

## Docs to update after the build

`HANDOFF.md` (journey, storyline, reset runbook with the new baseline), `PRODUCT.md` (hosted, admin, backtest built, self-service SMEs), skills.
