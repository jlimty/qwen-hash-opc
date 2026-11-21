import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { consoleCss } from './console-css.mjs';
import { renderAudit, renderBacktest, renderBriefDetail, renderBriefs, renderClients, renderConflicts, renderForgot, renderLogin, renderOverview, renderReset, renderRevealConfirm } from './console-view.mjs';

const sessionMs = 8 * 60 * 60 * 1000;
const throttleMs = 60 * 1000;
const maxFailures = 5;
const maxBodyBytes = 4096;
const digest = (value) => createHash('sha256').update(value).digest();
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const actions = {
  'brief/approve': (ops, id) => ops.reviewBrief({ brief_id: id, decision: 'approved' }),
  'brief/decline': (ops, id, form) => ops.reviewBrief({ brief_id: id, decision: 'declined', reason: String(form.get('reason') ?? '').slice(0, 500) }),
  'conflict/serve-holder': (ops, id) => ops.resolveConflict({ conflict_id: id, resolution: 'serve_holder' }),
  'conflict/stop': (ops, id) => ops.resolveConflict({ conflict_id: id, resolution: 'serve_neither' }),
  'project/verify': (ops, id) => ops.verifyProject({ project_id: id, verified: true }),
  'project/unverify': (ops, id) => ops.verifyProject({ project_id: id, verified: false }),
};
const successText = { 'brief/approve': 'Brief approved.', 'brief/decline': 'Brief declined.', 'conflict/serve-holder': 'Conflict resolved: the current holder keeps pricing.',
  'conflict/stop': 'Conflict resolved: pricing for this tender has stopped.', 'project/verify': 'Project verified.', 'project/unverify': 'Project verification revoked.' };

export function createSecretAuth(founderToken) {
  const expected = digest(founderToken);
  const key = digest(`td-console-session:${founderToken}`);
  const sign = (value) => createHmac('sha256', key).update(value).digest('hex');
  const revoked = new Set();
  return {
    mode: 'secret',
    async login(form) {
      if (!timingSafeEqual(expected, digest(form.get('token') ?? ''))) return undefined;
      const id = randomBytes(16).toString('hex');
      const expires = String(Date.now() + sessionMs);
      return { session: `${id}.${expires}.${sign(`${id}.${expires}`)}`, maxAge: sessionMs / 1000 };
    },
    async verify(raw) {
      const match = /^([a-f0-9]{32})\.(\d{10,16})\.([a-f0-9]{64})$/.exec(raw ?? '');
      if (!match) return false;
      return timingSafeEqual(Buffer.from(match[3]), Buffer.from(sign(`${match[1]}.${match[2]}`))) && Number(match[2]) > Date.now() && !revoked.has(match[1]);
    },
    async logout(raw) { const id = /^([a-f0-9]{32})\./.exec(raw ?? '')?.[1]; if (id) revoked.add(id); },
  };
}

