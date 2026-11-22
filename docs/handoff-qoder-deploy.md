# Handoff: deploy the reviewed-brief release (22 Nov 2026)

This is for the Qoder agent that deploys Tender Desk. It assumes no other context. Follow the steps in order.

**Every step that changes production waits for the admin's explicit yes in chat.** A yes for one step is not a yes for the next. Never print a secret, a password or a database URL. Nothing here wipes data.

## What is being deployed

- **Code:** `main` at `cb8fe13` in this repository. `npm test` passes 461/461.
- **Live site today:** https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/assistant (project `01a1fc00-0331-71d8-8889-f9c1c96aca6d`). It still runs the first cut-over build (`e70d87a`).
- **Main changes customers will see:**
  - Credits at S$29. Packs of 5 cost S$119 and packs of 20 cost S$399. The first brief is free, one per company (UEN). Purchases are in test mode.
  - Sign-up needs a verified email and a UEN.
  - A profile assistant fills in the profile from pasted text and from the company's own GeBIZ awards.
  - Before a credit is spent, checkout lists profile gaps and the closing date. Tenders closing within 2 days can't be requested.
  - "Ask for more": the admin can send a request back with a message. The client has 5 days, or until 2 days before closing, to reply. After that the request closes and the credit is refunded.
  - Thin evidence (under ten awards, or awards spread more than five times apart) shows a rough spread, never quartiles.
- **Main changes for the admin:**
  - A console with brief requests, separate Ask and Decline forms, and a tick to approve a high-risk brief.
  - An operator connector for the admin's own QwenWork.

## Files and accounts (on the admin's Mac, mode 0600, never in git)

| What | Where |
| --- | --- |
| Production DB URL (unpooled) | `.local/site/db-unpooled.url` |
| Neon Auth URL | `~/.td-auth-url` |
| OpenRouter key | `~/.td-openrouter-key`; already set as the `TD_OPENROUTER_KEY` secret in Sites |
| Console admin | `console-admin@tenderdesk.invalid`, password in `~/.td-admin-pass-new` |
| Test customers (Aster, Bramble, Clover) | `.local/site/test-customers.json` |

## Before you start (checks only, nothing changes)

1. On `main`, `npm test` prints `# fail 0`.
2. `npm run assistant:rehearse -- --fake-llm` prints `8/8 steps passed`.
3. The admin confirms both settings below in the Neon console:
   - **Neon Auth → email verification is on.** New sign-ups get a "check your email" page.
   - **Neon Auth → trusted domains includes `tender-desk-bz2oc52nag4.qoder.website`.** Without it, the verification link in the email is refused.

## Steps

1. **The admin says yes to the deployment.**

2. **Safety branch (rollback point).**

   ```bash
   neon branches create --name before-tier2-3 --parent production
   ```

3. **Check what will migrate.** Expected output: `Pending: 005-credits-operator.sql`. 004 is already applied; if it is listed too, that is fine.

   ```bash
   npm run site:migrate -- --db-file .local/site/db-unpooled.url --check
   ```

4. **Migrate in place.** Expected output: `Clients before: N, after: N`.
   - 005 adds credits, prices, the operator role, review notes, brief parts, UEN, hold expiry, and the Ask-for-more columns.
   - Existing customers keep their data, but start with 0 credits and no UEN.

   ```bash
   npm run site:migrate -- --db-file .local/site/db-unpooled.url
   ```

5. **Mark the old test customers as verified.** They were created before email verification existed, so they can't sign in until this runs. The admin runs it in the Neon SQL editor:

   ```sql
   SELECT id, email, "emailVerified" FROM neon_auth."user" WHERE email LIKE '%@tenderdesk.invalid';
   UPDATE neon_auth."user" SET "emailVerified" = true WHERE email LIKE '%@tenderdesk.invalid';
   ```

