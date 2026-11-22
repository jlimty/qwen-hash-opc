// Live open tenders from GeBIZ's official RSS feeds (one per procurement subcategory). Only the feeds are read;
// GeBIZ detail pages are never fetched. Each feed lists only its latest few items, so rows are kept and refreshed.
import { categorize } from './tender-data.mjs';

const feed = (name, path, category) => Object.freeze({ name, category, url: `https://www.gebiz.gov.sg/rss/${path}-CREATE_BO_FEED.xml` });

export const feeds = Object.freeze([
  feed('Event Organising', 'Event_Organising', 'events-community'),
  feed('Catering Services', 'Catering_Services', 'catering'),
  feed('Cleaning Services', 'Cleaning_Services', 'cleaning-facilities'),
  feed('Security Services', 'Security_Services', 'security'),
  feed('IT Services & Software Development', 'IT_Services_%26_Software_Development', 'ict-services'),
  feed('Courses', 'Courses', 'training-consultancy'),
  feed('General Building & Minor Construction Works', 'General_Building_%26_Minor_Construction_Works', 'construction-renovation'),
  feed('Professional Services', 'Professional_Services', 'other'),
  feed('Laundry Services', 'Laundry_Services', 'cleaning-facilities'),
  feed('Servers', 'Servers', 'ict-services'),
  feed('Softwares & Licences', 'Softwares_%26_Licences', 'ict-services'),
  feed('Other IT & Telecommunication', 'OthersIT%26Telecommunication', 'ict-services'),
  feed('Advertising Services', 'Advertising_Services', 'other'),
  feed('Public Relations & Counselling', 'Public_Relations_%26_Counselling', 'other'),
  feed('Printing Services', 'Printing_Services', 'other'),
  feed('Survey Services', 'Survey_Services', 'other'),
  feed('Others (Miscellaneous)', 'OthersMiscellaneous', 'other'),
]);

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : '');
const decode = (text) => String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => codePoint(Number(dec)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => entities[name]).trim();
const tag = (block, name) => decode(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1]);
const sgDate = (text) => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?$/.exec(String(text ?? '').trim());
  return match ? { date: `${match[3]}-${match[2]}-${match[1]}`, time: match[4] } : undefined;
};

// A title-based category wins over the feed's broad one (Professional Services covers many kinds of work).
export function parseFeed(xml, source) {
  if (typeof xml !== 'string' || !/<rss[\s>]/.test(xml)) throw new Error('not a GeBIZ feed');
  const items = [];
  for (const [, block] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const fields = Object.fromEntries(tag(block, 'description').split('|').map((part) => part.trim()).filter(Boolean)
      .map((part) => { const at = part.indexOf(': '); return at < 0 ? [part, ''] : [part.slice(0, at).trim(), part.slice(at + 2).trim()]; }));
    const tender_no = Object.entries(fields).find(([key]) => /^IT[QT]$|^RFQ$|^RFP$|^ITO$/.test(key))?.[1]
      ?? Object.values(fields)[0];
    const title = tag(block, 'title');
    const gebiz_url = tag(block, 'link');
    if (!tender_no || !/^[A-Za-z0-9][A-Za-z0-9-]{2,99}$/.test(tender_no) || !title || !gebiz_url.startsWith('https://www.gebiz.gov.sg/')) continue;
    const published = sgDate(fields['Published Date']);
    const closing = sgDate(fields['Closing Date']);
    const titleCategory = categorize(title);
    items.push({
      tender_no, title, agency: fields['Calling Entity'] ?? '', gebiz_url, source_feed: source.name,
      category: titleCategory === 'other' ? source.category : titleCategory,
      published_on: published?.date ?? null,
      closes_at: closing ? `${closing.date}T${closing.time ?? '23:59:59'}+08:00` : null,
    });
  }
  return items;
}

async function fetchFeed(source, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/rss+xml, text/xml' } });
    if (!response.ok) return { name: source.name, ok: false, count: 0, error: `HTTP ${response.status}` };
    const items = parseFeed(await response.text(), source);
    return { name: source.name, ok: true, count: items.length, items };
  } catch (error) {
    return { name: source.name, ok: false, count: 0, error: String(error?.message ?? error).slice(0, 120) };
  }
}

