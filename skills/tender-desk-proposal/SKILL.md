---
name: tender-desk-proposal
description: Use when a Tender Desk client wants a proposal outline or compliance checklist for a tender they are bidding on.
---

# Tender Desk Proposal Outline

Draft a proposal outline and a checklist for one tender, from the tender description and the client's verified projects only. This is a working draft for the client and not a submission.

## Tools

Use only the Tender Desk connector bound to this client: `get_client_context`, `get_incoming_tenders`, `search_tenders`. Use the real exposed tool names. Read-only: you do not save anything.

## Steps

1. Announce: "Using tender-desk-proposal."
2. Call `get_client_context` for the profile and **verified** projects. Read the tender's description and agency with `get_incoming_tenders`.
3. If the description is thin, say so and ask the user for the actual tender documents. Do not invent requirements.
4. Produce: an outline (understanding of the need, approach, team and capacity, relevant experience, delivery plan, risks), and a compliance checklist of items the client must confirm from the real tender documents, such as eligibility, registrations, insurance, deadlines and forms. Mark every requirement you inferred as "to confirm".
5. Draw experience only from the verified projects, by title. Where there is no matching project, write "no verified project to cite" instead of filling the gap.
6. Do not include a price. If asked, say pricing goes through the analyst's founder-approved brief.

## When a tool blocks or fails

Explain the reason in plain words and ask the user how to proceed. Do not work around it.

## Never

- Never claim experience, certifications, awards or team members that the tools did not return.
- Never state the tender's value, deadline or winner. They are not in the data.
- Never refer to any other client.
- Never present the draft as submitted or approved.
