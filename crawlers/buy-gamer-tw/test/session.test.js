import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login, LoginError } from '../src/session.js';

const BASE = 'https://buy.gamer.com.tw';
const LOGGED_OUT = { code: 1, message: '請先登入。' };
const EMPTY = { code: 2, message: '購物車沒有商品' };

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buygamer-'));
  return { sessionFile: path.join(dir, 'session.json'), dataDir: dir };
}

/**
 * Swap global fetch for a router: `routes(url, init) -> { body, cookies? }`.
 * Every call is recorded with the Cookie header it carried.
 */
function mockFetch(t, routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url).split('?')[0],
      method: init.method,
      cookie: init.headers.cookie,
    });
    const { body, cookies = [] } = routes(String(url), init);
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const ORDER = { user: 'me', password: 'pw', cookies: '' };

test('a saved session that still works is used without logging in', async (t) => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.sessionFile, JSON.stringify({ cookies: { BAHARUNE: 'ok' } }));
  const calls = mockFetch(t, (url, init) => ({
    body: init.headers.cookie.includes('BAHARUNE=ok') ? EMPTY : LOGGED_OUT,
  }));

  const { via } = await login(ORDER, paths, { baseUrl: BASE });
  assert.equal(via, 'session');
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${BASE}/ajax/shopping_cart_get.php`],
  );
});

test('stale session -> pasted cookies -> saved for next time', async (t) => {
  const paths = tmpPaths();
  fs.writeFileSync(paths.sessionFile, JSON.stringify({ cookies: { BAHARUNE: 'old' } }));
  mockFetch(t, (url, init) => ({
    body: init.headers.cookie.includes('BAHARUNE=new') ? EMPTY : LOGGED_OUT,
  }));

  const { via } = await login({ ...ORDER, cookies: 'BAHAID=me; BAHARUNE=new' }, paths, {
    baseUrl: BASE,
  });
  assert.equal(via, 'cookies');
  const saved = JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8'));
  assert.deepEqual(saved.cookies, { BAHAID: 'me', BAHARUNE: 'new' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.sessionFile).mode & 0o777, 0o600);
  }
});

test('password login posts no captcha field and keeps the cookies it is given', async (t) => {
  const paths = tmpPaths();
  let posted;
  const calls = mockFetch(t, (url, init) => {
    if (url.endsWith('/login.php')) return { body: '<html>', cookies: ['nologinuser=x; path=/'] };
    if (url.endsWith('/do_login.php')) {
      posted = init.body;
      return { body: { data: { userid: 'me' } }, cookies: ['BAHARUNE=fresh; path=/'] };
    }
    return { body: init.headers.cookie.includes('BAHARUNE=fresh') ? EMPTY : LOGGED_OUT };
  });

  const { via } = await login(ORDER, paths, { baseUrl: BASE });
  assert.equal(via, 'password');
  assert.deepEqual([...posted.keys()], ['userid', 'password', 'autoLogin', 'twoStepAuth']);
  assert.equal(posted.get('userid'), 'me');
  const doLogin = calls.find((call) => call.url.endsWith('/do_login.php'));
  assert.equal(doLogin.cookie, 'nologinuser=x');
});

test('a refused password login says to paste cookies instead', async (t) => {
  const paths = tmpPaths();
  mockFetch(t, (url) => {
    if (url.endsWith('/do_login.php'))
      return { body: { error: { message: '請勾選我不是機器人' } } };
    if (url.endsWith('/login.php')) return { body: '<html>' };
    return { body: LOGGED_OUT };
  });

  await assert.rejects(login(ORDER, paths, { baseUrl: BASE }), (error) => {
    assert.ok(error instanceof LoginError);
    assert.match(error.message, /請勾選我不是機器人/);
    assert.match(error.message, /BUYGAMER_COOKIES/);
    return true;
  });
  assert.equal(fs.existsSync(paths.sessionFile), false);
});

test('no working cookies and no password fails without touching the login page', async (t) => {
  const calls = mockFetch(t, () => ({ body: LOGGED_OUT }));
  await assert.rejects(
    login({ user: '', password: '', cookies: 'BAHARUNE=dead' }, tmpPaths(), { baseUrl: BASE }),
    /cookie 已失效且未設定帳密/,
  );
  assert.ok(calls.every((call) => !call.url.includes('user.gamer.com.tw')));
});
