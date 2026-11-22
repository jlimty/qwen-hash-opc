# Tender Desk as an AI tender assistant: design

Date: 22 Nov 2026. Status: ready for the admin's approval. Builder questions answered.

## Intent

Tender Desk becomes a product a Singapore SME would actually use: a web-based AI tender assistant. The customer never touches QwenWork, skills or connectors.

The SME owner already sees tenders: GeBIZ emails trading partners about new opportunities. What they lack is judgement on each one. Two questions matter:

1. **Is this tender worth the days a bid takes?**
2. **What price should go in?**

Tender Desk answers both, from public GeBIZ award data. Every number comes from code. A person (the admin) approves every piece of advice.

The admin's bar: if this cannot ship as a whole, working product by the hackathon deadline (Mon 23 Nov 2026, 23:59 SGT), he does not submit. The design is shaped by what a customer needs, not by the judging criteria.

## Goals

- **Live open tenders.** Pulled from GeBIZ's official RSS feeds and matched to each customer.
- **Free instant check, no account needed.** Works on any tender: comparable past awards, price range, buyers, and how spread out the winners are. Every figure is traceable to the awards behind it.
- **Paid reviewed brief, S$99 each, account needed.** A bid/no-bid recommendation with a suggested price position. It cites only the customer's verified projects. Agents draft it and the admin approves or declines it before the customer sees it.
- **All existing guardrails stay in force:**
  - client walls
  - advice to one client per tender
  - verified projects only
  - price bands that match a saved snapshot
  - human approval
  - an audit log nobody can edit
- **The design leaves room for a chat box** (a later phase), without building it now.

## Non-goals (for this release)

- **Real payments.** Checkout is a mock, clearly labelled "Test mode: no card is charged". It is designed so Stripe Checkout can replace it later as a single change.
- **The free-form chat assistant.** That is phase 2, after the submission.
- **Email delivery.** Briefs live in the customer's account. Email notifications come later.
- **Uploading tender documents (PDF).** The customer pastes text instead.
- **Fetching or scraping GeBIZ tender detail pages.** Only the official RSS feeds are used.
- **Subscriptions, plans or invoices.**
- **Changes to the QwenWork MCP endpoint.** It keeps working but is no longer part of the customer product. The public starter pack (skills and intake connector) is retired from the website.

## Anti-goals (failure even if it "works")

- Any figure a customer sees that code did not compute from the award data.
- Any wording that implies a win probability or a winning price. GeBIZ publishes winning amounts only, not losing bids.
- Charging, even in mock mode, for a brief that cannot be given, for example because another client holds the tender.
- Any customer seeing another customer's data, or learning *who* holds a tender.
- An advice brief reaching a customer without the admin's approval.
- A page that looks finished but doesn't work: a dead button, a placeholder tender, or an unlabelled demo.

## Constraints

- **Hosting stays the same.** One Qoder Sites (Deno) function serves everything (`site/functions/index.ts` → `src/site-app.mjs`). It runs on Neon Postgres and uses Neon Auth. The console is server-rendered HTML with no client JS, and the customer app follows the same approach.
- **AI calls go through OpenRouter, using a Qwen model.** The key is a server secret (for example `TD_OPENROUTER_KEY`). The server currently has no AI in it, so this is new.
- **Live tender data comes from GeBIZ RSS, one feed per procurement subcategory.**
  - URL pattern: `https://www.gebiz.gov.sg/rss/<Subcategory_Name>-CREATE_BO_FEED.xml`
  - Confirmed live on 22 Nov 2026: Professional Services, Cleaning Services, Security Services, Catering Services, Event Organising, Courses.
  - Each item has: title, tender/quotation number, published date, closing date, calling entity (agency), and a GeBIZ link.
  - Items have no scope text and no estimated value.
  - Each feed shows only the latest few items (8 seen), so we store what we see and build up the list over time.
  - An unknown name returns an HTML "Page not found" with status 200. A feed is only counted as working if its response is XML.
- **Price data is historical.** The data.gov.sg awards dataset (`d_acde1106003906a75c3fa052592f2fcb`) covers Apr 2021 to Mar 2026, which the UI must state.
  - Comparables come from the existing `buildStatsSnapshot`: query-token prefixes plus exact category and agency filters, linear quartiles, and at least 5 comparables.
  - Every query token must match, so a full tender title usually matches nothing. Choosing a few good search terms is a real step (see "Reading a tender").
