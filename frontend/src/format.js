// Timestamps are Pacific local strings: "2026-10-10T04:26:29".
// Format them by slicing the string rather than via Date, so the display
// doesn't shift if the viewer is in a different time zone.

export function formatDate(ts) {
  if (!ts) return ''
  const [y, m, d] = ts.slice(0, 10).split('-')
  return `${m}/${d}/${y.slice(2)}`
}

export function formatTime(ts) {
  if (!ts || ts.length < 16) return ''
  let h = parseInt(ts.slice(11, 13), 10)
  const min = ts.slice(14, 16)
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${min} ${ampm}`
}

export function formatDateTime(ts) {
  return ts ? `${formatDate(ts)} ${formatTime(ts)}`.trim() : ''
}

// Date-only strings ("2026-09-22") parse as UTC in JS; add a time so they
// parse as local midnight like full timestamps do.
function toDate(ts) {
  return new Date(ts.length === 10 ? `${ts}T00:00:00` : ts)
}

export function formatMoney(n) {
  if (n == null) return null
  return '$' + Number(n).toLocaleString('en-US')
}

export function timeHeld(start, end) {
  if (!start || !end) return null
  const ms = toDate(end) - toDate(start)
  if (!(ms > 0)) return null
  const totalMins = Math.floor(ms / 60000)
  const days = Math.floor(totalMins / 1440)
  const hours = Math.floor((totalMins % 1440) / 60)
  const mins = totalMins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

// Agencies are spelled out ("OLYMPIA PD"); just tidy the capitals.
export function agencyName(name) {
  if (!name) return 'N/A'
  return name.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bPd\b/g, 'PD').replace(/\bSo\b/g, 'SO')
}

export const LEVEL_NAMES = { F: 'Felony', GM: 'Gross Misdemeanor', M: 'Misdemeanor' }

export function levelName(code) {
  return LEVEL_NAMES[code] || code
}

// Only unambiguous codes are named; N, I, P etc. show as-is.
const RACE_NAMES = { W: 'White', B: 'Black', H: 'Hispanic', A: 'Asian', U: 'Unknown' }

export function raceName(code) {
  return RACE_NAMES[code] || code || 'N/A'
}

export function sexName(code) {
  return { M: 'Male', F: 'Female' }[code] || code || 'N/A'
}

// "510" -> 5'10"
export function formatHeight(raw) {
  const s = String(raw || '')
  if (s.length === 3) return `${s[0]}'${s.slice(1)}"`
  return s || 'N/A'
}

// The roster only gives a booking date. For bookings we watched happen,
// firstSeen (within ~30 min of booking) is the better start time.
export function bookingStart(entry) {
  return !entry.baseline && entry.firstSeen ? entry.firstSeen : entry.bookedAt
}

// The official release list has dates only. "~" marks a time we noticed the
// release (accurate to one scrape); a bare date came from the official list.
export function releaseTime(entry, fmt) {
  return (entry.releaseSource === 'observed' ? '~' : '') + fmt(entry.releasedAt)
}
