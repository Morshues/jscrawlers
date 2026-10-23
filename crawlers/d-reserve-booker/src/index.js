import { once } from 'node:events';
import { runCrawler, parseArgs, createNotifier, readJson } from '@jscrawlers/core';

import { loadConfig } from './config.js';
import { createBooker, NAME } from './booker.js';
import { createApp } from './server.js';
import { buildBookingPayload } from './notify.js';

// Start through main.js, which loads the env file from outside the repo.
if (process.env.BOOKER_STARTED_BY_MAIN !== '1') {
  console.error(
    '[d-reserve-booker] start with: node crawlers/d-reserve-booker/src/main.js --serve',
  );
  process.exit(1);
}

const { values, positionals } = parseArgs({
  serve: { type: 'boolean', default: false }, // listen for watcher requests
  book: { type: 'boolean', default: false }, // <date> <roomCode> <planCode>: one attempt by hand
  confirm: { type: 'boolean', default: false }, // --book really submits
  status: { type: 'boolean', default: false },
  'test-notify': { type: 'string' }, // booking | dry-run | failed: a sample result, real format
});

/** Sample results for --test-notify, shaped like what booker.run hands to notify. */
const TEST_RESULTS = {
  booking: [
    {
      ok: true,
      submitted: true,
      nextUrl: 'https://d-reserve.jp/guest-reserve-front/GRES018F04500/GRES018A01',
    },
    true,
  ],
  'dry-run': [{ ok: true, submitted: false }, false],
  failed: [{ ok: false, submitted: false, error: '測試用的失敗原因' }, true],
};

/** Every configured channel gets a message built exactly like a real one. */
async function testNotify(kind, notify) {
  const sample = TEST_RESULTS[kind];
  if (!sample) {
    throw new Error(`--test-notify takes one of: ${Object.keys(TEST_RESULTS).join(', ')}`);
  }
  const [result, submit] = sample;
  const cell = {
    salesDate: '2026-11-01',
    roomCode: 'RM00000000',
    roomName: '測試房型',
    planCode: 'PL00000000',
    memberPrice: 12345,
  };
  const payload = buildBookingPayload(cell, result, { submit });
  const results = await notify({ ...payload, title: `[測試] ${payload.title}`, test: true });
  console.log(JSON.stringify(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function serve({ config, booker, log, signal }) {
  const server = createApp({ config, booker, log }).listen(config.server.port, config.server.host);
  await once(server, 'listening');
  log.info(
    `listening on ${config.server.host}:${config.server.port} — ` +
      (config.server.submit
        ? '⚠️ BOOKER_SUBMIT=true：受理後會真的送出訂房'
        : 'BOOKER_SUBMIT=false：只演練，不送出'),
  );

  await once(signal, 'abort');
  server.close();
  await booker.idle();
}

await runCrawler(NAME, async ({ log, signal }) => {
  const config = loadConfig(process.env, { serve: values.serve });
  const notify = createNotifier({ channels: config.notify.channels, logger: log });
  const booker = createBooker({ config, log, notify, signal });

  if (values.status) {
    const state = (await readJson(NAME, 'booking-state.json')) ?? {};
    console.log(
      JSON.stringify({ ...(await booker.status()), attempts: state.attempts ?? {} }, null, 2),
    );
    return;
  }

  if (values['test-notify'] !== undefined) return testNotify(values['test-notify'], notify);

  if (values.book) {
    const [salesDate, roomCode, planCode] = positionals;
    if (!salesDate || !roomCode || !planCode) {
      throw new Error('usage: --book <YYYY-MM-DD> <roomCode> <planCode> [--confirm]');
    }
    const result = await booker.run(
      { salesDate, roomCode, planCode, memberPrice: null },
      { submit: values.confirm },
    );
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (values.serve) return serve({ config, booker, log, signal });

  throw new Error('nothing to do: pass --serve, --book, --status or --test-notify');
});
