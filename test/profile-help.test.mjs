import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownAwards, prefillValues, profileGaps, readProfile } from '../src/profile-help.mjs';
import { parseTenderCsv } from '../src/tender-data.mjs';

const header = 'tender_no,tender_description,agency,award_date,tender_detail_status,supplier_name,awarded_amt\n';
const dataset = parseTenderCsv(header + [
  'A1,Community festival for a town council,Town Council A,1/3/2024,Awarded to Suppliers,ASTER EVENTS PTE. LTD.,85000.00',
  'A2,School carnival,Ministry of Education,1/5/2025,Awarded to Suppliers,Aster Events Pte Ltd,42000.50',
  'A3,Heritage week,Agency B,1/6/2023,Awarded to Suppliers,Other Firm Pte Ltd,10000',
  'A4,Panel of event companies,Agency C,1/7/2025,Awarded to Suppliers,Aster Events Pte Ltd,0',
  'HOLD,2026 gala,Agency D,1/2/2026,Awarded to Suppliers,Aster Events Pte Ltd,99000',
].join('\n'));

test('ownAwards finds a company\'s own GeBIZ awards by its registered name, newest first, never the backtest hold-out', () => {
  const found = ownAwards(dataset, 'Aster Events Pte. Ltd');
  assert.deepEqual(found.map((a) => a.gebiz_tender_no), ['A2', 'A1']);
  assert.deepEqual(found[0], { title: 'School carnival', agency: 'Ministry of Education', value_cents: 4200050, gebiz_tender_no: 'A2', award_date: '2025-05-01' });
  assert.deepEqual(ownAwards(dataset, 'Nobody Pte Ltd'), []);
  assert.deepEqual(ownAwards(dataset, ''), []);
});

const reading = { capabilities: 'Corporate events and community festivals with an in-house crew.', categories: ['events-community'], team_size: 8,
  max_contract_sgd: 300000, past_projects: [{ title: 'Annual dinner for a bank', agency: null, value_sgd: 60000 }, { title: 'Community festival for a town council', agency: 'Town Council A', value_sgd: null }] };

test('readProfile turns pasted text into a draft profile, and says why when there is no model', async () => {
  let call;
  const result = await readProfile({ name: 'Aster Events', text: 'We run events...' }, { llm: async (args) => { call = args; return reading; }, model: 'r' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, reading);
  assert.match(call.system, /only what the text says/i);
  assert.match(call.user, /We run events/);
  assert.deepEqual(await readProfile({ name: 'x', text: 'y' }, {}), { ok: false, reason: 'The AI reader is not set up, so only your GeBIZ awards were looked up.' });
  const twice = await readProfile({ name: 'x', text: 'y' }, { llm: async () => ({ ...reading, categories: ['events-community', 'events-community'] }), model: 'r' });
  assert.deepEqual(twice.profile.categories, ['events-community']);
  const broken = await readProfile({ name: 'x', text: 'y' }, { llm: async () => ({ capabilities: 5 }), model: 'r' });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /could not read/);
});

test('prefillValues puts GeBIZ awards first (they can be checked), then the text\'s projects without repeats, within the free slots', () => {
  const awards = ownAwards(dataset, 'Aster Events Pte Ltd');
  const values = prefillValues({ reading, awards, slots: 3 });
  assert.equal(values.capabilities, reading.capabilities);
  assert.deepEqual(values.categories, ['events-community']);
  assert.equal(values.team_size, '8');
  assert.equal(values.max_contract, '300000');
  assert.equal(values.project_title_0, 'School carnival');
  assert.equal(values.project_gebiz_0, 'A2');
  assert.equal(values.project_value_0, '42000.50');
  assert.equal(values.project_title_1, 'Community festival for a town council');
  assert.equal(values.project_gebiz_1, 'A1');
  assert.equal(values.project_title_2, 'Annual dinner for a bank', 'the text\'s festival repeats a GeBIZ award, so it is skipped');
  assert.equal(values.project_value_2, '60000');
  assert.equal(values.project_title_3, undefined);
  // Awards already on the profile are not suggested again.
  assert.equal(prefillValues({ awards, slots: 3, listed: ['A2'] }).project_gebiz_0, 'A1');
});

test('profileGaps names what would make a brief weak, in plain words', () => {
  const client = { capabilities: 'Events.', categories: ['events-community'] };
  assert.deepEqual(profileGaps({ client, projects: [], terms: ['event management'] }).map((g) => g.code), ['thin_description', 'no_projects']);
  const projects = [{ title: 'School carnival', verified: false }];
  assert.deepEqual(profileGaps({ client, projects, terms: ['event'] }).map((g) => g.code), ['thin_description', 'none_checked']);
  const rich = { capabilities: 'Corporate events, community festivals, school programmes and exhibitions, with an in-house crew of eight.', categories: ['events-community'] };
  assert.deepEqual(profileGaps({ client: rich, projects: [{ title: 'Annual dinner for a bank', verified: true }], terms: ['cleaning'] }).map((g) => g.code), ['no_related_project']);
  assert.deepEqual(profileGaps({ client: rich, projects: [{ title: 'Cleaning for a school', verified: true }], terms: ['cleaning'] }), []);
  assert.match(profileGaps({ client, projects: [], terms: [] })[0].message, /what your company does/);
});
