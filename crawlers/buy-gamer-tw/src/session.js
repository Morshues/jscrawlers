import fs from 'node:fs';
import { createCookieJar, requestWithCookies } from '@jscrawlers/core';
import { writePrivate } from './private.js';

/**
 * A logged-in 巴哈 session, as a cookie jar.
 *
 * Order of preference, cheapest and least intrusive first:
 *   1. session.json from a previous run, if 巴哈 still accepts it
 *   2. BUYGAMER_COOKIES pasted from a logged-in browser
 *   3. userid + password to ajax/do_login.php
 *
 * The login page carries reCAPTCHA Enterprise. Step 3 sends the form without
 * any captcha field and takes 巴哈's answer as final: if it insists on the
 * captcha, a human logs in once in a browser and pastes the cookies. A captcha
 * token is never replayed or forged here.
 */

export const USER_BASE = 'https://user.gamer.com.tw';
const USER_AGENT =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const COOKIE_HINT =
  '在瀏覽器登入巴哈一次（勾「保持登入狀態」），從開發者工具複製 BAHAID / BAHARUNE / BAHAENUR 三個 cookie，' +
  '以 BUYGAMER_COOKIES=BAHAID=...; BAHARUNE=...; BAHAENUR=... 寫進 order env 檔';

export class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoginError';
  }
}

const TIMEOUT_MS = 20_000;

/** core's requestWithCookies with browser-ish headers for gamer.com.tw and a timeout. */
export function request(jar, url, { headers = {}, signal, ...options } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return requestWithCookies(jar, url, {
    ...options,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      ...headers,
    },
  });
}

/** XHR-style JSON call, as the site's own jQuery makes it. */
export async function requestJson(jar, url, { headers = {}, referer, ...options } = {}) {
  const { response } = await request(jar, url, {
    ...options,
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      ...(referer ? { referer, origin: new URL(referer).origin } : {}),
      ...headers,
    },
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(
      `expected JSON from ${url.split('?')[0]}, got HTTP ${response.status}: ${snippet}`,
    );
  }
}

/**
 * What is in the shopping cart, which doubles as the session check: logged out,
 * `ajax/shopping_cart_get.php` answers `{"code":1,"message":"請先登入。"}`.
 * Logged in it is either `{ code: 2, message }` (empty) or the items keyed by
 * index, each `{ sn, title, qty, platform }`.
 *
 * @returns {{ loggedIn: boolean, items: { sn: string, title: string, qty: number }[], message?: string }}
 */
export function parseCart(body) {
  if (body && typeof body.message === 'string') {
    if (body.message.includes('登入')) return { loggedIn: false, items: [], message: body.message };
    return { loggedIn: true, items: [], message: body.message };
  }
  const items = Object.values(body ?? {})
    .filter((entry) => entry && typeof entry === 'object' && entry.sn !== undefined)
    .map((entry) => ({ sn: String(entry.sn), title: entry.title, qty: Number(entry.qty) }));
  return { loggedIn: true, items };
}

export async function fetchCart(jar, { baseUrl, logger, signal }) {
  const body = await requestJson(jar, new URL('/ajax/shopping_cart_get.php', baseUrl).href, {
    referer: `${baseUrl}/`,
    logger,
    signal,
  });
  return parseCart(body);
}

function readSession(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(file, jar) {
  writePrivate(
    file,
    `${JSON.stringify({ savedAt: new Date().toISOString(), cookies: jar.toJSON() }, null, 2)}\n`,
  );
}

/** POST do_login.php without a captcha; throws LoginError with 巴哈's own message. */
async function passwordLogin(jar, { user, password }, { logger, signal }) {
  // A browser has the login page's cookies (nologinuser, ckBahamutCsrfToken)
  // before it posts; arrive the same way.
  const page = await request(jar, `${USER_BASE}/login.php`, { logger, signal });
  await page.response.body?.cancel();

  const form = new FormData();
  form.set('userid', user);
  form.set('password', password);
  form.set('autoLogin', 'T');
  form.set('twoStepAuth', '');

  let body;
  try {
    body = await requestJson(jar, `${USER_BASE}/ajax/do_login.php`, {
      method: 'POST',
      body: form,
      referer: `${USER_BASE}/login.php`,
      logger,
      signal,
    });
  } catch (error) {
    throw new LoginError(`帳密登入失敗：${error.message}`);
  }
  if (body?.error) {
    const message = body.error.message ?? JSON.stringify(body.error);
    throw new LoginError(
      `帳密登入被拒：${message}。若是要求人機驗證，請改用 cookie：${COOKIE_HINT}`,
    );
  }
}

/**
 * A jar that 巴哈 currently treats as logged in, saved for next time.
 *
 * @param {{ user: string, password: string, cookies: string }} order loadOrderConfig()
 * @param {{ sessionFile: string }} paths privatePaths()
 * @param {{ baseUrl: string, logger?: object, signal?: AbortSignal }} options
 * @returns {Promise<{ jar: object, via: 'session' | 'cookies' | 'password', cart: object }>}
 */
export async function login(order, paths, { baseUrl, logger, signal }) {
  const attempts = [];
  const saved = readSession(paths.sessionFile);
  if (saved?.cookies) attempts.push(['session', () => createCookieJar(saved.cookies)]);
  if (order.cookies) attempts.push(['cookies', () => createCookieJar(order.cookies)]);

  for (const [via, makeJar] of attempts) {
    const jar = makeJar();
    const cart = await fetchCart(jar, { baseUrl, logger, signal });
    if (cart.loggedIn) {
      logger?.debug(`logged in via ${via}`);
      saveSession(paths.sessionFile, jar);
      return { jar, via, cart };
    }
    logger?.info(`${via === 'session' ? '上次的 session' : 'BUYGAMER_COOKIES'} 已失效`);
  }

  if (!(order.user && order.password)) {
    throw new LoginError(`沒有可用的登入：cookie 已失效且未設定帳密。${COOKIE_HINT}`);
  }

  const jar = createCookieJar();
  await passwordLogin(jar, order, { logger, signal });
  const cart = await fetchCart(jar, { baseUrl, logger, signal });
  if (!cart.loggedIn) {
    throw new LoginError(`do_login.php 沒有回錯誤，但商城仍顯示未登入。${COOKIE_HINT}`);
  }
  saveSession(paths.sessionFile, jar);
  return { jar, via: 'password', cart };
}
