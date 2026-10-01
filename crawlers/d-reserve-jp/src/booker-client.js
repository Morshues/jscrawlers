import { signRequest } from '@jscrawlers/core';

/**
 * Hand open rooms to the booker (crawlers/d-reserve-booker) on its own machine.
 *
 * Only what the calendar already showed is sent — room, date, plan, price — and
 * only a decision comes back: whether the booker took one of them on. How the
 * booking went, and the payment link, go from the booker straight to the person
 * paying; this process never sees them.
 *
 * Never throws: an unreachable booker must not cost the alert.
 *
 * @returns {Promise<{ accepted: boolean, target?: { roomCode: string, salesDate: string },
 *   submit?: boolean, reason?: string }>}
 */
export async function requestBooking(config, cells, { logger, signal } = {}) {
  const { url, secret, timeoutMs } = config.booker;
  const body = JSON.stringify({
    hotelCode: config.hotelCode,
    cells: cells.map((cell) => ({
      roomCode: cell.roomCode,
      roomName: cell.roomName,
      salesDate: cell.salesDate,
      planCode: cell.planCode,
      memberPrice: cell.memberPrice,
    })),
  });

  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(new URL('/bookings', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signRequest(secret, body) },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { accepted: false, reason: `HTTP ${response.status} ${answer.error ?? ''}`.trim() };
    }
    return answer;
  } catch (error) {
    logger?.debug(`booker request failed: ${error.message}`);
    return { accepted: false, reason: `unreachable (${error.name})` };
  }
}
