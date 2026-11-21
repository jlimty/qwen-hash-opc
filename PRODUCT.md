# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Founder console: plain server-rendered Node HTML/CSS with no client JavaScript, served from the same local process as the MCP endpoint (recommended by the agent; the user asked about tradeoffs and did not object). Marketing site: Hashmeta AI Website Builder, built by the admin, separate from this repository.

## Users
The admin: the single human in a one-person Singapore tender advisory. Works at a desk, alone, reviewing what QwenWork agents produced. Job: approve or decline client-facing briefs, verify clients' past projects, resolve pricing conflicts between competing SMEs, and read an audit trail. Later audiences (not built): SME clients via a portal, hackathon judges watching a 3-minute demo video.

## Product Purpose
Tender Desk helps Singapore SMEs win government contracts. QwenWork agents do intake, scouting, analysis and proposal outlines. Governance is enforced in code at the tool layer, so the founder only decides what matters. Success: a judge watching the video sees one run from intake to approved brief, a conflict caught and resolved by the founder, and every step in an audit log.

## Positioning
Guardrails live in the tools, not the prompts: agents cannot approve their own work, see another client's data, or invent numbers. The founder console is the only place those human decisions happen.

## Operating Context
Local loopback console on the founder's machine for the hackathon demo (QwenWork x Hashmeta, video due 23 Nov 2026). Data: real GeBIZ awards from data.gov.sg; clients in the demo are fictional. The console will be screen-recorded.

## Capabilities and Constraints
Founder actions available in the backend: review brief (approve/decline), verify or unverify a project, resolve a conflict (serve the current holder or stop service; never transfer disclosed pricing), read audit log. Not yet built: backtest reveal and scoreboard, client portal. Everything money-related is integer cents in SGD. Founder authentication is a locally stored secret; no real user accounts.

## Brand Commitments
Working name Tender Desk (registered for the hackathon). No logo or brand assets exist.

## Evidence on Hand
Real GeBIZ dataset at data/GovernmentProcurementviaGeBIZ.csv. No real customers, testimonials or payments exist and none may be fabricated; demo clients are labelled fictional.

## Product Principles
1. The founder decides; agents propose. Every consequential action is a deliberate, reversible-looking choice with its reason visible.
2. Show the rule that fired. Blocked and escalated events always name the guardrail and why.
3. Never imply more assurance than exists: local only, prose is not verified, backtest not yet revealed.
4. Numbers are traceable to a saved snapshot.

## Accessibility & Inclusion
Readable on a screen recording: strong contrast, large enough text for video compression. Keyboard operable, no colour-only status.
