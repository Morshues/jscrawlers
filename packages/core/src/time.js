/** Wait for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `ms` +/- up to `ratio` of it, so requests do not land on an exact cadence. */
export function jitter(ms, ratio = 0.3) {
  const delta = ms * ratio;
  return Math.max(0, Math.round(ms - delta + Math.random() * delta * 2));
}

/**
 * Rate limiter: returns a function that resolves only once `minIntervalMs`
 * has passed since the previous call resolved.
 *
 * const wait = throttle(1000);
 * for (const url of urls) { await wait(); await fetchText(url); }
 */
export function throttle(minIntervalMs, { withJitter = true } = {}) {
  let last = 0;
  return async function wait() {
    const gap = withJitter ? jitter(minIntervalMs) : minIntervalMs;
    const remaining = last + gap - Date.now();
    if (remaining > 0) await sleep(remaining);
    last = Date.now();
  };
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep input order.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function withConcurrency(items, limit, fn) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      results[index] = await fn(list[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

/**
 * "5m" / "90s" / "2h" / "300000" -> milliseconds.
 * A bare number is treated as milliseconds so raw values keep working.
 */
export function parseDuration(value, key = 'duration') {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!match)
    throw new Error(`${key} must look like 5m, 90s, 2h or a number of ms, got "${value}"`);
  const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * units[match[2] ?? 'ms'];
}

/**
 * Sleep that wakes immediately on abort. A plain sleep would keep the process
 * alive for up to a full interval after Ctrl-C, which feels like a hang.
 */
export function sleepUntilAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
