import { runCrawler, fetchText, throttle, saveJson, parseArgs } from '@jscrawlers/core';
import * as cheerio from 'cheerio';

const NAME = 'd-reserve-jp';
const BASE_URL = process.env.D_RESERVE_JP_URL ?? 'https://d-reserve.jp/';

const { values } = parseArgs({
  pages: { type: 'string', default: '1' },
  delay: { type: 'string', default: '1000' },
});

await runCrawler(NAME, async ({ log, signal }) => {
  const pages = Number(values.pages);
  const wait = throttle(Number(values.delay));
  const items = [];

  for (let page = 1; page <= pages; page++) {
    if (signal.aborted) break;

    await wait();
    const url = page === 1 ? BASE_URL : new URL(`?page=${page}`, BASE_URL).href;
    const html = await fetchText(url, { logger: log, signal });
    const $ = cheerio.load(html);

    // TODO: replace with the real selectors for the target listing.
    const pageItems = $('a[href]')
      .toArray()
      .map((el) => ({
        title: $(el).text().trim().replace(/\s+/g, ' '),
        href: new URL($(el).attr('href'), url).href,
      }))
      .filter((item) => item.title);

    log.info(`page ${page}: ${pageItems.length} items`);
    items.push(...pageItems);
  }

  const file = await saveJson(NAME, '{stamp}.json', {
    source: BASE_URL,
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
  });
  log.info(`saved ${items.length} items -> ${file}`);

  return items;
});
