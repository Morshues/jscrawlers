/**
 * Turn two consecutive snapshots into a list of change events.
 *
 * Only changes are recorded. A poll of ~940 cells every 5 minutes would be
 * ~270k rows a day if stored whole; in practice almost every poll produces zero
 * events, which is what makes the history worth analysing later.
 */

/** `seed` marks a baseline, not a real change — reports must exclude it. */
export const EVENT_KINDS = [
  'seed',
  'appear',
  'disappear',
  'stock',
  'price',
  'room_added',
  'room_removed',
];

function snapshotOf(cell) {
  return {
    available: cell.available,
    stockStatus: cell.stockStatus,
    stockNum: cell.stockNum,
    memberPrice: cell.memberPrice,
    regularPrice: cell.regularPrice,
  };
}

function identity(cell) {
  return {
    roomCode: cell.roomCode,
    roomName: cell.roomName,
    salesDate: cell.salesDate,
    dayOfWeek: cell.dayOfWeek,
  };
}

/**
 * Compare the previous cells against the current ones.
 *
 * A cell can emit more than one event per poll — a room that becomes bookable
 * at a new price yields both `appear` and `price` — so downstream code should
 * filter by `kind` rather than assume one event per cell.
 *
 * @param {object|null} previous previous cells map, or null/empty on first run
 * @param {object} current current cells map
 * @param {{ ts?: string }} [options]
 * @returns {object[]} events, ready to append as JSONL
 */
export function diffSnapshots(previous, current, { ts = new Date().toISOString() } = {}) {
  const before = previous ?? {};
  const events = [];
  const seeding = Object.keys(before).length === 0;

  for (const [key, cell] of Object.entries(current)) {
    const old = before[key];

    if (!old) {
      // First ever run seeds a baseline; a later unseen key is a genuinely new
      // room/date, which is still not a release we can attribute a time to.
      events.push({
        ts,
        kind: seeding ? 'seed' : 'room_added',
        ...identity(cell),
        to: snapshotOf(cell),
      });
      continue;
    }

    if (old.available !== cell.available) {
      events.push({
        ts,
        kind: cell.available ? 'appear' : 'disappear',
        ...identity(cell),
        from: snapshotOf(old),
        to: snapshotOf(cell),
      });
    } else if (old.stockNum !== cell.stockNum) {
      // Only interesting while the status itself held steady.
      events.push({
        ts,
        kind: 'stock',
        ...identity(cell),
        from: snapshotOf(old),
        to: snapshotOf(cell),
      });
    }

    if (old.memberPrice !== cell.memberPrice || old.regularPrice !== cell.regularPrice) {
      events.push({
        ts,
        kind: 'price',
        ...identity(cell),
        from: snapshotOf(old),
        to: snapshotOf(cell),
      });
    }
  }

  for (const [key, old] of Object.entries(before)) {
    if (current[key]) continue;
    events.push({ ts, kind: 'room_removed', ...identity(old), from: snapshotOf(old) });
  }

  return events;
}

/** No plan on offer: the cell cannot be booked at all, its price is not merely unknown. */
export function offSale(snapshot) {
  return Boolean(snapshot) && snapshot.memberPrice == null && snapshot.regularPrice == null;
}

/**
 * A `price` event that is really the listing closing or reopening.
 *
 * The API drops `lowestPlanForMember`/`lowestPlanForRegular` once a date stops
 * being sellable, so a diff of two snapshots can only see ¥63,800 -> null and
 * calls it a price change. Readers that care about the difference ask here.
 *
 * @returns {'off'|'on'|null} 'off' when the plan vanished, 'on' when it came
 *   back, null for a genuine price move.
 */
export function listingShift(event) {
  if (event.kind !== 'price') return null;
  if (offSale(event.to) && !offSale(event.from)) return 'off';
  if (offSale(event.from) && !offSale(event.to)) return 'on';
  return null;
}
