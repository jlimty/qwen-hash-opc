# Tier 1 trust fixes: design

Date: 22 Nov 2026. Status: draft for the admin's approval.
Source: the persona review of 22 Nov. Three customers (an events owner, an experienced cleaning bidder, a first-time IT bidder), the admin, a design critic and a business critic. All six would not pay S$99 today, for the same reasons.

## Intent

Fix what stops a customer paying, and what makes the admin's daily work wrong or risky. Four areas:
- The numbers can be trusted.
- The product never sells a brief the customer obviously can't use.
- The paid brief looks like a finished deliverable.
- Payment is confirmed.

On the admin side: the console shows the paid work, records who did what correctly, and gives the admin what they need to judge a draft.

**Out of scope (tier 2 and 3):**
- editing a draft or redrafting with a note
- releasing exclusivity after a no-bid
- a single suggested price figure
- help text for jargon
- reworking the profile form
- a sample brief on the landing page
- subscriptions, team accounts, alerts
- wider feed coverage and a scheduled feed refresh

## What the review found, and the cause of each

| # | Finding | Cause in the code |
|---|---|---|
| 1 | A S$5 panel award counts as a comparable; ranges like S$19.46–S$2.5M | Every award above S$0 is used; nothing filters nominal awards or warns about wide bands |
| 2 | An events company is matched to an architectural Registered Inspector tender, then sold a "do not bid" | `categorize()` maps any title containing "consultancy" to `training-consultancy` |
| 3 | The home page and the free check disagree on the same tender (football: 13 awards vs too few) | The home page uses stored or keyword terms; the free check reads with Qwen and then caches. Two sources of terms |
| 4 | The search box shows two terms but only one was searched, with no explanation | The most-specific-term rule is real, but the page only says "Searched past awards for X" |
| 5 | The S$99 button shows on tenders with too few awards, and on tenders the customer already has a brief for | The home page shows the button on every matched row |
| 6 | The brief renders as raw `## Markdown` | The brief is stored as Markdown text and shown with `white-space: pre-wrap` (customer and console) |
| 7 | A project UUID leaks into the brief; "your only verified project…" next to "None cited" | The model wrote the ID into its prose; nothing rejects IDs; the prompt doesn't link mentioning a project to citing it |
| 8 | "Do not bid" is a green chip | `renderRequest` uses `chip done` for both verdicts |
| 9 | No payment confirmation | Checkout redirects to the plain request page |
| 10 | Paid requests are missing from the console overview | `renderOverview` builds "Needs your decision" from briefs, conflicts and projects only |
| 11 | The audit log credits the client with the admin's and the AI's actions | `who` checks `client_id` before `actor` (console-view.mjs:168, 358) |
| 12 | "Agency: Unknown" for live tenders on the brief review page | The brief detail looks the tender up only in the award dataset |
| 13 | The admin can't see which awards a band came from | The review page shows only the band |

## Decisions (my calls unless marked)

1. **Nominal awards are excluded from live comparables.** Awards under S$1,000 are not comparable prices (panel and schedule-of-rates awards record nominal values). Live price checks and briefs drop them before the five-award minimum is counted. Backtest snapshots are unchanged, so their `stat_id`s stay the same.
2. **Wide bands are labelled, not hidden.** When the upper quartile is more than 5× the lower quartile, the price check, the home row and the brief all show the band with a plain warning: "Wide range: past awards for this kind of work vary a lot, so treat it as a rough guide." That's honest about the data, and it doesn't throw away information.
3. **Categories come from Qwen, not the keyword rules.** When the feed refreshes, each new tender is read once by Qwen (`qwen3.8-flash`, about 2s) and its search terms and category are stored. The keyword rules remain only as the fallback when the model fails. The keyword rule also changes: "consultancy" alone no longer means training. It needs a training word (training, workshop, course, coaching).
4. **One set of terms per tender, everywhere.** The home page, the free check, checkout and the brief all use the stored terms. If a customer edits the terms on the free check, those edited terms carry into checkout, as now. The note under the terms becomes: "Matched on 'X', the most specific of these terms with at least five past awards."
5. **Purchase gate (the admin to confirm).** On the home page, the S$99 button shows only when the check is ready, the tender is in one of the customer's categories, and the customer has no brief on it yet. In that last case the button becomes "View your brief". At checkout, a tender outside the customer's categories shows a warning, and paying needs an explicit tick: "This tender is outside the categories in your profile. A brief may well say not to bid, and the S$99 is not refunded for that." *Alternative: a hard block.* I chose the warning because the categoriser can still be wrong, and a hard block would stop a customer who really does the work.
6. **The brief is rendered, not dumped.** The stored brief stays Markdown, because the MCP path and the audit already use it. A small server-side renderer turns the fixed subset (`## ` headings, `- ` bullets, paragraphs) into escaped HTML. It is used for both the customer and the console. The customer page puts the verdict on top in a coloured block (Bid green, Do not bid amber) and shows the price row (median, quartiles, number of awards) from the request's saved snapshot. The Markdown's own "Comparable awards" and "Limits" sections are folded into that row and the footer.
7. **No IDs or self-contradictions in a draft.** A draft whose prose contains a UUID or a reference code (`PRJ00001` style) is rejected, and the retry tells the model why. The prompt says: refer to projects by title, never by ID, and cite every project you mention.
8. **Payment confirmation.** After paying, the request page shows a confirmation banner: "Payment received (test mode) · S$99.00 · REQ00003 · <date>". It also shows a three-step timeline: Paid, then In review, then Brief ready, with the current step highlighted. There's no email: the page says the brief will appear on their home page. Email is tier 3.
9. **Console fixes:**
   - The overview's "Needs your decision" lists paid requests first, each with its age.
   - The audit log uses the stored actor first (admin, agent, customer), then the client name for customer actions. Every action has a plain label: request_brief, save_draft, register_customer, cancel_request, decline_request, draft_failed.
   - Agency and title fall back to the open-tender row.
   - The brief review page lists the comparable awards behind the band (tender number, description, agency, amount, date), flags any award outside 5× the median, and labels the band "lower quartile / median / upper quartile".

## Definition of done

- None of the 13 findings can be reproduced on the local copy with the seeded data.
- A fresh persona pass on the same screens (one customer and the admin) finds no tier 1 issue.
- The suite passes, and `assistant:rehearse` passes 8/8 with the real model.
- Deployed by the redeploy steps in `docs/handoff-assistant-cutover.md`, which needs the admin's yes.
