/* Warplan Comms: the ball-in-whose-court ledger.
   GET  /api/comms                -> { items, days, updated }
   POST /api/comms {op, ...}      -> same, after the write
     op: merge   { items:[feedItem] }        nightly feed from the Mac (needs x-warplan-key)
         patch   { id, changes:{...} }       browser edits
         add     { item:{...} }              manual item from the browser
         delete  { id }
         snapshot {}                         records today's end-of-day score (feed does this too)
         requestSync {}                      browser asks for a fresh mail sync; the Mac polls and runs it
         syncStart / syncDone {note,error,mailboxStatus}   script bookkeeping (needs x-warplan-key)
         setConfig {composioKey?, mailboxes?[{id,on}]}   browser saves the Composio key / toggles mailboxes
   Auth: the app's session cookie (browser) OR header x-warplan-key === COMMS_KEY (script).
   Storage: Upstash Redis REST (KV_REST_API_URL / KV_REST_API_TOKEN), one key. */
const crypto = require('crypto');

const COOKIE = 'wp_session';
const KEY = 'warplan:comms';

function token(secret) {
  return crypto.createHmac('sha256', secret).update('warplan-v1').digest('hex');
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function authed(req) {
  const key = req.headers['x-warplan-key'];
  if (key && process.env.COMMS_KEY && safeEq(key, process.env.COMMS_KEY)) return 'script';
  const c = readCookie(req, COOKIE);
  if (c && process.env.SESSION_SECRET && safeEq(c, token(process.env.SESSION_SECRET))) return 'browser';
  return null;
}

async function redis(cmd) {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  if (!url || !tok) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN missing');
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
/* the first mailbox is the gog account the Mac script reads; set GOG_ACCOUNT in Vercel to show it here */
const DEFAULT_MAILBOXES = process.env.GOG_ACCOUNT
  ? [{ id: 'gog:' + process.env.GOG_ACCOUNT, label: 'Work', kind: 'gog', email: process.env.GOG_ACCOUNT, on: true }]
  : [];
/* Composio calendar connections (optional); add them through op setConfig */
const DEFAULT_CALENDARS = [];
async function load() {
  const raw = await redis(['GET', KEY]);
  const d = raw ? JSON.parse(raw) : {};
  const config = d.config || {};
  if (!Array.isArray(config.mailboxes) || !config.mailboxes.length) config.mailboxes = DEFAULT_MAILBOXES.map(m => ({ ...m }));
  config.mailboxStatus = config.mailboxStatus || {};
  if (!Array.isArray(config.calendars) || !config.calendars.length) config.calendars = DEFAULT_CALENDARS.map(c => ({ ...c }));
  return { items: d.items || [], days: d.days || {}, updated: d.updated || null, sync: d.sync || {}, config };
}
/* the browser never sees the key itself, only whether one is set */
function forBrowser(d) {
  const c = d.config || {};
  return { ...d, config: { mailboxes: c.mailboxes, mailboxStatus: c.mailboxStatus, calendars: c.calendars, calendarStatus: c.calendarStatus || {}, composioKeySet: !!c.composioKey } };
}
async function store(d) {
  d.updated = new Date().toISOString();
  await redis(['SET', KEY, JSON.stringify(d)]);
  return d;
}

const today = () => new Date().toISOString().slice(0, 10);

/* the feed proposes; the human's edits win until the thread moves on */
function merge(existing, feed) {
  const byId = new Map(existing.map(i => [i.id, i]));
  const seen = new Set();
  feed.forEach(f => {
    seen.add(f.id);
    const cur = byId.get(f.id);
    if (!cur) { byId.set(f.id, { ...f, status: f.ball === 'none' ? 'done' : 'open', createdAt: f.lastMsgAt || new Date().toISOString() }); return; }
    const moved = (f.lastMsgAt && cur.lastMsgAt && f.lastMsgAt > cur.lastMsgAt) || (f.lastMsgId && cur.lastMsgId && f.lastMsgId !== cur.lastMsgId);
    const next = { ...cur, subject: f.subject || cur.subject, counterparty: f.counterparty || cur.counterparty,
      lastMsgAt: f.lastMsgAt || cur.lastMsgAt, lastMsgId: f.lastMsgId || cur.lastMsgId, lastFrom: f.lastFrom || cur.lastFrom, mailbox: f.mailbox || cur.mailbox };
    if (moved) {
      /* the thread got a new message: take the feed's fresh read, keep the note */
      next.ball = f.ball; next.action = f.action; next.summary = f.summary; next.priority = f.priority;
      next.due = f.due; next.snoozedUntil = null;
      next.status = f.ball === 'none' ? 'done' : 'open';
      if (next.status === 'done' && !next.doneAt) next.doneAt = new Date().toISOString();
      if (next.status === 'open') next.doneAt = null;
    } else if (cur.status === 'open' && !cur.userEdited) {
      /* nothing new, item untouched by the human: allow the feed to sharpen the wording */
      next.action = f.action || cur.action; next.summary = f.summary || cur.summary;
      next.due = cur.due || f.due; next.priority = f.priority || cur.priority;
    }
    byId.set(f.id, next);
  });
  /* email items the feed no longer reports (older than its window) simply stay as they are */
  return Array.from(byId.values());
}

function snapshot(d) {
  const t = today();
  const open = d.items.filter(i => i.status === 'open' && i.ball === 'me');
  const overdue = open.filter(i => i.due && i.due < t && !(i.snoozedUntil && i.snoozedUntil >= t));
  const closed = d.items.filter(i => i.status === 'done' && i.doneAt && i.doneAt.slice(0, 10) === t).length;
  d.days[t] = { owed: open.length, overdue: overdue.length, closed };
  /* keep 120 days */
  Object.keys(d.days).sort().slice(0, -120).forEach(k => delete d.days[k]);
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const who = authed(req);
  if (!who) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
  try {
    if (req.method === 'GET') {
      const d = await load();
      return res.end(JSON.stringify(who === 'script' ? d : forBrowser(d)));
    }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('{"error":"method"}'); }
    let body = '';
    for await (const chunk of req) body += chunk;
    const p = body ? JSON.parse(body) : {};
    const d = await load();
    const now = new Date().toISOString();
    switch (p.op) {
      case 'merge': {
        if (who !== 'script') { res.statusCode = 403; return res.end('{"error":"merge needs the script key"}'); }
        d.items = merge(d.items, Array.isArray(p.items) ? p.items : []);
        snapshot(d);
        break;
      }
      case 'patch': {
        const it = d.items.find(i => i.id === p.id);
        if (!it) { res.statusCode = 404; return res.end('{"error":"no such item"}'); }
        const c = p.changes || {};
        ['action', 'due', 'ball', 'status', 'note', 'priority', 'snoozedUntil', 'counterparty'].forEach(k => { if (k in c) it[k] = c[k]; });
        it.userEdited = true; it.updatedAt = now;
        if ('status' in c) it.doneAt = c.status === 'done' ? now : null;
        snapshot(d);
        break;
      }
      case 'add': {
        const it = p.item || {};
        d.items.push({
          id: 'm_' + crypto.randomBytes(5).toString('hex'), source: 'manual',
          counterparty: it.counterparty || '', action: it.action || '', due: it.due || null,
          ball: it.ball === 'them' ? 'them' : 'me', priority: it.priority || 2, status: 'open',
          createdAt: now, lastMsgAt: now, userEdited: true
        });
        snapshot(d);
        break;
      }
      case 'delete': {
        d.items = d.items.filter(i => i.id !== p.id);
        snapshot(d);
        break;
      }
      case 'snapshot': { snapshot(d); break; }
      /* on-demand sync: the browser asks, the Mac polls every minute and answers */
      case 'requestSync': {
        d.sync = d.sync || {};
        const stale = !d.sync.requestedAt || (d.sync.finishedAt && d.sync.finishedAt > d.sync.requestedAt) || (Date.now() - Date.parse(d.sync.requestedAt) > 15 * 60 * 1000);
        if (stale) { d.sync.requestedAt = now; d.sync.startedAt = null; }
        break;
      }
      case 'setConfig': {
        d.config = d.config || {};
        if (typeof p.composioKey === 'string') d.config.composioKey = p.composioKey.trim() || null;
        if (Array.isArray(p.mailboxes)) {
          const on = new Map(p.mailboxes.map(m => [m.id, !!m.on]));
          d.config.mailboxes.forEach(m => { if (on.has(m.id)) m.on = on.get(m.id); });
        }
        break;
      }
      case 'setCalendars': {
        if (who !== 'script') { res.statusCode = 403; return res.end('{"error":"script only"}'); }
        d.config = d.config || {};
        const by = new Map((p.calendars || []).map(c => [c.id, c]));
        (d.config.calendars || []).forEach(c => { const u = by.get(c.id); if (u) { if (u.email) c.email = u.email; if (u.label) c.label = u.label; } });
        if (p.calendarStatus && typeof p.calendarStatus === 'object') d.config.calendarStatus = { ...(d.config.calendarStatus || {}), ...p.calendarStatus };
        break;
      }
      case 'setSources': {
        /* script only: replace the mailbox / calendar source lists (ids change when accounts are re-linked) */
        if (who !== 'script') { res.statusCode = 403; return res.end('{"error":"script only"}'); }
        d.config = d.config || {};
        if (Array.isArray(p.mailboxes)) d.config.mailboxes = p.mailboxes;
        if (Array.isArray(p.calendars)) d.config.calendars = p.calendars;
        if (typeof p.composioUserId === 'string') d.config.composioUserId = p.composioUserId;
        if (p.resetStatus) { d.config.mailboxStatus = {}; d.config.calendarStatus = {}; }
        break;
      }
      case 'syncStart': { if (who !== 'script') { res.statusCode = 403; return res.end('{"error":"script only"}'); } d.sync = d.sync || {}; d.sync.startedAt = now; break; }
      case 'syncDone': {
        if (who !== 'script') { res.statusCode = 403; return res.end('{"error":"script only"}'); }
        d.sync = d.sync || {}; d.sync.finishedAt = now; d.sync.startedAt = null; d.sync.note = String(p.note || '').slice(0, 200); d.sync.error = p.error ? String(p.error).slice(0, 200) : null;
        if (p.mailboxStatus && typeof p.mailboxStatus === 'object') { d.config = d.config || {}; d.config.mailboxStatus = { ...(d.config.mailboxStatus || {}), ...p.mailboxStatus }; }
        break;
      }
      default: { res.statusCode = 400; return res.end('{"error":"unknown op"}'); }
    }
    const saved = await store(d);
    return res.end(JSON.stringify(who === 'script' ? saved : forBrowser(saved)));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
