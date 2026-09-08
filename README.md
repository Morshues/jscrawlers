# jscrawlers

A Node.js crawler monorepo. One folder per crawler, all sharing `@jscrawlers/core`.

## Layout

```
crawlers/            each subfolder = one crawler (npm workspace)
  d-reserve-jp/
    src/index.js     entry point
    package.json     that crawler's own dependencies
packages/
  core/              shared: logger / HTTP retry / throttling / output
scripts/
  run.mjs            npm run crawl <name>
  new-crawler.mjs    npm run new <name>
data/                crawl output (git ignored)
```

## Getting started

```bash
nvm use          # Node 24 (minimum 22)
npm install
cp .env.example .env
```

## Commands

| Command                             | What it does                                       |
| ----------------------------------- | -------------------------------------------------- |
| `npm run crawl <name>`              | Run one crawler, e.g. `npm run crawl d-reserve-jp` |
| `npm run crawl <name> -- --pages 3` | Pass arguments through to the crawler              |
| `npm run new <name>`                | Scaffold a new crawler (kebab-case name)           |
| `npm test`                          | Run the tests (built-in `node:test`)               |
| `npm run lint` / `npm run format`   | ESLint / Prettier                                  |

Running `npm run crawl` with no name lists every available crawler.

## Adding a crawler

```bash
npm run new example-jp
npm install            # link the new workspace
npm run crawl example-jp
```

`npm run new` creates `crawlers/example-jp/` with a `package.json`, a
`src/index.js` skeleton already wired to core, and a README. From there you only
need to replace the selectors.

Crawler-specific packages are installed into that crawler's own folder:

```bash
npm install playwright -w @jscrawlers/example-jp
```

## Writing a crawler

```js
import { runCrawler, fetchText, throttle, saveJson } from '@jscrawlers/core';
import * as cheerio from 'cheerio';

await runCrawler('example-jp', async ({ log, signal }) => {
  const wait = throttle(1000); // roughly 1 request/sec, with jitter
  await wait();

  const html = await fetchText('https://example.com', { logger: log, signal });
  const $ = cheerio.load(html);
  const items = $('.item')
    .toArray()
    .map((el) => ({ title: $(el).text().trim() }));

  log.info(`collected ${items.length} items`);
  await saveJson('example-jp', '{stamp}.json', items);
  return items;
});
```

`runCrawler` handles timing, logging, Ctrl-C (exposed as `signal`), and turns a
thrown error into exit code 1.

### core API

- `createLogger(name)` — levelled logger controlled by `LOG_LEVEL`; `log.child('page-2')`
- `fetchWithRetry(url, opts)` / `fetchText` / `fetchJson` — timeout, exponential
  backoff, honours `Retry-After`; retries only 408/425/429/5xx and throws
  `HttpError` for anything else
- `sleep(ms)` / `jitter(ms)` / `throttle(ms)` / `withConcurrency(items, n, fn)`
- `saveJson` / `saveJsonl` / `appendJsonl` / `readJson` / `outputDir` — write to
  `data/<crawler>/`; `{stamp}` in a filename becomes a UTC timestamp
- `parseArgs(options)` — a thin wrapper over `node:util` for crawler CLI flags

## Conventions

- ESM (`"type": "module"`), Node >= 22, built-in `fetch` — no extra HTTP client
- Configuration lives in environment variables in `.env` (loaded automatically by
  `npm run crawl`); secrets never go into git
- All output goes to `data/`, which is git ignored
- Default rate limit is 1 req/s with jitter; check the target site's robots.txt
  and terms of service before raising it
