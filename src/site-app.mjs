import { randomBytes } from 'node:crypto';
import { backtestFromJson } from './backtest.mjs';
import { createConsoleHandler } from './console-handler.mjs';
import { createCustomerAuth } from './customer-auth.mjs';
import { createCustomerHandler } from './customer-handler.mjs';
import { refreshOpenTenders } from './gebiz-feed.mjs';
import { createOpenRouterLlm } from './openrouter.mjs';
import { createTenderDesk } from './governance.mjs';
import { createMcpWebHandler } from './mcp-web.mjs';
import { createNeonAuth } from './neon-auth.mjs';
import { parseTenderCsv } from './tender-data.mjs';

export const publicBase = '/functions/v1/app';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const safeMessage = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 160)}`;

const clean = (value) => String(value ?? '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim() || undefined;
const shape = (value) => `scheme ${/^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1] ?? 'none'}, ${value.length} characters`;

export function createSiteApp({ openDatabase, env, csv, backtestJson, origin, fetchImpl, feedFetch = fetch, waitUntil }) {
  let runtime;
  let stage = 'start';
  function boot() {
    stage = 'config';
    const databaseUrl = clean(env('TD_DB_URL'));
    const authUrl = clean(env('TD_AUTH_URL'));
    if (!databaseUrl || !authUrl) return undefined;
    if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new Error(`TD_DB_URL must be a postgres URL (${shape(databaseUrl)})`);
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/i.test(authUrl)) throw new Error(`TD_AUTH_URL must be an https URL (${shape(authUrl)})`);
    const adminToken = randomBytes(32).toString('hex');
    stage = 'auth';
    stage = 'dataset';
    const dataset = parseTenderCsv(csv);
    stage = 'database';
    const database = openDatabase(databaseUrl);
    // Read on every check, so a changed or removed admin takes effect at once; no row means nobody is admin.
    const adminUserId = async () => (await database.query("SELECT value FROM tender_desk.settings WHERE key = 'admin_user_id'")).rows[0]?.value;
    stage = 'auth';
    const auth = createNeonAuth({ baseUrl: authUrl, adminUserId, origin, fetchImpl });
    stage = 'desk';
    const desk = createTenderDesk({ database, dataset, adminToken, backtest: backtestFromJson(backtestJson, dataset),
      connector: { url: `${origin}${publicBase}/mcp`, origin, timeout: 60 } });
    stage = 'ai';
    const openRouterKey = clean(env('TD_OPENROUTER_KEY'));
    const llm = openRouterKey ? createOpenRouterLlm({ apiKey: openRouterKey, referer: origin }) : undefined;
    const models = { read: clean(env('TD_MODEL_READ')) ?? 'qwen/qwen3.8-flash', draft: clean(env('TD_MODEL_DRAFT')) ?? 'qwen/qwen3.8-max-0902' };
    return {
      console: createConsoleHandler({ admin: desk.admin, adminToken, auth, dataset, basePath: publicBase, secureCookies: true, llm, models }),
      assistant: createCustomerHandler({ desk, dataset, llm, models, database, basePath: `${publicBase}/assistant`, secureCookies: true, waitUntil,
        auth: createCustomerAuth({ baseUrl: authUrl, origin, adminUserId, fetchImpl }),
        refresh: () => refreshOpenTenders(database, { fetchImpl: feedFetch }) }),
      mcp: createMcpWebHandler({ authenticate: (token) => desk.agent(token) }),
    };
  }

  return async function app(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const route = `/${segments.slice(1).join('/')}`;
    if (request.method === 'GET' && route === '/health') {
      return json({ ok: true, configured: Boolean(clean(env('TD_DB_URL')) && clean(env('TD_AUTH_URL'))), ai: Boolean(clean(env('TD_OPENROUTER_KEY'))) });
    }
    try {
      runtime ??= boot();
      if (runtime) stage = 'serving';
      if (!runtime) return json({ error: 'service_not_configured' }, 503);
      if (route === '/mcp') return await runtime.mcp(request);
      if (route === '/assistant' || route.startsWith('/assistant/')) return await runtime.assistant(request, route.slice('/assistant'.length) || '/');
      return await runtime.console(request, route);
    } catch (error) {
      console.error(`request failed at ${stage}: ${safeMessage(error)}`);
      return json({ error: 'service_unavailable' }, 503);
    }
  };
}
