import { parseDuration } from './time.js';

/**
 * Typed readers over an environment object.
 *
 * Every crawler's config is "read a handful of env vars, fail loudly when one is
 * missing or malformed". Binding the env once keeps the call sites to the part
 * that actually varies:
 *
 *   const read = createEnvReader(env);
 *   const code = read.required('DRESERVE_HOTEL_CODE');
 *   const keep = read.number('DRESERVE_RAW_KEEP', 48);
 *
 * The messages are deliberately actionable: a bad `.env` should fail on the
 * first run with the name of the variable to fix, not at 3am three days later.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function createEnvReader(env = process.env) {
  /** Trimmed value, or `fallback` when unset/blank. */
  function optional(key, fallback = '') {
    const value = env[key]?.trim();
    return value === undefined || value === '' ? fallback : value;
  }

  function required(key) {
    const value = optional(key);
    if (!value) throw new Error(`${key} is required — copy .env.example to .env and fill it in`);
    return value;
  }

  function bool(key, fallback = false) {
    const value = optional(key);
    if (value === '') return fallback;
    return value === 'true' || value === '1' || value === 'yes';
  }

  function number(key, fallback) {
    const value = optional(key);
    if (value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${value}"`);
    return parsed;
  }

  /** A whole number, optionally bounded — for hours, counts, retries. */
  function integer(key, fallback, { min = -Infinity, max = Infinity } = {}) {
    const value = number(key, fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      const range =
        min === -Infinity && max === Infinity ? 'an integer' : `an integer ${min}-${max}`;
      throw new Error(`${key} must be ${range}, got "${value}"`);
    }
    return value;
  }

  /** Comma-separated list -> trimmed non-empty entries. */
  function list(key, fallback = []) {
    const entries = optional(key)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return entries.length > 0 ? entries : fallback;
  }

  /** Reject a mistyped IANA zone at startup rather than at 20:00 three days later. */
  function timeZone(key, fallback) {
    const value = optional(key, fallback);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      throw new Error(`${key} is not a valid IANA time zone, got "${value}"`);
    }
    return value;
  }

  /** "5m" / "90s" / "2h" / raw ms -> milliseconds. */
  function duration(key, fallback) {
    const value = optional(key);
    return value === '' ? parseDuration(fallback, key) : parseDuration(value, key);
  }

  return { optional, required, bool, number, integer, list, timeZone, duration };
}
