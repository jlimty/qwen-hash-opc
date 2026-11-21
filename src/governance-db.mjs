import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../db/001-governance.sql', import.meta.url);

export async function initializeGovernance(database) {
  const { rows } = await database.query("SELECT to_regclass('tender_desk.clients') AS relation");
  if (rows[0].relation === null) {
    await database.exec(await readFile(migrationUrl, 'utf8'));
  }
}
