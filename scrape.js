import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRoster, fetchReleases, fetchDetail, delay } from './scrapers/nisqually.js';
import { nowLocalIso } from './utils.js';
import { buildStats } from './stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, 'data');
fs.mkdirSync(STORAGE_DIR, { recursive: true });

const LOG_FILE    = path.join(STORAGE_DIR, 'change_log.json');
const STATS_FILE  = path.join(STORAGE_DIR, 'stats.json');
const STATUS_FILE = path.join(STORAGE_DIR, 'status.json');

// If the roster suddenly shrinks below this fraction of who we think is in
// custody, assume the page is broken/partial rather than mass release, and
// don't mark anyone released this run.
const MIN_ROSTER_RATIO = 0.5;

// Detail pages are small (~12-20 KB). Each run fetches them for new
// bookings, new releases and release-list-only bookings, plus this many
// existing inmates (least recently checked first): ~265 people cycle
// through about every 2 hours.
const REFRESH_PER_RUN = Number(process.env.REFRESH_PER_RUN ?? 60);
const DETAIL_DELAY_MS = 300;

// The release search is queried for the last few days (dates only).
const RELEASE_LOOKBACK_DAYS = 3;

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`Could not parse ${file}: ${e.message}`);
    process.exit(1); // never overwrite history with an empty array
  }
  return fallback;
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function daysAgo(todayIso, n) {
  const d = new Date(`${todayIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function applyDetail(entry, detail, now) {
  entry.detailsCheckedAt = now;
  if (!detail) return; // keep what we have
  for (const k of ['inmateId', 'age', 'height', 'weight', 'hair', 'eyes']) {
    if (detail[k]) entry[k] = detail[k];
  }
  if (detail.charges.length) {
    entry.charges = detail.charges;
    entry.arrestingAgency = detail.charges[0].arrestAgency || entry.arrestingAgency || null;
  }
  entry.bondTotal = detail.totalBond;
  if (detail.releasedDate && !entry.officialReleaseDate) entry.officialReleaseDate = detail.releasedDate;
}

// The release list only has dates. A release we noticed on the same day as
// the official date keeps the observed time (accurate to one run); one we
// only learned about later gets the official date.
function settleRelease(entry, officialDate) {
  if (!officialDate) return;
  entry.officialReleaseDate = officialDate;
  if (entry.releaseSource === 'observed' && entry.releasedAt?.slice(0, 10) !== officialDate) {
    entry.releasedAt = officialDate;
    entry.releaseSource = 'official-date';
  }
}

async function run() {
  const now = nowLocalIso();
  const today = now.slice(0, 10);
  console.log(`[${now}] Running scrape...`);

  const log = readJSON(LOG_FILE, []);
  const isFirstRun = log.length === 0;

  let inmates;
  try {
    inmates = await fetchRoster();
  } catch (err) {
    console.error('Roster fetch failed:', err.message);
    process.exit(1);
  }
  console.log(`  Roster: ${inmates.length} in custody`);

  const byId = new Map(log.map(e => [e.id, e]));
  const wasInCustody = log.filter(e => e.status === 'in_custody');

  if (inmates.length === 0 || (wasInCustody.length > 20 && inmates.length < wasInCustody.length * MIN_ROSTER_RATIO)) {
    console.error(`Got ${inmates.length} inmates (expected ~${wasInCustody.length}) — skipping diff to avoid false releases.`);
    process.exit(1);
  }

  const currentIds = new Set();
  const needDetails = [];

  for (const inmate of inmates) {
    if (currentIds.has(inmate.id)) continue;
    currentIds.add(inmate.id);
    const { releaseDate, ...fields } = inmate;

    const existing = byId.get(inmate.id);
    if (!existing) {
      console.log(`  NEW: ${inmate.name} (${inmate.id})`);
      const entry = {
        ...fields,
        inmateId: null, age: null, height: null, weight: null, hair: null, eyes: null,
        charges: [],
        bondTotal: null,
        arrestingAgency: null,
        detailsCheckedAt: null,
        status: 'in_custody',
        // The roster only gives a booking date; firstSeen is the closest
        // thing to a booking time for bookings we watch happen.
        firstSeen: now,
        releasedAt: null,
        officialReleaseDate: null,
        releaseSource: null,
        baseline: isFirstRun
      };
      log.push(entry);
      byId.set(entry.id, entry);
      needDetails.push(entry);
      continue;
    }

    existing.status = 'in_custody';
    existing.releasedAt = null;
    existing.officialReleaseDate = null;
    existing.releaseSource = null;
    existing.name = inmate.name;
    existing.schedRelease = inmate.schedRelease;
    if (inmate.bookedAt) existing.bookedAt = inmate.bookedAt;
  }

  const releases = await fetchReleases(daysAgo(today, RELEASE_LOOKBACK_DAYS), today);
  const releaseById = new Map(releases.filter(r => r.releaseDate).map(r => [r.id, r]));
  console.log(`  Release list (${RELEASE_LOOKBACK_DAYS} days): ${releases.length} rows`);

  let releasedCount = 0;
  for (const entry of wasInCustody) {
    if (currentIds.has(entry.id)) continue;
    console.log(`  RELEASED: ${entry.name} (${entry.id})`);
    entry.status = 'released';
    entry.releasedAt = now;
    entry.releaseSource = 'observed';
    settleRelease(entry, releaseById.get(entry.id)?.releaseDate);
    needDetails.push(entry); // final details: last charges and release date
    releasedCount++;
  }

  // Fill in official dates for recent releases noticed before the list had them.
  for (const entry of log) {
    if (entry.status === 'released' && !entry.officialReleaseDate && releaseById.has(entry.id)) {
      settleRelease(entry, releaseById.get(entry.id).releaseDate);
    }
  }

  // Bookings that started and ended between runs never reach the custody
  // list, but the release list still has them.
  let listOnlyCount = 0;
  for (const person of releaseById.values()) {
    if (byId.has(person.id)) continue;
    console.log(`  RELEASED (release list only): ${person.name} (${person.id})`);
    const { releaseDate, ...fields } = person;
    const entry = {
      ...fields,
      inmateId: null, age: null, height: null, weight: null, hair: null, eyes: null,
      charges: [],
      bondTotal: null,
      arrestingAgency: null,
      detailsCheckedAt: null,
      status: 'released',
      firstSeen: now,
      releasedAt: releaseDate,
      officialReleaseDate: releaseDate,
      releaseSource: 'official-date',
      fromReleaseList: true,
      baseline: false
    };
    log.push(entry);
    byId.set(entry.id, entry);
    needDetails.push(entry);
    listOnlyCount++;
  }

  const queued = new Set(needDetails.map(e => e.id));
  const refresh = log
    .filter(e => e.status === 'in_custody' && !queued.has(e.id))
    .sort((a, b) => (a.detailsCheckedAt || '').localeCompare(b.detailsCheckedAt || ''))
    .slice(0, REFRESH_PER_RUN);
  const toFetch = process.env.SKIP_DETAILS ? [] : [...needDetails, ...refresh];

  console.log(`[${nowLocalIso()}] Fetching details for ${needDetails.length} new/released + ${refresh.length} refresh...`);
  let failures = 0;
  for (const entry of toFetch) {
    const detail = await fetchDetail(entry.id);
    if (!detail) failures++;
    applyDetail(entry, detail, now);
    if (!process.env.DETAIL_DIR) await delay(DETAIL_DELAY_MS);
  }
  console.log(`[${nowLocalIso()}] Details done. ${toFetch.length - failures} ok, ${failures} failed.`);

  log.sort((a, b) =>
    (b.bookedAt || '').localeCompare(a.bookedAt || '') || (b.firstSeen || '').localeCompare(a.firstSeen || '')
  );

  writeJSON(LOG_FILE, log);
  writeJSON(STATUS_FILE, { inCustody: currentIds.size, lastUpdated: now });
  writeJSON(STATS_FILE, buildStats(log, now));
  console.log(`[${nowLocalIso()}] Done. ${needDetails.length - releasedCount - listOnlyCount} new, ${releasedCount} released, ${listOnlyCount} release-list only, ${currentIds.size} in custody.`);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
