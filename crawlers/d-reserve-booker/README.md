# d-reserve-booker

Books a d-reserve.jp room **up to the JTB card page** when the
[`d-reserve-jp`](../d-reserve-jp/README.md) watcher reports it open, then sends
you the page to pay. It never pays.

It is a separate service, run by a separate account, for one reason: the
watcher is meant to be driven by an AI agent, and the things booking needs — the
d-reserve login, your name, phone, address and birthday, the payment link — must
stay out of anything that agent can read. It is an Express web service, so the
watcher can reach it from another device.

Isolation comes from **who can read the files**, not from which box they are on.
On a different machine that is automatic. On the same Mac as the watcher, run the
booker as a separate macOS user (see [Same Mac](#same-mac-a-separate-macos-user)):
an agent with a shell in your account can read your own `~/.config`.

```
 watcher (AI-driven)                      booker (separate account)
 ┌──────────────────────────┐   signed    ┌────────────────────────────────────┐
 │ d-reserve-jp             │POST /bookings d-reserve-booker --serve           │
 │  calendar → matches ─────┼────────────▶│  policy: dates, rooms, price cap   │
 │  knows: URL + secret     │◀────────────┼─ "accepted" / "locked" / ...       │
 └──────────────────────────┘  yes / no   │  login → booking page → entry      │
                                          │  → Telegram: ✅ 付款連結 / ❌ 原因   │
                                          └────────────────────────────────────┘
```

## What stays where

|                                          | watcher | booker                                  |
| ---------------------------------------- | ------- | --------------------------------------- |
| d-reserve login, guest details           | —       | `~/.config/d-reserve-booker/booker.env` |
| payload, site responses, payment link    | —       | `~/.local/share/d-reserve-booker/`      |
| what may be booked (dates, rooms, cap)   | —       | `booker.env`                            |
| booker URL + shared secret               | `.env`  | `booker.env`                            |
| room / date / plan / price of open rooms | sent    | received                                |

The booker refuses to start if its env file or data directory is inside this
repository, or if the env file is readable by anyone but you. Only source code
lives in the repo.

### What the shared secret can and cannot do

Whoever holds `BOOKER_SECRET` can ask the booker to book. They cannot choose
what it books: the cells in a request are only candidates, and the booker picks
from them using **its own** `BOOKER_DATES`, `BOOKER_ROOM_CODES` and
`BOOKER_MAX_PRICE`, books one at a time, and stops after one success until you
run `--reset`. The total on the booking page is checked against the cap again
before anything is submitted. The answer to a request never contains the
payment link, personal data or the site's error text.

Requests are HMAC-SHA256 signed over timestamp and body
(`packages/core/src/sign.js`), rejected when more than 60s old, and each
signature is accepted once.

## HTTP API

All requests are signed (below); unsigned ones get 401 before anything else
happens. Responses are JSON and never contain the payment link, personal data
or the site's error text.

| Method | Path        | Body                          | Answer                                                                       |
| ------ | ----------- | ----------------------------- | ---------------------------------------------------------------------------- |
| POST   | `/bookings` | `{ hotelCode, cells: [...] }` | 202 `{ accepted: true, submit, target }` — attempt started in the background |
|        |             |                               | 200 `{ accepted: false, reason }` — `locked`, `busy` or `no-eligible-cell`   |
|        |             |                               | 400 wrong hotel / bad JSON, 401 signature, 413 body over 16 KB               |
| POST   | `/book`     | same                          | alias of `/bookings` for older watchers                                      |
| GET    | `/health`   | —                             | 200 `{ ok, locked, busy, submit }`                                           |

A cell is `{ roomCode, salesDate, planCode, memberPrice, roomName? }`; anything
else in it is dropped. Signing, for a client written in anything:

```
x-signed-timestamp: <unix ms>
x-signed-signature: hex( HMAC-SHA256( BOOKER_SECRET, "<timestamp>.<raw body>" ) )
```

`/health` signs the empty string.

## Setup

```bash
git clone … && cd jscrawlers && npm install

mkdir -p ~/.config/d-reserve-booker
cp crawlers/d-reserve-booker/booker.env.example ~/.config/d-reserve-booker/booker.env
chmod 600 ~/.config/d-reserve-booker/booker.env
$EDITOR ~/.config/d-reserve-booker/booker.env      # login, dates, cap, Telegram
openssl rand -hex 32                               # → BOOKER_SECRET here and
                                                   #   DRESERVE_BOOKER_SECRET on the watcher
```

Bind `BOOKER_LISTEN` to the machine's Tailscale (or LAN) address, never a public
one, and set the watcher's `DRESERVE_BOOKER_URL` to it. If the watcher is on the
same Mac, `127.0.0.1` is enough.

### Same Mac: a separate macOS user

```bash
# once, from an admin account
sudo sysadminctl -addUser booker -fullName "d-reserve booker" -password -   # prompts
sudo chmod 700 /Users/booker

# everything else as that user
sudo -iu booker
git clone … ~/jscrawlers && cd ~/jscrawlers && npm install
# then the same booker.env steps as above, inside /Users/booker
```

The booker's env file, data and checkout then live in `/Users/booker`, which
your own account — and anything running in it — cannot read. Only the shared
secret is copied to the watcher's `.env`.

## Commands

Always start through `src/main.js` — it loads the env file from your home
directory. `npm run crawl d-reserve-booker` is refused on purpose: it would load
the repo's `.env` instead.

| Command                                              | What it does                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `node crawlers/d-reserve-booker/src/main.js --serve` | Listen for the watcher.                                        |
| `… --book 2026-10-29 RM00010236 PL00028613`          | One attempt by hand, rehearsal only.                           |
| `… --book … --confirm`                               | One attempt by hand that really submits.                       |
| `… --status`                                         | Lock, in-flight attempt, attempt counts.                       |
| `… --reset`                                          | Unlock and clear attempt counts after a booking is dealt with. |

## Rehearsal first

`BOOKER_SUBMIT=false` (the default) makes `--serve` accept requests, log in,
build the whole booking and stop just before submitting, sending you
`🧪 自動訂房演練（未送出）`. Rehearsals never lock or count as attempts. Leave it
like that until one has come through end to end, then set `BOOKER_SUBMIT=true`
and restart.

## After a request is accepted

1. The booker logs in, opens the booking page for that room, plan and date,
   fills it from `booker.env`, and posts it (`reservation/entry`).
2. On success you get `✅ 已送出訂房，請立即付款` with the JTB link. Open it on your
   phone, pay (JPY, EEA: No, 3-D Secure yourself). The booker is now **locked**.
3. On failure you get `❌ 自動訂房失敗` with the reason; the room is retried on a
   later poll, up to `BOOKER_MAX_ATTEMPTS`.
4. Once you have paid (or cancelled), `--reset` to let it book again.

## Files

```
~/.local/share/d-reserve-booker/d-reserve-booker/
  booking-state.json      lock, attempt counts, what was booked
  bookings.jsonl          one line per attempt (incl. rehearsals)
  booking/<stamp>-*.json  the exact payload sent and the site's answer
```

## Running it under launchd

Keep it resident with `KeepAlive`; `ProgramArguments` is the absolute node path,
`…/crawlers/d-reserve-booker/src/main.js` and `--serve`.

- Own machine, own account: a LaunchAgent in `~/Library/LaunchAgents`. `HOME` is
  yours, so the default paths work unchanged.
- Separate `booker` user on a shared Mac: that user is never logged in, so use a
  LaunchDaemon in `/Library/LaunchDaemons` with `UserName` = `booker` and
  `EnvironmentVariables` → `HOME` = `/Users/booker`. It then runs as `booker`
  from boot, with that user's files and nobody else's.
