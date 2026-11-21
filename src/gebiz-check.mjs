// Facts for the admin about a client's claimed government project, from the public GeBIZ awards.
// Exact comparison after normalisation only: no fuzzy matching, no judgement.
import { formatSgd } from './brief-risk.mjs';

const suffixes = ['PTE LTD', 'PRIVATE LIMITED', 'LTD'];

export function normaliseCompany(name) {
  let value = String(name ?? '').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const suffix = suffixes.find((s) => value === s ? false : value.endsWith(` ${s}`));
  if (suffix) value = value.slice(0, -suffix.length - 1).trim();
  return value;
}

export function crossCheckProject(dataset, project, clientName, revealed) {
  const tenderNo = project.gebiz_tender_no?.trim();
  if (!tenderNo) return { result: 'no_match', lines: ['No GeBIZ tender number given.'] };
  const contract = dataset.contracts.find((c) => c.tender_no === tenderNo);
  if (!contract) return { result: 'no_match', lines: ['Not found in GeBIZ awards 2021-04 to 2026-03.'] };
  // Keeps the backtest scoreboard honest: no hold-out winner is shown before it is revealed.
  if (contract.is_holdout && !revealed.has(tenderNo)) return { result: 'not_checked', lines: ['In the backtest hold-out; not checked until revealed.'] };
  const wanted = normaliseCompany(clientName);
  const matching = contract.suppliers.find((s) => normaliseCompany(s.name) === wanted);
  const claimed = project.value_cents === null || project.value_cents === undefined ? 'no value' : formatSgd(project.value_cents);
  return {
    result: matching ? 'match' : 'no_match',
    lines: [
      `Tender ${tenderNo} exists · awarded ${contract.last_award_date} · ${contract.agency}`,
      `Agency claimed: ${project.agency ?? 'not given'}`,
      `Supplier on record: ${contract.suppliers.map((s) => s.name).join(' / ')} — ${matching ? 'matches' : 'does not match'} "${clientName}"`,
      `Claimed ${claimed} · awarded ${formatSgd(matching ? matching.awarded_cents : contract.total_awarded_cents)}`,
    ],
  };
}
