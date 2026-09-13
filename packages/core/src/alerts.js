/**
 * Edge-triggered notification bookkeeping.
 *
 * The hard part of a watcher is not matching, it is not spamming: whatever you
 * are waiting for stays in the interesting state across many polls once it gets
 * there. Notifications therefore fire on the *rising edge* (was not interesting
 * -> is interesting), with an optional cooldown for a repeat nudge while it
 * stays that way.
 *
 * This works on opaque keys, so every crawler can decide for itself what an
 * "interesting thing" is — a room/date pair, a shop item, a price bracket.
 */

/**
 * @param {Iterable<string>} keys the keys that are interesting right now
 * @param {Record<string, { lastNotifiedAt: string }>} [notified] previous bookkeeping
 * @param {{ cooldownMs?: number, now?: number }} [options]
 * @returns {{ fresh: string[], notified: Record<string, { lastNotifiedAt: string }> }}
 *   `fresh` are the keys to announce now; `notified` is the state to persist.
 */
export function selectFresh(keys, notified = {}, { cooldownMs = 0, now = Date.now() } = {}) {
  const fresh = [];
  const next = {};
  const stamp = new Date(now).toISOString();

  for (const key of keys) {
    const previous = notified[key];

    if (!previous) {
      // Rising edge: this key was not interesting last time round.
      fresh.push(key);
      next[key] = { lastNotifiedAt: stamp };
      continue;
    }

    const age = now - Date.parse(previous.lastNotifiedAt);
    if (cooldownMs > 0 && age >= cooldownMs) {
      fresh.push(key);
      next[key] = { lastNotifiedAt: stamp };
    } else {
      // Still interesting and still inside the cooldown: carry the timestamp
      // forward so the reminder clock keeps running from the original alert.
      next[key] = previous;
    }
  }

  // Keys absent from `next` have stopped being interesting; dropping them is
  // what lets a future re-appearance count as a fresh edge again.
  return { fresh, notified: next };
}
