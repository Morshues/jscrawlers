import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed requests between two of our own processes on different machines.
 *
 *   x-signed-timestamp: <unix ms>
 *   x-signed-signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * The timestamp is inside the signature, so a captured request cannot be
 * re-dated, and the receiver rejects anything outside a short window. Within
 * that window a replay is still possible; `createReplayGuard` closes it.
 */

export const SIGNATURE_HEADER = 'x-signed-signature';
export const TIMESTAMP_HEADER = 'x-signed-timestamp';

function hmac(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Headers to send with `body` (the exact string that goes on the wire). */
export function signRequest(secret, body, now = Date.now()) {
  const timestamp = String(now);
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: hmac(secret, timestamp, body),
  };
}

/**
 * @param {Record<string, string | string[] | undefined>} headers lower-cased, as node:http gives them
 * @returns {{ ok: true, signature: string } | { ok: false, reason: string }}
 */
export function verifyRequest(
  secret,
  headers,
  body,
  { now = Date.now(), maxSkewMs = 60_000 } = {},
) {
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (typeof timestamp !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: 'unsigned' };
  }
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > maxSkewMs) {
    return { ok: false, reason: 'stale' };
  }

  const expected = Buffer.from(hmac(secret, timestamp, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true, signature };
}

/**
 * Remembers signatures seen inside the skew window, so a captured request
 * cannot be sent a second time while its timestamp is still fresh.
 */
export function createReplayGuard({ ttlMs = 120_000 } = {}) {
  const seen = new Map();
  return function firstSeen(signature, now = Date.now()) {
    for (const [key, at] of seen) if (now - at > ttlMs) seen.delete(key);
    if (seen.has(signature)) return false;
    seen.set(signature, now);
    return true;
  };
}