- **Deadline: 23 Nov 2026, 23:59 SGT.**

## Approaches considered

- **A. Chat-first assistant.** The customer chats, and a server-side model calls the tools for everything.
  - Pro: the purest "assistant".
  - Con: unbounded inputs are the place most likely to put a wrong number in front of a customer, and they can't be tested well in a day.
- **B. Assistant-shaped dashboard, with AI only where it earns its place.** Code computes every number, and AI handles two jobs: reading a tender into search terms, and drafting the brief.
  - Pro: it can ship and be tested by tomorrow.
  - Con: no free-form conversation yet.
- **C. B now, with A's chat box designed in and added after the submission.** **Chosen by the admin.** It ships a product that keeps the promise ("every number is computed, every brief is approved") and leaves the conversational layer for when it can be proven.

Separately, the admin chose **both** a free instant tier and a paid reviewed tier (over reviewed-only or instant-only), **per-brief pricing** (over a subscription), and a **mock payment** for now (no Stripe account yet).

## The product

### Who uses it

- **The SME owner (customer).** Works only on the web app.
- **The admin (operator).** The only person inside Tender Desk. Works in the existing admin console, which gets one new queue.

### Customer journey

1. **Lands on the app**, from the Hashmeta site's "Try a free price check" link. No sign-in is needed.
2. **Free instant check.** The customer picks an open tender from the live list, or pastes a tender's title and description (and the agency, if they know it). They see:
   - the search terms used, which they can edit
   - the comparable past awards (count, median, middle half), with the awards themselves listed (tender number, agency, supplier, amount, date)
   - the top buyers and how spread out the winners are
   - an "insufficient comparables" state when fewer than 5 awards match, with a suggestion to broaden the terms

   Every screen carries the limits: past awards up to Mar 2026, not a quote, not a winning price.
3. **Sign up.** Email and password through Neon Auth, then a company profile:
   - name
   - what the company does
   - categories
   - team size
   - largest contract it could deliver
   - past projects (title, agency, value, GeBIZ tender number if it was government work)

   Projects start **unverified**, and the UI says so plainly.
4. **Daily matches (home screen).** "Good morning, <company>": open tenders from the feed that match the customer's categories, newest first, each showing its closing date, the instant price check summary, and fit facts. Fit facts are computed by code:
   - the category matches
   - the price range sits within the customer's largest deliverable contract
   - N verified projects with related terms
5. **Ask for a reviewed brief (S$99).**
   - **Before checkout,** code checks whether the brief can be given:
     - Another client holds the tender → "Tender Desk already advises a client on this tender", with no charge.
     - No verified projects yet → the customer is told the brief can only cite verified projects, and may go ahead or wait.
   - **Mock checkout,** labelled test mode. A payment record is saved with status `test`.
   - **The request** shows "In review", with a target of one business day.
6. **Brief ready.** Once the admin approves it, the customer's account shows:
   - bid or no-bid, with reasons
   - a suggested price position, stated against the comparables band ("toward the lower quartile, because…") and never as a winning number
   - the verified projects cited
   - the comparables and their limits

   If the admin declines a request, the customer sees his reason. In mock mode, any real payment would be refunded (not applicable for now). The customer can then ask for a brief on another tender.

### Operator journey (console)

The existing console already has client verification, approvals, conflicts, audit and backtest. It gains a **brief requests** queue:

1. A new paid request appears, showing customer, tender and paid status.
2. The admin clicks **Draft**. The server builds the facts and asks the model for the draft (see below). The draft is saved as `pending_approval` through the existing brief path, so every existing guardrail and risk fact applies.
3. The admin reviews it in the existing brief page and approves it, or declines it with a reason the customer can read.

Project verification (with the GeBIZ cross-check) stays as it is. New customers' projects land in the existing verify queue.

### Live tenders

- **Feed list.** A configured list of GeBIZ RSS subcategory feeds, mapped to Tender Desk's categories:
  - Event Organising, Catering Services → `events-community` / `catering`
  - Cleaning Services → `cleaning-facilities`
  - Security Services → `security`
  - IT Services & Software Development → `ict-services`
  - Courses → `training-consultancy`
  - General Building & Minor Construction Works → `construction-renovation`
  - Professional Services → `training-consultancy` / `other`

  The builder confirms each feed returns XML and records the ones that don't.
