// =====================================================================
//  Golsh Dépôt-Vente — API (Cloudflare Worker + D1 + KV)
//  Aucune dépendance externe. Le schéma de base se crée tout seul.
// =====================================================================

const SCHEMA_VERSION = '1';
const SESSION_DAYS = 30;
const PBKDF2_ITER = 10000;
const SELLABLE = "('en_vente','reserve')";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL DEFAULT 'caissier', pass_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS login_attempts (username TEXT NOT NULL, ts TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, rate REAL)`,
  `CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT NOT NULL, phone TEXT, cin TEXT, address TEXT, rib TEXT, payout_method TEXT DEFAULT 'especes', rate REAL, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT, supplier_id INTEGER NOT NULL, user_id INTEGER, notes TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, deposit_id INTEGER, supplier_id INTEGER NOT NULL, category_id INTEGER, title TEXT NOT NULL, brand TEXT, size TEXT, color TEXT, condition TEXT, description TEXT, price REAL NOT NULL, rate_override REAL, no_markdown INTEGER NOT NULL DEFAULT 0, location TEXT, status TEXT NOT NULL DEFAULT 'en_vente', reserved_for TEXT, has_photo INTEGER NOT NULL DEFAULT 0, sale_id TEXT, created_at TEXT NOT NULL, sold_at TEXT, closed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_items_supplier ON items(supplier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_sale ON items(sale_id)`,
  `CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, number TEXT, user_id INTEGER, created_at TEXT NOT NULL, subtotal REAL, discount REAL, total REAL, shop_total REAL, payment_method TEXT, customer TEXT, customer_phone TEXT, status TEXT NOT NULL DEFAULT 'ok', cancelled_at TEXT, cancel_reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at)`,
  `CREATE TABLE IF NOT EXISTS sale_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, item_id INTEGER NOT NULL, supplier_id INTEGER NOT NULL, base_price REAL, unit_price REAL, discount REAL, final_price REAL, rate REAL, shop_amount REAL, supplier_amount REAL, payout_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_lines_sale ON sale_lines(sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lines_supplier ON sale_lines(supplier_id, payout_id)`,
  `CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, number TEXT, supplier_id INTEGER NOT NULL, amount REAL NOT NULL, method TEXT, reference TEXT, notes TEXT, user_id INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS movements (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER, type TEXT NOT NULL, note TEXT, user_id INTEGER, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_mov_item ON movements(item_id)`,
  `CREATE TABLE IF NOT EXISTS inventories (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, created_at TEXT NOT NULL, scanned INTEGER, found INTEGER, missing INTEGER, unexpected INTEGER, data TEXT)`,
];

const DEFAULT_SETTINGS = {
  schema_version: SCHEMA_VERSION,
  shop_name: 'Golsh',
  shop_phone: '',
  shop_address: '',
  currency: 'DT',
  color: '#111111',
  default_rate: '30',
  tiers: '[]',
  deposit_days: '90',
  markdown_enabled: '1',
  markdown_rules: JSON.stringify([{ days: 30, pct: 20 }, { days: 60, pct: 40 }]),
  code_prefix: 'GS',
  label_format: 'a4',
  label_code: 'both',
  ticket_footer: 'Merci pour votre visite !',
  tz_offset: '1',
  seq_item: '0',
  seq_sale: '0',
  seq_deposit: '0',
  seq_payout: '0',
  seq_supplier: '0',
};

let schemaReady = false;

// ---------------------------------------------------------------- utils
const nowIso = () => new Date().toISOString();
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const num = (v, def = null) => {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
};
const int = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Identifiant invalide');
  return n;
};
const str = (v, max = 500) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function csv(rows, filename) {
  if (!rows.length) rows = [{ vide: '' }];
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function hashPassword(password, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return b64(bits);
}

function newSalt() {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---------------------------------------------------------------- schema / settings
async function ensureSchema(env) {
  if (schemaReady) return;
  let ok = false;
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key='schema_version'`).first();
    ok = !!row;
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    const entries = Object.entries(DEFAULT_SETTINGS);
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ${entries.map(() => '(?, ?)').join(',')}`)
      .bind(...entries.flat())
      .run();
  }
  schemaReady = true;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results) s[r.key] = r.value;
  return s;
}

async function nextSeq(env, key) {
  const row = await env.DB.prepare(
    `UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING value`
  )
    .bind(key)
    .first();
  if (!row) {
    await env.DB.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, '1')`).bind(key).run();
    return 1;
  }
  return Number(row.value);
}

// ---------------------------------------------------------------- business rules
function parseJsonSafe(s, def) {
  try {
    const v = JSON.parse(s);
    return v ?? def;
  } catch {
    return def;
  }
}

function ageDays(createdAt) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86400000));
}

// Prix actuel après démarque automatique
function currentPrice(item, settings) {
  const base = Number(item.price) || 0;
  if (settings.markdown_enabled !== '1' || item.no_markdown) return { price: base, pct: 0 };
  const rules = parseJsonSafe(settings.markdown_rules, []).filter((r) => r && r.days > 0 && r.pct > 0);
  const age = ageDays(item.created_at);
  let pct = 0;
  for (const r of rules) if (age >= Number(r.days) && Number(r.pct) > pct) pct = Number(r.pct);
  if (!pct) return { price: base, pct: 0 };
  let p = base * (1 - pct / 100);
  p = p >= 2 ? Math.round(p * 2) / 2 : r3(p);
  return { price: p, pct };
}

// Taux de commission : article > fournisseur > catégorie > paliers > défaut
function resolveRate(item, settings) {
  if (item.rate_override !== null && item.rate_override !== undefined) return { rate: Number(item.rate_override), source: 'article' };
  if (item.supplier_rate !== null && item.supplier_rate !== undefined) return { rate: Number(item.supplier_rate), source: 'fournisseur' };
  if (item.category_rate !== null && item.category_rate !== undefined) return { rate: Number(item.category_rate), source: 'catégorie' };
  const tiers = parseJsonSafe(settings.tiers, [])
    .filter((t) => t && t.rate !== undefined && t.rate !== null && t.rate !== '')
    .sort((a, b) => (num(a.max, Infinity) ?? Infinity) - (num(b.max, Infinity) ?? Infinity));
  const price = Number(item.price) || 0;
  for (const t of tiers) {
    const max = num(t.max, null);
    if (max === null || price <= max) return { rate: Number(t.rate), source: 'palier' };
  }
  return { rate: num(settings.default_rate, 30), source: 'défaut' };
}

function decorateItem(item, settings) {
  const cp = currentPrice(item, settings);
  const rr = resolveRate(item, settings);
  const age = ageDays(item.created_at);
  const days = num(settings.deposit_days, 90);
  return {
    ...item,
    current_price: cp.price,
    markdown_pct: cp.pct,
    rate: rr.rate,
    rate_source: rr.source,
    age_days: age,
    expired: ['en_vente', 'reserve'].includes(item.status) && days > 0 && age >= days,
  };
}

