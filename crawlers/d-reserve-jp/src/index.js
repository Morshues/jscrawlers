import { gzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runCrawler,
  parseArgs,
  appendJsonl,
  saveJson,
  readJson,
  readJsonl,
  outputDir,
  createNotifier,
  createInbox,
  pollLoop,
  trackHealth,
  backoffRemaining,
} from '@jscrawlers/core';

import { loadConfig, parseDuration } from './config.js';
import { fetchSnapshot, classifyError } from './api.js';
import { diffSnapshots } from './diff.js';
import {
  selectNotifications,
  buildPayloads,
  buildClosedPayloads,
  resolveAck,
  resolveCell,
  buildHealthPayload,
} from './watch.js';
import { readHistory, buildReport, formatReport } from './report.js';
import { pendingWindows, summarizeWindow, buildSummaryPayloads } from './daily-summary.js';
import { requestBooking } from './booker-client.js';

const NAME = 'd-reserve-jp';
const STATE_FILE = 'state.json';
const DAILY_STATE_FILE = 'daily-summary-state.json';
const ACK_FILE = 'ack.jsonl';

const { values, positionals } = parseArgs({
  interval: { type: 'string' }, // "5m" -> stay resident; absent -> one shot
  report: { type: 'boolean', default: false },
  since: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  'notify-test': { type: 'boolean', default: false },
  'daily-summary': { type: 'boolean', default: false },
  ack: { type: 'boolean', default: false }, // stop reminding me; optional filter
});

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
 * Record a "stop reminding me" command.
 *
 * Appending to a log rather than editing state.json is what makes `--ack` safe
 * to run against a resident watcher: two writers that only ever append cannot
 * clobber each other, and the file doubles as a record of who said stop when.
 */
async function recordAck(entry, log) {
  await appendJsonl(NAME, ACK_FILE, entry);
  const what = entry.filter ? `（${entry.filter}）` : '（全部）';
  log.info(`已記錄停止提醒指令${what}，下一次輪詢生效`);
  return entry;
}

/**
 * Fold the commands nobody has applied yet into the notification bookkeeping.
 *
 * Only cells that are currently being announced can be silenced: an ack for
 * something that is not alerting has nothing to stop, and letting it linger
 * would silence a genuine opening later.
 *
 * @returns {{ acked: string[], cursor: string|null }}
 */
async function pendingAcks(state) {
  const cursor = state.ackCursor ?? null;
  const entries = (await readJsonl(NAME, ACK_FILE)).filter(
    (entry) => entry?.ts && (!cursor || entry.ts > cursor),
  );
  if (entries.length === 0) return { acked: [], cursor };

  const alerting = Object.keys(state.notified ?? {});
  const acked = new Set();
  for (const entry of entries) {
    for (const key of resolveAck(entry.filter, alerting, state.cells ?? {})) acked.add(key);
  }

  return {
    acked: [...acked],
    cursor: entries.reduce(
      (latest, entry) => (entry.ts > latest ? entry.ts : latest),
      cursor ?? '',
    ),
  };
}

/**
 * Fold one poll's outcome into the failure bookkeeping and say so out loud when
 * it crosses a line. Returns the health to persist.
 */
async function updateHealth({ state, outcome, config, log, signal, notifyHealth }) {
  const now = Date.now();
  const { health, alert } = trackHealth(state.health, outcome, { now, ...config.health });
  if (alert) {
    // A recovery reports on the outage that just ended, which only the old
    // health still describes.
    const subject = alert === 'recovered' ? state.health : health;
    const payload = buildHealthPayload(alert, subject, config, { now });
    log[alert === 'recovered' ? 'info' : 'warn'](payload.title);
    await notifyHealth(payload, { signal });
  }
  return health;
}

/**
 * One full cycle: fetch, diff against the stored snapshot, persist the changes,
 * then decide whether anything is worth a notification.
 *
 * The two phases deliberately share a single fetch — running them separately
 * would double the request rate and let them disagree about the same minute.
 */
