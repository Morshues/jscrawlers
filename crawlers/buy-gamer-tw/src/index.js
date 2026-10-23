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

import { loadConfig, loadOrderConfig, parseDuration, parseItems } from './config.js';
import { fetchSnapshot } from './item.js';
import { diffItems } from './diff.js';
import { selectAlerts, buildPayloads, selectOrders } from './watch.js';
import { privatePaths, readOrderEnv } from './private.js';
import { login } from './session.js';
import { placeOrder, buildOrderPayload, clearLock, orderProgress, ordersDone } from './orderer.js';

const NAME = 'buy-gamer-tw';
const STATE_FILE = 'state.json';

const FLAGS = {
  interval: { type: 'string' }, // "5m" -> stay resident; absent -> one shot
  'dry-run': { type: 'boolean', default: false },
  'notify-test': { type: 'boolean', default: false },
  order: { type: 'string' }, // sn or URL: order it once, now
  'order-recon': { type: 'string' }, // sn or URL: cart it and save the checkout pages
  'order-reset': { type: 'string' }, // sn: forget its orders, count from zero again
  'login-test': { type: 'boolean', default: false },
};
const { values } = parseArgs(FLAGS);

// core's parseArgs is lenient, so a typo (or a stray full-width comma after
// --login-test) would otherwise fall through to a watch run that orders things.
const unknown = Object.keys(values).filter((flag) => !(flag in FLAGS));
if (unknown.length > 0) {
  console.error(`[${NAME}] 未知參數：${unknown.map((flag) => `--${flag}`).join(' ')}`);
  console.error(
    `[${NAME}] 可用：${Object.keys(FLAGS)
      .map((flag) => `--${flag}`)
      .join(' ')}`,
  );
  process.exit(2);
}

function ordersFor({ config, orderCtx, buyable, fresh }) {
  return selectOrders({
    buyable,
    fresh,
    allowed: config.order.items,
    progress: (sn) => orderProgress(orderCtx.paths, sn, config.order.count),
  });
}

/** "42810 1/1, 41435 0/2" for the log. */
function describeProgress(items, count) {
  return items.map((item) => `${item.sn} ${item.placed}/${count}`).join(', ');
}

/** The private half of ordering: paths outside the repo + the order env file. */
function loadOrderContext() {
  const paths = privatePaths();
  return { paths, order: loadOrderConfig(readOrderEnv(paths.envFile)) };
}

