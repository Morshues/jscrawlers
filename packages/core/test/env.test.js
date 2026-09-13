import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvReader } from '../src/env.js';

test('required names the variable to fix', () => {
  const read = createEnvReader({ A: '  ' });
  assert.throws(() => read.required('A'), /A is required/);
  assert.throws(() => read.required('MISSING'), /MISSING is required/);
});

test('blank and absent are the same thing: use the fallback', () => {
  const read = createEnvReader({ A: '', B: '   ', C: ' kept ' });
  assert.equal(read.optional('A', 'fallback'), 'fallback');
  assert.equal(read.optional('B', 'fallback'), 'fallback');
  assert.equal(read.optional('C'), 'kept');
  assert.equal(read.optional('MISSING'), '');
});

test('bool accepts the spellings people actually write', () => {
  const read = createEnvReader({ T: 'true', ONE: '1', YES: 'yes', F: 'false', JUNK: 'maybe' });
  assert.equal(read.bool('T'), true);
  assert.equal(read.bool('ONE'), true);
  assert.equal(read.bool('YES'), true);
  assert.equal(read.bool('F'), false);
  assert.equal(read.bool('JUNK'), false);
  assert.equal(read.bool('MISSING', true), true);
});

test('number rejects something that is not one', () => {
  const read = createEnvReader({ N: '42', BAD: 'lots' });
  assert.equal(read.number('N'), 42);
  assert.equal(read.number('MISSING', 7), 7);
  assert.throws(() => read.number('BAD'), /BAD must be a number, got "lots"/);
});

test('integer enforces whole numbers and the range', () => {
  const read = createEnvReader({ H: '20', FRACTION: '1.5', HIGH: '25' });
  assert.equal(read.integer('H', 20, { min: 0, max: 23 }), 20);
  assert.equal(read.integer('MISSING', 20, { min: 0, max: 23 }), 20);
  assert.throws(() => read.integer('FRACTION', 1), /an integer/);
  assert.throws(() => read.integer('HIGH', 20, { min: 0, max: 23 }), /integer 0-23/);
});

test('list trims, drops blanks and falls back when empty', () => {
  const read = createEnvReader({ L: ' a , b ,, c ', EMPTY: ' , ' });
  assert.deepEqual(read.list('L'), ['a', 'b', 'c']);
  assert.deepEqual(read.list('EMPTY'), []);
  assert.deepEqual(read.list('EMPTY', ['x']), ['x']);
  assert.deepEqual(read.list('MISSING'), []);
});

test('a mistyped timezone fails at startup, not at 20:00 three days later', () => {
  const read = createEnvReader({ TZ_OK: 'Asia/Taipei', TZ_BAD: 'Asia/Taipeh' });
  assert.equal(read.timeZone('TZ_OK', 'UTC'), 'Asia/Taipei');
  assert.equal(read.timeZone('MISSING', 'Asia/Tokyo'), 'Asia/Tokyo');
  assert.throws(() => read.timeZone('TZ_BAD', 'UTC'), /not a valid IANA time zone/);
});

test('duration understands 5m, 90s and raw milliseconds', () => {
  const read = createEnvReader({ D: '5m', S: '90s', MS: '1500', BAD: 'soon' });
  assert.equal(read.duration('D', '1m'), 300_000);
  assert.equal(read.duration('S', '1m'), 90_000);
  assert.equal(read.duration('MS', '1m'), 1500);
  assert.equal(read.duration('MISSING', '2h'), 7_200_000);
  assert.throws(() => read.duration('BAD', '1m'), /BAD must look like 5m/);
});
