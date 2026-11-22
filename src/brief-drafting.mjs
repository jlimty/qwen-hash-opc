// Drafts a reviewed brief in one model call over facts that code assembled. The model writes only the reasons and the
// price-position prose, with no digits; code writes every figure. A draft that cites an unverified project or states a
// figure that is not in the comparables is refused, never saved.
import { z } from 'zod';
import { formatSgd, unmatchedFigures } from './brief-risk.mjs';

// Worded without years so the brief's own figure check stays quiet; the customer page shows the full limits line too.
export const briefLimits = 'These are past contract awards, not a quote and not a winning price. GeBIZ publishes winning amounts only, not the bids that lost. Contract scope and length differ between awards.';

export const draftSchema = z.strictObject({
  recommendation: z.enum(['bid', 'no-bid']),
  reasons: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
  price_position: z.string().trim().min(1).max(600),
  credentials_cited: z.array(z.uuid()).max(10),
});
const draftJsonSchema = (() => { const { $schema, ...schema } = z.toJSONSchema(draftSchema, { io: 'input' }); return schema; })();

const system = `You are Tender Desk's tender adviser for one Singapore SME. Decide whether this SME should bid on this government tender,
using only the facts given. Write short, plain reasons a busy owner can act on.
Rules:
- Never state a win probability, a chance of winning, or a "winning price". Past awards are what winners were paid, not what will win.
- Describe the price position only relative to the comparable band: below the lower quartile, between the lower quartile and the median,
  between the median and the upper quartile, or above the upper quartile, with the reason.
- Do not write any digits or numbers at all. Code adds every figure to the brief.
- Cite only project ids from verifiedProjects, and only when the project is relevant. Never mention any other company.`;

export function composeBrief(draft, facts) {
  const band = facts.snapshot.price_band;
  const cited = facts.verifiedProjects.filter((project) => draft.credentials_cited.includes(project.id));
  return [
    '## Recommendation', '', draft.recommendation === 'bid' ? 'Bid' : 'Do not bid', '',
    '## Why', '', ...draft.reasons.map((reason) => `- ${reason}`), '',
    '## Price position', '', draft.price_position, '',
    '## Your verified projects cited', '', ...(cited.length ? cited.map((project) => `- ${project.title}${project.agency ? ` (${project.agency})` : ''}`) : ['None cited.']), '',
    '## Comparable awards', '',
    `${facts.snapshot.n} comparable past awards${facts.query_used ? ` for "${facts.query_used}"` : ''}: lower quartile ${formatSgd(band.low_cents)}, median ${formatSgd(band.median_cents)}, upper quartile ${formatSgd(band.high_cents)}.`,
    '',
    '## Limits', '', briefLimits,
  ].join('\n');
}

export async function draftBrief(facts, { llm, model }) {
  if (facts?.snapshot?.status !== 'ready' || !facts.snapshot.price_band) return { ok: false, reason: 'There are too few comparable awards for a brief.' };
  const prompt = {
    tender: facts.tender,
    comparables: { count: facts.snapshot.n, search: facts.query_used, band_sgd: { lower_quartile: formatSgd(facts.snapshot.price_band.low_cents),
      median: formatSgd(facts.snapshot.price_band.median_cents), upper_quartile: formatSgd(facts.snapshot.price_band.high_cents) },
    top_agencies: (facts.snapshot.top_agencies ?? []).slice(0, 5), top_suppliers: (facts.snapshot.top_suppliers ?? []).slice(0, 5) },
    client: { name: facts.client.name, capabilities: facts.client.capabilities, team_size: facts.client.team_size,
      largest_contract_sgd: formatSgd(facts.client.max_contract_cents), categories: facts.client.categories },
    verifiedProjects: facts.verifiedProjects.map((project) => ({ id: project.id, title: project.title, agency: project.agency,
      value_sgd: project.value_cents === null ? null : formatSgd(project.value_cents) })),
    fit: facts.fit,
  };
  let raw;
  try {
    raw = await llm({ model, system, name: 'tender_brief', jsonSchema: draftJsonSchema, user: JSON.stringify(prompt) });
  } catch {
    return { ok: false, reason: 'The model was unavailable. Try Redraft.' };
  }
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'The model returned an unusable draft. Try Redraft.' };
  const draft = parsed.data;
  const verifiedIds = new Set(facts.verifiedProjects.map((project) => project.id));
  if (!draft.credentials_cited.every((id) => verifiedIds.has(id))) return { ok: false, reason: 'Draft cited a project that is not verified.' };
  const figures = unmatchedFigures([...draft.reasons, draft.price_position].join('\n'), facts.snapshot.price_band, facts.snapshot.n);
  if (figures.length) return { ok: false, reason: `Draft contained figures not in the comparables: ${figures.slice(0, 5).join(', ')}.` };
  return { ok: true, draft: { recommendation: draft.recommendation, content: composeBrief(draft, facts), credentials_cited: draft.credentials_cited } };
}