- **Refresh.** When stored tenders are more than an hour old, the next page load triggers a refresh with a short timeout, a lock (one refresh at a time) and per-feed error isolation. The page always renders from the database, never waits on GeBIZ.
- **Storage.** A new `open_tenders` table:
  - tender number (key), title, agency, published and closing dates, GeBIZ link, source feed and mapped category
  - first-seen and last-seen times
  - the search terms derived for it

  Tenders past their closing date drop out of lists.

### Reading a tender (AI job 1)

- **Input.** A title (from the feed) or pasted text. The model (OpenRouter, a fast Qwen model) returns structured output: 1 to 3 search terms, a category from the fixed list, and the agency if stated.
- **Checks.** Code validates the output against the schema and the category enum. For feed tenders, the result is cached on the `open_tenders` row.
- **Fallback.** If the model fails or times out, code uses keyword rules (the existing category regexes plus title-token heuristics).
- **The customer can edit the terms,** and the price check reruns. The terms in use are always shown.
- **Abuse limits.** The anonymous check is rate-limited per IP, and pasted text is capped in length.

### Drafting the brief (AI job 2)

This is not an agent loop. It is one model call over facts that code assembled:

- **Facts:**
  - the tender (title, agency, closing date)
  - the stats snapshot (saved through the existing snapshot path, so `stat_id` and the price band check apply)
  - the customer's profile and **verified** projects only
  - computed fit facts
- **The model returns structured output:**
  - recommendation (`bid` / `no-bid`)
  - reasons
  - price-position text
  - the IDs of the verified projects it cites
- **Code checks before saving:**
  - cited IDs ⊆ that customer's verified projects
  - figures in the text match the snapshot (reusing the `brief-risk` figure check: a draft with unmatched figures is rejected, or saved with flags so the admin sees it)
  - the price band equals the snapshot
- **Saving.** The draft goes through the existing brief-submission path as `pending_approval`. That path is what holds the exclusive-advice rule and writes the audit log.

### Pricing and payment

- S$99 per reviewed brief, stored as integer cents (9900).
- **Mock checkout:**
  - a page with the amount, the tender and the company
  - a "Pay S$99 (test mode)" button
  - a banner: "Test mode: no card is charged"
- A `payments` record is saved with `status = 'test'`, tied to the brief request.
- The payment step is isolated so Stripe Checkout and its webhook can replace it.
- A mock "payment" happens only after the can-we-advise check passes.

### Website (Hashmeta)

- **Data article:** stays.
- **Product section:** rewritten around the assistant (free check, reviewed brief, the rules).
- **Get started:** "Try a free price check →" (the app) and "Create an account". QwenWork, skills, connectors and the starter pack disappear from the public site.
- **Promo script:** ends on the free check, not on installing skills.

## Data model changes (new migration `003`)

- **`open_tenders`**, as described above.
- **`customers`**, linking a Neon Auth user ID to a `clients` row. One user per client for now.
- **`brief_requests`:**
  - client, tender number, tender source (`feed` or `pasted`)
  - pasted text (if any) and search terms
  - status: `requested`, `drafted`, `approved`, `declined`, `cancelled`
  - links to the payment and the brief
  - timestamps
- **`payments`:**
  - request, amount in cents, currency, status (`test` for now; `paid` and `refunded` reserved for Stripe), timestamps

All writes are audited in the same transaction, as today.

**Pasted tenders.** They have no GeBIZ number, so the brief and exclusivity key needs a stable identifier. **Builder's call:** use a normalised hash of the agency plus title, prefixed (for example `PASTED-<hash>`). If the customer gives a real GeBIZ number, use that instead, so exclusivity still works across customers.

## Existing pieces this reuses

- `governance.mjs` / `governance-agent.mjs`: client creation, snapshots, briefs, exclusivity, audit. Call these in-process, the same way the MCP tools call them.
- `tender-stats.mjs`: comparables and the price band.
- `brief-risk.mjs`: the figure check and risk facts.
- `gebiz-check.mjs`: project verification.
- Console: approvals, verification, conflicts, audit.
- `neon-auth.mjs`: it already calls `/sign-in/email`, and there is a `signUpAdmin` helper for `/sign-up/email`. Customer sign-in needs its own session cookie, separate from the admin allowlist, so a customer can never reach the console.

## What happens to the backtest and the demo data

