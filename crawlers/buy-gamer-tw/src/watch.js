import { selectFresh } from '@jscrawlers/core';

/**
 * Decide which products are worth interrupting someone for, and turn them into
 * a notification payload.
 *
 * A restocked product stays orderable across many polls, so alerts fire on the
 * edge (sold out -> orderable) via core's `selectFresh`, with an optional
 * cooldown for a repeat nudge while it is still open.
 */

/**
 * Pick the products to announce right now, and the bookkeeping to persist.
 *
 * @param {object[]} items every watched product's current snapshot
 * @param {Record<string, object>} previous stored items from before this poll
 * @param {object} config
 * @param {Record<string, { lastNotifiedAt: string }>} [notified] previous state
 * @param {{ now?: number }} [options]
 * @returns {{ buyable: object[], fresh: object[], seeded: object[], notified: object }}
 */
export function selectAlerts(
  items,
  previous = {},
  config,
  notified = {},
  { now = Date.now() } = {},
) {
  const buyable = items.filter((item) => item.buyable);
  const { fresh: freshSns, notified: next } = selectFresh(
    buyable.map((item) => item.sn),
    notified,
    { cooldownMs: config.notify.cooldownMs, now },
  );

  const bySn = new Map(buyable.map((item) => [item.sn, item]));
  const alerts = freshSns.map((sn) => bySn.get(sn));

  // A product seen for the first time has no baseline, so "orderable" cannot be
  // told apart from "orderable for weeks" — announcing that is a false restock
  // signal every time a product is added to the watch list. They stay in
  // `next` regardless, so the following poll does not replay them as an edge.
  const seeded = alerts.filter((item) => !previous[item.sn]);
  const fresh = config.notify.onFirstRun ? alerts : alerts.filter((item) => previous[item.sn]);

  return { buyable, fresh, seeded, notified: next };
}

function formatPrice(item) {
  if (item.price === null) return item.priceText ?? '價格不明';
  return `NT ${item.price.toLocaleString('zh-TW')} 元`;
}

function describe(item) {
  const bits = [formatPrice(item)];
  if (item.status) bits.push(item.status);
  if (item.publishDate) bits.push(`發售 ${item.publishDate}`);
  return `• ${item.title}\n  ${bits.join('・')}\n  ${item.url}`;
}

/**
 * Build the payload handed to every notify channel.
 *
 * @param {object[]} items the freshly-orderable products to announce
 * @param {object} config
 * @param {{ detectedAt?: string }} [options]
 */
export function buildPayload(items, config, { detectedAt = new Date().toISOString() } = {}) {
  const sorted = [...items].sort((a, b) => a.title.localeCompare(b.title, 'zh-TW'));
  const first = sorted[0];
  const more = sorted.length > 1 ? ` 另 ${sorted.length - 1} 筆` : '';

  return {
    source: 'buy-gamer-tw',
    event: 'availability',
    title: `可以下單了：${first.title}${more}`,
    text: sorted.map(describe).join('\n\n'),
    detectedAt,
    matches: sorted.map((item) => ({
      sn: item.sn,
      title: item.title,
      url: item.url,
      status: item.status,
      price: item.price,
      publishDate: item.publishDate,
      platform: item.platform,
    })),
  };
}

/** One payload for everything, or one per product, per BUYGAMER_NOTIFY_GROUPED. */
export function buildPayloads(items, config, options) {
  if (items.length === 0) return [];
  if (config.notify.grouped) return [buildPayload(items, config, options)];
  return items.map((item) => buildPayload([item], config, options));
}
