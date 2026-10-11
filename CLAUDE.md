# Nisqually Jail Roster — Project Context

## What it is
A public jail roster monitor for Nisqually Corrections (Nisqually Indian
Tribe), which also holds inmates under contract for many cities (Olympia,
Lacey, Tumwater, Tacoma, Federal Way…). Built from the same template as the
`recordwatch/*-county-monitor` repos; the detail parser follows the Kitsap
monitor (`recordwatch/ksco-scraper`), which uses the same jail software.

## Source
"Web Jail Viewer" by Executive Information Services, at
`http://nit-pscapp.nisqually-nsn.gov:81` — **plain http on port 81**.
GitHub Actions reaches it fine; the Claude Code cloud sandbox cannot (its
proxy only supports https on 443), so all live testing happens in Actions.

- `/Home/BookingSearchResult?...&Status=IN+CUSTODY&page=N` — in-custody list,
  40 rows per page: booking #, first/last/middle, race, sex, booking date,
  release date, scheduled release. **Asking for a page past the end returns
  the last page again**, so paging stops on a short page or a repeated page.
- Same endpoint with `Status=OUT+OF+CUSTODY&ReleaseFrom=MM/DD/YYYY&ReleaseTo=MM/DD/YYYY`
  and a **blank** LastName lists releases in that range. Both dates are
  required; `LastName=%` or an open-ended range returns nothing, and no
  dates at all returns everyone ever released. Dates only — no times.
- `/Home/BookingSearchDetail?BookingNumber=N` — Kitsap-format detail page:
  inmate ID, age, height, weight, hair, eyes, and per charge: violation,
  level, clearance, arrest agency, arrest date, court case, next court date,
  bond type and amounts. The results page's "View" links point at row
  indexes, not bookings — build detail URLs from the booking number.

## Architecture
- **Scraper:** `scrape.js` (orchestrator) + `scrapers/nisqually.js` (Cheerio parsing), Node 20 built-in fetch
- **Schedule:** `.github/workflows/scrape.yml`, cron every 30 min (backup only — see Scheduling)
- **Storage:** JSON committed to `data/` — no server, no database
- **Frontend:** React + Vite in `frontend/`, built and pushed to the `gh-pages` branch

## Key facts / gotchas
- Booking `id` = booking number (unique per booking). `inmateId` is per person.
- Booking dates have no time. For bookings we watched happen, `firstSeen` is
  the start time for length-of-stay; baseline entries use the date.
  Date-only strings must be parsed as local midnight (`T00:00:00`).
- Releases: when someone leaves the custody list, `releasedAt` = scrape time
  (`releaseSource: 'observed'`). The release list's date is stored as
  `officialReleaseDate`; if it's a different day than we noticed, the date
  replaces the time (`releaseSource: 'official-date'`).
- Bookings that start and end between runs only appear in the release list;
  they're added with `fromReleaseList: true`.
- Details are fetched for new bookings, new releases, release-list-only
  bookings, plus `REFRESH_PER_RUN` (60) least-recently-checked people —
  everyone refreshes about every 2 hours.
- Race codes: only W/B/H/A/U are named. N, I and P appear but aren't
  documented, so they show as-is. Charge levels F/GM/M are named; others
  (e.g. T) show as-is.
- The jail's own data can be odd (e.g. a booking date in the future).
- Safety: if the roster comes back empty or < 50% of the previous in-custody
  count, the run exits non-zero without marking anyone released.

## Scheduling (important)
- GitHub's own `schedule:` cron is unreliable for small repos — Kitsap's
  measured gaps were 3–9 hours (median ~5.5 h), not 30 minutes.
- The real trigger should be an external **cron-job.org** job that POSTs
  every 30 minutes to
  `https://api.github.com/repos/recordwatch/nisqually-jail-monitor/actions/workflows/scrape.yml/dispatches`
  with body `{"ref":"main"}`, using the same fine-grained token as the county
  repos (Actions: read & write). That token must include this repo, and it
  **expires in August 2027**.

## Data files
- `data/change_log.json` — every booking ever seen, newest `bookedAt` first
- `data/stats.json` — precomputed stats (`stats.js`)
- `data/status.json` — `{ inCustody, lastUpdated }`

## Local dev
- Saved pages: `CUSTODY_DIR=<dir with page1.html…> RELEASES_DIR=<dir> DETAIL_DIR=<dir with detail_<booking>.html> node scrape.js`
- When copying this template elsewhere, **don't copy `data/*.json`** — the
  scraper commits live data, so it comes along with `git ls-files`.
- Frontend: copy `data/*.json` into `frontend/public/data/`, then `cd frontend && npm run dev`
