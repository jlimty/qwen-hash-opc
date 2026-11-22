import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';

const columns = ['tender_no', 'tender_description', 'agency', 'award_date', 'tender_detail_status', 'supplier_name', 'awarded_amt'];
const statuses = new Set(['Awarded to Suppliers', 'Awarded by Items', 'Award by interface record', 'Awarded to No Suppliers']);
const holdoutFrom = '2026-01-01';
export const categoryRules = [
  ['cleaning-facilities', /\b(cleaning|janitorial|housekeeping|landscaping|pest control|grass cutting|waste collection)\b/i],
  ['security', /\b(security (guard|services)|guarding|patrol|surveillance)\b/i],
  ['ict-services', /\b(ict|it services|software|hardware|cybersecurity|computers?|laptops?|network|data analytics|cloud|hosting)\b/i],
  ['construction-renovation', /\b(construction|renovation|refurbishment|civil works|upgrading)\b/i],
  ['events-community', /\b(events?|festivals?|conferences?|exhibitions?|celebrations?|ceremonies|community outreach)\b/i],
  ['training-consultancy', /\b(training|consultancy|consulting|workshops?|courses?|coaching)\b/i],
  ['catering', /\b(catering|meals?|food services)\b/i],
];
// Live tenders and pasted text: "consultancy" alone is not training (an architectural or engineering consultancy is
// professional services). The award dataset keeps categoryRules as they were, so backtest figures do not move.
const liveRules = categoryRules.map(([category, pattern]) => (category === 'training-consultancy'
  ? [category, /\b(training|workshops?|courses?|coaching)\b/i] : [category, pattern]));
export function categorize(text) {
  return liveRules.find(([, pattern]) => pattern.test(String(text ?? '')))?.[0] ?? 'other';
}
export const tenderCategories = Object.freeze([...categoryRules.map(([category]) => category), 'other']);

function parseDate(value, record) {
  const match = /^(\d{1,2})\/(\d{1,2})\/([1-9]\d{3})$/.exec(value);
  if (!match) throw new Error(`Record ${record}: invalid award_date.`);
  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Record ${record}: invalid award_date.`);
  }
  return { iso: date.toISOString().slice(0, 10), fiscalYear: month >= 4 ? year : year - 1 };
}

function parseCents(value, record) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`Record ${record}: invalid awarded_amt.`);
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Record ${record}: awarded_amt exceeds safe integer cents.`);
  return Number(cents);
}

export function parseTenderCsv(csv) {
  const source = parse(csv, {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    columns: (headers) => {
      if (headers.length !== columns.length || new Set(headers).size !== columns.length || columns.some((c) => !headers.includes(c))) {
        throw new Error('CSV columns do not match the GeBIZ award schema.');
      }
      return headers;
    },
  });
  if (!source.length) throw new Error('The GeBIZ CSV has no award records.');
  const rows = source.map((raw, index) => {
    const record = index + 1;
    const fields = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.trim()]));
    for (const field of ['tender_no', 'tender_description', 'agency']) {
      if (!fields[field]) throw new Error(`Record ${record}: missing ${field}.`);
    }
    if (!statuses.has(fields.tender_detail_status)) throw new Error(`Record ${record}: unsupported status.`);
    const { iso, fiscalYear } = parseDate(fields.award_date, record);
    const cents = parseCents(fields.awarded_amt, record);
    if (fields.tender_detail_status === 'Awarded to No Suppliers' && cents !== 0) {
      throw new Error(`Record ${record}: an award to no suppliers cannot have a positive amount.`);
    }
    if (fields.tender_detail_status !== 'Awarded to No Suppliers' && !fields.supplier_name) {
      throw new Error(`Record ${record}: missing supplier_name.`);
    }
    return {
      source_record: record,
      tender_no: fields.tender_no,
      description: fields.tender_description,
      agency: fields.agency,
      award_date: iso,
      status: fields.tender_detail_status,
      supplier_name: fields.supplier_name,
      awarded_cents: cents,
      fiscal_year: fiscalYear,
      category: categoryRules.find(([, pattern]) => pattern.test(fields.tender_description))?.[0] ?? 'other',
      is_holdout: iso >= holdoutFrom,
    };
  });
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.tender_no)) groups.set(row.tender_no, []);
    groups.get(row.tender_no).push(row);
  }
  const contracts = [...groups.entries()].map(([tenderNo, items]) => {
    const first = items[0];
    if (items.some((item) => item.description !== first.description || item.agency !== first.agency)) {
      throw new Error(`Conflicting agency or description for contract ${tenderNo}.`);
    }
    const isHoldout = items.some((item) => item.is_holdout);
    const supplierAmounts = new Map();
    let total = 0;
    for (const item of items) {
      item.is_holdout = isHoldout;
      total += item.awarded_cents;
      if (!Number.isSafeInteger(total)) throw new Error(`Contract ${tenderNo} amount exceeds safe integer cents.`);
      if (item.status !== 'Awarded to No Suppliers') {
        supplierAmounts.set(item.supplier_name, (supplierAmounts.get(item.supplier_name) ?? 0) + item.awarded_cents);
      }
      Object.freeze(item);
    }
    const dates = items.map((item) => item.award_date).sort();
    return Object.freeze({
      tender_no: tenderNo,
      description: first.description,
      agency: first.agency,
      category: first.category,
      first_award_date: dates[0],
      last_award_date: dates.at(-1),
      statuses: Object.freeze([...new Set(items.map((item) => item.status))].sort()),
      total_awarded_cents: total,
      suppliers: Object.freeze([...supplierAmounts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, awarded_cents]) => Object.freeze({ name, awarded_cents }))),
      source_records: Object.freeze(items.map((item) => item.source_record)),
      is_holdout: isHoldout,
    });
  }).sort((a, b) => a.tender_no < b.tender_no ? -1 : a.tender_no > b.tender_no ? 1 : 0);
  return Object.freeze({
    dataset_id: 'd_acde1106003906a75c3fa052592f2fcb',
    dataset_sha256: createHash('sha256').update(csv).digest('hex'),
    taxonomy_version: 'keywords-v1',
    holdout_from: holdoutFrom,
    rows: Object.freeze(rows),
    contracts: Object.freeze(contracts),
  });
}
