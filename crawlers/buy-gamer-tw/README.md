# buy-gamer-tw

監看巴哈姆特商城（buy.gamer.com.tw）的商品頁，**從「售罄」變成「可以下單」的那一刻發通知**。

預購品常常一開賣就額滿，之後因為取消訂單或追加配額會再度開放，沒人盯著就錯過了。
這支爬蟲定時輪詢商品頁，只在狀態由不可買翻成可買時才叫你。

## 設定

`.env`（完整註解在 repo 根目錄的 `.env.example`）：

```bash
BUYGAMER_ITEMS=42810,https://buy.gamer.com.tw/atmItem.php?sn=41435
BUYGAMER_INTERVAL=5m
BUYGAMER_NOTIFY_CHANNELS=telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

商品可以用編號（網址裡的 `sn`）或整條網址，混用也可以。

## 執行

```bash
npm run crawl buy-gamer-tw                   # 跑一輪
npm run crawl buy-gamer-tw -- --interval 5m  # 常駐輪詢，Ctrl-C 結束
npm run crawl buy-gamer-tw -- --dry-run      # 只印解析結果，不寫檔也不發通知
npm run crawl buy-gamer-tw -- --notify-test  # 測試通知管道通不通
```

輸出在 `data/buy-gamer-tw/`：

| 檔案                  | 內容                                                      |
| --------------------- | --------------------------------------------------------- |
| `state.json`          | 每件商品的最新快照，以及通知去重用的 `notified` 記帳      |
| `events-YYYYMM.jsonl` | 變更事件：`available` / `sold_out` / `price` / `status` … |
| `polls.jsonl`         | 每輪的時間、可下單件數、變更數、失敗數                    |
| `raw/`                | `BUYGAMER_KEEP_RAW=true` 時的 gzip 原始 HTML              |

## 怎麼判斷「可以下單」

看商品頁 `.buy-products-btn-area` 裡的按鈕文字，實測 18 個商品頁的結果：

| 商品狀態           | 按鈕                     | 判定     |
| ------------------ | ------------------------ | -------- |
| 熱烈預購中         | 前往預購 + 加入購物車    | 可以下單 |
| 已發售             | 前往購買 + 加入購物車    | 可以下單 |
| 本商品已額滿或售完 | 補貨通知我（只有這一顆） | 售罄     |

`前往購買` 和 `前往預購` 都要看：售罄的預購品若拖到發售日之後才開放，按鈕會是前者。

**判讀不出來就不更新狀態。** 抓不到按鈕區塊、或區塊裡沒有任何已知關鍵字，該商品這一輪
只留 warn log 與 `polls.jsonl` 的失敗記錄，不會動到既有狀態。把改版誤讀成「售罄」會讓監看
在最該叫的時候永遠安靜，那比漏抓一輪嚴重得多。

## 通知時機

- 只在**售罄 → 可下單**的上升緣通知，持續可買不會一直吵。
- `BUYGAMER_NOTIFY_COOLDOWN_MIN=30` 可在開放期間每 30 分鐘再提醒一次。
- 商品**第一次**被觀測到時沒有基準線，就算當下可買也只寫 log
  （`BUYGAMER_NOTIFY_ON_FIRST_RUN=true` 可改變）。所以往 `BUYGAMER_ITEMS` 新增商品不會噴假通知。
- 抓取失敗的商品沿用上一輪的狀態，避免一次 timeout 造成重複通知。

## 版面改版了怎麼辦

1. 看 log 裡 `購買按鈕沒有任何已知關鍵字（實際文字：「…」）`，那就是新的按鈕文字。
2. 暫時可以用 `BUYGAMER_BUY_KEYWORDS` / `BUYGAMER_SOLD_OUT_KEYWORDS` 補上，不必改程式。
3. 要重現問題時開 `BUYGAMER_KEEP_RAW=true`，`data/buy-gamer-tw/raw/` 會留下原始 HTML。
4. `src/item.js` 的 regex 與 `test/fixtures/` 的樣本頁是解析的唯一真相來源。

## 自動下單

偵測到「售罄 → 可下單」時直接下單：登入 → 前往預購 → 結帳頁選「貨到付款」、沿用預設的超商取貨 →
核對訂單資料 → 送出訂單 → 通知訂單編號。

商城的「商城訊息」「分級提醒」只是前端對話框；「前往預購」實際是 `POST /ajax/shopping_cart.php`
（token 嵌在商品頁裡），直接呼叫就不會跳出那些訊息。送出訂單則是 `getCSRFToken.php` →
`checkout_userdata.php` → `checkout_order_action.php`，和網頁按鈕送的內容一樣（`src/order.js`）。

「我同意以下事項：預購商品在出貨作業前刷卡失敗…」只有選**信用卡**付款的預購單才會出現，而且只是
前端檢查、不會送到伺服器；選貨到付款時頁面上沒有這個勾選框。

取貨方式沿用帳號的預設值，必須是**已設定門市的超商**。預設是宅配時會拒絕下單（網頁每次都要人選配送時段）。

### 設定

帳密、cookie、金額上限放在 **repo 外**（repo 可能被 AI agent 讀到）：

```bash
mkdir -p ~/.config/buy-gamer-tw
cp crawlers/buy-gamer-tw/order.env.example ~/.config/buy-gamer-tw/order.env
chmod 600 ~/.config/buy-gamer-tw/order.env   # 不是 600 會拒絕執行
```

| 位置                                       | 內容                                      |
| ------------------------------------------ | ----------------------------------------- |
| `~/.config/buy-gamer-tw/order.env`         | 帳密 / cookie、`BUYGAMER_ORDER_MAX_PRICE` |
| `~/.config/buy-gamer-tw/session.json`      | 登入後的 cookie，下次沿用                 |
| `~/.local/share/buy-gamer-tw/orders.jsonl` | 每次下單的結果                            |
| `~/.local/share/buy-gamer-tw/pages/`       | 結帳頁原始 HTML（含姓名地址）             |
| `~/.local/share/buy-gamer-tw/locks/`       | 下過單的商品，不會再自動下第二次          |

repo 的 `.env` 只放開關：`BUYGAMER_ORDER_ENABLED=true`，以及 `BUYGAMER_ORDER_ITEMS`（只自動下這些，留白 = 全部）。

### 登入

依序嘗試：上次的 `session.json` → `BUYGAMER_COOKIES` → 帳密。巴哈登入頁有 reCAPTCHA，帳密登入不帶驗證碼，
巴哈要求驗證時就會失敗（不會去繞過它）。那時在瀏覽器登入一次、勾「保持登入狀態」，把 `BAHAID` /
`BAHARUNE` / `BAHAENUR` 三個 cookie 貼進 `BUYGAMER_COOKIES`。

### 指令

```bash
npm run crawl buy-gamer-tw -- --login-test          # 只驗證登入，列出購物車
npm run crawl buy-gamer-tw -- --order-recon 43077   # 走到確認訂單資料為止，不送出、不上鎖、不通知
npm run crawl buy-gamer-tw -- --order 43077         # 手動下單一次（SUBMIT=true 才送出，送出後上鎖）
npm run crawl buy-gamer-tw -- --order-reset 43077   # 解鎖，允許再次自動下單
```

### 安全檢查

- 商品價格超過 `BUYGAMER_ORDER_MAX_PRICE` 就不下單。
- 商品已在購物車就不重複加入（避免數量變 2）；購物車裡有其他商品會在通知裡警告。
- 送出前核對：訂單裡只有這一件、數量 1、付款方式是貨到付款、總額不超過上限
  （`order.js` 的 `checkConfirmation`），任何一項不符就不送。
- `BUYGAMER_ORDER_SUBMIT=false`（預設）時只走到核對完成，通知你「未送出」。
- 送出**之前**就先上鎖，送出後不論成功或回應看不懂都維持上鎖，避免逾時重試造成重複訂單；
  回應看不懂時通知「結果不明」，請到商城訂單查詢確認。
- 首次觀測（沒有基準線）的商品不會自動下單；`--dry-run` 只印出會下單的商品。

## 定時執行（launchd）

`launchd/tw.buy-gamer.watch.plist.example` 每 5 分鐘跑一輪，每次都是獨立行程，
當掉只損失一輪而不是整個監看：

```bash
# 先把檔案裡的 /Users/YOU/git/jscrawlers 與 node 路徑換成實際的（nvm 用 `nvm which 24`）
cp crawlers/buy-gamer-tw/launchd/tw.buy-gamer.watch.plist.example \
   ~/Library/LaunchAgents/tw.buy-gamer.watch.plist
launchctl load ~/Library/LaunchAgents/tw.buy-gamer.watch.plist
tail -f data/buy-gamer-tw/launchd.log
```

停掉：`launchctl unload ~/Library/LaunchAgents/tw.buy-gamer.watch.plist`

## 注意

- 預設 1.5 秒抓一件商品，商品清單長就會拉長一輪的時間；別把間隔調得太兇。
- 限制級商品需要 `BUYGAMER_ADULT_COOKIE=true`（預設），否則會被導去 `warn.php` 而抓不到。
- 通知只代表「頁面顯示可以下單」，實際能不能結帳還是以網站為準。
