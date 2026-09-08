import fs from 'node:fs/promises';
import path from 'node:path';
import { outputDir } from '@jscrawlers/core';

/**
 * Offline analysis of the history this crawler accumulates. Reads only local
 * files — `--report` never touches the network.
 *
 * The question this exists to answer is "roughly when do cancellations get
 * released?", so the headline output is an appear-event heatmap in the hotel's
 * own timezone, plus how long an opening survives before someone books it.
 */

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function readJsonlFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A half-written final line can happen if a run was killed mid-append.
      process.emitWarning(`skipping malformed JSONL at ${path.basename(file)}:${index + 1}`);
    }
  }
  return records;
}

/** Read every events-YYYYMM.jsonl plus polls.jsonl. */
export async function readHistory(crawler) {
  const dir = await outputDir(crawler);
  const names = await fs.readdir(dir).catch(() => []);
  const eventFiles = names.filter((name) => /^events-\d{6}\.jsonl$/.test(name)).sort();

  const events = [];
  for (const name of eventFiles) events.push(...(await readJsonlFile(path.join(dir, name))));
  const polls = await readJsonlFile(path.join(dir, 'polls.jsonl'));

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  polls.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, polls, dir };
}

/** Weekday + hour of an ISO timestamp, as seen in `timeZone`. */
export function localParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '?';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  // Intl renders midnight as "24" in some ICU versions.
  return { weekday, hour: hour % 24 };
}

/**
 * Gaps between consecutive successful polls that are much longer than the
 * configured interval. Without this a quiet stretch is indistinguishable from a
 * crashed crawler, and the heatmap would quietly lie.
 */
export function findGaps(polls, intervalMs) {
  const ok = polls.filter((poll) => poll.ok);
  const gaps = [];
  const threshold = intervalMs * 2.5;
  for (let i = 1; i < ok.length; i++) {
    const ms = Date.parse(ok[i].ts) - Date.parse(ok[i - 1].ts);
    if (ms > threshold) gaps.push({ from: ok[i - 1].ts, to: ok[i].ts, ms });
  }
  return gaps.sort((a, b) => b.ms - a.ms);
}

