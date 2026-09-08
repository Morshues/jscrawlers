import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNotifier } from '../src/notify.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Collect every request a channel makes against a throwaway server. */
async function serve(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      handler(req, res, received.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const payload = { source: 'test', event: 'availability', title: 'Room open', text: 'line one' };

test('webhook posts the whole payload as JSON with custom headers', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  try {
    const notify = createNotifier({
      channels: ['webhook'],
      logger: silent,
      env: {
        NOTIFY_WEBHOOK_URL: `${s.origin}/hook`,
        NOTIFY_WEBHOOK_HEADERS: '{"Authorization":"Bearer secret"}',
      },
    });

    assert.deepEqual(await notify(payload), [{ channel: 'webhook', ok: true }]);
    assert.equal(s.received[0].headers.authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(s.received[0].body), payload);
  } finally {
    await s.close();
  }
});

test('malformed webhook headers are ignored rather than fatal', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  try {
    const notify = createNotifier({
      channels: ['webhook'],
      logger: silent,
      env: { NOTIFY_WEBHOOK_URL: s.origin, NOTIFY_WEBHOOK_HEADERS: 'not json' },
    });
    assert.equal((await notify(payload))[0].ok, true);
  } finally {
    await s.close();
  }
});

test('telegram sends the text and escapes HTML', async () => {
  const s = await serve((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  try {
    const notify = createNotifier({
      channels: ['telegram'],
      logger: silent,
      env: {
        TELEGRAM_API_BASE: s.origin,
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_CHAT_ID: '-100',
      },
    });

    await notify({ ...payload, title: 'a < b & c', text: '<script>' });
    assert.equal(s.received[0].url, '/bot123:abc/sendMessage');
    const sent = JSON.parse(s.received[0].body);
    assert.equal(sent.chat_id, '-100');
    assert.match(sent.text, /a &lt; b &amp; c/);
    assert.match(sent.text, /&lt;script&gt;/);
  } finally {
    await s.close();
  }
});

test('command receives the payload as JSON on stdin', async () => {
  const file = `${process.env.TMPDIR ?? '/tmp'}/notify-test-${process.pid}.json`;
  const notify = createNotifier({
    channels: ['command'],
    logger: silent,
    env: { NOTIFY_COMMAND: `cat > ${file}` },
  });

  assert.deepEqual(await notify(payload), [{ channel: 'command', ok: true }]);
  const { readFile, unlink } = await import('node:fs/promises');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), payload);
  await unlink(file);
});

test('a failing command is reported, not thrown', async () => {
  const notify = createNotifier({
    channels: ['command'],
    logger: silent,
    env: { NOTIFY_COMMAND: 'echo boom >&2; exit 3' },
  });

  const [result] = await notify(payload);
  assert.equal(result.ok, false);
  assert.match(result.error, /exit code 3/);
  assert.match(result.error, /boom/);
});

test('one broken channel never stops the others', async () => {
  const s = await serve((_req, res) => res.end('ok'));
  try {
    const notify = createNotifier({
      channels: ['webhook', 'command'],
      logger: silent,
      env: { NOTIFY_WEBHOOK_URL: s.origin, NOTIFY_COMMAND: 'exit 1' },
    });

    const results = await notify(payload);
    assert.deepEqual(
      results.map((r) => [r.channel, r.ok]),
      [
        ['webhook', true],
        ['command', false],
      ],
    );
    assert.equal(s.received.length, 1, 'the healthy channel still delivered');
  } finally {
    await s.close();
  }
});

test('a channel missing its config fails that channel only', async () => {
  const notify = createNotifier({ channels: ['telegram'], logger: silent, env: {} });
  const [result] = await notify(payload);
  assert.equal(result.ok, false);
  assert.match(result.error, /TELEGRAM_BOT_TOKEN/);
});

test('no channels configured is a no-op, not an error', async () => {
  const notify = createNotifier({ channels: [], logger: silent, env: {} });
  assert.deepEqual(await notify(payload), []);
});

test('an unknown channel name is dropped with a warning', async () => {
  const warnings = [];
  const notify = createNotifier({
    channels: ['carrier-pigeon'],
    logger: { ...silent, warn: (msg) => warnings.push(msg) },
    env: {},
  });
  assert.deepEqual(await notify(payload), []);
  assert.match(warnings[0], /unknown notify channel/);
});
