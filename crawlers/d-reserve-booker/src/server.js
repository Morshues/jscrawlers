import express from 'express';
import { verifyRequest, createReplayGuard } from '@jscrawlers/core';
import { sanitizeCells } from './policy.js';

/**
 *   POST /bookings   { hotelCode, cells: [{ roomCode, salesDate, planCode, memberPrice, roomName? }] }
 *                    202 { accepted: true, submit, target: { roomCode, salesDate } }
 *                    200 { accepted: false, reason: 'locked' | 'busy' | 'no-eligible-cell' }
 *   POST /book       alias of /bookings, for watchers deployed before the rename
 *   GET  /health     200 { ok: true, locked, busy, submit }
 *
 * Every request, /health included, must be signed (core sign.js). Answers carry
 * decisions only — no payment link, no personal data, no error text from the
 * site — because whoever calls this is not trusted to see them.
 */

const MAX_BODY = '16kb';

/**
 * @param {{ config: object, booker: ReturnType<import('./booker.js').createBooker>, log: object,
 *   now?: () => number }} options
 */
export function createApp({ config, booker, log, now = Date.now }) {
  const firstSeen = createReplayGuard();
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((request, response, next) => {
    response.set('cache-control', 'no-store');
    next();
  });

  // Raw bytes, not parsed JSON: the signature covers exactly what was sent, and
  // a re-serialised body would not match it.
  app.use(express.raw({ type: () => true, limit: MAX_BODY }));

  function requireSignature(request, response, next) {
    const raw = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : '';
    const route = `${request.method} ${request.path}`;
    const verdict = verifyRequest(config.server.secret, request.headers, raw, { now: now() });
    if (!verdict.ok) {
      log.warn(`${route} rejected (${verdict.reason}) from ${request.ip}`);
      return response.status(401).json({ error: verdict.reason });
    }
    if (!firstSeen(verdict.signature, now())) {
      log.warn(`${route} rejected (replay) from ${request.ip}`);
      return response.status(401).json({ error: 'replay' });
    }
    request.rawBody = raw;
    next();
  }

  app.get('/health', requireSignature, async (request, response) => {
    response.json({ ok: true, ...(await booker.status()) });
  });

  async function book(request, response) {
    let body;
    try {
      body = JSON.parse(request.rawBody);
    } catch {
      return response.status(400).json({ error: 'bad-json' });
    }
    if (body?.hotelCode !== config.hotelCode) {
      return response.status(400).json({ error: 'wrong-hotel' });
    }

    const cells = sanitizeCells(body.cells);
    const decision = await booker.request(cells);
    log.info(
      decision.accepted
        ? `受理：${decision.target.salesDate} ${decision.target.roomCode}（${cells.length} 筆候選）`
        : `未受理（${decision.reason}，${cells.length} 筆候選）`,
    );
    response.status(decision.accepted ? 202 : 200).json(decision);
  }

  app.post('/bookings', requireSignature, book);
  app.post('/book', requireSignature, book);

  app.use((request, response) => response.status(404).json({ error: 'not-found' }));

  // Express 5 routes rejected promises here too. Nothing from the error reaches
  // the caller but its HTTP class.
  app.use((error, request, response, next) => {
    const status = error.status ?? error.statusCode ?? 500;
    if (status >= 500) log.error(`${request.method} ${request.path} failed: ${error.message}`);
    if (response.headersSent) return next(error);
    response.status(status).json({
      error: status === 413 ? 'too-large' : status < 500 ? 'bad-request' : 'internal',
    });
  });

  return app;
}
