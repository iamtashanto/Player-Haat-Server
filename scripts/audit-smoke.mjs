// Live smoke audit: logs in as a player and a recruiter, then calls every parameter-free GET route in the OpenAPI
// document (anonymous, player, recruiter) and reports 5xx responses and routes that answer anonymous callers.
// Usage: node scripts/audit-smoke.mjs [baseUrl]   (needs PARITY_PLAYER / PARITY_REC emails, password Passw0rd1)
const base = process.argv[2] ?? 'http://localhost:4000';
const api = `${base}/api/v1`;
const j = async (r) => { try { return await r.json(); } catch { return null; } };
const login = async (email) => {
  const r = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd1' }) });
  const b = await j(r);
  return b?.data?.accessToken ?? b?.data?.tokens?.accessToken;
};
const spec = await (await fetch(`${base}/openapi.json`)).json();
const player = await login(process.env.PARITY_PLAYER);
const rec = await login(process.env.PARITY_REC);
console.log('tokens', !!player, !!rec);
const rows = [];
for (const [path, ms] of Object.entries(spec.paths)) {
  if (!ms.get || path.includes('{') || path.startsWith('/admin')) continue;
  const hit = async (tok) => (await fetch(api + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {} })).status;
  rows.push({ path, anon: await hit(null), player: await hit(player), rec: await hit(rec), auth: ms.get.security?.length ? 'auth' : 'public' });
}
console.table(rows);
const bad = rows.filter((r) => [r.anon, r.player, r.rec].some((s) => s >= 500));
const open = rows.filter((r) => r.auth === 'auth' && r.anon === 200);
console.log('5xx:', bad.map((r) => r.path), '\nauth routes answering anonymous callers:', open.map((r) => r.path));
