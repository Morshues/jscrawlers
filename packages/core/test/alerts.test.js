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

// ── being told to stop ───────────────────────────────────────────────────────

test('an acked key stays tracked but is never announced again', () => {
  const notified = { a: { lastNotifiedAt: new Date(NOW - 60 * 60_000).toISOString() } };
  const options = { now: NOW, cooldownMs: 10 * 60_000 };

  const acked = selectFresh(['a'], notified, { ...options, acked: ['a'] });
  assert.deepEqual(acked.fresh, [], 'the reminder that was due is silenced');
  assert.ok(acked.notified.a.ackedAt, 'still tracked, just quiet');

  // Long past the cooldown, and still quiet on every later poll.
  const later = selectFresh(['a'], acked.notified, { ...options, now: NOW + 86_400_000 });
  assert.deepEqual(later.fresh, []);
  assert.equal(later.notified.a.ackedAt, acked.notified.a.ackedAt);
});

test('an ack does not outlive the thing it silenced', () => {
  const acked = selectFresh(
    ['a'],
    { a: { lastNotifiedAt: new Date(NOW).toISOString() } },
    {
      now: NOW,
      acked: ['a'],
    },
  );

  const gone = selectFresh([], acked.notified, { now: NOW + 60_000 });
  assert.deepEqual(gone.closed, ['a']);
  assert.deepEqual(gone.notified, {});

  const back = selectFresh(['a'], gone.notified, { now: NOW + 120_000 });
  assert.deepEqual(back.fresh, ['a'], 'a reopening is a fresh edge, ack and all');
  assert.equal(back.notified.a.ackedAt, undefined);
});

test('acking something nobody has been told about does not swallow the edge', () => {
  const result = selectFresh(['a'], {}, { now: NOW, acked: ['a'] });
  assert.deepEqual(result.fresh, ['a']);
});

test('closed keys are reported once, then forgotten', () => {
  const notified = {
    a: { lastNotifiedAt: new Date(NOW).toISOString() },
    b: { lastNotifiedAt: new Date(NOW).toISOString() },
  };
  const first = selectFresh(['a'], notified, { now: NOW + 60_000 });
  assert.deepEqual(first.closed, ['b']);

  const second = selectFresh(['a'], first.notified, { now: NOW + 120_000 });
  assert.deepEqual(second.closed, []);
});
