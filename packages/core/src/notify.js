import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    // Trailing newline so line-oriented consumers (`cat >> log.jsonl`, `read`)
    // see one record per line instead of concatenated JSON.
    child.stdin.end(JSON.stringify(payload) + '\n');
  });
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Access tokens by service-account file, so a notification costs one request, not two. */
const fcmTokens = new Map();

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/**
 * Trade a service account for an OAuth access token: a JWT signed with its
 * private key, posted to its token_uri. This is what firebase-admin does, in
 * the few lines this repo needs instead of the dependency.
 */
async function fcmAccessToken(file, { logger, signal }) {
  const cached = fcmTokens.get(file);
  // Refresh a minute early so a token never expires between here and FCM.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached;

  const account = JSON.parse(await readFile(file, 'utf8'));
  for (const key of ['client_email', 'private_key', 'project_id']) {
    if (!account[key]) throw new Error(`FCM service account ${file} has no ${key}`);
  }
  const tokenUri = account.token_uri ?? GOOGLE_TOKEN_URI;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);

  const response = await fetchWithRetry(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature.toString('base64url')}`,
    }).toString(),
    logger,
    signal,
  });
  const { access_token: accessToken, expires_in: expiresIn = 3600 } = await response.json();
  if (!accessToken) throw new Error(`no access_token from ${tokenUri}`);

  const entry = {
    accessToken,
    projectId: account.project_id,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  fcmTokens.set(file, entry);
  return entry;
}

/**
 * Push the payload straight to an Android app as a high-priority FCM data
 * message, so the app gets it in onMessageReceived without waiting on another
 * app's notification. FCM data values must be strings; objects go as JSON.
 */
async function sendFcm(payload, { env, logger, signal }) {
  const file = env.FCM_SERVICE_ACCOUNT_FILE;
  const tokens = String(env.FCM_DEVICE_TOKEN ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (!file || tokens.length === 0)
    throw new Error('FCM_SERVICE_ACCOUNT_FILE and FCM_DEVICE_TOKEN must both be set');

  const { accessToken, projectId } = await fcmAccessToken(file, { logger, signal });
  const data = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    data[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  const base = env.FCM_API_BASE ?? 'https://fcm.googleapis.com';
  const results = await Promise.allSettled(
    tokens.map((token) =>
      fetchWithRetry(`${base}/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message: { token, android: { priority: 'HIGH' }, data } }),
        logger,
        signal,
      }),
    ),
  );
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${tokens.length} FCM devices failed: ${failed[0].reason.message}`,
    );
  }
}

const CHANNELS = {
  webhook: sendWebhook,
  telegram: sendTelegram,
  command: sendCommand,
  fcm: sendFcm,
};

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
