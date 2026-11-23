# Handoff: deploy the customer redesign (23 Nov 2026)

This is for the Qoder agent that deploys Tender Desk. It assumes no other context. Follow the steps in order.

**Every step that changes production waits for the admin's explicit yes in chat.** A yes for one step is not a yes for the next. Never print a secret, a password or a database URL. Nothing here changes data or the database schema.

## What is being deployed

- **Code:** `main` at the commit that adds this file. `npm test` passes 474/474.
- **Live site today:** https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/assistant (project `01a1fc00-0331-71d8-8889-f9c1c96aca6d`). It runs the reviewed-brief release from `docs/handoff-qoder-deploy.md` (`cb8fe13`).
- **No migration.** The highest migration is still `005-credits-operator.sql`, which is already applied. Every column this release uses already exists.
- **What customers will see:**
  - **Landing page.** One box takes a GeBIZ tender number or a title, with a real example check beside it. Below that: tenders closing soon, how it works, prices from settings and the backtest figures.
  - **Free price check.** The answer comes first: the range, the median and a chart. The search terms and the awards table are folded away. A "Get your first brief free" button carries the tender through sign-up.
  - **Sign-up keeps the tender.** A new customer lands back on that tender's checkout after email confirmation, sign-in and the profile.
  - **Checkout.** One card shows when the tender closes, the cost ("Free: your first brief" or "Uses 1 credit"), when the brief will be ready, and what happens if we decline.
  - **Report.** The verdict and price range come first, then what could stop you, then why, questions for the agency and the projects cited.
  - **Home.** "Your briefs" comes first, with "usually ready by" on briefs in review. Tender rows are plain text, with no pills. A brief is offered only where it is worth a credit; otherwise the row says why.
  - **Credits.** Packs show the price per brief and the saving. No pack is highlighted while the free brief is unused.
  - **Tender titles.** Long GeBIZ titles are split into a short headline plus labelled facts.
  - **Working state.** Slow forms show a spinner and ignore a second press. This comes from one script, `/app.js`, which the page security policy now allows. Every form still works without it.
- **What changes for the admin:**
  - **Automatic project checks.** A newly added project whose GeBIZ tender number names the client's company exactly is marked checked as soon as it is saved. This is the same check the Verify button runs.
  - The audit log shows these checks as "Automatic GeBIZ check".
  - Anything without an exact match (private work, no number, a different name) still waits for the admin.

## Before you start (checks only, nothing changes)

1. On `main`, `npm test` prints `# fail 0`.
2. `npm run assistant:rehearse -- --fake-llm` prints `8/8 steps passed`.
3. `npm run site:migrate -- --db-file .local/site/db-unpooled.url --check` lists nothing pending. **If it lists a migration, stop and tell the admin.**

## Steps

1. **The admin says yes to the deployment.**

2. **Build and redeploy.**
   1. `npm run site:build`
   2. Call `prepare_site` with:
      - `webDirectory: site/dist`, `functionDirectory: site/functions`
      - `databaseAccess: none`
      - `secretNames: ["TD_OPENROUTER_KEY"]`
      - project `01a1fc00-0331-71d8-8889-f9c1c96aca6d`
      - a fresh action ID

      If it returns `descriptorStatus: pending`, retry with identical inputs. Don't use `databaseAccess: read_write`: the function talks to Neon directly, so that setting is rejected.
   3. Call `publish_site` with the same action ID.

3. **Health check.** `GET https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/health` returns `{"ok":true,"configured":true,"ai":true}`.

4. **Live walkthrough.** Do this in a browser, on the live site. Sign-ins use `.local/site/test-customers.json`. Never type those passwords anywhere except the live Tender Desk pages.
   1. **Landing.** `/assistant` shows the tender box, the example check and the closing-soon list. Open the browser console: no CSP errors, and `/app.js` loads with status 200.
   2. **Tender number.** Type an open tender number from the list into the box. The price check opens with the range first. Run one whose home row shows a figure: the award count must match what home shows for that tender.
   3. **Wrong number.** Type a tender number that isn't open (for example `XYZ000ETT26000001`). The page explains it instead of erroring.
   4. **Sign-up carries the tender.** On a price check, click **Get your first brief free**. The sign-up page shows that tender as the next step. Don't finish this sign-up.
   5. **Home.** Sign in as Aster. Check that:
      - "Your briefs" is listed first.
      - Tender rows have no coloured pills.
      - A row without a brief button says why ("Too few past awards for a brief" or "Closes too soon for a brief").
   6. **Checkout and credits.** Open a tender with a brief button and go to checkout. One card shows Closes, Cost, Ready and If we decline. Don't spend a credit unless the admin asks. Open **Credits**: the pack buttons line up.
   7. **Working state.** Submit a price check. The button shows a working label while it waits.
   8. **Console.** In the console (`/functions/v1/app/`, admin sign-in), the audit log still loads.

5. **Reinstall the operator skill.** the admin reinstalls `skills/tender-desk-operator/SKILL.md` in QwenWork. Step 6 now mentions the automatic exact-match checks. The connector itself doesn't change.

## Rolling back

- **Code:** redeploy the build from commit `4bbd436`, using the same `prepare_site` and `publish_site` inputs.
- **Data:** nothing to roll back. This release adds no migration.
  - The only new writes are automatic project checks. Each one is an ordinary `verified=true` with a note and an audit entry, and the admin can uncheck it in the console.

## Things to know

- **Automatic checks run only on new projects.** A project saved before this release, or one the admin has unchecked, is never checked automatically.
- **"Usually ready by"** is one business day after the request, skipping weekends. It does not know public holidays.
- **First load can be slow.** Home and the landing page still read new tenders with the AI on first view, as before. The first load after new tenders arrive can take a few seconds.

## Not in this release (don't promise them)

- A footer with the operator's name, contact email and a PDPA line; terms; a refund policy; a GST statement. The admin supplies these. Until then, card payments stay in test mode.
- A tax invoice or receipt line on purchases.
- Greeting customers by their own name. The app stores the company name, not the person's name.
