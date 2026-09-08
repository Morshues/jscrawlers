import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from `start` until a package.json declaring workspaces is found. */
function findRepoRoot(start) {
  let dir = start;
  while (true) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).workspaces) return dir;
      } catch {
        // unreadable manifest, keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Absolute path of the monorepo root. Override with DATA_ROOT if needed. */
export const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

const dataRoot = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.join(repoRoot, 'data');

/** `<root>/data/<crawler>[/...segments]`, created if missing. */
export async function outputDir(crawler, ...segments) {
  const dir = path.join(dataRoot, crawler, ...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** UTC stamp usable in a filename: 20260908T101700Z */
function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

// "run.json" -> data/<crawler>/run.json ; "{stamp}.json" -> timestamped filename
function resolveTarget(filename) {
  return filename.replace('{stamp}', stamp());
}

/**
 * Write a pretty-printed JSON file under data/<crawler>/.
 * @returns {Promise<string>} the path written
 */
export async function saveJson(crawler, filename, value) {
  const dir = await outputDir(crawler);
  const file = path.join(dir, resolveTarget(filename));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return file;
}

/** Write an array as newline-delimited JSON (one record per line). */
export async function saveJsonl(crawler, filename, records) {
  const dir = await outputDir(crawler);
  const file = path.join(dir, resolveTarget(filename));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  await fs.writeFile(file, body ? body + '\n' : '', 'utf8');
  return file;
}

/** Append records to an existing JSONL file, creating it if needed. */
export async function appendJsonl(crawler, filename, records) {
  const dir = await outputDir(crawler);
  const file = path.join(dir, resolveTarget(filename));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0) return file;
  await fs.appendFile(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

/** Read a JSON file from data/<crawler>/, or `fallback` if it does not exist. */
export async function readJson(crawler, filename, fallback = null) {
  const file = path.join(dataRoot, crawler, filename);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
