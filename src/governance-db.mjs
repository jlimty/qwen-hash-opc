import { readFile } from 'node:fs/promises';

// Applied in order; each is skipped when its marker shows it already ran.
const migrations = [
  { file: '001-governance.sql', present: "SELECT to_regclass('tender_desk.clients') IS NOT NULL AS present" },
  { file: '002-journey.sql', present: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='tender_desk' AND table_name='clients' AND column_name='reference_number') AS present` },
  { file: '003-assistant.sql', present: "SELECT to_regclass('tender_desk.brief_requests') IS NOT NULL AS present" },
  { file: '004-settings.sql', present: "SELECT to_regclass('tender_desk.settings') IS NOT NULL AS present" },
  { file: '005-credits-operator.sql', present: "SELECT to_regclass('tender_desk.credit_ledger') IS NOT NULL AS present" },
];

const body = async (file) => (await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'))
  .replace(/^\s*BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, '\n');

// Destructive: drops tender_desk and re-applies every migration in ONE transaction, so a failure part-way
// (a dropped connection, a bad statement) rolls back to the old schema and data instead of leaving it dropped.
export async function rebuildTenderDesk(database) {
  const bodies = await Promise.all(migrations.map(({ file }) => body(file)));
  await database.transaction(async (tx) => {
    await tx.query('DROP SCHEMA IF EXISTS tender_desk CASCADE');
    for (const sql of bodies) await tx.exec(sql);
  });
}

export async function pendingMigrations(database) {
  const pending = [];
  for (const { file, present } of migrations) if (!(await database.query(present)).rows[0].present) pending.push(file);
  return pending;
}

export async function initializeGovernance(database) {
  for (const { file, present } of migrations) {
    const { rows } = await database.query(present);
    if (!rows[0].present) await database.exec(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  }
}
