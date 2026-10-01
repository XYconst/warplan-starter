#!/usr/bin/env node
/* Warplan Comms poller: a small always-on loop (launchd KeepAlive) that asks the API every
   45 seconds whether the app requested a mail sync, and runs sync.js --if-requested when it did.
   launchd StartInterval proved unreliable for this on macOS, KeepAlive is not. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const EVERY = +(process.env.POLL_SECONDS || 45) * 1000;
function loadEnv(file) {
  const out = {};
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
  return out;
}
const ENV = { ...loadEnv(path.join(HERE, '.env')), ...process.env };
let busy = false;

async function wanted() {
  const r = await fetch(ENV.WARPLAN_URL.replace(/\/$/, '') + '/api/comms', { headers: { 'x-warplan-key': ENV.COMMS_KEY } });
  if (!r.ok) throw new Error('api ' + r.status);
  const s = (await r.json()).sync || {};
  const asked = s.requestedAt && !(s.finishedAt && s.finishedAt > s.requestedAt);
  const running = s.startedAt && (Date.now() - Date.parse(s.startedAt) < 10 * 60 * 1000);
  return asked && !running;
}
function runSync() {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(HERE, 'sync.js'), '--if-requested'], { cwd: HERE, stdio: 'inherit', env: process.env });
    p.on('exit', code => resolve(code));
    p.on('error', () => resolve(-1));
  });
}
async function tick() {
  if (busy) return;
  busy = true;
  try { if (await wanted()) { console.log(new Date().toISOString() + ' poller: sync requested, running'); await runSync(); } }
  catch (e) { /* offline or API down: try again next tick */ }
  busy = false;
}
console.log(new Date().toISOString() + ' poller up, every ' + EVERY / 1000 + 's');
tick();
setInterval(tick, EVERY);
