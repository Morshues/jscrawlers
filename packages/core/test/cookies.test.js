import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCookieJar, requestWithCookies } from '../src/cookies.js';

const response = (...lines) => ({ headers: { getSetCookie: () => lines } });

test('a jar seeds from a Cookie header string or a toJSON() map', () => {
  const fromHeader = createCookieJar(' BAHAID=me; BAHARUNE=a=b ;junk');
  assert.deepEqual(fromHeader.toJSON(), { BAHAID: 'me', BAHARUNE: 'a=b' });

  const fromJson = createCookieJar(fromHeader.toJSON());
  assert.equal(fromJson.header(), 'BAHAID=me; BAHARUNE=a=b');
  assert.equal(fromJson.get('BAHAID'), 'me');
});

test('a jar keeps the latest value and drops expired cookies', () => {
  const jar = createCookieJar({ A: '0' });
  jar.store(response('A=1; Path=/', 'B=2'));
  jar.store(response('B=; Max-Age=0'));
  assert.deepEqual(jar.toJSON(), { A: '1' });
});

test('requestWithCookies keeps Set-Cookie from every redirect hop', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ''}`);
    if (req.url === '/start') {
      res.writeHead(302, { location: '/next', 'set-cookie': 'S=1; Path=/' });
      return res.end();
    }
    res.writeHead(200, { 'set-cookie': 'T=2' });
    res.end('done');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const jar = createCookieJar('A=0');
    const { response: last, url } = await requestWithCookies(jar, `${base}/start`, {
      method: 'POST',
      body: 'x=1',
    });
    assert.equal(await last.text(), 'done');
    assert.equal(url, `${base}/next`);
    assert.deepEqual(seen, ['POST /start cookie=A=0', 'GET /next cookie=A=0; S=1']);
    assert.equal(jar.header(), 'A=0; S=1; T=2');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
