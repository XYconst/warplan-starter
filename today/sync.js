#!/usr/bin/env node
/* Warplan Today feed: reads the next 8 days of calendar through gog (every calendar listed in
   CALENDARS), pushes them to /api/today, and optionally sends the morning brief to your
   own Telegram: the day's schedule, what you owe (from the comms ledger), the fronts' next moves,
   and the open flags.

   Usage:  node sync.js                 calendar -> API, brief printed
           node sync.js --telegram      calendar -> API, brief sent to Telegram
           node sync.js --brief-only    no calendar fetch, brief from what the API holds
           node sync.js --dry           fetch + print, push nothing

   Env (today/.env, falls back to ../comms/.env): WARPLAN_URL, COMMS_KEY, GOG_ACCOUNT,
   TELEGRAM_CHAT_ID, CALENDARS (comma list of calendar ids, default primary), TZ_LABEL.
   The Telegram bot token is read from ~/.claude/channels/telegram/.env. Nothing here ever sends email. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ADS = require('./ads.js');

const HERE = __dirname;
const LOG = path.join(HERE, 'sync.log');
function log(s) { const line = new Date().toISOString() + ' ' + s; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} }
function loadEnv(file) {
  const out = {};
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
  return out;
}
const ENV = { ...loadEnv(path.join(HERE, '..', 'comms', '.env')), ...loadEnv(path.join(HERE, '.env')), ...process.env };
const TG = loadEnv(path.join(os.homedir(), '.claude/channels/telegram/.env'));
const ARGS = new Set(process.argv.slice(2));
const ACCOUNT = ENV.GOG_ACCOUNT;
if (!ACCOUNT) { console.error('Set GOG_ACCOUNT in comms/.env or today/.env'); process.exit(1); }
const CALENDARS = (ENV.CALENDARS || 'primary').split(',').map(s => s.trim()).filter(Boolean);
const CAL_LABELS = Object.fromEntries((ENV.CAL_LABELS || '').split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p[0] && p[1]));
const DAYS = +(ENV.CAL_DAYS || 8);
const TZ = ENV.TZ_LABEL || 'Europe/Sofia';

function gog(args) {
  return JSON.parse(execFileSync('gog', ['-a', ACCOUNT, ...args, '-j', '--results-only'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input: '' }));
}
function ymd(d) { return new Date(d.toLocaleString('en-US', { timeZone: TZ })).toISOString().slice(0, 10); }
function localYmd(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return p;
}

/* ---------- calendar ---------- */
function collectEvents() {
  const from = localYmd(new Date());
  const toD = new Date(); toD.setDate(toD.getDate() + DAYS);
  const to = localYmd(toD);
  const events = [];
  CALENDARS.forEach(cal => {
    let list;
    try { list = gog(['calendar', 'events', cal, '--from', from, '--to', to]); }
    catch (e) { log(`calendar ${cal} failed: ${String(e.message).split('\n').slice(-1)[0]}`); return; }
    (Array.isArray(list) ? list : []).forEach(e => {
      if (e.status === 'cancelled') return;
      const st = e.start || {}, en = e.end || {};
      const label = CAL_LABELS[cal] || (cal === 'primary' ? 'Work' : cal.split('@')[0]);
      events.push({
        id: cal + ':' + (e.id || e.iCalUID || ''),
        cal: label,
        title: e.summary || (label + ' (private)'),
        start: st.dateTime || st.date || '',
        end: en.dateTime || en.date || '',
        allDay: !st.dateTime,
        who: (e.attendees || []).map(a => a.email).filter(a => a && a.toLowerCase() !== ACCOUNT.toLowerCase()),
        link: e.hangoutLink || (e.conferenceData && e.conferenceData.entryPoints || []).map(p => p.uri).find(u => /meet|zoom|teams/.test(u || '')) || '',
        where: e.location || '',
        htmlLink: e.htmlLink || ''
      });
    });
    log(`calendar ${cal}: ${(Array.isArray(list) ? list : []).length} events`);
  });
  events.sort((a, b) => a.start < b.start ? -1 : 1);
  return events;
}

