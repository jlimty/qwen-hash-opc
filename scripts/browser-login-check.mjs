import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const loginUrl = process.argv[2];
if (!loginUrl) { console.error('Usage: node scripts/browser-login-check.mjs <login page URL>'); process.exit(2); }
const port = 9300 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(join(tmpdir(), 'td-cdp-'));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(loginUrl)}`, { method: 'PUT' }).then((r) => r.json()).catch(() => undefined);
  }
  if (!target) throw new Error('Chrome did not start.');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('devtools connection failed')); });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } };
  const send = (method, params = {}) => new Promise((done) => { const n = ++id; pending.set(n, done); socket.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  for (let i = 0; i < 40 && (await evaluate("document.readyState === 'complete' && !!document.querySelector('form')")) !== true; i++) await sleep(250);
  console.log('page title before submit:', await evaluate('document.title'));
  await evaluate("(() => { const set = (selector, value) => { const field = document.querySelector(selector); if (field) field.value = value; }; set('#email', 'someone@example.com'); set('#password', 'definitely-not-the-password'); set('#token', 'definitely-not-the-secret'); document.querySelector('form').submit(); return true; })()");
  await sleep(4000);
  console.log('after submit, url path:', new URL(await evaluate('location.href')).pathname);
  console.log('after submit, page says:', JSON.stringify((await evaluate('document.body.innerText')).replace(/\s+/g, ' ').slice(0, 160)));
  socket.close();
} finally {
  chrome.kill('SIGKILL');
  await sleep(300);
  await rm(profile, { recursive: true, force: true });
}
