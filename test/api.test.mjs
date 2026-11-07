// Tests de bout en bout de l'API (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { makeD1, makeKV, resetQueryCount } from './local-env.mjs';

const env = { DB: makeD1(), PHOTOS: makeKV() };
let cookie = '';
let maxQueries = 0;

async function call(method, path, body, opts = {}) {
  const headers = { 'x-app': '1' };
  if (opts.cookie ?? cookie) headers.cookie = opts.cookie ?? cookie;
  let payload;
  if (body instanceof Uint8Array) { payload = body; headers['content-type'] = 'image/jpeg'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  resetQueryCount();
  const res = await worker.fetch(new Request('https://test.local' + path, { method, headers, body: payload }), env);
  const q = resetQueryCount();
  maxQueries = Math.max(maxQueries, q);
  assert.ok(q <= 50, `${method} ${path} a utilisé ${q} requêtes (limite D1 gratuite : 50)`);
  const sc = res.headers.get('set-cookie');
  if (sc && !opts.noStore) cookie = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

test('parcours complet dépôt-vente', async () => {
  let r = await call('GET', '/api/status');
  assert.equal(r.data.initialized, false);

  r = await call('POST', '/api/setup', { username: 'Admin', password: 'secret123', name: 'Med', shop_name: 'Golsh' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('POST', '/api/setup', { username: 'x', password: 'secret123' });
  assert.equal(r.status, 409);

  r = await call('GET', '/api/status');
  assert.equal(r.data.initialized, true);
  assert.equal(r.data.user.role, 'admin');

  // CSRF
  const noHdr = await worker.fetch(new Request('https://test.local/api/logout', { method: 'POST', headers: { cookie } }), env);
  assert.equal(noHdr.status, 403);

  // Paramètres : taux par défaut 30, démarque 30j -20%
  r = await call('PUT', '/api/settings', { default_rate: '30', markdown_rules: [{ days: 30, pct: 20 }, { days: 60, pct: 40 }], deposit_days: 90 });
  assert.equal(r.status, 200);

  r = await call('GET', '/api/categories');
  assert.ok(r.data.length >= 8);
  const femme = r.data.find((c) => c.name === 'Femme');
  await call('PUT', `/api/categories/${femme.id}`, { name: 'Femme', rate: 25 });

  // Fournisseurs
  r = await call('POST', '/api/suppliers', { name: 'Amira Ben Salah', phone: '22 333 444', payout_method: 'd17' });
  const amira = r.data.id;
  r = await call('POST', '/api/suppliers', { name: 'Karim', phone: '98111222', rate: 20 });
  const karim = r.data.id;

  // Dépôt de 3 articles (dont 2 identiques via qty)
  r = await call('POST', '/api/deposits', {
    supplier_id: amira,
    items: [
      { title: 'Robe soirée noire', price: 120, category_id: femme.id, size: 'M', brand: 'Zara' },
      { title: 'Sac cuir', price: 80, qty: 2 },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const dep = await call('GET', `/api/deposits/${r.data.id}`);
  assert.equal(dep.data.items.length, 3);
  const [robe, sac1, sac2] = dep.data.items;
  assert.equal(robe.code, 'GS000001');
  assert.equal(robe.rate, 25); // taux catégorie
  assert.equal(sac1.rate, 30); // taux défaut

  // Gros dépôt (60 articles) pour vérifier la limite de requêtes
  const many = Array.from({ length: 60 }, (_, i) => ({ title: 'Article ' + i, price: 10 + i }));
  r = await call('POST', '/api/deposits', { supplier_id: karim, items: many });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const kItems = (await call('GET', `/api/items?supplier_id=${karim}`)).data;
  assert.equal(kItems.length, 60);
  assert.equal(kItems[0].rate, 20); // taux fournisseur

  // Démarque : vieillir la robe de 35 jours
  env.DB._db.prepare(`UPDATE items SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 35 * 86400000).toISOString(), robe.id);
  r = await call('GET', `/api/items/by-code/${encodeURIComponent('https://x/#/a/gs000001')}`);
  assert.equal(r.data.current_price, 96);
  assert.equal(r.data.markdown_pct, 20);

  // Photo
  r = await call('PUT', `/api/items/${robe.id}/photo`, new Uint8Array([255, 216, 255, 1, 2, 3]));
  assert.equal(r.status, 200);
  const ph = await worker.fetch(new Request(`https://test.local/api/photo/${robe.id}`, { headers: { cookie } }), env);
  assert.equal(ph.status, 200);

  // Aperçu + vente : robe (96) + sac1 (80) remise globale 6
  r = await call('POST', '/api/sales/preview', { items: [{ code: robe.code }, { code: sac1.code }], discount: 6 });
  assert.equal(r.data.total, 170);
  r = await call('POST', '/api/sales', { items: [{ code: robe.code }, { code: sac1.code }], discount: 6, payment_method: 'especes' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sale1 = r.data.id;
  let sale = (await call('GET', `/api/sales/${sale1}`)).data;
  assert.equal(sale.lines.length, 2);
  assert.equal(sale.sale.total, 170);
  const sumParts = sale.lines.reduce((a, l) => a + l.shop_amount + l.supplier_amount, 0);
  assert.ok(Math.abs(sumParts - 170) < 0.01);

  // Double vente impossible
  r = await call('POST', '/api/sales', { items: [{ code: sac1.code }] });
  assert.equal(r.status, 409);
  assert.equal(r.data.problems[0].code, sac1.code);

  // Grosse vente (40 articles) : limite de requêtes respectée
  r = await call('POST', '/api/sales', { items: kItems.slice(0, 40).map((i) => ({ code: i.code })), payment_method: 'carte' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  sale = (await call('GET', `/api/sales/${r.data.id}`)).data;
  assert.equal(sale.lines.length, 40);

  // Solde Amira = parts fournisseur robe + sac
  r = await call('GET', `/api/suppliers/${amira}`);
  const expected = (await call('GET', `/api/sales/${sale1}`)).data.lines.reduce((a, l) => a + l.supplier_amount, 0);
  assert.ok(Math.abs(r.data.supplier.balance - expected) < 0.001);
  assert.equal(r.data.unpaid.length, 2);

  // Annulation puis revente
  r = await call('POST', `/api/sales/${sale1}/cancel`, { reason: 'test' });
  assert.equal(r.status, 200);
  r = await call('GET', `/api/suppliers/${amira}`);
  assert.equal(r.data.supplier.balance, 0);
  assert.equal(r.data.supplier.items_stock, 3);
  r = await call('POST', '/api/sales', { items: [{ code: sac1.code, discount: 10 }], payment_method: 'd17' });
  assert.equal(r.status, 200);

  // Reversement
  r = await call('POST', '/api/payouts', { supplier_id: amira, method: 'd17', reference: 'TX1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const po = (await call('GET', `/api/payouts/${r.data.id}`)).data;
  assert.equal(po.lines.length, 1);
  assert.equal(po.payout.amount, 49); // (80-10) * 70%
  r = await call('POST', '/api/payouts', { supplier_id: amira });
  assert.equal(r.status, 400);

  // Retour fournisseur + réservation
  r = await call('POST', '/api/items/status', { ids: [sac2.id], status: 'reserve', note: 'Mme X' });
  assert.equal(r.data.changed, 1);
  r = await call('POST', '/api/items/status', { ids: [sac2.id, sac1.id], status: 'retourne' });
  assert.equal(r.data.changed, 1);
  assert.equal(r.data.skipped, 1);

  // Inventaire
  r = await call('POST', '/api/inventory', { codes: [robe.code, sac1.code, 'GS999999'] });
  assert.equal(r.status, 200);
  assert.equal(r.data.found, 1);
  assert.ok(r.data.unexpected.find((u) => u.code === 'GS999999'));

  // Tableau de bord
  r = await call('GET', '/api/dashboard');
  assert.equal(r.status, 200);
  assert.equal(r.data.today.n, 2);
  assert.ok(r.data.stock.n > 0);

  // Exports
  for (const n of ['articles', 'ventes', 'lignes', 'fournisseurs', 'reversements']) {
    r = await call('GET', `/api/export/${n}.csv`);
    assert.equal(r.status, 200);
    assert.ok(r.data.length > 10);
  }
  r = await call('GET', '/api/backup');
  assert.equal(r.status, 200);

  // Caissier : droits limités
  r = await call('POST', '/api/users', { username: 'sami', password: 'caisse1', role: 'caissier' });
  assert.equal(r.status, 200);
  const adminCookie = cookie;
  r = await call('POST', '/api/login', { username: 'sami', password: 'mauvais' });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/login', { username: 'SAMI', password: 'caisse1' });
  assert.equal(r.status, 200);
  r = await call('GET', '/api/dashboard');
  assert.equal(r.data.today.margin, null);
  r = await call('PUT', '/api/settings', { default_rate: 50 });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/payouts', { supplier_id: karim });
  assert.equal(r.status, 403);
  r = await call('GET', '/api/export/ventes.csv');
  assert.equal(r.status, 403);
  cookie = adminCookie;

  r = await call('POST', '/api/logout');
  r = await call('GET', '/api/dashboard');
  assert.equal(r.status, 401);
  console.log('Max requêtes D1 par appel :', maxQueries);
});