6. **Build and redeploy.**
   1. `npm run site:build`
   2. Call `prepare_site` with:
      - `webDirectory: site/dist`, `functionDirectory: site/functions`
      - `databaseAccess: none`
      - `secretNames: ["TD_OPENROUTER_KEY"]`
      - project `01a1fc00-0331-71d8-8889-f9c1c96aca6d`
      - a fresh action ID

      If it returns `descriptorStatus: pending`, retry with identical inputs. `databaseAccess: read_write` is rejected: the function talks to Neon directly.
   3. `publish_site` with the same action ID.

7. **Health check.** `GET https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/health` returns `{"ok":true,"configured":true,"ai":true}`.

8. **Revoke the old customer and intake connector keys.** This includes the intake key that was published on the Hashmeta site.
   - The check prints `Legacy keys found: client: N, intake: N`.
   - The second command prints `Revoked N of N.`

   ```bash
   npm run site:revoke-legacy -- --db-file .local/site/db-unpooled.url --check
   ```

   ```bash
   npm run site:revoke-legacy -- --db-file .local/site/db-unpooled.url
   ```

9. **Live walkthrough.** Do this in a browser, on the live site. Sign-ins use `.local/site/test-customers.json`. Never type these passwords anywhere but the live Tender Desk pages.
   1. `/assistant` lists open GeBIZ tenders. Pick one whose home row shows a figure, and run its free price check. The award count must match what home shows for that tender.
   2. Sign up with a new address. The "check your email" page appears. Don't finish this sign-up.
   3. Sign in as Aster. Home shows its projects. Open a tender and go to checkout. "Before you spend a credit" and the closing date are shown.
   4. Spend a credit. The request shows "Requested".
   5. In the console (`/functions/v1/app/`, admin sign-in), open **Brief requests**. Use **Ask the client for more…**: type a message and send it. The queue shows "Waiting for the client" and a reply-due date.
   6. As Aster, open the request. "Needs your reply" shows a "Reply by" date. Click **Resubmit**.
   7. In the console, click **Draft**, open the brief, then **Approve**. If the brief is high risk, tick the box first. Aster sees the report.
   8. As Bramble, open checkout for the same tender. It is refused, and does not say who holds it.
   9. The audit log shows each step. Normal steps have no pill; Approved, Declined and Blocked do.

10. **Set up the admin's QwenWork back office.**
    1. In the console, open **QwenWork** and click **Issue a connector**. The JSON is shown once: hand it to the admin, don't save it.
    2. The admin pastes it into QwenWork → Connectors and installs `skills/tender-desk-operator/SKILL.md`.

11. **New baseline.**

    ```bash
    neon branches create --name tier2-3-baseline --parent production
    ```

12. **Hashmeta site.** Follow `docs/hashmeta/site-update-instructions.md`. The copy is in `docs/hashmeta/site-content.md`.

## Rolling back

- **Code:** redeploy the build from commit `e70d87a`.
- **Data:** run the command below. It also removes migration 005.

  ```bash
  neon branches restore production before-tier2-3 --preserve-under-name production-tier2-3-attempt
  ```

## Things to know

- **Prices are settings, not code.** They live in `tender_desk.settings`: `credit_price_cents`, `credits_per_brief`, `welcome_credits` and `credit_packs` (`credits:cents` pairs). A changed row applies at once. A single credit is always on sale at `credit_price_cents`.
- **No scheduler.**
  - Overdue "Ask for more" requests close the next time anyone opens a page that reads requests.
  - The open-tender list refreshes when someone opens the app, at most once an hour.
- **Existing production customers have no UEN.** New sign-ups must give one. One UEN can register one company.
- **Home reads tenders with the AI on first view.** It reads each new tender into search terms, waiting up to 6 seconds, and stores them. The first home load after new tenders arrive can take a few seconds.
- **Practice data on production is permanent.** Use the test customers.

## Not in this release (don't promise them)

- Terms, a refund policy, a PDPA notice, the operator's name and UEN on the site, and a GST statement. The admin supplies these. Until then, card payments stay in test mode.
- Comparables are matched by keywords. A broad search term can pull in unrelated work, so the admin checks the comparable awards table on every brief.
- UENs are not yet checked against bizfile automatically. The console's project-check page reminds the admin to confirm them.
