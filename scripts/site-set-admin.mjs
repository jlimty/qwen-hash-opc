// Records which Neon Auth user is the console admin, in the database, so no hosting setting is needed.
// Reads the user ID from .local/site/admin-user-id.txt (written by site:admin).
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { connectPg, createPgDatabase } from '../src/pg-database.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let database;
try {
  const { values } = parseArgs({ options: { 'db-file': { type: 'string' }, 'state-dir': { type: 'string' } }, allowPositionals: false, strict: true });
  const stateDir = resolve(values['state-dir'] ?? join(root, '.local', 'site'));
  const adminId = (await readFile(join(stateDir, 'admin-user-id.txt'), 'utf8').catch(() => { throw new Error(`No admin user ID found in ${join(stateDir, 'admin-user-id.txt')}.`); })).trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(adminId)) throw new Error('The admin user ID file does not hold a valid user ID. Nothing was changed.');
  const databaseUrl = (await readFile(resolve(values['db-file'] ?? join(stateDir, 'db-unpooled.url')), 'utf8').catch(() => { throw new Error('Could not read the database URL file (default .local/site/db-unpooled.url).'); })).trim();
  database = createPgDatabase(connectPg(postgres, databaseUrl, { max: 1 }));
  await database.query(`INSERT INTO tender_desk.settings (key, value) VALUES ('admin_user_id', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [adminId]);
  console.log(`Console admin set to the account in ${join(stateDir, 'admin-user-id.txt')}.`);
} catch (error) {
  console.error(`Setting the admin failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => {});
}
