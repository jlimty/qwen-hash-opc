import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export function createProbeServer({ token, onHealthCheck = () => {} }) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('A nonempty bearer token is required.');
  }
  const expectedAuth = createHash('sha256').update(`Bearer ${token}`).digest();

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!allowedHosts.includes(req.headers.host) ||
        (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`))) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const suppliedAuth = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(expectedAuth, suppliedAuth)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="tender-desk-smoke"' }).end('Unauthorized');
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

    const mcp = new McpServer({ name: 'tender-desk-smoke', version: '0.0.1' });
    mcp.registerTool('health_check', {
      title: 'Tender Desk connection check',
      description: 'Check the live MCP connection. Echoes your nonce with a server timestamp; no tender data or business actions.',
      inputSchema: {
        nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('A fresh check label, using letters, digits, underscores or hyphens.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, async ({ nonce }) => {
      const result = {
        status: 'ok',
        service: 'tender-desk-smoke',
        nonce,
        checked_at: new Date().toISOString(),
      };
      onHealthCheck(result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end('MCP request failed');
      } else {
        res.destroy();
      }
    }
  });
}
