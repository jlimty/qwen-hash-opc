import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeGovernance } from '../src/governance-db.mjs';
import { feeds, listOpenTenders, parseFeed, refreshOpenTenders } from '../src/gebiz-feed.mjs';

const xml = await readFile(new URL('./fixtures/gebiz-professional.xml', import.meta.url), 'utf8');
const professional = feeds.find((feed) => feed.name === 'Professional Services');
const notFound = '<!DOCTYPE html><html><head><title>GeBIZ | Page not found</title></head></html>';
let db;

before(async () => { db = await PGlite.create(); await initializeGovernance(db); });
after(async () => { await db?.close(); });

test('feeds are official GeBIZ business-opportunity RSS URLs with a known category', () => {
  assert.ok(feeds.length >= 8);
  for (const feed of feeds) {
    assert.match(feed.url, /^https:\/\/www\.gebiz\.gov\.sg\/rss\/[^/]+-CREATE_BO_FEED\.xml$/);
    assert.equal(typeof feed.category, 'string');
  }
});

test('parseFeed reads the real Professional Services feed', () => {
  const items = parseFeed(xml, professional);
  assert.equal(items.length, 8);
  const [first] = items;
  assert.equal(first.tender_no, 'RPO000ETQ26000129');
  assert.equal(first.agency, 'Republic Polytechnic');
  assert.equal(first.published_on, '2026-11-20');
  assert.equal(first.closes_at, '2026-12-04T13:00:00+08:00');
  assert.match(first.gebiz_url, /^https:\/\/www\.gebiz\.gov\.sg\/ptn\/opportunity\//);
  assert.doesNotMatch(first.gebiz_url, /&amp;/);
  assert.equal(first.source_feed, 'Professional Services');
  assert.ok(items.some((item) => item.agency === "People's Association"));
});

test('parseFeed rejects the HTML Page not found body', () => {
  assert.throws(() => parseFeed(notFound, professional), /not a GeBIZ feed/);
});

function fakeFetch(calls) {
  return async (url) => {
    calls.push(url);
    if (url === professional.url) return new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    if (url === feeds[0].url) return new Response(notFound, { status: 200, headers: { 'Content-Type': 'text/html' } });
    throw new Error('network down');
  };
}

test('refreshOpenTenders isolates a failing feed and keeps terms on upsert', async () => {
  const calls = [];
  const now = new Date('2026-11-22T00:00:00Z');
  const result = await refreshOpenTenders(db, { fetchImpl: fakeFetch(calls), now });
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, feeds.length);
  const ok = result.feeds.filter((feed) => feed.ok);
  assert.deepEqual(ok.map((feed) => [feed.name, feed.count]), [['Professional Services', 8]]);
  assert.equal(result.feeds.filter((feed) => !feed.ok).length, feeds.length - 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tender_desk.open_tenders')).rows[0].n, 8);
  await db.query("UPDATE tender_desk.open_tenders SET terms=ARRAY['audit'] WHERE tender_no='RPO000ETQ26000129'");
  await refreshOpenTenders(db, { fetchImpl: fakeFetch([]), now, maxAgeMs: 0 });
  const { rows } = await db.query("SELECT terms FROM tender_desk.open_tenders WHERE tender_no='RPO000ETQ26000129'");
  assert.deepEqual(rows[0].terms, ['audit']);
});

test('refreshOpenTenders skips when fresh and fetches nothing', async () => {
  const calls = [];
  const result = await refreshOpenTenders(db, { fetchImpl: fakeFetch(calls), now: new Date('2026-11-22T00:10:00Z') });
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test('listOpenTenders hides closed tenders and filters by category', async () => {
  const before = await listOpenTenders(db, { now: new Date('2026-11-22T00:00:00Z') });
  assert.ok(before.some((row) => row.tender_no === 'RPO000ETQ26000129'));
  const later = await listOpenTenders(db, { now: new Date('2026-12-04T06:00:00Z') });
  assert.ok(!later.some((row) => row.tender_no === 'RPO000ETQ26000129'));
  const none = await listOpenTenders(db, { now: new Date('2026-11-22T00:00:00Z'), categories: ['security'] });
  assert.ok(none.every((row) => row.category === 'security'));
});

test('when every feed fails, the last successful update time stays put', async () => {
  const { feedRefreshedAt } = await import('../src/gebiz-feed.mjs');
  const before = await feedRefreshedAt(db);
  assert.ok(before, 'an earlier refresh succeeded');
  const later = new Date('2026-11-23T05:00:00Z');
  const result = await refreshOpenTenders(db, { fetchImpl: async () => { throw new Error('GeBIZ down'); }, now: later });
  assert.equal(result.refreshed, true);
  assert.equal(new Date(await feedRefreshedAt(db)).getTime(), new Date(before).getTime());
});

test('numeric character references in titles are decoded', () => {
  const xmlWithEntities = '<rss version="2.0"><channel><item><title>Children&#8217;s Day &#x26; Family Fair</title><link>https://www.gebiz.gov.sg/ptn/x</link>'
    + '<description>ITQ: ABC000ETQ26000001 | Published Date: 20/11/2026 | Closing Date: 04/12/2026 13:00:00 | Calling Entity: Agency A |</description></item></channel></rss>';
  assert.equal(parseFeed(xmlWithEntities, professional)[0].title, 'Children’s Day & Family Fair');
});
