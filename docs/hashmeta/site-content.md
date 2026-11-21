# Tender Desk: Hashmeta site content

Copy for the Hashmeta AI Website Builder. Paste each section into its own block.

- Every number in section 1 comes from `npm run data:report -- --category events-community`, run on 21 Nov 2026 (dataset `d_acde1106003906a75c3fa052592f2fcb`, award dates 2021-04-01 to 2026-03-31). Section 4 reuses only those numbers.
- Placeholders in `{{double braces}}` are download links the admin fills in. No real key appears anywhere in this file. Never paste one into the site.

---

## 1. Data article

### Who buys events in Singapore's public sector? 195 contract awards, in numbers

**Takeaway:** Events and community work is a small, spread-out corner of government buying. No single agency or supplier dominates it.

Between April 2021 and March 2026, GeBIZ records 12,052 government contracts. Our keyword tagging puts 204 of them in events and community work: exhibitions, event management, venues, festivals and outreach. 195 of those have an awarded amount above zero, and those 195 are the basis for every figure below.

**1. The typical award is in the hundreds of thousands.** The median award is S$386,500. The middle half of awards sits between S$157,730 and S$1,001,185. That is a wide range, and it reflects very different scopes, from a single exhibition design to multi-year venue panels.

**2. Two agencies buy the most, but neither dominates.** People's Association and Science Centre Board each awarded 20 of the 195 contracts, about 10% each. Then come Singapore Tourism Board (11), Urban Redevelopment Authority (10) and National Heritage Board (9). Buyers are spread across many agencies, so a small firm is not depending on one buyer.

**3. No supplier has locked up the category.** The most frequent winner took 14 of the 195 awards, about 7%. The next most frequent took 6. Many of the repeat names are hotels that win places on venue and catering panels, not event agencies.

**4. The work keeps coming.** Recent awards include exhibition design and multimedia production for the National Library Board (S$926,580, December 2025) and LED screen rental for a Chingay event for People's Association (S$170,000, December 2025).

#### What this means for a small business

If you run events, exhibitions or community programmes, government work is not one big buyer you have to win over. It is many agencies, each buying a few times a year, with no supplier holding a large share. The useful questions are which agencies buy what you do, and what similar contracts were actually awarded for. Public award data answers both before you spend days on a bid.

#### Limits

- These are historical award totals, not quotes or predictions. Scope and contract length differ between awards, often a lot.
- The S$157,730 to S$1,001,185 range is the middle half (quartiles) of past awards. It describes the past and is not a price to bid.
- The category comes from keyword matching on tender descriptions, so a few contracts may be tagged wrongly.
- This shows who won, not who bid or why they won.

#### Get matched

