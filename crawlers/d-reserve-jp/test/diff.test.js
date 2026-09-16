import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, listingShift, offSale } from '../src/diff.js';

/** One cell, shaped like api.js normalize() output. */
function cell(overrides = {}) {
  return {
    roomCode: 'RM00010235',
    roomName: '露天風呂付特別室',
    salesDate: '2026-10-09',
    dayOfWeek: 'FRIDAY',
    available: false,
    stockStatus: 'SOLD_OUT',
    stockNum: 0,
    noSaleReason: null,
    memberPrice: 110000,
    regularPrice: 110000,
    planCode: 'PL00028617',
    ...overrides,
  };
}

const KEY = 'RM00010235|2026-10-09';

test('first run seeds a baseline instead of reporting releases', () => {
  const events = diffSnapshots(null, { [KEY]: cell({ available: true }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'seed');
});

test('an unchanged snapshot produces nothing', () => {
  const before = { [KEY]: cell() };
  assert.deepEqual(diffSnapshots(before, { [KEY]: cell() }), []);
});

test('becoming bookable is an appear', () => {
  const events = diffSnapshots(
    { [KEY]: cell() },
    { [KEY]: cell({ available: true, stockStatus: 'FEW_STOCK', stockNum: 1 }) },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'appear');
  assert.equal(events[0].from.available, false);
  assert.equal(events[0].to.stockNum, 1);
});

test('being booked away is a disappear', () => {
  const events = diffSnapshots(
    { [KEY]: cell({ available: true, stockNum: 1 }) },
    { [KEY]: cell() },
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['disappear'],
  );
});

test('stock moving while still bookable is its own event', () => {
  const events = diffSnapshots(
    { [KEY]: cell({ available: true, stockNum: 2 }) },
    { [KEY]: cell({ available: true, stockNum: 1 }) },
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['stock'],
  );
});

test('a price move is reported alongside an appear', () => {
  const events = diffSnapshots(
    { [KEY]: cell() },
    { [KEY]: cell({ available: true, stockNum: 1, memberPrice: 118800, regularPrice: 118800 }) },
  );
  assert.deepEqual(events.map((e) => e.kind).sort(), ['appear', 'price']);
});

test('a new key after seeding is room_added, not seed', () => {
  const before = { [KEY]: cell() };
  const after = { [KEY]: cell(), 'RM00010241|2026-10-09': cell({ roomCode: 'RM00010241' }) };
  const events = diffSnapshots(before, after);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['room_added'],
  );
});

test('a vanished key is room_removed', () => {
  const events = diffSnapshots({ [KEY]: cell() }, {});
  assert.deepEqual(
    events.map((e) => e.kind),
    ['room_removed'],
  );
});

test('a null price on a past date does not crash or churn', () => {
  const expired = cell({
    memberPrice: null,
    regularPrice: null,
    planCode: null,
    stockStatus: 'NO_SALE',
  });
  assert.deepEqual(diffSnapshots({ [KEY]: expired }, { [KEY]: expired }), []);
});

// ── reading a price event that is really the listing closing ────────────────

test('a plan vanishing is a listing shift, not a price move', () => {
  const [event] = diffSnapshots(
    { [KEY]: cell() },
    { [KEY]: cell({ memberPrice: null, regularPrice: null, stockStatus: 'NO_SALE' }) },
  );
  assert.equal(event.kind, 'price', 'still stored as a price event');
  assert.equal(listingShift(event), 'off');
});

test('a plan coming back is the other direction', () => {
  const [event] = diffSnapshots(
    { [KEY]: cell({ memberPrice: null, regularPrice: null, stockStatus: 'NO_SALE' }) },
    { [KEY]: cell() },
  );
  assert.equal(listingShift(event), 'on');
});

test('a genuine price move is not a listing shift', () => {
  const [event] = diffSnapshots(
    { [KEY]: cell() },
    { [KEY]: cell({ memberPrice: 118800, regularPrice: 118800 }) },
  );
  assert.equal(listingShift(event), null);
});

test('only a price event can be a listing shift', () => {
  const [event] = diffSnapshots(
    { [KEY]: cell({ available: true, stockNum: 1 }) },
    { [KEY]: cell() },
  );
  assert.equal(event.kind, 'disappear');
  assert.equal(listingShift(event), null);
});

test('offSale needs both prices gone', () => {
  assert.equal(offSale(null), false);
  assert.equal(offSale({ memberPrice: null, regularPrice: null }), true);
  assert.equal(offSale({ memberPrice: null, regularPrice: 110000 }), false);
  // Older rows only ever carried memberPrice.
  assert.equal(offSale({ memberPrice: null }), true);
});
