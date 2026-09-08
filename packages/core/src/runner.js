import { createLogger } from './logger.js';

/**
 * Standard entry point for every crawler: sets up a logger, times the run,
 * handles Ctrl-C, and turns a thrown error into a non-zero exit code.
 *
 * await runCrawler('my-site', async ({ log, signal }) => { ... });
 *
 * @template T
 * @param {string} name crawler name, also the data/ output folder
 * @param {(ctx: { log: ReturnType<createLogger>, name: string, signal: AbortSignal }) => Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
export async function runCrawler(name, fn) {
  const log = createLogger(name);
  const controller = new AbortController();

  const onSignal = (sig) => {
    log.warn(`received ${sig}, shutting down`);
    controller.abort(new Error(`Interrupted by ${sig}`));
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const startedAt = Date.now();
  log.info('start');

  try {
    const result = await fn({ log, name, signal: controller.signal });
    log.info(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    log.error(error?.stack ?? error);
    process.exitCode = 1;
    return undefined;
  }
}
