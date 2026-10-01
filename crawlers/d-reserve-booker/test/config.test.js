import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseAnswers, parseDateSpec, parseListen } from '../src/config.js';

const ENV = {
  BOOKER_HOTEL_CODE: '0000001834',
  BOOKER_DATES: '2026-10-29',
  BOOKER_MAX_PRICE: '70000',
  BOOKER_LOGIN_USER: 'u',
  BOOKER_LOGIN_PASSWORD: 'p',
};

test('a minimal env loads, rehearsing on localhost by default', () => {
  const config = loadConfig(ENV);
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 8787);
  assert.equal(config.server.submit, false);
  assert.equal(config.policy.maxPrice, 70000);
  assert.equal(config.booking.maxPrice, 70000);
  assert.deepEqual([...config.policy.dates], ['2026-10-29']);
});

test('dates, a price cap and the login are required', () => {
  for (const key of [
    'BOOKER_DATES',
    'BOOKER_MAX_PRICE',
    'BOOKER_LOGIN_USER',
    'BOOKER_LOGIN_PASSWORD',
  ]) {
    assert.throws(() => loadConfig({ ...ENV, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => loadConfig({ ...ENV, BOOKER_MAX_PRICE: '0' }), /positive/);
});

test('serving needs a long enough secret', () => {
  assert.throws(() => loadConfig(ENV, { serve: true }), /BOOKER_SECRET/);
  assert.equal(
    loadConfig({ ...ENV, BOOKER_SECRET: 'x'.repeat(32) }, { serve: true }).server.secret.length,
    32,
  );
});

test('parsers', () => {
  assert.deepEqual(parseAnswers('8153=0, 8154=東京'), { 8153: '0', 8154: '東京' });
  assert.throws(() => parseAnswers('8153'), /<code>=<value>/);
  assert.deepEqual(
    [...parseDateSpec('2026-10-30..2026-11-01')],
    ['2026-10-30', '2026-10-31', '2026-11-01'],
  );
  assert.deepEqual(parseListen('100.64.0.2:9000'), { host: '100.64.0.2', port: 9000 });
  assert.throws(() => parseListen('8787'), /host:port/);
});
