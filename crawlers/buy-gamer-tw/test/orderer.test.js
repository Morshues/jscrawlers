import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placeOrder, readLock, buildOrderPayload } from '../src/orderer.js';
import { loadConfig } from '../src/config.js';

const BASE = 'https://buy.gamer.com.tw';
const SN = '41435'; // the in-stock fixture, NT 1880 on the product page
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const CHECKOUT = fixture('checkout-order.html').replaceAll('43077', SN).replaceAll('1990', '2950');

function setup(t, { submit = true, maxPrice = 3000, actionAnswer } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buygamer-'));
  const paths = { dataDir, sessionFile: path.join(dataDir, 'session.json') };
  fs.writeFileSync(paths.sessionFile, JSON.stringify({ cookies: { BAHARUNE: 'ok' } }));

  let carted = false;
  const posts = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const json = (body) => new Response(JSON.stringify(body));
    if (init.method === 'POST') posts[pathname] = init.body;
    switch (pathname) {
      case '/ajax/shopping_cart_get.php':
        return json(carted ? { 0: { sn: SN, title: 'X', qty: 1 } } : { code: 2, message: '空' });
      case '/atmItem.php':
        return new Response(fixture('in-stock.html'));
      case '/ajax/shopping_cart.php':
        carted = true;
        return json({});
      case '/checkout_order.php':
        return new Response(CHECKOUT);
      case '/ajax/getCSRFToken.php':
        return new Response('1a5b2a4a87a5ca47');
      case '/ajax/checkout_userdata.php':
        return json({});
      case '/checkout_order_action.php':
        return json(actionAnswer ?? { message: `${BASE}/checkout_finish.php?o=1` });
      case '/checkout_finish.php':
        return new Response('<p>訂單編號：A123456789</p>');
      default:
        throw new Error(`unexpected ${pathname}`);
    }
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const config = loadConfig({ BUYGAMER_ITEMS: SN });
  const order = { user: '', password: '', cookies: '', maxPrice, submit };
  return { ctx: { config, order, paths }, posts, paths };
}

const ITEM = { sn: SN, url: `${BASE}/atmItem.php?sn=${SN}` };

test('a full run picks 貨到付款, keeps the default store, submits and locks', async (t) => {
  const { ctx, posts, paths } = setup(t);
  const result = await placeOrder(ITEM, ctx);

  assert.equal(result.status, 'submitted', result.error);
  assert.equal(result.orderNumber, 'A123456789');
  assert.equal(result.payment, '貨到付款');
  assert.equal(result.ship, '7-11 超商取貨');

  assert.equal(
    posts['/ajax/checkout_userdata.php'],
    new URLSearchParams({ [`payway[${SN}]`]: '1', token: '1a5b2a4a87a5ca47', from: '' }).toString(),
  );
  const form = posts['/checkout_order_action.php'];
  assert.deepEqual(Object.fromEntries(form), {
    [`bonus[${SN}]`]: '0',
    memo: '',
    [`payway[${SN}]`]: '1',
    [`ship[${SN}]`]: '1',
    token: '0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    source: 'normal',
  });

  assert.equal(readLock(paths, SN).status, 'submitted');
  assert.equal((await placeOrder(ITEM, ctx)).status, 'locked');
  assert.match(buildOrderPayload(result).title, /已下單/);
});

test('with SUBMIT off it stops after the checks, sends nothing, locks nothing', async (t) => {
  const { ctx, posts, paths } = setup(t, { submit: false });
  const result = await placeOrder(ITEM, ctx);
  assert.equal(result.status, 'ready', result.error);
  assert.equal(posts['/checkout_order_action.php'], undefined);
  assert.equal(posts['/ajax/checkout_userdata.php'], undefined);
  assert.equal(readLock(paths, SN), null);
});

test('a product price over the cap stops before the cart', async (t) => {
  const { ctx, posts } = setup(t, { maxPrice: 1000 });
  const result = await placeOrder(ITEM, ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'item');
  assert.match(result.error, /超過上限/);
  assert.equal(posts['/ajax/shopping_cart.php'], undefined);
});

test('a checkout total over the cap is caught at the confirmation step', async (t) => {
  // The product page says NT 1880, the checkout page NT 2950.
  const { ctx, posts } = setup(t, { maxPrice: 2000 });
  const result = await placeOrder(ITEM, ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.step, 'confirm');
  assert.match(result.error, /總額 NT 2950 超過上限/);
  assert.equal(posts['/ajax/checkout_userdata.php'], undefined);
  assert.equal(posts['/checkout_order_action.php'], undefined);
});

test('an answer it cannot read after submitting stays locked', async (t) => {
  const { ctx, paths } = setup(t, { actionAnswer: { weird: true } });
  const result = await placeOrder(ITEM, ctx);
  assert.equal(result.status, 'submit-unknown');
  assert.equal(readLock(paths, SN).status, 'submit-unknown');
  assert.match(buildOrderPayload(result).title, /結果不明/);
});
