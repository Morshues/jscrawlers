import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  availabilityAt,
  boundaryAtOrBefore,
  buildSummaryPayloads,
  formatSummary,
  pendingWindows,
  splitMessage,
  summarizeWindow,
  tzOffsetMs,
  zonedBoundary,
} from '../src/daily-summary.js';

const TPE = 'Asia/Taipei';
const HOUR = 20;

function configWith(overrides = {}) {
  return loadConfig({
    DRESERVE_HOTEL_CODE: '0000001834',
    DRESERVE_FROM_DATE: '2026-09-10',
    DRESERVE_TO_DATE: '2026-11-15',
    ...overrides,
  });
}

/** Asia/Taipei is UTC+8 year round, so 20:00 local is 12:00Z the same day. */
const at = (iso) => Date.parse(iso);

// ── boundary maths ───────────────────────────────────────────────────────────

test('20:00 Asia/Taipei is 12:00Z', () => {
  assert.equal(
    new Date(zonedBoundary('2026-09-10', HOUR, TPE)).toISOString(),
    '2026-09-10T12:00:00.000Z',
  );
});

test('tzOffsetMs reports +8h for Taipei', () => {
  assert.equal(tzOffsetMs(at('2026-09-10T00:00:00Z'), TPE), 8 * 3_600_000);
});

test('boundaryAtOrBefore snaps back when the boundary has not been reached', () => {
  // 11:59Z on the 10th is 19:59 local — the 20:00 boundary has not landed yet.
  assert.equal(boundaryAtOrBefore(at('2026-09-10T11:59:00Z'), HOUR, TPE).date, '2026-09-09');
  assert.equal(boundaryAtOrBefore(at('2026-09-10T12:00:00Z'), HOUR, TPE).date, '2026-09-10');
});

// ── event attribution: the acceptance criterion ──────────────────────────────