/* ---------- the other calendars, through Composio ---------- */
let COMPOSIO_USER = ENV.COMPOSIO_USER_ID || 'default';
async function composio(key, slug, ca, args) {
  const r = await fetch('https://backend.composio.dev/api/v3/tools/execute/' + slug, {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ connected_account_id: ca, user_id: COMPOSIO_USER, arguments: args })
  });
  const j = await r.json();
  if (!r.ok || j.successful === false || j.error) throw new Error((j.error && (j.error.message || j.error)) || (j.data && j.data.error) || ('composio ' + r.status));
  return j.data || {};
}
function labelFor(email) {
  const e = (email || '').toLowerCase();
  if (!e) return null;
  if (ACCOUNT && e === ACCOUNT.toLowerCase()) return 'Work';
  if (e.includes('gmail.com')) return 'Personal';
  return e.split('@')[0];
}
async function collectComposioEvents(events) {
  let cfg;
  try { cfg = (await api('/api/comms', 'GET')).config || {}; } catch (e) { log('comms config unreadable: ' + e.message); return; }
  const key = cfg.composioKey, cals = (cfg.calendars || []).filter(c => c.on !== false && c.kind === 'composio');
  if (cfg.composioUserId) COMPOSIO_USER = cfg.composioUserId;
  if (!cals.length) return;
  if (!key) { log(`calendars via composio: ${cals.length} linked, waiting for the Composio key`); return; }
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const toD = new Date(); toD.setDate(toD.getDate() + DAYS); toD.setHours(23, 59, 59, 0);
  const resolved = [], status = {};
  for (const c of cals) {
    try {
      if (!c.email) {
        /* which Google account is this? the primary calendar's id is the address */
        let list = null;
        for (const slug of ['GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_GET_CALENDAR']) {
          try { list = await composio(key, slug, c.id, slug === 'GOOGLECALENDAR_GET_CALENDAR' ? { calendar_id: 'primary' } : {}); break; } catch (e) { list = { _err: e.message }; }
        }
        const items = list.items || list.calendars || (list.id ? [list] : []);
        const prim = items.find(x => x.primary) || items.find(x => /@/.test(x.id || '')) || items[0];
        if (prim && prim.id) { c.email = prim.id; c.label = labelFor(prim.id); resolved.push({ id: c.id, email: c.email, label: c.label }); }
        else throw new Error('could not read the primary calendar: ' + (list._err || JSON.stringify(list).slice(0, 120)));
      }
      const label = c.label || labelFor(c.email) || c.id;
      const already = (c.email || '').toLowerCase() === ACCOUNT.toLowerCase() || CALENDARS.some(x => x.toLowerCase() === (c.email || '').toLowerCase());
      if (already) { status[c.id] = { ok: true, note: 'already read via gog', at: new Date().toISOString() }; continue; }
      let data = null, lastErr = '';
      for (const [slug, args] of [
        ['GOOGLECALENDAR_EVENTS_LIST', { calendarId: 'primary', timeMin: from.toISOString(), timeMax: toD.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 }],
        ['GOOGLECALENDAR_FIND_EVENT', { calendar_id: 'primary', timeMin: from.toISOString(), timeMax: toD.toISOString(), single_events: true, order_by: 'startTime', max_results: 100 }]
      ]) { try { data = await composio(key, slug, c.id, args); break; } catch (e) { lastErr = e.message; } }
      if (!data) throw new Error(lastErr || 'no events tool worked');
      const items = data.items || data.events || data.event_data || (data.response_data && data.response_data.items) || [];
      let n = 0;
      items.forEach(e => {
        if (e.status === 'cancelled') return;
        const st = e.start || {}, en = e.end || {};
        events.push({
          id: c.id + ':' + (e.id || e.iCalUID || ''), cal: label,
          title: e.summary || (label + ' (private)'),
          start: st.dateTime || st.date || '', end: en.dateTime || en.date || '', allDay: !st.dateTime,
          who: (e.attendees || []).map(a => a.email).filter(a => a && a.toLowerCase() !== (c.email || '').toLowerCase()),
          link: e.hangoutLink || ((e.conferenceData && e.conferenceData.entryPoints) || []).map(p => p.uri).find(u => /meet|zoom|teams/.test(u || '')) || '',
          where: e.location || '', htmlLink: e.htmlLink || ''
        });
        n++;
      });
      status[c.id] = { ok: true, note: `${n} events`, at: new Date().toISOString() };
      log(`calendar ${label} (composio): ${n} events`);
    } catch (e) {
      status[c.id] = { ok: false, note: String(e.message || e).slice(0, 160), at: new Date().toISOString() };
      log(`calendar ${c.label || c.id} failed: ${e.message}`);
    }
  }
  try { await api('/api/comms', 'POST', { op: 'setCalendars', calendars: resolved, calendarStatus: status }); } catch (e) { log('could not record calendar status: ' + e.message); }
  events.sort((a, b) => a.start < b.start ? -1 : 1);
}

