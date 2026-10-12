import fs from 'node:fs';
import path from 'node:path';
import { login, request, fetchCart } from './session.js';
import { parseItem } from './item.js';
import {
  parseBuyToken,
  addToCart,
  parseCheckout,
  codPayway,
  resolveShip,
  checkConfirmation,
  submitCheckout,
  parseOrderNumber,
  OrderError,
} from './order.js';
import { writePrivate, appendPrivate } from './private.js';

/**
 * One product, from "it is orderable" to a placed 貨到付款 order.
 *
 *   login → product page (price cap, buy token) → shopping_cart.php
 *         → checkout_order.php: 貨到付款, saved default 取貨, strict checks
 *         → getCSRFToken → checkout_userdata → checkout_order_action → result page
 *
 * Status: `ready` (checks passed, not sent: --order-recon or
 * BUYGAMER_ORDER_SUBMIT=false), `submitted`, `submit-unknown` (sent, answer not
 * understood — look at the shop), `failed`, `locked`. Pages land in the private
 * data dir.
 *
 * Never throws: the watcher calls this mid-poll, and a failed order must not
 * cost the poll its history. The result says what happened.
 */

const lockFile = (paths, sn) => path.join(paths.dataDir, 'locks', `${sn}.json`);

export function readLock(paths, sn) {
  try {
    return JSON.parse(fs.readFileSync(lockFile(paths, sn), 'utf8'));
  } catch {
    return null;
  }
}

export function clearLock(paths, sn) {
  fs.rmSync(lockFile(paths, sn), { force: true });
}

