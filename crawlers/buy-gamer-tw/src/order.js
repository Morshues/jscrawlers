import { request, requestJson } from './session.js';
import { ParseError, stripTags } from './item.js';

/**
 * The pieces of 巴哈商城's checkout that are plain HTTP.
 *
 * The product page's 前往預購 button is
 *
 *   buyPart.remind('', 'TW-15TO18', buyPart.buyNext(43077, '<token>'))
 *
 * `remind` and `ageGrade` only open dialogs (商城訊息, the age rating notice);
 * what actually orders is `buyNext`, which posts {token, sn, num} to
 * ajax/shopping_cart.php and then sends the browser to checkout_order.php
 * (gshop.js). Calling that endpoint directly is "skipping the pop-ups".
 *
 * The 加入購物車 button calls the same thing with its own token and a third
 * `false` argument (stay on the page); either token works for the cart, but the
 * buy-now one is what a person clicking 前往預購 would send.
 */

export class OrderError extends Error {
  constructor(message, { step } = {}) {
    super(message);
    this.name = 'OrderError';
    this.step = step;
  }
}

const BUY_NEXT_RE = /buyPart\.buyNext\(\s*(\d+)\s*,\s*'([0-9a-f]+)'\s*(,\s*false\s*)?\)/g;

/**
 * The cart token of the buy-now (前往預購 / 前往購買) button.
 *
 * @param {string} html product page
 * @param {string} sn the product the page is expected to be
 */
export function parseBuyToken(html, sn) {
  const area = /<div class="buy-products-btn-area">([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (!area) throw new ParseError(`sn=${sn} 找不到購買按鈕區塊`, { sn });

  const calls = [...area.matchAll(BUY_NEXT_RE)].map((match) => ({
    sn: match[1],
    token: match[2],
    buyNow: !match[3],
  }));
  const call = calls.find((entry) => entry.buyNow) ?? calls[0];
  if (!call)
    throw new ParseError(`sn=${sn} 購買按鈕裡沒有 buyPart.buyNext（售罄，或頁面改版）`, { sn });
  if (call.sn !== String(sn)) {
    throw new ParseError(`sn=${sn} 的購買按鈕指向 sn=${call.sn}`, { sn });
  }
  return call.token;
}

/**
 * POST ajax/shopping_cart.php, what buyNext does. A `message` in the answer is
 * a refusal; code 1 means the account still needs 手機認證.
 */
export async function addToCart(jar, { sn, token, num = 1, baseUrl, referer, logger, signal }) {
  const body = await requestJson(jar, new URL('/ajax/shopping_cart.php', baseUrl).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ token, sn: String(sn), num: String(num) }).toString(),
    referer,
    logger,
    signal,
  });
  if (body?.message) {
    const hint =
      body.code === 1
        ? '（帳號需先完成免費手機認證：https://user.gamer.com.tw/mobile_verify.php）'
        : '';
    throw new OrderError(`加入購物車被拒：${body.message}${hint}`, { step: 'cart' });
  }
  return body;
}

/**
 * Everything that must hold before an order is submitted. Returns the list of
 * problems; empty means go.
 *
 * @param {{ items: { sn: string, qty: number }[], payment: string | null, total: number | null }} summary
 *   what the confirmation page says
 * @param {{ sn: string, maxPrice: number }} expected
 */
export function checkConfirmation(summary, { sn, maxPrice }) {
  const problems = [];
  const others = summary.items.filter((item) => item.sn !== String(sn));
  const mine = summary.items.find((item) => item.sn === String(sn));

  if (!mine) problems.push(`確認頁沒有 sn=${sn}`);
  else if (mine.qty !== 1) problems.push(`sn=${sn} 數量是 ${mine.qty}，不是 1`);
  if (others.length > 0) {
    problems.push(`訂單裡還有其他商品：${others.map((item) => item.sn).join(', ')}`);
  }
  if (!summary.payment?.includes('貨到付款')) {
    problems.push(`付款方式不是貨到付款（${summary.payment ?? '讀不到'}）`);
  }
  if (summary.total === null || summary.total === undefined) problems.push('讀不到訂單總額');
  else if (summary.total > maxPrice) {
    problems.push(`總額 NT ${summary.total} 超過上限 NT ${maxPrice}`);
  }
  return problems;
}

