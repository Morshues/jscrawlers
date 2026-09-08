import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchJson, fetchText, fetchWithRetry, HttpError } from '../src/http.js';

/** Start a throwaway server whose handler is swapped per test. */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('returns the body on success', async () => {
  const s = await serve((_req, res) => res.end('hello'));
  try {
    assert.equal(await fetchText(s.url), 'hello');
  } finally {
    await s.close();
  }
});

test('parses JSON', async () => {
  const s = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  try {
    assert.deepEqual(await fetchJson(s.url), { ok: true });
  } finally {
    await s.close();
  }
});

test('retries a 503 then succeeds', async () => {
  let hits = 0;
  const s = await serve((_req, res) => {
    hits++;
    if (hits < 3) {
      res.statusCode = 503;
      res.end('busy');
      return;
    }
    res.end('recovered');
  });
  try {
    const body = await fetchText(s.url, { retryDelay: 10 });
    assert.equal(body, 'recovered');
    assert.equal(hits, 3);
  } finally {
    await s.close();
  }
});

test('does not retry a 404 and throws HttpError', async () => {
  let hits = 0;
  const s = await serve((_req, res) => {
    hits++;
    res.statusCode = 404;
    res.end('nope');
  });
  try {
    await assert.rejects(fetchText(s.url, { retryDelay: 10 }), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      return true;
    });
    assert.equal(hits, 1, 'a 404 must not be retried');
  } finally {
    await s.close();
  }
});

test('gives up after the configured retries', async () => {
  const s = await serve((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    await assert.rejects(fetchWithRetry(s.url, { retries: 1, retryDelay: 10 }), HttpError);
  } finally {
    await s.close();
  }
});
