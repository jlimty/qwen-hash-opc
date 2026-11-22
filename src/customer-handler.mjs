// The customer web app: open tenders, the free price check, sign-up, the test-mode checkout and brief requests.
// Routes arrive relative to the app root ("/", "/check", "/home" ...). No client JavaScript; every POST carries the
// page's CSRF token, matched against a cookie scoped to this app.
import { randomBytes } from 'node:crypto';
import { consoleCss } from './console-css.mjs';
import { assistantCss, creditWord, layout, renderCheck, renderCheckout, renderCredits, renderHome, renderLanding, renderProfile, renderRequest, renderSignin, renderSignup } from './customer-view.mjs';
import { feedRefreshedAt, getOpenTender, listOpenTenders } from './gebiz-feed.mjs';
import { cleanTerms, fitFacts, pastedTenderNo, priceCheck } from './price-check.mjs';
import { parseReference } from './references.mjs';
import { categorize, tenderCategories } from './tender-data.mjs';
import { keywordTerms, maxTenderText, readTender } from './tender-reading.mjs';

const maxBodyBytes = 256 * 1024;
const checksPerHour = 20;
const customerChecksPerHour = 60;
const sessionSeconds = 7 * 24 * 60 * 60;
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const css = consoleCss + assistantCss;

function parseCents(text) {
  const clean = String(text ?? '').replace(/[,\sS$]/gi, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(clean)) return undefined;
  const [whole, fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function profileFromForm(form) {
  const categories = form.getAll('categories').filter((c) => tenderCategories.includes(c));
  const team = Number(String(form.get('team_size') ?? '').trim());
  const max = parseCents(form.get('max_contract'));
  const past_projects = [];
  for (let i = 0; i < 6; i++) {
    const title = String(form.get(`project_title_${i}`) ?? '').trim();
    if (!title) continue;
    const value = String(form.get(`project_value_${i}`) ?? '').trim();
    const agency = String(form.get(`project_agency_${i}`) ?? '').trim();
    const gebiz = String(form.get(`project_gebiz_${i}`) ?? '').trim();
    const value_cents = value ? parseCents(value) : undefined;
    if (value && value_cents === undefined) return { error: `Project ${i + 1}: enter the value as a number of dollars.` };
    past_projects.push({ title: title.slice(0, 250), ...(agency && { agency: agency.slice(0, 250) }), ...(value_cents !== undefined && { value_cents }),
      ...(gebiz && { gebiz_tender_no: gebiz.slice(0, 100) }) });
  }
  if (!String(form.get('name') ?? '').trim()) return { error: 'Enter your company name.' };
  if (!String(form.get('capabilities') ?? '').trim()) return { error: 'Describe what your company does.' };
  if (!categories.length) return { error: 'Choose at least one category.' };
  if (!Number.isInteger(team) || team < 1) return { error: 'Enter your team size as a whole number.' };
  if (max === undefined) return { error: 'Enter the largest contract you could deliver, in dollars.' };
  return { profile: { name: String(form.get('name')).trim().slice(0, 150), capabilities: String(form.get('capabilities')).trim().slice(0, 4000),
    categories, team_size: team, max_contract_cents: max, past_projects } };
}

export function createCustomerHandler({ desk, dataset, auth, llm, models = {}, database, basePath = '', secureCookies = false, refresh, waitUntil, now = () => new Date() }) {
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=${basePath || '/'}${secureCookies ? '; Secure' : ''}`;
  const checks = new Map();
  const withBase = (html) => (basePath ? html.replaceAll('href="/', `href="${basePath}/`).replaceAll('action="/', `action="${basePath}/`) : html);
  const respond = (status, type, body, { headers = {}, cookies = [] } = {}) => {
    const response = new Response(body, { status, headers: { 'Content-Type': type, ...securityHeaders, ...headers } });
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  };
  const text = (status, message) => respond(status, 'text/plain; charset=utf-8', message);
  const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? '')?.[1];

  async function freshen() {
    if (typeof refresh !== 'function') return;
    const running = Promise.resolve().then(refresh).catch(() => {});
    if (typeof waitUntil === 'function') { waitUntil(running); return; }
    await Promise.race([running, new Promise((resolve) => { setTimeout(resolve, 5000).unref?.(); })]);
  }
  async function readForm(request) {
    if (Number(request.headers.get('content-length') ?? 0) > maxBodyBytes) throw new Error('too large');
    const body = await request.text();
    if (body.length > maxBodyBytes) throw new Error('too large');
    return new URLSearchParams(body);
  }
  function allowCheck(key, limit) {
    const at = now().getTime();
    const recent = (checks.get(key) ?? []).filter((time) => at - time < 3600000);
    if (recent.length >= limit) { checks.set(key, recent); return false; }
    recent.push(at);
    checks.set(key, recent);
    if (checks.size > 5000) checks.delete(checks.keys().next().value);
    return true;
  }
  const tenderTerms = (row) => (row.terms?.length ? row.terms : keywordTerms(row.title).terms);

  async function readFeedTender(row) {
    if (row.terms?.length) return { terms: row.terms, category: row.category };
    const reading = await readTender({ title: row.title, agency: row.agency }, { llm, model: models.read });
    if (reading.terms.length) await database.query('UPDATE tender_desk.open_tenders SET terms=$1 WHERE tender_no=$2', [reading.terms, row.tender_no]).catch(() => {});
    return { terms: reading.terms, category: row.category };
  }

  return async function handle(request, route) {
    const url = new URL(request.url);
    const path = route || '/';
    const post = request.method === 'POST';
    if (request.method !== 'GET' && !post) return text(405, 'Method not allowed');
    if (path === '/app.css' && !post) return respond(200, 'text/css; charset=utf-8', css);
    const cookieHeader = request.headers.get('cookie');
    const existingCsrf = cookieValue(cookieHeader, 'td_ccsrf');
    const csrf = /^[a-f0-9]{64}$/.test(existingCsrf ?? '') ? existingCsrf : randomBytes(32).toString('hex');
    const baseCookies = csrf === existingCsrf ? [] : [`td_ccsrf=${csrf}; ${cookieFlags}; Max-Age=${sessionSeconds}`];
    let balance;
    const html = (status, body, { cookies = [], headers } = {}) => respond(status, 'text/html; charset=utf-8',
      withBase(body.replace('<!--credits-->', balance === undefined ? '' : `<a class="credit-pill" href="/credits">${creditWord(balance)}</a>`)),
      { cookies: [...baseCookies, ...cookies], headers });
    const redirect = (location, { cookies = [] } = {}) => respond(303, 'text/plain', null, { headers: { Location: `${basePath}${location}` }, cookies: [...baseCookies, ...cookies] });

    const rawSession = cookieValue(cookieHeader, 'td_customer');
    let userId;
    if (rawSession) { try { userId = await auth.verify(decodeURIComponent(rawSession)); } catch { userId = undefined; } }
    let customer;
    if (userId) { try { customer = await desk.customer(userId); } catch { customer = undefined; } }
    const company = customer ? (await customer.context()).client.name : undefined;
    if (customer) balance = (await customer.credits()).balance;
    const sessionCookie = (session) => `td_customer=${encodeURIComponent(session)}; ${cookieFlags}; Max-Age=${sessionSeconds}`;

    let form;
    if (post) {
      try { form = await readForm(request); } catch { return text(413, 'Payload too large'); }
      const supplied = form.get('csrf') ?? '';
      if (supplied.length !== 64 || supplied !== existingCsrf) return text(403, 'This page expired. Go back, reload it and try again.');
    }

    if (path === '/' && !post) {
      if (customer) return redirect('/home');
      await freshen();
      return html(200, renderLanding({ tenders: await listOpenTenders(database, { now: now() }), refreshedAt: await feedRefreshedAt(database), csrf }));
    }

    if (path === '/check' && post) {
      // The last forwarded address is the one the platform's proxy appended; earlier entries are client-supplied.
      const ip = (request.headers.get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean).pop() || 'local';
      if (!(customer ? allowCheck(`customer:${userId}`, customerChecksPerHour) : allowCheck(`ip:${ip}`, checksPerHour))) return html(429, layout({ title: 'Slow down', csrf, body: '<p class="banner bad" role="alert">You have run a lot of checks this hour. Create a free account, or try again later.</p>' }));
      const typedTerms = cleanTerms(String(form.get('terms') ?? ''));
      const tenderNo = String(form.get('tender_no') ?? '').trim();
      let tender; let reading; let notice;
      if (tenderNo) {
        const row = await getOpenTender(database, tenderNo);
        if (!row) return redirect('/');
        tender = row;
        reading = typedTerms.length ? { terms: typedTerms, category: row.category } : await readFeedTender(row);
      } else {
        const title = String(form.get('title') ?? '').trim().slice(0, 300);
        if (!title) return redirect('/');
        const rawText = String(form.get('text') ?? '');
        if (rawText.length > maxTenderText) notice = `Only the first ${maxTenderText} characters were read.`;
        tender = { pasted: true, title, agency: String(form.get('agency') ?? '').trim().slice(0, 250), text: rawText.slice(0, maxTenderText) };
        reading = typedTerms.length ? { terms: typedTerms, category: categorize(`${title} ${tender.text}`) }
          : await readTender({ title, agency: tender.agency, text: tender.text }, { llm, model: models.read });
      }
      const check = priceCheck(dataset, { terms: reading.terms, category: reading.category });
      let refusal;
      if (customer) {
        const allowed = await customer.canRequest(tender.pasted ? pastedTenderNo(tender) : tender.tender_no, { now: now() });
        if (allowed.reason === 'held') refusal = allowed.message;
        if (allowed.reason === 'closed') refusal = 'This tender has closed.';
      }
      return html(200, renderCheck({ tender, reading, check, csrf, company, notice, refusal }));
    }

    if (path === '/signup' && !post) return customer ? redirect('/home') : html(200, renderSignup({ csrf }));
    if (path === '/signup' && post) {
      let result;
      try { result = await auth.signUp({ email: form.get('email'), password: form.get('password'), name: form.get('name') }); } catch { result = { ok: false, message: 'Sign-up is unavailable right now. Try again shortly.' }; }
      if (!result.ok) return html(400, renderSignup({ csrf, message: result.message }));
      return redirect('/profile', { cookies: [sessionCookie(result.session)] });
    }
    if (path === '/signin' && !post) return customer ? redirect('/home') : html(200, renderSignin({ csrf }));
    if (path === '/signin' && post) {
      let result;
      try { result = await auth.signIn({ email: form.get('email'), password: form.get('password') }); } catch { result = { ok: false, message: 'Sign-in is unavailable right now. Try again shortly.' }; }
      if (!result.ok) return html(401, renderSignin({ csrf, message: result.message }));
      return redirect('/home', { cookies: [sessionCookie(result.session)] });
    }
    if (path === '/signout' && post) {
      if (rawSession) { try { await auth.signOut(decodeURIComponent(rawSession)); } catch { /* a malformed cookie is simply cleared */ } }
      return redirect('/', { cookies: [`td_customer=; Max-Age=0; ${cookieFlags}`] });
    }

    // Everything below needs a signed-in account.
    if (!userId) return redirect(path === '/checkout' || path === '/checkout/start' ? '/signup' : '/signin');
    if (path === '/profile') {
      if (customer) return redirect('/home');
      if (!post) return html(200, renderProfile({ csrf }));
      const values = Object.fromEntries([...form.keys()].filter((k) => k !== 'csrf' && k !== 'categories').map((k) => [k, form.get(k)]));
      values.categories = form.getAll('categories');
      const parsed = profileFromForm(form);
      if (parsed.error) return html(400, renderProfile({ csrf, message: parsed.error, values }));
      const created = await desk.registerCustomer(userId, parsed.profile);
      if (created.outcome !== 'allowed') return html(400, renderProfile({ csrf, message: created.reason, values }));
      return redirect('/home');
    }
    if (!customer) return redirect('/profile');

    if (path === '/home' && !post) {
      await freshen();
      const context = await customer.context();
      const tenders = await listOpenTenders(database, { categories: context.client.categories, now: now(), limit: 15 });
      const verified = context.projects.filter((p) => p.verified);
      const owned = new Map(context.requests.filter((r) => ['requested', 'drafted', 'approved'].includes(r.status)).map((r) => [r.tender_no, r.reference]));
      const matches = tenders.map((tender) => {
        const check = priceCheck(dataset, { terms: tenderTerms(tender), category: tender.category });
        return { tender, check, ownRequest: owned.get(tender.tender_no), fit: fitFacts({ client: context.client, verifiedProjects: verified, tender, check }) };
      });
      for (const match of matches) if (!match.ownRequest) match.taken = (await customer.canRequest(match.tender.tender_no, { now: now() })).reason === 'held';
      return html(200, renderHome({ context, matches, refreshedAt: await feedRefreshedAt(database), csrf }));
    }

    if ((path === '/checkout' && !post) || path === '/checkout/start') {
      const params = post ? form : url.searchParams;
      let tender;
      if (!post) {
        tender = await getOpenTender(database, String(url.searchParams.get('tender') ?? ''));
        if (!tender) return redirect('/home');
      } else {
        const title = String(form.get('title') ?? '').trim().slice(0, 300);
        if (!title) return redirect('/home');
        tender = { pasted: true, title, agency: String(form.get('agency') ?? '').trim().slice(0, 250), text: String(form.get('text') ?? '').slice(0, maxTenderText) };
      }
      const typed = cleanTerms(String(params.get('terms') ?? ''));
      const terms = typed.length ? typed : tender.pasted ? keywordTerms(`${tender.title} ${tender.text}`).terms : tenderTerms(tender);
      const requested = String(params.get('category') ?? '');
      const category = tenderCategories.includes(requested) ? requested : tender.pasted ? categorize(`${tender.title} ${tender.text}`) : tender.category;
      const allowed = await customer.canRequest(tender.pasted ? pastedTenderNo(tender) : tender.tender_no, { now: now() });
      if (allowed.reason === 'active' || allowed.reason === 'approved') return redirect(`/requests/${allowed.request_reference}`);
      const thin = priceCheck(dataset, { terms, category }).status !== 'ready';
      const refusal = allowed.reason === 'held' ? allowed.message : allowed.reason === 'closed' ? 'This tender has closed.'
        : thin ? 'A reviewed brief needs at least five comparable awards. Go back to the price check and try other search terms.' : undefined;
      const noChecked = !(await customer.context()).projects.some((project) => project.verified);
      const outside = !(await customer.context()).client.categories.includes(category);
      return html(200, renderCheckout({ tender, company, csrf, refusal, terms, category, noChecked, outside, credits: await customer.credits(),
        requirements: post ? String(form.get('requirements') ?? '').slice(0, 4000) : '' }));
    }
    if (path === '/checkout' && post) {
      const tenderNo = String(form.get('tender_no') ?? '').trim();
      const terms = cleanTerms(String(form.get('terms') ?? ''));
      const requested = String(form.get('category') ?? '');
      const category = tenderCategories.includes(requested) ? { category: requested } : {};
      const requirementsText = String(form.get('requirements') ?? '').trim().slice(0, 4000);
      const extra = { ...category, ...(requirementsText && { requirements: requirementsText }) };
      const input = tenderNo ? { tender_no: tenderNo, terms, ...extra }
        : { pasted: { title: String(form.get('title') ?? '').trim().slice(0, 300), ...(String(form.get('agency') ?? '').trim() && { agency: String(form.get('agency')).trim().slice(0, 250) }),
          ...(String(form.get('text') ?? '').trim() && { text: String(form.get('text')).slice(0, maxTenderText) }) }, terms, ...extra };
      const tenderCategory = category.category ?? (tenderNo ? (await getOpenTender(database, tenderNo))?.category : categorize(`${input.pasted.title} ${input.pasted.text ?? ''}`));
      if (!(await customer.context()).client.categories.includes(tenderCategory) && form.get('confirm_outside') !== 'yes') {
        const shown = tenderNo ? (await getOpenTender(database, tenderNo)) ?? { tender_no: tenderNo, title: tenderNo } : { pasted: true, ...input.pasted };
        return html(409, renderCheckout({ tender: shown, company, csrf, terms, category: tenderCategory, outside: true, credits: await customer.credits(),
          notice: 'Tick the box to confirm you want a brief on a tender outside your categories, then pay again.' }));
      }
      const result = await customer.requestBrief(input, { now: now() });
      if (result.outcome === 'allowed' && !result.reason?.startsWith('This request already exists')) {
        return redirect(`/requests/${result.request_reference}`, { cookies: [`td_paid=${result.request_reference}; ${cookieFlags}; Max-Age=600`] });
      }
      if (result.outcome === 'allowed' || result.request_reference) return redirect(`/requests/${result.request_reference}`);
      const tender = tenderNo ? (await getOpenTender(database, tenderNo)) ?? { tender_no: tenderNo, title: tenderNo } : { pasted: true, ...input.pasted };
      return html(409, renderCheckout({ tender, company, csrf, refusal: result.reason, terms }));
    }

    if (path === '/credits' && !post) return html(200, renderCredits({ company, csrf, credits: await customer.credits() }));
    if (path === '/credits/buy' && post) {
      const result = await customer.buyCredits({ credits: Number(form.get('credits')) });
      if (result.outcome !== 'allowed') return html(400, renderCredits({ company, csrf, credits: await customer.credits(), notice: result.reason }));
      return redirect('/credits');
    }

    const requestRoute = /^\/requests\/([^/]+)$/.exec(path);
    if (requestRoute && !post) {
      const ref = parseReference(requestRoute[1]);
      const mine = ref?.prefix === 'REQ' ? (await customer.context()).requests.find((r) => r.reference === requestRoute[1]) : undefined;
      if (!mine) return html(404, layout({ title: 'Not found', csrf, company, body: '<p class="banner bad">That request was not found.</p><p><a href="/home">Back to home</a></p>' }));
      const justPaid = cookieValue(cookieHeader, 'td_paid') === mine.reference;
      const byNumber = mine.comparables?.length ? new Map(dataset.contracts.map((c) => [c.tender_no, c])) : new Map();
      const awards = (mine.comparables ?? []).map((c) => ({ c, contract: byNumber.get(c.tender_no) })).filter(({ contract }) => contract)
        .map(({ c, contract }) => ({ tender_no: c.tender_no, cents: Number(c.total_awarded_cents), description: contract.description, agency: contract.agency,
          date: contract.last_award_date, winner: contract.suppliers.filter((x) => x.awarded_cents > 0).map((x) => x.name).join(', ') }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      return html(200, renderRequest({ request: mine, company, csrf, justPaid, awards }), { cookies: justPaid ? [`td_paid=; Max-Age=0; ${cookieFlags}`] : [] });
    }
    return html(404, layout({ title: 'Not found', csrf, company, body: '<p class="banner bad">That page was not found.</p><p><a href="/">Open tenders</a></p>' }));
  };
}
