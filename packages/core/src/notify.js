import { spawn } from 'node:child_process';
import { fetchWithRetry } from './http.js';

/**
 * A notification payload. `text` is what human-facing channels send; `title` is
 * a one-line summary; everything else is structured detail for machine consumers.
 *
 * @typedef {{
 *   source: string,
 *   event: string,
 *   title: string,
 *   text: string,
 *   [key: string]: unknown,
 * }} NotifyPayload
 */

/** Telegram's HTML parse mode only needs these three escaped. */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseHeaders(raw, logger) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    logger?.warn('NOTIFY_WEBHOOK_HEADERS is not a JSON object, ignoring it');
  } catch {
    logger?.warn('NOTIFY_WEBHOOK_HEADERS is not valid JSON, ignoring it');
  }
  return {};
}

/** POST the whole payload as JSON. Covers clawbot HTTP, Discord, Slack, n8n, ... */
async function sendWebhook(payload, { env, logger, signal }) {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) throw new Error('NOTIFY_WEBHOOK_URL is not set');

  await fetchWithRetry(url, {
    method: env.NOTIFY_WEBHOOK_METHOD ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...parseHeaders(env.NOTIFY_WEBHOOK_HEADERS, logger),
    },
    body: JSON.stringify(payload),
    logger,
    signal,
  });
}

/** Send `payload.text` through the Telegram Bot API. */
async function sendTelegram(payload, { env, logger, signal }) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId)
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');

  const base = env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
  await fetchWithRetry(`${base}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `<b>${escapeHtml(payload.title)}</b>\n\n${escapeHtml(payload.text)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
    logger,
    signal,
  });
}

/**
 * Run a shell command with the payload as JSON on stdin. This is the escape
 * hatch for anything without an HTTP endpoint — a clawbot CLI, a script that
 * forwards to a specific session, `cat >> /tmp/notify.log` while testing.
 */
async function sendCommand(payload, { env, logger, signal }) {
  const command = env.NOTIFY_COMMAND;
  if (!command) throw new Error('NOTIFY_COMMAND is not set');

  const timeout = Number(env.NOTIFY_COMMAND_TIMEOUT_MS ?? 15_000);
  logger?.debug(`notify command: ${command}`);

  await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // Draining stdout keeps a chatty command from blocking on a full pipe.
    child.stdout.resume();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signalName) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const how = signalName ? `killed by ${signalName}` : `exit code ${code}`;
      reject(new Error(`notify command failed (${how})${stderr ? `: ${stderr.trim()}` : ''}`));
    });

    child.stdin.on('error', () => {}); // command may not read stdin; that is fine
    child.stdin.end(JSON.stringify(payload));
  });
}

const CHANNELS = { webhook: sendWebhook, telegram: sendTelegram, command: sendCommand };

export const NOTIFY_CHANNELS = Object.keys(CHANNELS);

/**
 * Build a notifier over the named channels.
 *
 * Every channel is attempted independently: one failing never stops the others,
 * and `notify` never throws — a broken webhook must not take a crawler down.
 *
 * @param {{
 *   channels?: string[],
 *   env?: Record<string, string | undefined>,
 *   logger?: { debug: Function, info: Function, warn: Function, error: Function },
 * }} [options]
 * @returns {(payload: NotifyPayload, opts?: { signal?: AbortSignal }) =>
 *   Promise<{ channel: string, ok: boolean, error?: string }[]>}
 */
export function createNotifier({ channels = [], env = process.env, logger } = {}) {
  const selected = channels.filter((name) => {
    if (CHANNELS[name]) return true;
    logger?.warn(`unknown notify channel "${name}", expected one of ${NOTIFY_CHANNELS.join(', ')}`);
    return false;
  });

  return async function notify(payload, { signal } = {}) {
    if (selected.length === 0) {
      logger?.info(`[no notify channel configured] ${payload.title}`);
      return [];
    }

    return Promise.all(
      selected.map(async (channel) => {
        try {
          await CHANNELS[channel](payload, { env, logger, signal });
          logger?.info(`notified via ${channel}`);
          return { channel, ok: true };
        } catch (error) {
          logger?.error(`notify via ${channel} failed: ${error.message}`);
          return { channel, ok: false, error: error.message };
        }
      }),
    );
  };
}