export function createConsoleHandler({ founder, founderToken, auth, dataset, basePath = '', secureCookies = false }) {
  if (typeof founder !== 'function') throw new Error('A founder function is required.');
  const ops = founder(founderToken);
  const provider = auth ?? createSecretAuth(founderToken);
  const canReset = typeof provider.requestReset === 'function' && typeof provider.resetPassword === 'function';
  const loginPage = (message, notice) => renderLogin(message, provider.mode, { notice, canReset });
  let failures = [];
  let resets = [];
  const cookiePath = basePath || '/';
  const cookieFlags = `HttpOnly; SameSite=Strict; Path=${cookiePath}${secureCookies ? '; Secure' : ''}`;

  const withBase = (html) => (basePath ? html.replaceAll('href="/', `href="${basePath}/`).replaceAll('action="/', `action="${basePath}/`) : html);
  const respond = (status, type, body, { headers = {}, cookies = [] } = {}) => {
    const response = new Response(body, { status, headers: { 'Content-Type': type, ...securityHeaders, ...headers } });
    for (const cookie of cookies) response.headers.append('Set-Cookie', cookie);
    return response;
  };
  const text = (status, message, options) => respond(status, 'text/plain', message, options);
  const html = (status, body, options) => respond(status, 'text/html; charset=utf-8', withBase(body), options);
  const redirect = (location, options) => respond(303, 'text/plain', null, { ...options, headers: { Location: `${basePath}${location}`, ...options?.headers } });
  const flashCookie = (flash) => `td_flash=${encodeURIComponent(JSON.stringify(flash))}; Max-Age=30; ${cookieFlags}`;
  const clearFlash = `td_flash=; Max-Age=0; ${cookieFlags}`;

  const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? '')?.[1];
  async function readForm(request) {
    if (Number(request.headers.get('content-length') ?? 0) > maxBodyBytes) throw new Error('too large');
    const body = await request.text();
    if (body.length > maxBodyBytes) throw new Error('too large');
    return new URLSearchParams(body);
  }
  function readFlash(cookieHeader) {
    const raw = /(?:^|;\s*)td_flash=([^;]*)/.exec(cookieHeader ?? '')?.[1];
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw));
      return typeof parsed?.text === 'string' && typeof parsed.ok === 'boolean' ? { ok: parsed.ok, text: parsed.text.slice(0, 400) } : undefined;
    } catch { return undefined; }
  }

  return async function handle(request, route = new URL(request.url).pathname) {
    const url = new URL(request.url);
    const path = route;
    const post = request.method === 'POST';
    if (request.method !== 'GET' && !post) return text(405, 'Method not allowed', { headers: { Allow: 'GET, POST' } });
    const cookieHeader = request.headers.get('cookie');

    if (path === '/console.css' && !post) return respond(200, 'text/css; charset=utf-8', consoleCss);
    if (path === '/login' && !post) return html(200, loginPage());
    if (path === '/login' && post) {
      const now = Date.now();
      failures = failures.filter((time) => now - time < throttleMs);
      if (failures.length >= maxFailures) return html(429, loginPage('Too many attempts. Wait a minute and try again.'), { headers: { 'Retry-After': '60' } });
      let form;
      try { form = await readForm(request); } catch { return text(413, 'Payload too large'); }
      let result;
      try { result = await provider.login(form); } catch { return html(503, loginPage('Sign-in is temporarily unavailable. Try again shortly.')); }
      if (!result) {
        failures.push(now);
        return html(401, loginPage(provider.mode === 'email' ? 'That email or password was not accepted.' : 'That secret was not accepted.'));
      }
      const csrf = randomBytes(32).toString('hex');
      return redirect('/', { cookies: [`td_session=${result.session}; ${cookieFlags}; Max-Age=${result.maxAge}`, `td_csrf=${csrf}; ${cookieFlags}; Max-Age=${result.maxAge}`] });
    }

    if (canReset && (path === '/forgot' || path === '/reset')) {
      const tokenShape = /^[A-Za-z0-9_-]{16,128}$/;
      if (!post) {
        if (path === '/forgot') return html(200, renderForgot());
        const token = url.searchParams.get('token') ?? '';
        return tokenShape.test(token) ? html(200, renderReset({ token })) : html(400, renderReset({ invalid: true }));
      }
      const now = Date.now();
      resets = resets.filter((time) => now - time < throttleMs);
      if (resets.length >= maxFailures) return html(429, path === '/forgot' ? renderForgot({ message: 'Too many requests. Wait a minute and try again.' }) : renderReset({ invalid: true }), { headers: { 'Retry-After': '60' } });
      resets.push(now);
      let form;
      try { form = await readForm(request); } catch { return text(413, 'Payload too large'); }
      if (path === '/forgot') {
        const email = String(form.get('email') ?? '').trim();
        if (email && email.length <= 254) {
          try { await provider.requestReset(email, `${basePath}/reset`); } catch { return html(503, renderForgot({ message: 'Password reset is temporarily unavailable. Try again shortly.' })); }
        }
        return html(200, renderForgot({ sent: true }));
      }
      const token = String(form.get('token') ?? '');
      const password = String(form.get('password') ?? '');
      if (!tokenShape.test(token)) return html(400, renderReset({ invalid: true }));
      if (password.length < 12) return html(400, renderReset({ token, message: 'Use at least 12 characters.' }));
      if (password !== String(form.get('confirm') ?? '')) return html(400, renderReset({ token, message: 'The two entries did not match.' }));
      let result;
      try { result = await provider.resetPassword(token, password); } catch { return html(503, renderReset({ token, message: 'Password reset is temporarily unavailable. Try again shortly.' })); }
      if (result.ok) return html(200, loginPage(undefined, 'Password changed. Sign in with your new password.'));
      return result.invalid ? html(400, renderReset({ invalid: true })) : html(400, renderReset({ token, message: result.message ?? 'That password was not accepted.' }));
    }

    const rawSession = cookieValue(cookieHeader, 'td_session');
    let valid = false;
    if (rawSession) { try { valid = await provider.verify(rawSession); } catch { valid = false; } }
    if (!valid) return redirect('/login');
    const existingCsrf = cookieValue(cookieHeader, 'td_csrf');
    const csrf = /^[a-f0-9]{64}$/.test(existingCsrf ?? '') ? existingCsrf : randomBytes(32).toString('hex');
    const csrfCookies = csrf === existingCsrf ? [] : [`td_csrf=${csrf}; ${cookieFlags}; Max-Age=${sessionMs / 1000}`];

    if (!post) {
      const state = await ops.readConsole();
      const flash = readFlash(cookieHeader);
      const options = { cookies: [...csrfCookies, ...(flash ? [clearFlash] : [])] };
      const render = (fn) => html(200, fn({ state, dataset, csrf, flash }), options);
      if (path === '/') return render((context) => renderOverview(context));
      if (path === '/briefs') return render((context) => renderBriefs({ ...context, view: url.searchParams.get('view') === 'decided' ? 'decided' : 'pending' }));
      const briefMatch = /^\/briefs\/([0-9a-f-]{36})$/.exec(path);
      if (briefMatch && idPattern.test(briefMatch[1])) {
        const brief = state.briefs.find((b) => b.id === briefMatch[1]);
        return brief ? render((context) => renderBriefDetail({ ...context, brief })) : text(404, 'Brief not found');
      }
      if (path === '/conflicts') return render((context) => renderConflicts(context));
      if (path === '/clients') return render((context) => renderClients(context));
      if (path === '/backtest/reveal-all') return render((context) => renderRevealConfirm(context));
      if (path === '/backtest') return render((context) => renderBacktest({ ...context, filter: ['inside', 'outside'].includes(url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all' }));
      if (path === '/audit') return render((context) => renderAudit(context));
      return text(404, 'Not found');
    }

    let form;
    try { form = await readForm(request); } catch { return text(413, 'Payload too large'); }
    const supplied = form.get('csrf') ?? '';
    if (supplied.length !== 64 || supplied !== csrf || csrfCookies.length) return text(403, 'Forbidden');
    if (path === '/logout') {
      await provider.logout(rawSession).catch(() => {});
      return redirect('/login', { cookies: [`td_session=; Max-Age=0; ${cookieFlags}`, `td_csrf=; Max-Age=0; ${cookieFlags}`] });
    }
    const reveal = /^\/actions\/backtest\/([^/]+)\/reveal$/.exec(path);
    if (reveal) {
      let tenderNo;
      try { tenderNo = decodeURIComponent(reveal[1]); } catch { tenderNo = ''; }
      if (tenderNo === 'all' && form.get('confirm') !== 'yes') return redirect('/backtest/reveal-all');
      const result = await ops.revealBacktest(tenderNo === 'all' ? { all: true } : { tender_no: tenderNo });
      const flash = result.outcome === 'blocked' ? { ok: false, text: `Blocked · ${result.rule_id}: ${result.reason}` }
        : { ok: true, text: result.scope === 'all' ? `Revealed ${result.revealed_count} outcomes.` : 'Outcome revealed.' };
      return redirect('/backtest', { cookies: [flashCookie(flash)] });
    }
    const match = /^\/actions\/(brief|conflict|project)\/([^/]+)\/([a-z-]+)$/.exec(path);
    const actionKey = match && `${match[1]}/${match[3]}`;
    if (!match || !actions[actionKey] || !idPattern.test(match[2])) return text(404, 'Not found');
    let flash;
    try {
      const result = await actions[actionKey](ops, match[2], form);
      flash = result.outcome === 'blocked' ? { ok: false, text: `Blocked · ${result.rule_id}: ${result.reason}` } : { ok: true, text: successText[actionKey] };
    } catch {
      flash = { ok: false, text: 'The action could not be completed. Nothing was changed.' };
    }
    const landing = { brief: `/briefs/${match[2]}`, conflict: '/conflicts', project: '/clients' }[match[1]];
    return redirect(landing, { cookies: [flashCookie(flash)] });
  };
}
