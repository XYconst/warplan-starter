#!/usr/bin/env node
/* Warplan Comms sync: reads the mailbox through gog, asks Claude who has the ball on each
   thread, pushes the result to the Warplan API, and (optionally) sends the morning digest
   to your own Telegram.

   Usage:  node sync.js               full run: classify + push + digest
           node sync.js --no-telegram  classify + push, print the digest instead of sending
           node sync.js --digest-only  no classification, just send today's digest


   Env (comms/.env):  WARPLAN_URL, COMMS_KEY, GOG_ACCOUNT, TELEGRAM_CHAT_ID
   The Telegram bot token is read from ~/.claude/channels/telegram/.env (TELEGRAM_BOT_TOKEN).
   Nothing here ever sends email. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const HERE = __dirname;
const LOG = path.join(HERE, 'sync.log');
function log(s) { const line = new Date().toISOString() + ' ' + s; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} }
function loadEnv(file) {
  const out = {};
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
  return out;
}
const ENV = { ...loadEnv(path.join(HERE, '.env')), ...process.env };
const TG = loadEnv(path.join(os.homedir(), '.claude/channels/telegram/.env'));
const ARGS = new Set(process.argv.slice(2));
const ACCOUNT = ENV.GOG_ACCOUNT;
if (!ACCOUNT) { console.error('Set GOG_ACCOUNT in comms/.env'); process.exit(1); }
const OWNER = ENV.OWNER_NAME || 'the owner';
const OWNER_CONTEXT = ENV.OWNER_CONTEXT || 'who works at a marketing agency';
const ME = ACCOUNT.toLowerCase();
const WINDOW_DAYS = +(ENV.WINDOW_DAYS || 10);
const MODEL = ENV.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

/* ---------- gmail via gog ---------- */
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function gog(args) {
  /* Gmail meters "units per minute"; a full thread read is expensive. Pace the calls and back off on 403. */
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(execFileSync('gog', ['-a', ACCOUNT, ...args, '-j', '--results-only'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: '' }));
    } catch (e) {
      const msg = String(e.stderr || e.message || '');
      if (/rateLimitExceeded|429|quota/i.test(msg) && attempt < 4) { const wait = 15000 * (attempt + 1); log(`gmail quota hit, waiting ${wait / 1000}s`); sleep(wait); continue; }
      throw new Error(msg.split('\n').filter(Boolean).slice(-1)[0] || 'gog failed');
    }
  }
}
const NOISE_FROM = ['noreply', 'no-reply', 'notifications', 'mailer', 'emailer', 'invoice+statements', 'alert', 'calendar-notification', 'drive-shares', 'hello@dev.brandwise', 'failed-payments'];
const NOISE_SUBJECT = [/^invitation:/i, /^updated invitation/i, /^accepted:/i, /^declined:/i, /^tentatively accepted/i, /your ads? (was|were) approved/i, /daily digest/i, /receipt from/i, /sign-in/i, /security alert/i, /shared the (folder|file)/i];