// Claims the refresh atomically (one caller per window), fetches every feed in parallel, then upserts what came back.
// A failing feed is reported, never thrown. Terms already derived for a tender are kept.
export async function refreshOpenTenders(database, { fetchImpl = fetch, now = new Date(), maxAgeMs = 3600000, timeoutMs = 4000, reader } = {}) {
  const claimed = await database.query(`UPDATE tender_desk.feed_state SET refreshed_at=$1
    WHERE id=1 AND (refreshed_at IS NULL OR refreshed_at <= $2) RETURNING id`, [now.toISOString(), new Date(now.getTime() - maxAgeMs).toISOString()]);
  if (!claimed.rows.length) return { refreshed: false, feeds: [] };
  const results = await Promise.all(feeds.map((source) => fetchFeed(source, fetchImpl, timeoutMs)));
  await database.transaction(async (tx) => {
    if (results.some((result) => result.ok)) await tx.query('UPDATE tender_desk.feed_state SET succeeded_at=$1 WHERE id=1', [now.toISOString()]);
    for (const item of results.flatMap((result) => result.items ?? [])) {
      await tx.query(`INSERT INTO tender_desk.open_tenders
        (tender_no,title,agency,published_on,closes_at,gebiz_url,source_feed,category,first_seen,last_seen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        ON CONFLICT (tender_no) DO UPDATE SET title=EXCLUDED.title, agency=EXCLUDED.agency, published_on=EXCLUDED.published_on,
          closes_at=EXCLUDED.closes_at, gebiz_url=EXCLUDED.gebiz_url, last_seen=EXCLUDED.last_seen`,
      [item.tender_no, item.title, item.agency, item.published_on, item.closes_at, item.gebiz_url, item.source_feed, item.category, now.toISOString()]);
    }
  });
  if (typeof reader === 'function') await readNewTenders(database, results.flatMap((result) => result.items ?? []), reader);
  return { refreshed: true, feeds: results.map(({ items, ...rest }) => rest) };
}

// Each tender is read once (search terms and category) and the result stored, so every page uses the same terms.
// A few run at a time; a failed read leaves the row for the next refresh.
async function readNewTenders(database, items, reader) {
  const seen = new Set(items.map((item) => item.tender_no));
  const unread = (await database.query('SELECT tender_no,title,agency,category FROM tender_desk.open_tenders WHERE terms IS NULL')).rows
    .filter((row) => seen.has(row.tender_no));
  for (let at = 0; at < unread.length; at += 4) {
    await Promise.all(unread.slice(at, at + 4).map(async (row) => {
      try {
        const reading = await reader(row);
        if (reading?.terms?.length) {
          await database.query('UPDATE tender_desk.open_tenders SET terms=$1, category=$2 WHERE tender_no=$3 AND terms IS NULL',
            [reading.terms, reading.category ?? row.category, row.tender_no]);
        }
      } catch { /* left unread; tried again next refresh */ }
    }));
  }
}

export async function feedRefreshedAt(database) {
  return (await database.query('SELECT succeeded_at FROM tender_desk.feed_state WHERE id=1')).rows[0]?.succeeded_at ?? null;
}

export async function listOpenTenders(database, { categories, now = new Date(), limit = 50 } = {}) {
  const params = [now.toISOString(), Math.min(Math.max(Number(limit) || 50, 1), 200)];
  const filter = categories?.length ? (params.push(categories), 'AND category = ANY($3::text[])') : '';
  return (await database.query(`SELECT * FROM tender_desk.open_tenders WHERE (closes_at IS NULL OR closes_at > $1) ${filter}
    ORDER BY published_on DESC NULLS LAST, tender_no LIMIT $2`, params)).rows;
}

export async function getOpenTender(database, tender_no) {
  return (await database.query('SELECT * FROM tender_desk.open_tenders WHERE tender_no=$1', [tender_no])).rows[0];
}