Tender Desk reads the same public data to show you which public-sector events tenders fit your track record, and what comparable contracts were awarded for. Every brief is checked by a person before you see it. We do not promise wins. We help you decide where your effort is worth it. [Get matched →](#get-started)

*Source: Government Procurement via GeBIZ, Ministry of Finance, Singapore, published on data.gov.sg under the Singapore Open Data Licence. Award dates 2021-04-01 to 2026-03-31. Figures computed by Tender Desk from 12,052 contracts; events and community category: 204 contracts, 195 with a positive award amount.*

<!-- Word count of the article body (headline to call to action, excluding the source footer): 472. -->

---

## 2. Product

### Tender Desk: tender advice for Singapore SMEs, with a person in charge

Tender Desk is a one-person tender advisory for small and medium businesses in Singapore. You work with Tender Desk's agents in QwenWork chat. They find government tenders that fit your track record, look up what similar contracts were awarded for, and draft a brief on whether to bid. The admin, the one person who runs Tender Desk, decides what reaches you. Agents prepare. The admin decides.

All of this runs on public Singapore government award data (GeBIZ, via data.gov.sg).

### The rules, and the code that enforces them

Each rule below is enforced by the server and the database, not by asking the AI nicely. An agent that ignores its instructions still cannot break them.

| Rule | In plain words | What enforces it |
|---|---|---|
| **Client walls** | Agents can't see other clients. | Each company gets its own connector key, and the server ties that key to one company. Every request is answered for that company only. A brief that names another client is refused. |
| **Exclusive advice** | Tender Desk advises only one client per tender. | When a brief is submitted, the database records which client Tender Desk is advising on that tender. A second client is stopped and sent to the admin. They are told only that Tender Desk already advises someone, never who. |
| **Verified projects only** | Only verified projects can be cited, checked against GeBIZ. | A brief can cite only that client's own projects that the admin has verified. Before verifying, the admin sees the project's GeBIZ tender number checked against the public award record: agency, supplier and amount. |
| **Grounded prices** | Price bands come from saved statistics. | The price band in a brief must match, figure for figure, a statistics snapshot the server computed and saved for that client and tender. Snapshots cannot be edited afterwards. |
| **Human approval** | Every brief is approved by a human. | Agents can only submit a brief as pending. Only the admin's signed-in console can approve or decline it, and a decline must give a reason the client can read. |
| **Audit trail** | Every step is audit-logged. | Every agent call and admin decision is written to an audit log in the same database transaction. A database trigger rejects any edit or deletion of the log. Connector keys are never written to it. |
| **Honest backtest** | The backtest is scored honestly. | The 536 most recent awards (from 1 January 2026) are held out. Price bands for them come only from older contracts, are fixed in advance, and are hidden from agents. The admin reveals the real outcomes only after that, and hits and misses are both counted. |

**About the backtest:** the tenders Tender Desk's agents show today are past awards from that held-out period, used to test the method. They are labelled as backtest, not live opportunities.

---

## 3. Get started {#get-started}

Three steps, all inside QwenWork.

**Step 1: Install the four Tender Desk skills.**
Download each skill. Each is a .zip containing one `SKILL.md`. In QwenWork, open **Install Skill** and add them one at a time.

- [tender-desk-intake.zip]({{INTAKE_SKILL_ZIP_URL}}): registers your company.
- [tender-desk-scout.zip]({{SCOUT_SKILL_ZIP_URL}}): finds tenders that fit you.
- [tender-desk-analyst.zip]({{ANALYST_SKILL_ZIP_URL}}): prices a tender and drafts your brief.
- [tender-desk-proposal.zip]({{PROPOSAL_SKILL_ZIP_URL}}): turns an approved brief into a proposal outline.

**Step 2: Add the intake connector.**
Download [tender-desk-intake.json]({{INTAKE_CONNECTOR_JSON_URL}}), copy its contents, and paste them into **QwenWork → Connectors**. The intake connector can do only one thing: register a new company.

**Step 3: Start a chat with "Register my company".**
Intake asks for your company details and past projects. If a project was a government contract, give its GeBIZ tender number so the admin can check it. At the end, intake shows your **personal connector**. Paste it into QwenWork → Connectors the same way as step 2. It is shown only once, so paste it straight away. If you lose it, contact Tender Desk.

Your personal connector works for your company only. The admin verifies your projects before they can be cited in a brief.

---

## 4. Promo script (about 55 seconds)

| Time | Voiceover | On-screen text |
|---|---|---|
| 0:00–0:06 | Between April 2021 and March 2026, Singapore's government awarded 195 events and community contracts with a published amount. | **195 events and community awards** · GeBIZ, Apr 2021 to Mar 2026 |
| 0:06–0:14 | The median award was three hundred and eighty-six thousand five hundred dollars. And no supplier took more than about seven percent. | **Median S$386,500** · Top supplier: 14 of 195 |
| 0:14–0:22 | Tender Desk is a one-person tender advisory for Singapore SMEs. You work with its agents in QwenWork chat. The admin decides. | **Agents prepare. The admin decides.** |
| 0:22–0:38 | The rules are enforced in code, not prompts. Agents can't see other clients. Tender Desk advises only one client per tender. Only verified projects can be cited, checked against GeBIZ. Price bands come from saved statistics. | Client walls · Exclusive advice · Verified projects · Saved statistics |
| 0:38–0:46 | Every brief is approved by a human. Every step is audit-logged. And the backtest is scored honestly. | Human approval · Append-only audit log · Honest backtest |
| 0:46–0:55 | Install four skills, paste the intake connector, and say "Register my company". Get matched. | **Get matched** · Install skills → Add connector → "Register my company" |

*Footer card (final frame): Data: Government Procurement via GeBIZ, Ministry of Finance, data.gov.sg, Singapore Open Data Licence. Past awards, not a quote or a promise of winning.*
