import test from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, verifyRequest, createReplayGuard } from '../src/sign.js';

const SECRET = 'a-secret-that-is-long-enough-for-tests';
const NOW = Date.parse('2026-10-01T10:00:00Z');
const BODY = JSON.stringify({ hello: 'world' });

test('a signed body verifies', () => {
  const headers = signRequest(SECRET, BODY, NOW);
  assert.equal(verifyRequest(SECRET, headers, BODY, { now: NOW + 5_000 }).ok, true);
});

test('a changed body, a wrong secret or missing headers do not verify', () => {
  const headers = signRequest(SECRET, BODY, NOW);
  assert.equal(verifyRequest(SECRET, headers, BODY + ' ', { now: NOW }).reason, 'bad-signature');
  assert.equal(verifyRequest('other-secret', headers, BODY, { now: NOW }).reason, 'bad-signature');
  assert.equal(verifyRequest(SECRET, {}, BODY, { now: NOW }).reason, 'unsigned');
  assert.equal(
    verifyRequest(SECRET, { ...headers, 'x-signed-signature': 'zz' }, BODY, { now: NOW }).reason,
    'bad-signature',
  );
});

test('a timestamp outside the window is stale, even when correctly signed', () => {
  const headers = signRequest(SECRET, BODY, NOW);
  assert.equal(verifyRequest(SECRET, headers, BODY, { now: NOW + 61_000 }).reason, 'stale');
  assert.equal(verifyRequest(SECRET, headers, BODY, { now: NOW - 61_000 }).reason, 'stale');
});

test('the replay guard accepts a signature once and forgets it after the ttl', () => {
  const firstSeen = createReplayGuard({ ttlMs: 1_000 });
  assert.equal(firstSeen('abc', NOW), true);
  assert.equal(firstSeen('abc', NOW + 500), false);
  assert.equal(firstSeen('abc', NOW + 2_000), true);
});
