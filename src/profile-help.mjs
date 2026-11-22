// Helps a customer build a profile that makes a brief worth its credit: their own GeBIZ awards found by company name,
// a draft profile read from text they paste, and the gaps that would make a brief weak. Nothing here saves anything:
// it only fills the profile form, which the customer checks, edits and saves themselves.
import { z } from 'zod';
import { normaliseCompany } from './gebiz-check.mjs';
import { categorize, tenderCategories } from './tender-data.mjs';

export const maxProfileText = 6000;

// The company's own past awards, matched on the exact registered name after normalisation (the same rule as the
// admin's GeBIZ cross-check, so a suggested project will match when it is checked). Hold-out awards are left out:
// they stay hidden until the backtest reveals them.
export function ownAwards(dataset, companyName, { limit = 6 } = {}) {
  const wanted = normaliseCompany(companyName);
  if (!wanted) return [];
  return dataset.contracts.filter((contract) => !contract.is_holdout)
    .flatMap((contract) => contract.suppliers.filter((s) => s.awarded_cents > 0 && normaliseCompany(s.name) === wanted)
      .map((s) => ({ title: contract.description.slice(0, 250), agency: contract.agency, value_cents: s.awarded_cents, gebiz_tender_no: contract.tender_no, award_date: contract.last_award_date })))
    .sort((a, b) => (a.award_date === b.award_date ? (a.gebiz_tender_no < b.gebiz_tender_no ? -1 : 1) : a.award_date > b.award_date ? -1 : 1))
    .slice(0, limit);
}

const money = z.number().nonnegative().max(1e10).nullable();
export const profileReadingSchema = z.strictObject({
  capabilities: z.string().trim().min(1).max(600).describe('What the company does, in two or three plain sentences, from the text.'),
  categories: z.array(z.enum(tenderCategories)).max(4).describe('Tender categories the company bids in, from the allowed list.'),
  team_size: z.number().int().min(1).max(100000).nullable().describe('Only if the text states it.'),
  max_contract_sgd: money.describe('The largest contract value the text says they delivered or can deliver, in Singapore dollars. Only if stated.'),
  past_projects: z.array(z.strictObject({ title: z.string().trim().min(1).max(250), agency: z.string().trim().max(250).nullable(), value_sgd: money }))
    .max(6).describe('Past projects named in the text: what was delivered and for whom.'),
});
const readingJsonSchema = (() => { const { $schema, ...schema } = z.toJSONSchema(profileReadingSchema, { io: 'input' }); return schema; })();

const system = `You help a Singapore SME fill in its Tender Desk company profile from text it pasted (a capability statement,
company profile or website "About" page). Use only what the text says: never guess a team size, a contract value or a project.
Leave a field null or a list empty when the text does not say. Write capabilities in plain English, two or three sentences.
Pick a category only when the text names that line of work as one of the company's main services, not a side job (minor repairs are not construction).
Each past project is one thing delivered for one client: a short title naming the work and, if given, the client or agency.`;

export async function readProfile({ name, text } = {}, { llm, model } = {}) {
  if (typeof llm !== 'function') return { ok: false, reason: 'The AI reader is not set up, so only your GeBIZ awards were looked up.' };
  try {
    const raw = await llm({ model, system, name: 'profile_reading', jsonSchema: readingJsonSchema, reasoning: { enabled: false }, timeoutMs: 30000,
      user: JSON.stringify({ company: String(name ?? '').slice(0, 150), text: String(text ?? '').slice(0, maxProfileText) }) });
    const parsed = profileReadingSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'The AI reader could not read that text. Fill in the form yourself, or try pasting less.' };
    return { ok: true, profile: { ...parsed.data, categories: [...new Set(parsed.data.categories)] } };
  } catch {
    return { ok: false, reason: 'The AI reader is busy right now, so only your GeBIZ awards were looked up.' };
  }
}

// Money in the form is written with thousands separators; the form parser accepts them.
const dollars = (cents) => (cents / 100).toLocaleString('en-SG', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
const sameTitle = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Form values for the profile page. GeBIZ awards come first because they can be checked and cited; projects from the
// text follow, skipping any that repeat an award; awards already on the profile are not suggested again.
export function prefillValues({ reading, awards = [], slots = 6, listed = [] }) {
  const values = {};
  if (reading) {
    values.capabilities = reading.capabilities;
    if (reading.team_size) values.team_size = String(reading.team_size);
    // The text gives past contract sizes, not what the company could take on, so it is shown as a hint, never filled in.
    if (reading.max_contract_sgd) values.largest_mentioned = Math.round(reading.max_contract_sgd).toLocaleString('en-SG');
  }
  const categories = [...new Set([...(reading?.categories ?? []), ...awards.map((a) => categorize(a.title)).filter((c) => c !== 'other')])];
  if (categories.length) values.categories = categories;
  const fresh = awards.filter((award) => !listed.includes(award.gebiz_tender_no));
  const projects = [
    ...fresh.map((a) => ({ title: a.title, agency: a.agency, value: dollars(a.value_cents), gebiz: a.gebiz_tender_no })),
    ...(reading?.past_projects ?? []).filter((p) => !fresh.some((a) => sameTitle(a.title, p.title)))
      .map((p) => ({ title: p.title, agency: p.agency ?? '', value: p.value_sgd ? Math.round(p.value_sgd).toLocaleString('en-SG') : '', gebiz: '' })),
  ].slice(0, slots);
  projects.forEach((p, i) => Object.assign(values, { [`project_title_${i}`]: p.title, [`project_agency_${i}`]: p.agency, [`project_value_${i}`]: p.value, [`project_gebiz_${i}`]: p.gebiz }));
  return values;
}

const words = (text) => (String(text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4);
const related = (title, terms) => words(title).some((w) => terms.flatMap(words).some((t) => w.startsWith(t) || t.startsWith(w)));

// What would make a brief on this tender weak. Advice only: nothing is blocked. Worded for the customer, or for the admin.
const gapText = {
  customer: { thin_description: 'Say more about what your company does: the work, the clients you serve and the size of jobs you take on.',
    no_projects: 'Add past projects. A brief can only point to work you have done.',
    none_checked: 'None of your projects has been checked yet, so the brief cannot cite your track record. Projects with a GeBIZ tender number are checked fastest.',
    no_related_project: "None of your checked projects looks like this tender's work. If you have done similar work, add it." },
  admin: { thin_description: 'Says little about what the company does.', no_projects: 'No past projects listed.',
    none_checked: 'No project checked yet, so nothing can be cited.', no_related_project: 'No checked project matches this work.' },
};
export function profileGaps({ client, projects = [], terms = [], audience = 'customer' }) {
  const codes = [];
  if (String(client?.capabilities ?? '').trim().length < 60) codes.push('thin_description');
  const verified = projects.filter((p) => p.verified);
  if (!projects.length) codes.push('no_projects');
  else if (!verified.length) codes.push('none_checked');
  else if (terms.length && !verified.some((p) => related(p.title, terms))) codes.push('no_related_project');
  return codes.map((code) => ({ code, message: gapText[audience][code] }));
}