const ITEM_SELECT = `SELECT i.*, s.name AS supplier_name, s.phone AS supplier_phone, s.rate AS supplier_rate,
  c.name AS category_name, c.rate AS category_rate
  FROM items i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN categories c ON c.id = i.category_id`;

async function logMoves(env, entries) {
  if (!entries.length) return;
  const t = nowIso();
  // requêtes multi-lignes (max 19 lignes × 5 paramètres < 100 paramètres D1)
  const stmts = [];
  for (let i = 0; i < entries.length; i += 19) {
    const part = entries.slice(i, i + 19);
    const args = [];
    for (const e of part) args.push(e.item_id ?? null, e.type, e.note ?? null, e.user_id ?? null, t);
    stmts.push(
      env.DB.prepare(`INSERT INTO movements (item_id, type, note, user_id, created_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(',')}`).bind(...args)
    );
  }
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------- auth
async function currentUser(req, env) {
  const token = getCookie(req, 'gs_session');
  if (!token) return null;
  const th = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  )
    .bind(th)
    .first();
  if (!row || !row.active || Date.parse(row.expires_at) < Date.now()) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

function sessionCookie(token, maxAge) {
  return `gs_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function createSession(env, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso()),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).bind(await sha256(token), userId, exp),
  ]);
  return token;
}

function requireAdmin(user) {
  if (!user || user.role !== 'admin') throw new HttpError(403, 'Réservé à l’administrateur');
}

function validPassword(p) {
  if (!p || String(p).length < 6) throw new HttpError(400, 'Le mot de passe doit contenir au moins 6 caractères');
  return String(p);
}

// ---------------------------------------------------------------- router
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  routes.push({ method, re, keys, handler, opts });
};

// ---------- statut / installation / connexion
route('GET', '/api/status', async (req, env, ctx) => {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  const s = await getSettings(env);
  return json({ initialized: row.n > 0, user: ctx.user, shop_name: s.shop_name, color: s.color, photos: !!env.PHOTOS });
}, { public: true });

route('POST', '/api/setup', async (req, env) => {
  const body = await req.json();
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
  if (row.n > 0) throw new HttpError(409, 'Application déjà initialisée');
  const username = str(body.username, 40)?.toLowerCase();
  if (!username) throw new HttpError(400, 'Identifiant requis');
  const pw = validPassword(body.password);
  const salt = newSalt();
  const stmts = [
    env.DB.prepare(`INSERT INTO users (username, name, role, pass_hash, salt, created_at) VALUES (?, ?, 'admin', ?, ?, ?)`).bind(
      username, str(body.name, 80) || username, await hashPassword(pw, salt), salt, nowIso()
    ),
  ];
  if (str(body.shop_name, 80)) stmts.push(env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'shop_name'`).bind(str(body.shop_name, 80)));
  await env.DB.batch(stmts);
  // catégories de départ
  const cats = ['Femme', 'Homme', 'Enfant', 'Chaussures', 'Sacs & accessoires', 'Bijoux', 'Maison', 'Divers'];
  await env.DB.prepare(`INSERT OR IGNORE INTO categories (name) VALUES ${cats.map(() => '(?)').join(',')}`).bind(...cats).run();
  const u = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`).bind(username).first();
  const token = await createSession(env, u.id);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}, { public: true });

route('POST', '/api/login', async (req, env) => {
  const body = await req.json();
  const username = str(body.username, 40)?.toLowerCase() || '';
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const att = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ts > ?`).bind(username, since).first();
  if (att.n >= 8) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
  const u = await env.DB.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();
  const ok = u && u.active && safeEqual(await hashPassword(String(body.password || ''), u.salt), u.pass_hash);
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM login_attempts WHERE ts < ?`).bind(since),
      env.DB.prepare(`INSERT INTO login_attempts (username, ts) VALUES (?, ?)`).bind(username, nowIso()),
    ]);
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
  }
  const token = await createSession(env, u.id);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86400) });
}, { public: true });

route('POST', '/api/logout', async (req, env) => {
  const token = getCookie(req, 'gs_session');
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}, { public: true });

route('POST', '/api/me/password', async (req, env, ctx) => {
  const body = await req.json();
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(ctx.user.id).first();
  if (!safeEqual(await hashPassword(String(body.current || ''), u.salt), u.pass_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect');
  const salt = newSalt();
  await env.DB.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).bind(await hashPassword(validPassword(body.password), salt), salt, u.id).run();
  return json({ ok: true });
});

// ---------- paramètres
const EDITABLE_SETTINGS = ['shop_name', 'shop_phone', 'shop_address', 'currency', 'color', 'default_rate', 'tiers', 'deposit_days', 'markdown_enabled', 'markdown_rules', 'code_prefix', 'label_format', 'label_code', 'ticket_footer', 'tz_offset'];

route('GET', '/api/settings', async (req, env) => {
  const s = await getSettings(env);
  const out = {};
  for (const k of EDITABLE_SETTINGS) out[k] = s[k];
  out.tiers = parseJsonSafe(s.tiers, []);
  out.markdown_rules = parseJsonSafe(s.markdown_rules, []);
  return json(out);
});

route('PUT', '/api/settings', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const body = await req.json();
  const stmts = [];
  for (const k of EDITABLE_SETTINGS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === 'tiers' || k === 'markdown_rules') {
      if (!Array.isArray(v)) throw new HttpError(400, 'Format invalide pour ' + k);
      v = JSON.stringify(
        v.slice(0, 10).map((r) => (k === 'tiers' ? { max: num(r.max, null), rate: num(r.rate, 0) } : { days: Math.max(0, Math.round(num(r.days, 0))), pct: Math.min(90, Math.max(0, num(r.pct, 0))) }))
      );
    } else if (['default_rate', 'deposit_days', 'tz_offset'].includes(k)) {
      const n = num(v, null);
      if (n === null) throw new HttpError(400, 'Valeur numérique invalide : ' + k);
      v = String(n);
    } else if (k === 'markdown_enabled') {
      v = v === true || v === '1' || v === 1 ? '1' : '0';
    } else if (k === 'code_prefix') {
      v = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'GS';
    } else if (k === 'color') {
      v = /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#111111';
    } else {
      v = str(v, 300) || '';
    }
    stmts.push(env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(k, v));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
});

// ---------- utilisateurs
route('GET', '/api/users', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const { results } = await env.DB.prepare(`SELECT id, username, name, role, active, created_at FROM users ORDER BY id`).all();
  return json(results);
});

route('POST', '/api/users', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const b = await req.json();
  const username = str(b.username, 40)?.toLowerCase();
  if (!username || !/^[a-z0-9._-]+$/.test(username)) throw new HttpError(400, 'Identifiant invalide (lettres, chiffres, . _ -)');
  const role = b.role === 'admin' ? 'admin' : 'caissier';
  const salt = newSalt();
  try {
    await env.DB.prepare(`INSERT INTO users (username, name, role, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(username, str(b.name, 80) || username, role, await hashPassword(validPassword(b.password), salt), salt, nowIso())
      .run();
  } catch (e) {
    throw new HttpError(409, 'Cet identifiant existe déjà');
  }
  return json({ ok: true });
});

