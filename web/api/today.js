/* Warplan Today: the day's schedule, the week's fronts, and the flags that need a decision.
   GET  /api/today                 -> { calendar, fronts, flags, brief, updated }
   POST /api/today {op, ...}       -> same, after the write
     op: merge   { calendar, flags:[feedFlag], brief }   the feed from the Mac (x-warplan-key)
         seed    { fronts, flags, wins:{date:[...]} }    replace the plan (x-warplan-key)
         win     { date, idx, changes } | { date, add } | { date, remove }   today's three
         patch   { kind:'front'|'flag', id, changes }    browser edits
         add     { kind, item }
         delete  { kind, id }
         step    { id, idx, done }                       tick a step on a front
   Auth: the app's session cookie (browser) OR header x-warplan-key === COMMS_KEY (script).
   Storage: Upstash Redis REST, one key. Same database as the comms ledger. */
const crypto = require('crypto');

const COOKIE = 'wp_session';
const KEY = 'warplan:today';

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
async function load() {
  const raw = await redis(['GET', KEY]);
  const d = raw ? JSON.parse(raw) : {};
  return {
    calendar: d.calendar || { fetchedAt: null, events: [] },
    fronts: d.fronts || [],
    flags: d.flags || [],
    brief: d.brief || '',
    wins: d.wins || {},
    updated: d.updated || null
  };
}
async function store(d) {
  d.updated = new Date().toISOString();
  await redis(['SET', KEY, JSON.stringify(d)]);
  return d;
}

const uid = p => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const str = (v, n) => String(v == null ? '' : v).slice(0, n || 400);

function cleanFront(f) {
  return {
    id: f.id || uid('f'),
    name: str(f.name, 80),
    why: str(f.why, 240),
    next: str(f.next, 240),
    due: f.due ? str(f.due, 10) : null,
    owner: str(f.owner || 'me', 40),
    status: ['live', 'blocked', 'waiting', 'done'].includes(f.status) ? f.status : 'live',
    blocker: str(f.blocker, 240),
    steps: Array.isArray(f.steps) ? f.steps.slice(0, 12).map(s => ({ t: str(s.t, 160), done: !!s.done })) : [],
    order: Number.isFinite(+f.order) ? +f.order : 50,
    userEdited: !!f.userEdited,
    doneAt: f.doneAt || null
  };
}
/* the seed may set a day's three; a tick the human already made on the same wording survives */
function cleanWins(list, cur) {
  const done = new Set((cur || []).filter(w => w.done).map(w => w.t));
  return (Array.isArray(list) ? list : []).slice(0, 3).map(w => typeof w === 'string' ? { t: str(w, 160), done: done.has(w) } : { t: str(w.t, 160), done: !!w.done || done.has(w.t) });
}
function cleanFlag(f) {
  return {
    id: f.id || uid('g'),
    text: str(f.text, 240),
    kind: ['money', 'risk', 'info', 'win'].includes(f.kind) ? f.kind : 'info',
    due: f.due ? str(f.due, 10) : null,
    source: str(f.source || 'hand', 20),
    done: !!f.done,
    userEdited: !!f.userEdited
  };
}
function cleanEvent(e) {
  return {
    id: str(e.id, 120),
    cal: str(e.cal, 40),
    title: str(e.title, 120),
    start: str(e.start, 30),
    end: str(e.end, 30),
    allDay: !!e.allDay,
    who: Array.isArray(e.who) ? e.who.slice(0, 12).map(w => str(w, 60)) : [],
    link: str(e.link, 300),
    htmlLink: str(e.htmlLink, 300),
    where: str(e.where, 120)
  };
}

