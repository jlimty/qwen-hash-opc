import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';
import { hashPassword } from '../src/neon-password.mjs';
import { chooseNewPassword } from './lib/prompt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'state-dir': { type: 'string' }, 'password-file': { type: 'string' } }, allowPositionals: false, strict: true });
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  const adminId = (await readFile(join(stateDir, 'admin-user-id.txt'), 'utf8').catch(() => { throw new Error(`No admin user ID found in ${join(stateDir, 'admin-user-id.txt')}.`); })).trim();
  const databaseUrl = (await readFile(resolve(values['db-file'] ?? join(stateDir, 'db-unpooled.url')), 'utf8').catch(() => { throw new Error('Could not read the database URL file (default .local/site/db-unpooled.url).'); })).trim();
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  const found = (await database.query('SELECT email FROM neon_auth."user" WHERE id = $1', [adminId])).rows[0];
  if (!found) throw new Error('The admin user ID does not match any account in Neon Auth. Nothing was changed.');
  console.log(`Setting a new password for ${found.email}.`);
  const password = values['password-file'] ? (await readFile(resolve(values['password-file']), 'utf8')).replace(/\r?\n$/, '') : await chooseNewPassword(undefined, 'new admin password');
  if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const hash = await hashPassword(password);
  await database.transaction(async (tx) => {
    const updated = await tx.query(`UPDATE neon_auth.account SET password = $2, "updatedAt" = now() WHERE "userId" = $1 AND "providerId" = 'credential' RETURNING id`, [adminId, hash]);
    if (!updated.rows.length) {
      await tx.query(`INSERT INTO neon_auth.account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, $3, now(), now())`, [randomUUID(), adminId, hash]);
    }
    await tx.query('DELETE FROM neon_auth.session WHERE "userId" = $1', [adminId]);
  });
  console.log('Password changed and existing sessions signed out. You can sign in now.');
} catch (error) {
  console.error(`Password reset failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
