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
} from '@jscrawlers/core';

import { loadConfig, parseDuration } from './config.js';
import { fetchSnapshot } from './api.js';
import { diffSnapshots } from './diff.js';
import { selectNotifications, buildPayloads } from './watch.js';
import { readHistory, buildReport, formatReport } from './report.js';

const NAME = 'd-reserve-jp';
const STATE_FILE = 'state.json';

const { values } = parseArgs({
  interval: { type: 'string' }, // "5m" -> stay resident; absent -> one shot
  report: { type: 'boolean', default: false },
  since: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'notify-test': { type: 'boolean', default: false },
});

/**
 * Sleep that wakes immediately on Ctrl-C. A plain sleep would keep the process
 * alive for up to a full interval after the signal, which feels like a hang.
 */
function sleepUntilAborted(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Events are sharded by month so no single file grows without bound. */
function eventsFile(ts) {
  return `events-${ts.slice(0, 4)}${ts.slice(5, 7)}.jsonl`;
}

async function pruneRaw(keep, log) {
  const dir = await outputDir(NAME, 'raw');
  const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json.gz')).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    await fs.unlink(path.join(dir, name)).catch(() => {});
  }
  log.debug(`raw snapshots kept: ${Math.min(files.length, keep)}`);
}

/**
 * One full cycle: fetch, diff against the stored snapshot, persist the changes,
 * then decide whether anything is worth a notification.
 *
 * The two phases deliberately share a single fetch — running them separately
 * would double the request rate and let them disagree about the same minute.
 */