function hdr(m, n) { return ((m.payload || {}).headers || []).find(h => h.name.toLowerCase() === n.toLowerCase())?.value || ''; }
function decode(part) {
  const out = [];
  const b = part.body && part.body.data, mt = part.mimeType || '';
  if (b && (mt === 'text/plain' || mt === 'text/html')) {
    let s = Buffer.from(b.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (mt === 'text/html') s = s.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    out.push([mt, s]);
  }
  (part.parts || []).forEach(p => out.push(...decode(p)));
  return out;
}
function bodyOf(m) {
  const parts = decode(m.payload || {});
  const plain = parts.filter(p => p[0] === 'text/plain').map(p => p[1]);
  let s = (plain[0] || (parts[0] || [])[1] || m.snippet || '');
  s = s.replace(/\s+/g, ' ');
  const head = s.split(/(On .{5,90} wrote:|На .{5,120}написа:|-----Original|Изпратено от|Sent from my|From: |От: |> )/)[0];
  /* a forward has almost nothing before the quoted part; keep the forwarded content then */
  const keep = head.trim().length < 120 && /Forwarded|Препратено|Fwd:/i.test(s) ? s : head;
  return keep.trim().slice(0, 1400);
}
function addrOf(v) { const m = v.match(/<([^>]+)>/); return (m ? m[1] : v).trim().toLowerCase(); }
function nameOf(v) { return v.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || addrOf(v); }

function collectThreads(known) {
  const q = `newer_than:${WINDOW_DAYS}d -category:promotions -category:social -in:spam -in:trash`;
  const res = gog(['gmail', 'messages', 'search', q, '--max', '200']);
  const msgs = Array.isArray(res) ? res : (res.messages || []);
  const ids = new Map();   // threadId -> { sub, newest message id }
  msgs.forEach(m => {
    const from = (m.from || '').toLowerCase(), sub = m.subject || '';
    if (NOISE_FROM.some(n => from.includes(n))) return;
    if (NOISE_SUBJECT.some(re => re.test(sub))) return;
    const cur = ids.get(m.threadId);
    if (!cur) ids.set(m.threadId, { sub, newest: m.id });
    else if (m.id > cur.newest) cur.newest = m.id;   // gmail ids grow with time
  });
  /* only threads whose newest message the ledger has not seen get their bodies fetched (Gmail meters those) */
  const changed = new Map();
  const unchanged = [];
  for (const [tid, v] of ids) {
    const k = known.get(tid);
    if (k && k.lastMsgId && k.lastMsgId === v.newest) unchanged.push({ id: tid, lastMsgAt: k.lastMsgAt, lastMsgId: k.lastMsgId, subject: v.sub });
    else changed.set(tid, v.sub);
  }
  log(`gmail: ${msgs.length} messages, ${ids.size} threads, ${changed.size} changed`);
  const threads = [];
  const MAX_THREADS = +(ENV.MAX_THREADS || 60);
  let n = 0;
  for (const [tid, sub] of changed) {
    if (n++ >= MAX_THREADS) { log(`stopping at ${MAX_THREADS} threads (MAX_THREADS)`); break; }
    if (n > 1) sleep(+(ENV.FETCH_GAP_MS || 700));
    let th;
    try { th = gog(['gmail', 'thread', 'get', tid]).thread; } catch (e) { log(`thread ${tid} failed: ${e.message}`); continue; }
    const ms = th.messages || [];
    if (!ms.length) continue;
    const last = ms[ms.length - 1];
    const people = new Set();
    ms.forEach(m => [hdr(m, 'From'), hdr(m, 'To'), hdr(m, 'Cc')].join(',').split(',').map(s => s.trim()).filter(Boolean).forEach(a => { const ad = addrOf(a); if (ad && ad !== ME) people.add(nameOf(a) + ' <' + ad + '>'); }));
    const lastFrom = hdr(last, 'From');
    const lastDate = new Date(+last.internalDate).toISOString();
    threads.push({
      id: tid, subject: hdr(ms[0], 'Subject') || sub, count: ms.length, lastMsgId: last.id, mailbox: 'Work', mailboxEmail: ACCOUNT,
      participants: Array.from(people).slice(0, 6),
      lastFrom: nameOf(lastFrom), lastFromMe: addrOf(lastFrom) === ME, lastMsgAt: lastDate,
      messages: ms.slice(-3).map(m => ({ from: nameOf(hdr(m, 'From')), fromMe: addrOf(hdr(m, 'From')) === ME, date: new Date(+m.internalDate).toISOString().slice(0, 16), text: bodyOf(m) }))
    });
  }
  return { threads, unchanged };
}

/* ---------- composio (the other mailboxes) ---------- */
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
const pick = (m, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((o, x) => (o == null ? o : o[x]), m); if (v != null && v !== '') return v; } return ''; };
function isoOf(v) { if (!v) return ''; const d = new Date(isNaN(+v) ? v : +v * (String(v).length < 13 ? 1000 : 1)); return isNaN(d) ? '' : d.toISOString(); }
function stripQuotes(s) {
  s = String(s || '').replace(/\s+/g, ' ');
  const head = s.split(/(On .{5,90} wrote:|На .{5,120}написа:|-----Original|Изпратено от|Sent from my|From: |От: |> )/)[0];
  const keep = head.trim().length < 120 && /Forwarded|Препратено|Fwd:/i.test(s) ? s : head;
  return keep.trim().slice(0, 1400);
}
async function collectComposio(box, key, known, status) {
  const me = (box.email || '').toLowerCase();
  const list = await composio(key, 'GMAIL_FETCH_EMAILS', box.id, { query: `newer_than:${WINDOW_DAYS}d -category:promotions -category:social`, max_results: 100, verbose: false, include_payload: false });
  const msgs = list.messages || list.emails || [];
  const ids = new Map();
  msgs.forEach(m => {
    const from = String(pick(m, 'sender', 'from', 'preview.from')).toLowerCase(), sub = String(pick(m, 'subject', 'preview.subject'));
    const tid = pick(m, 'threadId', 'thread_id'), mid = pick(m, 'messageId', 'id');
    if (!tid || !mid) return;
    if (NOISE_FROM.some(n => from.includes(n))) return;
    if (NOISE_SUBJECT.some(re => re.test(sub))) return;
    const cur = ids.get(tid);
    if (!cur) ids.set(tid, { sub, newest: mid }); else if (mid > cur.newest) cur.newest = mid;
  });
  const threads = [];
  let changed = 0;
  for (const [tid, v] of ids) {
    const id = box.id + '_' + tid;
    const k = known.get(id);
    if (k && k.lastMsgId && k.lastMsgId === v.newest) continue;
    changed++;
    if (changed > +(ENV.MAX_THREADS || 60)) break;
    let th;
    try { th = await composio(key, 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', box.id, { thread_id: tid }); } catch (e) { log(`${box.label} thread ${tid} failed: ${e.message}`); continue; }
    const ms = (th.messages || []).slice().sort((a, b) => String(pick(a, 'messageId', 'id')).localeCompare(String(pick(b, 'messageId', 'id'))));
    if (!ms.length) continue;
    const last = ms[ms.length - 1];
    const people = new Set();
    ms.forEach(m => [pick(m, 'sender', 'from'), pick(m, 'to'), pick(m, 'cc')].join(',').split(',').map(s => s.trim()).filter(Boolean).forEach(a => { const ad = addrOf(a); if (ad && ad !== me) people.add(nameOf(a) + ' <' + ad + '>'); }));
    const lastFrom = String(pick(last, 'sender', 'from'));
    threads.push({
      id, subject: String(pick(ms[0], 'subject')) || v.sub, count: ms.length, lastMsgId: String(pick(last, 'messageId', 'id')),
      mailbox: box.label, mailboxEmail: box.email, participants: Array.from(people).slice(0, 6),
      lastFrom: nameOf(lastFrom), lastFromMe: addrOf(lastFrom) === me, lastMsgAt: isoOf(pick(last, 'messageTimestamp', 'internalDate', 'date')) || new Date().toISOString(),
      messages: ms.slice(-3).map(m => ({ from: nameOf(String(pick(m, 'sender', 'from'))), fromMe: addrOf(String(pick(m, 'sender', 'from'))) === me, date: (isoOf(pick(m, 'messageTimestamp', 'internalDate', 'date')) || '').slice(0, 16), text: stripQuotes(pick(m, 'messageText', 'snippet', 'preview.body', 'body')) })),
      url: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(box.email || '') + '#all/' + tid
    });
  }
  status[box.id] = { ok: true, note: `${ids.size} threads, ${threads.length} changed`, at: new Date().toISOString() };
  log(`${box.label} (composio): ${msgs.length} messages, ${ids.size} threads, ${threads.length} changed`);
  return threads;
}

/* ---------- classification ---------- */
function classify(threads) {
  if (!threads.length) return [];
  const today = new Date().toISOString().slice(0, 10);
  const addrs = Array.from(new Set(threads.map(t => t.mailboxEmail).filter(Boolean).concat([ACCOUNT]))).join(', ');
  const prompt = `You are triaging email threads for ${OWNER} (addresses: ${addrs}), ${OWNER_CONTEXT}. Each thread says which mailbox it came from. Today is ${today}.
For EACH thread decide who has the ball:
- "me": ${OWNER} owes the next move (a reply, a decision, a signature, a payment, a document, scheduling).
- "them": ${OWNER} already replied or asked something and is waiting on the other side.
- "none": nothing is owed by anyone (closed loop, FYI, newsletter, cold pitch with no relationship, automated notice).
Cold outreach from strangers selling services is "none" unless ${OWNER} replied to them.
Write "action" as one short imperative line in the language of the thread (Bulgarian or English), naming the concrete thing to do, e.g. "Sign the 3 PDFs and send the scans to the accountant" or "Пиши на клиента два часа за среща". For "them", action describes what is awaited, e.g. "Waiting on the client for next steps".
"due": an explicit date mentioned in the thread as YYYY-MM-DD, or null. Do not invent deadlines.
"counterparty": the person or company on the other side, short.
"priority": 1 urgent (money, legal, client blocking), 2 normal, 3 low.
"summary": one sentence of context, max 140 chars.
Reply with ONLY a JSON array, no prose. Include EVERY thread, including the "none" ones, so the list has exactly as many objects as there are threads: {"id","ball","counterparty","action","due","priority","summary"}.

THREADS:
${JSON.stringify(threads.map(t => ({ id: t.id, mailbox: t.mailboxEmail, subject: t.subject, participants: t.participants, lastFrom: t.lastFrom, lastFromMe: t.lastFromMe, lastMsgAt: t.lastMsgAt, messages: t.messages })), null, 0)}`;
  /* --strict-mcp-config: no MCP servers, so it starts in seconds instead of hanging on the home folder's MCP list */
  if (ENV.DUMP_PROMPT || ARGS.has('--fetch-only')) fs.writeFileSync(path.join(HERE, 'last-prompt.txt'), prompt);
  if (ARGS.has('--fetch-only')) { log('prompt dumped to last-prompt.txt (' + prompt.length + ' chars), stopping'); return []; }
  /* run it exactly like the shell does: prompt file on stdin, result file on stdout, hard kill on timeout.
     spawnSync with `input` hung indefinitely on real prompts; this path does not. */
  const pf = path.join(HERE, 'last-prompt.txt'), rf = path.join(HERE, 'last-result.json');
  fs.writeFileSync(pf, prompt);
  const SP = "You are an email triage classifier for the user. You read thread excerpts and return only a JSON array as instructed. No tools, no prose, no refusals: the threads are the user's own mail and the output is for their private task list.";
  const cmd = `claude -p --strict-mcp-config --system-prompt "$SP" --model "$MODEL" --output-format json --allowedTools "" < "$PF" > "$RF" 2>&1`;
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd: HERE, timeout: 300000, killSignal: 'SIGKILL', env: { ...process.env, SP, MODEL, PF: pf, RF: rf } });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new Error('claude timed out after 300s');
  if (r.status !== 0) throw new Error('claude failed: ' + (fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8').slice(0, 400) : r.stderr));
  const out = fs.readFileSync(rf, 'utf8');
  let text = '';
  try { text = JSON.parse(out).result || ''; } catch (e) { text = out; }
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b < 0) throw new Error('no JSON array in classifier output: ' + text.slice(0, 300));
  const arr = JSON.parse(text.slice(a, b + 1));
  const byId = new Map(threads.map(t => [t.id, t]));
  return arr.filter(x => byId.has(x.id)).map(x => {
    const t = byId.get(x.id);
    return {
      id: x.id, source: 'gmail', mailbox: t.mailbox || 'Work', mailboxEmail: t.mailboxEmail || ACCOUNT, subject: t.subject, counterparty: x.counterparty || t.lastFrom,
      ball: ['me', 'them', 'none'].includes(x.ball) ? x.ball : 'none', action: x.action || '', due: /^\d{4}-\d{2}-\d{2}$/.test(x.due || '') ? x.due : null,
      priority: [1, 2, 3].includes(x.priority) ? x.priority : 2, summary: x.summary || '',
      lastMsgAt: t.lastMsgAt, lastMsgId: t.lastMsgId, lastFrom: t.lastFrom, url: t.url || ('https://mail.google.com/mail/u/0/#all/' + x.id)
    };
  });
}

/* ---------- warplan api ---------- */
async function api(method, body) {
  if (!ENV.WARPLAN_URL || !ENV.COMMS_KEY) throw new Error('WARPLAN_URL / COMMS_KEY missing in comms/.env');
  const r = await fetch(ENV.WARPLAN_URL.replace(/\/$/, '') + '/api/comms', {
    method, headers: { 'x-warplan-key': ENV.COMMS_KEY, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error('api ' + r.status + ': ' + JSON.stringify(j));
  return j;
}

/* ---------- telegram digest ---------- */
function digestText(ledger) {
  const t = new Date().toISOString().slice(0, 10);
  const live = i => i.status === 'open' && !(i.snoozedUntil && i.snoozedUntil > t);
  const mine = ledger.items.filter(i => live(i) && i.ball === 'me').sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : a.priority - b.priority);
  const theirs = ledger.items.filter(i => live(i) && i.ball === 'them');
  const overdue = mine.filter(i => i.due && i.due < t);
  const days = Object.keys(ledger.days || {}).sort();
  let streak = 0;
  for (let k = days.length - 1; k >= 0; k--) { const d = ledger.days[days[k]]; if (d && d.overdue === 0) streak++; else break; }
  const lines = [];
  lines.push(`Warplan · ${t}`);
  lines.push(`You owe ${mine.length} · overdue ${overdue.length} · waiting on others ${theirs.length} · clean-day streak ${streak}`);
  if (mine.length) {
    lines.push('');
    lines.push('Owed by you:');
    mine.slice(0, 12).forEach(i => lines.push(`${i.due && i.due < t ? '!! ' : '- '}${i.counterparty}: ${i.action}${i.due ? ' (' + i.due + ')' : ''}`));
    if (mine.length > 12) lines.push(`… and ${mine.length - 12} more`);
  } else {
    lines.push('');
    lines.push('Nothing owed. Keep the streak.');
  }
  if (theirs.length) {
    lines.push('');
    lines.push('Waiting on them:');
    theirs.slice(0, 6).forEach(i => lines.push(`- ${i.counterparty}: ${i.action}`));
  }
  lines.push('');
  lines.push((ENV.WARPLAN_URL || '') + ' → Comms');
  return lines.join('\n');
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
    let ledger;
    const LOCK = path.join(HERE, 'sync.lock');
    if (ARGS.has('--if-requested')) {
      /* the minute poller: act only when the app asked and nobody else is on it */
      let cur; try { cur = await api('GET'); } catch (e) { return; }
      const s = cur.sync || {};
      const wanted = s.requestedAt && !(s.finishedAt && s.finishedAt > s.requestedAt);
      const running = s.startedAt && (Date.now() - Date.parse(s.startedAt) < 10 * 60 * 1000);
      if (!wanted || running) return;
      if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60 * 1000) return;
      log('sync requested from the app');
    }
    if (!ARGS.has('--digest-only')) {
      fs.writeFileSync(LOCK, String(process.pid));
      let known = new Map(), config = { mailboxes: [] };
      if (!ARGS.has('--dry')) {
        try { const cur = await api('GET'); known = new Map(cur.items.map(i => [i.id, { lastMsgAt: i.lastMsgAt, lastMsgId: i.lastMsgId }])); config = cur.config || config; } catch (e) { log('could not read ledger, classifying everything: ' + e.message); }
        try { await api('POST', { op: 'syncStart' }); } catch (e) {}
      }
      let items = [], threads = [];
      const status = {};
      const notes = [];
      if (config.composioUserId) COMPOSIO_USER = config.composioUserId;
      try {
        for (const box of (config.mailboxes || [])) {
          if (!box.on) { status[box.id] = { ok: false, note: 'off', at: new Date().toISOString() }; continue; }
          try {
            if (box.kind === 'gog') {
              const got = collectThreads(known);
              threads.push(...got.threads.map(t => ({ ...t, mailbox: box.label || 'Work', mailboxEmail: box.email || ACCOUNT })));
              status[box.id] = { ok: true, note: `${got.threads.length} changed`, at: new Date().toISOString() };
              notes.push(`${box.label} ${got.threads.length}`);
            } else if (box.kind === 'composio') {
              if (!config.composioKey) { status[box.id] = { ok: false, note: 'needs the Composio key', at: new Date().toISOString() }; continue; }
              const got = await collectComposio(box, config.composioKey, known, status);
              threads.push(...got);
              notes.push(`${box.label} ${got.length}`);
            }
          } catch (e) {
            status[box.id] = { ok: false, note: String(e.message || e).slice(0, 160), at: new Date().toISOString() };
            log(`${box.label} failed: ${e.message}`);
            notes.push(`${box.label} failed`);
          }
        }
        if (!(config.mailboxes || []).length) { const got = collectThreads(known); threads = got.threads; }
        log(`classifying ${threads.length} threads with ${MODEL}`);
        items = threads.length ? classify(threads) : [];
        /* a thread the classifier skipped counts as "nothing owed": close it if the ledger knew it, ignore it if not */
        const gotIds = new Set(items.map(i => i.id));
        threads.filter(t => !gotIds.has(t.id) && known.has(t.id)).forEach(t => items.push({ id: t.id, source: 'gmail', mailbox: ACCOUNT, subject: t.subject, ball: 'none', action: '', due: null, priority: 3, summary: '', lastMsgAt: t.lastMsgAt, lastMsgId: t.lastMsgId, lastFrom: t.lastFrom }));
        if (ARGS.has('--dry') || ARGS.has('--fetch-only')) { console.log(JSON.stringify(items, null, 2)); fs.rmSync(LOCK, { force: true }); return; }
        ledger = await api('POST', { op: 'merge', items });
        log(`pushed ${items.length} items; ledger now ${ledger.items.length} items`);
        ledger = await api('POST', { op: 'syncDone', note: (notes.length ? notes.join(' · ') + ' changed' : `${threads.length} changed`), mailboxStatus: status });
      } catch (e) {
        try { await api('POST', { op: 'syncDone', error: String(e.message || e).slice(0, 200), mailboxStatus: status }); } catch (e2) {}
        fs.rmSync(LOCK, { force: true });
        throw e;
      }
      fs.rmSync(LOCK, { force: true });
      if (ARGS.has('--if-requested')) { log('on-demand sync done'); return; }
    } else {
      ledger = await api('POST', { op: 'snapshot' });
    }
    const text = digestText(ledger);
    if (ARGS.has('--no-telegram')) { console.log('\n' + text); log('digest printed, not sent'); return; }
    await telegram(text);
    log('digest sent to telegram');
  } catch (e) {
    log('FAILED: ' + (e.stack || e));
    process.exitCode = 1;
  }
})();
