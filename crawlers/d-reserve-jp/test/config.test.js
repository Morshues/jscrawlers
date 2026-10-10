import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  monthWindows,
  monthsBetween,
  parseDateSpec,
  parseDuration,
} from '../src/config.js';

const BASE_ENV = {
  DRESERVE_HOTEL_CODE: '0000001834',
  DRESERVE_FROM_DATE: '2026-09-10',
  DRESERVE_TO_DATE: '2026-11-15',
};

test('monthsBetween spans the year boundary', () => {
  assert.deepEqual(monthsBetween('2026-11-20', '2027-02-03'), [
    '202611',
    '202612',
    '202701',
    '202702',
  ]);
});

test('monthWindows respects the API 2-month limit', () => {
  // 2026-09-10..2026-11-15 covers three months, so it must split into two calls.
  assert.deepEqual(monthWindows('2026-09-10', '2026-11-15'), [
    { fromYM: '202609', toYM: '202610' },
    { fromYM: '202611', toYM: '202611' },
  ]);
});

test('monthWindows keeps a short range in one request', () => {
  assert.deepEqual(monthWindows('2026-10-01', '2026-11-30'), [
    { fromYM: '202610', toYM: '202611' },
  ]);
  assert.deepEqual(monthWindows('2026-10-05', '2026-10-20'), [
    { fromYM: '202610', toYM: '202610' },
  ]);
});

test('parseDateSpec expands ranges and single dates together', () => {
  const dates = parseDateSpec('2026-10-09, 2026-11-01..2026-11-03');
  assert.deepEqual([...dates].sort(), ['2026-10-09', '2026-11-01', '2026-11-02', '2026-11-03']);
});

test('parseDateSpec crossing a month boundary', () => {
  assert.deepEqual([...parseDateSpec('2026-10-30..2026-11-02')].sort(), [
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
  ]);
});

test('parseDateSpec returns null when unset, meaning no restriction', () => {
  assert.equal(parseDateSpec(''), null);
  assert.equal(parseDateSpec(undefined), null);
});

test('parseDateSpec rejects bad input', () => {
  assert.throws(() => parseDateSpec('2026-13-01'), /YYYY-MM-DD/);
  assert.throws(() => parseDateSpec('2026-11-05..2026-11-01'), /ends before it starts/);
});

test('parseDuration understands suffixes and bare milliseconds', () => {
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1500'), 1500);
  assert.throws(() => parseDuration('soon'), /5m, 90s, 2h/);
});

test('loadConfig fails loudly on a missing hotel code', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DRESERVE_HOTEL_CODE: '' }),
    /DRESERVE_HOTEL_CODE is required/,
  );
});

test('loadConfig rejects an inverted date range', () => {
  assert.throws(
    () =>
      loadConfig({ ...BASE_ENV, DRESERVE_FROM_DATE: '2026-11-15', DRESERVE_TO_DATE: '2026-09-10' }),
    /before DRESERVE_FROM_DATE/,
  );
});

test('loadConfig rejects a typo in the weekday filter', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DRESERVE_WATCH_DAYS_OF_WEEK: 'FRIDAY,SATURNDAY' }),
    /unknown day "SATURNDAY"/,
  );
});

test('loadConfig defaults leave the watch unrestricted', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.watch.dates, null);
  assert.equal(config.watch.maxPrice, null);
  assert.equal(config.watch.roomCodes.size, 0);
  assert.equal(config.poll.intervalMs, 300_000);
  assert.equal(config.query.lodgerNum, '2_0_0_0_0_0');
  assert.equal(config.windows.length, 2);
});

// ── notification modes ──────────────────────────────────────────────────────

test('the default is the one-shot alert, with nothing listening for commands', () => {
  const { notify } = loadConfig(BASE_ENV);
  assert.equal(notify.mode, 'once');
  assert.deepEqual(notify.ackChannels, []);
  assert.equal(notify.legacyCooldown, false);
});

