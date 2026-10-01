import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCells, selectBookingTarget } from '../src/policy.js';

const POLICY = {
  dates: new Set(['2026-10-09', '2026-10-20']),
  roomCodes: new Set(),
  maxPrice: 120000,
  maxAttempts: 3,
};

function cell(overrides = {}) {
  return {
    roomCode: 'RM00010235',
    salesDate: '2026-10-09',
    planCode: 'PL00028617',
    memberPrice: 110000,
    roomName: '露天風呂付特別室',
    ...overrides,
  };
}

test('sanitizeCells drops malformed cells and anything beyond the known fields', () => {
  const cells = sanitizeCells([
    cell({ extra: 'x' }),
    cell({ roomCode: '../../etc' }),
    cell({ planCode: null }),
    cell({ salesDate: '2026-1-9' }),
    cell({ memberPrice: '1000' }),
    null,
  ]);
  assert.deepEqual(cells, [
    {
      roomCode: 'RM00010235',
      salesDate: '2026-10-09',
      planCode: 'PL00028617',
      memberPrice: 110000,
      roomName: '露天風呂付特別室',
    },
  ]);
  assert.deepEqual(sanitizeCells('nope'), []);
});

test('the policy, not the request, decides: dates, rooms and price cap', () => {
  const outside = cell({ salesDate: '2026-10-10' });
  const pricey = cell({ memberPrice: 130000 });
  assert.deepEqual(selectBookingTarget([outside, pricey], {}, POLICY), {
    target: null,
    reason: 'no-eligible-cell',
  });

  const onlyRoom = { ...POLICY, roomCodes: new Set(['RM00010236']) };
  assert.equal(selectBookingTarget([cell()], {}, onlyRoom).target, null);
});

test('earliest date first, then the cheapest; spent cells are skipped', () => {
  const late = cell({ salesDate: '2026-10-20', memberPrice: 90000 });
  const dear = cell({ roomCode: 'RM00010236', memberPrice: 115000 });
  const cheap = cell({ roomCode: 'RM00010237', memberPrice: 100000 });

  assert.equal(selectBookingTarget([late, dear, cheap], {}, POLICY).target, cheap);
  assert.equal(
    selectBookingTarget([late, dear, cheap], { attempts: { 'RM00010237|2026-10-09': 3 } }, POLICY)
      .target,
    dear,
  );
});

test('a lock refuses everything', () => {
  assert.deepEqual(selectBookingTarget([cell()], { locked: true }, POLICY), {
    target: null,
    reason: 'locked',
  });
});
