// Drafts a reviewed brief in one model call over facts that code assembled. The model writes judgement only (reasons,
// which band position to aim for and why, a requirements check, questions, risks) with no digits; code writes every
// figure: the suggested range in dollars, who usually wins, the comparables. A draft that cites an unverified project,
// writes an internal ID or states a figure that is not in the comparables is refused, never saved.
import { z } from 'zod';
import { formatSgd, unmatchedFigures, wholeSgd } from './brief-risk.mjs';

// Worded without years so the brief's own figure check stays quiet; the customer page shows the full limits line too.
export const briefLimits = 'These are past contract awards, not a quote and not a winning price. GeBIZ publishes winning amounts only, not the bids that lost. Contract scope and length differ between awards.';

export const bandPositions = Object.freeze(['below_lower_quartile', 'lower_quartile_to_median', 'median_to_upper_quartile', 'above_upper_quartile']);
const requirementStatus = { met: 'Met', partly_met: 'Partly met', gap: 'Gap' };

export const draftSchema = z.strictObject({
  recommendation: z.enum(['bid', 'no-bid']).describe('bid or no-bid'),
  reasons: z.array(z.string().trim().min(1).max(600)).min(1).max(5)
    .describe('Two to four reasons about fit, capacity, track record and the buyer, one or two sentences each. Never about price.'),
  price_position: z.strictObject({
    band: z.enum(bandPositions).describe('Where a bid should sit against the comparable awards.'),
    why: z.string().trim().min(40).max(600).describe('Say why a bid should sit there, in one or two sentences. For a no-bid, where a bid would have to sit if they bid anyway, and why.'),
  }),
  requirements: z.array(z.strictObject({
    requirement: z.string().trim().min(1).max(200), status: z.enum(['met', 'partly_met', 'gap']),
    evidence: z.string().trim().min(1).max(300).describe('The verified project (by title) that shows it, or what is missing.'),
  })).max(8).describe('Only when requirements_text is given: its key requirements checked against the client. Otherwise an empty list.'),
  questions: z.array(z.string().trim().min(1).max(300)).max(4).describe('Questions to ask the agency before the clarification deadline.'),
  risks: z.array(z.string().trim().min(1).max(300)).max(3).describe('The main risks of bidding.'),
  credentials_cited: z.array(z.uuid()).max(10).describe('Ids of the verified projects that are relevant to this tender.'),
});
const draftJsonSchema = (() => { const { $schema, ...schema } = z.toJSONSchema(draftSchema, { io: 'input' }); return schema; })();

const system = `You are Tender Desk's tender adviser for one Singapore SME. Decide whether this SME should bid on this government tender,
using only the facts given, and write for a busy owner in plain English.
Rules:
- Keep price out of the reasons. Reasons cover fit with the work, capacity, track record and the buyer; price lives only in price_position.
  Give two to four reasons, one or two sentences each.
- In price_position, pick where a bid should sit against the comparable awards and say why. Code turns your choice into dollar figures.
  For a no-bid, still fill price_position (it is kept for the admin only, never shown to the client).
- If requirements_text is given, check its key requirements against the client's profile and verified projects (met, partly_met or gap),
  quoting each requirement briefly. If it is not given, return an empty requirements list.
- Add up to four questions worth asking the agency before the clarification deadline, and up to three risks.
  In requirements, questions and risks, quote a number only if it appears in the tender or requirements_text.
- Never state a win probability, a chance of winning, or a "winning price". Past awards are what winners were paid, not what will win.
- Do not write any digits or numbers at all in reasons or price_position, and no quantities in words either ("a third", "half", "twice",
  "four", "percent"). Code adds every figure to the brief. Describe size and share in plain terms ("the most active buyer").
- Judge each verified project by its title and agency, cite every one that is relevant to this tender, and say how it is relevant.
  Refer to a project by its title, never by an ID. If you mention a verified project in your text, cite it.
  Cite only ids from verifiedProjects. Never mention any other company.
- Never use internal labels or field names (such as "fit", "scored", "category match" or "related projects") in what you write.
- If admin_note is given, follow it: it is the reviewer's instruction for this redraft.`;

// Names the rule a draft broke, so the admin (and the rehearsal) can tell a strict rule from a weak model.
function describeIssues(issues, raw) {
  return issues.slice(0, 2).map((issue) => {
    const path = issue.path.join('.') || 'draft';
    const value = issue.path.reduce((at, key) => at?.[key], raw);
    const size = typeof value === 'string' ? `${value.length} characters` : Array.isArray(value) ? `${value.length} items` : undefined;
    if (issue.code === 'too_small') return `${path}: too short${size ? ` (${size}, needs at least ${issue.minimum})` : ''}`;
    if (issue.code === 'too_big') return `${path}: too long${size ? ` (${size}, allows at most ${issue.maximum})` : ''}`;
    return `${path}: ${issue.message}`;
  }).join('; ').slice(0, 300);
}

