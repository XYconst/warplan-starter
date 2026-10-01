/* Meta ad numbers for the brief and the recap: last 7 days and yesterday per account.
   Accounts come from META_ACCOUNTS in today/.env, "Label=act_123,Label2=act_456".
   Token: META_TOKEN in today/.env, else TOP_META_TOKEN / META_ACCESS_TOKEN from ~/.env.
   Read-only. Nothing here changes a campaign. */
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadEnv(file) {
  const out = {};
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) {}
  return out;
}
function config(ENV) {
  const home = loadEnv(path.join(os.homedir(), '.env'));
  const token = ENV.META_TOKEN || home.TOP_META_TOKEN || home.META_ACCESS_TOKEN || '';
  /* "Label=act_123" uses the default token; "Label=act_123:META_ACCESS_TOKEN" names the ~/.env variable to use instead */
  const accounts = (ENV.META_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('='); const rest = p.slice(i + 1).trim(); const j = rest.indexOf(':');
    const id = j > 0 ? rest.slice(0, j) : rest, tv = j > 0 ? rest.slice(j + 1) : '';
    return { label: p.slice(0, i).trim(), id, token: (tv && (home[tv] || ENV[tv])) || token };
  });
  return { token, accounts };
}
async function insights(id, preset, token) {
  const u = `https://graph.facebook.com/v21.0/${id}/insights?date_preset=${preset}&fields=spend,purchase_roas,actions,account_currency&access_token=${token}`;
  const j = await (await fetch(u)).json();
  if (j.error) throw new Error(j.error.message);
  const r = (j.data || [])[0] || {};
  const roas = +(((r.purchase_roas || []).find(x => x.action_type === 'omni_purchase') || {}).value || 0);
  const purchases = +(((r.actions || []).find(x => x.action_type === 'omni_purchase') || {}).value || 0);
  return { spend: +(r.spend || 0), roas, purchases, currency: r.account_currency || '' };
}
async function fetchAds(ENV) {
  const { token, accounts } = config(ENV);
  if (!accounts.length) return [];
  const rows = [];
  for (const a of accounts) {
    try {
      if (!a.token) throw new Error('no token'); const [d7, d1] = await Promise.all([insights(a.id, 'last_7d', a.token), insights(a.id, 'yesterday', a.token)]);
      rows.push({ label: a.label, id: a.id, d7, d1 });
    } catch (e) { rows.push({ label: a.label, id: a.id, error: String(e.message).slice(0, 120) }); }
  }
  return rows;
}
const fmt = n => Math.round(n).toLocaleString('en-GB');
function adsLines(rows) {
  return rows.map(r => r.error
    ? `- ${r.label}: no data (${r.error})`
    : `- ${r.label}: 7d ${fmt(r.d7.spend)} ${r.d7.currency} at ROAS ${r.d7.roas.toFixed(2)}, ${r.d7.purchases} orders · yesterday ${fmt(r.d1.spend)} at ${r.d1.roas.toFixed(2)}`);
}
/* a risk flag when a real budget runs under the line for a week; the flag id is stable so a tick survives the next run */
function adsFlags(rows, ENV) {
  const line = +(ENV.ROAS_LINE || 1.5), minSpend = +(ENV.ROAS_MIN_SPEND || 500);
  const out = [];
  rows.forEach(r => {
    if (r.error || r.d7.spend < minSpend) return;
    if (r.d7.roas < line) out.push({ id: 'g_ads_' + r.id, kind: 'risk', source: 'feed', text: `${r.label} ads: 7-day ROAS ${r.d7.roas.toFixed(2)} on ${fmt(r.d7.spend)} ${r.d7.currency} (${r.d7.purchases} orders). Below the ${line} line.` });
  });
  return out;
}
module.exports = { fetchAds, adsLines, adsFlags };
