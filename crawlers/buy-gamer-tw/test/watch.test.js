import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { selectAlerts, buildPayload, buildPayloads } from '../src/watch.js';

const NOW = Date.parse('2026-09-13T10:00:00Z');

function item(sn, buyable, overrides = {}) {
  return {
    sn,
    url: `https://buy.gamer.com.tw/atmItem.php?sn=${sn}`,
    title: `商品 ${sn}`,
    platform: 'NS2',
    status: buyable ? '熱烈預購中' : '本商品已額滿或售完',
    buyable,
    buyAction: buyable ? 'buy' : 'restock-notify',
    price: 2950,
    priceText: 'NT 2950 元',
    publishDate: '2026-10-29',
    ...overrides,
  };
}

function config(env = {}) {
  return loadConfig({ BUYGAMER_ITEMS: '42810', ...env });
}

test('a product seen for the first time is recorded but not announced', () => {
  const result = selectAlerts([item('42810', true)], {}, config(), {}, { now: NOW });

  assert.deepEqual(result.fresh, []);
  assert.equal(result.seeded.length, 1);
  // Recorded anyway, so the next poll does not read it as a fresh edge.
  assert.ok(result.notified['42810']);
});

test('BUYGAMER_NOTIFY_ON_FIRST_RUN opts into that first announcement', () => {
  const result = selectAlerts(
    [item('42810', true)],
    {},
    config({ BUYGAMER_NOTIFY_ON_FIRST_RUN: 'true' }),
    {},
    { now: NOW },
  );

  assert.equal(result.fresh.length, 1);
});

test('sold out -> orderable is the edge that notifies', () => {
  const previous = { 42810: item('42810', false) };
  const result = selectAlerts([item('42810', true)], previous, config(), {}, { now: NOW });

  assert.deepEqual(
    result.fresh.map((entry) => entry.sn),
    ['42810'],
  );
});

test('staying orderable does not notify again', () => {
  const previous = { 42810: item('42810', true) };
  const notified = { 42810: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() } };
  const result = selectAlerts([item('42810', true)], previous, config(), notified, { now: NOW });

  assert.deepEqual(result.fresh, []);
  // The original alert time is kept, so a cooldown counts from then, not now.
  assert.equal(result.notified['42810'].lastNotifiedAt, notified['42810'].lastNotifiedAt);
});

test('a cooldown re-nudges once it has elapsed', () => {
  const previous = { 42810: item('42810', true) };
  const notified = { 42810: { lastNotifiedAt: new Date(NOW - 31 * 60_000).toISOString() } };
  const withCooldown = config({ BUYGAMER_NOTIFY_COOLDOWN_MIN: '30' });

  assert.equal(
    selectAlerts([item('42810', true)], previous, withCooldown, notified, { now: NOW }).fresh
      .length,
    1,
  );
  // 29 minutes in, the same state is still inside the cooldown.
  assert.equal(
    selectAlerts(
      [item('42810', true)],
      previous,
      withCooldown,
      { 42810: { lastNotifiedAt: new Date(NOW - 29 * 60_000).toISOString() } },
      { now: NOW },
    ).fresh.length,
    0,
  );
});

test('selling out drops the bookkeeping so a later restock is a fresh edge', () => {
  const previous = { 42810: item('42810', true) };
  const notified = { 42810: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() } };

  const soldOut = selectAlerts([item('42810', false)], previous, config(), notified, { now: NOW });
  assert.deepEqual(soldOut.notified, {});

  const back = selectAlerts(
    [item('42810', true)],
    { 42810: item('42810', false) },
    config(),
    soldOut.notified,
    { now: NOW + 60_000 },
  );
  assert.equal(back.fresh.length, 1);
});

test('the payload says what it is, what it costs and where to order it', () => {
  const payload = buildPayload([item('42810', true)], config(), {
    detectedAt: '2026-09-13T10:00:00.000Z',
  });

  assert.equal(payload.source, 'buy-gamer-tw');
  assert.equal(payload.event, 'availability');
  assert.equal(payload.title, '可以下單了：商品 42810');
  assert.match(payload.text, /NT 2,950 元/);
  assert.match(payload.text, /熱烈預購中/);
  assert.match(payload.text, /發售 2026-10-29/);
  assert.match(payload.text, /atmItem\.php\?sn=42810/);
  assert.deepEqual(payload.matches[0].sn, '42810');
});

test('grouping is one message for everything, or one each', () => {
  const items = [item('42810', true), item('41435', true)];

  const grouped = buildPayloads(items, config());
  assert.equal(grouped.length, 1);
  assert.match(grouped[0].title, /另 1 筆/);

  const separate = buildPayloads(items, config({ BUYGAMER_NOTIFY_GROUPED: 'false' }));
  assert.equal(separate.length, 2);
  assert.doesNotMatch(separate[0].title, /另/);
});

test('nothing to announce is no payload at all', () => {
  assert.deepEqual(buildPayloads([], config()), []);
});
