# Warplan: setup guide for Claude Code

The person running this wants their own Warplan. Walk them through README.md "Manual setup", one step at a time, doing everything you can yourself and asking them only for what needs their hands (logins, passwords, pasting tokens, clicking in a dashboard).

## How to run the setup
1. Check prerequisites yourself: `node -v` (18+), `which gog claude`, `npx vercel --version`. Install what is missing (`brew install gogcli` or see the gog README; `npm i -g vercel`). Ask before installing anything system-wide.
2. Ask for: their name, their Google email, a one-line description of their role (goes in `OWNER_CONTEXT`, e.g. "who runs operations at a marketing agency in Bulgaria"), their time zone (default Europe/Sofia), and whether they want Telegram.
3. Google: gog needs an OAuth client first. Either they get the team's client JSON privately from whoever shared this repo, or create one (Google Cloud console > APIs & Services > enable Gmail API + Google Calendar API > Credentials > OAuth client ID > Desktop app > download JSON). Then `gog auth credentials set <file.json>` and have them run `gog auth add <email> --readonly` themselves (it opens a browser; read-only scopes are all Warplan needs). Verify with `gog -a <email> gmail messages search "newer_than:1d" -j --results-only | head`. Never copy the client JSON into this repo.
4. Upstash: they create a free Redis database and paste the REST URL and token. Never echo the token back in full.
5. Generate `SESSION_SECRET` and `COMMS_KEY` with `openssl rand -hex 32`. Ask them to pick `WARPLAN_PASSWORD`.
6. `sh build-web.sh`, then in `web/`: `npx vercel link` (new project), add the env vars with `npx vercel env add <NAME> production`, then `npx vercel --prod`. Give them the URL.
7. Write `comms/.env` and `today/.env` from the examples. Run `node comms/sync.js --no-telegram`, then `node today/sync.js`. Tell them to open the app.
8. Telegram if wanted (README step 4), then `sh launchd/install.sh`.
9. Finish by telling them: open the app, the Plan tab starts the yearly interview; add the app to the phone home screen.

## Rules
- Never commit `.env`, logs, `my-board.json`, `today/seed.json`, or anything with a token. Check `git status` before any commit.
- The scripts must never send email or move money. Do not add that.
- Plain language with the user. Say what you are doing in one line, then do it.

## Code map
- `board.html`: the whole front end (no build step besides `build-web.sh`). Big file; edit surgically, never replace large regions.
- `web/api/index.js`: password gate, serves the page. `web/api/comms.js` and `web/api/today.js`: data API on Upstash (keys `warplan:comms`, `warplan:today`). Browser auth = session cookie, script auth = header `x-warplan-key: $COMMS_KEY`.
- `comms/sync.js`: gog mail -> `claude -p` classification -> /api/comms -> optional Telegram digest. Flags: `--no-telegram`, `--digest-only`, `--dry`, `--fetch-only`, `--if-requested`.
- `comms/poller.js`: always-on loop that runs a sync when the app's Sync button is pressed.
- `today/sync.js`: calendar -> /api/today -> morning brief (`--telegram`, `--dry`, `--brief-only`).
- `today/recap.js`: Sunday recap, rewrites fronts/flags/wins (`--dry` to preview, `--print` to not send).
- `today/ads.js`: optional Meta ad numbers (read-only) when `META_ACCOUNTS` is set.
- Gotcha: op `seed` with a `fronts` array replaces the whole list; to add one front use op `add`.
- Gotcha: if launchd jobs sit idle after install, `launchctl kickstart gui/$(id -u)/<label>`.
