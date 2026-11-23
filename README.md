# Tender Desk

Tender Desk helps Singapore SMEs decide whether a government tender is worth bidding on, and at what price. It was built for the QwenWork x Hashmeta AI One-Person Company hackathon.

An SME owner pastes in an open GeBIZ tender and gets a free price check: what comparable contracts were actually awarded for. If it helps, they sign up and buy a reviewed brief. An AI drafts the brief, a person approves it, and it advises bid or no-bid and where to price, citing only the client's checked projects.

## Guardrails

The rules are enforced in code at the tool layer, not in prompts:

- Agents cannot approve their own work.
- Agents cannot see another client's data.
- Agents cannot cite unverified experience.
- Agents cannot invent numbers. Every figure traces to a saved snapshot.
- Only one client is advised per tender.

The admin is the only human decision point: they verify projects, resolve conflicts, approve or decline briefs, and read the audit log.

## Apps

Two server-rendered web apps with no client-side JavaScript, served by one Qoder Sites (Deno) function on Neon Postgres and Neon Auth:

- Customer app at `/functions/v1/app/assistant`
- Admin console at `/functions/v1/app/`

## Data

Real GeBIZ awards from data.gov.sg (`data/GovernmentProcurementviaGeBIZ.csv`, April 2021 to March 2026). Demo clients are fictional.

## Run locally

Requires Node.js 22 or later.

```bash
npm install
npm test
npm run server -- --seed-demo
```

The local server uses an embedded Postgres under `.local/`, with the MCP endpoint on port 8788 and the admin console on port 8789.

## Configuration

The hosted deployment reads these environment variables, which are kept out of the repository:

- `DATABASE_URL`, `DATABASE_URL_UNPOOLED`: Neon Postgres
- `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL`: Neon Auth