/*
 * checkout_order.php, and what its 送出訂單 button does (gshop.js
 * buyPart.checkoutOrder.validateForm):
 *
 *   GET  /ajax/getCSRFToken.php                 -> a token, as plain text
 *   POST /ajax/checkout_userdata.php            payway[sn], token, from=""
 *   POST /checkout_order_action.php (multipart) bonus[sn], memo, payway[sn],
 *        ship[sn], token (the page's hidden one), source[, iid]
 *        -> { message: <url of the next page> } or { react: 1, data: { form } }
 *
 * The page's own confirm("確認訂單資料無誤？") sits between the checks and the
 * posts; the checks are checkConfirmation() here.
 *
 * The 「我同意以下事項」 box (preorder_approve) is only drawn for a pre-order paid
 * by credit card, and it is a client-side check that never reaches the server.
 * With 貨到付款 there is nothing to tick.
 */

// gshop.js shipping bits.
export const SHIP = { SEVEN: 1, FAMILY: 2, HOME: 4, HILIFE: 512, OK: 1024 };
const SHIP_NAMES = {
  [SHIP.SEVEN]: '7-11 超商取貨',
  [SHIP.FAMILY]: '全家 超商取貨',
  [SHIP.HOME]: '黑貓宅急便',
  [SHIP.HILIFE]: '萊爾富 超商取貨',
  [SHIP.OK]: 'OK 超商取貨',
};

const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/**
 * Everything the submit needs from checkout_order.php. The page also embeds the
 * buyer's name, phone and addresses (initData); only the shipping defaults are
 * kept from it.
 */
export function parseCheckout(html) {
  const formTag = /<form name="frm0115"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  if (!formTag) throw new ParseError('結帳頁找不到 frm0115 表單（未登入、購物車空了，或頁面改版）');
  const hidden = (name) =>
    new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(formTag[1])?.[1] ?? null;

  const items = [...html.matchAll(/<div class="list-number" name="itemList"[^>]*>/g)].map(
    ([tag]) => {
      const sn = attr(tag, 'data-sn');
      const num = new RegExp(`<p class="product-num"[^>]*data-sn="${sn}"[^>]*>\\s*(\\d+)`).exec(
        html,
      );
      return {
        sn,
        title: attr(tag, 'data-title'),
        shipway: Number(attr(tag, 'data-shipway')),
        qty: num ? Number(num[1]) : null,
      };
    },
  );

  const shipTag = /<div id="js-ship"[^>]*>/.exec(html)?.[0] ?? '';
  const total = /<span id="amountpaid" data-grandtotal="(\d+)"/.exec(html)?.[1];

  const payways = [
    ...html.matchAll(/<input type="radio" name="payway" value="(\d+)"[^>]*>([\s\S]*?)<\/label>/g),
  ].map((match) => ({ value: match[1], label: stripTags(match[2]) }));

  let defaults = { ship: 0, stores: [], home: false };
  const init = /buyPart\.checkoutOrder\.initData\((\{.*?\})\);?\s*$/m.exec(html);
  if (init) {
    try {
      const data = JSON.parse(init[1]);
      defaults = {
        ship: Number(data.ship) || 0,
        stores: Object.entries(data.store ?? {})
          .filter(([, store]) => store && String(store.id ?? '').trim())
          .map(([bit]) => Number(bit)),
        home: Boolean(Array.isArray(data.shipHome) && data.shipHome[0]),
      };
    } catch {
      // Left at "no defaults", which resolveShip() refuses with a message.
    }
  }

  return {
    token: hidden('token'),
    source: hidden('source'),
    iid: /<input[^>]*name="sn"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? null,
    items,
    shipMask: Number(attr(shipTag, 'data-ship')) || 0,
    shipVariety: Number(attr(shipTag, 'data-variety')) || 0,
    total: total === undefined ? null : Number(total),
    payways,
    defaults,
  };
}

