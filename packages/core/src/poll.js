import { jitter, sleepUntilAborted } from './time.js';

/**
 * Run `task` every `intervalMs` until the signal aborts.
 *
 * A single failed cycle must never end the watch — the next one may well be the
 * release we are waiting for — so a thrown error is logged and the loop
 * continues. Ctrl-C ends it immediately instead of after the remaining interval.
 *
 * `jitterRatio` spreads each wait by up to that fraction either way, so the
 * requests do not arrive on a clockwork cadence that is trivial to fingerprint.
 *
 * @param {{
 *   task: (ctx: { signal: AbortSignal, run: number }) => Promise<unknown>,
 *   intervalMs: number,
 *   signal: AbortSignal,
 *   logger?: { info: Function, error: Function },
 *   label?: string,
 *   jitterRatio?: number,
 * }} options
 * @returns {Promise<{ runs: number, failures: number }>}
 */
export async function pollLoop({
  task,
  intervalMs,
  signal,
  logger,
  label = 'poll',
  jitterRatio = 0,
}) {
  const spread = jitterRatio > 0 ? ` ±${Math.round(jitterRatio * 100)}%` : '';
  logger?.info(`polling every ${Math.round(intervalMs / 1000)}s${spread} — Ctrl-C to stop`);

  let runs = 0;
  let failures = 0;

  while (!signal.aborted) {
    try {
      await task({ signal, run: runs });
    } catch (error) {
      if (signal.aborted) break;
      failures++;
      logger?.error(`${label} failed: ${error.message}`);
    }
    runs++;
    if (signal.aborted) break;
    await sleepUntilAborted(jitter(intervalMs, jitterRatio), signal);
  }

  return { runs, failures };
}
