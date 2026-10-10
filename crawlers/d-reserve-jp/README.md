# d-reserve-jp

Watches room availability for one hotel on [d-reserve.jp](https://d-reserve.jp),
records every change, and notifies you the moment a matching room opens up.

Built for the case where the hotel is sold out for months and the only way in is
to catch a cancellation. Two jobs, one fetch:

1. **History** — poll the calendar, store state changes, and report _when_
   cancellations tend to be released so you know when to be watching.
2. **Alerts** — match your dates / room / price and push to a webhook, Telegram,
   or a local command.

## Quick start

```bash
cp .env.example .env          # from the repo root; fill in DRESERVE_*
npm run crawl d-reserve-jp -- --dry-run     # look, touch nothing
npm run crawl d-reserve-jp                  # first run: establishes the baseline
```

The first run seeds the baseline and deliberately sends no alert (see
[First run](#first-run)). From then on, every run reports what changed.

## Commands

| Command                            | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npm run crawl d-reserve-jp`       | One poll, then exit. This is what cron/launchd runs.                 |
| `... -- --interval 5m`             | Stay resident and poll on a timer. Ctrl-C stops it.                  |
| `... -- --dry-run`                 | Fetch and show what _would_ happen. No state, no alerts.             |
| `... -- --notify-test`             | Send one fake alert to check your channels. Exits 1 if any fail.     |
| `... -- --ack [filter]`            | Stop the reminders for everything, or just what the filter names.    |
| `... -- --report`                  | Statistics from local data. Never touches the network.               |
| `... -- --report --since 7d`       | Same, limited to a recent window.                                    |
| `... -- --daily-summary`           | Send every daily digest still owed. This is what the 20:00 job runs. |
| `... -- --daily-summary --dry-run` | Print the digests instead of sending; leaves the checkpoint alone.   |

## The API

```
GET https://d-reserve.jp/v1/search/hotels/{hotelCode}/calendar
      ?fromYM=202610&toYM=202611
      &lodgerCode=0_1_2_3_4_6&lodgerNum=2_0_0_0_0_0&stays=1
      &onlyAllLanguagesPlan=false&onlyAllRankPlan=false
```

No auth, no cookies, and `robots.txt` is a 404. Findings worth knowing:

- **`fromYM`..`toYM` may not span more than 2 months.** A wider range returns
  HTTP 400 `AvailableYearMonthPeriodOutOfRange`. `monthWindows()` in `config.js`
  splits the configured range automatically, so 2026-09-10..2026-11-15 becomes
  two requests. Whole months come back regardless; out-of-range days are trimmed.
- **`lodgerNum` changes the answer.** Asking for 4 adults instead of 2 drops the
  room list from 14 to 10 (capacity filtering) and shifts prices. It must match
  what you would actually book.
- **`stays` does not affect this endpoint.** The calendar is per-night either
  way. It is kept configurable to stay consistent with the booking front end.
- **`salesAvailable` is the field that decides bookability** — not `stockStatus`.
  Only `SOLD_OUT`, `NO_SALE` and `FEW_STOCK` have been observed, but the site is
  free to add more, so an unrecognised value logs a warning and is otherwise
  ignored. Past dates come back as `NO_SALE` with a `null` plan, so prices are
  always null-checked.
- **`d-reserve.jp` has no front end.** Its own `/` is a 404 — it is an API host,
  and booking happens on the hotel's own site. That is why `DRESERVE_BOOKING_URL`
  exists: alerts have no link unless you supply one.

## Configuration

Everything lives in the repo-root `.env` (git-ignored); `.env.example` documents
every key. The essentials:

| Env                                         | Meaning                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `DRESERVE_HOTEL_CODE`                       | The hotel, e.g. `0000001834`                            |
| `DRESERVE_FROM_DATE` / `DRESERVE_TO_DATE`   | Check-in range to watch, `YYYY-MM-DD`                   |
| `DRESERVE_LODGER_NUM`                       | Party size — **changes which rooms and prices you see** |
| `DRESERVE_INTERVAL`                         | Resident-mode cadence, e.g. `5m`                        |
| `DRESERVE_REPORT_TZ`                        | Timezone for release-time stats (default `Asia/Tokyo`)  |
| `DRESERVE_DAILY_TZ` / `DRESERVE_DAILY_HOUR` | Digest window boundary (default `Asia/Taipei` 20:00)    |

### What to alert on

Blank means "do not restrict", so an empty watch config alerts on any bookable
room. All criteria are ANDed.

| Env                           | Example                                                          |
| ----------------------------- | ---------------------------------------------------------------- |
| `DRESERVE_WATCH_DATES`        | `2026-10-09,2026-11-01..2026-11-03` (dates and inclusive ranges) |
| `DRESERVE_WATCH_ROOM_CODES`   | `RM00010235,RM00010241`                                          |
| `DRESERVE_WATCH_ROOM_NAME`    | `露天風呂付` (substring of the room name)                        |
| `DRESERVE_WATCH_DAYS_OF_WEEK` | `FRIDAY,SATURDAY`                                                |
| `DRESERVE_WATCH_MAX_PRICE`    | `120000` (yen, whole stay, member price)                         |
| `DRESERVE_WATCH_MIN_STOCK`    | `1`                                                              |

Run `--dry-run` once to see the room codes and names for your hotel.

### Where alerts go

`DRESERVE_NOTIFY_CHANNELS` is a comma-separated list; blank logs only. Channels
are independent — one failing never silences the others or stops the crawl.

- `webhook` → POSTs the whole JSON payload to `NOTIFY_WEBHOOK_URL`, with
  `NOTIFY_WEBHOOK_HEADERS` as a JSON object for auth. Use for clawbot's HTTP
  interface, Discord, Slack, n8n.
- `telegram` → `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, straight to the Bot API.
- `command` → runs `NOTIFY_COMMAND` via `sh -c` with the JSON payload on
  **stdin**. Use for a clawbot CLI or a script that forwards to a session.
  Test it with `NOTIFY_COMMAND='cat >> /tmp/notify.log'`.

Always confirm with `--notify-test` before relying on it.

## Behaviour worth understanding

### First run

A first run has no baseline, so it cannot tell "just released" from "open for
weeks" — treating whatever is currently open as a release would be a false
signal, and with an empty watch filter it would fire for every incidentally
open room. So the baseline run logs what is bookable and sends nothing. Set
`DRESERVE_NOTIFY_ON_FIRST_RUN=true` if you would rather be told anyway.

### Not being spammed

A cancellation stays bookable across many polls. Alerts therefore fire on the
**rising edge** (not bookable → bookable), never once per poll. When a room
closes again its bookkeeping is dropped, so a later reopening is a fresh alert.

How long one opening keeps talking to you is `DRESERVE_NOTIFY_MODE`:

- **`once`** (default) — one message per opening, then silence. What a watcher
  has always done.
- **`until-ack`** — the same message again every `DRESERVE_NOTIFY_REPEAT_MIN`
  minutes until you say stop, or the room is taken. Use it when missing the
  alert means missing the room.

Two ways to say stop, both of which only affect rooms that are being announced
right now:

```bash
npm run crawl d-reserve-jp -- --ack              # everything
npm run crawl d-reserve-jp -- --ack 2026-10-09   # a date, a room code or a room name
```

or reply `/stop` (`/ack` works too, and both take the same optional filter) to
the Telegram bot. Commands are read at the start of each poll, so a `/stop` sent
a minute ago stops that poll's reminder. They are appended to `ack.jsonl` rather
than written into `state.json`, which is what makes `--ack` safe to run against a
watcher that is mid-poll: two writers that only append cannot clobber each other.

A room that goes away while `until-ack` is reminding you earns one closing
message — after a stream of reminders, silence on its own cannot be told apart
from a crawler that died. An ack does not outlive its room: once that room is
gone, a later reopening alerts again from scratch.

The repeat interval is quantised by the poll interval — a 5m poll with
`REPEAT_MIN=10` reminds you somewhere between 10 and 15 minutes apart.

**One bot, one listener.** Telegram's `getUpdates` hands each message to whoever
asks for it first and then deletes it, so two crawlers sharing a bot token would
steal each other's commands. Only this crawler listens; set
`DRESERVE_NOTIFY_ACK_TELEGRAM=false` to turn that off, or give each crawler its
own bot. A bot with a webhook configured cannot use `getUpdates` at all — that
shows up as a warning in the log and `--ack` still works.

### The daily digest

`--daily-summary` sends one message per day covering everything the watcher
recorded. It is independent of the watch filter: immediate alerts narrow to the
date you are booking, while the digest covers **every** room and date, which is
how the release pattern becomes visible.

Each digest covers a fixed half-open window:

```
[ previous day 20:00 (inclusive) , today 20:00 (exclusive) )
```

in `DRESERVE_DAILY_TZ`. An event at exactly 20:00:00 belongs to the _next_
window, so **every event lands in exactly one digest** — yesterday 20:00–24:00
arrives in the report sent at 20:00 today.

Which windows to send comes from a checkpoint
(`data/d-reserve-jp/daily-summary-state.json`), never from "now". So a sleeping
Mac, a missed schedule or a Telegram outage is recovered by simply running
again: pending windows go out oldest-first. Boundaries are computed per calendar
date rather than by adding 24h, so a DST zone still lands on local 20:00 (and
correctly yields a 23h or 25h window on the transition day).

The checkpoint only advances after **every segment on every configured channel**
has been delivered, and processing stops at the first failure rather than
skipping ahead. Two consequences worth knowing:

- Delivery is **at-least-once**, not exactly-once. If segment 3 of 5 fails, the
  whole window is resent on retry. A duplicate is recoverable; a gap is not.
- A permanently broken channel stalls the checkpoint and keeps retrying, by
  design — advancing past undelivered data would lose it silently. After three
  consecutive failures the log names the channel; fix it, or drop it from
  `DRESERVE_DAILY_CHANNELS` / `DRESERVE_NOTIFY_CHANNELS`.

Once the watched range reaches today, every room type of the current date stops
being sellable in the same poll. Those collapse into one line per date —
`🕛 2026-09-16 訂房截止（11:01 起 14 個房型下架）` plus the room names — instead of a
dozen near-identical blocks. A cell that did anything else that day keeps its own
timeline instead of joining the group.

On a first run with no checkpoint only the most recent complete window is sent,
so existing history does not arrive as a dozen messages.
`DRESERVE_DAILY_MAX_BACKFILL` (default 7) caps a long catch-up; skipped periods
are named in the first message. Long digests are split at line boundaries, never
mid-line, into `(1/n)` messages.

### Handing rooms to the booker

This crawler never books. Booking needs a login, guest details and a payment
link, none of which belong where this crawler (and whatever drives it) can read
them, so it lives in [`d-reserve-booker`](../d-reserve-booker/README.md) on
another machine.

With `DRESERVE_BOOKER_URL` and `DRESERVE_BOOKER_SECRET` set, every poll that
finds matches sends them — room, date, plan, price, nothing else — as a signed
request, before the alerts go out. The booker answers only yes or no:

```
已交給訂房機：2026-10-29 RM00010236
訂房機未受理：locked | busy | no-eligible-cell | unreachable (…)
```

An accepted hand-off adds `🤖 已交給訂房機` to that poll's alert. Whether the
booking then went through, and where to pay, the booker tells you directly; this
crawler never finds out. All matches are sent on every poll, the first run
included — what to book, and whether to retry, is the booker's call. A booker
that is down costs at most `DRESERVE_BOOKER_TIMEOUT_MS` and never the alert.

### Output

```
data/d-reserve-jp/
  state.json            latest full snapshot + notification bookkeeping
  events-YYYYMM.jsonl   only cells that changed — the history that matters
  polls.jsonl           one line per poll, including failures
  ack.jsonl             every "stop reminding me", from --ack or Telegram
  report-<stamp>.json   saved by --report
  daily-summary-state.json  digest checkpoint: last fully delivered window
  raw/<stamp>.json.gz   raw responses, only when DRESERVE_KEEP_RAW=true
```

Storing whole snapshots would be ~270k rows a day (938 cells every 5 minutes);
almost every poll changes nothing, so only changes are appended. `polls.jsonl`
is what lets `--report` tell "nothing was released" apart from "the crawler was
down" — without it the statistics would quietly lie.

Event kinds: `seed` (baseline, excluded from stats), `appear` (**a release**),
`disappear`, `stock`, `price`, `room_added`, `room_removed`.

A `price` event whose `to` side quotes no plan at all (both prices `null`) is not
a price move, so `--report` leaves it out of the price statistics. What it _is_
depends on the date: the check-in date arriving closes booking (訂房截止), while a
future date losing its last plan means it was booked — the `disappear` from the
same poll already says so, and the digest drops the duplicate price row rather
than calling it a withdrawal.

## Reading the report

```
釋出事件  12 次（時區 Asia/Tokyo）

     000000000011111111112222
     012345678901234567890123
Mon                ░           1
Tue               █▒           4
...
釋出後存活  中位數 25m  最短 6m  最長 3h 10m  (9 次完整觀測)
```

- The heatmap is when releases land, in the hotel's timezone. That is the answer
  to "when should I be watching?"
- **Survival time** is how long an opening lasted before someone booked it. If
  the shortest is under your poll interval, releases are being missed and
  `DRESERVE_INTERVAL` should come down.
- Any coverage gap is printed first, because a quiet stretch caused by downtime
  must not be read as a quiet market.

## Running it on the mac server

One-shot on a schedule is the recommended setup: each firing is its own process,
so a crash or hung request costs one poll rather than ending the watch.

```bash
cp crawlers/d-reserve-jp/launchd/jp.d-reserve.watch.plist.example \
   ~/Library/LaunchAgents/jp.d-reserve.watch.plist
# edit the paths inside, then:
launchctl load ~/Library/LaunchAgents/jp.d-reserve.watch.plist
tail -f data/d-reserve-jp/launchd.log
# to stop:
launchctl unload ~/Library/LaunchAgents/jp.d-reserve.watch.plist
```

launchd starts jobs with a bare environment and does not read your shell
profile, so use absolute paths (`nvm which 24`) and keep the `--env-file`
argument pointing at the repo's `.env`.

For resident mode instead, drop `StartInterval`, add `KeepAlive`, and append
`--interval` / `5m` to `ProgramArguments`.

### When the watcher itself fails

A failed poll used to be a log line, and a blocked watcher looks exactly like a
quiet market. Now every failure is counted in `state.json` (`health`), and:

- after `DRESERVE_HEALTH_ALERT_AFTER` (default 3) failures in a row you get
  `⚠️ d-reserve-jp 連續失敗 N 次`, repeated every `DRESERVE_HEALTH_REPEAT`
  (default `1h`) while it lasts;
- a 403/429/503, or an HTML page where JSON belongs (a WAF challenge), is marked
  **疑似被擋** and alerts on the first failure;
- the first good poll after an alert sends `✅ 已恢復，中斷 N 分鐘`.

These go to `DRESERVE_HEALTH_CHANNELS`, or `DRESERVE_NOTIFY_CHANNELS` when blank.
`polls.jsonl` records `blocked` and `status` for every failed poll.

### Polling faster without getting blocked

Each poll makes one request per two-month window of the range, so the request
rate is `windows × polls`. In order of effect:

1. **Narrow the range.** `DRESERVE_FROM_DATE`/`TO_DATE` spanning only the
   months you care about halves the requests per dropped window, at no cost.
2. **Back off when refused.** `DRESERVE_BACKOFF_BASE=2m` makes a failed poll
   pause the next ones (2m, 4m, 8m … up to `DRESERVE_BACKOFF_MAX`). A
   `Retry-After` is always honoured. The pause lives in `state.json`, so it
   works for launchd one-shots too.
3. **Do not retry within a poll.** `DRESERVE_HTTP_RETRIES=1` (or `0`) — at a
   short interval the next poll is the retry.
4. **Use resident mode.** `StartInterval` fires on an exact cadence; resident
   mode spreads each wait by `DRESERVE_INTERVAL_JITTER` (default ±20%).

### The 20:00 daily digest

A second job sends the digest, running alongside the polling job:

```bash
cp crawlers/d-reserve-jp/launchd/jp.d-reserve.daily.plist.example \
   ~/Library/LaunchAgents/jp.d-reserve.daily.plist
# edit the paths inside, then:
launchctl load ~/Library/LaunchAgents/jp.d-reserve.daily.plist
```

`StartCalendarInterval` follows the **system** timezone. If the machine is not
set to `DRESERVE_DAILY_TZ` the job fires at a different moment, but the window
comes from the checkpoint rather than the launch time, so the content stays
correct and anything missed is backfilled on the next run. The same holds when
the Mac is asleep at 20:00.

## Request volume

Two requests per poll (three months, 2-month API limit), so every 5 minutes is
~576 requests/day, with 1.5s of throttled jitter between windows. Narrowing the
range to 2 months or less makes it a single request per poll.
