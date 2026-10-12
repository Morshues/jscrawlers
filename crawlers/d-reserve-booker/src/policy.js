/**
 * What the booker agrees to book.
 *
 * Requests come from a watcher this machine does not trust with secrets, so
 * nothing in them is taken as permission. A cell is only booked when this
 * machine's own policy — dates, room codes, price cap, attempt limit —
 * allows it. The worst a forged-but-validly-signed request can do is ask for a
 * booking the policy already approved.
 */

const CODE_RE = /^[A-Z]{2}\d{4,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CELLS = 200;

export function cellKey(cell) {
  return `${cell.roomCode}|${cell.salesDate}`;
}

/**
 * Keep only well-formed cells, copying just the fields the booker uses, so a
 * request cannot smuggle anything else into a URL or a log line.
 *
 * @returns {{ roomCode: string, salesDate: string, planCode: string, memberPrice: number }[]}
 */
export function sanitizeCells(cells) {
  if (!Array.isArray(cells)) return [];
  return cells
    .slice(0, MAX_CELLS)
    .filter(
      (cell) =>
        cell &&
        CODE_RE.test(cell.roomCode) &&
        CODE_RE.test(cell.planCode) &&
        DATE_RE.test(cell.salesDate) &&
        Number.isFinite(cell.memberPrice),
    )
    .map(({ roomCode, salesDate, planCode, memberPrice, roomName }) => ({
      roomCode,
      salesDate,
      planCode,
      memberPrice,
      roomName: typeof roomName === 'string' ? roomName.slice(0, 80) : roomCode,
    }));
}

/**
 * The one cell to book now, or why not.
 *
 * Earliest date wins, then the cheapest. A submitted booking does not stop the
 * next one: submitting is not buying, and the next chance must not wait.
 *
 * @param {object[]} cells already sanitized
 * @param {{ attempts?: Record<string, number> }} state
 * @param {{ dates: Set<string>, roomCodes: Set<string>, maxPrice: number, maxAttempts: number }} policy
 * @returns {{ target: object } | { target: null, reason: 'no-eligible-cell' }}
 */
export function selectBookingTarget(cells, state = {}, policy) {
  const candidates = cells.filter(
    (cell) =>
      policy.dates.has(cell.salesDate) &&
      (policy.roomCodes.size === 0 || policy.roomCodes.has(cell.roomCode)) &&
      cell.memberPrice <= policy.maxPrice &&
      (state.attempts?.[cellKey(cell)] ?? 0) < policy.maxAttempts,
  );
  candidates.sort(
    (a, b) => a.salesDate.localeCompare(b.salesDate) || a.memberPrice - b.memberPrice,
  );
  return candidates.length > 0
    ? { target: candidates[0] }
    : { target: null, reason: 'no-eligible-cell' };
}
