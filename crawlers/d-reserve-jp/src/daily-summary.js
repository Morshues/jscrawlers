import { addDays } from './config.js';

/**
 * Daily digest of everything the watcher recorded, as pure functions.
 *
 * Nothing here reads files or sends messages — `index.js` owns that — so the
 * hard part (which events belong to which day) is directly testable.
 *
 * The guarantee to preserve: every event lands in exactly one digest. That is
 * why windows are a fixed half-open grid rather than "the last 24 hours", and
 * why the caller only advances its checkpoint once a window is fully delivered.
 */

const FORMATTERS = new Map();

/** Intl formatters are expensive to build, and we call these per event. */
function formatter(timeZone) {
  let dtf = FORMATTERS.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, dtf);
  }
  return dtf;
}

function partsIn(instant, timeZone) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some ICU versions render midnight as "24" rather than "00".
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far `timeZone` is ahead of UTC at this instant, in ms. */
export function tzOffsetMs(instant, timeZone) {
  const p = partsIn(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
}

/** Local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(instant, timeZone) {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Local HH:MM of an instant. */
export function localTime(instant, timeZone) {
  const p = partsIn(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The UTC instant at which `localDate` reaches `hour:00` in `timeZone`.
 *
 * Adding 24h to the previous boundary would drift across a DST transition and
 * silently produce 23h/25h-long days, so every boundary is derived from its own
 * calendar date. Two correction passes converge for every real zone.
 */
export function zonedBoundary(date, hour, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, 0, 0, 0);
  let instant = wall;
  for (let pass = 0; pass < 2; pass++) instant = wall - tzOffsetMs(instant, timeZone);
  return instant;
}

/** The most recent boundary at or before `instant`, with the date it belongs to. */
export function boundaryAtOrBefore(instant, hour, timeZone) {
  let date = localDate(instant, timeZone);
  let at = zonedBoundary(date, hour, timeZone);
  if (at > instant) {
    date = addDays(date, -1);
    at = zonedBoundary(date, hour, timeZone);
  }
  return { at, date };
}

function makeWindow(startDate, hour, timeZone) {
  const endDate = addDays(startDate, 1);
  return {
    startDate,
    endDate,
    start: zonedBoundary(startDate, hour, timeZone),
    end: zonedBoundary(endDate, hour, timeZone),
  };
}

/**
 * Every window still owed, oldest first.
 *
 * A window is `[boundary(D), boundary(D+1))` — half-open, so an event at
 * exactly the boundary belongs to the next window and can never be counted
 * twice or dropped.
 *
 * @param {{
 *   lastWindowEnd: string|null, now: number, timeZone: string,
 *   hour: number, maxBackfill: number,
 * }} options
 * @returns {{ windows: object[], skipped: object[], realigned: boolean }}
 */
export function pendingWindows({ lastWindowEnd, now, timeZone, hour, maxBackfill = 7 }) {
  const latest = boundaryAtOrBefore(now, hour, timeZone);

  // Cold start: report only the most recent complete window. Backfilling all of
  // history here would fire a dozen messages the first time this ever runs.
  if (!lastWindowEnd) {
    return {
      windows: [makeWindow(addDays(latest.date, -1), hour, timeZone)],
      skipped: [],
      realigned: false,
    };
  }

  // A changed DRESERVE_DAILY_TZ/HOUR leaves the checkpoint off the new grid.
  // Snapping down keeps windows whole; the alternative is a truncated period.
  const checkpoint = Date.parse(lastWindowEnd);
  const aligned = boundaryAtOrBefore(checkpoint, hour, timeZone);
  const realigned = aligned.at !== checkpoint;

  const all = [];
  for (let date = aligned.date; zonedBoundary(date, hour, timeZone) < latest.at;) {
    const window = makeWindow(date, hour, timeZone);
    all.push(window);
    date = window.endDate;
  }

  const windows = maxBackfill > 0 ? all.slice(-maxBackfill) : all;
  return { windows, skipped: all.slice(0, all.length - windows.length), realigned };
}

const KIND_LABEL = {
  appear: '空室',
  disappear: '満室',
  stock: '在庫',
  price: '価格',
  room_added: '追加',
  room_removed: '削除',
};

function yen(value) {
  return value === null || value === undefined ? '?' : `¥${value.toLocaleString('ja-JP')}`;
}

/**
 * How many cells were bookable at `cutoff`, replayed from the seed baseline.
 *
 * Reading state.json instead would be wrong for a backfilled window: it holds
 * the state *now*, not the state when that window closed. Returns null when the
 * baseline is missing (old event files pruned) rather than a misleading number.
 *
 * @param {object[]} events all events, sorted by ts
 * @param {number} cutoff exclusive upper bound
 */
export function availabilityAt(events, cutoff) {
  const bookable = new Map();
  let sawSeed = false;

  for (const event of events) {
    if (Date.parse(event.ts) >= cutoff) break;
    const key = `${event.roomCode}|${event.salesDate}`;
    if (event.kind === 'seed') sawSeed = true;
    if (event.kind === 'room_removed') bookable.delete(key);
    else if (event.to) bookable.set(key, event.to.available === true);
  }

  if (!sawSeed) return null;
  let count = 0;
  for (const available of bookable.values()) if (available) count++;
  return count;
}

/**
 * Aggregate one window. Pure: takes the full history and returns a plain object.
 *
 * @param {{ events: object[], polls: object[] }} history
 * @param {{ start: number, end: number, startDate: string, endDate: string }} window
 * @param {object} config
 */
export function summarizeWindow({ events, polls }, window, config) {
  const inWindow = (record) => {
    const ts = Date.parse(record.ts);
    return ts >= window.start && ts < window.end;
  };

  const windowEvents = events.filter(inWindow);
  const windowPolls = polls.filter(inWindow);

  // Seed rows are the baseline snapshot, not things that happened; listing all
  // ~938 of them would bury the window's actual news.
  const changes = windowEvents.filter((event) => event.kind !== 'seed');
  const seeded = windowEvents.length - changes.length;

  const cells = new Map();
  for (const event of changes) {
    const key = `${event.roomCode}|${event.salesDate}`;
    const entry = cells.get(key) ?? {
      roomCode: event.roomCode,
      roomName: event.roomName,
      salesDate: event.salesDate,
      dayOfWeek: event.dayOfWeek,
      events: [],
    };
    entry.events.push(event);
    cells.set(key, entry);
  }

  const counts = {};
  for (const event of changes) counts[event.kind] = (counts[event.kind] ?? 0) + 1;

  const ok = windowPolls.filter((poll) => poll.ok);
  const expected = Math.round((window.end - window.start) / config.poll.intervalMs);

  return {
    window: {
      startDate: window.startDate,
      endDate: window.endDate,
      start: new Date(window.start).toISOString(),
      end: new Date(window.end).toISOString(),
    },
    timeZone: config.daily.timeZone,
    coverage: {
      polls: windowPolls.length,
      ok: ok.length,
      failed: windowPolls.length - ok.length,
      expected,
      gaps: findWindowGaps(ok, config.poll.intervalMs),
    },
    counts,
    seeded,
    cells: [...cells.values()].sort(
      (a, b) => a.salesDate.localeCompare(b.salesDate) || a.roomName.localeCompare(b.roomName),
    ),
    availableAtEnd: availabilityAt(events, window.end),
  };
}

/** Gaps between successful polls inside a window (same rule as report.js). */
function findWindowGaps(okPolls, intervalMs) {
  const gaps = [];
  const threshold = intervalMs * 2.5;
  for (let i = 1; i < okPolls.length; i++) {
    const ms = Date.parse(okPolls[i].ts) - Date.parse(okPolls[i - 1].ts);
    if (ms > threshold) gaps.push({ from: okPolls[i - 1].ts, to: okPolls[i].ts, ms });
  }
  return gaps.sort((a, b) => b.ms - a.ms);
}

function humanMs(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60 ? `${minutes % 60}分` : ''}`;
}

/** One line describing what changed, e.g. "05:12 空室 残1 ¥110,000". */
function describeEvent(event, timeZone) {
  const at = localTime(Date.parse(event.ts), timeZone);
  const label = KIND_LABEL[event.kind] ?? event.kind;

  if (event.kind === 'price') {
    return `${at} ${label} ${yen(event.from?.memberPrice)} → ${yen(event.to?.memberPrice)}`;
  }
  if (event.kind === 'stock') {
    return `${at} ${label} 残${event.from?.stockNum} → 残${event.to?.stockNum}`;
  }
  if (event.kind === 'disappear' || event.kind === 'room_removed') {
    return `${at} ${label}`;
  }
  return `${at} ${label} 残${event.to?.stockNum ?? '?'} ${yen(event.to?.memberPrice)}`;
}

/**
 * Render a window summary as plain text, ready for splitMessage().
 *
 * @param {object} summary from summarizeWindow
 * @param {{ skippedNote?: string }} [options]
 */
export function formatSummary(summary, { skippedNote } = {}) {
  const tz = summary.timeZone;
  const out = [];

  if (skippedNote) out.push(skippedNote, '');

  const startAt = localTime(Date.parse(summary.window.start), tz);
  const endAt = localTime(Date.parse(summary.window.end), tz);
  out.push(`${summary.window.startDate} ${startAt} → ${summary.window.endDate} ${endAt} (${tz})`);

  const { coverage } = summary;
  out.push(`輪詢 ${coverage.ok}/${coverage.expected} 成功、失敗 ${coverage.failed}`);
  if (coverage.gaps.length > 0) {
    out.push(`⚠ 觀測中斷 ${coverage.gaps.length} 段（最長 ${humanMs(coverage.gaps[0].ms)}）`);
    for (const gap of coverage.gaps.slice(0, 3)) {
      out.push(
        `   ${localTime(Date.parse(gap.from), tz)} → ${localTime(Date.parse(gap.to), tz)} (${humanMs(gap.ms)})`,
      );
    }
    out.push('   中斷期間的「無變化」不可信。');
  }

  if (summary.seeded > 0)
    out.push(`基準建立 ${summary.seeded} 筆（初回のため変化としては数えません）`);

  const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  out.push('');

  if (total === 0) {
    out.push('本期間に変化はありませんでした。');
  } else {
    const parts = Object.entries(summary.counts).map(
      ([kind, n]) => `${KIND_LABEL[kind] ?? kind} ${n}`,
    );
    out.push(`変化 ${total} 件（${parts.join(' / ')}）`);
    out.push('');

    for (const cell of summary.cells) {
      const last = cell.events.at(-1);
      const finalState = last.to
        ? `${last.to.available ? '空室' : '満室'} 残${last.to.stockNum} ${yen(last.to.memberPrice)}`
        : '削除';
      out.push(`■ ${cell.salesDate} ${cell.roomName}`);
      for (const event of cell.events) out.push(`   ${describeEvent(event, tz)}`);
      out.push(`   → 締切時: ${finalState}`);
    }
  }

  if (summary.availableAtEnd !== null) {
    out.push('');
    out.push(`締切時の予約可能: ${summary.availableAtEnd} 件`);
  }

  return out.join('\n');
}

/** Hard-split a single line that is itself longer than the limit. */
function hardSplit(line, maxChars) {
  const pieces = [];
  for (let i = 0; i < line.length; i += maxChars) pieces.push(line.slice(i, i + maxChars));
  return pieces;
}

/**
 * Split text into chunks that fit a channel's message limit.
 *
 * Splits only at line boundaries, so a room's entry is never cut mid-line.
 * Joining the result with "\n" reproduces the input exactly, unless some single
 * line exceeded the limit and had to be broken.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
export function splitMessage(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const segments = [];
  let current = '';

  for (const line of text.split('\n')) {
    for (const piece of line.length > maxChars ? hardSplit(line, maxChars) : [line]) {
      const candidate = current === '' ? piece : `${current}\n${piece}`;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        if (current !== '') segments.push(current);
        current = piece;
      }
    }
  }

  if (current !== '') segments.push(current);
  return segments;
}

/**
 * Build the notification payloads for one window: one per message segment.
 *
 * @param {object} summary
 * @param {object} config
 * @param {{ skippedNote?: string }} [options]
 */
export function buildSummaryPayloads(summary, config, { skippedNote } = {}) {
  const text = formatSummary(summary, { skippedNote });
  const segments = splitMessage(text, config.daily.maxChars);
  const date = summary.window.endDate;

  return segments.map((segment, index) => ({
    source: 'd-reserve-jp',
    event: 'daily-summary',
    hotelCode: config.hotelCode,
    title: segments.length > 1 ? `日報 ${date} (${index + 1}/${segments.length})` : `日報 ${date}`,
    text: segment,
    bookingUrl: config.notify.bookingUrl || null,
    window: summary.window,
    segment: { index: index + 1, total: segments.length },
    detectedAt: new Date().toISOString(),
    matches: [],
  }));
}
