import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseItems, itemUrl, DEFAULT_BUY_KEYWORDS } from '../src/config.js';

const BASE = 'https://buy.gamer.com.tw';
const BASE_ENV = { BUYGAMER_ITEMS: '42810' };

test('parseItems accepts bare product numbers and full URLs', () => {
  assert.deepEqual(parseItems('42810, https://buy.gamer.com.tw/atmItem.php?sn=41435', BASE), [
    { sn: '42810', url: `${BASE}/atmItem.php?sn=42810` },
    { sn: '41435', url: `${BASE}/atmItem.php?sn=41435` },
  ]);
});

test('parseItems collapses duplicates however they were written', () => {
  const items = parseItems('42810,42810,https://buy.gamer.com.tw/atmItem.php?sn=42810', BASE);
  assert.deepEqual(items, [{ sn: '42810', url: itemUrl(BASE, '42810') }]);
});

test('parseItems rejects something that is neither', () => {
  assert.throws(() => parseItems('not-a-product', BASE), /neither a product number/);
  assert.throws(() => parseItems('https://buy.gamer.com.tw/indexList.php?gc1=998', BASE), /sn/);
});

test('an empty watch list fails loudly', () => {
  assert.throws(() => loadConfig({}), /BUYGAMER_ITEMS is required/);
  assert.throws(() => loadConfig({ BUYGAMER_ITEMS: '  ,  ' }), /BUYGAMER_ITEMS is required/);
});

test('defaults cover everything except the watch list', () => {
  const config = loadConfig(BASE_ENV);

  assert.equal(config.baseUrl, BASE);
  assert.equal(config.items.length, 1);
  assert.equal(config.poll.intervalMs, 300_000);
  assert.equal(config.poll.requestDelayMs, 1500);
  assert.equal(config.parse.adultCookie, true);
  assert.deepEqual(config.parse.buyKeywords, DEFAULT_BUY_KEYWORDS);
  assert.deepEqual(config.parse.soldOutKeywords, ['補貨通知我']);
  assert.deepEqual(config.notify.channels, []);
  assert.equal(config.notify.cooldownMs, 0);
  assert.equal(config.notify.grouped, true);
  assert.equal(config.notify.onFirstRun, false);
});

test('the keyword lists and interval can be overridden from .env', () => {
  const config = loadConfig({
    ...BASE_ENV,
    BUYGAMER_INTERVAL: '90s',
    BUYGAMER_BUY_KEYWORDS: '立即購買, 加入購物車',
    BUYGAMER_NOTIFY_CHANNELS: 'telegram,webhook',
    BUYGAMER_NOTIFY_COOLDOWN_MIN: '30',
    BUYGAMER_ADULT_COOKIE: 'false',
  });

  assert.equal(config.poll.intervalMs, 90_000);
  assert.deepEqual(config.parse.buyKeywords, ['立即購買', '加入購物車']);
  assert.deepEqual(config.notify.channels, ['telegram', 'webhook']);
  assert.equal(config.notify.cooldownMs, 1_800_000);
  assert.equal(config.parse.adultCookie, false);
});