async function pollOnce({ config, log, signal, notify, dryRun }) {
  const startedAt = Date.now();
  const state = (await readJson(NAME, STATE_FILE)) ?? {};

  let snapshot;
  try {
    snapshot = await fetchSnapshot(config, { logger: log, signal });
  } catch (error) {
    if (!dryRun) {
      await appendJsonl(NAME, 'polls.jsonl', {
        ts: new Date().toISOString(),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
    }
    throw error;
  }

  // Must agree with diffSnapshots' own seeding test, which keys off an empty map.
  const seeding = Object.keys(state.cells ?? {}).length === 0;
  const cellCount = Object.keys(snapshot.cells).length;
  const available = Object.values(snapshot.cells).filter((cell) => cell.available);
  const events = diffSnapshots(state.cells, snapshot.cells, { ts: snapshot.fetchedAt });
  const changes = events.filter((event) => event.kind !== 'seed');

  log.info(
    `${Object.keys(snapshot.rooms).length} rooms x ${cellCount} cells, ` +
      `${available.length} available, ${events.length} events`,
  );
  for (const event of changes) {
    log.info(`  ${event.kind}: ${event.roomName} ${event.salesDate}`);
  }

  const { matches, fresh, notified } = selectNotifications(
    snapshot.cells,
    config,
    state.notified ?? {},
    { now: Date.parse(snapshot.fetchedAt) },
  );

  if (dryRun) {
    log.info(`[dry-run] ${matches.length} cells match the watch filter, ${fresh.length} are new`);
    for (const cell of matches)
      log.info(`  match: ${cell.salesDate} ${cell.roomName} 残${cell.stockNum}`);
    for (const payload of buildPayloads(fresh, config))
      log.info(`[dry-run] would notify:\n${payload.text}`);
    return { snapshot, events, matches, fresh, notified: false };
  }

  // Events are appended before the state advances. A crash in between then
  // re-derives the same events next poll — a duplicate row, which is visible and
  // fixable. The other order would drop the release from history for good, and
  // catching rare releases is the whole point.
  if (events.length > 0) {
    await appendJsonl(NAME, eventsFile(snapshot.fetchedAt), events);
  }

  await saveJson(NAME, STATE_FILE, {
    hotelCode: config.hotelCode,
    range: { from: config.fromDate, to: config.toDate },
    query: config.query,
    updatedAt: snapshot.fetchedAt,
    rooms: snapshot.rooms,
    cells: snapshot.cells,
    notified,
  });

  await appendJsonl(NAME, 'polls.jsonl', {
    ts: snapshot.fetchedAt,
    ok: true,
    durationMs: Date.now() - startedAt,
    cells: cellCount,
    available: available.length,
    changes: changes.length,
    matches: matches.length,
  });

  if (config.poll.keepRaw) {
    const dir = await outputDir(NAME, 'raw');
    const stamp = snapshot.fetchedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    await fs.writeFile(path.join(dir, `${stamp}.json.gz`), gzipSync(JSON.stringify(snapshot.raw)));
    await pruneRaw(config.poll.rawKeep, log);
  }

  // The first run has no baseline, so it cannot tell "just released" from "open
  // for weeks" — alerting on that would be a false release signal, and with an
  // unset watch filter it fires for whatever happens to be open. The matches are
  // logged instead, and `notified` above already recorded them so the next poll
  // does not replay them as a fresh edge.
  if (seeding && !config.notify.onFirstRun) {
    if (fresh.length > 0) {
      log.info(`baseline established; ${fresh.length} cell(s) already bookable (not alerted):`);
      for (const cell of fresh) log.info(`  ${cell.salesDate} ${cell.roomName} 残${cell.stockNum}`);
      log.info('set DRESERVE_NOTIFY_ON_FIRST_RUN=true to be alerted about these too');
    }
    return { snapshot, events, matches, fresh, notified: false };
  }

  // A notification failure must never abort the run: the history is the part we
  // cannot reconstruct later, and it is already safely on disk by this point.
  for (const payload of buildPayloads(fresh, config, { detectedAt: snapshot.fetchedAt })) {
    log.warn(`空室検知: ${payload.title}`);
    await notify(payload, { signal });
  }

  return { snapshot, events, matches, fresh, notified: fresh.length > 0 };
}

async function runReport({ config, log }) {
  const history = await readHistory(NAME);
  const state = await readJson(NAME, STATE_FILE);
  const sinceMs = values.since ? parseDuration(values.since, '--since') : null;

  const report = buildReport(history, config, { sinceMs });
  console.log('\n' + formatReport(report, config, state) + '\n');

  const file = await saveJson(NAME, 'report-{stamp}.json', report);
  log.info(`report saved -> ${file}`);
  return report;
}

await runCrawler(NAME, async ({ log, signal }) => {
  const config = loadConfig();

  if (values.report) return runReport({ config, log });

  const notify = createNotifier({ channels: config.notify.channels, logger: log });

  if (values['notify-test']) {
    const payload = {
      source: NAME,
      event: 'test',
      hotelCode: config.hotelCode,
      title: `[test] d-reserve-jp 通知テスト`,
      text: `通知チャンネルの疎通確認です。\nhotel: ${config.hotelCode}\n${config.notify.bookingUrl || ''}`.trim(),
      bookingUrl: config.notify.bookingUrl || null,
      detectedAt: new Date().toISOString(),
      matches: [],
    };
    const results = await notify(payload, { signal });
    if (results.length === 0) log.warn('DRESERVE_NOTIFY_CHANNELS is empty — nothing was sent');
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return results;
  }

  const dryRun = values['dry-run'];
  log.info(
    `${config.hotelCode} ${config.fromDate}..${config.toDate} ` +
      `(${config.windows.length} window(s), lodgerNum=${config.query.lodgerNum})`,
  );

  const intervalMs = values.interval
    ? parseDuration(values.interval, '--interval')
    : config.poll.intervalMs;

  if (!values.interval) return pollOnce({ config, log, signal, notify, dryRun });

  // Resident mode. A single failed poll must not end the watch — the next one
  // may well be the release we are waiting for.
  log.info(`polling every ${Math.round(intervalMs / 1000)}s — Ctrl-C to stop`);
  while (!signal.aborted) {
    try {
      await pollOnce({ config, log, signal, notify, dryRun });
    } catch (error) {
      if (signal.aborted) break;
      log.error(`poll failed: ${error.message}`);
    }
    if (signal.aborted) break;
    await sleepUntilAborted(intervalMs, signal);
  }
  return undefined;
});
