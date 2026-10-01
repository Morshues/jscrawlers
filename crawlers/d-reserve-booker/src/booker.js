import { appendJsonl, readJson, saveJson } from '@jscrawlers/core';
import { attemptBooking } from './booking.js';
import { buildBookingPayload } from './notify.js';
import { cellKey, selectBookingTarget } from './policy.js';

export const NAME = 'd-reserve-booker';
const STATE_FILE = 'booking-state.json';

/** The real disk, behind a seam the tests can replace. */
export const fileStore = {
  readState: async () => (await readJson(NAME, STATE_FILE)) ?? {},
  saveState: (state) => saveJson(NAME, STATE_FILE, state),
  saveRecord: (name, value) => saveJson(NAME, `booking/{stamp}-${name}.json`, value),
  appendLog: (entry) => appendJsonl(NAME, 'bookings.jsonl', entry),
};

/**
 * The booking engine both entry points share: the HTTP server asks it to
 * decide and run, `--book` asks it to run one cell directly.
 *
 * One attempt at a time. A second request while one is running is answered
 * `busy` rather than queued: by the time it would run, the watcher will have
 * polled again and sent fresher news.
 */
export function createBooker({
  config,
  log,
  notify,
  store = fileStore,
  attempt = attemptBooking,
  signal,
}) {
  let running = null;

  /** One attempt, recorded and announced. Resolves to the result; never rejects. */
  async function run(cell, { submit }) {
    const key = cellKey(cell);
    const ts = new Date().toISOString();
    log.warn(
      `訂房開始${submit ? '' : '（演練）'}：${cell.salesDate} ${cell.roomCode} ${cell.planCode}`,
    );

    const result = await attempt(config, cell, { dryRun: !submit, logger: log, signal });

    try {
      if (result.payload)
        await store.saveRecord(submit ? 'payload' : 'payload-dry-run', result.payload);
      if (result.response) await store.saveRecord('entry', result.response);
      await store.appendLog({
        ts,
        key,
        planCode: cell.planCode,
        submit,
        ok: result.ok,
        submitted: result.submitted,
        nextUrl: result.nextUrl ?? null,
        error: result.error ?? null,
      });

      // A dry run neither counts as an attempt nor locks: it spent nothing.
      if (submit) {
        const state = await store.readState();
        const attempts = { ...state.attempts, [key]: (state.attempts?.[key] ?? 0) + 1 };
        await store.saveState({
          ...state,
          attempts,
          ...(result.ok
            ? { locked: true, lockedAt: ts, booked: { key, nextUrl: result.nextUrl } }
            : {}),
        });
      }
    } catch (error) {
      log.error(`could not record the attempt: ${error.message}`);
    }

    if (result.ok) log.warn(submit ? '已送出訂房，等待付款' : '演練成功，未送出');
    else log.error(`訂房失敗：${result.error}`);

    await notify(buildBookingPayload(cell, result, { submit: submit }), { signal });
    return result;
  }

  return {
    /**
     * Decide synchronously-ish (one state read) and start the attempt in the
     * background. The answer says only what was decided — never the outcome,
     * which goes to the booker's own channels.
     */
    async request(cells) {
      if (running) return { accepted: false, reason: 'busy' };
      const decision = selectBookingTarget(cells, await store.readState(), config.policy);
      if (!decision.target) return { accepted: false, reason: decision.reason };
      if (running) return { accepted: false, reason: 'busy' };

      const target = decision.target;
      running = run(target, { submit: config.server.submit }).finally(() => {
        running = null;
      });
      return {
        accepted: true,
        submit: config.server.submit,
        target: { roomCode: target.roomCode, salesDate: target.salesDate },
      };
    },

    run,

    /** Settles once the in-flight attempt (if any) is done; for tests and shutdown. */
    idle: () => running ?? Promise.resolve(),

    async status() {
      const state = await store.readState();
      return {
        locked: Boolean(state.locked),
        busy: Boolean(running),
        submit: config.server.submit,
      };
    },
  };
}
