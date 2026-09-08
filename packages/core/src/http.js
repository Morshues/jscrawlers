import { sleep } from './time.js';

const DEFAULT_USER_AGENT =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Status codes worth retrying: rate limit + transient server errors. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(response, url) {
    super(`HTTP ${response.status} ${response.statusText} for ${url}`);
    this.name = 'HttpError';
    this.status = response.status;
    this.url = url;
    this.response = response;
  }
}

function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/**
 * fetch() with timeout, exponential backoff and sane crawler defaults.
 * Throws HttpError on a non-ok response once retries are exhausted.
 *
 * @param {string} url
 * @param {RequestInit & {
 *   retries?: number,
 *   timeout?: number,
 *   retryDelay?: number,
 *   logger?: { debug: Function, warn: Function },
 * }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    retries = 3,
    timeout = 20_000,
    retryDelay = 1_000,
    logger,
    headers,
    signal,
    ...init
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    try {
      logger?.debug(`GET ${url}${attempt ? ` (retry ${attempt}/${retries})` : ''}`);
      const response = await fetch(url, {
        ...init,
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'ja,en-US;q=0.9,en;q=0.8,zh-TW;q=0.7',
          ...headers,
        },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });

      if (response.ok) return response;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) {
        throw new HttpError(response, url);
      }

      const wait = retryAfterMs(response) ?? retryDelay * 2 ** attempt;
      logger?.warn(`HTTP ${response.status} for ${url}, retrying in ${wait}ms`);
      await response.body?.cancel();
      await sleep(wait);
      lastError = new HttpError(response, url);
    } catch (error) {
      // A non-retryable HttpError above must not be swallowed by the retry loop.
      if (error instanceof HttpError && !RETRYABLE_STATUS.has(error.status)) throw error;
      if (signal?.aborted) throw error;
      if (attempt === retries) throw error;

      lastError = error;
      const wait = retryDelay * 2 ** attempt;
      logger?.warn(`${error.name}: ${error.message}, retrying in ${wait}ms`);
      await sleep(wait);
    }
  }

  throw lastError;
}

/** fetchWithRetry + `.text()`. */
export async function fetchText(url, options) {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

/** fetchWithRetry + `.json()`, with a JSON Accept header. */
export async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  return response.json();
}