function stampOf(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Keep a page (it carries name and address) in the private data dir. */
function savePage(paths, startedAt, sn, name, html) {
  const file = path.join(paths.dataDir, 'pages', `${stampOf(startedAt)}-${sn}-${name}.html`);
  writePrivate(file, html);
  return file;
}

/**
 * @param {{ sn: string, url: string }} item
 * @param {{ config: object, order: object, paths: object, logger: object, signal?: AbortSignal,
 *   recon?: boolean }} ctx
 */
export async function placeOrder(item, { config, order, paths, logger, signal, recon = false }) {
  const startedAt = new Date().toISOString();
  const result = { sn: item.sn, url: item.url, startedAt, recon };

  try {
    const lock = readLock(paths, item.sn);
    if (lock && !recon) {
      return { ...result, status: 'locked', lock };
    }

    const {
      jar,
      via,
      cart: before,
    } = await login(order, paths, {
      baseUrl: config.baseUrl,
      logger,
      signal,
    });
    result.loginVia = via;
    if (config.parse.adultCookie) jar.set('ckBUY_item18UP', '18UP');

    const page = await request(jar, item.url, { logger, signal });
    if (!page.url.includes('atmItem.php')) {
      await page.response.body?.cancel();
      throw new OrderError(`商品頁被轉址到 ${page.url}`, { step: 'item' });
    }
    const html = await page.response.text();
    const snapshot = parseItem(html, {
      ...item,
      buyKeywords: config.parse.buyKeywords,
      soldOutKeywords: config.parse.soldOutKeywords,
    });
    Object.assign(result, { title: snapshot.title, price: snapshot.price });

    if (!snapshot.buyable) throw new OrderError('商品目前不可下單', { step: 'item' });
    if (snapshot.price === null) throw new OrderError('讀不到商品價格', { step: 'item' });
    if (snapshot.price > order.maxPrice) {
      throw new OrderError(`價格 NT ${snapshot.price} 超過上限 NT ${order.maxPrice}`, {
        step: 'item',
      });
    }

    // Already in the cart (an earlier recon, or added by hand): adding again
    // could bump the quantity to 2.
    if (before.items.some((entry) => entry.sn === item.sn)) {
      logger?.info(`sn=${item.sn} 已在購物車，不重複加入`);
    } else {
      const token = parseBuyToken(html, item.sn);
      await addToCart(jar, {
        sn: item.sn,
        token,
        baseUrl: config.baseUrl,
        referer: item.url,
        logger,
        signal,
      });
    }

    const after = await fetchCart(jar, { baseUrl: config.baseUrl, logger, signal });
    const mine = after.items.find((entry) => entry.sn === item.sn);
    if (!mine) throw new OrderError('加入購物車後，購物車裡找不到這件商品', { step: 'cart' });
    result.qty = mine.qty;
    result.otherItems = after.items.filter((entry) => entry.sn !== item.sn);

    const checkoutUrl = new URL('/checkout_order.php', config.baseUrl).href;
    const checkout = await request(jar, checkoutUrl, {
      headers: { referer: item.url },
      logger,
      signal,
    });
    const checkoutHtml = await checkout.response.text();
    result.savedPages = [savePage(paths, startedAt, item.sn, 'checkout_order', checkoutHtml)];
    result.checkoutUrl = checkoutUrl;

    // 付款方式選貨到付款, the default 取貨 is kept, then the same checks a person
    // makes at confirm("確認訂單資料無誤？") — but strict, before anything is sent.
    const form = parseCheckout(checkoutHtml);
    const cod = codPayway(form);
    const ship = resolveShip(form);
    Object.assign(result, { total: form.total, payment: cod.label, ship: ship.name });
    const problems = checkConfirmation(
      { items: form.items, payment: cod.label, total: form.total },
      { sn: item.sn, maxPrice: order.maxPrice },
    );
    if (problems.length > 0) {
      throw new OrderError(`確認訂單資料不符，未送出：${problems.join('；')}`, { step: 'confirm' });
    }

    if (recon || !order.submit) {
      result.status = 'ready';
    } else {
      // Locked BEFORE the submit: a timeout after the shop took the order must
      // not let the next restock order it a second time. A failed submit stays
      // locked too, for a human to look at (--order-reset).
      writePrivate(
        lockFile(paths, item.sn),
        `${JSON.stringify({ ...result, status: 'submitting' }, null, 2)}\n`,
      );
      result.status = 'submit-unknown';
      const next = await submitCheckout(jar, {
        checkout: form,
        sn: item.sn,
        payway: cod.value,
        ship: ship.ship,
        baseUrl: config.baseUrl,
        logger,
        signal,
      });
      if (next.kind === 'gateway') {
        if (next.form)
          result.savedPages.push(savePage(paths, startedAt, item.sn, 'gateway', next.form));
        throw new OrderError('巴哈要求前往刷卡頁（貨到付款不該如此），請到網站確認訂單', {
          step: 'submit',
        });
      }
      const done = await request(jar, next.url, {
        headers: { referer: checkoutUrl },
        logger,
        signal,
      });
      const doneHtml = await done.response.text();
      result.savedPages.push(savePage(paths, startedAt, item.sn, 'result', doneHtml));
      Object.assign(result, {
        status: 'submitted',
        resultUrl: done.url,
        orderNumber: parseOrderNumber(doneHtml),
      });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    Object.assign(result, {
      status: result.status === 'submit-unknown' ? 'submit-unknown' : 'failed',
      step: error.step ?? null,
      error: error.message,
    });
  }

  result.finishedAt = new Date().toISOString();
  appendPrivate(path.join(paths.dataDir, 'orders.jsonl'), `${JSON.stringify(result)}\n`);
  if (result.status === 'submitted' || result.status === 'submit-unknown') {
    writePrivate(lockFile(paths, item.sn), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

/** Notification for an order result. Product, price and outcome only — no personal data. */
export function buildOrderPayload(result) {
  const name = result.title ?? `sn=${result.sn}`;
  const amount = result.total ?? result.price;
  const price = amount ? `NT ${amount.toLocaleString('zh-TW')} 元` : '價格不明';
  const base = {
    source: 'buy-gamer-tw',
    event: 'order',
    detectedAt: result.finishedAt ?? new Date().toISOString(),
    matches: [{ sn: result.sn, title: result.title, url: result.url, price: amount }],
    status: result.status,
  };
  const how = [result.payment, result.ship].filter(Boolean).join('・');

  switch (result.status) {
    case 'submitted':
      return {
        ...base,
        title: `✅ 已下單：${name}`,
        text:
          `${name}\n${price}・${how}\n` +
          `訂單編號：${result.orderNumber ?? '（頁面上沒讀到，請到商城訂單查詢確認）'}`,
      };
    case 'ready':
      return {
        ...base,
        title: `🛒 已到確認步驟（未送出）：${name}`,
        text:
          `${name}\n${price}・${how}\n確認訂單資料無誤，但 BUYGAMER_ORDER_SUBMIT=false，沒有送出。\n` +
          `請手動結帳：${result.checkoutUrl}`,
      };
    case 'submit-unknown':
      return {
        ...base,
        title: `⚠️ 訂單已送出但結果不明：${name}`,
        text: `${name}\n${result.error}\n請到商城「訂單查詢」確認，避免重複下單。`,
      };
    default:
      return {
        ...base,
        title: `❌ 自動下單失敗：${name}`,
        text: `${name}\n${result.error}\n${result.url}`,
      };
  }
}