test('loadConfig rejects a mode it does not know', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, DRESERVE_NOTIFY_MODE: 'forever' }),
    /DRESERVE_NOTIFY_MODE must be one of once, until-ack/,
  );
});

test('until-ack needs an interval that actually elapses', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        DRESERVE_NOTIFY_MODE: 'until-ack',
        DRESERVE_NOTIFY_REPEAT_MIN: '0',
      }),
    /DRESERVE_NOTIFY_REPEAT_MIN must be greater than 0/,
  );
  const { notify } = loadConfig({ ...BASE_ENV, DRESERVE_NOTIFY_MODE: 'until-ack' });
  assert.equal(notify.repeatMs, 10 * 60_000, 'ten minutes unless told otherwise');
});

test('an existing cooldown keeps its cadence and gains a way to stop', () => {
  const { notify } = loadConfig({ ...BASE_ENV, DRESERVE_NOTIFY_COOLDOWN_MIN: '30' });
  assert.equal(notify.mode, 'until-ack');
  assert.equal(notify.repeatMs, 30 * 60_000);
  assert.equal(notify.legacyCooldown, true, 'so the run can say it has been superseded');

  // An explicit mode wins: the old knob is then only a fallback interval.
  const explicit = loadConfig({
    ...BASE_ENV,
    DRESERVE_NOTIFY_MODE: 'once',
    DRESERVE_NOTIFY_COOLDOWN_MIN: '30',
  });
  assert.equal(explicit.notify.mode, 'once');
  assert.equal(explicit.notify.legacyCooldown, false);
});

test('Telegram only listens for /stop when it is a channel and the mode nags', () => {
  const on = loadConfig({
    ...BASE_ENV,
    DRESERVE_NOTIFY_MODE: 'until-ack',
    DRESERVE_NOTIFY_CHANNELS: 'telegram,webhook',
  });
  assert.deepEqual(on.notify.ackChannels, ['telegram']);

  const off = loadConfig({
    ...BASE_ENV,
    DRESERVE_NOTIFY_MODE: 'until-ack',
    DRESERVE_NOTIFY_CHANNELS: 'telegram',
    DRESERVE_NOTIFY_ACK_TELEGRAM: 'false',
  });
  assert.deepEqual(off.notify.ackChannels, [], 'the escape hatch for a shared bot token');

  const onceMode = loadConfig({ ...BASE_ENV, DRESERVE_NOTIFY_CHANNELS: 'telegram' });
  assert.deepEqual(onceMode.notify.ackChannels, [], 'nothing to stop in once mode');
});

test('health and pacing knobs have safe defaults', () => {
  const config = loadConfig(BASE_ENV);
  assert.equal(config.poll.jitterRatio, 0.2);
  assert.equal(config.poll.httpRetries, 3);
  assert.deepEqual(config.health, {
    alertAfter: 3,
    repeatMs: 3_600_000,
    channels: [],
    backoffBaseMs: 0,
    backoffMaxMs: 1_800_000,
  });
});

test('health and pacing knobs are read and validated', () => {
  const config = loadConfig({
    ...BASE_ENV,
    DRESERVE_INTERVAL_JITTER: '0',
    DRESERVE_HTTP_RETRIES: '1',
    DRESERVE_HEALTH_ALERT_AFTER: '5',
    DRESERVE_HEALTH_CHANNELS: 'telegram',
    DRESERVE_BACKOFF_BASE: '2m',
  });
  assert.equal(config.poll.jitterRatio, 0);
  assert.equal(config.poll.httpRetries, 1);
  assert.equal(config.health.alertAfter, 5);
  assert.deepEqual(config.health.channels, ['telegram']);
  assert.equal(config.health.backoffBaseMs, 120_000);

  assert.throws(() => loadConfig({ ...BASE_ENV, DRESERVE_INTERVAL_JITTER: '1.5' }), /JITTER/);
  assert.throws(() => loadConfig({ ...BASE_ENV, DRESERVE_HEALTH_ALERT_AFTER: '0' }), /ALERT_AFTER/);
});