route('PUT', '/api/users/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const id = int(p.id);
  const b = await req.json();
  if (id === ctx.user.id && (b.active === false || b.role === 'caissier')) throw new HttpError(400, 'Vous ne pouvez pas désactiver ou rétrograder votre propre compte');
  const stmts = [];
  if (b.name !== undefined) stmts.push(env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(str(b.name, 80), id));
  if (b.role !== undefined) stmts.push(env.DB.prepare(`UPDATE users SET role = ? WHERE id = ?`).bind(b.role === 'admin' ? 'admin' : 'caissier', id));
  if (b.active !== undefined) {
    stmts.push(env.DB.prepare(`UPDATE users SET active = ? WHERE id = ?`).bind(b.active ? 1 : 0, id));
    if (!b.active) stmts.push(env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id));
  }
  if (b.password) {
    const salt = newSalt();
    stmts.push(env.DB.prepare(`UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?`).bind(await hashPassword(validPassword(b.password), salt), salt, id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
});

// ---------- catégories
route('GET', '/api/categories', async (req, env) => {
  const { results } = await env.DB.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.status IN ${SELLABLE}) AS in_stock FROM categories c ORDER BY c.name`
  ).all();
  return json(results);
});

route('POST', '/api/categories', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const b = await req.json();
  const name = str(b.name, 60);
  if (!name) throw new HttpError(400, 'Nom requis');
  try {
    await env.DB.prepare(`INSERT INTO categories (name, rate) VALUES (?, ?)`).bind(name, num(b.rate, null)).run();
  } catch {
    throw new HttpError(409, 'Cette catégorie existe déjà');
  }
  return json({ ok: true });
});

route('PUT', '/api/categories/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const b = await req.json();
  await env.DB.prepare(`UPDATE categories SET name = COALESCE(?, name), rate = ? WHERE id = ?`).bind(str(b.name, 60), num(b.rate, null), int(p.id)).run();
  return json({ ok: true });
});

route('DELETE', '/api/categories/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const id = int(p.id);
  await env.DB.batch([
    env.DB.prepare(`UPDATE items SET category_id = NULL WHERE category_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM categories WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
});

// ---------- fournisseurs
const SUPPLIER_STATS = `
  (SELECT COUNT(*) FROM items i WHERE i.supplier_id = s.id) AS items_total,
  (SELECT COUNT(*) FROM items i WHERE i.supplier_id = s.id AND i.status IN ${SELLABLE}) AS items_stock,
  (SELECT COUNT(*) FROM items i WHERE i.supplier_id = s.id AND i.status = 'vendu') AS items_sold,
  (SELECT COALESCE(SUM(l.supplier_amount), 0) FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status = 'ok' WHERE l.supplier_id = s.id AND l.payout_id IS NULL) AS balance,
  (SELECT COALESCE(SUM(l.final_price), 0) FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status = 'ok' WHERE l.supplier_id = s.id) AS sales_total`;

