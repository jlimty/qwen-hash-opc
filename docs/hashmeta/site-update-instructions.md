# Instructions: update the Tender Desk site on Hashmeta

For a Qoder agent with no other context. Follow the steps in order.

## What changed

Tender Desk is no longer something customers set up in QwenWork. It is now a web-based AI tender assistant at:

**https://tender-desk-bz2oc52nag4.qoder.website/functions/v1/app/assistant**

Customers don't install skills, paste connectors or download anything. The site must say nothing about QwenWork, skills, connectors or a starter pack.

## The site

- **Live site:** https://tenderdesk.geo.hashmeta.tech
- **Source of truth for every word of copy:** `docs/hashmeta/site-content.md` in the Tender Desk repository (the admin will paste or attach it). Use its text exactly. Don't rewrite, shorten or add claims.

## Steps

1. **Data article (section 1).** Keep the article as it is. Change only two things to match `site-content.md` section 1:
   - The call to action under "Get matched" becomes the link **Try a free price check →**, pointing to the app URL above.
   - The sentence before it now begins "Tender Desk reads the same public data. Paste any open tender and see, for free…"
2. **Product section.** Replace the whole section with `site-content.md` section 2: the heading "Tender Desk: your AI tender assistant, with a person in charge", the two offers (free price check, reviewed brief S$99), the rules table and the "What we never claim" paragraph.
3. **Get started section.** Replace the whole section with `site-content.md` section 3:
   - the three numbered items
   - the test-mode line
   - item 1 links to the app URL
   - item 2 links to the app URL followed by `/signup`
4. **Promo video script**, if it appears on the site. Replace it with `site-content.md` section 4.
5. **Remove** everything below, both the links on the page and the files in the media library:
   - `tender-desk-intake.zip`
   - `tender-desk-scout.zip`
   - `tender-desk-analyst.zip`
   - `tender-desk-proposal.zip`
   - `tender-desk-intake.json`
   - any text mentioning QwenWork, skills, Install Skill, connectors, Connectors settings, or "Register my company"
6. **Publish** the site.

## Final checklist

Do each check on the published site, not the editor.

- [ ] Searching the page for "QwenWork", "skill", "connector" and ".zip" finds nothing.
- [ ] Opening `https://tenderdesk.geo.hashmeta.tech/api/media/file/tender-desk-intake.json` no longer returns the file. That file contained an access key, so it must be gone.
- [ ] "Try a free price check" opens the app, which lists open GeBIZ tenders.
- [ ] "Create an account" opens the app's sign-up page.
- [ ] Get started shows the credit price (S$29, first brief free), the sample brief link, and the line "Credit purchases are in test mode while we launch: no card is charged."
- [ ] No page says S$99.
- [ ] The source note under the data article is still there (GeBIZ, Ministry of Finance, data.gov.sg, Singapore Open Data Licence).

Report back to the admin with the checklist results.
