import { sleepUntilAborted } from './time.js';

/**
 * Run `task` every `intervalMs` until the signal aborts.
 *
 * A single failed cycle must never end the watch — the next one may well be the
 * release we are waiting for — so a thrown error is logged and the loop
 * continues. Ctrl-C ends it immediately instead of after the remaining interval.
 *
 * @param {{
 *   task: (ctx: { signal: AbortSignal, run: number }) => Promise<unknown>,
 *   intervalMs: number,
 *   signal: AbortSignal,
 *   logger?: { info: Function, error: Function },
 *   label?: string,
 * }} options
 * @returns {Promise<{ runs: number, failures: number }>}
 */
export async function pollLoop({ task, intervalMs, signal, logger, label = 'poll' }) {
  logger?.info(`polling every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop`);

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
    await sleepUntilAborted(intervalMs, signal);
  }

  return { runs, failures };
}