route('GET', '/api/suppliers', async (req, env) => {
  const url = new URL(req.url);
  const q = str(url.searchParams.get('q'), 60);
  let sql = `SELECT s.*, ${SUPPLIER_STATS} FROM suppliers s WHERE s.active = 1`;
  const args = [];
  if (q) {
    sql += ` AND (s.name LIKE ? OR s.phone LIKE ? OR s.code LIKE ?)`;
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY s.name LIMIT 500`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json(results.map((r) => ({ ...r, balance: r3(r.balance), sales_total: r3(r.sales_total) })));
});

route('GET', '/api/suppliers/:id', async (req, env, ctx, p) => {
  const id = int(p.id);
  const s = await env.DB.prepare(`SELECT s.*, ${SUPPLIER_STATS} FROM suppliers s WHERE s.id = ?`).bind(id).first();
  if (!s) throw new HttpError(404, 'Fournisseur introuvable');
  const settings = await getSettings(env);
  const [items, payouts, deposits] = await env.DB.batch([
    env.DB.prepare(`${ITEM_SELECT} WHERE i.supplier_id = ? ORDER BY i.id DESC LIMIT 500`).bind(id),
    env.DB.prepare(`SELECT * FROM payouts WHERE supplier_id = ? ORDER BY created_at DESC LIMIT 100`).bind(id),
    env.DB.prepare(`SELECT d.*, (SELECT COUNT(*) FROM items i WHERE i.deposit_id = d.id) AS n FROM deposits d WHERE d.supplier_id = ? ORDER BY d.id DESC LIMIT 100`).bind(id),
  ]);
  const unpaid = await env.DB.prepare(
    `SELECT l.*, i.code, i.title, v.number AS sale_number, v.created_at AS sale_date FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status = 'ok' JOIN items i ON i.id = l.item_id WHERE l.supplier_id = ? AND l.payout_id IS NULL ORDER BY v.created_at`
  ).bind(id).all();
  return json({
    supplier: { ...s, balance: r3(s.balance), sales_total: r3(s.sales_total) },
    items: items.results.map((i) => decorateItem(i, settings)),
    payouts: payouts.results,
    deposits: deposits.results,
    unpaid: unpaid.results,
  });
});

function supplierFields(b) {
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, 'Nom du fournisseur requis');
  return [name, str(b.phone, 30), str(b.cin, 30), str(b.address, 200), str(b.rib, 40),
    ['especes', 'virement', 'd17', 'flouci', 'cheque', 'autre'].includes(b.payout_method) ? b.payout_method : 'especes',
    num(b.rate, null), str(b.notes, 1000)];
}

route('POST', '/api/suppliers', async (req, env) => {
  const b = await req.json();
  const f = supplierFields(b);
  const seq = await nextSeq(env, 'seq_supplier');
  const code = 'F' + String(seq).padStart(4, '0');
  const row = await env.DB.prepare(
    `INSERT INTO suppliers (code, name, phone, cin, address, rib, payout_method, rate, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(code, ...f, nowIso()).first();
  return json({ ok: true, id: row.id, code });
});

route('PUT', '/api/suppliers/:id', async (req, env, ctx, p) => {
  const b = await req.json();
  const f = supplierFields(b);
  if (ctx.user.role !== 'admin') {
    // le caissier ne peut pas modifier le taux négocié
    const cur = await env.DB.prepare(`SELECT rate FROM suppliers WHERE id = ?`).bind(int(p.id)).first();
    f[6] = cur ? cur.rate : null;
  }
  await env.DB.prepare(`UPDATE suppliers SET name=?, phone=?, cin=?, address=?, rib=?, payout_method=?, rate=?, notes=? WHERE id = ?`).bind(...f, int(p.id)).run();
  return json({ ok: true });
});

route('DELETE', '/api/suppliers/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const id = int(p.id);
  const s = await env.DB.prepare(`SELECT ${SUPPLIER_STATS.replace(/s\.id/g, '?')}`).bind(id, id, id, id, id).first();
  if (s.items_stock > 0 || s.balance > 0.0005) throw new HttpError(400, 'Impossible : ce fournisseur a encore des articles en stock ou un solde à reverser');
  await env.DB.prepare(`UPDATE suppliers SET active = 0 WHERE id = ?`).bind(id).run();
  return json({ ok: true });
});

// ---------- dépôts (bons de dépôt)
route('GET', '/api/deposits', async (req, env) => {
  const { results } = await env.DB.prepare(
    `SELECT d.*, s.name AS supplier_name, (SELECT COUNT(*) FROM items i WHERE i.deposit_id = d.id) AS n,
     (SELECT COALESCE(SUM(price),0) FROM items i WHERE i.deposit_id = d.id) AS value
     FROM deposits d JOIN suppliers s ON s.id = d.supplier_id ORDER BY d.id DESC LIMIT 200`
  ).all();
  return json(results);
});

route('GET', '/api/deposits/:id', async (req, env, ctx, p) => {
  const id = int(p.id);
  const d = await env.DB.prepare(`SELECT d.*, s.name AS supplier_name, s.phone AS supplier_phone, s.cin AS supplier_cin, s.code AS supplier_code FROM deposits d JOIN suppliers s ON s.id = d.supplier_id WHERE d.id = ?`).bind(id).first();
  if (!d) throw new HttpError(404, 'Dépôt introuvable');
  const settings = await getSettings(env);
  const { results } = await env.DB.prepare(`${ITEM_SELECT} WHERE i.deposit_id = ? ORDER BY i.id`).bind(id).all();
  return json({ deposit: d, items: results.map((i) => decorateItem(i, settings)) });
});

route('POST', '/api/deposits', async (req, env, ctx) => {
  const b = await req.json();
  const supplierId = int(b.supplier_id);
  const sup = await env.DB.prepare(`SELECT id FROM suppliers WHERE id = ? AND active = 1`).bind(supplierId).first();
  if (!sup) throw new HttpError(400, 'Fournisseur invalide');
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length) throw new HttpError(400, 'Ajoutez au moins un article');
  if (lines.length > 200) throw new HttpError(400, 'Maximum 200 articles par dépôt');
  const clean = [];
  for (const l of lines) {
    const title = str(l.title, 120);
    const price = num(l.price, null);
    if (!title) throw new HttpError(400, 'Chaque article doit avoir une désignation');
    if (price === null || price <= 0) throw new HttpError(400, `Prix invalide pour « ${title} »`);
    const qty = Math.min(50, Math.max(1, Math.round(num(l.qty, 1))));
    for (let k = 0; k < qty; k++) clean.push({ ...l, title, price: r3(price) });
  }
  if (clean.length > 200) throw new HttpError(400, 'Maximum 200 articles par dépôt');
  const settings = await getSettings(env);
  const prefix = settings.code_prefix || 'GS';
  const dseq = await nextSeq(env, 'seq_deposit');
  const number = 'D' + String(dseq).padStart(5, '0');
  const t = nowIso();
  const dep = await env.DB.prepare(`INSERT INTO deposits (number, supplier_id, user_id, notes, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .bind(number, supplierId, ctx.user.id, str(b.notes, 1000), t).first();
  // réserve un bloc de codes en une seule requête
  const row = await env.DB.prepare(`UPDATE settings SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'seq_item' RETURNING value`).bind(clean.length).first();
  const last = Number(row.value);
  const first = last - clean.length + 1;
  const COLS = 13;
  const chunk = Math.floor(90 / COLS);
  const stmts = [];
  for (let i = 0; i < clean.length; i += chunk) {
    const part = clean.slice(i, i + chunk);
    const args = [];
    part.forEach((l, j) => {
      const code = prefix + String(first + i + j).padStart(6, '0');
      args.push(code, dep.id, supplierId, l.category_id ? Number(l.category_id) || null : null, l.title, str(l.brand, 60), str(l.size, 30), str(l.color, 30), str(l.condition, 30), str(l.description, 500), l.price, num(l.rate_override, null), str(l.location, 40));
    });
    stmts.push(env.DB.prepare(
      `INSERT INTO items (code, deposit_id, supplier_id, category_id, title, brand, size, color, condition, description, price, rate_override, location, created_at) VALUES ${part.map(() => `(${Array(COLS).fill('?').join(',')}, '${t}')`).join(',')}`
    ).bind(...args));
  }
  stmts.push(env.DB.prepare(`INSERT INTO movements (item_id, type, note, user_id, created_at) SELECT id, 'depot', ?, ?, ? FROM items WHERE deposit_id = ?`).bind('Bon ' + number, ctx.user.id, t, dep.id));
  await env.DB.batch(stmts);
  return json({ ok: true, id: dep.id, number });
});

// ---------- articles
route('GET', '/api/items', async (req, env) => {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const settings = await getSettings(env);
  const where = [];
  const args = [];
  const status = sp.get('status');
  if (status === 'stock') where.push(`i.status IN ${SELLABLE}`);
  else if (['en_vente', 'reserve', 'vendu', 'retourne', 'perdu'].includes(status)) {
    where.push(`i.status = ?`);
    args.push(status);
  }
  if (sp.get('supplier_id')) { where.push(`i.supplier_id = ?`); args.push(int(sp.get('supplier_id'))); }
  if (sp.get('category_id')) { where.push(`i.category_id = ?`); args.push(int(sp.get('category_id'))); }
  const q = str(sp.get('q'), 60);
  if (q) {
    where.push(`(i.code LIKE ? OR i.title LIKE ? OR i.brand LIKE ? OR s.name LIKE ? OR i.location LIKE ?)`);
    for (let k = 0; k < 5; k++) args.push(`%${q}%`);
  }
  const alert = sp.get('alert');
  const days = num(settings.deposit_days, 90);
  if (alert === 'expired') {
    where.push(`i.status IN ${SELLABLE} AND i.created_at <= ?`);
    args.push(new Date(Date.now() - days * 86400000).toISOString());
  } else if (alert === 'dormant') {
    where.push(`i.status IN ${SELLABLE} AND i.created_at <= ?`);
    args.push(new Date(Date.now() - 30 * 86400000).toISOString());
  }
  const limit = Math.min(500, Math.max(1, Math.round(num(sp.get('limit'), 200))));
  const sql = `${ITEM_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json(results.map((i) => decorateItem(i, settings)));
});

async function loadItem(env, where, arg) {
  const settings = await getSettings(env);
  const it = await env.DB.prepare(`${ITEM_SELECT} WHERE ${where}`).bind(arg).first();
  if (!it) throw new HttpError(404, 'Article introuvable');
  return decorateItem(it, settings);
}

function extractCode(raw) {
  let s = String(raw || '').trim();
  const m = s.match(/#\/a\/([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  return s.toUpperCase();
}

route('GET', '/api/items/by-code/:code', async (req, env, ctx, p) => {
  return json(await loadItem(env, `i.code = ?`, extractCode(decodeURIComponent(p.code))));
});

route('GET', '/api/items/:id', async (req, env, ctx, p) => {
  const item = await loadItem(env, `i.id = ?`, int(p.id));
  const [moves, line] = await env.DB.batch([
    env.DB.prepare(`SELECT m.*, u.name AS user_name FROM movements m LEFT JOIN users u ON u.id = m.user_id WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 50`).bind(item.id),
    env.DB.prepare(`SELECT l.*, v.number AS sale_number, v.created_at AS sale_date, v.payment_method FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status = 'ok' WHERE l.item_id = ? ORDER BY l.id DESC LIMIT 1`).bind(item.id),
  ]);
  return json({ item, moves: moves.results, sale: line.results[0] || null });
});

route('PUT', '/api/items/:id', async (req, env, ctx, p) => {
  const id = int(p.id);
  const b = await req.json();
  const cur = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  if (!cur) throw new HttpError(404, 'Article introuvable');
  const title = str(b.title, 120) || cur.title;
  const price = num(b.price, cur.price);
  if (price <= 0) throw new HttpError(400, 'Prix invalide');
  if (cur.status === 'vendu' && price !== cur.price) throw new HttpError(400, 'Article déjà vendu : prix non modifiable');
  const isAdmin = ctx.user.role === 'admin';
  const rate = isAdmin && 'rate_override' in b ? num(b.rate_override, null) : cur.rate_override;
  const noMd = isAdmin && 'no_markdown' in b ? (b.no_markdown ? 1 : 0) : cur.no_markdown;
  await env.DB.prepare(
    `UPDATE items SET title=?, brand=?, size=?, color=?, condition=?, description=?, price=?, category_id=?, location=?, rate_override=?, no_markdown=? WHERE id = ?`
  ).bind(title, str(b.brand, 60), str(b.size, 30), str(b.color, 30), str(b.condition, 30), str(b.description, 500), r3(price),
    b.category_id ? Number(b.category_id) || null : null, str(b.location, 40), rate, noMd, id).run();
  const note = price !== cur.price ? `Prix ${cur.price} → ${r3(price)}` : 'Fiche modifiée';
  await logMoves(env, [{ item_id: id, type: 'modif', note, user_id: ctx.user.id }]);
  return json({ ok: true });
});

const STATUS_TRANSITIONS = {
  en_vente: ['reserve', 'retourne', 'perdu'],
  reserve: ['en_vente', 'retourne', 'perdu'],
  retourne: ['en_vente'],
  perdu: ['en_vente'],
};
const STATUS_LABEL = { en_vente: 'Remis en vente', reserve: 'Réservé', retourne: 'Rendu au fournisseur', perdu: 'Déclaré perdu' };

route('POST', '/api/items/status', async (req, env, ctx) => {
  const b = await req.json();
  const to = b.status;
  if (!STATUS_LABEL[to]) throw new HttpError(400, 'Statut invalide');
  if (to === 'perdu') requireAdmin(ctx.user);
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(int).slice(0, 300);
  if (!ids.length) throw new HttpError(400, 'Aucun article sélectionné');
  const from = Object.entries(STATUS_TRANSITIONS).filter(([, tos]) => tos.includes(to)).map(([f]) => `'${f}'`).join(',');
  const t = nowIso();
  const reservedFor = to === 'reserve' ? str(b.note, 100) : null;
  const res = await env.DB.prepare(
    `UPDATE items SET status = ?, reserved_for = ?, closed_at = ? WHERE id IN (${ids.join(',')}) AND status IN (${from}) RETURNING id`
  ).bind(to, reservedFor, ['retourne', 'perdu'].includes(to) ? t : null).all();
  const changed = res.results.map((r) => r.id);
  await logMoves(env, changed.map((id) => ({ item_id: id, type: to, note: str(b.note, 200) || STATUS_LABEL[to], user_id: ctx.user.id })));
  return json({ ok: true, changed: changed.length, skipped: ids.length - changed.length });
});

route('DELETE', '/api/items/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const id = int(p.id);
  const cur = await env.DB.prepare(`SELECT status FROM items WHERE id = ?`).bind(id).first();
  if (!cur) throw new HttpError(404, 'Article introuvable');
  if (cur.status === 'vendu') throw new HttpError(400, 'Un article vendu ne peut pas être supprimé (annulez la vente d’abord)');
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM movements WHERE item_id = ?`).bind(id),
  ]);
  if (env.PHOTOS) await env.PHOTOS.delete('photo:' + id);
  return json({ ok: true });
});

// ---------- photos (KV)
route('PUT', '/api/items/:id/photo', async (req, env, ctx, p) => {
  if (!env.PHOTOS) throw new HttpError(501, 'Stockage photo non configuré');
  const id = int(p.id);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > 1_500_000) throw new HttpError(400, 'Photo trop lourde (max 1,5 Mo)');
  await env.PHOTOS.put('photo:' + id, buf, { metadata: { type: req.headers.get('content-type') || 'image/jpeg' } });
  await env.DB.prepare(`UPDATE items SET has_photo = has_photo + 1 WHERE id = ?`).bind(id).run();
  return json({ ok: true });
});

route('GET', '/api/photo/:id', async (req, env, ctx, p) => {
  if (!env.PHOTOS) return new Response('', { status: 404 });
  const { value, metadata } = await env.PHOTOS.getWithMetadata('photo:' + int(p.id), { type: 'arrayBuffer' });
  if (!value) return new Response('', { status: 404 });
  return new Response(value, { headers: { 'content-type': metadata?.type || 'image/jpeg', 'cache-control': 'private, max-age=604800' } });
});

// ---------- caisse / ventes
route('POST', '/api/sales/preview', async (req, env) => {
  const b = await req.json();
  return json(await priceCart(env, b));
});

async function priceCart(env, b) {
  const codes = [...new Set((Array.isArray(b.items) ? b.items : []).map((x) => extractCode(x.code)).filter(Boolean))].slice(0, 100);
  if (!codes.length) throw new HttpError(400, 'Panier vide');
  const settings = await getSettings(env);
  const { results } = await env.DB.prepare(`${ITEM_SELECT} WHERE i.code IN (${codes.map(() => '?').join(',')})`).bind(...codes).all();
  const byCode = Object.fromEntries(results.map((r) => [r.code, r]));
  const lineDisc = Object.fromEntries((b.items || []).map((x) => [extractCode(x.code), Math.max(0, num(x.discount, 0))]));
  const problems = [];
  const lines = [];
  for (const c of codes) {
    const it = byCode[c];
    if (!it) { problems.push({ code: c, error: 'Code inconnu' }); continue; }
    if (!['en_vente', 'reserve'].includes(it.status)) { problems.push({ code: c, error: `Article non disponible (${it.status})` }); continue; }
    const d = decorateItem(it, settings);
    const disc = Math.min(lineDisc[c] || 0, d.current_price);
    lines.push({ item: d, unit_price: d.current_price, discount: r3(disc), price: r3(d.current_price - disc) });
  }
  const subtotal = r3(lines.reduce((a, l) => a + l.price, 0));
  const globalDisc = Math.min(Math.max(0, num(b.discount, 0)), subtotal);
  // répartition proportionnelle de la remise globale
  let remaining = globalDisc;
  lines.forEach((l, idx) => {
    const share = idx === lines.length - 1 ? remaining : r3(subtotal > 0 ? (globalDisc * l.price) / subtotal : 0);
    remaining = r3(remaining - share);
    l.final_price = r3(l.price - share);
    l.discount = r3(l.discount + share);
    l.shop_amount = r3((l.final_price * l.item.rate) / 100);
    l.supplier_amount = r3(l.final_price - l.shop_amount);
  });
  const total = r3(lines.reduce((a, l) => a + l.final_price, 0));
  return { lines, problems, subtotal, discount: r3(globalDisc), total, shop_total: r3(lines.reduce((a, l) => a + l.shop_amount, 0)) };
}

route('POST', '/api/sales', async (req, env, ctx) => {
  const b = await req.json();
  const cart = await priceCart(env, b);
  if (cart.problems.length) throw new HttpError(409, 'Certains articles ne sont pas disponibles', { problems: cart.problems });
  const method = ['especes', 'carte', 'd17', 'flouci', 'virement', 'cheque', 'mixte', 'autre'].includes(b.payment_method) ? b.payment_method : 'especes';
  const id = crypto.randomUUID();
  const seq = await nextSeq(env, 'seq_sale');
  const number = 'V' + String(seq).padStart(6, '0');
  const t = nowIso();
  const ids = cart.lines.map((l) => Number(l.item.id));
  const lit = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) throw new HttpError(500, 'Valeur numérique invalide');
    return String(v);
  };
  const values = cart.lines
    .map((l) => `(${[l.item.id, l.item.supplier_id, l.item.price, l.unit_price, l.discount, l.final_price, l.item.rate, l.shop_amount, l.supplier_amount].map(lit).join(',')})`)
    .join(',');
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO sales (id, number, user_id, created_at, subtotal, discount, total, shop_total, payment_method, customer, customer_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, number, ctx.user.id, t, cart.subtotal, cart.discount, cart.total, cart.shop_total, method, str(b.customer, 80), str(b.customer_phone, 30)),
    env.DB.prepare(`UPDATE items SET status = 'vendu', sale_id = ?, sold_at = ?, reserved_for = NULL WHERE id IN (${ids.join(',')}) AND status IN ${SELLABLE}`).bind(id, t),
    env.DB.prepare(
      `INSERT INTO sale_lines (sale_id, item_id, supplier_id, base_price, unit_price, discount, final_price, rate, shop_amount, supplier_amount)
       SELECT ?, v.column1, v.column2, v.column3, v.column4, v.column5, v.column6, v.column7, v.column8, v.column9 FROM (VALUES ${values}) AS v
       WHERE EXISTS (SELECT 1 FROM items i WHERE i.id = v.column1 AND i.sale_id = ?)`
    ).bind(id, id),
    env.DB.prepare(`INSERT INTO movements (item_id, type, note, user_id, created_at) SELECT id, 'vente', ?, ?, ? FROM items WHERE sale_id = ?`).bind('Vente ' + number, ctx.user.id, t, id),
  ]);
  const updated = results[1].meta?.changes ?? 0;
  if (updated !== ids.length) {
    // un autre appareil a vendu un article entre-temps : on annule proprement
    await env.DB.batch([
      env.DB.prepare(`UPDATE items SET status = 'en_vente', sale_id = NULL, sold_at = NULL WHERE sale_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM movements WHERE note = ? AND created_at = ?`).bind('Vente ' + number, t),
      env.DB.prepare(`DELETE FROM sale_lines WHERE sale_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM sales WHERE id = ?`).bind(id),
    ]);
    throw new HttpError(409, 'Un article vient d’être vendu sur un autre appareil. Vérifiez le panier.');
  }
  return json({ ok: true, id, number });
});

route('GET', '/api/sales', async (req, env, ctx) => {
  const sp = new URL(req.url).searchParams;
  const settings = await getSettings(env);
  const tz = num(settings.tz_offset, 1);
  const from = sp.get('from');
  const to = sp.get('to');
  const where = [];
  const args = [];
  const off = `'${tz >= 0 ? '+' : ''}${tz} hours'`;
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push(`date(v.created_at, ${off}) >= ?`); args.push(from); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push(`date(v.created_at, ${off}) <= ?`); args.push(to); }
  const { results } = await env.DB.prepare(
    `SELECT v.*, u.name AS user_name, (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_id = v.id) AS n FROM sales v LEFT JOIN users u ON u.id = v.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.created_at DESC LIMIT 500`
  ).bind(...args).all();
  if (ctx.user.role !== 'admin') results.forEach((r) => delete r.shop_total);
  return json(results);
});

route('GET', '/api/sales/:id', async (req, env, ctx, p) => {
  const v = await env.DB.prepare(`SELECT v.*, u.name AS user_name FROM sales v LEFT JOIN users u ON u.id = v.user_id WHERE v.id = ?`).bind(p.id).first();
  if (!v) throw new HttpError(404, 'Vente introuvable');
  const { results } = await env.DB.prepare(
    `SELECT l.*, i.code, i.title, i.size, i.brand, s.name AS supplier_name, s.phone AS supplier_phone FROM sale_lines l JOIN items i ON i.id = l.item_id JOIN suppliers s ON s.id = l.supplier_id WHERE l.sale_id = ? ORDER BY l.id`
  ).bind(p.id).all();
  if (ctx.user.role !== 'admin') {
    delete v.shop_total;
    results.forEach((r) => { delete r.shop_amount; delete r.rate; });
  }
  return json({ sale: v, lines: results });
});

route('POST', '/api/sales/:id/cancel', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const b = await req.json().catch(() => ({}));
  const v = await env.DB.prepare(`SELECT * FROM sales WHERE id = ?`).bind(p.id).first();
  if (!v) throw new HttpError(404, 'Vente introuvable');
  if (v.status !== 'ok') throw new HttpError(400, 'Vente déjà annulée');
  const paid = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sale_lines WHERE sale_id = ? AND payout_id IS NOT NULL`).bind(p.id).first();
  if (paid.n > 0) throw new HttpError(400, 'Impossible : un fournisseur a déjà été payé pour cette vente');
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE sales SET status = 'annulee', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND status = 'ok'`).bind(t, str(b.reason, 200), p.id),
    env.DB.prepare(`INSERT INTO movements (item_id, type, note, user_id, created_at) SELECT id, 'annulation', ?, ?, ? FROM items WHERE sale_id = ?`).bind('Annulation vente ' + v.number, ctx.user.id, t, p.id),
    env.DB.prepare(`UPDATE items SET status = 'en_vente', sale_id = NULL, sold_at = NULL WHERE sale_id = ?`).bind(p.id),
  ]);
  return json({ ok: true });
});

// ---------- reversements fournisseurs
route('POST', '/api/payouts', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const b = await req.json();
  const supplierId = int(b.supplier_id);
  const bal = await env.DB.prepare(
    `SELECT COALESCE(SUM(l.supplier_amount),0) AS amount, COUNT(*) AS n FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status = 'ok' WHERE l.supplier_id = ? AND l.payout_id IS NULL`
  ).bind(supplierId).first();
  if (!bal.n || bal.amount <= 0) throw new HttpError(400, 'Aucun montant à reverser');
  const id = crypto.randomUUID();
  const seq = await nextSeq(env, 'seq_payout');
  const number = 'R' + String(seq).padStart(5, '0');
  const method = ['especes', 'virement', 'd17', 'flouci', 'cheque', 'autre'].includes(b.method) ? b.method : 'especes';
  await env.DB.batch([
    env.DB.prepare(`UPDATE sale_lines SET payout_id = ? WHERE supplier_id = ? AND payout_id IS NULL AND sale_id IN (SELECT id FROM sales WHERE status = 'ok')`).bind(id, supplierId),
    env.DB.prepare(
      `INSERT INTO payouts (id, number, supplier_id, amount, method, reference, notes, user_id, created_at)
       SELECT ?, ?, ?, ROUND(COALESCE(SUM(supplier_amount),0), 3), ?, ?, ?, ?, ? FROM sale_lines WHERE payout_id = ?`
    ).bind(id, number, supplierId, method, str(b.reference, 80), str(b.notes, 300), ctx.user.id, nowIso(), id),
  ]);
  return json({ ok: true, id, number });
});

route('GET', '/api/payouts', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const { results } = await env.DB.prepare(`SELECT p.*, s.name AS supplier_name FROM payouts p JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.created_at DESC LIMIT 300`).all();
  return json(results);
});

route('GET', '/api/payouts/:id', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const po = await env.DB.prepare(`SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, s.rib AS supplier_rib, s.code AS supplier_code FROM payouts p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`).bind(p.id).first();
  if (!po) throw new HttpError(404, 'Reversement introuvable');
  const { results } = await env.DB.prepare(
    `SELECT l.*, i.code, i.title, v.number AS sale_number, v.created_at AS sale_date FROM sale_lines l JOIN items i ON i.id = l.item_id JOIN sales v ON v.id = l.sale_id WHERE l.payout_id = ? ORDER BY v.created_at`
  ).bind(p.id).all();
  return json({ payout: po, lines: results });
});

// ---------- inventaire
route('POST', '/api/inventory', async (req, env, ctx) => {
  const b = await req.json();
  const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map(extractCode).filter(Boolean))].slice(0, 5000);
  const { results: stock } = await env.DB.prepare(`SELECT i.id, i.code, i.title, i.location, i.status, s.name AS supplier_name FROM items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.status IN ${SELLABLE}`).all();
  const scanned = new Set(codes);
  const stockCodes = new Set(stock.map((s) => s.code));
  const missing = stock.filter((s) => !scanned.has(s.code));
  const extraCodes = codes.filter((c) => !stockCodes.has(c));
  let unexpected = [];
  for (let i = 0; i < extraCodes.length; i += 80) {
    const part = extraCodes.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT id, code, title, status FROM items WHERE code IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    const known = new Set(results.map((r) => r.code));
    unexpected = unexpected.concat(results, part.filter((c) => !known.has(c)).map((c) => ({ code: c, title: 'Code inconnu', status: 'inconnu' })));
    if (i > 400) break;
  }
  const found = stock.length - missing.length;
  const data = { missing: missing.map((m) => m.code), unexpected: unexpected.map((u) => u.code) };
  const inv = await env.DB.prepare(`INSERT INTO inventories (user_id, created_at, scanned, found, missing, unexpected, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(ctx.user.id, nowIso(), codes.length, found, missing.length, unexpected.length, JSON.stringify(data)).first();
  return json({ id: inv.id, expected: stock.length, scanned: codes.length, found, missing, unexpected });
});

route('GET', '/api/inventory', async (req, env) => {
  const { results } = await env.DB.prepare(`SELECT v.id, v.created_at, v.scanned, v.found, v.missing, v.unexpected, u.name AS user_name FROM inventories v LEFT JOIN users u ON u.id = v.user_id ORDER BY v.id DESC LIMIT 50`).all();
  return json(results);
});

// ---------- tableau de bord
route('GET', '/api/dashboard', async (req, env, ctx) => {
  const settings = await getSettings(env);
  const tz = num(settings.tz_offset, 1);
  const off = `'${tz >= 0 ? '+' : ''}${tz} hours'`;
  const local = new Date(Date.now() + tz * 3600000);
  const today = local.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const d7 = new Date(local.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const days = num(settings.deposit_days, 90);
  const expBefore = new Date(Date.now() - days * 86400000).toISOString();
  const dormBefore = new Date(Date.now() - 30 * 86400000).toISOString();
  const [todayR, monthR, daily, stock, alerts, dues, topSup, topCat, recent] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(shop_total),0) AS margin FROM sales WHERE status='ok' AND date(created_at, ${off}) = ?`).bind(today),
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(shop_total),0) AS margin FROM sales WHERE status='ok' AND strftime('%Y-%m', created_at, ${off}) = ?`).bind(month),
    env.DB.prepare(`SELECT date(created_at, ${off}) AS d, COALESCE(SUM(total),0) AS total, COALESCE(SUM(shop_total),0) AS margin FROM sales WHERE status='ok' AND date(created_at, ${off}) >= ? GROUP BY d ORDER BY d`).bind(d7),
    env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(price),0) AS value FROM items WHERE status IN ${SELLABLE}`),
    env.DB.prepare(`SELECT SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END) AS expired, SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END) AS dormant, SUM(CASE WHEN status='reserve' THEN 1 ELSE 0 END) AS reserved FROM items WHERE status IN ${SELLABLE}`).bind(expBefore, dormBefore),
    env.DB.prepare(`SELECT COALESCE(SUM(l.supplier_amount),0) AS amount, COUNT(DISTINCT l.supplier_id) AS suppliers FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status='ok' WHERE l.payout_id IS NULL`),
    env.DB.prepare(`SELECT s.id, s.name, COUNT(*) AS n, SUM(l.final_price) AS total FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status='ok' JOIN suppliers s ON s.id = l.supplier_id WHERE strftime('%Y-%m', v.created_at, ${off}) = ? GROUP BY s.id ORDER BY total DESC LIMIT 5`).bind(month),
    env.DB.prepare(`SELECT COALESCE(c.name, 'Sans catégorie') AS name, COUNT(*) AS n, SUM(l.final_price) AS total FROM sale_lines l JOIN sales v ON v.id = l.sale_id AND v.status='ok' JOIN items i ON i.id = l.item_id LEFT JOIN categories c ON c.id = i.category_id WHERE strftime('%Y-%m', v.created_at, ${off}) = ? GROUP BY c.id ORDER BY total DESC LIMIT 6`).bind(month),
    env.DB.prepare(`SELECT id, number, total, created_at, payment_method FROM sales WHERE status='ok' ORDER BY created_at DESC LIMIT 6`),
  ]);
  const isAdmin = ctx.user.role === 'admin';
  const series = [];
  const map = Object.fromEntries(daily.results.map((r) => [r.d, r]));
  for (let k = 6; k >= 0; k--) {
    const d = new Date(local.getTime() - k * 86400000).toISOString().slice(0, 10);
    series.push({ d, total: r3(map[d]?.total || 0), margin: isAdmin ? r3(map[d]?.margin || 0) : null });
  }
  const a = alerts.results[0] || {};
  return json({
    today: { n: todayR.results[0].n, total: r3(todayR.results[0].total), margin: isAdmin ? r3(todayR.results[0].margin) : null },
    month: { n: monthR.results[0].n, total: r3(monthR.results[0].total), margin: isAdmin ? r3(monthR.results[0].margin) : null },
    series,
    stock: { n: stock.results[0].n, value: r3(stock.results[0].value) },
    alerts: { expired: a.expired || 0, dormant: a.dormant || 0, reserved: a.reserved || 0 },
    dues: isAdmin ? { amount: r3(dues.results[0].amount), suppliers: dues.results[0].suppliers } : null,
    top_suppliers: topSup.results,
    top_categories: topCat.results,
    recent: recent.results,
  });
});

// ---------- exports & sauvegarde
const EXPORTS = {
  articles: `SELECT i.code, i.title AS designation, c.name AS categorie, i.brand AS marque, i.size AS taille, i.color AS couleur, i.condition AS etat, i.price AS prix_initial, i.status AS statut, i.location AS emplacement, s.code AS code_fournisseur, s.name AS fournisseur, i.created_at AS date_depot, i.sold_at AS date_vente FROM items i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN categories c ON c.id = i.category_id ORDER BY i.id`,
  ventes: `SELECT v.number AS numero, v.created_at AS date, v.subtotal AS sous_total, v.discount AS remise, v.total, v.shop_total AS marge_depot, v.payment_method AS paiement, v.customer AS client, v.status AS statut FROM sales v ORDER BY v.created_at`,
  lignes: `SELECT v.number AS vente, v.created_at AS date, v.status AS statut_vente, i.code, i.title AS designation, s.name AS fournisseur, l.base_price AS prix_initial, l.unit_price AS prix_affiche, l.discount AS remise, l.final_price AS prix_vendu, l.rate AS taux, l.shop_amount AS part_depot, l.supplier_amount AS part_fournisseur, p.number AS reversement FROM sale_lines l JOIN sales v ON v.id = l.sale_id JOIN items i ON i.id = l.item_id JOIN suppliers s ON s.id = l.supplier_id LEFT JOIN payouts p ON p.id = l.payout_id ORDER BY v.created_at`,
  fournisseurs: `SELECT code, name AS nom, phone AS telephone, cin, address AS adresse, rib, payout_method AS mode_reversement, rate AS taux_negocie, notes, created_at AS date_creation FROM suppliers WHERE active = 1 ORDER BY name`,
  reversements: `SELECT p.number AS numero, p.created_at AS date, s.name AS fournisseur, p.amount AS montant, p.method AS mode, p.reference FROM payouts p JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.created_at`,
};

route('GET', '/api/export/:name', async (req, env, ctx, p) => {
  requireAdmin(ctx.user);
  const name = p.name.replace(/\.csv$/, '');
  if (!EXPORTS[name]) throw new HttpError(404, 'Export inconnu');
  const { results } = await env.DB.prepare(EXPORTS[name]).all();
  return csv(results, `${name}-${new Date().toISOString().slice(0, 10)}.csv`);
});

route('GET', '/api/backup', async (req, env, ctx) => {
  requireAdmin(ctx.user);
  const tables = ['settings', 'categories', 'suppliers', 'deposits', 'items', 'sales', 'sale_lines', 'payouts', 'movements', 'inventories'];
  const res = await env.DB.batch(tables.map((t) => env.DB.prepare(`SELECT * FROM ${t}`)));
  const out = { app: 'golsh-depot', version: SCHEMA_VERSION, exported_at: nowIso(), tables: {} };
  tables.forEach((t, i) => (out.tables[t] = res[i].results));
  return new Response(JSON.stringify(out), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="sauvegarde-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' },
  });
});

// ---------------------------------------------------------------- entrée
async function handleApi(req, env) {
  const url = new URL(req.url);
  await ensureSchema(env);
  // protection CSRF : en-tête personnalisé obligatoire pour les écritures
  if (req.method !== 'GET' && req.headers.get('x-app') !== '1') throw new HttpError(403, 'Requête refusée');
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    const user = await currentUser(req, env);
    if (!r.opts.public && !user) throw new HttpError(401, 'Session expirée, reconnectez-vous');
    return await r.handler(req, env, { user }, params);
  }
  throw new HttpError(404, 'Route inconnue');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
        if (e instanceof SyntaxError) return json({ error: 'Données invalides' }, 400);
        console.error(e);
        return json({ error: 'Erreur serveur : ' + (e.message || 'inconnue') }, 500);
      }
    }
    // tout le reste : application (fichiers statiques)
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },
};

// exporté pour les tests
export const _internals = { currentPrice, resolveRate, extractCode };
