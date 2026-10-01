import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { verifyRequest } from '@jscrawlers/core';
import { loadConfig } from '../src/config.js';
import { requestBooking } from '../src/booker-client.js';

const SECRET = 'k'.repeat(40);

async function fakeBooker(handler) {
  const received = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      received.push({ path: request.url, headers: request.headers, raw });
      const [status, body] = handler(raw, request.headers);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, received, url: `http://127.0.0.1:${server.address().port}` };
}

function configFor(url, extra = {}) {
  return loadConfig({
    DRESERVE_HOTEL_CODE: '0000001834',
    DRESERVE_FROM_DATE: '2026-09-10',
    DRESERVE_TO_DATE: '2026-11-15',
    DRESERVE_BOOKER_URL: url,
    DRESERVE_BOOKER_SECRET: SECRET,
    ...extra,
  });
}

const CELL = {
  roomCode: 'RM00010236',
  roomName: '和洋室',
  salesDate: '2026-10-29',
  dayOfWeek: 'THURSDAY',
  available: true,
  stockNum: 1,
  memberPrice: 66000,
  regularPrice: 66000,
  planCode: 'PL00028613',
};

test('requestBooking signs the body and sends only room, date, plan and price', async (t) => {
  const booker = await fakeBooker((raw, headers) =>
    verifyRequest(SECRET, headers, raw).ok
      ? [
          202,
          {
            accepted: true,
            submit: false,
            target: { roomCode: 'RM00010236', salesDate: '2026-10-29' },
          },
        ]
      : [401, { error: 'bad-signature' }],
  );
  t.after(() => booker.server.close());

  const answer = await requestBooking(configFor(booker.url), [CELL]);
  assert.equal(answer.accepted, true);
  assert.equal(booker.received[0].path, '/bookings');
  assert.deepEqual(JSON.parse(booker.received[0].raw), {
    hotelCode: '0000001834',
    cells: [
      {
        roomCode: 'RM00010236',
        roomName: '和洋室',
        salesDate: '2026-10-29',
        planCode: 'PL00028613',
        memberPrice: 66000,
      },
    ],
  });
});

test('a refusal or an unreachable booker comes back as a reason, never a throw', async (t) => {
  const booker = await fakeBooker(() => [401, { error: 'stale' }]);
  t.after(() => booker.server.close());

  assert.deepEqual(await requestBooking(configFor(booker.url), [CELL]), {
    accepted: false,
    reason: 'HTTP 401 stale',
  });

  const gone = await requestBooking(
    configFor('http://127.0.0.1:9', { DRESERVE_BOOKER_TIMEOUT_MS: '500' }),
    [CELL],
  );
  assert.equal(gone.accepted, false);
  assert.match(gone.reason, /^unreachable/);
});

test('the booker is optional, but a URL needs a real secret', () => {
  assert.equal(
    loadConfig({
      DRESERVE_HOTEL_CODE: '0000001834',
      DRESERVE_FROM_DATE: '2026-09-10',
      DRESERVE_TO_DATE: '2026-11-15',
    }).booker,
    null,
  );
  assert.throws(
    () => configFor('http://127.0.0.1:8787', { DRESERVE_BOOKER_SECRET: 'short' }),
    /DRESERVE_BOOKER_SECRET/,
  );
  assert.throws(() => configFor('not a url'), /not a URL/);
});
