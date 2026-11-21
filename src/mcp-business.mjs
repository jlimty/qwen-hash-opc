import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const maxBodyBytes = 256 * 1024;
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function bearerToken(header) {
  const match = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header ?? '');
  return match?.[1];
}

const catalogs = new Map();
const readOnlyTools = new Set(['get_policies', 'get_client_context', 'get_incoming_tenders', 'search_tenders']);

function catalogFor(agent) {
  const key = agent.tools.map(({ name }) => name).join(',');
  if (!catalogs.has(key)) {
    catalogs.set(key, agent.tools.map(({ name, description, schema }) => {
      const { $schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' });
      return { name, description, inputSchema,
        annotations: { readOnlyHint: readOnlyTools.has(name), destructiveHint: false, openWorldHint: false } };
    }));
  }
  return catalogs.get(key);
}

function buildMcpServer(agent) {
  const server = new Server({ name: 'tender-desk', version: '0.1.0' }, { capabilities: { tools: {} } });
  const catalog = catalogFor(agent);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const result = await agent.invoke(params.name, params.arguments ?? {});
      return { ...text(result), ...(result.outcome === 'blocked' && { isError: true }) };
    } catch (error) {
      const unauthorized = error instanceof Error && error.message === 'Unauthorized';
      return { ...text({ outcome: 'blocked', reason: unauthorized ? 'Credential is no longer valid.' : 'The request could not be completed.' }), isError: true };
    }
  });
  return server;
}

export function createTenderDeskServer({ authenticate }) {
  if (typeof authenticate !== 'function') throw new Error('An authenticate function is required.');
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const port = req.socket.localPort;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host) ||
        (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const token = bearerToken(req.headers.authorization);
    let agent;
    if (token) {
      try { agent = await authenticate(token); } catch { agent = undefined; }
    }
    if (!agent) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="tender-desk"' }).end('Unauthorized');
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end('Method not allowed');
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > maxBodyBytes) {
      res.writeHead(413, { Connection: 'close' }).end('Payload too large');
      return;
    }

    const mcp = buildMcpServer(agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: maxBodyBytes });
    res.on('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
      else res.destroy();
    }
  });
}
