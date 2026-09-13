/**
 * Turn two consecutive snapshots into a list of change events.
 *
 * Only changes are recorded, so the history stays small enough to keep forever
 * and interesting enough to read: how long a product stayed sold out, whether
 * the price moved, when the release date slipped.
 */

/** `seed` marks a product's baseline, not a real change. */
export const EVENT_KINDS = [
  'seed',
  'available',
  'sold_out',
  'price',
  'status',
  'publish_date',
  'removed',
];

function snapshotOf(item) {
  return {
    buyable: item.buyable,
    status: item.status,
    price: item.price,
    publishDate: item.publishDate,
  };
}

function identity(item) {
  return { sn: item.sn, title: item.title, url: item.url };
}

/**
 * Compare the stored products against the ones just fetched.
 *
 * `current` holds only what was fetched and parsed successfully this round. A
 * product missing from it is a failed poll, not a disappearance, so it is left
 * untouched — inventing a change out of a timeout would either fire a false
 * alert or, worse, reset the state that suppresses duplicate ones. A product is
 * only `removed` once it is gone from the watch list itself.
 *
 * @param {Record<string, object>|null} previous stored items, keyed by sn
 * @param {Record<string, object>} current freshly parsed items, keyed by sn
 * @param {{ ts?: string, watching?: Set<string> }} [options]
 * @returns {object[]} events, ready to append as JSONL
 */
export function diffItems(previous, current, { ts = new Date().toISOString(), watching } = {}) {
  const before = previous ?? {};
  const events = [];

  for (const [sn, item] of Object.entries(current)) {
    const old = before[sn];

    // Seeding is per product, not per run: adding a product to the watch list
    // months later must not read as "it just came back in stock".
    if (!old) {
      events.push({ ts, kind: 'seed', ...identity(item), to: snapshotOf(item) });
      continue;
    }

    const from = snapshotOf(old);
    const to = snapshotOf(item);

    if (old.buyable !== item.buyable) {
      events.push({
        ts,
        kind: item.buyable ? 'available' : 'sold_out',
        ...identity(item),
        from,
        to,
      });
    } else if (old.status !== item.status) {
      // Only interesting while bookability itself held steady, e.g. 熱烈預購中 -> 已發售.
      events.push({ ts, kind: 'status', ...identity(item), from, to });
    }

    if (old.price !== item.price) {
      events.push({ ts, kind: 'price', ...identity(item), from, to });
    }
    if (old.publishDate !== item.publishDate) {
      events.push({ ts, kind: 'publish_date', ...identity(item), from, to });
    }
  }

  for (const [sn, old] of Object.entries(before)) {
    if (current[sn]) continue;
    if (!watching || watching.has(sn)) continue; // fetch failed, not removed
    events.push({ ts, kind: 'removed', ...identity(old), from: snapshotOf(old) });
  }

  return events;
}
