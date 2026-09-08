#!/usr/bin/env node
// Usage: npm run crawl <crawler-name> [-- args...]
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crawlersDir = path.join(root, 'crawlers');

function listCrawlers() {
  if (!existsSync(crawlersDir)) return [];
  return readdirSync(crawlersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const [name, ...rest] = process.argv.slice(2);

if (!name) {
  console.error('Usage: npm run crawl <crawler> [-- args...]\n');
  console.error('Available crawlers:');
  for (const crawler of listCrawlers()) console.error(`  - ${crawler}`);
  process.exit(1);
}

const entry = path.join(crawlersDir, name, 'src/index.js');
if (!existsSync(entry)) {
  console.error(`Crawler "${name}" not found (expected ${path.relative(root, entry)}).\n`);
  console.error('Available crawlers:');
  for (const crawler of listCrawlers()) console.error(`  - ${crawler}`);
  process.exit(1);
}

// Pass --env-file only when .env exists; --env-file-if-exists prints a notice otherwise.
const envFile = path.join(root, '.env');
const nodeArgs = existsSync(envFile) ? [`--env-file=${envFile}`] : [];

const child = spawn(process.execPath, [...nodeArgs, entry, ...rest], {
  stdio: 'inherit',
  cwd: path.join(crawlersDir, name),
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
