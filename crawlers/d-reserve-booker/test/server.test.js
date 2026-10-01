import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { signRequest } from '@jscrawlers/core';
import { loadConfig } from '../src/config.js';
import { createBooker } from '../src/booker.js';
import { createApp } from '../src/server.js';

const SECRET = 's'.repeat(40);
const CELL = {
  roomCode: 'RM00010236',
  salesDate: '2026-10-29',
  planCode: 'PL00028613',
  memberPrice: 66000,
  roomName: '和洋室',
};

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  const log = [];
  return {
    log,
    readState: async () => structuredClone(state),
    saveState: async (next) => {
      state = structuredClone(next);
    },
    saveRecord: async () => {},
    appendLog: async (entry) => log.push(entry),
    peek: () => state,
  };
}

/**
 * A booker + server on a random port with the network-facing attempt stubbed.
 * `attempt` resolves when the test calls `release()`, so "in flight" is observable.
 */
async function setup({ submit = true, state = {}, result } = {}) {
  const config = loadConfig(
    {
      BOOKER_HOTEL_CODE: '0000001834',
      BOOKER_DATES: '2026-10-29',
      BOOKER_MAX_PRICE: '70000',
      BOOKER_LOGIN_USER: 'u',
      BOOKER_LOGIN_PASSWORD: 'p',
      BOOKER_SECRET: SECRET,
      BOOKER_SUBMIT: String(submit),
      BOOKER_LISTEN: '127.0.0.1:0',
    },
    { serve: true },
  );
  const store = memoryStore(state);
  const calls = [];
  const notified = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const attempt = async (cfg, cell, options) => {
    calls.push({ cell, options });
    await gate;
    return (
      result ?? {
        ok: true,
        submitted: !options.dryRun,
        nextUrl: 'https://www2.jtbbookandpay.com/pay/secret-token',
        payload: { reservationGroup: { payment: { amount: 66000 } } },
      }
    );
  };
  const notify = async (payload) => {
    notified.push(payload);
    return [{ ok: true }];
  };
  const booker = createBooker({ config, log: quiet, notify, store, attempt });
  const server = createApp({ config, booker, log: quiet }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, { sign = true, secret = SECRET, headers } = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(base + path, {
      method,
      body: method === 'GET' ? undefined : raw,
      headers: { ...(sign ? signRequest(secret, raw) : {}), ...headers },
    });
    return { status: response.status, body: await response.json() };
  }

  return {
    call,
    base,
    calls,
    notified,
    store,
    booker,
    release: () => release(),
    close: async () => {
      release();
      await booker.idle();
      server.close();
    },
  };
}

test('unsigned, wrongly signed and replayed requests are refused', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const body = { hotelCode: '0000001834', cells: [CELL] };
  assert.equal((await ctx.call('POST', '/bookings', body, { sign: false })).status, 401);
  assert.equal((await ctx.call('POST', '/bookings', body, { secret: 'x'.repeat(40) })).status, 401);

  const raw = JSON.stringify(body);
  const headers = signRequest(SECRET, raw);
  const first = await ctx.call('POST', '/bookings', body, { sign: false, headers });
  const replay = await ctx.call('POST', '/bookings', body, { sign: false, headers });
  assert.equal(first.status, 202);
  assert.deepEqual(replay, { status: 401, body: { error: 'replay' } });
  assert.equal(ctx.calls.length, 1);
});

test('a request for another hotel or garbage is a 400 and books nothing', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  assert.equal(
    (await ctx.call('POST', '/bookings', { hotelCode: '9', cells: [CELL] })).status,
    400,
  );
  assert.equal((await ctx.call('GET', '/nope')).status, 404);
  assert.equal(ctx.calls.length, 0);
});

test('an accepted request answers the decision only, then books in the background', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const response = await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells: [CELL] });
  assert.deepEqual(response, {
    status: 202,
    body: {
      accepted: true,
      submit: true,
      target: { roomCode: CELL.roomCode, salesDate: CELL.salesDate },
    },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /jtbbookandpay|secret-token/);

  const busy = await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells: [CELL] });
  assert.deepEqual(busy.body, { accepted: false, reason: 'busy' });

  ctx.release();
  await ctx.booker.idle();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].options.dryRun, false);
  assert.equal(ctx.store.peek().locked, true);
  assert.match(ctx.notified[0].text, /secret-token/); // the link goes to the person, not the caller

  const after = await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells: [CELL] });
  assert.deepEqual(after.body, { accepted: false, reason: 'locked' });
  assert.deepEqual((await ctx.call('GET', '/health')).body, {
    ok: true,
    locked: true,
    busy: false,
    submit: true,
  });
});

test('with BOOKER_SUBMIT=false it only rehearses and never locks', async (t) => {
  const ctx = await setup({ submit: false });
  t.after(ctx.close);

  const response = await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells: [CELL] });
  assert.equal(response.body.submit, false);
  ctx.release();
  await ctx.booker.idle();

  assert.equal(ctx.calls[0].options.dryRun, true);
  assert.equal(ctx.store.peek().locked, undefined);
  assert.match(ctx.notified[0].title, /演練/);
});

test('a failed submission counts an attempt, stays unlocked and reports the reason', async (t) => {
  const ctx = await setup({ result: { ok: false, submitted: true, error: 'HTTP 409: sold out' } });
  t.after(ctx.close);

  await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells: [CELL] });
  ctx.release();
  await ctx.booker.idle();

  assert.deepEqual(ctx.store.peek(), { attempts: { 'RM00010236|2026-10-29': 1 } });
  assert.match(ctx.notified[0].title, /失敗/);
  assert.equal(ctx.store.log[0].error, 'HTTP 409: sold out');
});

test('cells outside the policy are not accepted', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const response = await ctx.call('POST', '/bookings', {
    hotelCode: '0000001834',
    cells: [
      { ...CELL, memberPrice: 90000 },
      { ...CELL, salesDate: '2026-10-30' },
    ],
  });
  assert.deepEqual(response, {
    status: 200,
    body: { accepted: false, reason: 'no-eligible-cell' },
  });
  assert.equal(ctx.calls.length, 0);
});

test('/book still works for watchers that predate /bookings', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const response = await ctx.call('POST', '/book', { hotelCode: '0000001834', cells: [CELL] });
  assert.equal(response.status, 202);
});

test('an oversized body is refused before anything is parsed or verified', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const cells = Array.from({ length: 400 }, () => CELL);
  const response = await ctx.call('POST', '/bookings', { hotelCode: '0000001834', cells });
  assert.deepEqual(response, { status: 413, body: { error: 'too-large' } });
  assert.equal(ctx.calls.length, 0);
});

test('responses do not advertise the framework', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  const response = await fetch(`${ctx.base}/nope`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-powered-by'), null);
});
