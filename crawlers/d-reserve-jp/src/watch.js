import { selectFresh } from '@jscrawlers/core';

/**
 * Decide which currently-bookable cells are worth waking someone up for, and
 * turn them into a notification payload.
 *
 * The hard part is not matching, it is not spamming: this room is sold out for
 * months, so when a cancellation lands the cell stays bookable across many
 * polls. Notifications therefore fire on the *edge* (not bookable -> bookable).
 *
 * In `until-ack` mode the edge is only the first of many: the reminder repeats
 * every DRESERVE_NOTIFY_REPEAT_MIN until you say stop, and the cell being
 * booked away earns a closing notice so silence is never ambiguous.
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
 * @param {Record<string, { lastNotifiedAt: string, ackedAt?: string }>} notified previous state
 * @param {{ now?: number, acked?: Iterable<string> }} [options]
 * @returns {{ matches: object[], fresh: object[], closed: string[], notified: object }}
 */
export function selectNotifications(
  cells,
  config,
  notified = {},
  { now = Date.now(), acked = [] } = {},
) {
  const matching = Object.entries(cells).filter(([, cell]) => matchesWatch(cell, config.watch));
  const {
    fresh,
    closed,
    notified: next,
  } = selectFresh(
    matching.map(([key]) => key),
    notified,
    // `once` never repeats, whatever the interval is set to.
    { cooldownMs: config.notify.mode === 'until-ack' ? config.notify.repeatMs : 0, now, acked },
  );
  const byKey = new Map(matching);

  return {
    matches: matching.map(([, cell]) => cell),
    fresh: fresh.map((key) => byKey.get(key)),
    closed,
    notified: next,
  };
}

/**
 * Which keys a stop command applies to.
 *
 * No filter means "everything you are currently nagging me about". A filter is
 * matched against the key (room code and date) and the room name, so
 * "2026-10-09", "RM00010235" and "特別室" all work.
 *
 * @param {string|null} filter
 * @param {Iterable<string>} keys the keys currently being announced
 * @param {object} [cells] whatever is known about them, for the room name
 */
export function resolveAck(filter, keys, cells = {}) {
  const needle = String(filter ?? '').trim();
  if (needle === '') return [...keys];
  return [...keys].filter((key) => `${key} ${cells[key]?.roomName ?? ''}`.includes(needle));
}

/**
 * Best-effort cell for a key, for a notice about something that is already
 * gone. Falls back to the key itself, which at least names the room and date.
 */
export function resolveCell(key, ...sources) {
  for (const source of sources) {
    if (source?.[key]) return source[key];
  }
  const [roomCode, salesDate] = key.split('|');
  return { roomCode, roomName: roomCode, salesDate, dayOfWeek: null, stockNum: 0 };
}

function formatPrice(value) {
  return value === null ? '價格不明' : `¥${value.toLocaleString('zh-TW')}`;
}

/** "2026-10-09 (五)  露天風呂付特別室" — which cell, without the numbers. */
function identify(cell) {
  const dow = DOW_SHORT[cell.dayOfWeek] ?? cell.dayOfWeek;
  return `${cell.salesDate}${dow ? ` (${dow})` : ''}  ${cell.roomName}`;
}

