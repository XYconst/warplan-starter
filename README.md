# Warplan

A yearly plan and a daily loop, in one private web app you add to your phone's home screen.

- **Plan**: a guided interview that turns into a one-page yearly board (pillars, outcomes, moves, weekly rules), a wall sheet and print-to-fill PDFs.
- **Today**: the day's calendar, the three things that make today a win, "do not miss" flags, and the emails you owe a reply to.
- **Week**: your fronts (the 5 to 7 projects that matter this week), each with a next move and steps.
- **Comms**: every email thread as "who has the ball": you, them, or nobody. Checkbox when done.
- **Morning brief** on Telegram at 07:45 and a **weekly recap** every Sunday at 18:00 (optional).

Nothing here sends email or money. Ever. It reads your mail and calendar, and it only writes to your own Warplan page and your own Telegram.

---

## Fastest way: let Claude Code set it up

1. Install [Claude Code](https://claude.com/claude-code) if you do not have it.
2. In Terminal:
   ```sh
   git clone https://github.com/XYconst/warplan-starter.git ~/warplan
   cd ~/warplan
   claude
   ```
3. Type: **set me up**

Claude reads `CLAUDE.md` in this folder and walks you through every step below, asking you only for the things it cannot do itself (logins, passwords).

---

## How it fits together

```
 your Mac (scheduled jobs)                 Vercel (the app)                 Upstash (storage)
 ─────────────────────────                 ────────────────                 ─────────────────
 comms/sync.js   reads Gmail (gog) ──┐
                 asks Claude who     ├──>  /api/comms   ─────────────────>  warplan:comms
                 has the ball        │
 today/sync.js   reads Calendar ─────┼──>  /api/today   ─────────────────>  warplan:today
 today/recap.js  Sunday plan ────────┘
                                           /            password-gated page (board.html)
 Telegram  <── morning brief + recap
```

- `board.html` is the whole front end. `build-web.sh` packs it into `web/` for Vercel.
- The plan itself (the yearly board) is saved **in your browser**. Use **More > Backup / restore** to keep a copy.
- Today / Week / Comms live in Upstash, so they are the same on phone and laptop.

## Manual setup

### 1. What you need
- A Mac with Node 18+ (`node -v`)
- [Claude Code](https://claude.com/claude-code), logged in (the scripts use `claude -p` to classify mail and write the recap)
- [gog](https://github.com/steipete/gogcli) (`brew install gogcli`) for Gmail + Calendar: load an OAuth client (`gog auth credentials`, see CLAUDE.md step 3), then `gog auth add you@company.com --readonly`
- Free accounts: [Vercel](https://vercel.com), [Upstash](https://upstash.com) (one Redis database, free tier is plenty)
- Optional: a Telegram bot from [@BotFather](https://t.me/BotFather) for the morning brief

### 2. Deploy the app
```sh
sh build-web.sh                 # packs board.html into web/lib/page.js
cd web
npx vercel link                 # create a new project, e.g. "warplan-yourname"
```
In the Vercel project settings, add these environment variables:

| Name | Value |
|---|---|
| `WARPLAN_PASSWORD` | the password you will type to open the app |
| `SESSION_SECRET` | any long random string (`openssl rand -hex 32`) |
| `COMMS_KEY` | another long random string; the Mac scripts use it to write |
| `KV_REST_API_URL` | from Upstash: your database > REST API > URL |
| `KV_REST_API_TOKEN` | from Upstash: same page, the token |
| `GOG_ACCOUNT` | your Google email (shows the mailbox in the app) |

Then `npx vercel --prod`. Open the URL, log in, and on your phone use Share > **Add to Home Screen**. The login lasts 90 days.

### 3. Connect your mail and calendar
```sh
cp comms/.env.example comms/.env      # fill in WARPLAN_URL, COMMS_KEY, GOG_ACCOUNT, OWNER_NAME, OWNER_CONTEXT
cp today/.env.example today/.env      # optional tweaks: calendars, time zone, weekly rules
node comms/sync.js --no-telegram      # first mail pass, takes a few minutes
node today/sync.js                    # pushes the calendar, prints the brief
```
Refresh the app: Comms and Today should now have content.

### 4. Telegram (optional)
Create a bot with @BotFather, put `TELEGRAM_BOT_TOKEN=...` in `comms/.env`, send your bot any message, then get your chat id:
```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9]*'
```
Put it in `comms/.env` as `TELEGRAM_CHAT_ID`. Test with `node today/sync.js --telegram`.

### 5. Put it on a schedule
```sh
sh launchd/install.sh
```
| Time | Job |
|---|---|
| 07:20 | mail sorted into the ledger |
| 07:45 | calendar pushed, morning brief to Telegram |
| 12:30, 17:30 | calendar refresh |
| Sunday 18:00 | weekly recap: rewrites next week's fronts, flags and daily wins |
| always | small poller that makes the in-app **Sync** button work |

Your Mac has to be awake for these to run. Remove them any time with `sh launchd/uninstall.sh`.

### 6. Set the first week by hand (optional)
Copy `today/seed.example.json` to `today/seed.json`, write your fronts and flags, then:
```sh
. comms/.env
curl -X POST "$WARPLAN_URL/api/today" -H "x-warplan-key: $COMMS_KEY" -H "content-type: application/json" \
  -d "{\"op\":\"seed\",$(tail -c +2 today/seed.json)"
```
After the first Sunday the recap keeps it up to date.

## Updating the app
Edit `board.html`, then `sh build-web.sh && cd web && npx vercel --prod`.
`sh build-local.sh` makes a `warplan.html` you can open straight from disk (Plan tab only, no live data).

## Privacy
- Your `.env` files, logs and `my-board.json` are gitignored. Keep it that way: never commit them.
- Mail content is sent to Claude (through your own Claude Code login) for classification, and only the result (who, what, due date) is stored in your Upstash.
- The app is behind your password and marked `noindex`.
