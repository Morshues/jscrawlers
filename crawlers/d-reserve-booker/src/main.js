#!/usr/bin/env node
/**
 * Entry point. Loads the booker's secrets from a file OUTSIDE the repository,
 * then starts index.js.
 *
 * The repository is readable by whatever drives the watcher crawlers (an AI
 * agent included); the login, the guest details and the payment link must not
 * be. So the env file and the data directory both default to the home
 * directory, and anything that would put them back inside the repo is refused.
 *
 *   BOOKER_ENV_FILE  default ~/.config/d-reserve-booker/booker.env  (chmod 600;
 *                    not checked on Windows, see below)
 *   DATA_ROOT        default ~/.local/share/d-reserve-booker
 *
 * DATA_ROOT has to be settled before @jscrawlers/core is imported — its store
 * reads it once at load — hence the dynamic import at the end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function insideRepo(target) {
  const relative = path.relative(repoRoot, path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * An env file is not a shell: `~` stays a literal directory name, which would
 * resolve against the working directory — usually the repo itself.
 */
function expandHome(file) {
  return /^~(?=$|[\\/])/.test(file) ? path.join(os.homedir(), file.slice(1)) : file;
}

function fail(message) {
  console.error(`[d-reserve-booker] ${message}`);
  process.exit(1);
}

const envFile = expandHome(
  process.env.BOOKER_ENV_FILE ??
    path.join(os.homedir(), '.config', 'd-reserve-booker', 'booker.env'),
);

/**
 * A file holding secrets must live outside the repo and be readable only by
 * this account.
 *
 * Windows keeps access rights in NTFS ACLs, which fs.stat cannot see: its mode
 * only reflects the read-only attribute, so every ordinary file reads as 666
 * and the check would refuse a file that is in fact locked down. There the
 * file is trusted to the user profile's default ACL, and the log says how to
 * tighten it.
 */
function checkSecretFile(file, missingHint) {
  file = path.resolve(file);
  if (insideRepo(file)) fail(`refusing a secret file inside the repository: ${file}`);
  if (!fs.existsSync(file)) fail(`no file at ${file} — ${missingHint}`);
  if (process.platform === 'win32') {
    console.warn(
      `[d-reserve-booker] file permissions are not checked on Windows. To limit ${file} ` +
        `to your account: icacls "${file}" /inheritance:r /grant:r "${os.userInfo().username}:F"`,
    );
    return;
  }
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    fail(`${file} is readable by others (mode ${mode.toString(8)}); run: chmod 600 "${file}"`);
  }
}

checkSecretFile(envFile, 'copy crawlers/d-reserve-booker/booker.env.example there');

// Assigned over whatever is already set: if this was started through
// `npm run crawl`, the repo .env is in the environment too, and its values
// (a different Telegram bot, say) must not win over the booker's own.
Object.assign(process.env, parseEnv(fs.readFileSync(envFile, 'utf8')));

// The FCM service account is a private key that can push to the phone.
if (process.env.FCM_SERVICE_ACCOUNT_FILE) {
  // Written back so the notifier reads the same file that was checked.
  process.env.FCM_SERVICE_ACCOUNT_FILE = path.resolve(
    expandHome(process.env.FCM_SERVICE_ACCOUNT_FILE),
  );
  checkSecretFile(
    process.env.FCM_SERVICE_ACCOUNT_FILE,
    'download it from Firebase console → Project settings → Service accounts',
  );
}

process.env.DATA_ROOT ||= path.join(os.homedir(), '.local', 'share', 'd-reserve-booker');
if (insideRepo(process.env.DATA_ROOT)) {
  fail(`refusing DATA_ROOT inside the repository: ${process.env.DATA_ROOT}`);
}

// Lets index.js tell it was started here rather than straight from the repo
// (e.g. `npm run crawl`), which would skip every check above.
process.env.BOOKER_STARTED_BY_MAIN = '1';
await import('./index.js');
