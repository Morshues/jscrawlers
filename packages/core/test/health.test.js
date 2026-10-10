import test from 'node:test';
import assert from 'node:assert/strict';
import { trackHealth, backoffRemaining } from '../src/health.js';

const NOW = Date.parse('2026-10-10T10:00:00Z');
const MIN = 60_000;
const fail = (extra = {}) => ({ ok: false, error: 'boom', ...extra });

/** Feed a sequence of outcomes one minute apart, returning every step. */
function run(outcomes, options = {}) {
  let health = null;
  return outcomes.map((outcome, index) => {
    const step = trackHealth(health, outcome, { now: NOW + index * MIN, ...options });
    health = step.health;
    return step;
  });
}

test('success with no history stays quiet and clean', () => {
  assert.deepEqual(trackHealth(null, { ok: true }, { now: NOW }), { health: null, alert: null });
});

test('alerts once the failures reach the threshold, not before', () => {
  const steps = run([fail(), fail(), fail(), fail()], { alertAfter: 3 });
  assert.deepEqual(
    steps.map((step) => step.alert),
    [null, null, 'down', null],
  );
  assert.equal(steps[3].health.consecutiveFailures, 4);
  assert.equal(steps[3].health.firstFailureAt, new Date(NOW).toISOString());
  assert.equal(steps[3].health.alertedAt, new Date(NOW + 2 * MIN).toISOString());
});

test('a blocked response alerts on the first failure', () => {
  const [step] = run([fail({ blocked: true })], { alertAfter: 3 });
  assert.equal(step.alert, 'down');
  assert.equal(step.health.blocked, true);
});

test('a sustained outage reminds again after repeatMs', () => {
  const steps = run([fail(), fail(), fail(), fail()], { alertAfter: 1, repeatMs: 2 * MIN });
  assert.deepEqual(
    steps.map((step) => step.alert),
    ['down', null, 'still-down', null],
  );
});

test('recovery is announced only when the outage was', () => {
  const quiet = run([fail(), { ok: true }], { alertAfter: 3 });
  assert.equal(quiet[1].alert, null);

  const loud = run([fail(), fail(), { ok: true }], { alertAfter: 2 });
  assert.equal(loud[2].alert, 'recovered');
  assert.equal(loud[2].health, null);
});

test('backoff doubles per failure, is capped, and is off by default', () => {
  const off = run([fail(), fail()]);
  assert.equal(off[1].health.backoffUntil, undefined);

  const steps = run([fail(), fail(), fail(), fail()], {
    backoffBaseMs: MIN,
    backoffMaxMs: 5 * MIN,
  });
  const delays = steps.map(
    (step, index) => Date.parse(step.health.backoffUntil) - (NOW + index * MIN),
  );
  assert.deepEqual(delays, [MIN, 2 * MIN, 4 * MIN, 5 * MIN]);
});

test('Retry-After wins when it asks for longer, still under the cap', () => {
  const [step] = run([fail({ retryAfterMs: 3 * MIN })], { backoffBaseMs: MIN });
  assert.equal(backoffRemaining(step.health, NOW), 3 * MIN);

  const [capped] = run([fail({ retryAfterMs: 99 * MIN })], { backoffMaxMs: 10 * MIN });
  assert.equal(backoffRemaining(capped.health, NOW), 10 * MIN);
});

test('backoffRemaining is 0 once the pause is over or when there is none', () => {
  assert.equal(backoffRemaining(null, NOW), 0);
  assert.equal(backoffRemaining({ backoffUntil: new Date(NOW - 1).toISOString() }, NOW), 0);
});
