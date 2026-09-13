import { createEnvReader, parseDuration } from '@jscrawlers/core';

/**
 * Every knob this crawler has, read from the environment.
 *
 * Nothing here is hard-coded to one hotel or one trip: the target, the date
 * range, the party size and the notification wiring all come from `.env`, which
 * is git-ignored. See `.env.example` for the full list.
 */

/** The calendar API refuses a fromYM..toYM span wider than this. */
export const MAX_MONTHS_PER_REQUEST = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Re-exported because index.js and the tests reach for it here, and `--interval`
// is a crawler-level flag rather than a core concern.
export { parseDuration };

function assertDate(value, key) {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${key} must be a YYYY-MM-DD date, got "${value}"`);
  }
  return value;
}

/** Inclusive list of every YYYY-MM between two dates: ['202609', '202610', ...]. */
export function monthsBetween(fromDate, toDate) {
  const months = [];
  const [fy, fm] = fromDate.split('-').map(Number);
  const [ty, tm] = toDate.split('-').map(Number);
  for (let year = fy, month = fm; year < ty || (year === ty && month <= tm);) {
    months.push(`${year}${String(month).padStart(2, '0')}`);
    if (++month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}

/**
 * Group the months into request windows no wider than the API's 2-month limit.
 * 2026-09-10..2026-11-15 -> [{fromYM:'202609',toYM:'202610'}, {fromYM:'202611',toYM:'202611'}]
 */
export function monthWindows(fromDate, toDate, size = MAX_MONTHS_PER_REQUEST) {
  const months = monthsBetween(fromDate, toDate);
  const windows = [];
  for (let i = 0; i < months.length; i += size) {
    const chunk = months.slice(i, i + size);
    windows.push({ fromYM: chunk[0], toYM: chunk[chunk.length - 1] });
  }
  return windows;
}

/**
 * Expand a watch-date spec into a Set of YYYY-MM-DD.
 * Accepts single dates and inclusive `A..B` ranges, mixed and comma-separated:
 *   "2026-10-09,2026-11-01..2026-11-03"
 * Returns null when the spec is empty, meaning "no date restriction".
 */
export function parseDateSpec(spec, key = 'DRESERVE_WATCH_DATES') {
  const entries = String(spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;

  const dates = new Set();
  for (const entry of entries) {
    const [start, end] = entry.split('..').map((part) => part.trim());
    assertDate(start, key);
    if (end === undefined) {
      dates.add(start);
      continue;
    }
    assertDate(end, key);
    if (end < start) throw new Error(`${key} range "${entry}" ends before it starts`);
    for (let day = start; day <= end; day = addDays(day, 1)) dates.add(day);
  }
  return dates;
}

/** YYYY-MM-DD + n days, staying in UTC so DST never shifts a calendar date. */
export function addDays(date, days) {
  const stamp = new Date(`${date}T00:00:00Z`);
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}

const DAYS_OF_WEEK = new Set([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

/**
 * Read the whole configuration. Throws with an actionable message when a
 * required value is missing or malformed, so a bad `.env` fails on the first
 * run rather than silently monitoring the wrong thing.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const read = createEnvReader(env);

  const fromDate = assertDate(read.required('DRESERVE_FROM_DATE'), 'DRESERVE_FROM_DATE');
  const toDate = assertDate(read.required('DRESERVE_TO_DATE'), 'DRESERVE_TO_DATE');
  if (toDate < fromDate) throw new Error('DRESERVE_TO_DATE is before DRESERVE_FROM_DATE');

  const daysOfWeek = read.list('DRESERVE_WATCH_DAYS_OF_WEEK').map((day) => day.toUpperCase());
  for (const day of daysOfWeek) {
    if (!DAYS_OF_WEEK.has(day)) {
      throw new Error(`DRESERVE_WATCH_DAYS_OF_WEEK has an unknown day "${day}"`);
    }
  }

  const maxPrice = read.optional('DRESERVE_WATCH_MAX_PRICE');

  return {
    apiBase: read.optional('DRESERVE_API_BASE', 'https://d-reserve.jp'),
    hotelCode: read.required('DRESERVE_HOTEL_CODE'),
    fromDate,
    toDate,
    windows: monthWindows(fromDate, toDate),

    query: {
      lodgerCode: read.optional('DRESERVE_LODGER_CODE', '0_1_2_3_4_6'),
      lodgerNum: read.optional('DRESERVE_LODGER_NUM', '2_0_0_0_0_0'),
      stays: read.optional('DRESERVE_STAYS', '1'),
      onlyAllLanguagesPlan: read.bool('DRESERVE_ONLY_ALL_LANGUAGES_PLAN', false),
      onlyAllRankPlan: read.bool('DRESERVE_ONLY_ALL_RANK_PLAN', false),
    },

    poll: {
      intervalMs: read.duration('DRESERVE_INTERVAL', '5m'),
      requestDelayMs: read.number('DRESERVE_REQUEST_DELAY_MS', 1500),
      keepRaw: read.bool('DRESERVE_KEEP_RAW', false),
      rawKeep: read.number('DRESERVE_RAW_KEEP', 48),
    },

    // Every field is optional; an empty one simply does not narrow the match.
    watch: {
      dates: parseDateSpec(read.optional('DRESERVE_WATCH_DATES')),
      roomCodes: new Set(read.list('DRESERVE_WATCH_ROOM_CODES')),
      roomName: read.optional('DRESERVE_WATCH_ROOM_NAME'),
      daysOfWeek: new Set(daysOfWeek),
      maxPrice: maxPrice === '' ? null : read.number('DRESERVE_WATCH_MAX_PRICE'),
      minStock: read.number('DRESERVE_WATCH_MIN_STOCK', 1),
    },

    notify: {
      channels: read.list('DRESERVE_NOTIFY_CHANNELS'),
      cooldownMs: read.number('DRESERVE_NOTIFY_COOLDOWN_MIN', 0) * 60_000,
      grouped: read.bool('DRESERVE_NOTIFY_GROUPED', true),
      onFirstRun: read.bool('DRESERVE_NOTIFY_ON_FIRST_RUN', false),
      bookingUrl: read.optional('DRESERVE_BOOKING_URL'),
    },

    // The daily digest is deliberately independent of the watch filter: the
    // immediate alerts narrow to the date being booked, the digest is how the
    // release pattern across every date becomes visible.
    daily: {
      timeZone: read.timeZone('DRESERVE_DAILY_TZ', 'Asia/Taipei'),
      hour: read.integer('DRESERVE_DAILY_HOUR', 20, { min: 0, max: 23 }),
      channels: read.list('DRESERVE_DAILY_CHANNELS'),
      maxBackfill: read.number('DRESERVE_DAILY_MAX_BACKFILL', 7),
      maxChars: read.number('DRESERVE_DAILY_MAX_CHARS', 3500),
    },

    reportTz: read.optional('DRESERVE_REPORT_TZ', 'Asia/Tokyo'),
  };
}
