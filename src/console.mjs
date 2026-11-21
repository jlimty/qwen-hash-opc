import { createServer } from 'node:http';
import { createConsoleHandler } from './console-handler.mjs';

const maxBodyBytes = 4096;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createConsoleServer({ founder, founderToken, dataset }) {
  const handle = createConsoleHandler({ founder, founderToken, dataset });
  return createServer(async (req, res) => {
    const port = req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const plain = (status, body, headers = {}) => res.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', ...headers }).end(body);
    if (!hosts.includes(req.headers.host)) return plain(403, 'Forbidden');
    const post = req.method === 'POST';
    if (post && !hosts.some((host) => req.headers.origin === `http://${host}`)) return plain(403, 'Forbidden');
    if (req.method !== 'GET' && !post) return plain(405, 'Method not allowed', { Allow: 'GET, POST' });

    let body;
    if (post) {
      try { body = await readBody(req); } catch { return plain(413, 'Payload too large'); }
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
      else if (value !== undefined) headers.set(name, value);
    }
    const response = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
    const out = {};
    response.headers.forEach((value, name) => { if (name !== 'set-cookie') out[name] = value; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out['set-cookie'] = cookies;
    res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
  });
}
