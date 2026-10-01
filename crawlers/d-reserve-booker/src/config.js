import { createEnvReader } from '@jscrawlers/core';

/**
 * Everything the booker knows, read from its own env file (see main.js), never
 * from the repo's `.env`.
 *
 * The policy lives here, not in the request: the watcher only says "these
 * cells are open", and what may actually be booked — which dates, which rooms,
 * up to what price, for whom — is decided by this file on this machine.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_SECRET_LENGTH = 32;

function assertDate(value, key) {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${key} must be a YYYY-MM-DD date, got "${value}"`);
  }
  return value;
}

function addDays(date, days) {
  const stamp = new Date(`${date}T00:00:00Z`);
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}

/** "2026-10-09,2026-11-01..2026-11-03" -> Set of YYYY-MM-DD; empty -> null. */
export function parseDateSpec(spec, key = 'BOOKER_DATES') {
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

/**
 * The booking questionnaire, keyed by question code: "8153=0,8154=東京".
 * A multi-choice answer separates its values with `|`.
 */
export function parseAnswers(spec) {
  const answers = {};
  for (const entry of String(spec ?? '').split(',')) {
    if (!entry.trim()) continue;
    const eq = entry.indexOf('=');
    if (eq < 1) throw new Error(`BOOKER_ANSWERS entry "${entry}" must be <code>=<value>`);
    answers[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return answers;
}

/** "127.0.0.1:8787" -> { host, port }. */
export function parseListen(value) {
  const match = /^(.+):(\d{1,5})$/.exec(value);
  if (!match) throw new Error(`BOOKER_LISTEN must be host:port, got "${value}"`);
  return { host: match[1], port: Number(match[2]) };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ serve?: boolean }} [options] serving also needs the shared secret
 */
export function loadConfig(env = process.env, { serve = false } = {}) {
  const read = createEnvReader(env);

  const dates = parseDateSpec(read.required('BOOKER_DATES'));
  // Required: an uncapped auto-booker is never what anyone meant.
  const maxPrice = Number(read.required('BOOKER_MAX_PRICE'));
  if (!(maxPrice > 0)) throw new Error('BOOKER_MAX_PRICE must be a positive number of yen');
  const secret = read.optional('BOOKER_SECRET');
  if (serve && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BOOKER_SECRET must be at least ${MIN_SECRET_LENGTH} characters to serve`);
  }

  // Same shape as the parts of the watcher config booking.js was written
  // against: apiBase, hotelCode, query and booking.
  return {
    apiBase: read.optional('BOOKER_API_BASE', 'https://d-reserve.jp'),
    hotelCode: read.required('BOOKER_HOTEL_CODE'),
    query: {
      lodgerCode: read.optional('BOOKER_LODGER_CODE', '0_1_2_3_4_6'),
      lodgerNum: read.optional('BOOKER_LODGER_NUM', '2_0_0_0_0_0'),
      stays: read.optional('BOOKER_STAYS', '1'),
    },

    booking: {
      username: read.required('BOOKER_LOGIN_USER'),
      password: read.required('BOOKER_LOGIN_PASSWORD'),
      answers: parseAnswers(read.optional('BOOKER_ANSWERS')),
      genders: {
        males: read.integer('BOOKER_ADULT_MALES', 0, { min: 0 }),
        females: read.integer('BOOKER_ADULT_FEMALES', 0, { min: 0 }),
      },
      maxPrice,
    },

    policy: {
      dates,
      roomCodes: new Set(read.list('BOOKER_ROOM_CODES')),
      maxPrice,
      maxAttempts: read.integer('BOOKER_MAX_ATTEMPTS', 3, { min: 1 }),
    },

    server: {
      ...parseListen(read.optional('BOOKER_LISTEN', '127.0.0.1:8787')),
      secret,
      // Off until the person running this machine says otherwise: a server that
      // only dry-runs can be wired up and tested end to end without spending.
      submit: read.bool('BOOKER_SUBMIT', false),
    },

    notify: {
      channels: read.list('BOOKER_NOTIFY_CHANNELS'),
    },
  };
}
