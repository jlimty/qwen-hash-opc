// Turns a tender's title (and any pasted text) into 1-3 search terms and a category, so code can find comparable
// awards. The model is optional: any failure, or no model at all, falls back to keyword rules.
import { z } from 'zod';
import { categorize, tenderCategories } from './tender-data.mjs';

export const maxTenderText = 4000;
const term = z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9 ]+$/);
export const readingSchema = z.strictObject({
  terms: z.array(term).min(1).max(3),
  category: z.enum(tenderCategories),
  agency: z.string().trim().max(200).nullable(),
});
const readingJsonSchema = (() => { const { $schema, ...schema } = z.toJSONSchema(readingSchema, { io: 'input' }); return schema; })();

const stopwords = new Set(['provision', 'services', 'service', 'supply', 'tender', 'quotation', 'invitation', 'quote', 'period', 'years',
  'option', 'extend', 'another', 'with', 'from', 'that', 'this', 'the', 'and', 'for', 'year', 'months', 'including', 'various', 'proposed']);

export function keywordTerms(text) {
  const words = (String(text ?? '').slice(0, maxTenderText).toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [])
    .filter((word) => word.length >= 4 && !stopwords.has(word));
  return { terms: [...new Set(words)].slice(0, 2), category: categorize(text), agency: null };
}

const system = `You read Singapore government tender notices for Tender Desk, which finds comparable past contract awards.
Return 1 to 3 short search terms (1-2 lowercase words each) naming the kind of work, as it would appear in an award description,
for example "event management", "cleaning", "video production". Put the most specific kind of work first (the role or service actually
bought, such as "registered inspector"), and avoid umbrella terms such as "consultancy" or "professional services" on their own. Avoid procurement words such as provision, services, tender, quotation.
Pick the category from the allowed list. Return the calling agency if the text names it, otherwise null.`;

export async function readTender({ title, text = '', agency } = {}, { llm, model } = {}) {
  const input = `${String(title ?? '')}\n${String(text ?? '')}`.slice(0, maxTenderText);
  const fallback = () => ({ ...keywordTerms(input), agency: agency || null, source: 'keywords' });
  if (typeof llm !== 'function') return fallback();
  try {
    // A quick answer for the free check: no reasoning step, and the keyword fallback after 20 seconds.
    const raw = await llm({ model, system, name: 'tender_reading', jsonSchema: readingJsonSchema, reasoning: { enabled: false }, timeoutMs: 20000,
      user: JSON.stringify({ title: String(title ?? '').slice(0, 300), agency: agency || null, text: input }) });
    const parsed = readingSchema.safeParse(raw);
    if (!parsed.success) return fallback();
    return { terms: parsed.data.terms, category: parsed.data.category, agency: agency || parsed.data.agency || null, source: 'model' };
  } catch {
    return fallback();
  }
}