// Quantities in words are figures the code did not compute. "one" is allowed ("one of the most active buyers").
const quantityWords = /\b(halves|half|thirds?|quarters?|fifths?|tenths?|twice|double|triple|treble|dozens?|percent|per cent|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?)\b/gi;
const internalId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|\b(PRJ|CLI|BRF|REQ|CON|AUD)\d{5,}\b/i;

export function suggestedRange(band, position) {
  const low = band.low_cents; const median = band.median_cents; const high = band.high_cents;
  if (position === 'below_lower_quartile') return { to_cents: low, text: `Below ${wholeSgd(low)}` };
  if (position === 'above_upper_quartile') return { from_cents: high, text: `Above ${wholeSgd(high)}` };
  const [from, to] = position === 'median_to_upper_quartile' ? [median, high] : [low, median];
  return { from_cents: from, to_cents: to, text: `${wholeSgd(from)} to ${wholeSgd(to)}` };
}
export const positionText = Object.freeze({ below_lower_quartile: 'Below the lower quartile', lower_quartile_to_median: 'Between the lower quartile and the median',
  median_to_upper_quartile: 'Between the median and the upper quartile', above_upper_quartile: 'Above the upper quartile' });
export const thinText = 'No dollar range: too few comparable awards, or awards too varied, to put a figure on. Treat the past awards as context.';

// The structured brief (for the customer's visual report) and its Markdown form (for the console, MCP and history).
export function composeBrief(draft, facts) {
  const band = facts.snapshot.price_band;
  // A no-bid carries no price advice: the tender is freed once it's approved, so it must not leave a priced position behind.
  const bid = draft.recommendation === 'bid';
  // Thin evidence (under ten awards, or a band wider than five times) gets a rough position, never a dollar range.
  const thin = Boolean(facts.snapshot.thin);
  const range = bid && !thin ? suggestedRange(band, draft.price_position.band) : null;
  const position = bid && thin ? positionText[draft.price_position.band] : null;
  const winners = (facts.snapshot.top_suppliers ?? []).slice(0, 5).map(({ name, wins }) => ({ name, wins }));
  const cited = facts.verifiedProjects.filter((project) => draft.credentials_cited.includes(project.id)).map(({ title, agency }) => ({ title, agency: agency ?? null }));
  const requirements = facts.requirements_text ? draft.requirements : [];
  const parts = { recommendation: draft.recommendation, reasons: draft.reasons, price_position: bid ? draft.price_position : null, suggested_range: range,
    winners, n: facts.snapshot.n, query_used: facts.query_used ?? null, requirements, questions: draft.questions, risks: draft.risks, cited,
    thin, position_text: position, excluded_panels: Number(facts.snapshot.excluded_panels ?? 0) };
  const list = (items) => (items.length ? items.map((item) => `- ${item}`) : ['None.']);
  const content = [
    '## Recommendation', '', draft.recommendation === 'bid' ? 'Bid' : 'Do not bid', '',
    '## Why', '', ...list(draft.reasons), '',
    ...(range ? ['## Suggested price range', '', range.text, '', draft.price_position.why, ''] : []),
    ...(position ? ['## Where to price', '', thinText, '', `Roughly: ${position.toLowerCase()}. ${draft.price_position.why}`, ''] : []),
    '## Who usually wins', '', ...list(winners.map((w) => w.name)), '',
    ...(requirements.length ? ['## Requirements check', '', ...list(requirements.map((r) => `${requirementStatus[r.status]}: ${r.requirement} (${r.evidence})`)), ''] : []),
    ...(draft.questions.length ? ['## Questions to ask the agency', '', ...list(draft.questions), ''] : []),
    ...(draft.risks.length ? ['## Risks', '', ...list(draft.risks), ''] : []),
    '## Your verified projects cited', '', ...(cited.length ? cited.map((p) => `- ${p.title}${p.agency ? ` (${p.agency})` : ''}`) : ['None cited.']), '',
    '## Comparable awards', '',
    `${facts.snapshot.n} comparable past awards${facts.query_used ? ` for "${facts.query_used}"` : ''}: lower quartile ${wholeSgd(band.low_cents)}, median ${wholeSgd(band.median_cents)}, upper quartile ${wholeSgd(band.high_cents)}.`,
    '',
    '## Limits', '', briefLimits,
  ].join('\n');
  // The admin's risk facts look at the model's own words only; code-written figures and quoted requirements are not its claims.
  const riskText = [...draft.reasons, draft.price_position.why, ...draft.questions, ...draft.risks, ...requirements.map((r) => r.evidence)].join('\n');
  return { content, parts, riskText };
}

