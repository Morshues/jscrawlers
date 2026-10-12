import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBuyToken,
  checkConfirmation,
  parseCheckout,
  codPayway,
  resolveShip,
  parseOrderNumber,
  SHIP,
} from '../src/order.js';
import { parseCart } from '../src/session.js';
import { ParseError } from '../src/item.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseBuyToken takes the 前往預購 token, not the 加入購物車 one', () => {
  assert.equal(
    parseBuyToken(fixture('in-stock.html'), '41435'),
    '0376e294667df68f54663300f787b1ce3c887e28597bb6136aa64cc5',
  );
});

test('parseBuyToken falls back to the cart button when it is the only one', () => {
  const html =
    "<div class=\"buy-products-btn-area\"><a onclick=\"buyPart.remind('', 'TW-0', buyPart.buyNext(7, 'abc123', false))\">加入購物車</a></div>";
  assert.equal(parseBuyToken(html, '7'), 'abc123');
});

test('parseBuyToken refuses a sold-out page and a button for another product', () => {
  assert.throws(() => parseBuyToken(fixture('sold-out.html'), '42810'), ParseError);
  assert.throws(() => parseBuyToken(fixture('in-stock.html'), '99999'), /指向 sn=41435/);
});

test('parseCart tells logged out, empty and filled carts apart', () => {
  assert.deepEqual(parseCart({ code: 1, message: '請先登入。' }), {
    loggedIn: false,
    items: [],
    message: '請先登入。',
  });
  assert.equal(parseCart({ code: 2, message: '購物車沒有商品' }).loggedIn, true);
  assert.deepEqual(parseCart({ 0: { sn: 43077, title: 'X', qty: '1', platform: 'NS2' } }), {
    loggedIn: true,
    items: [{ sn: '43077', title: 'X', qty: 1 }],
  });
});

test('checkConfirmation passes only the exact order', () => {
  const ok = { items: [{ sn: '43077', qty: 1 }], payment: '貨到付款', total: 2950 };
  assert.deepEqual(checkConfirmation(ok, { sn: '43077', maxPrice: 3000 }), []);

  const bad = {
    items: [
      { sn: '43077', qty: 2 },
      { sn: '1', qty: 1 },
    ],
    payment: '信用卡',
    total: 9000,
  };
  const problems = checkConfirmation(bad, { sn: '43077', maxPrice: 3000 });
  assert.equal(problems.length, 4);
  assert.match(problems.join('\n'), /數量是 2/);
  assert.match(problems.join('\n'), /其他商品：1/);
  assert.match(problems.join('\n'), /不是貨到付款/);
  assert.match(problems.join('\n'), /超過上限/);

  assert.match(
    checkConfirmation({ items: [], payment: null, total: null }, { sn: '43077', maxPrice: 1 }).join(
      '\n',
    ),
    /沒有 sn=43077[\s\S]*讀不到訂單總額/,
  );
});

test('parseCheckout reads what the submit needs and none of the personal data', () => {
  const page = parseCheckout(fixture('checkout-order.html'));
  assert.deepEqual(page, {
    token: '0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    source: 'normal',
    iid: null,
    items: [{ sn: '43077', title: '《女神異聞錄 4 Revival》中文一般版', shipway: 7, qty: 1 }],
    shipMask: 7,
    shipVariety: 1,
    total: 1990,
    payways: [
      { value: '1', label: '貨到付款' },
      { value: '2', label: '信用卡付款（將前往刷卡頁面結帳）' },
    ],
    defaults: { ship: 1, stores: [1, 2], home: true },
  });
  assert.deepEqual(codPayway(page), { value: '1', label: '貨到付款' });
  assert.deepEqual(resolveShip(page), { ship: SHIP.SEVEN, name: '7-11 超商取貨' });
});

test('parseCheckout fails loudly off the checkout page', () => {
  assert.throws(() => parseCheckout('<html>請先登入</html>'), /frm0115/);
});

test('codPayway refuses a checkout without 貨到付款', () => {
  const page = parseCheckout(fixture('checkout-order.html'));
  assert.throws(
    () => codPayway({ ...page, payways: page.payways.slice(1) }),
    /不能貨到付款（可選：信用卡付款/,
  );
});

test('resolveShip follows the saved default and refuses home delivery', () => {
  const page = parseCheckout(fixture('checkout-order.html'));
  const withDefaults = (defaults, extra = {}) => ({
    ...page,
    ...extra,
    defaults: { ...page.defaults, ...defaults },
  });

  // Saved default not allowed for this product -> first saved store it allows.
  assert.equal(
    resolveShip(withDefaults({ ship: SHIP.OK }, { shipMask: SHIP.SEVEN | SHIP.FAMILY })).ship,
    SHIP.FAMILY,
  );
  assert.throws(() => resolveShip(withDefaults({ ship: SHIP.HOME })), /宅配/);
  assert.throws(() => resolveShip(withDefaults({ ship: 0, stores: [], home: false })), /預設取貨/);
  assert.throws(() => resolveShip({ ...page, shipVariety: 2 }), /取貨方式不同/);
});

test('parseOrderNumber finds the number on a result page', () => {
  assert.equal(parseOrderNumber('<p>訂單編號：<b>A20261012001</b></p>'), 'A20261012001');
  assert.equal(parseOrderNumber('<p>謝謝</p>'), null);
});
