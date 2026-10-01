/* Warplan: password gate + app server.
   Same HMAC-cookie idea as the money dashboard, no framework.
   Secrets come from env only: WARPLAN_PASSWORD, SESSION_SECRET. */
const crypto = require('crypto');
const { HTML_B64 } = require('../lib/page.js');

const COOKIE = 'wp_session';
const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

function token(secret) {
  return crypto.createHmac('sha256', secret).update('warplan-v1').digest('hex');
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#000321"><title>Warplan</title>
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="icon" href="/icons/icon-32.png" sizes="32x32">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{--navy:#000321;--cream:#fcfcfa;--line:rgba(252,252,250,.16);--cobalt:#0038ff;--amber:#F2A516}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;
    background:var(--navy);color:var(--cream);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;padding:24px}
  .card{width:100%;max-width:340px;text-align:center}
  .mark{width:56px;height:56px;border-radius:14px;background:var(--cream);color:var(--navy);
    display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
  .mark svg{width:32px;height:32px}
  h1{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.01em}
  p.sub{margin:0 0 26px;font-family:'JetBrains Mono',monospace;font-size:10px;
    letter-spacing:.18em;text-transform:uppercase;opacity:.55}
  input{width:100%;font:inherit;font-size:16px;color:var(--cream);text-align:center;
    padding:14px;background:rgba(252,252,250,.06);border:1px solid var(--line);border-radius:3px}
  input:focus{outline:none;border-color:var(--cobalt);box-shadow:0 0 0 3px rgba(0,56,255,.35)}
  button{width:100%;margin-top:10px;font:inherit;font-size:15px;font-weight:700;color:var(--navy);
    background:var(--cream);border:none;border-radius:3px;padding:14px;cursor:pointer;min-height:50px}
  button:hover{background:var(--amber)}
  .err{margin-top:14px;font-size:13px;color:var(--amber)}
</style></head><body>
<form class="card" method="POST" action="/login">
  <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="2.4"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12a7 7 0 0 0 14 0"/><line x1="5" y1="12" x2="3" y2="12"/><line x1="19" y1="12" x2="21" y2="12"/></svg></div>
  <h1>Warplan</h1>
  <p class="sub">Yearly Warplan</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus aria-label="Password">
  <button type="submit">Open</button>
  ${error ? '<p class="err">' + error + '</p>' : ''}
</form></body></html>`;
}

module.exports = async (req, res) => {
  const secret = process.env.SESSION_SECRET;
  const password = process.env.WARPLAN_PASSWORD;
  if (!secret || !password) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain');
    return res.end('Server is missing WARPLAN_PASSWORD or SESSION_SECRET.');
  }

  const url = (req.url || '/').split('?')[0];

  if (url === '/logout') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    res.statusCode = 302; res.setHeader('Location', '/'); return res.end();
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const given = new URLSearchParams(body).get('password') || '';
    const a = Buffer.from(given);
    const b = Buffer.from(password);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      res.statusCode = 401;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(loginPage('Wrong password.'));
    }
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token(secret)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
    res.statusCode = 302; res.setHeader('Location', '/'); return res.end();
  }

  const cookie = readCookie(req, COOKIE);
  const expected = token(secret);
  const authed = cookie && cookie.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(expected));

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (!authed) { res.statusCode = 200; return res.end(loginPage('')); }

  res.setHeader('X-Warplan', 'app');   // the service worker only caches this
  res.statusCode = 200;
  return res.end(Buffer.from(HTML_B64, 'base64').toString('utf8'));
};
