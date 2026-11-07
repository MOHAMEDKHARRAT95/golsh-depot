// Environnement local qui imite Cloudflare (D1 = SQLite, KV = Map, ASSETS = dossier public)
// Sert uniquement aux tests : n'est pas déployé.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

export let queryCount = 0;
export const resetQueryCount = () => { const n = queryCount; queryCount = 0; return n; };

const clean = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));

export function makeD1(path = ':memory:') {
  const db = new DatabaseSync(path);
  const changes = () => db.prepare('SELECT changes() AS c').get().c;
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) {
      const placeholders = (this.sql.match(/\?/g) || []).length;
      if (a.length > 100) throw new Error(`D1: trop de paramètres (${a.length}) : ${this.sql.slice(0, 80)}`);
      if (placeholders !== a.length) throw new Error(`Bind mismatch ${placeholders} vs ${a.length}: ${this.sql.slice(0, 120)}`);
      return new Stmt(this.sql, a);
    }
    _exec() {
      queryCount++;
      const st = db.prepare(this.sql);
      const rows = st.all(...clean(this.args)).map((r) => ({ ...r }));
      return { results: rows, success: true, meta: { changes: changes() } };
    }
    async first(col) { const r = this._exec().results[0]; return r ? (col ? r[col] : r) : null; }
    async all() { return this._exec(); }
    async run() { return this._exec(); }
  }
  return {
    _db: db,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
  };
}

export function makeKV() {
  const m = new Map();
  return {
    async put(k, v, opts) { m.set(k, { v: v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer(), meta: opts?.metadata }); },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v, metadata: e.meta } : { value: null, metadata: null }; },
    async delete(k) { m.delete(k); },
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function makeAssets(dir) {
  return {
    async fetch(req) {
      let p = new URL(req.url).pathname;
      if (p === '/') p = '/index.html';
      try {
        const buf = await readFile(join(dir, p));
        return new Response(buf, { headers: { 'content-type': TYPES[extname(p)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}
