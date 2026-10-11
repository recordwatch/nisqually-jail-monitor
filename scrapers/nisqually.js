import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

// Nisqually Corrections runs the same "Web Jail Viewer" software (Executive
// Information Services) as Kitsap's incustody.kitsap.gov, on plain http,
// port 81. Only GitHub Actions can reach it; the dev sandbox can't.
const BASE_URL = 'http://nit-pscapp.nisqually-nsn.gov:81';
const RESULTS_URL = `${BASE_URL}/Home/BookingSearchResult`;
const DETAIL_URL = `${BASE_URL}/Home/BookingSearchDetail`;

const HEADERS = {
  'Referer': `${BASE_URL}/Home/BookingSearchQuery`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
};

const PAGE_SIZE = 40;
const MAX_PAGES = 30;
// Per-request cap. A stalled connection would otherwise hang the Actions job.
const REQUEST_TIMEOUT_MS = 30_000;

export async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper. Backoff: 2s, 5s, 10s.
async function getWithRetry(url, attempts = 3) {
  const backoff = [2000, 5000, 10000];
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.error(`  Request failed (attempt ${i + 1}/${attempts}): ${err.message} — retrying in ${backoff[i] / 1000}s`);
        await delay(backoff[i]);
      }
    }
  }
  throw lastErr;
}

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

const pad = n => String(n).padStart(2, '0');

// "10/10/2026" -> "2026-10-10". This system gives dates only, no times.
export function toDate(text) {
  const m = clean(text).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : null;
}

