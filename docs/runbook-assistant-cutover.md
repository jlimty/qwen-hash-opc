# Runbook: putting the tender assistant live

Branch `tender-assistant`. Every step that changes production waits for the admin's explicit yes. Nothing here wipes data.

## Before you start

- `npm test` passes, and `npm run assistant:rehearse -- --fake-llm` prints `8/8 steps passed`.
- With the OpenRouter key: `OPENROUTER_API_KEY=<key> npm run assistant:rehearse` prints `8/8`. Read the printed brief: no sentence may state a number that isn't in its "Comparable awards" line.

## Steps

1. **The admin says yes.**
2. **Safety branch (rollback point):**

   ```bash
   neon branches create --name before-assistant --parent production
   ```

3. **Check what will migrate.** Expected output: `Pending: 003-assistant.sql`.

   ```bash
   npm run site:migrate -- --db-file .local/site/db-unpooled.url --check
   ```

4. **Migrate in place.** Expected output: `Clients before: N, after: N`. The old function keeps working on the new tables.

   ```bash
   npm run site:migrate -- --db-file .local/site/db-unpooled.url
   ```

5. **Sites Settings → secrets (the admin).** Set `TD_OPENROUTER_KEY`. `TD_MODEL_READ` (default `qwen/qwen3.8-flash`) and `TD_MODEL_DRAFT` (default `qwen/qwen3.8-max-0902`) are optional.
6. **Neon Auth (the admin).** Turn on email sign-up, without email verification. The console still admits only the admin's user ID.
7. **Build and redeploy the Sites function:**

   ```bash
   npm run site:build
   ```

   Then redeploy `site/`.
8. **Health check.** `GET https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/health` returns `{"ok":true,"configured":true,"ai":true}`.
9. **Seed the test customers.** Their sign-in details go to `.local/site/test-customers.json` (mode 0600, never printed).

   ```bash
   npm run site:test-customers -- --db-file .local/site/db-unpooled.url --auth-url-file ~/.td-auth-url
   ```

10. **Live walkthrough** (spec definition of done, steps 1–8):
    1. Open `…/functions/v1/app/assistant`, which lists today's GeBIZ tenders. Run a free check.
    2. Paste a tender that isn't in the list.
    3. Sign in as `test+aster@tenderdesk.invalid`. Home shows checked projects.
    4. Ask for a reviewed brief on an open tender: test-mode checkout, then "In review".
    5. In the console, open **Brief requests**, click **Draft**, open the brief, then **Approve**. Aster sees the brief.
    6. Sign in as `test+bramble@tenderdesk.invalid` and open the same tender's checkout. It must show "Tender Desk already advises a client on this tender." with no pay button.
    7. The audit log shows each step.
11. **New baseline:**

    ```bash
    neon branches create --name assistant-baseline --parent production
    ```

    `demo-baseline-v2` predates migration 003: never restore it.
12. **Hashmeta site.** Pass `docs/hashmeta/site-update-instructions.md` to the Qoder agent, then run its checklist.

## Rolling back

- **Code:** redeploy the previous `site/` build from `main`.
- **Data:** `neon branches restore production before-assistant --preserve-under-name production-assistant-attempt`.

## Things to know

- **The open-tender list builds over time.** Each GeBIZ feed shows only recently published tenders (27 across the eight feeds on 22 Nov), and the list refreshes when someone opens the app, at most once an hour. If nobody visits for a day, tenders published that day can be missed. A scheduled hourly visit to `/assistant` closes that gap; it isn't set up yet.
- **Search terms decide the comparables.** With the key set, Qwen reads each tender into search terms; without it, a keyword fallback is used, which is cruder. The price-check page always shows the terms used, and the customer can edit them.
- **Practice runs on production are permanent.** They create real accounts, requests and audit rows. Practise with the test customers, or on a Neon branch.
- **Audit rows from before the rename** store the old operator name; the console shows them as the admin.