/** Pair each `appear` with the `disappear` that closed it, per cell. */
export function survivalTimes(events) {
  const open = new Map();
  const spans = [];

  for (const event of events) {
    const key = `${event.roomCode}|${event.salesDate}`;
    if (event.kind === 'appear') {
      open.set(key, event);
    } else if (event.kind === 'disappear' && open.has(key)) {
      const start = open.get(key);
      open.delete(key);
      spans.push({
        roomCode: event.roomCode,
        roomName: event.roomName,
        salesDate: event.salesDate,
        openedAt: start.ts,
        closedAt: event.ts,
        ms: Date.parse(event.ts) - Date.parse(start.ts),
      });
    }
  }

  return { spans, stillOpen: [...open.values()] };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function humanMs(ms) {
  if (ms === null) return 'n/a';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Build the full report object.
 *
 * @param {{ events: object[], polls: object[] }} history
 * @param {object} config
 * @param {{ sinceMs?: number|null, now?: number }} [options]
 */
export function buildReport({ events, polls }, config, { sinceMs = null, now = Date.now() } = {}) {
  const cutoff = sinceMs === null ? null : new Date(now - sinceMs).toISOString();
  const inRange = (record) => cutoff === null || record.ts >= cutoff;

  const scopedEvents = events.filter(inRange);
  const scopedPolls = polls.filter(inRange);
  const appears = scopedEvents.filter((event) => event.kind === 'appear');

  const heatmap = {};
  for (const weekday of WEEKDAYS) heatmap[weekday] = new Array(24).fill(0);
  for (const event of appears) {
    const { weekday, hour } = localParts(event.ts, config.reportTz);
    if (heatmap[weekday]) heatmap[weekday][hour]++;
  }

  const byCell = new Map();
  for (const event of appears) {
    const key = `${event.roomCode}|${event.salesDate}`;
    const entry = byCell.get(key) ?? {
      roomCode: event.roomCode,
      roomName: event.roomName,
      salesDate: event.salesDate,
      dayOfWeek: event.dayOfWeek,
      count: 0,
      lastAt: null,
    };
    entry.count++;
    entry.lastAt = event.ts;
    byCell.set(key, entry);
  }

  const { spans, stillOpen } = survivalTimes(scopedEvents);
  const durations = spans.map((span) => span.ms);

  const priceChanges = scopedEvents.filter((event) => event.kind === 'price');
  const priceByRoom = new Map();
  for (const event of priceChanges) {
    const entry = priceByRoom.get(event.roomCode) ?? {
      roomCode: event.roomCode,
      roomName: event.roomName,
      changes: 0,
      min: Infinity,
      max: -Infinity,
    };
    entry.changes++;
    for (const price of [event.from?.memberPrice, event.to?.memberPrice]) {
      if (typeof price === 'number') {
        entry.min = Math.min(entry.min, price);
        entry.max = Math.max(entry.max, price);
      }
    }
    priceByRoom.set(event.roomCode, entry);
  }

  const failed = scopedPolls.filter((poll) => !poll.ok);

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: config.reportTz,
    window: {
      since: cutoff,
      firstPollAt: scopedPolls[0]?.ts ?? null,
      lastPollAt: scopedPolls.at(-1)?.ts ?? null,
    },
    coverage: {
      polls: scopedPolls.length,
      failed: failed.length,
      gaps: findGaps(scopedPolls, config.poll.intervalMs).slice(0, 5),
    },
    releases: {
      total: appears.length,
      heatmap,
      byCell: [...byCell.values()].sort(
        (a, b) => b.count - a.count || a.salesDate.localeCompare(b.salesDate),
      ),
    },
    survival: {
      observed: spans.length,
      medianMs: median(durations),
      shortestMs: durations.length ? Math.min(...durations) : null,
      longestMs: durations.length ? Math.max(...durations) : null,
      stillOpen: stillOpen.map((event) => ({
        roomName: event.roomName,
        salesDate: event.salesDate,
        openedAt: event.ts,
      })),
      spans: spans.slice(-20),
    },
    prices: [...priceByRoom.values()].map((entry) => ({
      ...entry,
      min: entry.min === Infinity ? null : entry.min,
      max: entry.max === -Infinity ? null : entry.max,
    })),
  };
}

const BLOCKS = [' ', '·', '░', '▒', '▓', '█'];

function heatCell(count, max) {
  if (count === 0) return BLOCKS[0];
  return BLOCKS[Math.min(BLOCKS.length - 1, Math.ceil((count / max) * (BLOCKS.length - 1)))];
}

/** Render the report for a terminal. */
export function formatReport(report, config, state) {
  const out = [];
  const { coverage, releases, survival } = report;

  out.push(
    `觀測期間  ${report.window.firstPollAt ?? '(無資料)'} → ${report.window.lastPollAt ?? ''}`,
  );
  out.push(`輪詢次數  ${coverage.polls} 次，失敗 ${coverage.failed} 次`);
  if (coverage.gaps.length > 0) {
    out.push(`⚠ 觀測中斷 ${coverage.gaps.length} 段（最長 ${humanMs(coverage.gaps[0].ms)}）：`);
    for (const gap of coverage.gaps) out.push(`    ${gap.from} → ${gap.to}  (${humanMs(gap.ms)})`);
    out.push('  中斷期間的「沒有釋出」不可信。');
  }
  out.push('');

  if (releases.total === 0) {
    out.push('尚未觀測到任何空房釋出（appear）事件。');
    out.push(coverage.polls < 12 ? '觀測時間還太短，繼續累積資料再看。' : '這段期間確實沒有釋出。');
  } else {
    out.push(`釋出事件  ${releases.total} 次（時區 ${report.timezone}）`);
    out.push('');
    const max = Math.max(...Object.values(releases.heatmap).flat());
    out.push(
      '     ' + Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')[0]).join(''),
    );
    out.push(
      '     ' + Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')[1]).join(''),
    );
    for (const weekday of WEEKDAYS) {
      const row = releases.heatmap[weekday];
      const sum = row.reduce((a, b) => a + b, 0);
      out.push(`${weekday}  ${row.map((n) => heatCell(n, max)).join('')}  ${sum || ''}`);
    }
    out.push('');
    out.push('釋出次數最多的日期 / 房型：');
    for (const cell of releases.byCell.slice(0, 10)) {
      out.push(`  ${cell.salesDate}  ${cell.roomName}  ${cell.count} 次  (最近 ${cell.lastAt})`);
    }
    out.push('');
    out.push(
      `釋出後存活  中位數 ${humanMs(survival.medianMs)}` +
        `  最短 ${humanMs(survival.shortestMs)}  最長 ${humanMs(survival.longestMs)}` +
        `  (${survival.observed} 次完整觀測)`,
    );
    if (survival.shortestMs !== null && survival.shortestMs < config.poll.intervalMs) {
      out.push('  ⚠ 最短存活時間短於輪詢間隔，可能有釋出沒被抓到 — 考慮縮短 DRESERVE_INTERVAL。');
    }
  }

  if (report.prices.length > 0) {
    out.push('');
    out.push('價格變動：');
    for (const entry of report.prices) {
      out.push(
        `  ${entry.roomName}  ${entry.changes} 次  ¥${entry.min?.toLocaleString('ja-JP')} – ¥${entry.max?.toLocaleString('ja-JP')}`,
      );
    }
  }

  const availableNow = Object.values(state?.cells ?? {}).filter((cell) => cell.available);
  out.push('');
  out.push(`目前可訂  ${availableNow.length} 筆${availableNow.length ? '：' : ''}`);
  for (const cell of availableNow.slice(0, 20)) {
    out.push(
      `  ${cell.salesDate}  ${cell.roomName}  残${cell.stockNum}  ¥${cell.memberPrice?.toLocaleString('ja-JP') ?? '?'}`,
    );
  }

  return out.join('\n');
}
