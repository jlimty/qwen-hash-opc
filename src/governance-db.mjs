import { readFile } from 'node:fs/promises';

// Applied in order; each is skipped when its marker shows it already ran.
const migrations = [
  { file: '001-governance.sql', present: "SELECT to_regclass('tender_desk.clients') IS NOT NULL AS present" },
  { file: '002-journey.sql', present: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='tender_desk' AND table_name='clients' AND column_name='reference_number') AS present` },
];

export async function initializeGovernance(database) {
  for (const { file, present } of migrations) {
    const { rows } = await database.query(present);
    if (!rows[0].present) await database.exec(await readFile(new URL(`../db/${file}`, import.meta.url), 'utf8'));
  }
}
