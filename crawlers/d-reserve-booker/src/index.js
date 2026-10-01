import { once } from 'node:events';
import { runCrawler, parseArgs, createNotifier, readJson, saveJson } from '@jscrawlers/core';

import { loadConfig } from './config.js';
import { createBooker, NAME } from './booker.js';
import { createApp } from './server.js';

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
  reset: { type: 'boolean', default: false }, // unlock after a booking has been dealt with
  status: { type: 'boolean', default: false },
});

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
  if (values.reset) {
    const state = (await readJson(NAME, 'booking-state.json')) ?? {};
    await saveJson(NAME, 'booking-state.json', { ...state, locked: false, attempts: {} });
    log.info(`unlocked${state.booked ? ` (was ${state.booked.key})` : ''}; attempt counts cleared`);
    return;
  }

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

  throw new Error('nothing to do: pass --serve, --book, --status or --reset');
});
