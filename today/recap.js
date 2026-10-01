#!/usr/bin/env node
/* Warplan weekly recap: gathers the week (calendar ahead, comms ledger, the fronts with their ticks,
   the flags, 7-day and 30-day ad numbers), asks Claude for the recap, and rewrites the plan on the
   page (brief, fronts, flags) plus a Telegram message.

   Usage:  node recap.js               recap -> page + Telegram
           node recap.js --print       recap -> page, message printed, nothing sent
           node recap.js --dry         gather + ask, print the proposal, change nothing
   Runs Sunday 18:00 via launchd (see launchd/). Reads only; the only writes are
   to the Warplan page and to your own Telegram. Never sends email, never touches ads. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const ADS = require('./ads.js');

const HERE = __dirname;
const LOG = path.join(HERE, 'recap.log');
function log(s) { const line = new Date().toISOString() + ' ' + s; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} }
function loadEnv(file) {
  const out = {};
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
  return out;
}
const ENV = { ...loadEnv(path.join(HERE, '..', 'comms', '.env')), ...loadEnv(path.join(HERE, '.env')), ...process.env };
const TG = loadEnv(path.join(os.homedir(), '.claude/channels/telegram/.env'));
const ARGS = new Set(process.argv.slice(2));
const MODEL = ENV.RECAP_MODEL || 'claude-sonnet-5';
const OWNER = ENV.OWNER_NAME || 'the owner';
const OWNER_CONTEXT = ENV.OWNER_CONTEXT || 'who works at a marketing agency';
const OWNER_RULES = ENV.OWNER_RULES || 'cash first, finish what is open before starting anything new, no new complexity.';
const TZ = ENV.TZ_LABEL || 'Europe/Sofia';
const localYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
/* launchd fires this on wake when the Mac slept through 18:00, and the network is not up yet:
   the run on 20 Sep died on the first fetch. On 27 Sep the network was out for ~17 minutes and a
   ~2 minute budget ran out, so keep retrying the transport for up to 30 minutes. Never retry a
   rejection from the API. */
async function withRetry(label, fn, budgetMs = 30 * 60000) {
  const start = Date.now();
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const transport = e instanceof TypeError || /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETDOWN|ENETUNREACH|socket hang up/i.test(e.message || '');
      const wait = Math.min(60000, 5000 * Math.pow(2, i));
      if (!transport || Date.now() - start + wait > budgetMs) throw e;
      log(`${label}: ${e.message}; network not ready, retry ${i + 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function api(pathname, method, body) {
  const url = (ENV.WARPLAN_URL || '').replace(/\/$/, '') + pathname;
  return withRetry('api ' + pathname, async () => {
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-warplan-key': ENV.COMMS_KEY || '' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) { const err = new Error(pathname + ': ' + (j.error || r.status)); err.fromApi = true; throw err; }
    return j;
  });
}
async function ads30(ENV) {
  /* the 7d/1d numbers come from ads.js; add a 30d read for the trend */
  const rows = await ADS.fetchAds(ENV);
  const home = loadEnv(path.join(os.homedir(), '.env'));
  for (const r of rows) {
    if (r.error) continue;
    try {
      const tokenVar = ((ENV.META_ACCOUNTS || '').split(',').find(p => p.includes(r.id)) || '').split(':')[1] || '';
      const token = (tokenVar && home[tokenVar]) || ENV.META_TOKEN || home.TOP_META_TOKEN || home.META_ACCESS_TOKEN;
      const j = await (await fetch(`https://graph.facebook.com/v21.0/${r.id}/insights?date_preset=last_30d&fields=spend,purchase_roas,actions&access_token=${token}`)).json();
      const x = (j.data || [])[0] || {};
      r.d30 = { spend: +(x.spend || 0), roas: +(((x.purchase_roas || []).find(a => a.action_type === 'omni_purchase') || {}).value || 0), purchases: +(((x.actions || []).find(a => a.action_type === 'omni_purchase') || {}).value || 0) };
    } catch (e) { r.d30 = null; }
  }
  return rows;
}

