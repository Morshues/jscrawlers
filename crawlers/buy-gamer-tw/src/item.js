import { fetchWithRetry, throttle } from '@jscrawlers/core';

/**
 * Fetch and parse one 巴哈商城 product page.
 *
 * The page is plain server-rendered HTML with no JS and no login, so a handful
 * of anchored regexes beat pulling in a parser: there is exactly one
 * `.buy-products-btn-area`, and its text is what decides everything.
 */

/**
 * The page was reached but could not be understood. Kept distinct from a
 * network error because the caller treats both the same way — leave the stored
 * state alone — and the message is what tells a human which one happened.
 */
export class ParseError extends Error {
  constructor(message, { sn, url } = {}) {
    super(message);
    this.name = 'ParseError';
    this.sn = sn;
    this.url = url;
  }
}

const ADULT_COOKIE = 'ckBUY_item18UP=18UP';

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decode(value) {
  return value
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Tags out, entities decoded, whitespace collapsed. */
export function stripTags(html) {
  return decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** First capture group of `re`, as plain text, or null when it does not match. */
function text(html, re) {
  const match = re.exec(html);
  if (!match) return null;
  const value = stripTags(match[1]);
  return value === '' ? null : value;
}

/** "NT 2,950 元" -> 2950 */
function price(priceText) {
  if (!priceText) return null;
  const digits = priceText.replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
}

/** The 版本發行 / 預定取貨 / 付款方式 rows, as a plain label -> value map. */
function details(html) {
  const out = {};
  const re =
    /<p class="situation-title">([\s\S]*?)<\/p>\s*<p class="situation-content">([\s\S]*?)<\/p>/g;
  for (const match of html.matchAll(re)) {
    const label = stripTags(match[1]);
    if (label) out[label] = stripTags(match[2]);
  }
  return out;
}

/**
 * Turn a product page into a snapshot.
 *
 * Throws ParseError when the buy area is missing or says nothing we recognise.
 * Guessing here would be worse than failing: reading a redesign as "sold out"
 * would keep the watcher silent forever, which is the one outcome that makes it
 * useless.
 *
 * @param {string} html
 * @param {{ sn: string, url: string, buyKeywords: string[], soldOutKeywords: string[], fetchedAt?: string }} options
 */
export function parseItem(html, { sn, url, buyKeywords, soldOutKeywords, fetchedAt }) {
  const area = /<div class="buy-products-btn-area">([\s\S]*?)<\/div>/.exec(html);
  if (!area) {
    throw new ParseError(`sn=${sn} 找不到購買按鈕區塊 .buy-products-btn-area（頁面可能改版了）`, {
      sn,
      url,
    });
  }

  const buttons = [...area[1].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
  const areaText = stripTags(area[1]);

  const buyHit = buyKeywords.find((keyword) => areaText.includes(keyword)) ?? null;
  const soldOutHit = soldOutKeywords.find((keyword) => areaText.includes(keyword)) ?? null;
  if (!buyHit && !soldOutHit) {
    throw new ParseError(
      `sn=${sn} 購買按鈕沒有任何已知關鍵字（實際文字：「${areaText}」）— ` +
        '確認頁面是否改版，必要時調整 BUYGAMER_BUY_KEYWORDS / BUYGAMER_SOLD_OUT_KEYWORDS',
      { sn, url },
    );
  }

  // An actual buy button outranks a restock-notify link if both somehow appear:
  // being able to order is the thing being watched for.
  const buyable = Boolean(buyHit);
  const priceText = text(html, /class="info-main-price">([\s\S]*?)<\/p>/);

  return {
    sn,
    url,
    title:
      text(html, /<div class="detail-name-block">[\s\S]*?<p>([\s\S]*?)<\/p>/) ??
      text(html, /<title>([\s\S]*?)<\/title>/) ??
      `sn=${sn}`,
    platform: text(html, /<div class="detail-name-block">\s*<span[^>]*>([\s\S]*?)<\/span>/),
    status: text(html, /class="version-content">([\s\S]*?)<\/p>/),
    buyable,
    buyAction: buyable ? 'buy' : 'restock-notify',
    buttons,
    price: price(priceText),
    priceText,
    publishDate: text(html, /class="publish-date-content">([\s\S]*?)<\/p>/),
    details: details(html),
    imageUrl: /class="detail-img-block"[\s\S]*?<img src="([^"]+)"/.exec(html)?.[1] ?? null,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
  };
}

/**
 * Fetch one product page and parse it.
 *
 * fetch() follows redirects, and this shop redirects rather than 404s: an
 * unknown sn lands on the shop home page and an 18+ product on warn.php. Both
 * would parse as "no buy button" and quietly look like a sold-out product, so
 * the final URL is checked before the HTML is trusted at all.
 */
export async function fetchItem(item, config, { logger, signal } = {}) {
  const headers = {
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
    ...(config.parse.adultCookie ? { cookie: ADULT_COOKIE } : {}),
  };

  const response = await fetchWithRetry(item.url, { headers, logger, signal });
  const finalUrl = response.url || item.url;
  if (!finalUrl.includes('atmItem.php')) {
    const hint = finalUrl.includes('warn.php')
      ? '限制級商品，需要 BUYGAMER_ADULT_COOKIE=true'
      : '商品可能已下架或 sn 有誤';
    await response.body?.cancel();
    throw new ParseError(`sn=${item.sn} 被轉址到 ${finalUrl}（${hint}）`, item);
  }

  const html = await response.text();
  return {
    html,
    snapshot: parseItem(html, {
      ...item,
      buyKeywords: config.parse.buyKeywords,
      soldOutKeywords: config.parse.soldOutKeywords,
    }),
  };
}

/**
 * Fetch every watched product, politely spaced out.
 *
 * One bad product must not cost the others their poll — the interesting one may
 * be the next in the list — so failures are collected and returned rather than
 * thrown.
 *
 * @returns {Promise<{ items: Record<string, object>, failures: object[], raw: object[], fetchedAt: string }>}
 */
export async function fetchSnapshot(config, { logger, signal } = {}) {
  const wait = throttle(config.poll.requestDelayMs);
  const items = {};
  const failures = [];
  const raw = [];

  for (const item of config.items) {
    if (signal?.aborted) break;
    await wait();

    try {
      const { html, snapshot } = await fetchItem(item, config, { logger, signal });
      items[item.sn] = snapshot;
      if (config.poll.keepRaw) raw.push({ sn: item.sn, html });
    } catch (error) {
      if (signal?.aborted) break;
      failures.push({ sn: item.sn, url: item.url, error: error.message });
    }
  }

  return { items, failures, raw, fetchedAt: new Date().toISOString() };
}
