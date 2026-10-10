import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, NotJsonError } from '@jscrawlers/core';
import { classifyError } from '../src/api.js';

function httpError(status, retryAfter) {
  const headers = new Headers(retryAfter ? { 'retry-after': retryAfter } : {});
  return new HttpError(new Response('x', { status, headers }), 'https://example.test/');
}

test('a rate limit is a block, and keeps its Retry-After', () => {
  const outcome = classifyError(httpError(429, '120'));
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.status, 429);
  assert.equal(outcome.retryAfterMs, 120_000);
});

test('a 403 is a block even after describeHttpError wrapped it', () => {
  const wrapped = new Error('HTTP 403 — denied', { cause: httpError(403) });
  assert.deepEqual(
    { blocked: classifyError(wrapped).blocked, status: classifyError(wrapped).status },
    { blocked: true, status: 403 },
  );
});

test('an HTML page in place of JSON is a block; a network error is not', () => {
  assert.equal(classifyError(new NotJsonError('<html>', 'u', 'text/html')).blocked, true);
  assert.equal(
    classifyError(new HttpError(new Response('x', { status: 404 }), 'u')).blocked,
    false,
  );
  assert.equal(classifyError(new TypeError('fetch failed')).blocked, false);
});
