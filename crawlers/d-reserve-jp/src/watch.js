import { selectFresh } from '@jscrawlers/core';

/**
 * Decide which currently-bookable cells are worth waking someone up for, and
 * turn them into a notification payload.
 *
 * The hard part is not matching, it is not spamming: this room is sold out for
 * months, so when a cancellation lands the cell stays bookable across many
 * polls. Notifications therefore fire on the *edge* (not bookable -> bookable),
 * with an optional cooldown for a repeat nudge while it is still open.
 */

const DOW_SHORT = {
  MONDAY: '一',
  TUESDAY: '二',
  WEDNESDAY: '三',
  THURSDAY: '四',
  FRIDAY: '五',
  SATURDAY: '六',
  SUNDAY: '日',
};

/**
 * Does this cell satisfy every configured watch criterion?
 * Empty criteria do not narrow anything, so a blank watch config matches any
 * bookable cell.
 */
export function matchesWatch(cell, watch) {
  if (!cell.available) return false;
  if (cell.stockNum < watch.minStock) return false;
  if (watch.dates && !watch.dates.has(cell.salesDate)) return false;
  if (watch.roomCodes.size > 0 && !watch.roomCodes.has(cell.roomCode)) return false;
  if (watch.roomName && !cell.roomName.includes(watch.roomName)) return false;
  if (watch.daysOfWeek.size > 0 && !watch.daysOfWeek.has(cell.dayOfWeek)) return false;
  if (watch.maxPrice !== null) {
    // An unknown price cannot be proven to be under the cap, so it fails closed.
    if (cell.memberPrice === null || cell.memberPrice > watch.maxPrice) return false;
  }
  return true;
}

/**
 * Select the matches that should notify right now, and return the notification
 * bookkeeping to persist.
 *
 * @param {object} cells current cells map
 * @param {object} config loaded config
 * @param {Record<string, { lastNotifiedAt: string }>} notified previous state
 * @param {{ now?: number }} [options]
 * @returns {{ matches: object[], fresh: object[], notified: object }}
 */
export function selectNotifications(cells, config, notified = {}, { now = Date.now() } = {}) {
  const matching = Object.entries(cells).filter(([, cell]) => matchesWatch(cell, config.watch));
  const { fresh, notified: next } = selectFresh(
    matching.map(([key]) => key),
    notified,
    { cooldownMs: config.notify.cooldownMs, now },
  );
  const byKey = new Map(matching);

  return {
    matches: matching.map(([, cell]) => cell),
    fresh: fresh.map((key) => byKey.get(key)),
    notified: next,
  };
}

function formatPrice(value) {
  return value === null ? '價格不明' : `¥${value.toLocaleString('zh-TW')}`;
}

function describe(cell) {
  const dow = DOW_SHORT[cell.dayOfWeek] ?? cell.dayOfWeek;
  const price = formatPrice(cell.memberPrice);
  const regular =
    cell.regularPrice !== null && cell.regularPrice !== cell.memberPrice
      ? `（一般價 ${formatPrice(cell.regularPrice)}）`
      : '';
  return `${cell.salesDate} (${dow})  ${cell.roomName}  剩${cell.stockNum}  ${price}${regular}`;
}

/**
 * Build the payload handed to every notify channel.
 *
 * @param {object[]} cells the freshly-opened cells to announce
 * @param {object} config
 * @param {{ detectedAt?: string }} [options]
 */
export function buildPayload(cells, config, { detectedAt = new Date().toISOString() } = {}) {
  const sorted = [...cells].sort(
    (a, b) => a.salesDate.localeCompare(b.salesDate) || a.roomName.localeCompare(b.roomName),
  );
  const first = sorted[0];
  const more = sorted.length > 1 ? ` 另 ${sorted.length - 1} 筆` : '';

  const lines = sorted.map((cell) => `• ${describe(cell)}`);
  if (config.notify.bookingUrl) lines.push('', `訂房：${config.notify.bookingUrl}`);

  return {
    source: 'd-reserve-jp',
    event: 'availability',
    hotelCode: config.hotelCode,
    title: `有空房：${first.roomName} ${first.salesDate}${more}`,
    text: lines.join('\n'),
    bookingUrl: config.notify.bookingUrl || null,
    detectedAt,
    matches: sorted.map((cell) => ({
      roomCode: cell.roomCode,
      roomName: cell.roomName,
      salesDate: cell.salesDate,
      dayOfWeek: cell.dayOfWeek,
      stockNum: cell.stockNum,
      stockStatus: cell.stockStatus,
      memberPrice: cell.memberPrice,
      regularPrice: cell.regularPrice,
      planCode: cell.planCode,
    })),
  };
}

/** One payload for everything, or one per cell, per DRESERVE_NOTIFY_GROUPED. */
export function buildPayloads(cells, config, options) {
  if (cells.length === 0) return [];
  if (config.notify.grouped) return [buildPayload(cells, config, options)];
  return cells.map((cell) => buildPayload([cell], config, options));
}
