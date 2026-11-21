---
name: tender-desk-marketing
description: Use when asked to write a Tender Desk data article, weekly market note, or promo video script from public Singapore government award statistics.
---

# Tender Desk Marketing

Write a short, honest data article about Singapore government contract awards, and optionally a promo script. This uses public data only. No client, brief, price band or admin information may appear.

## Input

The user pastes the output of `npm run data:report -- --category <category>` (a JSON report from the public GeBIZ awards dataset). If nothing is pasted, ask for it and stop. Do not use the Tender Desk client connectors for this task.

## Steps

1. Announce: "Using tender-desk-marketing."
2. Read the report: dataset source and date range, contract counts, `statistics_summary` (`n`, `price_band`, `top_agencies`) and the category counts.
3. Write 350 to 500 words with a plain headline, a one-line takeaway, three or four findings each tied to a number in the report, a short "what this means for a small business" section, and a footer naming the source (Government Procurement via GeBIZ, Ministry of Finance, data.gov.sg, Singapore Open Data Licence) and the date range.
4. State the limits: awards are historical totals, scope and duration differ, the quartile band is descriptive and not a quote or a prediction.
5. End with a soft call to action to "get matched", with no promise of winning.
6. If asked, add a 45 to 60 second promo script (voiceover plus on-screen text) using only claims already in the article.

## Never

- Never use a number that is not in the pasted report. Never round in a way that changes the meaning.
- Never mention a client, brief, advice slot, or any Tender Desk internal data.
- Never claim to predict winners, guarantee outcomes, or give legal or bid advice.
- Never describe the backtest as live tender discovery.