/* a writer replaces only its own flags (feed -> feed, recap -> seed/recap); everything else stays; a tick survives */
function mergeFlags(existing, feed, replace) {
  const keep = existing.filter(f => !replace.includes(f.source) || f.userEdited);
  const doneById = new Map(existing.map(f => [f.id, f.done]));
  const fresh = feed.map(cleanFlag).map(f => ({ ...f, done: doneById.get(f.id) || f.done }));
  const ids = new Set(fresh.map(f => f.id));
  return keep.filter(f => !ids.has(f.id)).concat(fresh);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const who = authed(req);
  if (!who) { res.statusCode = 401; res.end(JSON.stringify({ error: 'Not signed in' })); return; }

  try {
    if (req.method === 'GET') { res.end(JSON.stringify(await load())); return; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET or POST' })); return; }

    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2e6) throw new Error('Body too large'); }
    const b = body ? JSON.parse(body) : {};
    const d = await load();

    switch (b.op) {
      case 'merge': {
        if (who !== 'script') throw new Error('merge is for the feed');
        if (b.calendar) d.calendar = { fetchedAt: new Date().toISOString(), events: (b.calendar.events || []).map(cleanEvent) };
        if (Array.isArray(b.flags)) d.flags = mergeFlags(d.flags, b.flags.map(f => ({ ...f, source: 'feed' })), ['feed']);
        if (typeof b.brief === 'string') d.brief = str(b.brief, 1200);
        break;
      }
      case 'seed': {
        if (who !== 'script') throw new Error('seed is for the script');
        if (Array.isArray(b.fronts)) {
          /* keep human edits on fronts that already exist */
          const cur = new Map(d.fronts.map(f => [f.id, f]));
          d.fronts = b.fronts.map(cleanFront).map(f => {
            const c = cur.get(f.id);
            if (!c) return f;
            if (b.override) {
              /* the weekly recap rewrites the plan; a tick the human made on a step with the same wording survives */
              const done = new Set(c.steps.filter(s => s.done).map(s => s.t));
              return { ...f, steps: f.steps.map(s => ({ ...s, done: s.done || done.has(s.t) })) };
            }
            return c.userEdited ? { ...f, next: c.next, status: c.status, steps: c.steps.length ? c.steps : f.steps, userEdited: true } : f;
          });
        }
        if (Array.isArray(b.flags)) d.flags = mergeFlags(d.flags, b.flags.map(f => ({ ...f, source: f.source || 'seed' })), ['seed', 'recap']);
        if (typeof b.brief === 'string') d.brief = str(b.brief, 1200);
        if (b.wins && typeof b.wins === 'object') Object.keys(b.wins).forEach(k => { if (/^\d{4}-\d{2}-\d{2}$/.test(k)) d.wins[k] = cleanWins(b.wins[k], d.wins[k]); });
        break;
      }
      case 'win': {
        /* today's three: tick, edit, add, remove */
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw new Error('date needed');
        const list = d.wins[b.date] || [];
        if (b.add) { if (list.length >= 3) throw new Error('Three is the limit'); list.push({ t: str(b.add, 160), done: false }); }
        else if (b.remove != null) list.splice(+b.remove, 1);
        else if (list[b.idx]) list[b.idx] = { t: str((b.changes || {}).t != null ? b.changes.t : list[b.idx].t, 160), done: (b.changes || {}).done != null ? !!b.changes.done : list[b.idx].done };
        else throw new Error('Not found');
        d.wins[b.date] = list;
        /* keep the map small: drop days older than 60 days */
        const cut = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
        Object.keys(d.wins).forEach(k => { if (k < cut) delete d.wins[k]; });
        break;
      }
      case 'patch': {
        const list = b.kind === 'flag' ? d.flags : d.fronts;
        const i = list.findIndex(x => x.id === b.id);
        if (i < 0) throw new Error('Not found');
        const merged = { ...list[i], ...(b.changes || {}), id: list[i].id, userEdited: true };
        if (b.kind === 'flag') list[i] = cleanFlag(merged);
        else {
          if (merged.status === 'done' && !list[i].doneAt) merged.doneAt = new Date().toISOString();
          if (merged.status !== 'done') merged.doneAt = null;
          list[i] = cleanFront(merged);
        }
        break;
      }
      case 'add': {
        if (b.kind === 'flag') d.flags.push(cleanFlag({ ...(b.item || {}), source: 'hand', userEdited: true }));
        else d.fronts.push(cleanFront({ ...(b.item || {}), userEdited: true }));
        break;
      }
      case 'delete': {
        if (b.kind === 'flag') d.flags = d.flags.filter(x => x.id !== b.id);
        else d.fronts = d.fronts.filter(x => x.id !== b.id);
        break;
      }
      case 'step': {
        const f = d.fronts.find(x => x.id === b.id);
        if (!f || !f.steps[b.idx]) throw new Error('Not found');
        f.steps[b.idx].done = !!b.done;
        f.userEdited = true;
        break;
      }
      default: throw new Error('Unknown op');
    }
    res.end(JSON.stringify(await store(d)));
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
};