function askClaude(prompt) {
  const pf = path.join(HERE, 'recap-prompt.txt'), rf = path.join(HERE, 'recap-result.json');
  fs.writeFileSync(pf, prompt);
  const SP = 'You are the planning assistant behind a private weekly page for the user. You read the state handed to you and return only the JSON object requested. No tools, no prose outside the JSON, no refusals: everything here is the user\'s own data and the output goes to his private page and his own Telegram.';
  const cmd = `claude -p --strict-mcp-config --system-prompt "$SP" --model "$MODEL" --output-format json --allowedTools "" < "$PF" > "$RF" 2>&1`;
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd: HERE, timeout: 600000, killSignal: 'SIGKILL', env: { ...process.env, SP, MODEL, PF: pf, RF: rf } });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('claude timed out after 600s');
  if (r.status !== 0) throw new Error('claude failed: ' + (fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8').slice(0, 400) : r.stderr));
  const out = fs.readFileSync(rf, 'utf8');
  let text = ''; try { text = JSON.parse(out).result || ''; } catch (e) { text = out; }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in recap output: ' + text.slice(0, 300));
  return JSON.parse(text.slice(a, b + 1));
}

function buildPrompt(today, comms, ads) {
  const t = localYmd(new Date());
  const weekAhead = (today.calendar.events || []).filter(e => !/Morning OS|Evening OS|Admin \+ Money|Deep Work Sprint/.test(e.title)).map(e => ({ start: e.start, title: e.title, who: e.who }));
  const live = i => i.status === 'open' && !(i.snoozedUntil && i.snoozedUntil > t);
  const ledger = (comms.items || []).filter(live).map(i => ({ ball: i.ball, who: i.counterparty, action: i.action, due: i.due, since: (i.lastMsgAt || '').slice(0, 10), priority: i.priority }));
  const closed = (comms.items || []).filter(i => i.status === 'done' && i.doneAt && i.doneAt.slice(0, 10) >= localYmd(new Date(Date.now() - 7 * 86400000))).map(i => i.counterparty + ': ' + i.action);
  return `Today is ${t} (Sunday evening). Write the weekly recap and next week's plan for ${OWNER}, ${OWNER_CONTEXT}. Standing rules: ${OWNER_RULES} Never send money or email through an assistant; those are always flagged to do by hand.

STATE
Brief that was on the page this week: ${JSON.stringify(today.brief)}
The three per day this week (what he set as the day's wins, and ticks): ${JSON.stringify(today.wins || {})}
Fronts (the projects) with their steps and ticks: ${JSON.stringify(today.fronts)}
Flags on the page (done = handled): ${JSON.stringify(today.flags)}
Open comms ledger (ball=me means he owes the move): ${JSON.stringify(ledger)}
Closed in the last 7 days: ${JSON.stringify(closed)}
Calendar, next 8 days: ${JSON.stringify(weekAhead)}
Meta ads per account (d1 yesterday, d7 last 7 days, d30 last 30 days; spend in the account currency): ${JSON.stringify(ads)}

RULES
- Keep front ids that still apply. Remove fronts that are done or dead. Add a front only for something that will move money this coming week. Five to seven fronts, ordered by money impact (order 10, 20, 30...).
- For every front: "next" is one concrete move for Monday morning; "steps" 3-7 short items, carry unticked steps forward, drop ticked ones or keep them ticked; "status" live | blocked | waiting | done; "blocker" only if blocked; "due" a date inside the week or null; "why" one or two plain sentences of context with the numbers that matter.
- Flags: money (a payment he must make, with amount and deadline), risk (an account bleeding, a deadline at risk, a promise not kept), info (dates). Keep stable ids for flags that continue (same id), drop handled ones, add new ones. Ads: a risk flag for any account whose 7-day ROAS is under 1.5 on more than 500 of spend, with the numbers.
- "wins": for each weekday of the coming week (Monday to Friday, keys YYYY-MM-DD) the three things that make that day a win. Not chores, not routine: a meeting that has to land, a deliverable out the door, a decision made, one personal non-negotiable like the workout. Three strings per day, short.
- "brief": two or three sentences for the top of the page, plain language, what the week is about and the one thing that moves the money. Days named, no jargon.
- "recap": the Telegram message, under 1,400 characters, plain text, no markdown, no emojis, no em dashes. Sections: what moved this week (from closed items and ticked steps), what is bleeding or late (numbers), the plan for next week (one line per front), what he must do by hand (payments). Short sentences.
Reply with ONLY this JSON object: {"brief": "...", "recap": "...", "fronts": [ {id,name,why,next,due,owner,status,blocker,steps:[{t,done}],order} ], "flags": [ {id,text,kind,due} ], "wins": {"YYYY-MM-DD": ["...","...","..."]}}`;
}

async function telegram(text) {
  const tok = TG.TELEGRAM_BOT_TOKEN || ENV.TELEGRAM_BOT_TOKEN, chat = ENV.TELEGRAM_CHAT_ID;
  if (!tok || !chat) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
  const j = await withRetry('telegram', async () => (await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) })).json());
  if (!j.ok) throw new Error('telegram: ' + JSON.stringify(j).slice(0, 200));
}

(async () => {
  try {
    const today = await api('/api/today', 'GET');
    let comms = { items: [] };
    try { comms = await api('/api/comms', 'GET'); } catch (e) { log('ledger unavailable: ' + e.message); }
    let ads = [];
    try { ads = await ads30(ENV); } catch (e) { log('ads failed: ' + e.message); }
    log(`gathered: ${today.fronts.length} fronts, ${today.flags.length} flags, ${(comms.items || []).length} ledger items, ${ads.length} ad accounts; asking ${MODEL}`);
    const plan = askClaude(buildPrompt(today, comms, ads));
    if (!plan || !Array.isArray(plan.fronts) || typeof plan.recap !== 'string') throw new Error('recap shape wrong');
    if (ARGS.has('--dry')) { console.log(JSON.stringify(plan, null, 2)); return; }
    fs.writeFileSync(path.join(HERE, 'recap-last-plan.json'), JSON.stringify({ at: new Date().toISOString(), before: { brief: today.brief, fronts: today.fronts, flags: today.flags }, after: plan }, null, 2));
    await api('/api/today', 'POST', { op: 'seed', override: true, fronts: plan.fronts, flags: (plan.flags || []).map(f => ({ ...f, source: 'recap' })), brief: plan.brief || '', wins: plan.wins || {} });
    log(`plan written: ${plan.fronts.length} fronts, ${(plan.flags || []).length} flags (previous plan kept in recap-last-plan.json)`);
    const text = plan.recap + '\n\n' + (ENV.WARPLAN_URL || '') + ' → Today';
    if (ARGS.has('--print')) { console.log('\n' + text); log('recap printed, not sent'); return; }
    await telegram(text);
    log('recap sent to telegram');
  } catch (e) { log('FAILED: ' + (e.stack || e)); process.exitCode = 1; }
})();