function logOrderResult(result, log) {
  const name = `${result.sn} ${result.title ?? ''}`.trim();
  const how = `NT ${result.total ?? result.price}・${result.payment ?? ''}・${result.ship ?? ''}`;
  switch (result.status) {
    case 'submitted':
      log.warn(
        `已下單：${name}（${how}）訂單編號 ${result.orderNumber ?? '未讀到'}` +
          `${result.placed ? `，第 ${result.placed} 張` : ''}`,
      );
      break;
    case 'ready':
      log.warn(`確認訂單資料無誤，未送出：${name}（${how}）`);
      if (!result.recon) log.warn('  BUYGAMER_ORDER_SUBMIT=false — 改成 true 才會真的送出');
      break;
    case 'locked':
      log.info(
        `${name} 已下滿 ${result.placed}/${result.count} 張，略過（--order-reset ${result.sn} 重新計算）`,
      );
      break;
    case 'submit-unknown':
      log.error(`訂單已送出但結果不明：${name}：${result.error}（請到商城確認）`);
      break;
    default:
      log.error(`自動下單失敗：${name}：${result.error}`);
  }
  for (const file of result.savedPages ?? []) log.info(`  頁面已存：${file}`);
}

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
async function pollOnce({ config, log, signal, notify, dryRun, orderCtx }) {
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
    if (orderCtx) {
      for (const item of ordersFor({ config, orderCtx, buyable, fresh }))
        log.info(`[dry-run] 將自動下單：${item.sn} ${item.title}`);
    }
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

  // Ordering goes before the notification: when a restock lasts minutes, the
  // second a notify call takes is better spent at the checkout.
  if (orderCtx) {
    for (const item of ordersFor({ config, orderCtx, buyable, fresh })) {
      const { placed } = orderProgress(orderCtx.paths, item.sn, config.order.count);
      log.warn(`自動下單：${item.sn} ${item.title}（第 ${placed + 1}/${config.order.count} 張）`);
      const result = await placeOrder(item, { ...orderCtx, config, logger: log, signal });
      logOrderResult(result, log);
      if (result.status !== 'locked') await notify(buildOrderPayload(result), { signal });
    }
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
  const watching = !(
    values['login-test'] ||
    values['order-reset'] ||
    values.order ||
    values['order-recon']
  );
  const config = loadConfig(process.env, { watching });
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

  if (values['login-test']) {
    const { paths, order } = loadOrderContext();
    const { via, cart } = await login(order, paths, {
      baseUrl: config.baseUrl,
      logger: log,
      signal,
    });
    log.info(
      `登入成功（${via}），購物車 ${cart.items.length} 件商品，session 存在 ${paths.sessionFile}`,
    );
    for (const entry of cart.items) log.info(`  ${entry.sn} ×${entry.qty} ${entry.title}`);
    return { via, cart };
  }

  if (values['order-reset']) {
    const [{ sn }] = parseItems(values['order-reset'], config.baseUrl, '--order-reset');
    clearLock(privatePaths(), sn);
    log.info(`sn=${sn} 下單次數歸零，可以再次自動下單`);
    return { sn };
  }

  const manual = values.order ?? values['order-recon'];
  if (manual) {
    const recon = values.order === undefined;
    const flag = recon ? '--order-recon' : '--order';
    const [item] = parseItems(manual, config.baseUrl, flag);
    const orderCtx = loadOrderContext();
    const result = await placeOrder(item, { ...orderCtx, config, logger: log, signal, recon });
    logOrderResult(result, log);
    if (!recon && result.status !== 'locked') await notify(buildOrderPayload(result), { signal });
    if (result.status === 'failed') process.exitCode = 1;
    return result;
  }

  const dryRun = values['dry-run'];
  // Read up front, so a missing or world-readable order env fails the first
  // run rather than the restock.
  const orderCtx = config.order.enabled ? loadOrderContext() : null;
  if (orderCtx) {
    log.info(
      `自動下單已啟用（上限 NT ${orderCtx.order.maxPrice}，每件 ${config.order.count} 張` +
        `${config.order.items ? `，限 ${[...config.order.items].join(', ')}` : ''}）`,
    );
  }
  log.info(`監看 ${config.items.map((item) => item.sn).join(', ')}`);

  const intervalMs = values.interval
    ? parseDuration(values.interval, '--interval')
    : config.poll.intervalMs;

  if (!values.interval) return pollOnce({ config, log, signal, notify, dryRun, orderCtx });

  // Resident mode. A single failed poll must not end the watch — the next one
  // may well be the restock we are waiting for. With ordering on, the watch
  // has a goal, and reaching it (every product ordered BUYGAMER_ORDER_COUNT
  // times) ends it.
  const finished = new AbortController();
  const checkFinished = () => {
    if (!orderCtx || dryRun) return false;
    const { done, items } = ordersDone(config, orderCtx.paths);
    if (!done) return false;
    log.info(`全部下單完成（${describeProgress(items, config.order.count)}），結束監看`);
    finished.abort();
    return true;
  };
  if (checkFinished()) return { runs: 0, failures: 0, finished: true };

  const loop = await pollLoop({
    task: async () => {
      await pollOnce({ config, log, signal, notify, dryRun, orderCtx });
      checkFinished();
    },
    intervalMs,
    signal: AbortSignal.any([signal, finished.signal]),
    logger: log,
  });
  return { ...loop, finished: finished.signal.aborted };
});