/** The value of the 貨到付款 radio. */
export function codPayway(checkout) {
  const cod = checkout.payways.find((option) => option.label.includes('貨到付款'));
  if (!cod) {
    const offered = checkout.payways.map((option) => option.label).join('、') || '無';
    throw new OrderError(`這筆訂單不能貨到付款（可選：${offered}）`, { step: 'checkout' });
  }
  return cod;
}

/**
 * The shipping method the page would submit without anyone touching it — the
 * account's saved default, as gshop.js `c()` picks it. Home delivery is
 * refused: the page makes a person pick a delivery time slot for it every time.
 */
export function resolveShip(checkout) {
  if (checkout.shipVariety > 1) {
    throw new OrderError('購物車商品的取貨方式不同，需手動選擇', { step: 'checkout' });
  }
  const { shipMask, defaults } = checkout;
  const saved = defaults.stores.reduce((mask, bit) => mask | bit, defaults.home ? SHIP.HOME : 0);
  const usable = saved & shipMask;

  let ship = 0;
  if (defaults.ship & shipMask) ship = defaults.ship;
  else if (usable) {
    ship =
      [SHIP.FAMILY, SHIP.HILIFE, SHIP.OK, SHIP.SEVEN, SHIP.HOME].find((bit) => usable & bit) ?? 0;
  }

  if (!usable || !ship || ship === SHIP.HOME) {
    throw new OrderError(
      '沒有可直接沿用的預設取貨方式（宅配每次都要選時段）— 請在巴哈商城把預設取貨改成已設定門市的超商',
      { step: 'checkout' },
    );
  }
  return { ship, name: SHIP_NAMES[ship] ?? `ship=${ship}` };
}

/**
 * Submit the order the way the 送出訂單 button does. Resolves with where the
 * site sent the browser next.
 */
export async function submitCheckout(jar, { checkout, sn, payway, ship, baseUrl, logger, signal }) {
  const referer = new URL('/checkout_order.php', baseUrl).href;

  const csrf = await request(jar, new URL(`/ajax/getCSRFToken.php?_=${Date.now()}`, baseUrl).href, {
    headers: { 'x-requested-with': 'XMLHttpRequest', referer },
    logger,
    signal,
  });
  const csrfToken = (await csrf.response.text()).trim();
  if (!/^[\w-]{8,128}$/.test(csrfToken)) {
    throw new OrderError(`取不到 CSRF token（${csrfToken.slice(0, 40)}）`, { step: 'submit' });
  }

  const userdata = await requestJson(jar, new URL('/ajax/checkout_userdata.php', baseUrl).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ [`payway[${sn}]`]: payway, token: csrfToken, from: '' }).toString(),
    referer,
    logger,
    signal,
  });
  if (userdata?.message) {
    throw new OrderError(`checkout_userdata 被拒：${userdata.message}`, { step: 'submit' });
  }

  const form = new FormData();
  form.set(`bonus[${sn}]`, '0');
  form.set('memo', '');
  form.set(`payway[${sn}]`, payway);
  form.set(`ship[${sn}]`, String(ship));
  form.set('token', checkout.token ?? '');
  form.set('source', checkout.source ?? 'normal');
  if (checkout.iid) form.set('iid', checkout.iid);

  const answer = await requestJson(jar, new URL('/checkout_order_action.php', baseUrl).href, {
    method: 'POST',
    body: form,
    referer,
    logger,
    signal,
  });
  if (Number(answer?.react) === 1) {
    // A payment-gateway form: only credit card goes there.
    return { kind: 'gateway', form: answer.data?.form ?? null };
  }
  if (answer?.message) return { kind: 'redirect', url: new URL(answer.message, baseUrl).href };
  throw new OrderError(
    `checkout_order_action 回應看不懂：${JSON.stringify(answer).slice(0, 200)}`,
    {
      step: 'submit',
    },
  );
}

/** An order number on the page the site lands on after submitting, if it shows one. */
export function parseOrderNumber(html) {
  const text = stripTags(html);
  return /訂單(?:編號|號碼)\s*[:：]?\s*([A-Z0-9-]{6,})/.exec(text)?.[1] ?? null;
}
