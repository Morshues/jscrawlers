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
  MONDAY: 'Mon',
  TUESDAY: 'Tue',
  WEDNESDAY: 'Wed',
  THURSDAY: 'Thu',
  FRIDAY: 'Fri',
  SATURDAY: 'Sat',
  SUNDAY: 'Sun',
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
  const { watch, notify } = config;
  const matches = [];
  const fresh = [];
  const next = {};

  for (const [key, cell] of Object.entries(cells)) {
    if (!matchesWatch(cell, watch)) continue;
    matches.push(cell);

    const previous = notified[key];
    if (!previous) {
      // Rising edge: the cell was not bookable (or not matching) last poll.
      fresh.push(cell);
      next[key] = { lastNotifiedAt: new Date(now).toISOString() };
      continue;
    }

    const age = now - Date.parse(previous.lastNotifiedAt);
    if (notify.cooldownMs > 0 && age >= notify.cooldownMs) {
      fresh.push(cell);
      next[key] = { lastNotifiedAt: new Date(now).toISOString() };
    } else {
      // Still open and still inside the cooldown: carry the timestamp forward
      // so the reminder clock keeps running from the original alert.
      next[key] = previous;
    }
  }

  // Keys absent from `next` have stopped matching; dropping them is what lets a
  // future re-opening count as a fresh edge again.
  return { matches, fresh, notified: next };
}

function formatPrice(value) {
  return value === null ? '価格不明' : `¥${value.toLocaleString('ja-JP')}`;
}

function describe(cell) {
  const dow = DOW_SHORT[cell.dayOfWeek] ?? cell.dayOfWeek;
  const price = formatPrice(cell.memberPrice);
  const regular =
    cell.regularPrice !== null && cell.regularPrice !== cell.memberPrice
      ? ` (一般 ${formatPrice(cell.regularPrice)})`
      : '';
  return `${cell.salesDate} (${dow})  ${cell.roomName}  残${cell.stockNum}  ${price}${regular}`;
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
  const more = sorted.length > 1 ? ` ほか${sorted.length - 1}件` : '';

  const lines = sorted.map((cell) => `・${describe(cell)}`);
  if (config.notify.bookingUrl) lines.push('', `予約: ${config.notify.bookingUrl}`);

  return {
    source: 'd-reserve-jp',
    event: 'availability',
    hotelCode: config.hotelCode,
    title: `空室あり: ${first.roomName} ${first.salesDate}${more}`,
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
