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
