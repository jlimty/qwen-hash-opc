# Handoff: tender assistant cut-over (22 Nov 2026)

State at the end of the session. The runbook is `docs/runbook-assistant-cutover.md`; this records what actually happened and what is left.

## Where things stand

- **Live:** https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/assistant. `/health` returns `{"ok":true,"configured":true,"ai":true}`.
- **Code:** `main` at `e70d87a` (on top of `ceb8deb`). Deployed from that tree. The generated `.Tender Desk.qoder.site` descriptor in the repo root is deliberately untracked.
- **Verified live in a real browser:** runbook walkthrough steps 1-7 (tender list, free check, pasted tender, Aster sign-in, test-mode checkout, console draft and approve, Bramble blocked at checkout, audit log). Aster sees the approved brief.
- **Tests:** 344/344. `assistant:rehearse` is 8/8 with `--fake-llm` and with the real model.

## What changed beyond the runbook

1. **Draft retries (`ceb8deb`).** The real-model rehearsal failed 6/8 because the model wrote "half" and nothing retried. `draftBrief` now retries up to three times, feeding the refusal back to the model. Validation is unchanged.
2. **Admin in the database (`e70d87a`).** A mis-pasted `TD_ADMIN_USER_ID` setting took the whole site down at startup. The admin user ID now lives in `tender_desk.settings` (migration `004-settings.sql`) and is read on every check, so a change applies at once. No row means nobody is admin: the console locks, customer pages keep working. The `TD_ADMIN_USER_ID` setting in Sites is ignored and can be deleted.

## Accounts and files (all on the admin's Mac, mode 0600, never in git)

| What | Where |
| --- | --- |
| Console admin | `console-admin@tenderdesk.invalid`, password in `~/.td-admin-pass-new` |
| Old admin | `the original admin email`, now refused by the console. Its ID is in `.local/site/admin-user-id.old.txt` |
| Stale weak-password file | `~/.td-admin-pass` (safe to `rm`) |
| Test customers (Aster, Bramble, Clover) | `.local/site/test-customers.json` |
| OpenRouter key | `~/.td-openrouter-key` locally; `TD_OPENROUTER_KEY` secret in Sites Settings |
| Neon Auth URL, DB URL | `~/.td-auth-url`, `.local/site/db-unpooled.url` |

Change the admin: `npm run site:admin -- --email <email> --password-file <file>`, then `npm run site:set-admin`.

## Redeploying

1. `npm run site:build`
2. `prepare_site` with `webDirectory: site/dist`, `functionDirectory: site/functions`, `databaseAccess: none`, `secretNames: ["TD_OPENROUTER_KEY"]`, project `01a1fc00-0331-71d8-8889-f9c1c96aca6d`, and a fresh action ID. If it returns `descriptorStatus: pending`, retry with identical inputs.
3. `publish_site` with the same action ID, then check `/health`.

`databaseAccess: read_write` is rejected: the function talks to Neon directly, and the Sites-managed database is disabled.

## Rollback points (Neon branches)

- `before-assistant`: production just before migration 003. Restoring it also removes 003, 004, the test customers and the practice rows.
- `assistant-baseline`: after 003 and the walkthrough, but before 004. After restoring it, run `site:migrate` and `site:set-admin`.
- `demo-baseline-v2` and `demo-baseline` predate 003. Never restore them.

## Practice data now on production

Test customers, REQ00001 and BRF00001 (an approved no-bid brief for Aster on `INDAVIETQ26000027`), and their audit rows. These are permanent. Bramble is correctly blocked on that tender.

## Open items

- **Hashmeta site update: deferred.** QwenWork builds the new site and the admin passes it over. Then run the checklist in `docs/hashmeta/site-update-instructions.md` against the published page. Copy is in `docs/hashmeta/site-content.md`.
- **Hourly visit to `/assistant`** to keep the open-tender list current is not set up (see the runbook's "Things to know").
- **Test projects PRJ00005 and PRJ00006** (Bramble, Clover) are unverified, so the console shows them as "needs your decision". Verify or ignore.

## Gotchas

- The browser automation's clicks did not submit the console login form. `form.requestSubmit()` did.
- The console login throttles at five failed attempts a minute per address.
- Sites secret fields are masked, so a bad paste cannot be seen. This is why the admin no longer lives there.
- The in-memory test database allows one connection at a time, so new site-app tests should reuse the shared app instance.
