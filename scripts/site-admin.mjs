import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { signUpAdmin } from '../src/neon-auth.mjs';
import { chooseNewPassword } from './lib/prompt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const { values } = parseArgs({ options: { email: { type: 'string' }, 'auth-url-file': { type: 'string' }, 'password-file': { type: 'string' }, 'state-dir': { type: 'string' } }, allowPositionals: false, strict: true });
  if (!values.email) throw new Error('Pass --email <the admin email>.');
  const authUrl = (await readFile(resolve(values['auth-url-file'] ?? join(homedir(), '.td-auth-url')), 'utf8').catch(() => { throw new Error('Could not read the Neon Auth URL file (default ~/.td-auth-url).'); })).trim();
  const { origin } = JSON.parse(await readFile(join(root, 'scripts', 'site-assets', 'site.json'), 'utf8'));
  const password = values['password-file'] ? (await readFile(resolve(values['password-file']), 'utf8')).replace(/\r?\n$/, '') : await chooseNewPassword(undefined, 'admin password');
  if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const { userId, emailVerified } = await signUpAdmin({ baseUrl: authUrl, origin, email: values.email, password });
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, 'admin-user-id.txt'), `${userId}\n`, { mode: 0o600 });
  console.log(`Admin account created. User ID saved to ${join(stateDir, 'admin-user-id.txt')}.`);
  if (!emailVerified) console.log('The email is not verified; that is fine, because the console allows only this user ID.');
} catch (error) {
  console.error(`Admin setup failed: ${error.message}`);
  process.exitCode = 1;
}
