// Tests : super admin, migration, journal, remise à zéro, analyse photo IA
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeD1, makeKV } from './local-env.mjs';

async function client(mod, env) {
  let cookie = '';
  const call = async (method, path, body, raw) => {
    const headers = { 'x-app': '1' };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (raw) { payload = raw; headers['content-type'] = 'image/jpeg'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const res = await mod.default.fetch(new Request('https://t.local' + path, { method, headers, body: payload }), env);
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { call, setCookie: (c) => (cookie = c), getCookie: () => cookie };
}

test('migration v1 → v2 : le premier admin devient super admin', async () => {
  const env = { DB: makeD1(), PHOTOS: makeKV() };
  const m1 = await import('../src/worker.js?a');
  const c = await client(m1, env);
  await c.call('POST', '/api/setup', { username: 'med', password: 'secret123', name: 'Med' });
  await c.call('POST', '/api/users', { username: 'owner', password: 'secret123', role: 'admin', name: 'Owner' });
  // simuler une ancienne installation v1
  const db = env.DB._db;
  db.exec(`UPDATE users SET role='admin'; DROP TABLE audit_log; UPDATE settings SET value='1' WHERE key='schema_version'`);
  const m2 = await import('../src/worker.js?b'); // nouvelle instance = nouveau démarrage
  const c2 = await client(m2, env); c2.setCookie(c.getCookie());
  const r = await c2.call('GET', '/api/status');
  assert.equal(r.data.user.role, 'superadmin');
  assert.equal(db.prepare(`SELECT value FROM settings WHERE key='schema_version'`).get().value, '2');
  assert.equal(db.prepare(`SELECT role FROM users WHERE username='owner'`).get().role, 'admin');
  const a = await c2.call('GET', '/api/audit');
  assert.equal(a.status, 200);
});

test('droits super admin / admin / caissier + journal + remise à zéro + code', async () => {
  const env = { DB: makeD1(), PHOTOS: makeKV(), SUPERADMIN_CODE: 'Golsh-2026!' };
  const m = await import('../src/worker.js?c');
  const sup = await client(m, env);
  let r = await sup.call('POST', '/api/setup', { username: 'med', password: 'secret123', name: 'Med' });
  r = await sup.call('GET', '/api/status');
  assert.equal(r.data.user.role, 'superadmin');
  assert.equal((await sup.call('POST', '/api/users', { username: 'boss', password: 'secret123', role: 'admin' })).status, 200);
  assert.equal((await sup.call('POST', '/api/users', { username: 'sami', password: 'secret123', role: 'caissier' })).status, 200);

  const adm = await client(m, env);
  assert.equal((await adm.call('POST', '/api/login', { username: 'boss', password: 'secret123' })).status, 200);
  assert.equal((await adm.call('POST', '/api/users', { username: 'x2', password: 'secret123', role: 'admin' })).status, 403);
  assert.equal((await adm.call('POST', '/api/users', { username: 'x3', password: 'secret123', role: 'caissier' })).status, 200);
  const users = (await adm.call('GET', '/api/users')).data;
  const medId = users.find((u) => u.username === 'med').id;
  const samiId = users.find((u) => u.username === 'sami').id;
  assert.equal((await adm.call('PUT', '/api/users/' + medId, { active: false })).status, 403);
  assert.equal((await adm.call('PUT', '/api/users/' + samiId, { role: 'admin' })).status, 403);
  assert.equal((await adm.call('PUT', '/api/users/' + samiId, { password: 'nouveau1' })).status, 200);
  assert.equal((await adm.call('GET', '/api/audit')).status, 403);
  assert.equal((await adm.call('POST', '/api/superadmin/reset', { confirm: 'SUPPRIMER' })).status, 403);
  // admin peut tout de même gérer la boutique
  assert.equal((await adm.call('PUT', '/api/settings', { default_rate: 25 })).status, 200);

  // code de récupération
  assert.equal((await adm.call('POST', '/api/superadmin/claim', { code: 'faux' })).status, 403);
  assert.equal((await adm.call('POST', '/api/superadmin/claim', { code: 'Golsh-2026!' })).status, 200);
  assert.equal((await adm.call('GET', '/api/status')).data.user.role, 'superadmin');

  // journal
  const j = (await sup.call('GET', '/api/audit')).data;
  assert.ok(j.some((x) => x.action === 'Réglages modifiés'));
  assert.ok(j.some((x) => x.action.startsWith('Super admin activé')));

  // remise à zéro
  const s = (await sup.call('POST', '/api/suppliers', { name: 'Test' })).data;
  await sup.call('POST', '/api/deposits', { supplier_id: s.id, items: [{ title: 'A', price: 10 }] });
  assert.equal((await sup.call('POST', '/api/superadmin/reset', { confirm: 'non' })).status, 400);
  assert.equal((await sup.call('POST', '/api/superadmin/reset', { confirm: 'SUPPRIMER' })).status, 200);
  assert.equal((await sup.call('GET', '/api/items?status=all')).data.length, 0);
  assert.equal((await sup.call('GET', '/api/users')).data.length, 4);
  const s2 = (await sup.call('POST', '/api/suppliers', { name: 'Nouveau' })).data;
  assert.equal(s2.code, 'F0001');
});

test('dépôt : correspondance lignes → articles (photos)', async () => {
  const env = { DB: makeD1(), PHOTOS: makeKV() };
  const m = await import('../src/worker.js?d');
  const c = await client(m, env);
  await c.call('POST', '/api/setup', { username: 'med', password: 'secret123' });
  const s = (await c.call('POST', '/api/suppliers', { name: 'F' })).data;
  const r = (await c.call('POST', '/api/deposits', { supplier_id: s.id, items: [{ title: 'A', price: 10 }, { title: 'B', price: 5, qty: 3 }, { title: 'C', price: 7 }] })).data;
  assert.deepEqual(r.items.map((x) => x.line), [0, 1, 1, 1, 2]);
});

test('analyse photo IA : repli entre modèles et normalisation', async () => {
  const calls = [];
  const AI = {
    async run(model, input) {
      calls.push(model);
      assert.ok(input.messages[0].content[0].image_url.url.startsWith('data:image/jpeg;base64,'));
      if (model.includes('gemma')) throw new Error('5035 model unavailable');
      return { choices: [{ message: { content: 'Voici :\n```json\n{"titre":"Robe d\'été fleurie","categorie":"femme","marque":"Zara","taille":"M","couleur":"Bleu","etat":"tres bon etat","matiere":"coton","prix":"44.6","description":"Robe légère à fleurs"}\n```' } }] };
    },
  };
  const env = { DB: makeD1(), PHOTOS: makeKV(), AI };
  const m = await import('../src/worker.js?e');
  const c = await client(m, env);
  await c.call('POST', '/api/setup', { username: 'med', password: 'secret123' });
  assert.equal((await c.call('GET', '/api/status')).data.ai, true);
  const r = await c.call('POST', '/api/ai/analyze', undefined, new Uint8Array(5000).fill(7));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.fields;
  assert.equal(f.title, "Robe d'été fleurie");
  assert.equal(f.category_name, 'Femme');
  assert.equal(f.brand, 'Zara');
  assert.equal(f.condition, 'Très bon état');
  assert.equal(f.price, 45);
  assert.match(f.description, /coton/);
  assert.equal(calls.length, 2);
  // tous les modèles échouent → message clair
  env.AI = { run: async () => { throw new Error('quota'); } };
  const r2 = await c.call('POST', '/api/ai/analyze', undefined, new Uint8Array(100));
  assert.equal(r2.status, 502);
  // sans IA configurée
  delete env.AI;
  assert.equal((await c.call('POST', '/api/ai/analyze', undefined, new Uint8Array(100))).status, 501);
});

test('réponse IA : formats variés', async () => {
  const { _internals: I } = await import('../src/worker.js?f');
  assert.equal(I.aiText({ response: { titre: 'x' } }), '{"titre":"x"}');
  assert.equal(I.aiText({ choices: [{ message: { content: [{ text: '{"a":1}' }] } }] }), '{"a":1}');
  assert.deepEqual(I.aiJson('bla {"a": 2} bla'), { a: 2 });
  assert.equal(I.aiJson('pas de json'), null);
  const n = I.aiNormalize({ titre: 'Sac', marque: 'null', taille: 'inconnu', etat: 'Neuf avec étiquette', categorie: 'Sacs' }, [{ id: 3, name: 'Sacs & accessoires' }]);
  assert.equal(n.brand, null); assert.equal(n.size, null); assert.equal(n.category_id, 3); assert.equal(n.condition, 'Neuf avec étiquette');
});