async function pollOnce({ config, log, signal, notify, notifyHealth, inbox, dryRun }) {
  const startedAt = Date.now();
  const state = (await readJson(NAME, STATE_FILE)) ?? {};
  const untilAck = config.notify.mode === 'until-ack';

  // The pause lives in state.json rather than in memory so a launchd job, one
  // process per poll, honours it just like the resident loop does.
  const pauseMs = backoffRemaining(state.health);
  if (pauseMs > 0 && !dryRun) {
    log.warn(
      `退避中，略過本輪（連續失敗 ${state.health.consecutiveFailures} 次，` +
        `${Math.ceil(pauseMs / 1000)}s 後再試）`,
    );
    return { skipped: true, pauseMs };
  }

  let snapshot;
  try {
    snapshot = await fetchSnapshot(config, { logger: log, signal });
  } catch (error) {
    // Ctrl-C mid-request is not the site failing.
    if (!dryRun && !signal.aborted) {
      const outcome = classifyError(error);
      await appendJsonl(NAME, 'polls.jsonl', {
        ts: new Date().toISOString(),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error.message,
        blocked: outcome.blocked,
        status: outcome.status,
      });
      // Only the health moves: the cells and alert bookkeeping still describe
      // the last poll that actually saw the calendar.
      const health = await updateHealth({ state, outcome, config, log, signal, notifyHealth });
      await saveJson(NAME, STATE_FILE, { ...state, health });
    }
    throw error;
  }

  // Commands arrive between polls, and are read before anything is announced so
  // a /stop sent a minute ago silences this poll's reminder rather than the next.
  const inboxState = { ...(state.inbox ?? {}) };
  if (inbox) {
    const { commands, offset } = await inbox({ offset: inboxState.telegramOffset, signal });
    for (const command of commands) {
      log.info(
        `收到停止提醒指令（${command.channel}）${command.filter ? `：${command.filter}` : ''}`,
      );
      if (!dryRun) {
        await recordAck({ ts: command.ts, source: command.channel, filter: command.filter }, log);
      }
    }
    inboxState.telegramOffset = offset;
  }
  const { acked, cursor } = untilAck ? await pendingAcks(state) : { acked: [], cursor: null };

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

  const { matches, fresh, closed, notified } = selectNotifications(
    snapshot.cells,
    config,
    state.notified ?? {},
    { now: Date.parse(snapshot.fetchedAt), acked },
  );
  // Only a watcher that was nagging owes an explanation for going quiet.
  const closedCells = untilAck
    ? closed.map((key) => resolveCell(key, snapshot.cells, state.cells))
    : [];

  if (dryRun) {
    log.info(`[dry-run] ${matches.length} cells match the watch filter, ${fresh.length} are new`);
    for (const cell of matches)
      log.info(`  match: ${cell.salesDate} ${cell.roomName} 剩${cell.stockNum}`);
    if (acked.length > 0) log.info(`[dry-run] ${acked.length} 筆會被停止提醒`);
    for (const payload of buildPayloads(fresh, config))
      log.info(`[dry-run] would notify:\n${payload.text}`);
    for (const payload of buildClosedPayloads(closedCells, config))
      log.info(`[dry-run] would notify:\n${payload.text}`);
    if (config.booker && matches.length > 0) {
      log.info(
        `[dry-run] would hand ${matches.length} cell(s) to the booker at ${config.booker.url}`,
      );
    }
    return { snapshot, events, matches, fresh, closed, notified: false };
  }

  // Events are appended before the state advances. A crash in between then
  // re-derives the same events next poll — a duplicate row, which is visible and
  // fixable. The other order would drop the release from history for good, and
  // catching rare releases is the whole point.
  if (events.length > 0) {
    await appendJsonl(NAME, eventsFile(snapshot.fetchedAt), events);
  }

  // A good poll clears the failure bookkeeping. Announcing the all-clear waits
  // until after the booker handoff, which cannot afford a Telegram round trip.
  const recovered = Boolean(state.health?.alertedAt);

  await saveJson(NAME, STATE_FILE, {
    hotelCode: config.hotelCode,
    range: { from: config.fromDate, to: config.toDate },
    query: config.query,
    updatedAt: snapshot.fetchedAt,
    rooms: snapshot.rooms,
    cells: snapshot.cells,
    notified,
    ackCursor: cursor,
    inbox: inboxState,
    health: null,
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

  // Booking runs on another machine that holds the login and its own policy
  // (crawlers/d-reserve-booker); this only tells it what is open. It goes before
  // the alerts because the booker answers within a second and a cancelled room
  // is gone within minutes, and before the first-run rule because an open room
  // is worth booking whether or not it counts as a release. Every match is sent,
  // not only fresh ones: the booker decides, and retries a failed attempt on a
  // later poll.
  const handoff =
    config.booker && matches.length > 0
      ? await requestBooking(config, matches, { logger: log, signal })
      : null;
  if (handoff?.accepted) {
    log.warn(
      `已交給訂房機：${handoff.target.salesDate} ${handoff.target.roomCode}` +
        (handoff.submit ? '' : '（演練模式）'),
    );
  } else if (handoff) {
    log.info(`訂房機未受理：${handoff.reason}`);
  }

  if (recovered) {
    await updateHealth({ state, outcome: { ok: true }, config, log, signal, notifyHealth });
  }

  // The first run has no baseline, so it cannot tell "just released" from "open
  // for weeks" — alerting on that would be a false release signal, and with an
  // unset watch filter it fires for whatever happens to be open. The matches are
  // logged instead, and `notified` above already recorded them so the next poll
  // does not replay them as a fresh edge.
  if (seeding && !config.notify.onFirstRun) {
    if (fresh.length > 0) {
      log.info(`baseline established; ${fresh.length} cell(s) already bookable (not alerted):`);
      for (const cell of fresh) log.info(`  ${cell.salesDate} ${cell.roomName} 剩${cell.stockNum}`);
      log.info('set DRESERVE_NOTIFY_ON_FIRST_RUN=true to be alerted about these too');
    }
    return { snapshot, events, matches, fresh, closed, notified: false, handoff };
  }

  const alerts = buildPayloads(fresh, config, { detectedAt: snapshot.fetchedAt });
  if (handoff?.accepted && alerts.length > 0) {
    alerts[0].text +=
      `\n\n🤖 已交給訂房機：${handoff.target.salesDate} ${handoff.target.roomCode}` +
      (handoff.submit ? '' : '（演練）');
  }

  // A notification failure must never abort the run: the history is the part we
  // cannot reconstruct later, and it is already safely on disk by this point.
  for (const payload of alerts) {
    log.warn(`偵測到空房：${payload.title}`);
    await notify(payload, { signal });
  }

  for (const payload of buildClosedPayloads(closedCells, config, {
    detectedAt: snapshot.fetchedAt,
  })) {
    log.info(payload.title);
    await notify(payload, { signal });
  }

  return { snapshot, events, matches, fresh, closed, notified: fresh.length > 0, handoff };
}

/**
 * Send every daily digest still owed, oldest first.
 *
 * The checkpoint only moves once a window's segments have all been delivered on
 * every configured channel, so a missed schedule, a sleeping Mac or a Telegram
 * failure is recovered by simply running again. That makes delivery
 * at-least-once: a failure partway through a multi-segment window resends the
 * whole window on retry. Duplicates are recoverable; a gap is not.
 */
async function runDailySummary({ config, log, signal, notify, dryRun }) {
  const checkpoint = (await readJson(NAME, DAILY_STATE_FILE)) ?? {};
  const { daily } = config;

  const { windows, skipped, realigned } = pendingWindows({
    lastWindowEnd: checkpoint.lastWindowEnd ?? null,
    now: Date.now(),
    timeZone: daily.timeZone,
    hour: daily.hour,
    maxBackfill: daily.maxBackfill,
  });

  if (realigned) {
    log.warn(
      `checkpoint did not sit on the ${daily.hour}:00 ${daily.timeZone} grid ` +
        '(DRESERVE_DAILY_TZ/HOUR changed?); snapped back to the previous boundary',
    );
  }
  if (skipped.length > 0) {
    log.warn(
      `${skipped.length} window(s) beyond DRESERVE_DAILY_MAX_BACKFILL=${daily.maxBackfill} ` +
        `were skipped: ${skipped[0].startDate} → ${skipped.at(-1).endDate}`,
    );
  }
  if (windows.length === 0) {
    log.info('no windows due — the latest digest has already been delivered');
    return { sent: 0, skipped: skipped.length };
  }

  const history = await readHistory(NAME);
  log.info(`${windows.length} window(s) due, ${history.events.length} events on file`);

  let sent = 0;
  for (const [index, window] of windows.entries()) {
    if (signal.aborted) break;

    const summary = summarizeWindow(history, window, config);
    // Only the first message of the batch carries the skip notice.
    const skippedNote =
      index === 0 && skipped.length > 0
        ? `※ 已跳過 ${skipped.length} 期（${skipped[0].startDate} → ${skipped.at(-1).endDate}）`
        : undefined;
    const payloads = buildSummaryPayloads(summary, config, { skippedNote });

    if (dryRun) {
      log.info(`[dry-run] ${window.startDate} → ${window.endDate}, ${payloads.length} segment(s)`);
      for (const payload of payloads) console.log(`\n--- ${payload.title} ---\n${payload.text}`);
      continue;
    }

    let delivered = true;
    for (const payload of payloads) {
      const results = await notify(payload, { signal });
      // No channel configured means nothing can be confirmed delivered, so the
      // checkpoint must not advance past data nobody received.
      if (results.length === 0 || results.some((result) => !result.ok)) {
        delivered = false;
        break;
      }
    }

    if (!delivered) {
      const failures = (checkpoint.consecutiveFailures ?? 0) + 1;
      await saveJson(NAME, DAILY_STATE_FILE, { ...checkpoint, consecutiveFailures: failures });
      log.error(
        `delivery failed for ${window.startDate} → ${window.endDate}; checkpoint not advanced ` +
          `(consecutive failures: ${failures})`,
      );
      if (failures >= 3) {
        log.error(
          'the same window has now failed 3+ times. It will keep retrying and no digest can ' +
            'advance past it — fix the channel, or remove it from DRESERVE_DAILY_CHANNELS / ' +
            'DRESERVE_NOTIFY_CHANNELS.',
        );
      }
      process.exitCode = 1;
      return { sent, skipped: skipped.length, failedAt: window.endDate };
    }

    const recent = [
      ...(checkpoint.recent ?? []),
      {
        windowEnd: new Date(window.end).toISOString(),
        segments: payloads.length,
        deliveredAt: new Date().toISOString(),
      },
    ].slice(-10);

    Object.assign(checkpoint, {
      timeZone: daily.timeZone,
      boundaryHour: daily.hour,
      lastWindowEnd: new Date(window.end).toISOString(),
      lastDeliveredAt: new Date().toISOString(),
      consecutiveFailures: 0,
      recent,
    });
    await saveJson(NAME, DAILY_STATE_FILE, checkpoint);

    sent++;
    log.info(`delivered ${window.startDate} → ${window.endDate} (${payloads.length} segment(s))`);
  }

  return { sent, skipped: skipped.length };
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

  // Pure bookkeeping: never touches the network, so it works while the watcher
  // is mid-poll, offline, or not running at all.
  if (values.ack) {
    return recordAck(
      { ts: new Date().toISOString(), source: 'cli', filter: positionals[0] ?? null },
      log,
    );
  }

  if (values['daily-summary']) {
    // Falls back to the shared channel list so one .env covers both jobs.
    const channels =
      config.daily.channels.length > 0 ? config.daily.channels : config.notify.channels;
    return runDailySummary({
      config,
      log,
      signal,
      notify: createNotifier({ channels, logger: log }),
      dryRun: values['dry-run'],
    });
  }

  const notify = createNotifier({ channels: config.notify.channels, logger: log });
  // Falls back like the digest does, so one channel list covers everything.
  const notifyHealth = createNotifier({
    channels: config.health.channels.length > 0 ? config.health.channels : config.notify.channels,
    logger: log,
  });
  const inbox =
    config.notify.ackChannels.length > 0
      ? createInbox({ channels: config.notify.ackChannels, logger: log })
      : null;

  if (config.notify.legacyCooldown) {
    log.warn(
      'DRESERVE_NOTIFY_COOLDOWN_MIN is superseded by DRESERVE_NOTIFY_MODE=until-ack plus ' +
        'DRESERVE_NOTIFY_REPEAT_MIN; using it as the repeat interval for now',
    );
  }

  if (values['notify-test']) {
    const payload = {
      source: NAME,
      event: 'test',
      hotelCode: config.hotelCode,
      title: `[測試] d-reserve-jp 通知測試`,
      text: `通知管道連線測試。\n旅館代碼：${config.hotelCode}\n${config.notify.bookingUrl || ''}`.trim(),
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
  log.info(
    config.notify.mode === 'until-ack'
      ? `通知模式 until-ack：每 ${config.notify.repeatMs / 60_000} 分鐘提醒一次，` +
          `直到 ${inbox ? 'Telegram /stop、' : ''}--ack 或房間消失`
      : '通知模式 once：每次上架只通知一次',
  );

  const intervalMs = values.interval
    ? parseDuration(values.interval, '--interval')
    : config.poll.intervalMs;

  const poll = () => pollOnce({ config, log, signal, notify, notifyHealth, inbox, dryRun });
  if (!values.interval) return poll();

  // Resident mode. A single failed poll must not end the watch — the next one
  // may well be the release we are waiting for.
  return pollLoop({
    task: poll,
    intervalMs,
    jitterRatio: config.poll.jitterRatio,
    signal,
    logger: log,
  });
});