// Every rule a draft must pass, shared by fresh drafts and the admin's edits.
export function checkDraft(raw, facts) {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `The model returned an unusable draft (${describeIssues(parsed.error.issues, raw)}). Try Redraft.` };
  const draft = parsed.data;
  if (draft.reasons.some((reason) => /\b(price|priced|pricing|quartile|median|band)\b/i.test(reason))) {
    return { ok: false, reason: 'Draft repeated the price position in its reasons. Try Redraft.' };
  }
  const prose = [...draft.reasons, draft.price_position.why].join('\n');
  // Names the facts already contain (an agency like "Ministry of Defence 6", a tender title, the client's projects) are not figures.
  const names = [facts.tender?.agency, facts.tender?.title, facts.client?.name, ...facts.verifiedProjects.flatMap((p) => [p.title, p.agency])]
    .filter((name) => typeof name === 'string' && /\d/.test(name)).sort((a, b) => b.length - a.length);
  const unnamed = (text) => names.reduce((out, name) => out.split(name).join(' '), text);
  const spelled = [...new Set(unnamed(prose).match(quantityWords) ?? [])].map((word) => word.toLowerCase());
  if (spelled.length) return { ok: false, reason: `Draft stated quantities in words: ${spelled.slice(0, 5).join(', ')}. Try Redraft.` };
  const everything = [prose, ...draft.questions, ...draft.risks, ...draft.requirements.flatMap((r) => [r.requirement, r.evidence])].join('\n');
  if (internalId.test(everything)) return { ok: false, reason: 'Draft wrote an internal ID. Name projects by their title. Try Redraft.' };
  const verifiedIds = new Set(facts.verifiedProjects.map((project) => project.id));
  if (!draft.credentials_cited.every((id) => verifiedIds.has(id))) return { ok: false, reason: 'Draft cited a project that is not verified.' };
  // Questions, risks and the requirements check may quote numbers only from the tender or the pasted requirements
  // (durations, terms, headcounts); money anywhere is checked against the comparables.
  const quoted = [...draft.questions, ...draft.risks, ...draft.requirements.flatMap((r) => [r.requirement, r.evidence])].join('\n');
  const sources = unnamed([facts.requirements_text, facts.tender?.pasted_text, facts.tender?.title, facts.tender?.agency].filter(Boolean).join('\n')).replace(/,/g, '');
  const stray = [...new Set((unnamed(quoted).replace(/S?\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million)?/gi, ' ').match(/\d+(?:\.\d+)?/g) ?? []))]
    .filter((n) => !new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d])`).test(sources));
  if (stray.length) return { ok: false, reason: `Draft quoted a number that is not in the tender or the pasted requirements: ${stray.slice(0, 5).join(', ')}. Try Redraft.` };
  const money = quoted.match(/(?:S?\$\s?)\d[\d,]*(?:\.\d+)?\s?(?:k|m|million)?\b|\d[\d,]*(?:\.\d+)?\s?(?:k|m|million)\b/gi) ?? [];
  const figures = unmatchedFigures([unnamed(prose), money.join(' ')].join('\n'), facts.snapshot.price_band, facts.snapshot.n);
  if (figures.length) return { ok: false, reason: `Draft contained figures not in the comparables: ${figures.slice(0, 5).join(', ')}.` };
  const { content, parts, riskText } = composeBrief(draft, facts);
  return { ok: true, draft: { recommendation: draft.recommendation, content, parts, risk_text: riskText, credentials_cited: draft.credentials_cited } };
}

export async function draftBrief(facts, { llm, model, note }) {
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
    fit: { in_your_categories: Boolean(facts.fit?.category_match),
      median_compared_with_your_largest_contract: facts.fit?.within_capacity === true ? 'within' : facts.fit?.within_capacity === false ? 'above' : 'unknown' },
    ...(facts.requirements_text && { requirements_text: facts.requirements_text }),
    ...(note && { admin_note: String(note).slice(0, 1000) }),
  };
  // A model call now and then breaks a writing rule it was given; feeding the refusal back and redrafting absorbs
  // that without loosening a rule. Anything still refused after three attempts is left for the admin.
  let previousRefusal = '';
  for (let attempt = 1; ; attempt++) {
    let raw;
    try {
      raw = await llm({ model, system, name: 'tender_brief', jsonSchema: draftJsonSchema, timeoutMs: 90000, reasoning: { effort: 'low' },
        user: JSON.stringify(previousRefusal ? { ...prompt, previous_refusal: previousRefusal } : prompt) });
    } catch (error) {
      const why = /^model unavailable: (.+)$/.exec(String(error?.message ?? ''))?.[1];
      return { ok: false, reason: `The model was unavailable${why ? ` (${why})` : ''}. Try Redraft.` };
    }
    const result = checkDraft(raw, facts);
    if (result.ok || attempt === 3) return result;
    previousRefusal = result.reason.replace(/ Try Redraft\.$/, '');
  }
}
