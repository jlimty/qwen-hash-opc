import { z } from 'zod';
import { tenderCategories } from './tender-data.mjs';

const tokens = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const textFilter = z.string().max(250).trim().min(1).refine((value) => !value.includes('\u0000'), 'NUL characters are not allowed.')
  .transform((value) => value.toLowerCase());
const amountFilter = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER / 100)
  .refine((value) => Number(value.toFixed(2)) === value && Number.isSafeInteger(Number(value.toFixed(2).replace('.', ''))),
    'Amounts must be representable as whole cents.');
const pagination = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
};
export const historicalFilterSchema = z.strictObject({
  query: textFilter.refine((value) => tokens(value).length > 0, 'Query must contain letters or digits.').optional(),
  agency: textFilter.optional(),
  category: z.enum(tenderCategories).optional(),
  min_amt: amountFilter.optional(),
  max_amt: amountFilter.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine((value) => value.min_amt === undefined || value.max_amt === undefined || value.min_amt <= value.max_amt,
  'min_amt must not exceed max_amt.')
  .refine((value) => value.from === undefined || value.to === undefined || value.from <= value.to,
    'from must not be after to.');
const searchSchema = historicalFilterSchema.safeExtend(pagination);
const incomingSchema = z.strictObject({ category: z.enum(tenderCategories).optional(), ...pagination });

export function selectHistoricalContracts(dataset, options = {}) {
  const filters = historicalFilterSchema.parse(options);
  const queryTokens = filters.query ? tokens(filters.query) : [];
  const minCents = filters.min_amt === undefined ? undefined : Number(filters.min_amt.toFixed(2).replace('.', ''));
  const maxCents = filters.max_amt === undefined ? undefined : Number(filters.max_amt.toFixed(2).replace('.', ''));
  return dataset.contracts.filter((contract) => {
    if (contract.is_holdout) return false;
    if (filters.agency && contract.agency.toLowerCase() !== filters.agency) return false;
    if (filters.category && contract.category !== filters.category) return false;
    if (filters.from && contract.last_award_date < filters.from) return false;
    if (filters.to && contract.last_award_date > filters.to) return false;
    if (minCents !== undefined && contract.total_awarded_cents < minCents) return false;
    if (maxCents !== undefined && contract.total_awarded_cents > maxCents) return false;
    const descriptionTokens = tokens(contract.description);
    return queryTokens.every((term) => descriptionTokens.some((word) => word.startsWith(term)));
  }).sort((a, b) => {
    if (a.last_award_date !== b.last_award_date) return a.last_award_date > b.last_award_date ? -1 : 1;
    return a.tender_no < b.tender_no ? -1 : a.tender_no > b.tender_no ? 1 : 0;
  });
}

export function searchHistoricalTenders(dataset, options = {}) {
  const { limit, offset, ...filters } = searchSchema.parse(options);
  const contracts = selectHistoricalContracts(dataset, filters);
  return {
    total: contracts.length, limit, offset,
    items: contracts.slice(offset, offset + limit).map((contract) => ({
      tender_no: contract.tender_no,
      description: contract.description,
      agency: contract.agency,
      category: contract.category,
      award_date: contract.last_award_date,
      statuses: contract.statuses,
      awarded_cents: contract.total_awarded_cents,
      currency: 'SGD',
      suppliers: contract.suppliers.map((supplier) => supplier.name),
    })),
  };
}

export function getIncomingTenders(dataset, options = {}) {
  const { category, limit, offset } = incomingSchema.parse(options);
  const contracts = dataset.contracts.filter((contract) => contract.is_holdout && (!category || contract.category === category));
  return {
    total: contracts.length, limit, offset,
    items: contracts.slice(offset, offset + limit).map((contract) => ({
      tender_no: contract.tender_no,
      description: contract.description,
      agency: contract.agency,
      category: contract.category,
      data_kind: 'historical-backtest',
    })),
  };
}
