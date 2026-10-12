import { createEnvReader, parseDuration } from '@jscrawlers/core';

/**
 * Every knob this crawler has, read from the environment.
 *
 * Which products to watch is the only required value; everything else has a
 * working default. See `.env.example` for the annotated list.
 */

// Re-exported because index.js reaches for it here: `--interval` is a
// crawler-level flag rather than a core concern.
export { parseDuration };

/**
 * The buy button area is the authoritative signal, and it says so in words:
 *
 *   熱烈預購中          前往預購 + 加入購物車
 *   已發售              前往購買 + 加入購物車
 *   本商品已額滿或售完  補貨通知我  (and nothing else)
 *
 * 前往購買 matters as much as 前往預購: a sold-out pre-order that only reopens
 * after its release date shows the former, and watching for the latter alone
 * would stay silent through exactly the event we are waiting for.
 */
export const DEFAULT_BUY_KEYWORDS = ['加入購物車', '前往預購', '前往購買'];
export const DEFAULT_SOLD_OUT_KEYWORDS = ['補貨通知我'];

/** `https://buy.gamer.com.tw/atmItem.php?sn=42810` */
export function itemUrl(baseUrl, sn) {
  return new URL(`/atmItem.php?sn=${sn}`, baseUrl).href;
}

/**
 * Expand the watch list into `{ sn, url }` entries.
 *
 * Accepts bare product numbers and full product URLs, mixed and
 * comma-separated, so a link copied straight from the browser works:
 *   "42810, https://buy.gamer.com.tw/atmItem.php?sn=41435"
 *
 * Duplicates collapse (the same product listed twice is one request, not two)
 * and the listed order is the order products get fetched in.
 */
export function parseItems(spec, baseUrl, key = 'BUYGAMER_ITEMS') {
  const entries = String(spec ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const items = new Map();
  for (const entry of entries) {
    const sn = /^\d+$/.test(entry) ? entry : snFromUrl(entry, entry, key);
    if (!items.has(sn)) items.set(sn, { sn, url: itemUrl(baseUrl, sn) });
  }

  if (items.size === 0) {
    throw new Error(`${key} is required — e.g. ${key}=42810 (the sn in the product URL)`);
  }
  return [...items.values()];
}

function snFromUrl(value, entry, key) {
  let sn;
  try {
    sn = new URL(value).searchParams.get('sn');
  } catch {
    sn = null;
  }
  if (!sn || !/^\d+$/.test(sn)) {
    throw new Error(
      `${key} entry "${entry}" is neither a product number nor an atmItem.php URL with an sn`,
    );
  }
  return sn;
}

/**
 * Read the whole configuration. Throws with an actionable message when a value
 * is missing or malformed, so a bad `.env` fails on the first run rather than
 * silently watching nothing.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ watching?: boolean }} [options] false for commands that never poll
 *   (--login-test, --order ...), which have no use for a watch list
 */
export function loadConfig(env = process.env, { watching = true } = {}) {
  const read = createEnvReader(env);
  const baseUrl = read.optional('BUYGAMER_BASE_URL', 'https://buy.gamer.com.tw');
  const itemSpec = read.optional('BUYGAMER_ITEMS');

  return {
    baseUrl,
    items: watching || itemSpec ? parseItems(itemSpec, baseUrl) : [],

    poll: {
      intervalMs: read.duration('BUYGAMER_INTERVAL', '5m'),
      requestDelayMs: read.number('BUYGAMER_REQUEST_DELAY_MS', 1500),
      keepRaw: read.bool('BUYGAMER_KEEP_RAW', false),
      rawKeep: read.integer('BUYGAMER_RAW_KEEP', 48, { min: 1 }),
    },

    parse: {
      // 限制級 products redirect to warn.php until this cookie says the viewer
      // is over 18. Without it they can never be watched at all.
      adultCookie: read.bool('BUYGAMER_ADULT_COOKIE', true),
      buyKeywords: read.list('BUYGAMER_BUY_KEYWORDS', DEFAULT_BUY_KEYWORDS),
      soldOutKeywords: read.list('BUYGAMER_SOLD_OUT_KEYWORDS', DEFAULT_SOLD_OUT_KEYWORDS),
    },

    notify: {
      channels: read.list('BUYGAMER_NOTIFY_CHANNELS'),
      cooldownMs: read.number('BUYGAMER_NOTIFY_COOLDOWN_MIN', 0) * 60_000,
      grouped: read.bool('BUYGAMER_NOTIFY_GROUPED', true),
      onFirstRun: read.bool('BUYGAMER_NOTIFY_ON_FIRST_RUN', false),
    },

    // Only the switch and the allow-list live in the repo .env; the login and
    // the price cap are in the private order env (loadOrderConfig).
    order: {
      enabled: read.bool('BUYGAMER_ORDER_ENABLED', false),
      // Blank = every watched product may be ordered.
      items: parseOrderItems(read.optional('BUYGAMER_ORDER_ITEMS'), baseUrl),
    },
  };
}

function parseOrderItems(spec, baseUrl) {
  if (!spec.trim()) return null;
  return new Set(parseItems(spec, baseUrl, 'BUYGAMER_ORDER_ITEMS').map((item) => item.sn));
}

/**
 * The private half of ordering, read from the order env file (see private.js),
 * never from the repo `.env`.
 *
 * @param {Record<string, string | undefined>} secrets parsed order env file
 */
export function loadOrderConfig(secrets) {
  const read = createEnvReader(secrets);

  const user = read.optional('BUYGAMER_LOGIN_USER');
  const password = read.optional('BUYGAMER_LOGIN_PASSWORD');
  const cookies = read.optional('BUYGAMER_COOKIES');
  if (!cookies && !(user && password)) {
    throw new Error(
      'order env needs BUYGAMER_LOGIN_USER + BUYGAMER_LOGIN_PASSWORD, or BUYGAMER_COOKIES ' +
        '(BAHAID=...; BAHARUNE=...; BAHAENUR=... copied from a logged-in browser)',
    );
  }

  // Required: an uncapped auto-buyer is never what anyone meant.
  const maxPrice = Number(read.required('BUYGAMER_ORDER_MAX_PRICE'));
  if (!(maxPrice > 0)) {
    throw new Error('BUYGAMER_ORDER_MAX_PRICE must be a positive number of NT dollars');
  }

  return {
    user,
    password,
    cookies,
    maxPrice,
    // Off until you have watched it stop at the confirmation page once.
    submit: read.bool('BUYGAMER_ORDER_SUBMIT', false),
  };
}
