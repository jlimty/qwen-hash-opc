import { randomBytes } from 'node:crypto';
import { backtestFromJson } from './backtest.mjs';
import { createConsoleHandler } from './console-handler.mjs';
import { createTenderDesk } from './governance.mjs';
import { createMcpWebHandler } from './mcp-web.mjs';
import { createNeonAuth } from './neon-auth.mjs';
import { parseTenderCsv } from './tender-data.mjs';

export const publicBase = '/functions/v1/app';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const safeMessage = (error) => `${error?.name ?? 'Error'}: ${String(error?.message ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 160)}`;

const clean = (value) => String(value ?? '').trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim() || undefined;
const shape = (value) => `scheme ${/^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1] ?? 'none'}, ${value.length} characters`;

export function createSiteApp({ openDatabase, env, csv, backtestJson, origin, fetchImpl }) {
  let runtime;
  let stage = 'start';
  function boot() {
    stage = 'config';
    const databaseUrl = clean(env('TD_DB_URL'));
    const authUrl = clean(env('TD_AUTH_URL'));
    const adminUserId = clean(env('TD_ADMIN_USER_ID'));
    if (!databaseUrl || !authUrl || !adminUserId) return undefined;
    if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new Error(`TD_DB_URL must be a postgres URL (${shape(databaseUrl)})`);
    if (!/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/i.test(authUrl)) throw new Error(`TD_AUTH_URL must be an https URL (${shape(authUrl)})`);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(adminUserId)) throw new Error(`TD_ADMIN_USER_ID is not a valid user ID (${adminUserId.length} characters)`);
    const founderToken = randomBytes(32).toString('hex');
    stage = 'auth';
    const auth = createNeonAuth({ baseUrl: authUrl, adminUserId, origin, fetchImpl });
    stage = 'dataset';
    const dataset = parseTenderCsv(csv);
    stage = 'database';
    const database = openDatabase(databaseUrl);
    stage = 'desk';
    const desk = createTenderDesk({ database, dataset, founderToken, backtest: backtestFromJson(backtestJson, dataset) });
    return {
      console: createConsoleHandler({ founder: desk.founder, founderToken, auth, dataset, basePath: publicBase, secureCookies: true }),
      mcp: createMcpWebHandler({ authenticate: (token) => desk.agent(token) }),
    };
  }

  return async function app(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const route = `/${segments.slice(1).join('/')}`;
    if (request.method === 'GET' && route === '/health') return json({ ok: true, configured: Boolean(clean(env('TD_DB_URL')) && clean(env('TD_AUTH_URL')) && clean(env('TD_ADMIN_USER_ID'))) });
    try {
      runtime ??= boot();
      if (runtime) stage = 'serving';
      if (!runtime) return json({ error: 'service_not_configured' }, 503);
      if (route === '/mcp') return await runtime.mcp(request);
      return await runtime.console(request, route);
    } catch (error) {
      console.error(`request failed at ${stage}: ${safeMessage(error)}`);
      return json({ error: 'service_unavailable' }, 503);
    }
  };
}
