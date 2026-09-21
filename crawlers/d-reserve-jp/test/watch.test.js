import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import {
  matchesWatch,
  selectNotifications,
  buildPayloads,
  buildClosedPayloads,
  resolveAck,
  resolveCell,
} from '../src/watch.js';

function configWith(overrides = {}) {
  return loadConfig({
    DRESERVE_HOTEL_CODE: '0000001834',
    DRESERVE_FROM_DATE: '2026-09-10',
    DRESERVE_TO_DATE: '2026-11-15',
    ...overrides,
  });
}

function cell(overrides = {}) {
  return {
    roomCode: 'RM00010235',
    roomName: '露天風呂付特別室',
    salesDate: '2026-10-09',
    dayOfWeek: 'FRIDAY',
    available: true,
    stockStatus: 'FEW_STOCK',
    stockNum: 1,
    noSaleReason: null,
    memberPrice: 110000,
    regularPrice: 110000,
    planCode: 'PL00028617',
    ...overrides,
  };
}

const KEY = 'RM00010235|2026-10-09';

test('an empty watch config matches any bookable cell', () => {
  const { watch } = configWith();
  assert.equal(matchesWatch(cell(), watch), true);
  assert.equal(matchesWatch(cell({ available: false }), watch), false);
});

test('each criterion narrows independently', () => {
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_DATES: '2026-10-09' }).watch),
    true,
  );
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_DATES: '2026-10-10' }).watch),
    false,
  );

  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_ROOM_NAME: '露天風呂付' }).watch),
    true,
  );
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_ROOM_NAME: '和洋室' }).watch),
    false,
  );

  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_ROOM_CODES: 'RM00010235' }).watch),
    true,
  );
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_ROOM_CODES: 'RM00010241' }).watch),
    false,
  );

  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_DAYS_OF_WEEK: 'FRIDAY' }).watch),
    true,
  );
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_DAYS_OF_WEEK: 'SATURDAY' }).watch),
    false,
  );

  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_MAX_PRICE: '120000' }).watch),
    true,
  );
  assert.equal(
    matchesWatch(cell(), configWith({ DRESERVE_WATCH_MAX_PRICE: '100000' }).watch),
    false,
  );

  assert.equal(
    matchesWatch(cell({ stockNum: 1 }), configWith({ DRESERVE_WATCH_MIN_STOCK: '2' }).watch),
    false,
  );
});

test('an unknown price fails a max-price filter rather than slipping through', () => {
  const { watch } = configWith({ DRESERVE_WATCH_MAX_PRICE: '120000' });
  assert.equal(matchesWatch(cell({ memberPrice: null }), watch), false);
});

test('notifies on the rising edge only', () => {
  const config = configWith();
  const cells = { [KEY]: cell() };

  const first = selectNotifications(cells, config, {});
  assert.equal(first.fresh.length, 1);

  // Same cell still bookable on the next poll: matched, but not re-announced.
  const second = selectNotifications(cells, config, first.notified);
  assert.equal(second.matches.length, 1);
  assert.equal(second.fresh.length, 0);
});

test('a cell that closes and reopens counts as a fresh edge', () => {
  const config = configWith();
  const open = selectNotifications({ [KEY]: cell() }, config, {});
  const closed = selectNotifications({ [KEY]: cell({ available: false }) }, config, open.notified);
  assert.equal(Object.keys(closed.notified).length, 0);

  const reopened = selectNotifications({ [KEY]: cell() }, config, closed.notified);
  assert.equal(reopened.fresh.length, 1);
});

test('the old cooldown knob still repeats, now as until-ack', () => {
  const config = configWith({ DRESERVE_NOTIFY_COOLDOWN_MIN: '60' });
  assert.equal(config.notify.mode, 'until-ack');
  const cells = { [KEY]: cell() };
  const now = Date.parse('2026-10-01T00:00:00Z');

  const first = selectNotifications(cells, config, {}, { now });
  const tooSoon = selectNotifications(cells, config, first.notified, { now: now + 30 * 60_000 });
  assert.equal(tooSoon.fresh.length, 0);
  // The clock keeps running from the original alert, not from this poll.
  assert.equal(tooSoon.notified[KEY].lastNotifiedAt, first.notified[KEY].lastNotifiedAt);

  const later = selectNotifications(cells, config, first.notified, { now: now + 61 * 60_000 });
  assert.equal(later.fresh.length, 1);
});

test('the default cooldown of 0 never repeats while a cell stays open', () => {
  const config = configWith();
  const cells = { [KEY]: cell() };
  const now = Date.parse('2026-10-01T00:00:00Z');
  const first = selectNotifications(cells, config, {}, { now });
  const muchLater = selectNotifications(cells, config, first.notified, {
    now: now + 30 * 86_400_000,
  });
  assert.equal(muchLater.fresh.length, 0);
});

test('grouped mode sends one payload covering every match', () => {
  const config = configWith({ DRESERVE_BOOKING_URL: 'https://example.com/book' });
  const cells = [
    cell(),
    cell({ roomCode: 'RM00010241', roomName: '露天風呂付和室', salesDate: '2026-10-10' }),
  ];

  const [payload, ...rest] = buildPayloads(cells, config);
  assert.equal(rest.length, 0);
  assert.equal(payload.matches.length, 2);
  assert.match(payload.title, /另 1 筆/);
  assert.match(payload.text, /2026-10-09 \(五\)/);
  assert.match(payload.text, /https:\/\/example\.com\/book/);
  assert.equal(payload.source, 'd-reserve-jp');
});

