import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseItem, stripTags, ParseError } from '../src/item.js';
import { DEFAULT_BUY_KEYWORDS, DEFAULT_SOLD_OUT_KEYWORDS, itemUrl } from '../src/config.js';

const BASE = 'https://buy.gamer.com.tw';

/** parseItem with the default keyword lists, which is how the crawler calls it. */
function parseHtml(html, sn) {
  return parseItem(html, {
    sn,
    url: itemUrl(BASE, sn),
    buyKeywords: DEFAULT_BUY_KEYWORDS,
    soldOutKeywords: DEFAULT_SOLD_OUT_KEYWORDS,
  });
}

function parseFixture(name, sn) {
  return parseHtml(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'), sn);
}

test('a sold-out pre-order parses as not buyable', () => {
  const item = parseFixture('sold-out.html', '42810');

  assert.equal(item.buyable, false);
  assert.equal(item.buyAction, 'restock-notify');
  assert.deepEqual(item.buttons, ['補貨通知我']);
  assert.equal(item.status, '本商品已額滿或售完');
  assert.equal(item.title, '《薩爾達傳說》40 週年紀念 Nintendo Switch 2 Pro 控制器');
  assert.equal(item.platform, 'NS2');
  assert.equal(item.price, 2950);
  assert.equal(item.publishDate, '2026-10-29');
  assert.equal(item.url, 'https://buy.gamer.com.tw/atmItem.php?sn=42810');
});

test('an open pre-order parses as buyable, with the detail rows', () => {
  const item = parseFixture('in-stock.html', '41435');

  assert.equal(item.buyable, true);
  assert.equal(item.buyAction, 'buy');
  assert.deepEqual(item.buttons, ['前往預購', '加入購物車']);
  assert.equal(item.status, '熱烈預購中');
  assert.equal(item.title, '《空之軌跡 the 2nd》中文一般版（附贈巴哈玩家專屬特典）');
  assert.equal(item.platform, 'PS5');
  assert.equal(item.price, 1880);
  assert.equal(item.priceText, 'NT 1880 元');
  assert.equal(item.publishDate, '2026-09-17');
  assert.equal(item.details['版本發行'], '中文代理版 / Falcom');
  assert.equal(item.details['付款方式'], '貨到付款、信用卡付款');
  assert.match(item.imageUrl, /^https:\/\/p2\.bahamut\.com\.tw\//);
});

// 已發售 products show 前往購買 rather than 前往預購. A sold-out pre-order that
// only reopens after its release date lands here, so missing this keyword would
// keep the watcher silent through exactly the event it exists for.
test('前往購買 counts as buyable, not just 前往預購', () => {
  const item = parseHtml(
    '<div class="buy-products-btn-area"><a>前往購買</a><a>加入購物車</a></div>',
    '40346',
  );

  assert.equal(item.buyable, true);
  assert.equal(item.title, 'sn=40346'); // this stub has no detail block to read
});

test('a missing buy area is an error, never a silent "sold out"', () => {
  assert.throws(
    () => parseHtml('<html><body>版面改了</body></html>', '42810'),
    (error) => error instanceof ParseError && /buy-products-btn-area/.test(error.message),
  );
});

test('an unrecognised button is an error naming what it actually said', () => {
  assert.throws(
    () => parseHtml('<div class="buy-products-btn-area"><a>敬請期待</a></div>', '42810'),
    (error) => error instanceof ParseError && /敬請期待/.test(error.message),
  );
});

test('stripTags decodes entities and collapses whitespace', () => {
  assert.equal(stripTags('<p>A &amp; B\n  &nbsp; C</p>'), 'A & B C');
});
