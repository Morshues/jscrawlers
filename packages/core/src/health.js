/**
 * Failure bookkeeping for a watcher that runs unattended.
 *
 * A failed poll is only ever logged, and a log nobody reads is how a watcher
 * goes blind for a day without anyone noticing. This decides when a run of
 * failures is worth telling someone about, when to say it is over, and how long
 * to back off so a site that has started refusing us is not hammered into a
 * proper block.
 *
 * Like `selectFresh`, it is a pure function over state the caller persists, so
 * it works the same for a resident loop and for one process per poll.
 *
 * @typedef {{
 *   consecutiveFailures: number,
 *   firstFailureAt: string,
 *   lastFailureAt: string,
 *   lastError: string,
 *   blocked: boolean,
 *   alertedAt?: string,
 *   backoffUntil?: string,
 * }} Health
 */

/**
 * @param {Partial<Health> | null | undefined} previous the health persisted last time
 * @param {{ ok: true } | { ok: false, error: string, blocked?: boolean, retryAfterMs?: number }} outcome
 * @param {{
 *   now?: number,
 *   alertAfter?: number,
 *   repeatMs?: number,
 *   backoffBaseMs?: number,
 *   backoffMaxMs?: number,
 * }} [options]
 * @returns {{ health: Health | null, alert: 'down' | 'still-down' | 'recovered' | null }}
 *   `health` is what to persist (null once healthy again).
 */
export function trackHealth(
  previous,
  outcome,
  {
    now = Date.now(),
    alertAfter = 3,
    repeatMs = 3_600_000,
    backoffBaseMs = 0,
    backoffMaxMs = 1_800_000,
  } = {},
) {
  const prev = previous?.consecutiveFailures ? previous : null;

  if (outcome.ok) {
    // Only an outage someone was told about earns an all-clear; a single blip
    // that healed on its own was never news.
    return { health: null, alert: prev?.alertedAt ? 'recovered' : null };
  }

  const stamp = new Date(now).toISOString();
  const failures = (prev?.consecutiveFailures ?? 0) + 1;
  const blocked = Boolean(outcome.blocked);

  // Exponential from the first failure, so a short blip costs one interval and
  // a sustained refusal backs off to the cap. A Retry-After from the server
  // wins when it asks for longer.
  const exponential = backoffBaseMs > 0 ? backoffBaseMs * 2 ** (failures - 1) : 0;
  const delay = Math.min(Math.max(exponential, outcome.retryAfterMs ?? 0), backoffMaxMs);

  const health = {
    consecutiveFailures: failures,
    firstFailureAt: prev?.firstFailureAt ?? stamp,
    lastFailureAt: stamp,
    lastError: outcome.error,
    blocked,
    ...(prev?.alertedAt ? { alertedAt: prev.alertedAt } : {}),
    ...(delay > 0 ? { backoffUntil: new Date(now + delay).toISOString() } : {}),
  };

  let alert = null;
  if (!prev?.alertedAt) {
    // Being refused is news on its own: waiting for N more refusals only digs
    // the hole deeper while nobody looks.
    if (blocked || failures >= alertAfter) alert = 'down';
  } else if (now - Date.parse(prev.alertedAt) >= repeatMs) {
    alert = 'still-down';
  }
  if (alert) health.alertedAt = stamp;

  return { health, alert };
}

/**
 * Should this poll be skipped because an earlier failure asked for a pause?
 *
 * @param {Partial<Health> | null | undefined} health
 * @returns {number} ms left to wait, 0 when it is fine to go
 */
export function backoffRemaining(health, now = Date.now()) {
  if (!health?.backoffUntil) return 0;
  return Math.max(0, Date.parse(health.backoffUntil) - now);
}
