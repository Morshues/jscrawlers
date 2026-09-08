import test from 'node:test';
import assert from 'node:assert/strict';
import { jitter, sleep, withConcurrency } from '../src/time.js';

test('jitter stays within the configured ratio', () => {
  for (let i = 0; i < 100; i++) {
    const value = jitter(1000, 0.3);
    assert.ok(value >= 700 && value <= 1300, `out of range: ${value}`);
  }
});

test('sleep waits at least the requested time', async () => {
  const start = Date.now();
  await sleep(20);
  assert.ok(Date.now() - start >= 18);
});

test('withConcurrency keeps input order and caps parallelism', async () => {
  let inFlight = 0;
  let peak = 0;

  const results = await withConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await sleep(5);
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2, `peak concurrency was ${peak}`);
});
