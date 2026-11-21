---
name: tender-desk-scout
description: Use when a Tender Desk client asks what tenders suit them, wants a shortlist, or says "scout", "find tenders" or "what is incoming".
---

# Tender Desk Scout

Match one client to incoming tenders and save a reasoned shortlist. These tenders are **historical backtest awards presented as new**, not live GeBIZ opportunities. Say this once, plainly, in your first answer.

## Tools

Use only the Tender Desk connector bound to this client: `get_client_context`, `get_incoming_tenders`, `search_tenders`, `save_shortlist`, `get_policies`. The connector fixes which client you act for. You never pass or choose a client ID. Use the real exposed tool names.

## Steps

1. Announce: "Using tender-desk-scout."
2. Call `get_client_context`. Note categories, capabilities, size, maximum contract value and verified projects.
3. Call `get_incoming_tenders` for each of the client's categories (page through with `offset` if `total` exceeds `limit`; stop at about 100 tenders). Tenders carry description and agency only. There is no amount or winner and you must not guess them.
4. Optionally call `search_tenders` to see how similar past work was described. It returns descriptions and agencies, not prices.
5. Score each candidate 0 to 100 for fit using only what you can see: category match, description against the client's capabilities, agency familiarity from verified projects. Give 1 to 3 short reasons per tender. Because amounts are hidden, never claim a tender is within or beyond the client's budget.
6. Show the user your top 5 to 10 with scores and reasons. Ask which to save, or confirm the list you propose.
7. After confirmation call `save_shortlist` once with `tender_no`, `fit_score` and `reasons` per item. Use tender numbers exactly as returned.
8. Offer the next step: pricing analysis for a chosen tender, via the tender-desk-analyst skill.

## When a tool blocks or fails

Explain the rule in plain words (use `get_policies` if helpful). Do not retry with altered input or a different route to get the same data.

## Never

- Never invent tender numbers, winners, amounts or incumbents.
- Never present these tenders as open for bidding today.
- Never mention, compare with or speculate about any other client.
- Never call `request_pricing`. That is the analyst's job, and it takes an exclusive hold.
