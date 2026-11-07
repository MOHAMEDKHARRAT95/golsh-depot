// Serveur local pour tester l'application sans Cloudflare : node test/dev-server.mjs
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/worker.js';
import { makeD1, makeKV, makeAssets } from './local-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { DB: makeD1(process.env.DB_FILE || ':memory:'), PHOTOS: makeKV(), ASSETS: makeAssets(join(root, 'public')) };
const port = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  try {
    const r = await worker.fetch(request, env);
    const headers = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e));
  }
}).listen(port, () => console.log(`http://localhost:${port}`));