test('19:59:59 belongs to the window closing that day, 20:00:00 to the next', () => {
  const { windows } = pendingWindows({
    lastWindowEnd: '2026-09-09T12:00:00.000Z', // 2026-09-09 20:00 local
    now: at('2026-09-11T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  const [first, second] = windows;
  assert.equal(first.startDate, '2026-09-09');
  assert.equal(first.endDate, '2026-09-10');

  const justBefore = at('2026-09-10T11:59:59Z'); // 19:59:59 local
  const exactly = at('2026-09-10T12:00:00Z'); // 20:00:00 local

  assert.ok(justBefore >= first.start && justBefore < first.end, '19:59:59 is in the first window');
  assert.ok(exactly >= first.end, '20:00:00 is excluded from the first window');
  assert.ok(exactly >= second.start && exactly < second.end, '20:00:00 opens the second window');
});

test('evening and after-midnight events share the window that opened at 20:00', () => {
  const { windows } = pendingWindows({
    lastWindowEnd: '2026-09-09T12:00:00.000Z',
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  const [window] = windows;
  // 23:30 on the 9th and 02:00 on the 10th, both local.
  for (const iso of ['2026-09-09T15:30:00Z', '2026-09-09T18:00:00Z']) {
    assert.ok(at(iso) >= window.start && at(iso) < window.end, iso);
  }
});

test('consecutive windows partition time with no overlap and no gap', () => {
  const { windows } = pendingWindows({
    lastWindowEnd: '2026-09-07T12:00:00.000Z',
    now: at('2026-09-11T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.ok(windows.length >= 3);
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].start, windows[i - 1].end, 'no gap and no overlap between windows');
  }

  // Every minute of the covered span lands in exactly one window.
  const span = windows.at(-1).end - windows[0].start;
  for (let offset = 0; offset < span; offset += 37 * 60_000) {
    const instant = windows[0].start + offset;
    const hits = windows.filter((w) => instant >= w.start && instant < w.end);
    assert.equal(hits.length, 1, `instant ${new Date(instant).toISOString()} hit ${hits.length}`);
  }
});

// ── backfill ─────────────────────────────────────────────────────────────────

test('a missed day yields two pending windows, oldest first', () => {
  const { windows, skipped } = pendingWindows({
    lastWindowEnd: '2026-09-08T12:00:00.000Z',
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.deepEqual(
    windows.map((w) => w.endDate),
    ['2026-09-09', '2026-09-10'],
  );
  assert.equal(skipped.length, 0);
});

test('a stale checkpoint is capped, and the skipped windows are reported', () => {
  const { windows, skipped } = pendingWindows({
    lastWindowEnd: '2026-08-11T12:00:00.000Z', // 30 days behind
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.equal(windows.length, 7);
  assert.equal(skipped.length, 23);
  assert.equal(windows.at(-1).endDate, '2026-09-10', 'the most recent window is always kept');
  assert.equal(skipped[0].startDate, '2026-08-11', 'the oldest skipped window is reported');
});

test('a cold start reports only the most recent complete window', () => {
  const { windows, skipped } = pendingWindows({
    lastWindowEnd: null,
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startDate, '2026-09-09');
  assert.equal(windows[0].endDate, '2026-09-10');
  assert.equal(skipped.length, 0);
});

test('nothing is due when the latest window is already delivered', () => {
  const { windows } = pendingWindows({
    lastWindowEnd: '2026-09-10T12:00:00.000Z',
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.equal(windows.length, 0);
});

test('a checkpoint off the grid is realigned instead of producing a part-window', () => {
  const { windows, realigned } = pendingWindows({
    lastWindowEnd: '2026-09-09T03:17:00.000Z', // nowhere near a 20:00 boundary
    now: at('2026-09-10T13:00:00Z'),
    timeZone: TPE,
    hour: HOUR,
    maxBackfill: 7,
  });
  assert.equal(realigned, true);
  assert.equal(windows[0].startDate, '2026-09-08', 'snapped back to the previous boundary');
  for (const window of windows) {
    assert.equal(window.end - window.start, 86_400_000, 'every window stays whole');
  }
});

// ── DST: the reason boundaries are not "previous + 24h" ──────────────────────

test('a DST zone keeps the boundary at local 20:00 and yields 23h/25h days', () => {
  const NY = 'America/New_York';
  // US DST starts 2026-03-08 and ends 2026-11-01.
  const spring = pendingWindows({
    lastWindowEnd: String(new Date(zonedBoundary('2026-03-07', HOUR, NY)).toISOString()),
    now: at('2026-03-09T10:00:00Z'),
    timeZone: NY,
    hour: HOUR,
    maxBackfill: 7,
  }).windows[0];
  assert.equal(spring.end - spring.start, 23 * 3_600_000, 'spring forward gives a 23h window');

  const autumn = pendingWindows({
    lastWindowEnd: String(new Date(zonedBoundary('2026-10-31', HOUR, NY)).toISOString()),
    now: at('2026-11-02T10:00:00Z'),
    timeZone: NY,
    hour: HOUR,
    maxBackfill: 7,
  }).windows[0];
  assert.equal(autumn.end - autumn.start, 25 * 3_600_000, 'fall back gives a 25h window');
});

// ── aggregation ──────────────────────────────────────────────────────────────

function event(ts, overrides = {}) {
  return {
    ts,
    kind: 'appear',
    roomCode: 'RM00010235',
    roomName: '露天風呂付特別室',
    salesDate: '2026-11-14',
    dayOfWeek: 'SATURDAY',
    from: { available: false, stockStatus: 'SOLD_OUT', stockNum: 0, memberPrice: 110000 },
    to: { available: true, stockStatus: 'FEW_STOCK', stockNum: 1, memberPrice: 110000 },
    ...overrides,
  };
}

const WINDOW = {
  startDate: '2026-09-09',
  endDate: '2026-09-10',
  start: at('2026-09-09T12:00:00Z'),
  end: at('2026-09-10T12:00:00Z'),
};

test('summarizeWindow keeps only in-window events and groups them per cell', () => {
  const events = [
    event('2026-09-09T11:59:59Z'), // before the window
    event('2026-09-09T15:30:00Z'), // 23:30 local, inside
    event('2026-09-09T18:00:00Z', { kind: 'disappear' }), // 02:00 local next day, inside
    event('2026-09-10T12:00:00Z'), // exactly the closing boundary, excluded
  ];
  const summary = summarizeWindow({ events, polls: [] }, WINDOW, configWith());

  assert.equal(summary.cells.length, 1);
  assert.equal(summary.cells[0].events.length, 2);
  assert.deepEqual(summary.counts, { appear: 1, disappear: 1 });
});

test('seed rows are counted but never listed as changes', () => {
  const events = [
    event('2026-09-09T13:00:00Z', { kind: 'seed', from: undefined }),
    event('2026-09-09T14:00:00Z'),
  ];
  const summary = summarizeWindow({ events, polls: [] }, WINDOW, configWith());
  assert.equal(summary.seeded, 1);
  assert.equal(summary.cells.length, 1);
  assert.equal(summary.cells[0].events.length, 1, 'only the real change is listed');
});

test('coverage counts polls and flags gaps inside the window', () => {
  const polls = [
    { ts: '2026-09-09T13:00:00Z', ok: true },
    { ts: '2026-09-09T13:05:00Z', ok: true },
    { ts: '2026-09-09T16:00:00Z', ok: true }, // ~3h gap
    { ts: '2026-09-09T16:05:00Z', ok: false },
  ];
  const summary = summarizeWindow({ events: [], polls }, WINDOW, configWith());
  assert.equal(summary.coverage.polls, 4);
  assert.equal(summary.coverage.ok, 3);
  assert.equal(summary.coverage.failed, 1);
  assert.equal(summary.coverage.expected, 288, '24h at a 5m interval');
  assert.equal(summary.coverage.gaps.length, 1);
});

test('availabilityAt replays from the seed rather than reading current state', () => {
  const events = [
    {
      ts: '2026-09-01T00:00:00Z',
      kind: 'seed',
      roomCode: 'A',
      salesDate: 'd1',
      to: { available: false },
    },
    {
      ts: '2026-09-01T00:00:00Z',
      kind: 'seed',
      roomCode: 'B',
      salesDate: 'd1',
      to: { available: false },
    },
    {
      ts: '2026-09-09T13:00:00Z',
      kind: 'appear',
      roomCode: 'A',
      salesDate: 'd1',
      to: { available: true },
    },
    // After the cutoff, so it must not affect the answer.
    {
      ts: '2026-09-10T13:00:00Z',
      kind: 'appear',
      roomCode: 'B',
      salesDate: 'd1',
      to: { available: true },
    },
  ];
  assert.equal(availabilityAt(events, WINDOW.end), 1);
});

test('availabilityAt returns null when the baseline is missing', () => {
  const events = [
    {
      ts: '2026-09-09T13:00:00Z',
      kind: 'appear',
      roomCode: 'A',
      salesDate: 'd1',
      to: { available: true },
    },
  ];
  assert.equal(availabilityAt(events, WINDOW.end), null);
});

// ── formatting and splitting ─────────────────────────────────────────────────

test('a quiet window still reports coverage', () => {
  const summary = summarizeWindow({ events: [], polls: [] }, WINDOW, configWith());
  const text = formatSummary(summary);
  assert.match(text, /2026-09-09 20:00 → 2026-09-10 20:00 \(Asia\/Taipei\)/);
  assert.match(text, /本期間に変化はありませんでした/);
});

test('the summary renders the timeline and the closing state', () => {
  const events = [
    event('2026-09-09T13:00:00Z'),
    event('2026-09-09T14:00:00Z', {
      kind: 'price',
      from: { available: true, stockNum: 1, memberPrice: 110000 },
      to: { available: true, stockStatus: 'FEW_STOCK', stockNum: 1, memberPrice: 118800 },
    }),
  ];
  const text = formatSummary(summarizeWindow({ events, polls: [] }, WINDOW, configWith()));
  assert.match(text, /■ 2026-11-14 露天風呂付特別室/);
  assert.match(text, /21:00 空室 残1 ¥110,000/);
  assert.match(text, /22:00 価格 ¥110,000 → ¥118,800/);
  assert.match(text, /締切時: 空室 残1 ¥118,800/);
});

test('splitMessage keeps short text whole', () => {
  assert.deepEqual(splitMessage('short', 100), ['short']);
});

test('splitMessage never breaks a line and round-trips exactly', () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const segments = splitMessage(text, 200);

  assert.ok(segments.length > 1);
  for (const segment of segments)
    assert.ok(segment.length <= 200, `segment too long: ${segment.length}`);
  assert.equal(segments.join('\n'), text, 'content survives the split');
  for (const segment of segments) {
    for (const line of segment.split('\n')) assert.match(line, /^line \d+ x+$/);
  }
});

test('splitMessage hard-splits a single over-long line', () => {
  const segments = splitMessage('y'.repeat(250), 100);
  assert.deepEqual(
    segments.map((s) => s.length),
    [100, 100, 50],
  );
});

test('payloads are numbered when the digest needs more than one message', () => {
  const events = Array.from({ length: 80 }, (_, i) =>
    event(new Date(WINDOW.start + i * 60_000).toISOString(), {
      salesDate: `2026-11-${(i % 28) + 1}`,
    }),
  );
  const summary = summarizeWindow({ events, polls: [] }, WINDOW, configWith());
  const payloads = buildSummaryPayloads(summary, configWith({ DRESERVE_DAILY_MAX_CHARS: '600' }));

  assert.ok(payloads.length > 1);
  assert.match(payloads[0].title, /日報 2026-09-10 \(1\/\d+\)/);
  for (const payload of payloads) {
    assert.ok(payload.text.length <= 600);
    assert.equal(payload.event, 'daily-summary');
    assert.equal(payload.segment.total, payloads.length);
  }
});

test('a single-segment digest is not numbered', () => {
  const summary = summarizeWindow({ events: [], polls: [] }, WINDOW, configWith());
  const [payload, ...rest] = buildSummaryPayloads(summary, configWith());
  assert.equal(rest.length, 0);
  assert.equal(payload.title, '日報 2026-09-10');
});

test('the skip notice rides on the first message only', () => {
  const summary = summarizeWindow({ events: [], polls: [] }, WINDOW, configWith());
  const withNote = buildSummaryPayloads(summary, configWith(), {
    skippedNote: '※ 3 期分をスキップ',
  });
  assert.match(withNote[0].text, /※ 3 期分をスキップ/);
  const without = buildSummaryPayloads(summary, configWith());
  assert.doesNotMatch(without[0].text, /スキップ/);
});
