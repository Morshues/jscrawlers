/**
 * Edge-triggered notification bookkeeping.
 *
 * The hard part of a watcher is not matching, it is not spamming: whatever you
 * are waiting for stays in the interesting state across many polls once it gets
 * there. Notifications therefore fire on the *rising edge* (was not interesting
 * -> is interesting), with an optional cooldown for a repeat nudge while it
 * stays that way.
 *
 * A nagging watcher also needs a way to be told "enough": `acked` keys keep
 * being tracked but are never announced again, until they stop being
 * interesting and come back, which is a fresh edge like any other.
 *
 * This works on opaque keys, so every crawler can decide for itself what an
 * "interesting thing" is — a room/date pair, a shop item, a price bracket.
 */

/**
 * @param {Iterable<string>} keys the keys that are interesting right now
 * @param {Record<string, { lastNotifiedAt: string, ackedAt?: string }>} [notified]
 *   previous bookkeeping
 * @param {{ cooldownMs?: number, now?: number, acked?: Iterable<string> }} [options]
 * @returns {{ fresh: string[], closed: string[], notified: object }}
 *   `fresh` are the keys to announce now, `closed` the ones that have just
 *   stopped being interesting, and `notified` is the state to persist.
 */
export function selectFresh(
  keys,
  notified = {},
  { cooldownMs = 0, now = Date.now(), acked = [] } = {},
) {
  const silenced = new Set(acked);
  const fresh = [];
  const next = {};
  const stamp = new Date(now).toISOString();

  for (const key of keys) {
    const previous = notified[key];

    if (!previous) {
      // Rising edge: this key was not interesting last time round. An ack for
      // something nobody has been told about yet would silence an announcement
      // that never happened, so the edge wins.
      fresh.push(key);
      next[key] = { lastNotifiedAt: stamp };
      continue;
    }

    if (previous.ackedAt || silenced.has(key)) {
      // Told to stop. Still interesting, so still tracked — just quiet.
      next[key] = { ...previous, ackedAt: previous.ackedAt ?? stamp };
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

  // Keys absent from `next` have stopped being interesting. Handing them back
  // lets a caller say so out loud; dropping them from the bookkeeping (ack and
  // all) is what lets a future re-appearance count as a fresh edge again.
  const closed = Object.keys(notified).filter((key) => !next[key]);
  return { fresh, closed, notified: next };
}