- The backtest stays in the console as a check on the method. It is not shown to customers.
- `get_incoming_tenders` (the 2026 holdout replay) is not used by the customer app. Live tenders replace it.
- **Builder's call:** customer price checks use all award history up to Mar 2026, including the 2026 holdout rows. The backtest's own snapshots stay fixed and separate, so its scoring is not affected.
- Birch Events (fictional) stays as a clearly labelled demo account, for walkthroughs. It is never shown to other customers.

## Definition of done (the ship bar)

A real person, with nothing but a browser, can do all of this in production, with no step faked except the labelled test-mode payment:

1. Open the app, see today's open tenders from GeBIZ with real closing dates, and run a free price check on one.
2. Paste a tender that isn't in the feed and get a price check, or an honest "too few comparables".
3. Sign up, create a company profile with projects, and see them as unverified.
4. The admin verifies a project in the console. The customer sees it as verified.
5. Ask for a reviewed brief, pass the mock checkout, and see "In review".
6. The admin drafts, reviews and approves it in the console. The customer sees the brief.
7. A second customer asking for a brief on the same tender is stopped before checkout, without learning who holds it.
8. Every step appears in the audit log.

Tests cover feed parsing (including the 200 "Page not found" case), the reading fallback, the draft checks (cited IDs, figures, band), the exclusivity check before payment, and customer/admin session separation.

If any of steps 1 to 8 doesn't work by the deadline, the admin does not submit.

## Decisions settled after the builder review (my calls, for the admin to check)

- **The tender slot is taken at request time, not draft time.** When a customer passes the "can we advise" check and completes checkout, the same transaction takes the exclusive-advice hold (`pricing_holds`) for that tender. A second customer is then stopped before checkout, without being charged. The hold is released when a request is declined or cancelled, because no advice was given. Today a decline leaves the hold in place, so this is a deliberate change to the exclusivity rule, and it is audited.
- **A draft that fails the checks is not saved.** This covers cited projects that aren't the customer's verified ones, figures that don't match the snapshot, and a band that doesn't match. The request stays `requested` with the failure reason visible to the admin. He can **Redraft**, which re-runs the model, or **Decline with a reason**. There is no editing of the brief text in this release. (With real payments, a decline would trigger a refund.)
- **Live and pasted tenders are kept in the audit log.** The audit log currently drops any tender number that isn't in the dataset, and that must be fixed.
- **Price snapshots for live and pasted tenders need a new path.** `request_pricing` only accepts holdout tenders today. Anonymous checks are computed on the fly and not saved, because `stats_snapshots.client_id` is required. Snapshots are saved only for signed-in customers who ask for a brief.

## the admin's answers (22 Nov 2026)

- **Production deploy.** Apply migration `003` to the live database without a wipe, keeping Birch and the audit history. Take a new Neon baseline branch afterwards. The admin approves the cut-over itself: the builder prepares a ready-to-run deploy step.
- **Customer sign-up.** Turn on open email sign-up in production Neon Auth, without email verification for this release. The builder also seeds **test customer profiles** (fictional, labelled as test). They come with sign-in credentials recorded in the git-ignored state directory, and with projects in different verification states. That way the journey can be tested without going through sign-up each time.
- **OpenRouter key.** It exists. The admin sets `TD_OPENROUTER_KEY` as a Sites secret today.
- **Hashmeta site.** A Qoder agent updates it. The builder writes a self-contained instruction file at `docs/hashmeta/site-update-instructions.md` for the admin to pass over: the new copy for each section, what to remove (QwenWork, skills, connectors, the starter-pack downloads and media), and the new links to the app. The ship bar includes a public site with no QwenWork, skills or starter-pack content.

## Phase 2 (not now)

- A chat box on the customer home that answers through the same in-process tools, with every reply's figures checked the same way.
- Stripe Checkout in place of the mock.
- Email when a brief is ready, and a daily match digest.
- PDF upload.

## Left to the builder

- **Which Qwen model on OpenRouter.**
  - Reading tenders: a cheap fast one, for example `qwen/qwen3.8-flash`.
  - Drafting: a stronger one, for example `qwen/qwen3.8-max-0902`.
  - Use structured output, with timeouts and a retry.
- Exact page layout, following the console's visual system.
- The final list of feed subcategories and their category mapping.
- Rate limits and text caps.
- How fit facts are worded.
