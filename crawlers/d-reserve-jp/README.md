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

| Command                      | What it does                                                     |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run crawl d-reserve-jp` | One poll, then exit. This is what cron/launchd runs.             |
| `... -- --interval 5m`       | Stay resident and poll on a timer. Ctrl-C stops it.              |
| `... -- --dry-run`           | Fetch and show what _would_ happen. No state, no alerts.         |
| `... -- --notify-test`       | Send one fake alert to check your channels. Exits 1 if any fail. |
| `... -- --report`            | Statistics from local data. Never touches the network.           |
| `... -- --report --since 7d` | Same, limited to a recent window.                                |

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

| Env                                       | Meaning                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| `DRESERVE_HOTEL_CODE`                     | The hotel, e.g. `0000001834`                            |
| `DRESERVE_FROM_DATE` / `DRESERVE_TO_DATE` | Check-in range to watch, `YYYY-MM-DD`                   |
| `DRESERVE_LODGER_NUM`                     | Party size — **changes which rooms and prices you see** |
| `DRESERVE_INTERVAL`                       | Resident-mode cadence, e.g. `5m`                        |
| `DRESERVE_REPORT_TZ`                      | Timezone for release-time stats (default `Asia/Tokyo`)  |

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
**rising edge** (not bookable → bookable), once. Set
`DRESERVE_NOTIFY_COOLDOWN_MIN` above 0 to be re-reminded every N minutes while a
room is still open. When a room closes again, its bookkeeping is dropped, so a
later reopening counts as a fresh alert.

### Output

```
data/d-reserve-jp/
  state.json            latest full snapshot + notification bookkeeping
  events-YYYYMM.jsonl   only cells that changed — the history that matters
  polls.jsonl           one line per poll, including failures
  report-<stamp>.json   saved by --report
  raw/<stamp>.json.gz   raw responses, only when DRESERVE_KEEP_RAW=true
```

Storing whole snapshots would be ~270k rows a day (938 cells every 5 minutes);
almost every poll changes nothing, so only changes are appended. `polls.jsonl`
is what lets `--report` tell "nothing was released" apart from "the crawler was
down" — without it the statistics would quietly lie.

Event kinds: `seed` (baseline, excluded from stats), `appear` (**a release**),
`disappear`, `stock`, `price`, `room_added`, `room_removed`.

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

## Request volume

Two requests per poll (three months, 2-month API limit), so every 5 minutes is
~576 requests/day, with 1.5s of throttled jitter between windows. Narrowing the
range to 2 months or less makes it a single request per poll.
