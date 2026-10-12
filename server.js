import express from 'express';
import session from 'express-session';
import fs from 'node:fs';
const E = process.env, API = 'https://discord.com/api/v10';
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

// ---- Facțiuni: fiecare are serverul ei de Discord si role ID-urile ei (prefix in .env) ----
const FACT = {};
for (const [id, name, color] of [['camorra', 'Camorra', '#b91c1c'], ['vagos', 'Vagos', '#eab308']]) {
  const P = id.toUpperCase() + '_';
  const f = { id, name, color, guild: E[P + 'GUILD_ID'], member: E[P + 'STAFF_ROLE_ID'], access: list(E[P + 'ACCESS_ROLE_IDS']), ranks: list(E[P + 'RANK_ROLE_IDS']) };
  if (!f.guild || !f.member) { console.log(`[${name}] sarit: lipseste ${P}GUILD_ID sau ${P}STAFF_ROLE_ID in .env`); continue; }
  FACT[id] = f;
}

const F = 'db.json';
let db = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : { docs: [], seen: {} };
db.docs ??= []; db.seen ??= {};
const save = () => fs.writeFileSync(F, JSON.stringify(db, null, 1));
const sk = (f, uid) => f.id + ':' + uid;

const bot = (m, p, b) => fetch(API + p, { method: m, headers: { Authorization: 'Bot ' + E.BOT_TOKEN, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
async function role(f, m, uid, rid) {
  const r = await bot(m, `/guilds/${f.guild}/members/${uid}/roles/${rid}`);
  if (!r.ok) throw new Error(`Discord ${r.status}: ${await r.text()}`);
}
async function members(f) {
  const all = []; let after = '0';
  for (;;) {
    const r = await bot('GET', `/guilds/${f.guild}/members?limit=1000&after=${after}`);
    if (!r.ok) throw new Error(`[${f.name}] Nu pot lista membrii (${r.status}). Botul e pe serverul ${f.name}? Server Members Intent activ?`);
    const a = await r.json(); all.push(...a);
    if (a.length < 1000) break; after = a.at(-1).user.id;
  }
  return all;
}
const RN = {};
async function roleNames(f) {
  const c = RN[f.id];
  if (!c || Date.now() - c.t > 6e4) {
    const r = await bot('GET', `/guilds/${f.guild}/roles`);
    RN[f.id] = { t: Date.now(), v: Object.fromEntries((await r.json()).map(x => [x.id, { name: x.name, color: x.color ? '#' + x.color.toString(16).padStart(6, '0') : null }])) };
  }
  return RN[f.id].v;
}
// Data reala la care a primit un membru un rol, din Audit Log (Discord pastreaza ~45 zile; botul are nevoie de "View Audit Log")
const sf = id => Number((BigInt(id) >> 22n) + 1420070400000n);
async function auditSince(f) {
  const map = {}; let before = '';
  try {
    for (let i = 0; i < 20; i++) {
      const r = await bot('GET', `/guilds/${f.guild}/audit-logs?action_type=25&limit=100${before}`);
      if (!r.ok) break;
      const a = (await r.json()).audit_log_entries || [];
      for (const e of a) for (const c of e.changes || []) if (c.key === '$add') for (const x of c.new_value || []) {
        const k = e.target_id + ':' + x.id; map[k] = Math.max(map[k] || 0, sf(e.id));
      }
      if (a.length < 100) break; before = '&before=' + a.at(-1).id;
    }
  } catch (e) {}
  return map;
}
const avatarUrl = (f, uid, m) => m.avatar ? `https://cdn.discordapp.com/guilds/${f.guild}/users/${uid}/avatars/${m.avatar}.png?size=64`
  : m.user?.avatar ? `https://cdn.discordapp.com/avatars/${uid}/${m.user.avatar}.png?size=64` : null;

const rankOf = (f, m) => f.ranks.filter(r => m.roles.includes(r)).pop() || null;
const extraOf = (f, m) => m.roles.filter(x => !f.ranks.includes(x) && x !== f.member);
// Reia gradele din Discord pentru un Docs deja generat
async function syncDoc(f, doc) {
  const all = await members(f), by = Object.fromEntries(all.map(m => [m.user.id, m]));
  let aud = null, ch = false;
  for (const r of doc.rows) {
    const m = by[r.uid]; if (!m || r.out) continue;
    const rank = rankOf(f, m), extra = extraOf(f, m);
    if (JSON.stringify(extra) !== JSON.stringify(r.extra || [])) { r.extra = extra; ch = true; }
    if (rank === r.rank && (r.since || !rank)) continue;
    if (rank !== r.rank || !r.since) {
      aud ??= await auditSince(f);
      const t = rank && aud[r.uid + ':' + rank], p = db.seen[sk(f, r.uid)];
      r.rank = rank;
      if (!rank) { r.since = null; r.sinceSrc = null; }
      else if (t) { r.since = new Date(t).toISOString().slice(0, 10); r.sinceSrc = 'audit'; }
      else if (p && p.rank === rank && p.since) { r.since = p.since; r.sinceSrc = p.src || 'seen'; }
      else { r.since = today(); r.sinceSrc = 'seen'; }
      db.seen[sk(f, r.uid)] = { rank, since: r.since, src: r.sinceSrc }; ch = true;
    }
  }
  if (ch) save();
  const nr = doc.rows.filter(r => !r.rank && !r.out);
  if (nr.length) console.log(`[${f.name}] ${nr.length} membri fara grad recunoscut. Roluri gasite la ei (adauga ID-ul potrivit in ${f.id.toUpperCase()}_RANK_ROLE_IDS):`,
    [...new Set(nr.flatMap(r => r.extra || []))].join(', ') || '(niciunul)');
}

const app = express();
app.use(express.json());
app.use(session({ secret: E.SESSION_SECRET || 'dev', resave: false, saveUninitialized: false, cookie: { maxAge: 864e5 * 7, sameSite: 'lax' } }));
app.use(express.static('public'));
const need = (q, s, n) => q.session.user ? n() : s.status(401).json({ error: 'login' });
// verifica ca userul are acces la facțiunea din URL
const fac = (q, s, n) => {
  const f = FACT[q.params.fid]; if (!f) return s.sendStatus(404);
  if (!q.session.user.fac?.[f.id]) return s.status(403).json({ error: 'Nu ai acces la această facțiune.' });
  q.f = f; q.fname = q.session.user.fac[f.id]; n();
};
const guard = [need, fac];

app.get('/auth/login', (q, s) => s.redirect(`https://discord.com/oauth2/authorize?client_id=${E.CLIENT_ID}&response_type=code&scope=identify&redirect_uri=${encodeURIComponent(E.REDIRECT_URI)}`));
app.get('/auth/callback', async (q, s) => {
  try {
    const t = await (await fetch(API + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: E.CLIENT_ID, client_secret: E.CLIENT_SECRET, grant_type: 'authorization_code', code: q.query.code, redirect_uri: E.REDIRECT_URI }) })).json();
    const u = await (await fetch(API + '/users/@me', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
    // Daca ai rolul de acces in ORICARE facțiune, poti folosi toate facțiunile configurate
    let ok = false, avatar = null, name = u.global_name || u.username; const nick = {};
    for (const f of Object.values(FACT)) {
      const r = await bot('GET', `/guilds/${f.guild}/members/${u.id}`);
      if (!r.ok) continue;
      const m = await r.json();
      nick[f.id] = m.nick;
      if (f.access.some(x => m.roles.includes(x))) ok = true;
      avatar ??= avatarUrl(f, u.id, m);
    }
    if (!ok) return s.status(403).send('Nu ai rolul necesar pentru acces.');
    const fc = Object.fromEntries(Object.keys(FACT).map(id => [id, nick[id] || name]));
    q.session.user = { id: u.id, name: Object.values(fc)[0] || name, avatar, fac: fc };
    s.redirect('/');
  } catch (e) { s.status(500).send('Eroare la login.'); }
});
app.post('/auth/logout', (q, s) => q.session.destroy(() => s.json({ ok: 1 })));

app.get('/api/me', need, (q, s) => {
  const u = q.session.user;
  s.json({ user: { id: u.id, name: u.name, avatar: u.avatar }, factions: Object.keys(u.fac).map(id => ({ id, name: FACT[id].name, color: FACT[id].color })) });
});
app.get('/api/:fid/meta', guard, async (q, s) => s.json({ name: q.f.name, user: q.fname, roles: await roleNames(q.f), order: q.f.ranks }));

const mine = q => db.docs.filter(d => d.faction === q.f.id);
app.get('/api/:fid/docs', guard, (q, s) => s.json(mine(q).map(d => ({ id: d.id, name: d.name, count: d.rows.length })).reverse()));
app.get('/api/:fid/docs/:id', guard, async (q, s) => {
  const d = mine(q).find(x => x.id === q.params.id); if (!d) return s.sendStatus(404);
  try { await syncDoc(q.f, d); } catch (e) { console.error('sync:', e.message); }
  s.json(d);
});

app.delete('/api/:fid/docs/:id', guard, (q, s) => {
  const i = db.docs.findIndex(d => d.id === q.params.id && d.faction === q.f.id);
  if (i < 0) return s.sendStatus(404);
  db.docs.splice(i, 1); save(); s.json({ ok: 1 });
});

app.post('/api/:fid/docs', guard, async (q, s) => {
  const f = q.f;
  try {
    const d = new Date(), st = new Date(d); st.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const en = new Date(st); en.setDate(st.getDate() + (+E.DOC_DAYS || 7) - 1);
    const fm = x => x.toLocaleDateString('ro-RO', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const name = `${fm(st)} - ${fm(en)}`;
    if (mine(q).some(x => x.name === name)) return s.status(409).json({ error: 'Docs-ul pentru această perioadă există deja.' });
    const aud = await auditSince(f);
    const rows = (await members(f)).filter(m => m.roles.includes(f.member)).map(m => {
      const uid = m.user.id, rank = rankOf(f, m);
      let since = null, src = null; const t = rank && aud[uid + ':' + rank], p = db.seen[sk(f, uid)];
      if (t) { since = new Date(t).toISOString().slice(0, 10); src = 'audit'; }
      else if (rank && p && p.rank === rank) { since = p.since; src = p.src || 'seen'; }
      else if (rank) { since = today(); src = 'seen'; }
      db.seen[sk(f, uid)] = { rank, since, src };
      return { uid, name: m.nick || m.user.global_name || m.user.username, avatar: avatarUrl(f, uid, m), tickets: 0, decision: '—', rank, extra: extraOf(f, m), since, sinceSrc: src, locked: false };
    }).sort((a, b) => f.ranks.indexOf(b.rank) - f.ranks.indexOf(a.rank));
    const doc = { id: Date.now().toString(36), faction: f.id, name, createdAt: new Date().toISOString(), createdBy: q.fname, rows };
    db.docs.push(doc); save(); s.json(doc);
  } catch (e) { s.status(502).json({ error: e.message }); }
});

app.patch('/api/:fid/docs/:id/rows/:uid', guard, async (q, s) => {
  const f = q.f, doc = mine(q).find(d => d.id === q.params.id), r = doc?.rows.find(x => x.uid === q.params.uid);
  if (!r) return s.sendStatus(404);
  const { decision, tickets } = q.body;
  if (tickets !== undefined) { r.tickets = Math.max(0, +tickets || 0); save(); return s.json(r); }
  if (r.locked) return s.status(409).json({ error: 'Decizia a fost deja aplicată.' });
  try {
    if (decision === 'Up' || decision === 'Down') {
      const n = f.ranks.indexOf(r.rank) + (decision === 'Up' ? 1 : -1);
      if (n < 0 || n >= f.ranks.length) return s.status(400).json({ error: decision === 'Up' ? 'Deja la gradul maxim.' : 'Deja la gradul minim.' });
      await role(f, 'PUT', r.uid, f.ranks[n]);
      if (r.rank) await role(f, 'DELETE', r.uid, r.rank);
      r.rank = f.ranks[n]; r.since = today(); r.sinceSrc = 'panel'; db.seen[sk(f, r.uid)] = { rank: r.rank, since: r.since, src: 'panel' };
    } else if (decision === 'Out') {
      if (r.rank) await role(f, 'DELETE', r.uid, r.rank);
      await role(f, 'DELETE', r.uid, f.member);
      r.out = true; delete db.seen[sk(f, r.uid)];
    } else if (decision !== 'Rămâne') return s.status(400).json({ error: 'Decizie invalidă.' });
    r.decision = decision; r.locked = true; r.by = q.fname; r.at = new Date().toISOString();
    save(); s.json(r);
  } catch (e) { s.status(502).json({ error: e.message }); }
});

app.listen(E.PORT || 3000, () => console.log('Panou facțiuni pe http://localhost:' + (E.PORT || 3000) + ' — active: ' + (Object.values(FACT).map(f => f.name).join(', ') || 'NICIUNA')));
