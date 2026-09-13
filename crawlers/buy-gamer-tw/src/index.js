import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runCrawler,
  parseArgs,
  appendJsonl,
  saveJson,
  readJson,
  outputDir,
  createNotifier,
  pollLoop,
} from '@jscrawlers/core';

import { loadConfig, parseDuration } from './config.js';
import { fetchSnapshot } from './item.js';
import { diffItems } from './diff.js';
import { selectAlerts, buildPayloads } from './watch.js';

const NAME = 'buy-gamer-tw';
const STATE_FILE = 'state.json';

const { values } = parseArgs({
  interval: { type: 'string' }, // "5m" -> stay resident; absent -> one shot
  'dry-run': { type: 'boolean', default: false },
  'notify-test': { type: 'boolean', default: false },
});

/** Events are sharded by month so no single file grows without bound. */
function eventsFile(ts) {
  return `events-${ts.slice(0, 4)}${ts.slice(5, 7)}.jsonl`;
}

function stampOf(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function pruneRaw(keep, log) {
  const dir = await outputDir(NAME, 'raw');
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.html.gz')).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
  log.debug(`raw pages kept: ${Math.min(files.length, keep)}`);
}

/**
 * One full cycle: fetch every watched product, diff against what is stored,
 * persist the changes, then decide whether anything is worth a notification.
 */
async function pollOnce({ config, log, signal, notify, dryRun }) {
  const startedAt = Date.now();
  const state = (await readJson(NAME, STATE_FILE)) ?? {};
  const previous = state.items ?? {};

  const snapshot = await fetchSnapshot(config, { logger: log, signal });
  const fetched = Object.values(snapshot.items);

  for (const item of fetched) {
    log.info(
      `  ${item.sn} ${item.buyable ? '✔ 可下單' : '✘ 售罄  '} ` +
        `${item.status ?? '狀態不明'}  ${item.title}`,
    );
  }
  for (const failure of snapshot.failures) log.warn(`  ${failure.error}`);

  // A product that failed this round keeps whatever was last known about it.
  // Dropping it would look like a change, and re-adding it later would look
  // like a restock — both are alerts nobody asked for.
  const watching = new Set(config.items.map((item) => item.sn));
  const items = {};
  for (const { sn } of config.items) {
    const next = snapshot.items[sn] ?? previous[sn];
    if (next) items[sn] = next;
  }

  const events = diffItems(previous, snapshot.items, { ts: snapshot.fetchedAt, watching });
  const changes = events.filter((event) => event.kind !== 'seed');
  for (const event of changes) log.info(`  ${event.kind}: ${event.title}`);

  const { buyable, fresh, seeded, notified } = selectAlerts(
    Object.values(items),
    previous,
    config,
    state.notified ?? {},
    { now: Date.parse(snapshot.fetchedAt) },
  );

  log.info(
    `${config.items.length} 件商品，${buyable.length} 件可下單，` +
      `${changes.length} 項變更，${snapshot.failures.length} 件抓取失敗`,
  );

  if (dryRun) {
    for (const payload of buildPayloads(fresh, config))
      log.info(`[dry-run] 將發出通知：\n${payload.title}\n${payload.text}`);
    if (fresh.length === 0) log.info('[dry-run] 沒有需要通知的商品');
    return { snapshot, events, buyable, fresh, notified: false };
  }

  // Events are appended before the state advances. A crash in between then
  // re-derives the same events next poll — a duplicate row, which is visible
  // and fixable. The other order would drop the restock from history for good,
  // and catching those is the whole point.
  if (events.length > 0) {
    await appendJsonl(NAME, eventsFile(snapshot.fetchedAt), events);
  }

  await saveJson(NAME, STATE_FILE, {
    updatedAt: snapshot.fetchedAt,
    watching: [...watching],
    items,
    notified,
  });

  await appendJsonl(NAME, 'polls.jsonl', {
    ts: snapshot.fetchedAt,
    ok: snapshot.failures.length === 0,
    durationMs: Date.now() - startedAt,
    items: fetched.length,
    buyable: buyable.length,
    changes: changes.length,
    failures: snapshot.failures.length,
  });

  if (config.poll.keepRaw && snapshot.raw.length > 0) {
    const dir = await outputDir(NAME, 'raw');
    const stamp = stampOf(snapshot.fetchedAt);
    for (const page of snapshot.raw) {
      await fs.writeFile(path.join(dir, `${stamp}-${page.sn}.html.gz`), gzipSync(page.html));
    }
    await pruneRaw(config.poll.rawKeep, log);
  }

  if (seeded.length > 0 && !config.notify.onFirstRun) {
    log.info(`首次觀測，${seeded.length} 件商品目前已可下單（不發通知）：`);
    for (const item of seeded) log.info(`  ${item.sn} ${item.title}`);
    log.info('若想連這些也收到通知，設定 BUYGAMER_NOTIFY_ON_FIRST_RUN=true');
  }

  // A notification failure must never abort the run: the history is the part we
  // cannot reconstruct later, and it is already safely on disk by this point.
  for (const payload of buildPayloads(fresh, config, { detectedAt: snapshot.fetchedAt })) {
    log.warn(`偵測到可下單：${payload.title}`);
    await notify(payload, { signal });
  }

  return { snapshot, events, buyable, fresh, notified: fresh.length > 0 };
}

await runCrawler(NAME, async ({ log, signal }) => {
  const config = loadConfig();
  const notify = createNotifier({ channels: config.notify.channels, logger: log });

  if (values['notify-test']) {
    const payload = {
      source: NAME,
      event: 'test',
      title: '[測試] buy-gamer-tw 通知測試',
      text:
        `通知管道連線測試。\n監看 ${config.items.length} 件商品：\n` +
        config.items.map((item) => `• ${item.url}`).join('\n'),
      detectedAt: new Date().toISOString(),
      matches: [],
    };
    const results = await notify(payload, { signal });
    if (results.length === 0) log.warn('BUYGAMER_NOTIFY_CHANNELS is empty — nothing was sent');
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return results;
  }

  const dryRun = values['dry-run'];
  log.info(`監看 ${config.items.map((item) => item.sn).join(', ')}`);

  const intervalMs = values.interval
    ? parseDuration(values.interval, '--interval')
    : config.poll.intervalMs;

  if (!values.interval) return pollOnce({ config, log, signal, notify, dryRun });

  // Resident mode. A single failed poll must not end the watch — the next one
  // may well be the restock we are waiting for.
  return pollLoop({
    task: () => pollOnce({ config, log, signal, notify, dryRun }),
    intervalMs,
    signal,
    logger: log,
  });
});