/* ---------- API ---------- */
async function api(pathname, method, body) {
  const url = (ENV.WARPLAN_URL || '').replace(/\/$/, '') + pathname;
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-warplan-key': ENV.COMMS_KEY || '' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(pathname + ': ' + (j.error || r.status));
  return j;
}

/* ---------- the brief ---------- */
function hm(iso) {
  if (!iso || iso.length <= 10) return 'all day';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function briefText(today, comms, ads) {
  const t = localYmd(new Date());
  const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const ev = (today.calendar.events || []).filter(e => (e.start || '').slice(0, 10) === t && !/Morning OS|Evening OS|Admin \+ Money/.test(e.title));
  const live = i => i.status === 'open' && !(i.snoozedUntil && i.snoozedUntil > t);
  const mine = (comms.items || []).filter(i => live(i) && i.ball === 'me').sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);
  const overdue = mine.filter(i => i.due && i.due < t);
  const fronts = (today.fronts || []).filter(f => f.status !== 'done').sort((a, b) => a.order - b.order);
  const flags = (today.flags || []).filter(f => !f.done && (f.kind === 'money' || f.kind === 'risk' || (f.due && f.due <= t)));
  const L = [];
  L.push(`Warplan · ${dayName}`);
  if (today.brief) { L.push(''); L.push(today.brief); }
  const three = (today.wins || {})[t] || [];
  if (three.length) { L.push(''); L.push('The three that make today:'); three.forEach(w => L.push((w.done ? 'x ' : '- ') + w.t)); }
  L.push('');
  L.push(ev.length ? 'Today:' : 'Today: no meetings.');
  ev.forEach(e => L.push(`${hm(e.start)}  ${e.title}${e.who && e.who.length ? ' · ' + e.who.length + ' people' : ''}`));
  if (flags.length) { L.push(''); L.push('Do not miss:'); flags.slice(0, 6).forEach(f => L.push(`!! ${f.text}${f.due ? ' (' + f.due + ')' : ''}`)); }
  L.push('');
  L.push(`You owe ${mine.length}${overdue.length ? ', ' + overdue.length + ' overdue' : ''}:`);
  mine.slice(0, 8).forEach(i => L.push(`${i.due && i.due < t ? '!! ' : '- '}${i.counterparty}: ${i.action}${i.due ? ' (' + i.due + ')' : ''}`));
  if (mine.length > 8) L.push(`… and ${mine.length - 8} more`);
  if (ads && ads.length) { L.push(''); L.push('Ads, last 7 days:'); ADS.adsLines(ads).forEach(l => L.push(l)); }
  if (fronts.length) {
    L.push('');
    L.push('Fronts, next move:');
    fronts.slice(0, 6).forEach(f => L.push(`- ${f.name}: ${f.next}${f.status === 'blocked' ? ' [blocked' + (f.blocker ? ': ' + f.blocker : '') + ']' : ''}`));
  }
  L.push('');
  L.push((ENV.WARPLAN_URL || '') + ' → Today');
  return L.join('\n');
}
async function telegram(text) {
  const tok = TG.TELEGRAM_BOT_TOKEN || ENV.TELEGRAM_BOT_TOKEN, chat = ENV.TELEGRAM_CHAT_ID;
  if (!tok || !chat) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
  const j = await r.json();
  if (!j.ok) throw new Error('telegram: ' + JSON.stringify(j).slice(0, 200));
}

/* ---------- main ---------- */
(async () => {
  try {
    let today;
    if (!ARGS.has('--brief-only')) {
      const events = collectEvents();
      await collectComposioEvents(events);
      if (ARGS.has('--dry')) { console.log(JSON.stringify(events, null, 2)); return; }
      let ads = [];
      try { ads = await ADS.fetchAds(ENV); log(`ads: ${ads.length} accounts read`); } catch (e) { log('ads failed: ' + e.message); }
      today = await api('/api/today', 'POST', { op: 'merge', calendar: { events }, flags: ADS.adsFlags(ads, ENV) });
      today.__ads = ads;
      log(`pushed ${events.length} events`);
    } else {
      today = await api('/api/today', 'GET');
    }
    let comms = { items: [] };
    try { comms = await api('/api/comms', 'GET'); } catch (e) { log('comms ledger unavailable: ' + e.message); }
    const text = briefText(today, comms, today.__ads || []);
    if (!ARGS.has('--telegram')) { console.log('\n' + text); log('brief printed, not sent'); return; }
    await telegram(text);
    log('brief sent to telegram');
  } catch (e) {
    log('FAILED: ' + (e.stack || e));
    process.exitCode = 1;
  }
})();
