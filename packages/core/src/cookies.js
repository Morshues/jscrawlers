/**
 * Just enough of a cookie jar for a logged-in session on one site. Cookies are
 * keyed by name alone — domain and path are ignored — which is fine for sites
 * that share one login across a few sibling hosts and paths (d-reserve.jp's
 * Keycloak + front end, gamer.com.tw's user / buy subdomains): sending a cookie
 * to a sibling that does not care about it is harmless.
 *
 * @param {Record<string, string> | string} [seed] initial cookies, either a
 *   `{ name: value }` map (what `toJSON()` returns) or a `Cookie:` header string
 *   such as one copied out of a browser.
 */
export function createCookieJar(seed) {
  const cookies = new Map();
  if (typeof seed === 'string') {
    for (const pair of seed.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  } else if (seed) {
    for (const [name, value] of Object.entries(seed)) cookies.set(name, String(value));
  }

  return {
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attributes.some((attribute) => {
          const [key, raw] = attribute.split('=').map((part) => part?.trim());
          if (/^max-age$/i.test(key)) return Number(raw) <= 0;
          if (/^expires$/i.test(key)) return Date.parse(raw) < Date.now();
          return false;
        });
        if (expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    names() {
      return [...cookies.keys()];
    },
    get(name) {
      return cookies.get(name);
    },
    set(name, value) {
      cookies.set(name, String(value));
    },
    toJSON() {
      return Object.fromEntries(cookies);
    },
  };
}

const MAX_REDIRECTS = 10;

/**
 * fetch() that carries the jar and follows redirects by hand: with
 * `redirect: 'follow'` the Set-Cookie headers of every intermediate hop are
 * lost, and login handshakes are mostly intermediate hops.
 *
 * Resolves with the final response and the URL it came from; the body is left
 * unread for the caller.
 *
 * @param {ReturnType<typeof createCookieJar>} jar
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: any,
 *   logger?: { debug: Function }, signal?: AbortSignal }} [options]
 */
export async function requestWithCookies(
  jar,
  url,
  { method = 'GET', headers = {}, body, logger, signal } = {},
) {
  let current = url;
  let init = { method, body };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    logger?.debug(`${init.method} ${current.split('?')[0]}`);
    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      signal,
      headers: { ...headers, cookie: jar.header() },
    });
    jar.store(response);

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: current };
    }
    await response.body?.cancel();
    current = new URL(location, current).href;
    // 307/308 would replay the body; nothing that uses this needs them.
    init = { method: 'GET' };
  }
  throw new Error(`too many redirects starting from ${url.split('?')[0]}`);
}