// 2026-10-10 -> "10/10/2026" for the search form.
function formDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${m}/${d}/${y}`;
}

// Results table columns: View, Booking #, First, Last, Middle, Race, Sex,
// Booking Date, Release Date, Sch Rel Date. The "View" links point at row
// indexes, not bookings, so details are fetched by booking number instead.
export function parseResults(html) {
  const $ = cheerio.load(html);
  return $('table.table tbody tr').toArray().map(row => {
    const tds = $(row).children('td').toArray().map(td => clean($(td).text()));
    const [, bookingNumber, first, last, middle, race, sex, bookingDate, releaseDate, schReleaseDate] = tds;
    if (!/^\d+$/.test(bookingNumber || '')) return null;
    return {
      id: bookingNumber,
      bookingNumber,
      name: `${last}, ${[first, middle].filter(Boolean).join(' ')}`.replace(/, $/, ''),
      race: race || null,
      sex: sex || null,
      bookedAt: toDate(bookingDate),
      releaseDate: toDate(releaseDate),
      schedRelease: toDate(schReleaseDate)
    };
  }).filter(Boolean);
}

// Pages hold 40 rows. Asking for a page past the end returns the LAST page
// again (not an empty one), so stop on a short page or a repeated page.
async function fetchAllPages(params, fileEnvPrefix) {
  const people = [];
  let previousFirst = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = process.env[`${fileEnvPrefix}_DIR`]
      ? readSaved(process.env[`${fileEnvPrefix}_DIR`], page)
      : await getWithRetry(`${RESULTS_URL}?${new URLSearchParams({ ...params, page: String(page) })}`);
    if (html == null) break;
    const rows = parseResults(html);
    if (!rows.length || rows[0].id === previousFirst) break;
    previousFirst = rows[0].id;
    people.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    await delay(300);
  }
  return people;
}

// Offline testing: <dir>/page<N>.html
function readSaved(dir, page) {
  const f = path.join(dir, `page${page}.html`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
}

// Everyone in custody. Set CUSTODY_DIR to read saved pages instead.
export async function fetchRoster() {
  return fetchAllPages({
    LastName: '%', FirstName: '', BookingFrom: '', BookingTo: '',
    ReleaseFrom: '', ReleaseTo: '', Status: 'IN CUSTODY', ValidSearch: '',
    sort: 'BookingDate', sortdir: 'DESC'
  }, 'CUSTODY');
}

// People released between two dates. Only works with BOTH dates set and a
// blank last name (an open-ended range or LastName=% returns nothing).
// Dates only — the list has no release times. Non-fatal: returns [] on
// failure so releases fall back to "when we noticed".
export async function fetchReleases(fromIso, toIso) {
  try {
    return await fetchAllPages({
      LastName: '', FirstName: '', BookingFrom: '', BookingTo: '',
      ReleaseFrom: formDate(fromIso), ReleaseTo: formDate(toIso),
      Status: 'OUT OF CUSTODY', ValidSearch: ''
    }, 'RELEASES');
  } catch (err) {
    console.error('Releases fetch failed:', err.message);
    return [];
  }
}

// Detail page parser — same layout as Kitsap's, so this follows the Kitsap
// scraper's fetchDetail (recordwatch/ksco-scraper), plus each charge's Level.
//
// Page structure (repeats for each charge):
//   [N]                                      ← charge number row
//   [Violation: TEXT]  [Level: X]
//   [Add. Desc.: ...]  [OBTS #: ...]
//   [War.#: ...]       [End Of Sentence Date: ...]  [Clearance: ...]
//   [Arrest Agency: ...]  [Case #: ...]  [Arrest Date: MM/DD/YYYY]
//   [Court Type: X]  [Court Case #: ...]  [Next Court Date MM/DD/YYYY]
//   [Req. Bond/Bail: ...]  [Bond Group #: ...]
//   [Req. Bond Amt: $X]  [Req. Cash Amt: $X]  [Bond Co. #: ...]
export function parseDetail(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();
  if (!/Booking Number:/i.test(bodyText)) return null;

  const field = re => bodyText.match(re)?.[1]?.trim() || null;

  function parseDollars(text) {
    const m = text.match(/\$\s*([\d,]+\.?\d*)/);
    if (!m) return null;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return v > 0 ? v : null;
  }
  const after = (td, re) => td.replace(re, '').trim() || null;

  const charges = [];
  let cur = null;
  for (const row of $('table tr').toArray()) {
    const tds = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    if (!tds.length) continue;
    const first = tds[0];

    if (tds.length === 1 && /^\d+$/.test(first)) {
      if (cur) charges.push(cur);
      cur = null;
      continue;
    }

    if (/^Violation:/i.test(first)) {
      if (cur) charges.push(cur);
      const raw = first.replace(/^Violation:\s*/i, '').trim();
      const violation = raw.replace(/\s*\(Cleared\)/i, '').trim();
      cur = {
        violation,
        // "46.61.502 - DUI" -> "DUI": the readable part, for lists and stats.
        description: violation.replace(/^\S+\s+-\s+/, '') || violation,
        cleared: /\(Cleared\)/i.test(raw),
        level: null,
        addDesc: null, clearance: null, bondBailType: null,
        bondAmount: null, cashAmount: null, courtCase: null,
        nextCourtDate: null, arrestAgency: null, arrestDate: null, courtType: null
      };
      for (const td of tds) if (/^Level:/i.test(td)) cur.level = after(td, /^Level:\s*/i);
      continue;
    }
    if (!cur) continue;

    if (/^Add\.?\s*Desc\.?:/i.test(first)) { cur.addDesc = after(first, /^Add\.?\s*Desc\.?:\s*/i); continue; }
    if (/^War\.?#?:/i.test(first)) {
      for (const td of tds) if (/^Clearance:/i.test(td)) cur.clearance = after(td, /^Clearance:\s*/i);
      continue;
    }
    if (/^Req\.?\s*Bond\/Bail:/i.test(first)) { cur.bondBailType = after(first, /^Req\.?\s*Bond\/Bail:\s*/i); continue; }
    if (/^Arrest Agency:/i.test(first)) {
      for (const td of tds) {
        if (/^Arrest Agency:/i.test(td)) cur.arrestAgency = after(td, /^Arrest Agency:\s*/i);
        else if (/^Arrest Date:/i.test(td)) cur.arrestDate = toDate(after(td, /^Arrest Date:\s*/i));
      }
      continue;
    }
    if (/^Court Type:/i.test(first)) {
      for (const td of tds) {
        if (/^Court Type:/i.test(td)) cur.courtType = after(td, /^Court Type:\s*/i);
        else if (/^Court Case\s*#:/i.test(td)) cur.courtCase = after(td, /^Court Case\s*#:\s*/i);
        else if (/^Next Court Date/i.test(td)) cur.nextCourtDate = toDate(td.match(/Next Court Date\s*([\d\/]+)/i)?.[1]);
      }
      continue;
    }
    if (/^Req\.?\s*Bond\s*Amt/i.test(first)) {
      for (const td of tds) {
        if (/^Req\.?\s*Bond\s*Amt/i.test(td)) cur.bondAmount = parseDollars(td);
        if (/^Req\.?\s*Cash\s*Amt/i.test(td)) cur.cashAmount = parseDollars(td);
      }
      continue;
    }
  }
  if (cur) charges.push(cur);

  const totalBond = charges.reduce((s, c) => s + (c.bondAmount || 0) + (c.cashAmount || 0), 0);
  return {
    inmateId: field(/Inmate\s*ID:\s*(\d+)/),
    age: field(/Age:\s*(\d+)/),
    height: field(/Height:\s*(\d+)/),
    weight: field(/Weight:\s*(\d+)/),
    hair: field(/Hair:\s*([A-Z]+)/i),
    eyes: field(/Eyes:\s*([A-Z]+)/i),
    releasedDate: toDate(field(/Released:\s*([\d\/]+)/i)),
    charges,
    totalBond: totalBond > 0 ? totalBond : null
  };
}

// Returns null on failure so callers keep what they already have. Set
// DETAIL_DIR to read <dir>/detail_<booking>.html instead.
export async function fetchDetail(bookingNumber) {
  try {
    const html = process.env.DETAIL_DIR
      ? fs.readFileSync(path.join(process.env.DETAIL_DIR, `detail_${bookingNumber}.html`), 'utf-8')
      : await getWithRetry(`${DETAIL_URL}?BookingNumber=${encodeURIComponent(bookingNumber)}`, 2);
    return parseDetail(html);
  } catch (err) {
    if (!process.env.DETAIL_DIR) console.error(`  Detail fetch failed for ${bookingNumber}: ${err.message}`);
    return null;
  }
}
