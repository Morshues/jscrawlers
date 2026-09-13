import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFresh } from '../src/alerts.js';

const NOW = Date.parse('2026-09-13T10:00:00Z');

test('a key that was not interesting last time is a rising edge', () => {
  const result = selectFresh(['a', 'b'], {}, { now: NOW });

  assert.deepEqual(result.fresh, ['a', 'b']);
  assert.equal(result.notified.a.lastNotifiedAt, new Date(NOW).toISOString());
});

test('a key that stays interesting does not fire again', () => {
  const notified = { a: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() } };
  const result = selectFresh(['a'], notified, { now: NOW });

  assert.deepEqual(result.fresh, []);
  // The original timestamp is carried forward so a cooldown runs from then.
  assert.equal(result.notified.a.lastNotifiedAt, notified.a.lastNotifiedAt);
});

test('a cooldown re-fires once it has elapsed, and not before', () => {
  const stale = { a: { lastNotifiedAt: new Date(NOW - 31 * 60_000).toISOString() } };
  const recent = { a: { lastNotifiedAt: new Date(NOW - 29 * 60_000).toISOString() } };
  const options = { now: NOW, cooldownMs: 30 * 60_000 };

  assert.deepEqual(selectFresh(['a'], stale, options).fresh, ['a']);
  assert.deepEqual(selectFresh(['a'], recent, options).fresh, []);
});

test('a cooldown of 0 means announce each opening exactly once', () => {
  const ancient = { a: { lastNotifiedAt: new Date(NOW - 30 * 86_400_000).toISOString() } };
  assert.deepEqual(selectFresh(['a'], ancient, { now: NOW }).fresh, []);
});

test('a key that stops being interesting is forgotten, so it can fire again', () => {
  const notified = { a: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() } };

  const gone = selectFresh([], notified, { now: NOW });
  assert.deepEqual(gone.notified, {});

  const back = selectFresh(['a'], gone.notified, { now: NOW + 60_000 });
  assert.deepEqual(back.fresh, ['a']);
});

test('unrelated keys are left alone', () => {
  const notified = {
    a: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() },
    b: { lastNotifiedAt: new Date(NOW - 60_000).toISOString() },
  };
  const result = selectFresh(['a'], notified, { now: NOW });

  assert.deepEqual(Object.keys(result.notified), ['a']);
});
