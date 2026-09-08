#!/usr/bin/env node
// Usage: npm run new <crawler-name>
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];

if (!name) {
  console.error('Usage: npm run new <crawler-name>   e.g. npm run new example-jp');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('Crawler name must be kebab-case: lowercase letters, digits and dashes.');
  process.exit(1);
}

const dir = path.join(root, 'crawlers', name);
if (existsSync(dir)) {
  console.error(`crawlers/${name} already exists.`);
  process.exit(1);
}

const pkg = {
  name: `@jscrawlers/${name}`,
  version: '1.0.0',
  private: true,
  type: 'module',
  description: `${name} crawler`,
  main: './src/index.js',
  scripts: {
    start: 'node --env-file-if-exists=../../.env src/index.js',
  },
  dependencies: {
    '@jscrawlers/core': '*',
    cheerio: '^1.0.0',
  },
};

const index = `import { runCrawler, fetchText, throttle, saveJson } from '@jscrawlers/core';
import * as cheerio from 'cheerio';

const NAME = '${name}';
const BASE_URL = process.env.${name.toUpperCase().replace(/-/g, '_')}_URL ?? 'https://example.com';

await runCrawler(NAME, async ({ log, signal }) => {
  const wait = throttle(1000); // be polite: ~1 request/sec

  await wait();
  const html = await fetchText(BASE_URL, { logger: log, signal });
  const $ = cheerio.load(html);

  const items = $('a')
    .toArray()
    .map((el) => ({
      title: $(el).text().trim(),
      href: new URL($(el).attr('href') ?? '', BASE_URL).href,
    }))
    .filter((item) => item.title);

  log.info(\`collected \${items.length} items\`);
  const file = await saveJson(NAME, '{stamp}.json', { scrapedAt: new Date().toISOString(), items });
  log.info(\`saved -> \${file}\`);

  return items;
});
`;

const readme = `# ${name}

## Run

\`\`\`bash
npm run crawl ${name}
\`\`\`

Output lands in \`data/${name}/\`.

## Notes

- Target: TODO
- Selectors / API endpoints: TODO
`;

await fs.mkdir(path.join(dir, 'src'), { recursive: true });
await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await fs.writeFile(path.join(dir, 'src', 'index.js'), index);
await fs.writeFile(path.join(dir, 'README.md'), readme);

console.log(`Created crawlers/${name}`);
console.log('Next:');
console.log('  npm install          # link the new workspace');
console.log(`  npm run crawl ${name}`);