test('ungrouped mode sends one payload per cell', () => {
  const config = configWith({ DRESERVE_NOTIFY_GROUPED: 'false' });
  const payloads = buildPayloads([cell(), cell({ salesDate: '2026-10-10' })], config);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].matches.length, 1);
});

test('nothing to announce means no payloads', () => {
  assert.deepEqual(buildPayloads([], configWith()), []);
});

// ── until-ack: nag until told to stop ────────────────────────────────────────

function untilAck(overrides = {}) {
  return configWith({
    DRESERVE_NOTIFY_MODE: 'until-ack',
    DRESERVE_NOTIFY_REPEAT_MIN: '10',
    ...overrides,
  });
}

const NOW = Date.parse('2026-10-01T00:00:00Z');

test('until-ack keeps reminding on the interval', () => {
  const config = untilAck();
  const cells = { [KEY]: cell() };

  const first = selectNotifications(cells, config, {}, { now: NOW });
  assert.equal(first.fresh.length, 1);

  const tooSoon = selectNotifications(cells, config, first.notified, { now: NOW + 9 * 60_000 });
  assert.equal(tooSoon.fresh.length, 0);

  const due = selectNotifications(cells, config, first.notified, { now: NOW + 10 * 60_000 });
  assert.equal(due.fresh.length, 1, 'still open, still nagging');
});

test('a stop command silences the reminders but keeps watching', () => {
  const config = untilAck();
  const cells = { [KEY]: cell() };
  const first = selectNotifications(cells, config, {}, { now: NOW });

  const stopped = selectNotifications(cells, config, first.notified, {
    now: NOW + 10 * 60_000,
    acked: [KEY],
  });
  assert.equal(stopped.fresh.length, 0);
  assert.equal(stopped.matches.length, 1, 'the cell is still matched, just not announced');

  const muchLater = selectNotifications(cells, config, stopped.notified, {
    now: NOW + 30 * 86_400_000,
  });
  assert.equal(muchLater.fresh.length, 0);
});

test('once mode ignores the repeat interval entirely', () => {
  const config = untilAck({ DRESERVE_NOTIFY_MODE: 'once' });
  const cells = { [KEY]: cell() };
  const first = selectNotifications(cells, config, {}, { now: NOW });
  const later = selectNotifications(cells, config, first.notified, { now: NOW + 86_400_000 });
  assert.equal(later.fresh.length, 0);
});

test('a cell that is booked away is reported as closed, once', () => {
  const config = untilAck();
  const open = selectNotifications({ [KEY]: cell() }, config, {}, { now: NOW });

  const gone = selectNotifications({ [KEY]: cell({ available: false }) }, config, open.notified, {
    now: NOW + 60_000,
  });
  assert.deepEqual(gone.closed, [KEY]);

  const after = selectNotifications({ [KEY]: cell({ available: false }) }, config, gone.notified, {
    now: NOW + 120_000,
  });
  assert.deepEqual(after.closed, [], 'silence after that');
});

test('the closing notice names the room and says why it stopped', () => {
  const [payload, ...rest] = buildClosedPayloads([cell()], untilAck());
  assert.equal(rest.length, 0);
  assert.equal(payload.event, 'availability-closed');
  assert.match(payload.title, /提醒結束：露天風呂付特別室 2026-10-09/);
  assert.match(payload.text, /2026-10-09 \(五\) {2}露天風呂付特別室/);
  assert.match(payload.text, /已被訂走（或不再可訂），停止提醒。/);
  assert.equal(payload.matches.length, 1);
});

test('the closing notice follows the grouping setting too', () => {
  const cells = [cell(), cell({ salesDate: '2026-10-10' })];
  assert.equal(buildClosedPayloads(cells, untilAck()).length, 1);
  assert.equal(
    buildClosedPayloads(cells, untilAck({ DRESERVE_NOTIFY_GROUPED: 'false' })).length,
    2,
  );
  assert.deepEqual(buildClosedPayloads([], untilAck()), []);
});

// ── who a stop command applies to ───────────────────────────────────────────

test('a bare stop silences everything currently being announced', () => {
  const keys = [KEY, 'RM00010241|2026-10-10'];
  assert.deepEqual(resolveAck(null, keys), keys);
  assert.deepEqual(resolveAck('  ', keys), keys);
});

test('a filter matches the date, the room code or the room name', () => {
  const other = 'RM00010241|2026-10-10';
  const keys = [KEY, other];
  const cells = { [KEY]: cell(), [other]: cell({ roomCode: 'RM00010241', roomName: '和洋室' }) };

  assert.deepEqual(resolveAck('2026-10-09', keys, cells), [KEY]);
  assert.deepEqual(resolveAck('RM00010241', keys, cells), [other]);
  assert.deepEqual(resolveAck('特別室', keys, cells), [KEY]);
  assert.deepEqual(resolveAck('無此房型', keys, cells), []);
});

test('a closed cell is described from whatever is still known about it', () => {
  const known = cell();
  assert.equal(resolveCell(KEY, { [KEY]: known }), known);
  assert.equal(resolveCell(KEY, {}, { [KEY]: known }), known);

  // Nothing left anywhere: the key itself still names the room and the date.
  const fallback = resolveCell(KEY, {}, {});
  assert.equal(fallback.roomCode, 'RM00010235');
  assert.equal(fallback.salesDate, '2026-10-09');
});
