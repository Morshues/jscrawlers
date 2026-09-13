import test from 'node:test';
import assert from 'node:assert/strict';
import { diffItems } from '../src/diff.js';

const TS = '2026-09-13T10:00:00.000Z';

function item(sn, overrides = {}) {
  return {
    sn,
    title: `商品 ${sn}`,
    url: `https://buy.gamer.com.tw/atmItem.php?sn=${sn}`,
    buyable: false,
    status: '本商品已額滿或售完',
    price: 2950,
    publishDate: '2026-10-29',
    ...overrides,
  };
}

const kinds = (events) => events.map((event) => event.kind);

test('a product is seeded the first time it is seen, not on the first run', () => {
  const events = diffItems(
    { 42810: item('42810') },
    { 42810: item('42810'), 41435: item('41435') },
    {
      ts: TS,
      watching: new Set(['42810', '41435']),
    },
  );

  assert.deepEqual(kinds(events), ['seed']);
  assert.equal(events[0].sn, '41435');
});

test('becoming orderable, and selling out again', () => {
  const soldOut = { 42810: item('42810') };
  const open = { 42810: item('42810', { buyable: true, status: '熱烈預購中' }) };

  assert.deepEqual(kinds(diffItems(soldOut, open, { ts: TS })), ['available']);
  assert.deepEqual(kinds(diffItems(open, soldOut, { ts: TS })), ['sold_out']);
});

test('a price move and a release-date slip are recorded separately', () => {
  const events = diffItems(
    { 42810: item('42810') },
    { 42810: item('42810', { price: 2790, publishDate: '2026-11-05' }) },
    { ts: TS },
  );

  assert.deepEqual(kinds(events), ['price', 'publish_date']);
  assert.equal(events[0].from.price, 2950);
  assert.equal(events[0].to.price, 2790);
});

test('a status change alone is recorded while bookability holds steady', () => {
  const events = diffItems(
    { 40346: item('40346', { buyable: true, status: '熱烈預購中' }) },
    { 40346: item('40346', { buyable: true, status: '已發售' }) },
    { ts: TS },
  );

  assert.deepEqual(kinds(events), ['status']);
});

// A timeout must not look like a disappearance: inventing an event here would
// either fire a false alert or reset the state that suppresses duplicate ones.
test('a product missing because its fetch failed produces no event', () => {
  const events = diffItems({ 42810: item('42810') }, {}, { ts: TS, watching: new Set(['42810']) });
  assert.deepEqual(events, []);
});

test('a product dropped from the watch list is recorded as removed', () => {
  const events = diffItems({ 42810: item('42810') }, {}, { ts: TS, watching: new Set() });
  assert.deepEqual(kinds(events), ['removed']);
});
