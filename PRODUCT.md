# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Two server-rendered web apps with no client JavaScript, served by one Qoder Sites (Deno) function together with the MCP endpoint, on Neon Postgres and Neon Auth: the customer app at /functions/v1/app/assistant and the admin console at /functions/v1/app/. A local Node launcher is kept as a fallback. Marketing site: Hashmeta AI Website Builder, separate from this repository.

## Users
Two audiences. SME owners in Singapore (cleaning, security, IT, events, renovation, training, catering firms of a few to a few dozen people) use the customer web app: usually the owner or a bid manager, at an office desk or on a phone between site visits, deciding in minutes whether a GeBIZ tender is worth the effort of a bid and what to price it at. They read GeBIZ daily, distrust hype, and count every dollar. First visit: they run a free price check on an open tender with no account; if the numbers help, they sign up (verified email and UEN) for one free reviewed brief, then buy credits. The admin is the single human inside Tender Desk: at a desk, alone, deciding what the agents cannot. His job: verify clients' past projects against public evidence, resolve conflicts between competing SMEs, approve or decline every brief, and read the audit trail. Hackathon judges watch a 3-minute demo video.

## Product Purpose
Tender Desk helps Singapore SMEs win government contracts. The customer app answers "is this tender worth bidding on, and at what price?": a free price check shows what comparable GeBIZ contracts were actually awarded for, and a paid reviewed brief (AI-drafted, approved by a person) advises bid or no-bid and where to price, citing only the client's checked projects. Agents do the work; governance is enforced in code at the tool layer, so the admin only decides what matters, from facts the code computes. Success: a judge watching the video sees an SME sign up, a guardrail block a bad brief, a conflict caught and resolved, an approved brief reach the client, every step in an audit log, and the backtest honestly scored.

## Positioning
Guardrails live in the tools, not the prompts: agents cannot approve their own work, see another client, cite unverified experience, or invent numbers. Price bands are public statistics anyone can get; what Tender Desk gives only one client per tender is its advice. The admin console is the only place human decisions happen.

## Operating Context
Hosted at a public URL (Qoder Sites + Neon), admin sign-in by allowlisted Neon Auth account. Data: real GeBIZ awards from data.gov.sg; tenders shown to agents are 2026 awards replayed as a backtest; demo clients are fictional. The console will be screen-recorded.

## Capabilities and Constraints
Admin actions: verify or unverify a project (a note is required without a GeBIZ match; exact GeBIZ matches are checked automatically when added, and the admin may uncheck them), approve a brief or decline it with a reason (sent to the client), resolve a conflict (keep advising the holder, or stop advising on that tender; advice is never transferred), revoke a client's connector, reveal backtest outcomes (irreversible), read and filter the audit log. Every record has a readable reference and its own page. Everything money-related is integer cents in SGD. Customers pay in credits: one brief costs 1 credit; 1 credit S$29, 5 for S$119, 20 for S$399; the first brief is free, one per company (UEN). Prices are database settings. Card payments are still in test mode (no card is charged) until terms, refund policy and PDPA notice exist.

## Brand Commitments
Working name Tender Desk (registered for the hackathon). No logo or brand assets exist.

## Evidence on Hand
Real GeBIZ dataset at data/GovernmentProcurementviaGeBIZ.csv: 12,052 awarded tenders, Apr 2021 to Mar 2026. Backtest: on 512 hold-out contracts awarded in 2026, 47% of actual awards fell inside the predicted middle-half range (a calibrated middle-half range should catch about 50%). No real customers, testimonials or payments exist and none may be fabricated; demo clients are labelled fictional.

## Product Principles
1. The admin decides; agents propose. Every consequential action is deliberate, with its reason visible and recorded. The one exception is a fact, not a judgement: a newly added project whose GeBIZ award names the client's company exactly is checked by code at once, recorded in the audit log as an automatic GeBIZ check, and the admin can uncheck it.
2. Show the rule that fired. Blocked and escalated events always name the guardrail and why.
3. Facts, not judgement: risk facts and verification evidence are computed by code; levels sort, they do not decide.
4. Never imply more assurance than exists: prose is not verified, the backtest is historical, a level is not a verdict.
5. Numbers are traceable to a saved snapshot.

## Accessibility & Inclusion
Readable on a screen recording: strong contrast, large enough text for video compression. Keyboard operable, no colour-only status (every chip carries text).
