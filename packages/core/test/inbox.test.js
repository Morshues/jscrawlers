import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInbox, parseCommand, parseTelegramUpdates } from '../src/inbox.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** One getUpdates result entry. */
function update(id, text, { chatId = 42, date = 1_790_000_000 } = {}) {
  return { update_id: id, message: { message_id: id, chat: { id: chatId }, date, text } };
}

// ── parsing commands ────────────────────────────────────────────────────────

test('stop and ack are the same command', () => {
  assert.deepEqual(parseCommand('/stop'), { command: 'stop', filter: null });
  assert.deepEqual(parseCommand('/ack'), { command: 'stop', filter: null });
  assert.deepEqual(parseCommand('  /STOP  '), { command: 'stop', filter: null });
});

test('a command can carry a filter, and groups suffix the bot name', () => {
  assert.deepEqual(parseCommand('/stop 2026-10-09'), { command: 'stop', filter: '2026-10-09' });
  assert.deepEqual(parseCommand('/stop@my_bot 特別室'), { command: 'stop', filter: '特別室' });
});

test('conversation is not a command', () => {
  for (const text of ['stop', 'hello', '/start', '/stopwatch', '', null]) {
    assert.equal(parseCommand(text), null, JSON.stringify(text));
  }
});

// ── reading updates ─────────────────────────────────────────────────────────

test('only the configured chat is heard', () => {
  const body = { ok: true, result: [update(1, '/stop'), update(2, '/stop', { chatId: 999 })] };
  const { messages } = parseTelegramUpdates(body, { chatId: 42 });
  assert.deepEqual(
    messages.map((m) => m.text),
    ['/stop'],
  );
});

test('the offset advances past every update, even ignored ones', () => {
  const body = { ok: true, result: [update(7, 'hello', { chatId: 999 }), update(8, '/stop')] };
  const { offset } = parseTelegramUpdates(body, { chatId: 42 });
  // Leaving 7 unconfirmed would replay that message on every future poll.
  assert.equal(offset, 9);
});

test('nothing waiting leaves the offset alone', () => {
  assert.deepEqual(parseTelegramUpdates({ ok: true, result: [] }), { messages: [], offset: null });
  assert.deepEqual(parseTelegramUpdates(null), { messages: [], offset: null });
});

// ── the reader ──────────────────────────────────────────────────────────────

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const env = (origin) => ({
  TELEGRAM_BOT_TOKEN: 'token',
  TELEGRAM_CHAT_ID: '42',
  TELEGRAM_API_BASE: origin,
});

test('commands come back with the offset to store next time', async () => {
  const seen = [];
  const s = await serve((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: [update(11, '/stop 2026-10-09')] }));
  });
  try {
    const read = createInbox({ channels: ['telegram'], env: env(s.origin), logger: silent });
    const result = await read({ offset: 5 });

    assert.deepEqual(result.commands, [
      { command: 'stop', filter: '2026-10-09', channel: 'telegram', ts: result.commands[0].ts },
    ]);
    assert.equal(result.offset, 12);
    assert.match(seen[0], /offset=5/);
  } finally {
    await s.close();
  }
});

test('a webhook-shaped 409 is a warning, not the end of the poll', async () => {
  const warnings = [];
  const s = await serve((_req, res) => {
    res.statusCode = 409;
    res.end("Conflict: can't use getUpdates method while webhook is active");
  });
  try {
    const read = createInbox({
      channels: ['telegram'],
      env: env(s.origin),
      logger: { ...silent, warn: (message) => warnings.push(message) },
    });
    assert.deepEqual(await read({ offset: 5 }), { commands: [], offset: 5 });
    assert.match(warnings.join('\n'), /webhook/);
  } finally {
    await s.close();
  }
});

test('a channel that cannot receive is ignored rather than fatal', async () => {
  const read = createInbox({ channels: ['webhook'], env: {}, logger: silent });
  assert.deepEqual(await read({ offset: null }), { commands: [], offset: null });
});