function describe(cell) {
  const price = formatPrice(cell.memberPrice);
  const regular =
    cell.regularPrice !== null && cell.regularPrice !== cell.memberPrice
      ? `（一般價 ${formatPrice(cell.regularPrice)}）`
      : '';
  return `${identify(cell)}  剩${cell.stockNum}  ${price}${regular}`;
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

/**
 * The other bookend: a cell that was being announced is no longer bookable.
 *
 * Only `until-ack` sends these. After a stream of reminders, silence on its own
 * is ambiguous — "booked away" and "the crawler died" look identical — and this
 * is the message that tells them apart.
 */
export function buildClosedPayload(cells, config, { detectedAt = new Date().toISOString() } = {}) {
  const sorted = [...cells].sort(
    (a, b) => a.salesDate.localeCompare(b.salesDate) || a.roomName.localeCompare(b.roomName),
  );
  const first = sorted[0];
  const more = sorted.length > 1 ? ` 另 ${sorted.length - 1} 筆` : '';

  return {
    source: 'd-reserve-jp',
    event: 'availability-closed',
    hotelCode: config.hotelCode,
    title: `提醒結束：${first.roomName} ${first.salesDate}${more}`,
    text: [
      ...sorted.map((cell) => `• ${identify(cell)}`),
      '',
      '已被訂走（或不再可訂），停止提醒。',
    ].join('\n'),
    bookingUrl: config.notify.bookingUrl || null,
    detectedAt,
    matches: sorted.map((cell) => ({
      roomCode: cell.roomCode,
      roomName: cell.roomName,
      salesDate: cell.salesDate,
      dayOfWeek: cell.dayOfWeek,
    })),
  };
}

/** One payload for everything, or one per cell, per DRESERVE_NOTIFY_GROUPED. */
export function buildPayloads(cells, config, options, build = buildPayload) {
  if (cells.length === 0) return [];
  if (config.notify.grouped) return [build(cells, config, options)];
  return cells.map((cell) => build([cell], config, options));
}

/** buildPayloads, for the closing notice. */
export function buildClosedPayloads(cells, config, options) {
  return buildPayloads(cells, config, options, buildClosedPayload);
}

/** "10/10 18:05" in the given zone — enough to place an outage, no more. */
function formatClock(iso, timeZone) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(iso))
    .replace(/\s+/g, ' '); // ICU may put a narrow no-break space in there
}

function formatSpan(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小時 ${minutes % 60} 分鐘` : `${hours} 小時`;
}

/**
 * Tell someone the watcher itself is in trouble, or that it is back.
 *
 * Without this a blocked crawler and a quiet market look the same: no alerts.
 *
 * @param {'down'|'still-down'|'recovered'} alert
 * @param {object} health the health being reported on — for `recovered`, the
 *   one from just before the successful poll
 * @param {object} config
 * @param {{ now?: number }} [options]
 */
export function buildHealthPayload(alert, health, config, { now = Date.now() } = {}) {
  const tz = config.daily.timeZone;
  const detectedAt = new Date(now).toISOString();
  const outage = formatSpan(now - Date.parse(health.firstFailureAt));
  const base = {
    source: 'd-reserve-jp',
    event: 'health',
    status: alert,
    hotelCode: config.hotelCode,
    detectedAt,
    consecutiveFailures: health.consecutiveFailures,
    firstFailureAt: health.firstFailureAt,
    blocked: health.blocked,
  };

  if (alert === 'recovered') {
    return {
      ...base,
      title: `✅ d-reserve-jp 已恢復，中斷 ${outage}`,
      text:
        `${formatClock(health.firstFailureAt, tz)} 起連續失敗 ${health.consecutiveFailures} 次，` +
        '現在已能正常查詢。',
    };
  }

  const why = health.blocked ? '（疑似被擋）' : '';
  const lines = [
    `首次失敗：${formatClock(health.firstFailureAt, tz)}（已 ${outage}）`,
    `最後錯誤：${health.lastError}`,
  ];
  if (health.backoffUntil) lines.push(`下次嘗試：${formatClock(health.backoffUntil, tz)}`);
  if (health.blocked) {
    lines.push('', '若持續被擋，可拉長 DRESERVE_INTERVAL 或設定 DRESERVE_BACKOFF_BASE。');
  }
  lines.push('', '這段期間的空房不會被偵測到。');

  return {
    ...base,
    lastError: health.lastError,
    title:
      `⚠️ d-reserve-jp ${alert === 'still-down' ? '仍在' : ''}連續失敗 ` +
      `${health.consecutiveFailures} 次${why}`,
    text: lines.join('\n'),
  };
}
