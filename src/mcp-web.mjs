import { z } from 'zod';

const PROTOCOL = '2025-03-26';
const maxBodyBytes = 256 * 1024;
const readOnlyTools = new Set(['get_policies', 'get_client_context', 'get_incoming_tenders', 'search_tenders']);
const rpc = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const bearerToken = (header) => /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header ?? '')?.[1];
const catalogs = new Map();
const describe = (error) => `${error?.name ?? 'Error'}${error?.code ? ` [${error.code}]` : ''}: ${String(error?.message ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').slice(0, 160)}`;

function catalogFor(agent) {
  const key = agent.tools.map(({ name }) => name).join(',');
  if (!catalogs.has(key)) {
    catalogs.set(key, agent.tools.map(({ name, description, schema }) => {
      const { $schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' });
      return { name, description, inputSchema, annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: false, openWorldHint: false } };
    }));
  }
  return catalogs.get(key);
}

export function createMcpWebHandler({ authenticate }) {
  if (typeof authenticate !== 'function') throw new Error('An authenticate function is required.');
  return async function handle(request) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    const token = bearerToken(request.headers.get('authorization'));
    let agent;
    if (token) {
      try { agent = await authenticate(token); } catch (error) {
        if (error?.message !== 'Unauthorized') {
          console.error(`mcp authentication unavailable: ${describe(error)}`);
          return rpc({ error: 'service_unavailable' }, 503);
        }
      }
    }
    if (!agent) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="tender-desk"' } });
    if (Number(request.headers.get('content-length') ?? 0) > maxBodyBytes) return new Response('Payload too large', { status: 413 });

    let message;
    try {
      const raw = await request.text();
      if (raw.length > maxBodyBytes) return new Response('Payload too large', { status: 413 });
      message = JSON.parse(raw);
    } catch {
      return rpc({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return rpc({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (message.method.startsWith('notifications/')) return new Response(null, { status: 202 });

    const id = message.id ?? null;
    const reply = (result) => rpc({ jsonrpc: '2.0', id, result });
    const fail = (code, text) => rpc({ jsonrpc: '2.0', id, error: { code, message: text } });
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'tender-desk', version: '0.1.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: catalogFor(agent) });
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string') return fail(-32602, 'Tool name is required.');
        if (!agent.toolNames.includes(name)) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const result = await agent.invoke(name, message.params?.arguments ?? {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], ...(result.outcome === 'blocked' && { isError: true }) });
        } catch (error) {
          const unauthorized = error instanceof Error && error.message === 'Unauthorized';
          return reply({ content: [{ type: 'text', text: JSON.stringify({ outcome: 'blocked', reason: unauthorized ? 'Credential is no longer valid.' : 'The request could not be completed.' }) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  };
}
