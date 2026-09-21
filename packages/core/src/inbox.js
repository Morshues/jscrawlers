import { fetchJson } from './http.js';

/**
 * The other direction: commands people send *back* to a crawler.
 *
 * A watcher that nags until you tell it to stop needs a way to hear "stop".
 * Only Telegram can do that today — getUpdates is itself a poll, so a one-shot
 * run picks up whatever arrived since the last one, which suits a launchd job
 * as well as a resident loop.
 *
 * Parsing is kept separate from fetching so the interesting part is testable
 * without a network or a bot token.
 */

/** `/stop` and `/ack` mean the same thing; both stop the reminders. */
const COMMANDS = new Set(['stop', 'ack']);

/**
 * Read one chat message as a command, or null when it is just conversation.
 *
 * Accepts "/stop", "/ack", the "/stop@mybot" form groups produce, and an
 * optional argument: "/stop 2026-10-09". The argument is handed back verbatim
 * for the caller to interpret — core has no idea what a room is.
 *
 * @param {string} text
 * @returns {{ command: 'stop', filter: string|null }|null}
 */
export function parseCommand(text) {
  const match = /^\/([a-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  if (!COMMANDS.has(match[1].toLowerCase())) return null;
  return { command: 'stop', filter: match[2]?.trim() || null };
}

/**
 * Pull the usable messages out of a getUpdates response.
 *
 * The offset must be stored even when nothing matched: Telegram only drops an
 * update once a later offset confirms it, so an unrelated message left
 * unconfirmed comes back on every single poll.
 *
 * @param {unknown} body the parsed getUpdates response
 * @param {{ chatId?: string|number }} [options] ignore anything from elsewhere
 * @returns {{ messages: { text: string, ts: string }[], offset: number|null }}
 */
export function parseTelegramUpdates(body, { chatId } = {}) {
  const updates = Array.isArray(body?.result) ? body.result : [];
  const messages = [];
  let offset = null;

  for (const update of updates) {
    if (Number.isInteger(update?.update_id)) {
      offset = Math.max(offset ?? 0, update.update_id + 1);
    }
    const message = update?.message ?? update?.edited_message;
    if (typeof message?.text !== 'string') continue;
    if (chatId !== undefined && String(message.chat?.id) !== String(chatId)) continue;
    messages.push({
      text: message.text,
      ts: new Date((message.date ?? 0) * 1000).toISOString(),
    });
  }

  return { messages, offset };
}

async function readTelegram({ offset, env, logger, signal }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');
  }

  const base = env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
  const url = new URL(`/bot${token}/getUpdates`, base);
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', '["message"]');
  if (offset) url.searchParams.set('offset', String(offset));

  return parseTelegramUpdates(await fetchJson(url.href, { logger, signal }), { chatId });
}

const READERS = { telegram: readTelegram };

export const INBOX_CHANNELS = Object.keys(READERS);

/**
 * Build a reader over the channels that can receive commands.
 *
 * `read` never throws: an unread "/stop" costs one extra reminder, while a
 * failed poll costs the release we are waiting for. Everything is logged and
 * the crawl carries on.
 *
 * @param {{
 *   channels?: string[],
 *   env?: Record<string, string | undefined>,
 *   logger?: { debug: Function, info: Function, warn: Function, error: Function },
 * }} [options]
 * @returns {(opts?: { offset?: number|null, signal?: AbortSignal }) => Promise<{
 *   commands: { command: 'stop', filter: string|null, channel: string, ts: string }[],
 *   offset: number|null,
 * }>}
 */
export function createInbox({ channels = [], env = process.env, logger } = {}) {
  const selected = channels.filter((name) => {
    if (READERS[name]) return true;
    logger?.warn(`notify channel "${name}" cannot receive commands, ignoring it`);
    return false;
  });

  return async function read({ offset = null, signal } = {}) {
    const commands = [];
    let next = offset;

    for (const channel of selected) {
      try {
        const result = await READERS[channel]({ offset: next, env, logger, signal });
        if (result.offset !== null) next = result.offset;

        for (const message of result.messages) {
          const command = parseCommand(message.text);
          if (command) commands.push({ ...command, channel, ts: message.ts });
          else logger?.debug(`ignoring "${message.text}" — not a command`);
        }
      } catch (error) {
        const hint =
          error.status === 409
            ? ' — this bot has a webhook set, which makes getUpdates refuse to answer'
            : '';
        logger?.warn(`reading commands from ${channel} failed: ${error.message}${hint}`);
      }
    }

    return { commands, offset: next };
  };
}
