import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { repoRoot } from '@jscrawlers/core';

/**
 * Where ordering keeps what must not be in the repository.
 *
 * The repo (and its `.env`, and `data/`) is readable by whatever drives the
 * watcher, an AI agent included. The 巴哈 login, the session cookies and the
 * checkout pages — which carry your name, phone and address — are not, so they
 * default to the home directory and anything pointing back into the repo is
 * refused. Same rules as crawlers/d-reserve-booker/src/main.js.
 *
 *   BUYGAMER_ORDER_ENV_FILE   default ~/.config/buy-gamer-tw/order.env (chmod 600)
 *   session.json              next to the env file, written 600
 *   BUYGAMER_ORDER_DATA_DIR   default ~/.local/share/buy-gamer-tw  (orders.jsonl,
 *                             locks/, pages/)
 */

export function insideRepo(target, root = repoRoot) {
  const relative = path.relative(root, path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** @param {Record<string, string | undefined>} [env] */
export function privatePaths(env = process.env, { home = os.homedir(), root = repoRoot } = {}) {
  const envFile = path.resolve(
    env.BUYGAMER_ORDER_ENV_FILE?.trim() || path.join(home, '.config', 'buy-gamer-tw', 'order.env'),
  );
  const dataDir = path.resolve(
    env.BUYGAMER_ORDER_DATA_DIR?.trim() || path.join(home, '.local', 'share', 'buy-gamer-tw'),
  );
  if (insideRepo(envFile, root)) {
    throw new Error(`refusing BUYGAMER_ORDER_ENV_FILE inside the repository: ${envFile}`);
  }
  if (insideRepo(dataDir, root)) {
    throw new Error(`refusing BUYGAMER_ORDER_DATA_DIR inside the repository: ${dataDir}`);
  }
  return {
    envFile,
    sessionFile: path.join(path.dirname(envFile), 'session.json'),
    dataDir,
  };
}

/**
 * Read the order env file into a plain object. It is deliberately NOT merged
 * into process.env, so nothing else in the process (a notify `command` channel,
 * say) inherits the password.
 */
export function readOrderEnv(envFile, { platform = process.platform } = {}) {
  if (!fs.existsSync(envFile)) {
    throw new Error(
      `no order env file at ${envFile} — copy crawlers/buy-gamer-tw/order.env.example there and chmod 600`,
    );
  }
  // Windows keeps access rights in ACLs that fs.stat cannot see (every file
  // reads as 666), so the check would refuse a file that is in fact private.
  if (platform !== 'win32') {
    const mode = fs.statSync(envFile).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `${envFile} is readable by others (mode ${mode.toString(8)}); run: chmod 600 "${envFile}"`,
      );
    }
  }
  return parseEnv(fs.readFileSync(envFile, 'utf8'));
}

/** Write a file only its owner can read, creating its directory (700) first. */
export function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function appendPrivate(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line, { mode: 0o600 });
}
