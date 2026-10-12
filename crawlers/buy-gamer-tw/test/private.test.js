import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privatePaths, readOrderEnv } from '../src/private.js';
import { loadConfig, loadOrderConfig } from '../src/config.js';

test('private paths default to the home directory and refuse the repo', () => {
  const paths = privatePaths({}, { home: '/home/u', root: '/repo' });
  assert.equal(paths.envFile, '/home/u/.config/buy-gamer-tw/order.env');
  assert.equal(paths.sessionFile, '/home/u/.config/buy-gamer-tw/session.json');
  assert.equal(paths.dataDir, '/home/u/.local/share/buy-gamer-tw');

  assert.throws(
    () => privatePaths({ BUYGAMER_ORDER_ENV_FILE: '/repo/order.env' }, { root: '/repo' }),
    /inside the repository/,
  );
  assert.throws(
    () => privatePaths({ BUYGAMER_ORDER_DATA_DIR: '/repo/data/x' }, { home: '/h', root: '/repo' }),
    /inside the repository/,
  );
});

test('readOrderEnv refuses a file others can read', { skip: process.platform === 'win32' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buygamer-')), 'order.env');
  fs.writeFileSync(file, 'BUYGAMER_ORDER_MAX_PRICE=3000\n', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readOrderEnv(file), /chmod 600/);
  fs.chmodSync(file, 0o600);
  assert.deepEqual(readOrderEnv(file), { BUYGAMER_ORDER_MAX_PRICE: '3000' });
  assert.throws(() => readOrderEnv(`${file}.missing`), /order\.env\.example/);
});

test('loadOrderConfig needs a login and a price cap', () => {
  assert.throws(() => loadOrderConfig({ BUYGAMER_ORDER_MAX_PRICE: '1' }), /BUYGAMER_COOKIES/);
  assert.throws(() => loadOrderConfig({ BUYGAMER_COOKIES: 'a=b' }), /BUYGAMER_ORDER_MAX_PRICE/);
  assert.throws(
    () => loadOrderConfig({ BUYGAMER_COOKIES: 'a=b', BUYGAMER_ORDER_MAX_PRICE: '0' }),
    /positive/,
  );
  assert.deepEqual(
    loadOrderConfig({
      BUYGAMER_LOGIN_USER: 'me',
      BUYGAMER_LOGIN_PASSWORD: 'pw',
      BUYGAMER_ORDER_MAX_PRICE: '3000',
    }),
    { user: 'me', password: 'pw', cookies: '', maxPrice: 3000, submit: false },
  );
});

test('ordering is off by default and the allow-list takes URLs too', () => {
  assert.deepEqual(loadConfig({ BUYGAMER_ITEMS: '1' }).order, { enabled: false, items: null });
  const { order } = loadConfig({
    BUYGAMER_ITEMS: '1',
    BUYGAMER_ORDER_ENABLED: 'true',
    BUYGAMER_ORDER_ITEMS: '43077,https://buy.gamer.com.tw/atmItem.php?sn=1',
  });
  assert.equal(order.enabled, true);
  assert.deepEqual([...order.items], ['43077', '1']);
});

test('commands that never poll do not need a watch list', () => {
  assert.deepEqual(loadConfig({}, { watching: false }).items, []);
  assert.throws(() => loadConfig({}), /BUYGAMER_ITEMS is required/);
});
