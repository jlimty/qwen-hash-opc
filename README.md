# Tender Desk

Tender Desk helps Singapore SMEs decide whether a government tender is worth bidding on, and at what price. It was built for the QwenWork x Hashmeta AI One-Person Company hackathon.

An SME owner pastes in an open GeBIZ tender and gets a free price check: what comparable contracts were actually awarded for. If the numbers help, they sign up and buy a reviewed brief. An AI drafts the brief, a person approves it, and it advises bid or no-bid and where to price, citing only the client's checked projects.

## What makes it different

Guardrails live in the tools, not the prompts. The code enforces these rules, so an agent cannot get around them:

- Agents cannot approve their own work.
- Agents cannot see another client's data.
- Agents cannot cite experience that has not been verified.
- Agents cannot invent numbers. Every figure traces to a saved snapshot.
- Only one client is advised per tender, and that advice is never transferred.

The admin is the only human decision point. They verify projects, resolve conflicts, approve or decline every brief, and read the audit log. The single exception is a fact rather than a judgement: a new project whose GeBIZ award names the client's company exactly is checked by code, recorded in the audit log, and can be unchecked by the admin.

## Two web apps

Both are server-rendered with no client-side JavaScript, and are served by one Qoder Sites (Deno) function along with the MCP endpoint.

| App | Path | Who uses it |
| --- | --- | --- |
| Customer app | `/functions/v1/app/assistant` | SME owners: price check, brief, credits |
| Admin console | `/functions/v1/app/` | The admin: verification, approvals, conflicts, audit log |

Hosting is Qoder Sites with Neon Postgres and Neon Auth. A local Node launcher is kept as a fallback.

## Data and backtest

The data is the real GeBIZ awards dataset from data.gov.sg, in `data/GovernmentProcurementviaGeBIZ.csv`: 12,052 awarded tenders from April 2021 to March 2026.

The tenders shown to agents are 2026 awards replayed as a backtest. On 512 hold-out contracts, 47% of actual awards fell inside the predicted middle-half range. A calibrated range should catch about 50%. The backtest is historical and says nothing about future awards. Demo clients are fictional, and there are no real customers or payments.

## Pricing

Customers pay in credits. One brief costs one credit, and the first brief is free (one per company UEN). Prices are database settings, and all money is stored as integer cents in SGD. Card payments are in test mode and no card is charged.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Governance engine, MCP server, GeBIZ data and statistics, brief drafting and risk facts, customer and admin apps |
| `db/` | Numbered SQL migrations (`001` to `005`) |
| `scripts/` | Server launcher, site build, seed, migrate and rehearsal scripts |
| `skills/` | Agent skills: scout, analyst, intake, proposal, operator, marketing, connection check |
| `test/` | Automated tests (Node's built-in test runner) |
| `data/` | GeBIZ award dataset |
| `docs/` | Design specs, plans, runbooks and handoff notes |
| `PRODUCT.md` | Product purpose, users, principles and constraints |

## Getting started

Requires Node.js 22 or later.

```bash
npm install
npm test
```

Run the local fallback server. It uses an embedded Postgres (PGlite) under `.local/`, with the MCP endpoint on port 8788 and the admin console on port 8789:

```bash
npm run server -- --seed-demo
```

Other useful scripts:

| Command | What it does |
| --- | --- |
| `npm run data:report` | Summarise the GeBIZ dataset |
| `npm run governance:demo` | Run the guardrail demo end to end |
| `npm run mcp:smoke` | Smoke-test the MCP connector |
| `npm run site:build` | Build the Qoder Sites function |
| `npm run site:migrate` | Apply database migrations to the hosted database |
| `npm run site:rehearse` | Rehearse the full storyline against a database |

## Configuration

Hosted deployment reads its settings from environment variables, kept out of the repository (`.env*` is git-ignored):

- `DATABASE_URL` and `DATABASE_URL_UNPOOLED`: Neon Postgres connection strings
- `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL`: Neon Auth, used for admin and customer sign-in

Never commit credentials. Production resets and migrations should only be run deliberately, using the scripts in `scripts/` and the runbooks in `docs/`.

## Further reading

- [PRODUCT.md](PRODUCT.md): who it is for and the principles it follows
- [docs/superpowers/specs/](docs/superpowers/specs/): design specs
- [docs/runbook-assistant-cutover.md](docs/runbook-assistant-cutover.md): production cut-over runbook
