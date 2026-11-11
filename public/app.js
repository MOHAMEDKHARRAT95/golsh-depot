/* =====================================================================
   Golsh Dépôt-Vente — application (PWA) : iPhone, Android, PC
   ===================================================================== */
'use strict';

// ------------------------------------------------------------------ outils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem('gs_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gs_' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const isTouch = matchMedia('(pointer: coarse)').matches;
const S = { user: null, status: null, settings: null, cats: [] };

const PAY = { especes: 'Espèces', carte: 'Carte', d17: 'D17', flouci: 'Flouci', virement: 'Virement', cheque: 'Chèque', mixte: 'Mixte', autre: 'Autre' };
const STATUS = { en_vente: 'En vente', reserve: 'Réservé', vendu: 'Vendu', retourne: 'Rendu', perdu: 'Perdu' };
const CONDITIONS = ['Neuf avec étiquette', 'Neuf sans étiquette', 'Très bon état', 'Bon état', 'État correct'];

function cur() { return S.settings?.currency || S.status?.currency || 'DT'; }
function money(n, withCur = true) {
  const v = Number(n) || 0;
  const whole = Math.abs(v - Math.round(v)) < 0.0005;
  const s = v.toLocaleString('fr-FR', { minimumFractionDigits: whole ? 0 : 3, maximumFractionDigits: whole ? 0 : 3 });
  return withCur ? `${s} ${cur()}` : s;
}
function fdate(iso, time = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const o = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (time) Object.assign(o, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('fr-FR', o);
}
function localDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const isAdmin = () => S.user?.role === 'admin' || S.user?.role === 'superadmin';
const isSuper = () => S.user?.role === 'superadmin';
const ROLE_LABEL = { caissier: 'Caissier', admin: 'Administrateur', superadmin: 'Super admin' };
const roleLabel = () => ROLE_LABEL[S.user?.role] || '';
const normCode = (raw) => {
  let s = String(raw || '').trim();
  const m = s.match(/#\/a\/([A-Za-z0-9-]+)/);
  if (m) s = m[1];
  return s.toUpperCase();
};
function phoneIntl(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 8) d = '216' + d;
  return d;
}
function waLink(phone, text) {
  const p = phoneIntl(phone);
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function qs() {
  const h = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(h));
}

// ------------------------------------------------------------------ API
async function api(method, path, body) {
  const opt = { method, headers: { 'x-app': '1' }, credentials: 'same-origin' };
  if (body instanceof Blob) { opt.body = body; opt.headers['content-type'] = body.type || 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, opt); }
  catch { throw Object.assign(new Error('Pas de connexion internet. Réessayez.'), { status: 0 }); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !['/api/login', '/api/me/password'].includes(path)) {
    S.user = null;
    renderAuth();
    throw Object.assign(new Error(data.error || 'Session expirée'), { status: 401, silent: true });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'Erreur ' + res.status), { status: res.status, data });
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b ?? {});
const PUT = (p, b) => api('PUT', p, b ?? {});
const DEL = (p) => api('DELETE', p);

// ------------------------------------------------------------------ UI : toasts, modales
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'bad' ? 4500 : 2600);
}
function fail(e) { if (!e?.silent) toast(e?.message || 'Erreur', 'bad'); }

function modal(title, html, { onClose, wide } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" ${wide ? 'style="max-width:760px"' : ''}><div class="mh"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Fermer">✕</button></div><div class="mb">${html}</div></div>`;
  document.body.appendChild(bg);
  document.body.style.overflow = 'hidden';
  const m = { el: $('.modal', bg), closed: false };
  m.close = () => {
    if (m.closed) return;
    m.closed = true;
    bg.remove();
    if (!$('.modal-bg')) document.body.style.overflow = '';
    onClose && onClose();
  };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) m.close(); });
  return m;
}
function confirmDlg(msg, { ok = 'Confirmer', danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Confirmation', `<p>${esc(msg)}</p>${input ? `<label class="f"><span>${esc(input)}</span><input id="cf-in"></label>` : ''}
      <div class="btns" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-close>Annuler</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(ok)}</button></div>`,
    { onClose: () => { if (!done) resolve(false); } });
    $('#cf-ok', m.el).onclick = () => { done = true; const v = input ? $('#cf-in', m.el).value : true; m.close(); resolve(input ? { value: v } : v); };
  });
}
function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    o[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}
async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.t = btn.innerHTML; btn.innerHTML = '…'; }
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.t; } }
}

function beep() {
  try {
    const ac = beep.ac || (beep.ac = new (window.AudioContext || window.webkitAudioContext)());
    const o = ac.createOscillator(); const g = ac.createGain();
    o.frequency.value = 1150; g.gain.value = 0.08;
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.09);
  } catch { /* son indisponible */ }
  navigator.vibrate?.(40);
}

// ------------------------------------------------------------------ scanner (caméra)
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Chargement impossible'));
    document.head.appendChild(s);
  });
}
async function ensureHtml5Qrcode() {
  if (window.Html5Qrcode) return;
  const urls = ['https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js', 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js'];
  for (const u of urls) { try { await loadScript(u); if (window.Html5Qrcode) return; } catch { /* essai suivant */ } }
  throw new Error('Scanner indisponible (vérifiez internet)');
}

/** Ouvre le scanner. onCode(code) peut renvoyer un texte affiché dans le journal. */
function openScanner({ title = 'Scanner', continuous = false, onCode, onClose }) {
  let stopFn = () => {};
  const m = modal(title, `
    <div class="scan-view" id="scan-view"><div class="scan-frame"></div></div>
    <p class="small muted" style="text-align:center;margin:8px 0">Visez le QR code ou le code-barres de l’étiquette</p>
    <form class="row" id="scan-manual"><input name="code" placeholder="…ou tapez le code (ex : GS000012)" autocapitalize="characters" autocomplete="off"><button class="btn">OK</button></form>
    <div class="scan-log" id="scan-log"></div>
    ${continuous ? '<button class="btn primary block" data-close style="margin-top:10px">Terminé</button>' : ''}`,
  { onClose: () => { stopFn(); onClose && onClose(); } });
  let last = '', lastT = 0;
  const handle = async (raw) => {
    const code = normCode(raw);
    if (!code) return;
    const t = Date.now();
    if (code === last && t - lastT < 2500) return;
    last = code; lastT = t;
    beep();
    const msg = await onCode(code);
    if (!continuous) { m.close(); return; }
    const log = $('#scan-log', m.el);
    if (log) log.insertAdjacentHTML('afterbegin', `<div class="between" style="padding:4px 0;border-bottom:1px solid var(--line)"><span class="mono">${esc(code)}</span><span class="small">${msg || '✓'}</span></div>`);
  };
  $('#scan-manual', m.el).onsubmit = (e) => { e.preventDefault(); const i = e.target.code; handle(i.value); i.value = ''; last = ''; };

  (async () => {
    const view = $('#scan-view', m.el);
    try {
      if ('BarcodeDetector' in window) {
        const formats = (await BarcodeDetector.getSupportedFormats()).filter((f) => ['qr_code', 'code_128', 'ean_13', 'code_39'].includes(f));
        if (!formats.length) throw new Error('nofmt');
        const det = new BarcodeDetector({ formats });
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const video = document.createElement('video');
        video.setAttribute('playsinline', ''); video.muted = true; video.srcObject = stream;
        view.prepend(video);
        await video.play();
        let alive = true;
        stopFn = () => { alive = false; stream.getTracks().forEach((tr) => tr.stop()); };
        const loop = async () => {
          if (!alive || m.closed) return;
          try { const r = await det.detect(video); if (r[0]) await handle(r[0].rawValue); } catch { /* image suivante */ }
          setTimeout(loop, 180);
        };
        loop();
        return;
      }
      throw new Error('nodetector');
    } catch (e) {
      if (m.closed) return;
      if (e.name === 'NotAllowedError') { view.innerHTML = '<div class="empty" style="color:#fff">Accès caméra refusé.<br>Réglages › Safari › Caméra › Autoriser.</div>'; return; }
    }
    try {
      await ensureHtml5Qrcode();
      if (m.closed) return;
      view.innerHTML = '<div id="scan-h5" style="width:100%;height:100%"></div>';
      const h = new window.Html5Qrcode('scan-h5', { verbose: false });
      const F = window.Html5QrcodeSupportedFormats;
      await h.start({ facingMode: 'environment' }, {
        fps: 12,
        qrbox: (w, hh) => ({ width: Math.floor(w * 0.82), height: Math.floor(hh * 0.6) }),
        formatsToSupport: F ? [F.QR_CODE, F.CODE_128, F.EAN_13, F.CODE_39] : undefined,
      }, (txt) => handle(txt), () => {});
      stopFn = () => { h.stop().then(() => h.clear()).catch(() => {}); };
      if (m.closed) stopFn();
    } catch (e) {
      if (m.closed) return;
      view.innerHTML = `<div class="empty" style="color:#fff;padding:40px 16px">Caméra indisponible : ${esc(e.message || e)}.<br>Tapez le code ci-dessous.</div>`;
    }
  })();
  return m;
}

// ------------------------------------------------------------------ codes : QR & Code 128 (SVG)
function qrSvg(text, sizeMm) {
  const { QRCode, ECL } = window.QRCodeLib;
  const q = new QRCode(-1, ECL.M);
  q.addData(text); q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
function code128Svg(text, widthMm, heightMm) {
  const codes = [104];
  for (const ch of text) { const v = ch.charCodeAt(0) - 32; codes.push(v >= 0 && v < 95 ? v : 0); }
  let sum = 104;
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  let x = 10, rects = '';
  for (const c of codes) {
    const p = C128[c];
    for (let i = 0; i < p.length; i++) { const w = +p[i]; if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="40"/>`; x += w; }
  }
  const total = x + 10;
  return `<svg class="bc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 40" width="${widthMm}mm" height="${heightMm}mm" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
const itemUrl = (code) => `${location.origin}/#/a/${code}`;

// ------------------------------------------------------------------ impression (AirPrint sur iPhone)
function printHtml(html, page = 'size: A4; margin: 10mm') {
  const root = $('#print-root');
  root.innerHTML = `<style>@page { ${page} }</style>${html}`;
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 250);
}

function labelHtml(it, fmt, mode) {
  const shop = esc(S.settings?.shop_name || S.status?.shop_name || '');
  const meta = [it.size && `T. ${it.size}`, it.brand, it.color].filter(Boolean).map(esc).join(' · ');
  const showQr = mode !== 'barcode';
  const showBc = mode !== 'qr';
  if (fmt === 'roll') {
    return `<div class="lbl">${showQr ? qrSvg(itemUrl(it.code), 21) : ''}<div class="tx"><div class="shop">${shop}</div><div class="ti">${esc(it.title)}</div><div class="meta">${meta}</div>${!showQr && showBc ? code128Svg(it.code, 44, 8) : ''}<div class="pr">${money(it.price)}</div><div class="cd">${esc(it.code)}</div></div></div>`;
  }
  return `<div class="lbl">${showQr ? qrSvg(itemUrl(it.code), 24) : ''}<div class="tx"><div class="shop">${shop}</div><div class="ti">${esc(it.title)}</div><div class="meta">${meta}</div><div class="pr">${money(it.price)}</div>${showBc ? code128Svg(it.code, showQr ? 36 : 62, 7) : ''}<div class="cd">${esc(it.code)}</div></div></div>`;
}
async function printLabels(items) {
  if (!items.length) return toast('Aucun article à imprimer', 'bad');
  await ensureSettings();
  const fmt = S.settings.label_format === 'roll' ? 'roll' : 'a4';
  const mode = S.settings.label_code || 'both';
  if (fmt === 'roll') printHtml(`<div class="labels-roll">${items.map((i) => labelHtml(i, fmt, mode)).join('')}</div>`, 'size: 50mm 30mm; margin: 0');
  else printHtml(`<div class="labels-a4">${items.map((i) => labelHtml(i, fmt, mode)).join('')}</div>`, 'size: A4; margin: 0');
}

// ------------------------------------------------------------------ composants
const photoUrl = (it) => `/api/photo/${it.id}?v=${it.has_photo}`;
const thumb = (it) => `<div class="thumb">${it.has_photo ? `<img loading="lazy" src="${photoUrl(it)}" alt="">` : esc((it.title || '?')[0].toUpperCase())}</div>`;
const badge = (st) => `<span class="badge b-${st}">${esc(STATUS[st] || st)}</span>`;
function priceTag(it) {
  if (it.status === 'en_vente' || it.status === 'reserve') {
    if (it.markdown_pct) return `<span class="price"><s>${money(it.price)}</s>${money(it.current_price)}</span>`;
    return `<span class="price">${money(it.current_price)}</span>`;
  }
  return `<span class="price">${money(it.price)}</span>`;
}
function itemRow(it, { select = false, checked = false } = {}) {
  const tags = [badge(it.status), it.expired ? '<span class="badge b-exp">Expiré</span>' : '', it.markdown_pct && ['en_vente', 'reserve'].includes(it.status) ? `<span class="badge b-md">-${it.markdown_pct}%</span>` : ''].join(' ');
  return `<a class="it" href="#/article/${it.id}" data-id="${it.id}">
    ${select ? `<input type="checkbox" class="sel" data-id="${it.id}" ${checked ? 'checked' : ''} onclick="event.stopPropagation()">` : ''}
    ${thumb(it)}
    <div class="grow"><div class="t">${esc(it.title)}</div><div class="s"><span class="mono">${esc(it.code)}</span> · ${esc(it.supplier_name || '')}${it.size ? ' · T. ' + esc(it.size) : ''}${it.location ? ' · 📍' + esc(it.location) : ''}</div><div style="margin-top:3px">${tags}</div></div>
    <div class="right">${priceTag(it)}</div></a>`;
}
const empty = (txt, ic = '∅') => `<div class="empty"><span class="ic">${ic}</span>${esc(txt)}</div>`;
async function ensureSettings(force) {
  if (!S.settings || force) S.settings = await GET('/api/settings');
  return S.settings;
}
async function ensureCats(force) {
  if (!S.cats.length || force) S.cats = await GET('/api/categories');
  return S.cats;
}
const catOptions = (sel) => `<option value="">— Catégorie —</option>` + S.cats.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

// ------------------------------------------------------------------ authentification
function renderAuth() {
  const init = S.status?.initialized;
  $('#app').innerHTML = `<div class="auth"><div class="box">
    <div class="brand"><div class="m wordmark">${esc(S.status?.shop_name || 'Golsh')}</div><div class="s">Dépôt-vente</div></div>
    ${init ? `
      <form id="f-login" class="stack">
        <label class="f"><span>Identifiant</span><input name="username" autocomplete="username" autocapitalize="none" required></label>
        <label class="f"><span>Mot de passe</span><input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block big">Se connecter</button>
      </form>` : `
      <p class="note">Première ouverture : créez le compte administrateur. Il aura accès à tout (marges, reversements, réglages).</p>
      <form id="f-setup" class="stack" style="margin-top:12px">
        <label class="f"><span>Nom de la boutique</span><input name="shop_name" value="${esc(S.status?.shop_name || 'Golsh')}" required></label>
        <label class="f"><span>Votre nom</span><input name="name" required></label>
        <label class="f"><span>Identifiant de connexion</span><input name="username" autocapitalize="none" placeholder="ex : admin" required></label>
        <label class="f"><span>Mot de passe (6 caractères min.)</span><input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
        <button class="btn primary block big">Créer et commencer</button>
      </form>`}
  </div></div>`;
  const f = $('#f-login') || $('#f-setup');
  f.onsubmit = (e) => {
    e.preventDefault();
    busy($('button', f), async () => {
      await POST(init ? '/api/login' : '/api/setup', formData(f));
      await boot();
    });
  };
}

// ------------------------------------------------------------------ coque de l'application
const NAV = [
  { h: '', ic: '◷', t: 'Accueil' },
  { h: 'caisse', ic: '＋', t: 'Caisse', cta: true },
  { h: 'stock', ic: '▤', t: 'Stock' },
  { h: 'depot', ic: '⇩', t: 'Dépôt' },
  { h: 'plus', ic: '☰', t: 'Plus' },
];
const SIDE = [
  { h: '', ic: '◷', t: 'Tableau de bord' },
  { h: 'caisse', ic: '＋', t: 'Caisse' },
  { h: 'stock', ic: '▤', t: 'Stock' },
  { h: 'depot', ic: '⇩', t: 'Nouveau dépôt' },
  { h: 'depots', ic: '▦', t: 'Bons de dépôt' },
  { h: 'fournisseurs', ic: '☺', t: 'Fournisseurs' },
  { h: 'ventes', ic: '€', t: 'Ventes' },
  { h: 'reversements', ic: '⇄', t: 'Reversements', admin: true },
  { h: 'inventaire', ic: '✓', t: 'Inventaire' },
  { sep: true },
  { h: 'journal', ic: '☷', t: 'Journal d’activité', sup: true },
  { h: 'reglages', ic: '⚙', t: 'Réglages' },
];
function renderShell() {
  document.documentElement.style.setProperty('--brand', S.status?.color || '#111111');
  $('#app').innerHTML = `
    <header class="topbar"><div class="logo"><span class="wordmark">${esc(S.status?.shop_name || 'Golsh')}</span><small>Dépôt</small></div>
      <button id="tb-scan" aria-label="Scanner un article">⌗ Scanner</button></header>
    <div class="offline hidden" id="offline">Hors connexion — les données affichées peuvent ne pas être à jour</div>
    <nav class="side">${SIDE.filter((n) => (!n.admin || isAdmin()) && (!n.sup || isSuper())).map((n) => (n.sep ? '<div class="sep"></div>' : `<a href="#/${n.h}" data-h="${n.h}"><span>${n.ic}</span>${n.t}</a>`)).join('')}
      <div class="sep"></div><div class="small muted" style="padding:4px 12px">${esc(S.user.name || S.user.username)} · ${roleLabel()}</div></nav>
    <main id="main"></main>
    <nav class="tabs">${NAV.map((n) => `<a href="#/${n.h}" data-h="${n.h}" class="${n.cta ? 'cta' : ''}"><span class="ic">${n.ic}</span>${n.t}</a>`).join('')}</nav>`;
  $('#tb-scan').onclick = () => openScanner({ title: 'Trouver un article', onCode: (c) => { location.hash = '#/a/' + c; } });
  const upd = () => $('#offline')?.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
}

const ROUTES = [
  [/^$/, viewDashboard, 'Accueil'],
  [/^caisse$/, viewCaisse],
  [/^stock$/, viewStock],
  [/^a\/([A-Za-z0-9-]+)$/, viewArticleByCode, 'stock'],
  [/^article\/(\d+)$/, viewArticle, 'stock'],
  [/^depot$/, viewDepotNew],
  [/^depots$/, viewDepots, 'depot'],
  [/^depot\/(\d+)$/, viewDepot, 'depot'],
  [/^fournisseurs$/, viewSuppliers, 'plus'],
  [/^fournisseur\/(\d+)$/, viewSupplier, 'plus'],
  [/^ventes$/, viewSales, 'plus'],
  [/^vente\/([\w-]+)$/, viewSale, 'plus'],
  [/^reversements$/, viewPayouts, 'plus'],
  [/^reversement\/([\w-]+)$/, viewPayout, 'plus'],
  [/^inventaire$/, viewInventory, 'plus'],
  [/^reglages$/, viewSettings, 'plus'],
  [/^journal$/, viewJournal, 'plus'],
  [/^plus$/, viewMore],
];

let routeToken = 0;
async function router() {
  if (!S.user) return;
  const path = (location.hash.replace(/^#\/?/, '').split('?')[0] || '').replace(/\/$/, '');
  const main = $('#main');
  if (!main) return;
  let found = ROUTES.find(([re]) => re.test(path));
  if (!found) { location.hash = '#/'; return; }
  const [re, fn, navKey] = found;
  const key = navKey === 'Accueil' ? '' : navKey ?? path.split('/')[0];
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.h === key || (key === 'plus' && a.dataset.h === path.split('/')[0])));
  const token = ++routeToken;
  main.innerHTML = '<div class="loading">Chargement…</div>';
  window.scrollTo(0, 0);
  try {
    const args = path.match(re).slice(1);
    await fn(main, ...args, () => token === routeToken);
  } catch (e) {
    if (e.silent) return;
    main.innerHTML = `<div class="err">${esc(e.message)}</div><button class="btn" onclick="location.reload()">Réessayer</button>`;
  }
}

// ------------------------------------------------------------------ TABLEAU DE BORD
async function viewDashboard(main) {
  const d = await GET('/api/dashboard');
  const max = Math.max(1, ...d.series.map((s) => s.total));
  const jours = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  main.innerHTML = `
    <div class="page-head"><h1>Bonjour ${esc((S.user.name || '').split(' ')[0])}</h1><span class="muted small">${new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>
    <div class="grid k2" style="margin-bottom:10px">
      <a class="btn primary big" href="#/caisse">＋ Nouvelle vente</a>
      <a class="btn gold big" href="#/depot">⇩ Nouveau dépôt</a>
    </div>
    <div class="grid k4" style="margin-bottom:12px">
      <div class="kpi dark"><div class="lbl">Ventes aujourd’hui</div><div class="val">${money(d.today.total)}</div><div class="sub">${d.today.n} vente(s)${d.today.margin !== null ? ' · marge ' + money(d.today.margin) : ''}</div></div>
      <div class="kpi"><div class="lbl">Ce mois</div><div class="val">${money(d.month.total)}</div><div class="sub">${d.month.n} vente(s)${d.month.margin !== null ? ' · marge ' + money(d.month.margin) : ''}</div></div>
      <a class="kpi" href="#/stock"><div class="lbl">En stock</div><div class="val">${d.stock.n}</div><div class="sub">valeur ${money(d.stock.value)}</div></a>
      ${d.dues ? `<a class="kpi" href="#/fournisseurs?dues=1"><div class="lbl">À reverser</div><div class="val">${money(d.dues.amount)}</div><div class="sub">${d.dues.suppliers} fournisseur(s)</div></a>` : `<a class="kpi" href="#/ventes"><div class="lbl">Ventes</div><div class="val">→</div><div class="sub">historique</div></a>`}
    </div>
    ${d.alerts.expired || d.alerts.dormant || d.alerts.reserved ? `<div class="card"><h3>À traiter</h3><div class="btns">
      ${d.alerts.expired ? `<a class="btn sm danger" href="#/stock?alert=expired">⏰ ${d.alerts.expired} dépôt(s) expiré(s) à rendre</a>` : ''}
      ${d.alerts.dormant ? `<a class="btn sm" href="#/stock?alert=dormant">💤 ${d.alerts.dormant} invendu(s) depuis +30 j</a>` : ''}
      ${d.alerts.reserved ? `<a class="btn sm" href="#/stock?status=reserve">🔖 ${d.alerts.reserved} réservé(s)</a>` : ''}</div></div>` : ''}
    <div class="grid d2">
      <div class="card"><div class="between"><h3>7 derniers jours</h3>${isAdmin() ? '<div class="legend"><span><i style="background:var(--brand)"></i>CA</span><span><i style="background:var(--gold)"></i>Marge</span></div>' : ''}</div>
        <div class="bars">${d.series.map((s) => `<div class="b"><div class="v">${s.total ? money(s.total, false) : ''}</div><div class="bar" style="height:${(s.total / max) * 100}%">${s.margin ? `<i style="height:${(s.margin / Math.max(s.total, 1)) * 100}%"></i>` : ''}</div><div class="d">${jours[new Date(s.d + 'T12:00').getDay()]}</div></div>`).join('')}</div></div>
      <div class="card"><h3>Dernières ventes</h3><div class="list">${d.recent.length ? d.recent.map((v) => `<a class="it" href="#/vente/${v.id}"><div class="grow"><div class="t">${esc(v.number)}</div><div class="s">${fdate(v.created_at, true)} · ${PAY[v.payment_method] || ''}</div></div><span class="price">${money(v.total)}</span></a>`).join('') : empty('Aucune vente pour le moment')}</div></div>
      ${d.top_suppliers.length ? `<div class="card"><h3>Meilleurs fournisseurs du mois</h3><div class="list">${d.top_suppliers.map((s) => `<a class="it" href="#/fournisseur/${s.id}"><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${s.n} article(s) vendu(s)</div></div><span class="price">${money(s.total)}</span></a>`).join('')}</div></div>` : ''}
      ${d.top_categories.length ? `<div class="card"><h3>Catégories du mois</h3><div class="list">${d.top_categories.map((c) => `<div class="it"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${c.n} vendu(s)</div></div><span class="price">${money(c.total)}</span></div>`).join('')}</div></div>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ CAISSE
const cart = {
  get() { return store.get('cart', { items: [], discount: '', method: 'especes', customer: '', phone: '' }); },
  set(c) { store.set('cart', c); },
  add(code) {
    const c = cart.get();
    if (c.items.some((i) => i.code === code)) return false;
    c.items.push({ code, discount: 0 });
    cart.set(c);
    return true;
  },
};

async function viewCaisse(main, alive) {
  await ensureSettings();
  main.innerHTML = `
    <div class="page-head"><h1>Caisse</h1><button class="btn sm" id="c-clear">Vider</button></div>
    <div class="card">
      <div class="scanbar"><button class="btn primary big" id="c-scan" style="flex:1">⌗ Scanner un article</button></div>
      <form id="c-code" class="row" style="margin-top:8px"><input name="code" placeholder="Code article ou douchette (ex : GS000012)" autocapitalize="characters" autocomplete="off"><button class="btn">Ajouter</button></form>
    </div>
    <div id="c-body"></div>`;
  const input = $('#c-code input');
  if (!isTouch) input.focus();
  const addCode = async (raw) => {
    const code = normCode(raw);
    if (!code) return '';
    if (!cart.add(code)) { toast('Déjà dans le panier'); return 'déjà ajouté'; }
    const r = await refresh();
    const pb = r?.problems?.find((p) => p.code === code);
    if (pb) {
      const c = cart.get(); c.items = c.items.filter((i) => i.code !== code); cart.set(c);
      toast(`${code} : ${pb.error}`, 'bad');
      await refresh();
      return '⚠ ' + pb.error;
    }
    const l = r?.lines?.find((x) => x.item.code === code);
    return l ? esc(l.item.title) + ' · ' + money(l.unit_price) : '✓';
  };
  $('#c-code').onsubmit = async (e) => { e.preventDefault(); const v = input.value; input.value = ''; await addCode(v); };
  $('#c-scan').onclick = () => openScanner({ title: 'Ajouter au panier', continuous: true, onCode: addCode });
  $('#c-clear').onclick = async () => { if (cart.get().items.length && !(await confirmDlg('Vider le panier ?'))) return; cart.set({ items: [], discount: '', method: 'especes', customer: '', phone: '' }); refresh(); };

  async function refresh() {
    if (!alive()) return null;
    const c = cart.get();
    const body = $('#c-body');
    if (!body) return null;
    if (!c.items.length) {
      body.innerHTML = `<div class="card">${empty('Panier vide — scannez une étiquette pour commencer', '🛍')}</div>`;
      return null;
    }
    let r;
    try { r = await POST('/api/sales/preview', { items: c.items, discount: c.discount }); }
    catch (e) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; return null; }
    // retirer automatiquement les articles indisponibles
    if (r.problems.length) {
      const bad = new Set(r.problems.map((p) => p.code));
      c.items = c.items.filter((i) => !bad.has(i.code)); cart.set(c);
    }
    body.innerHTML = `
      <div class="card"><h3>Panier · ${r.lines.length} article(s)</h3>
        ${r.lines.map((l) => `<div class="cart-line">${thumb(l.item)}
          <div class="grow"><div class="t" style="font-weight:600">${esc(l.item.title)}</div>
            <div class="small muted"><span class="mono">${esc(l.item.code)}</span> · ${esc(l.item.supplier_name)}${l.item.markdown_pct ? ` · <span class="badge b-md">-${l.item.markdown_pct}% auto</span>` : ''}</div>
            ${l.item.status === 'reserve' ? `<div class="small" style="color:var(--warn)">Réservé${l.item.reserved_for ? ' pour ' + esc(l.item.reserved_for) : ''}</div>` : ''}
            <button class="btn sm" data-disc="${esc(l.item.code)}" style="margin-top:4px">Remise${(c.items.find((i) => i.code === l.item.code)?.discount || 0) > 0 ? ' : ' + money(c.items.find((i) => i.code === l.item.code).discount) : ''}</button></div>
          <div class="right">${l.unit_price !== l.item.price ? `<div class="small muted"><s>${money(l.item.price)}</s></div>` : ''}<div class="price">${money(l.price)}</div>
            <button class="icon-btn" data-rm="${esc(l.item.code)}" aria-label="Retirer">✕</button></div></div>`).join('')}
      </div>
      <div class="card">
        <label class="f"><span>Remise sur le total (${cur()})</span><input id="c-disc" inputmode="decimal" value="${esc(c.discount)}" placeholder="0"></label>
        <div class="totals">
          <div class="between"><span class="muted">Sous-total</span><span>${money(r.subtotal)}</span></div>
          ${r.discount ? `<div class="between"><span class="muted">Remise</span><span>− ${money(r.discount)}</span></div>` : ''}
          <div class="between grand"><span>Total</span><span>${money(r.total)}</span></div>
          ${isAdmin() ? `<div class="between small muted"><span>dont marge dépôt</span><span>${money(r.shop_total)}</span></div>` : ''}
        </div>
      </div>
      <div class="card"><h3>Paiement</h3>
        <div class="pay">${['especes', 'carte', 'd17', 'flouci', 'virement', 'cheque'].map((k) => `<button class="chip ${c.method === k ? 'on' : ''}" data-pay="${k}">${PAY[k]}</button>`).join('')}</div>
        ${c.method === 'especes' ? `<div class="row" style="margin-top:10px"><label class="f grow" style="margin:0"><span>Montant reçu</span><input id="c-recu" inputmode="decimal" placeholder="${money(r.total, false)}"></label><div class="grow right"><div class="small muted">À rendre</div><div class="price" id="c-rendu" style="font-size:20px">—</div></div></div>` : ''}
        <details style="margin-top:10px"><summary class="small muted">Client (facultatif — pour envoyer le ticket par WhatsApp)</summary>
          <div class="grid k2" style="margin-top:8px"><input id="c-cust" placeholder="Nom" value="${esc(c.customer)}"><input id="c-phone" inputmode="tel" placeholder="Téléphone" value="${esc(c.phone)}"></div></details>
      </div>
      <button class="btn ok big block" id="c-pay">Encaisser ${money(r.total)}</button>`;
    $$('[data-rm]', body).forEach((b) => (b.onclick = () => { const cc = cart.get(); cc.items = cc.items.filter((i) => i.code !== b.dataset.rm); cart.set(cc); refresh(); }));
    $$('[data-disc]', body).forEach((b) => (b.onclick = async () => {
      const res = await confirmDlg('Remise sur cet article (montant en ' + cur() + ')', { ok: 'Appliquer', input: 'Montant de la remise' });
      if (!res) return;
      const cc = cart.get(); const it = cc.items.find((i) => i.code === b.dataset.disc);
      if (it) it.discount = Math.max(0, Number(String(res.value).replace(',', '.')) || 0);
      cart.set(cc); refresh();
    }));
    $$('[data-pay]', body).forEach((b) => (b.onclick = () => { const cc = cart.get(); cc.method = b.dataset.pay; cart.set(cc); refresh(); }));
    $('#c-disc', body).onchange = (e) => { const cc = cart.get(); cc.discount = e.target.value.replace(',', '.'); cart.set(cc); refresh(); };
    const recu = $('#c-recu', body);
    if (recu) recu.oninput = () => { const v = Number(recu.value.replace(',', '.')); $('#c-rendu').textContent = v ? money(Math.max(0, v - r.total)) : '—'; };
    const saveCust = () => { const cc = cart.get(); cc.customer = $('#c-cust').value; cc.phone = $('#c-phone').value; cart.set(cc); };
    $('#c-cust', body).onchange = saveCust; $('#c-phone', body).onchange = saveCust;
    $('#c-pay', body).onclick = (e) => busy(e.currentTarget, async () => {
      saveCust();
      const cc = cart.get();
      try {
        const res = await POST('/api/sales', { items: cc.items, discount: cc.discount, payment_method: cc.method, customer: cc.customer, customer_phone: cc.phone });
        cart.set({ items: [], discount: '', method: 'especes', customer: '', phone: '' });
        beep();
        await saleDone(res.id);
        refresh();
      } catch (err) {
        if (err.status === 409) { await refresh(); }
        throw err;
      }
    });
    return r;
  }
  await refresh();
}

async function saleDone(id) {
  const { sale, lines } = await GET('/api/sales/' + id);
  const bySup = {};
  for (const l of lines) (bySup[l.supplier_id] ||= { name: l.supplier_name, phone: l.supplier_phone, items: [] }).items.push(l);
  const m = modal('Vente enregistrée ✓', `
    <div class="kpi dark" style="text-align:center"><div class="lbl">${esc(sale.number)} · ${PAY[sale.payment_method]}</div><div class="val" style="font-size:32px">${money(sale.total)}</div></div>
    <div class="btns" style="margin:12px 0"><button class="btn" id="sd-print">🖨 Ticket</button>
      ${sale.customer_phone ? `<a class="btn" target="_blank" href="${waLink(sale.customer_phone, ticketText(sale, lines))}">💬 Ticket WhatsApp</a>` : ''}
      <button class="btn primary" data-close>Nouvelle vente</button></div>
    ${Object.values(bySup).some((s) => s.phone) ? `<h3>Prévenir les fournisseurs</h3><div class="list">${Object.values(bySup).map((s) => `<div class="it"><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${s.items.map((i) => esc(i.title)).join(', ')}</div></div>${s.phone ? `<a class="btn sm" target="_blank" href="${waLink(s.phone, `Bonjour ${s.name}, bonne nouvelle ! Chez ${S.settings?.shop_name || ''}, nous venons de vendre : ${s.items.map((i) => `${i.title} (${i.code})`).join(', ')}. Le montant vous sera reversé selon nos conditions. Merci !`)}">💬 WhatsApp</a>` : ''}</div>`).join('')}</div>` : ''}`);
  $('#sd-print', m.el).onclick = () => printTicket(sale, lines);
}

function ticketText(sale, lines) {
  return `${S.settings?.shop_name || ''} — Ticket ${sale.number}\n${fdate(sale.created_at, true)}\n\n${lines.map((l) => `• ${l.title} : ${money(l.final_price)}`).join('\n')}\n\nTotal : ${money(sale.total)} (${PAY[sale.payment_method]})\n${S.settings?.ticket_footer || ''}`;
}
function printTicket(sale, lines) {
  const s = S.settings || {};
  printHtml(`<div class="p-ticket"><div class="c"><div class="p-brand" style="font-size:15pt">${esc(s.shop_name)}</div>${esc(s.shop_address || '')}${s.shop_phone ? '<br>Tél. ' + esc(s.shop_phone) : ''}</div><hr>
    <div class="l"><span>Ticket ${esc(sale.number)}</span><span>${fdate(sale.created_at, true)}</span></div><hr>
    ${lines.map((l) => `<div>${esc(l.title)}</div><div class="l"><span>${esc(l.code)}</span><span>${l.discount > 0 ? `<s>${money(l.unit_price)}</s> ` : ''}${money(l.final_price)}</span></div>`).join('')}<hr>
    ${sale.discount ? `<div class="l"><span>Remise</span><span>-${money(sale.discount)}</span></div>` : ''}
    <div class="l"><b>TOTAL</b><b>${money(sale.total)}</b></div><div class="l"><span>Paiement</span><span>${PAY[sale.payment_method]}</span></div>
    ${sale.status === 'annulee' ? '<div class="c"><b>*** VENTE ANNULÉE ***</b></div>' : ''}<hr>
    <div class="c">${esc(s.ticket_footer || '')}</div></div>`, 'size: 80mm auto; margin: 3mm');
}

// ------------------------------------------------------------------ STOCK
async function viewStock(main, alive) {
  await ensureCats();
  const q = qs();
  const sups = await GET('/api/suppliers');
  const st = { status: q.status || 'stock', alert: q.alert || '', q: '', supplier_id: q.supplier_id || '', category_id: '', select: false, sel: new Set() };
  const chips = [['stock', 'En stock'], ['reserve', 'Réservés'], ['vendu', 'Vendus'], ['retourne', 'Rendus'], ['perdu', 'Perdus'], ['expired', 'Expirés'], ['dormant', '+30 jours'], ['all', 'Tous']];
  main.innerHTML = `
    <div class="page-head"><h1>Stock</h1><button class="btn sm" id="s-sel">Sélectionner</button></div>
    <div class="row" style="margin-bottom:8px"><div class="search grow"><input id="s-q" placeholder="Rechercher : code, article, marque, fournisseur…" autocomplete="off"></div><button class="btn" id="s-scan">⌗</button></div>
    <div class="chips" id="s-chips">${chips.map(([k, t]) => `<button class="chip" data-k="${k}">${t}</button>`).join('')}</div>
    <div class="grid k2" style="margin:8px 0 12px"><select id="s-sup"><option value="">Tous les fournisseurs</option>${sups.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><select id="s-cat"><option value="">Toutes catégories</option>${S.cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="small muted" id="s-count"></div>
    <div class="card"><div class="list" id="s-list"></div></div>
    <div class="sel-bar hidden" id="s-bar"><span class="grow" id="s-n">0</span><button class="btn sm" id="s-all">Tout</button><button class="btn sm" id="s-print">🖨 Étiquettes</button><button class="btn sm" id="s-ret">Rendre</button></div>`;
  $('#s-sup').value = st.supplier_id;
  let items = [];
  const chipKey = () => (st.alert || st.status);
  const load = async () => {
    const p = new URLSearchParams();
    if (['expired', 'dormant'].includes(st.alert)) { p.set('alert', st.alert); } else if (st.status !== 'all') p.set('status', st.status);
    if (st.q) p.set('q', st.q);
    if (st.supplier_id) p.set('supplier_id', st.supplier_id);
    if (st.category_id) p.set('category_id', st.category_id);
    $$('#s-chips .chip').forEach((c) => c.classList.toggle('on', c.dataset.k === chipKey()));
    items = await GET('/api/items?' + p);
    if (!alive()) return;
    draw();
  };
  const draw = () => {
    $('#s-count').textContent = `${items.length} article(s)${items.length >= 200 ? ' (affinez la recherche pour voir plus)' : ''} · valeur ${money(items.reduce((a, i) => a + (['en_vente', 'reserve'].includes(i.status) ? i.current_price : i.price), 0))}`;
    $('#s-list').innerHTML = items.length ? items.map((i) => itemRow(i, { select: st.select, checked: st.sel.has(i.id) })).join('') : empty('Aucun article');
    $('#s-bar').classList.toggle('hidden', !st.select);
    $('#s-n').textContent = `${st.sel.size} sélectionné(s)`;
    $$('#s-list .sel').forEach((c) => (c.onchange = () => { const id = Number(c.dataset.id); c.checked ? st.sel.add(id) : st.sel.delete(id); $('#s-n').textContent = `${st.sel.size} sélectionné(s)`; }));
  };
  $('#s-list').addEventListener('click', (e) => {
    if (!st.select) return;
    const a = e.target.closest('.it'); if (!a) return;
    e.preventDefault();
    const id = Number(a.dataset.id);
    st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
    draw();
  });
  $('#s-sel').onclick = () => { st.select = !st.select; st.sel.clear(); $('#s-sel').textContent = st.select ? 'Terminer' : 'Sélectionner'; draw(); };
  $('#s-all').onclick = () => { if (st.sel.size === items.length) st.sel.clear(); else items.forEach((i) => st.sel.add(i.id)); draw(); };
  $('#s-print').onclick = () => printLabels(items.filter((i) => st.sel.has(i.id)));
  $('#s-ret').onclick = async () => {
    if (!st.sel.size) return;
    if (!(await confirmDlg(`Marquer ${st.sel.size} article(s) comme rendus au fournisseur ?`, { ok: 'Rendre' }))) return;
    try { const r = await POST('/api/items/status', { ids: [...st.sel], status: 'retourne' }); toast(`${r.changed} article(s) rendu(s)`, 'ok'); st.sel.clear(); load(); } catch (e) { fail(e); }
  };
  $('#s-chips').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const k = c.dataset.k;
    if (['expired', 'dormant'].includes(k)) { st.alert = k; st.status = 'stock'; } else { st.alert = ''; st.status = k; }
    load();
  };
  $('#s-q').oninput = debounce((e) => { st.q = e.target.value.trim(); load(); });
  $('#s-sup').onchange = (e) => { st.supplier_id = e.target.value; load(); };
  $('#s-cat').onchange = (e) => { st.category_id = e.target.value; load(); };
  $('#s-scan').onclick = () => openScanner({ title: 'Trouver un article', onCode: (c) => { location.hash = '#/a/' + c; } });
  await load();
}

async function viewArticleByCode(main, code) {
  try {
    const it = await GET('/api/items/by-code/' + encodeURIComponent(code));
    location.replace('#/article/' + it.id);
  } catch (e) {
    main.innerHTML = `<div class="err">Article ${esc(code)} introuvable.</div><a class="btn" href="#/stock">Retour au stock</a>`;
  }
}

async function viewArticle(main, id) {
  await Promise.all([ensureCats(), ensureSettings()]);
  const { item: it, moves, sale } = await GET('/api/items/' + id);
  const sellable = ['en_vente', 'reserve'].includes(it.status);
  const shop = (it.current_price * it.rate) / 100;
  main.innerHTML = `
    <a class="back" href="javascript:history.back()">‹ Retour</a>
    <div class="grid d2">
      <div>
        <div class="card">${it.has_photo ? `<img class="photo-big" src="${photoUrl(it)}" alt="">` : `<div class="photo-ph">${esc(it.title[0] || '?')}</div>`}
          ${S.status.photos ? `<label class="btn block" style="margin-top:10px">📷 ${it.has_photo ? 'Changer la photo' : 'Prendre une photo'}<input type="file" accept="image/*" capture="environment" id="a-photo" hidden></label>` : ''}</div>
      </div>
      <div>
        <div class="card">
          <div class="between"><span class="mono muted">${esc(it.code)}</span><span>${badge(it.status)} ${it.expired ? '<span class="badge b-exp">Expiré</span>' : ''}</span></div>
          <h1 style="margin-top:6px">${esc(it.title)}</h1>
          <div style="font-size:28px;margin:4px 0 10px">${priceTag(it)} ${it.markdown_pct && sellable ? `<span class="badge b-md">démarque -${it.markdown_pct}%</span>` : ''}</div>
          ${it.reserved_for && it.status === 'reserve' ? `<div class="note" style="margin-bottom:10px">Réservé pour : ${esc(it.reserved_for)}</div>` : ''}
          <dl class="kv">
            <dt>Fournisseur</dt><dd><a href="#/fournisseur/${it.supplier_id}">${esc(it.supplier_name)}</a></dd>
            ${it.category_name ? `<dt>Catégorie</dt><dd>${esc(it.category_name)}</dd>` : ''}
            ${it.brand ? `<dt>Marque</dt><dd>${esc(it.brand)}</dd>` : ''}
            ${it.size ? `<dt>Taille</dt><dd>${esc(it.size)}</dd>` : ''}
            ${it.color ? `<dt>Couleur</dt><dd>${esc(it.color)}</dd>` : ''}
            ${it.condition ? `<dt>État</dt><dd>${esc(it.condition)}</dd>` : ''}
            ${it.location ? `<dt>Emplacement</dt><dd>📍 ${esc(it.location)}</dd>` : ''}
            <dt>Déposé le</dt><dd>${fdate(it.created_at)} (${it.age_days} j)</dd>
            ${it.description ? `<dt>Notes</dt><dd>${esc(it.description)}</dd>` : ''}
            ${isAdmin() && sellable ? `<dt>Commission</dt><dd>${it.rate} % (${esc(it.rate_source)}) → dépôt ${money(shop)} / fournisseur ${money(it.current_price - shop)}</dd>` : ''}
          </dl>
          ${sale ? `<div class="note" style="margin-top:10px">Vendu ${money(sale.final_price)} le ${fdate(sale.sale_date, true)} — <a href="#/vente/${sale.sale_id}">${esc(sale.sale_number)}</a>${isAdmin() ? ` · part fournisseur ${money(sale.supplier_amount)}${sale.payout_id ? ' (reversée)' : ' (à reverser)'}` : ''}</div>` : ''}
        </div>
        <div class="btns" style="margin-bottom:12px">
          ${sellable ? '<button class="btn primary" id="a-sell">＋ Vendre</button>' : ''}
          <button class="btn" id="a-label">🖨 Étiquette</button>
          <button class="btn" id="a-edit">✎ Modifier</button>
          ${it.status === 'en_vente' ? '<button class="btn" data-st="reserve">🔖 Réserver</button>' : ''}
          ${it.status === 'reserve' ? '<button class="btn" data-st="en_vente">Annuler la réservation</button>' : ''}
          ${sellable ? '<button class="btn" data-st="retourne">↩ Rendre au fournisseur</button>' : ''}
          ${sellable && isAdmin() ? '<button class="btn danger" data-st="perdu">Déclarer perdu</button>' : ''}
          ${['retourne', 'perdu'].includes(it.status) ? '<button class="btn" data-st="en_vente">Remettre en vente</button>' : ''}
          ${isAdmin() && it.status !== 'vendu' ? '<button class="btn danger" id="a-del">Supprimer</button>' : ''}
        </div>
        <div class="card"><h3>Historique</h3><div class="list">${moves.map((m) => `<div class="it"><div class="grow"><div class="t" style="font-weight:500">${esc(m.note || m.type)}</div><div class="s">${fdate(m.created_at, true)}${m.user_name ? ' · ' + esc(m.user_name) : ''}</div></div></div>`).join('') || empty('—')}</div></div>
      </div>
    </div>`;
  $('#a-sell')?.addEventListener('click', () => { cart.add(it.code); location.hash = '#/caisse'; });
  $('#a-label').onclick = () => printLabels([it]);
  $('#a-edit').onclick = () => editItem(it);
  $('#a-del')?.addEventListener('click', async () => {
    if (!(await confirmDlg('Supprimer définitivement cet article ? (erreur de saisie uniquement)', { ok: 'Supprimer', danger: true }))) return;
    try { await DEL('/api/items/' + it.id); toast('Article supprimé', 'ok'); history.back(); } catch (e) { fail(e); }
  });
  $$('[data-st]').forEach((b) => (b.onclick = async () => {
    const to = b.dataset.st;
    let note = null;
    if (to === 'reserve') { const r = await confirmDlg('Réserver cet article', { ok: 'Réserver', input: 'Pour qui ? (nom / téléphone)' }); if (!r) return; note = r.value; }
    else if (!(await confirmDlg(`${b.textContent.trim()} ?`))) return;
    try { await POST('/api/items/status', { ids: [it.id], status: to, note }); toast('C’est fait', 'ok'); router(); } catch (e) { fail(e); }
  }));
  $('#a-photo')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { toast('Envoi de la photo…'); await PUT_PHOTO(it.id, f); toast('Photo enregistrée', 'ok'); router(); } catch (er) { fail(er); }
  });
}

async function compressImage(file, max = 1000, q = 0.78) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Image illisible')); i.src = url; });
    const r = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  } finally { URL.revokeObjectURL(url); }
}
async function PUT_PHOTO(id, file) { return api('PUT', `/api/items/${id}/photo`, await compressImage(file)); }

function itemFormFields(it = {}) {
  return `
    <label class="f"><span>Désignation *</span><input name="title" value="${esc(it.title || '')}" required placeholder="ex : Robe longue fleurie"></label>
    <div class="grid k2"><label class="f"><span>Prix de vente (${cur()}) *</span><input name="price" inputmode="decimal" value="${esc(it.price ?? '')}" required></label>
      <label class="f"><span>Catégorie</span><select name="category_id">${catOptions(it.category_id)}</select></label></div>
    <div class="grid k2"><label class="f"><span>Marque</span><input name="brand" value="${esc(it.brand || '')}"></label><label class="f"><span>Taille</span><input name="size" value="${esc(it.size || '')}"></label></div>
    <div class="grid k2"><label class="f"><span>Couleur</span><input name="color" value="${esc(it.color || '')}"></label>
      <label class="f"><span>État</span><select name="condition"><option value="">—</option>${CONDITIONS.map((c) => `<option ${it.condition === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
    <div class="grid k2"><label class="f"><span>Emplacement</span><input name="location" value="${esc(it.location || '')}" placeholder="ex : Portant A"></label>
      ${it.id === undefined ? `<label class="f"><span>Quantité (articles identiques)</span><input name="qty" inputmode="numeric" value="1"></label>` : '<span></span>'}</div>
    <label class="f"><span>Notes</span><input name="description" value="${esc(it.description || '')}"></label>
    ${isAdmin() ? `<details><summary class="small muted">Options administrateur</summary>
      <div class="grid k2" style="margin-top:8px"><label class="f"><span>Commission spécifique (%)</span><input name="rate_override" inputmode="decimal" value="${esc(it.rate_override ?? '')}" placeholder="auto"></label>
      <label class="f row" style="margin-top:22px"><input type="checkbox" name="no_markdown" ${it.no_markdown ? 'checked' : ''}><span style="margin:0">Pas de démarque auto</span></label></div></details>` : ''}`;
}
function editItem(it) {
  const m = modal('Modifier l’article', `<form id="ei">${itemFormFields(it)}<button class="btn primary block big">Enregistrer</button></form>`);
  $('#ei', m.el).onsubmit = (e) => {
    e.preventDefault();
    busy($('button.primary', m.el), async () => { await PUT('/api/items/' + it.id, formData(e.target)); m.close(); toast('Enregistré', 'ok'); router(); });
  };
}

// ------------------------------------------------------------------ DÉPÔT (nouveau)
// photos des articles en cours de dépôt (gardées en mémoire + sauvegardées si possible)
const DPHOTO = {
  mem: new Map(),
  get(k) { if (!k) return null; if (this.mem.has(k)) return this.mem.get(k); const v = store.get('ph_' + k, null); if (v) this.mem.set(k, v); return v; },
  set(k, v) { this.mem.set(k, v); try { localStorage.setItem('gs_ph_' + k, JSON.stringify(v)); } catch { /* mémoire pleine : gardée pour la session */ } },
  del(k) { this.mem.delete(k); try { localStorage.removeItem('gs_ph_' + k); } catch { /* ignore */ } },
};
const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

async function viewDepotNew(main) {
  await ensureCats();
  const draft = store.get('depot', { supplier: null, items: [], notes: '' });
  const save = () => store.set('depot', draft);
  let pending = null; // photo du formulaire en cours : { key, url }
  const photoZone = () => `
    <div style="margin-bottom:12px">
      ${pending ? `<div class="row" style="align-items:flex-start"><img src="${pending.url}" class="ph-prev" alt=""><div class="grow small" id="d-ai-msg">${pending.msg || ''}</div><button type="button" class="icon-btn" id="d-ph-x" title="Retirer la photo">✕</button></div>` : ''}
      <label class="btn ${pending ? '' : 'primary'} block ${pending ? '' : 'big'}" style="margin-top:${pending ? '8px' : '0'}">📷 ${pending ? 'Reprendre la photo' : 'Photographier l’article' + (S.status.ai ? ' — remplissage auto ✨' : '')}<input type="file" accept="image/*" capture="environment" id="d-photo" hidden></label>
      ${!pending && S.status.ai ? '<div class="small muted" style="text-align:center;margin-top:6px">Prenez l’article à plat ou l’étiquette bien visible : l’IA propose la désignation, la catégorie, la marque, la taille, la couleur, l’état et un prix.</div>' : ''}
    </div>`;
  const draw = () => {
    main.innerHTML = `
      <div class="page-head"><h1>Nouveau dépôt</h1><a class="btn sm" href="#/depots">Bons de dépôt</a></div>
      <div class="card"><div class="between"><h3 style="margin:0">1. Fournisseur</h3>${draft.supplier ? '<button class="btn sm" id="d-chg">Changer</button>' : ''}</div>
        ${draft.supplier ? `<div class="it" style="display:flex;gap:10px;padding-top:8px"><div class="thumb">${esc(draft.supplier.name[0])}</div><div class="grow"><b>${esc(draft.supplier.name)}</b><div class="small muted">${esc(draft.supplier.code || '')} ${esc(draft.supplier.phone || '')}</div></div></div>`
        : `<div class="row" style="margin-top:8px"><div class="search grow"><input id="d-sq" placeholder="Nom ou téléphone…" autocomplete="off"></div><button class="btn primary" id="d-new">＋ Nouveau</button></div><div class="list" id="d-sl"></div>`}
      </div>
      ${draft.supplier ? `
      <div class="card"><h3>2. Ajouter un article</h3><div id="d-pz">${photoZone()}</div><form id="d-add">${itemFormFields()}<button class="btn gold block big">＋ Ajouter à la liste</button></form></div>
      <div class="card"><div class="between"><h3 style="margin:0">3. Articles déposés (${draft.items.reduce((a, i) => a + (Number(i.qty) || 1), 0)})</h3><span class="price">${money(draft.items.reduce((a, i) => a + Number(String(i.price).replace(',', '.')) * (Number(i.qty) || 1), 0))}</span></div>
        <div class="list">${draft.items.map((i, k) => `<div class="it">${DPHOTO.get(i.photo_key) ? `<div class="thumb"><img src="${DPHOTO.get(i.photo_key)}" alt=""></div>` : `<div class="thumb">${esc((i.title || '?')[0])}</div>`}<div class="grow"><div class="t">${esc(i.title)}${Number(i.qty) > 1 ? ` <span class="badge b-reserve">×${esc(i.qty)}</span>` : ''}</div><div class="s">${[S.cats.find((c) => String(c.id) === String(i.category_id))?.name, i.brand, i.size && 'T. ' + i.size, i.condition].filter(Boolean).map(esc).join(' · ')}</div></div><span class="price">${money(String(i.price).replace(',', '.'))}</span><button class="icon-btn" data-dup="${k}" title="Dupliquer">⧉</button><button class="icon-btn" data-rm="${k}" title="Retirer">✕</button></div>`).join('') || empty('Aucun article pour l’instant')}</div>
        <label class="f" style="margin-top:10px"><span>Remarques sur le dépôt</span><input id="d-notes" value="${esc(draft.notes)}"></label>
        <button class="btn primary block big" id="d-save" ${draft.items.length ? '' : 'disabled'}>✓ Enregistrer le dépôt et créer les étiquettes</button>
        ${draft.items.length ? '<button class="btn block danger" id="d-reset" style="margin-top:8px">Annuler ce brouillon</button>' : ''}
      </div>` : ''}`;
    if (!draft.supplier) {
      const search = async (q) => {
        const list = await GET('/api/suppliers' + (q ? '?q=' + encodeURIComponent(q) : ''));
        $('#d-sl').innerHTML = list.slice(0, 30).map((s) => `<a class="it" href="#" data-s='${esc(JSON.stringify({ id: s.id, name: s.name, phone: s.phone, code: s.code }))}'><div class="thumb">${esc(s.name[0])}</div><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc(s.code || '')} · ${esc(s.phone || '')} · ${s.items_stock} en stock</div></div></a>`).join('') || empty('Aucun fournisseur — créez-le avec « Nouveau »');
      };
      $('#d-sq').oninput = debounce((e) => search(e.target.value.trim()));
      $('#d-sl').onclick = (e) => { const a = e.target.closest('[data-s]'); if (!a) return; e.preventDefault(); draft.supplier = JSON.parse(a.dataset.s); save(); draw(); };
      $('#d-new').onclick = () => supplierForm(null, (s) => { draft.supplier = s; save(); draw(); });
      search('');
      return;
    }
    $('#d-chg').onclick = () => { draft.supplier = null; save(); draw(); };
    const bindPhoto = () => {
      $('#d-pz').innerHTML = photoZone();
      $('#d-ph-x')?.addEventListener('click', () => { if (pending) DPHOTO.del(pending.key); pending = null; bindPhoto(); });
      $('#d-photo').onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try {
          const blob = await compressImage(f, 1000, 0.75);
          const url = await blobToDataUrl(blob);
          const key = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          if (pending) DPHOTO.del(pending.key);
          DPHOTO.set(key, url);
          pending = { key, url, msg: S.status.ai ? '<span class="muted">✨ Analyse de la photo…</span>' : '<span class="muted">Photo ajoutée à l’article.</span>' };
          bindPhoto();
          if (S.status.ai) await analyse(blob);
        } catch (er) { fail(er); }
      };
    };
    const analyse = async (blob) => {
      const form = $('#d-add');
      try {
        const r = await api('POST', '/api/ai/analyze', blob);
        const f = r.fields || {};
        const filled = [];
        const setv = (name, v, label) => {
          const el = form.elements[name];
          if (!el || v === null || v === undefined || v === '') return;
          if (el.value && el.value !== '1' && name !== 'qty') return; // ne remplace pas ce qui a été saisi
          if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(v))) return;
          el.value = v; el.classList.add('ai-filled'); filled.push(label);
        };
        setv('title', f.title, 'désignation');
        setv('category_id', f.category_id, 'catégorie');
        setv('brand', f.brand, 'marque');
        setv('size', f.size, 'taille');
        setv('color', f.color, 'couleur');
        setv('condition', f.condition, 'état');
        setv('price', f.price, 'prix');
        setv('description', f.description, 'notes');
        if (pending) pending.msg = filled.length
          ? `<b>✨ Fiche pré-remplie</b> (${filled.join(', ')}).<br><span class="muted">Vérifiez les champs surlignés${f.price ? ', surtout le prix qui est une suggestion' : ''}.</span>`
          : '<span class="muted">L’IA n’a rien pu lire de fiable : complétez à la main.</span>';
      } catch (er) {
        if (pending) pending.msg = `<span class="muted">Analyse indisponible (${esc(er.message)}). Complétez à la main, la photo sera quand même enregistrée.</span>`;
      }
      const m = $('#d-ai-msg'); if (m && pending) m.innerHTML = pending.msg;
      form.elements.title?.focus({ preventScroll: true });
    };
    bindPhoto();
    $('#d-add').addEventListener('input', (e) => e.target.classList.remove('ai-filled'));
    $('#d-add').onsubmit = (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const p = Number(String(d.price).replace(',', '.'));
      if (!d.title.trim() || !(p > 0)) return toast('Désignation et prix obligatoires', 'bad');
      if (pending) d.photo_key = pending.key;
      pending = null;
      draft.items.push(d); save(); draw();
      toast('Ajouté ✓');
      const t = $('#d-add input[name=title]'); if (t && !isTouch) t.focus();
    };
    $$('[data-rm]').forEach((b) => (b.onclick = () => { draft.items.splice(+b.dataset.rm, 1); save(); draw(); }));
    $$('[data-dup]').forEach((b) => (b.onclick = () => { draft.items.splice(+b.dataset.dup + 1, 0, { ...draft.items[+b.dataset.dup] }); save(); draw(); }));
    $('#d-notes').onchange = (e) => { draft.notes = e.target.value; save(); };
    $('#d-reset')?.addEventListener('click', async () => { if (await confirmDlg('Effacer le brouillon ?', { danger: true, ok: 'Effacer' })) { draft.items.forEach((i) => DPHOTO.del(i.photo_key)); draft.items = []; draft.notes = ''; save(); draw(); } });
    $('#d-save').onclick = (e) => busy(e.currentTarget, async () => {
      const r = await POST('/api/deposits', { supplier_id: draft.supplier.id, notes: draft.notes, items: draft.items.map(({ photo_key, ...x }) => x) });
      // envoi des photos sur les articles créés
      const jobs = (r.items || []).map((x) => ({ id: x.id, key: draft.items[x.line]?.photo_key })).filter((j) => j.key && DPHOTO.get(j.key));
      let okN = 0;
      for (const [i, j] of jobs.entries()) {
        toast(`Envoi des photos ${i + 1}/${jobs.length}…`);
        try { const blob = await (await fetch(DPHOTO.get(j.key))).blob(); await api('PUT', `/api/items/${j.id}/photo`, blob); okN++; } catch { /* on continue */ }
      }
      if (jobs.length && okN < jobs.length) toast(`${jobs.length - okN} photo(s) non envoyée(s) — ajoutez-les depuis la fiche article`, 'bad');
      draft.items.forEach((i) => DPHOTO.del(i.photo_key));
      store.set('depot', { supplier: null, items: [], notes: '' });
      toast(`Dépôt ${r.number} enregistré`, 'ok');
      location.hash = `#/depot/${r.id}?new=1`;
    });
  };
  draw();
}

function supplierForm(s, onSaved) {
  const m = modal(s ? 'Modifier le fournisseur' : 'Nouveau fournisseur', `<form id="sf">
    <label class="f"><span>Nom et prénom *</span><input name="name" value="${esc(s?.name || '')}" required></label>
    <div class="grid k2"><label class="f"><span>Téléphone (WhatsApp)</span><input name="phone" inputmode="tel" value="${esc(s?.phone || '')}"></label>
      <label class="f"><span>CIN / Matricule fiscal</span><input name="cin" value="${esc(s?.cin || '')}"></label></div>
    <label class="f"><span>Adresse</span><input name="address" value="${esc(s?.address || '')}"></label>
    <div class="grid k2"><label class="f"><span>Reversement par</span><select name="payout_method">${['especes', 'virement', 'd17', 'flouci', 'cheque', 'autre'].map((k) => `<option value="${k}" ${s?.payout_method === k ? 'selected' : ''}>${PAY[k]}</option>`).join('')}</select></label>
      <label class="f"><span>RIB / n° D17</span><input name="rib" value="${esc(s?.rib || '')}"></label></div>
    ${isAdmin() ? `<label class="f"><span>Commission négociée (%) — vide = règles générales</span><input name="rate" inputmode="decimal" value="${esc(s?.rate ?? '')}"></label>` : ''}
    <label class="f"><span>Notes</span><textarea name="notes">${esc(s?.notes || '')}</textarea></label>
    <button class="btn primary block big">Enregistrer</button></form>`);
  $('#sf', m.el).onsubmit = (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (!isAdmin() && s) d.rate = s.rate;
    busy($('button.primary', m.el), async () => {
      if (s) { await PUT('/api/suppliers/' + s.id, d); m.close(); toast('Enregistré', 'ok'); onSaved && onSaved({ ...s, ...d }); }
      else { const r = await POST('/api/suppliers', d); m.close(); toast('Fournisseur créé', 'ok'); onSaved && onSaved({ id: r.id, code: r.code, name: d.name, phone: d.phone }); }
    });
  };
}

// ------------------------------------------------------------------ DÉPÔTS (liste + détail)
async function viewDepots(main) {
  const list = await GET('/api/deposits');
  main.innerHTML = `<div class="page-head"><h1>Bons de dépôt</h1><a class="btn primary sm" href="#/depot">＋ Nouveau</a></div>
    <div class="card"><div class="list">${list.map((d) => `<a class="it" href="#/depot/${d.id}"><div class="grow"><div class="t">${esc(d.number)} · ${esc(d.supplier_name)}</div><div class="s">${fdate(d.created_at, true)} · ${d.n} article(s)</div></div><span class="price">${money(d.value)}</span></a>`).join('') || empty('Aucun dépôt')}</div></div>`;
}

async function viewDepot(main, id) {
  await ensureSettings();
  const { deposit: d, items } = await GET('/api/deposits/' + id);
  const isNew = qs().new === '1';
  const total = items.reduce((a, i) => a + i.price, 0);
  main.innerHTML = `<a class="back" href="#/depots">‹ Bons de dépôt</a>
    <div class="page-head"><h1>Dépôt ${esc(d.number)}</h1></div>
    ${isNew ? '<div class="note" style="margin-bottom:12px">✓ Dépôt enregistré. Imprimez les étiquettes, collez-les sur les articles, puis faites signer le bon de dépôt.</div>' : ''}
    <div class="card"><dl class="kv"><dt>Fournisseur</dt><dd><a href="#/fournisseur/${d.supplier_id}">${esc(d.supplier_name)}</a></dd><dt>Date</dt><dd>${fdate(d.created_at, true)}</dd><dt>Articles</dt><dd>${items.length} · valeur ${money(total)}</dd>${d.notes ? `<dt>Remarques</dt><dd>${esc(d.notes)}</dd>` : ''}</dl>
      <div class="btns" style="margin-top:12px"><button class="btn primary" id="dp-lbl">🖨 Étiquettes (${items.length})</button><button class="btn" id="dp-bon">📄 Bon de dépôt</button>
      ${d.supplier_phone ? `<a class="btn" target="_blank" href="${waLink(d.supplier_phone, depositText(d, items))}">💬 Envoyer au fournisseur</a>` : ''}</div></div>
    <div class="card"><div class="list">${items.map((i) => itemRow(i)).join('')}</div></div>`;
  $('#dp-lbl').onclick = () => printLabels(items);
  $('#dp-bon').onclick = () => printDeposit(d, items);
}
function depositText(d, items) {
  const s = S.settings;
  return `Bonjour ${d.supplier_name},\nVoici le récapitulatif de votre dépôt ${d.number} du ${fdate(d.created_at)} chez ${s.shop_name} :\n\n${items.map((i) => `• ${i.code} — ${i.title} : ${money(i.price)}`).join('\n')}\n\nTotal : ${items.length} article(s), ${money(items.reduce((a, i) => a + i.price, 0))}.\nDurée du dépôt : ${s.deposit_days} jours. Merci pour votre confiance !`;
}
function rulesText() {
  const s = S.settings;
  const md = s.markdown_enabled === '1' && s.markdown_rules?.length ? `Démarque automatique : ${s.markdown_rules.map((r) => `-${r.pct}% après ${r.days} jours`).join(', ')}.` : 'Pas de démarque automatique.';
  return `Durée du dépôt : ${s.deposit_days} jours. Passé ce délai, les articles invendus doivent être récupérés par le déposant. ${md} La commission du dépôt est déduite du prix de vente effectif ; le solde est reversé au déposant selon le mode convenu. Le dépôt prend soin des articles mais ne peut être tenu responsable de l’usure normale.`;
}
function printDeposit(d, items) {
  const s = S.settings;
  printHtml(`<div class="p-doc">
    <div style="display:flex;justify-content:space-between"><div><div class="p-brand">${esc(s.shop_name)}</div><div class="cond">${esc(s.shop_address || '')} ${s.shop_phone ? '· Tél. ' + esc(s.shop_phone) : ''}</div></div><div style="text-align:right"><b>BON DE DÉPÔT ${esc(d.number)}</b><br>${fdate(d.created_at, true)}</div></div>
    <p style="margin-top:6mm"><b>Déposant :</b> ${esc(d.supplier_name)} (${esc(d.supplier_code || '')})${d.supplier_cin ? ' · CIN/MF ' + esc(d.supplier_cin) : ''}${d.supplier_phone ? ' · Tél. ' + esc(d.supplier_phone) : ''}</p>
    <table><thead><tr><th>Code</th><th>Article</th><th>Taille</th><th>État</th><th class="n">Prix de vente</th><th class="n">Commission</th></tr></thead>
    <tbody>${items.map((i) => `<tr><td>${esc(i.code)}</td><td>${esc(i.title)}${i.brand ? ' — ' + esc(i.brand) : ''}</td><td>${esc(i.size || '')}</td><td>${esc(i.condition || '')}</td><td class="n">${money(i.price)}</td><td class="n">${i.rate} %</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="4">${items.length} article(s)</th><th class="n">${money(items.reduce((a, i) => a + i.price, 0))}</th><th></th></tr></tfoot></table>
    <p class="cond">${esc(rulesText())}</p>
    <div class="sig"><div>Signature du déposant<br><span class="cond">« Lu et approuvé »</span></div><div>Pour ${esc(s.shop_name)}</div></div></div>`);
}

// ------------------------------------------------------------------ FOURNISSEURS
async function viewSuppliers(main) {
  const onlyDues = qs().dues === '1';
  main.innerHTML = `<div class="page-head"><h1>Fournisseurs</h1><button class="btn primary sm" id="f-new">＋ Nouveau</button></div>
    <div class="search" style="margin-bottom:8px"><input id="f-q" placeholder="Rechercher un fournisseur…" autocomplete="off"></div>
    ${isAdmin() ? `<div class="chips" style="margin-bottom:8px"><button class="chip ${onlyDues ? '' : 'on'}" data-d="0">Tous</button><button class="chip ${onlyDues ? 'on' : ''}" data-d="1">Avec solde à reverser</button></div>` : ''}
    <div class="card"><div class="list" id="f-list"></div></div>`;
  let dues = onlyDues;
  const load = async (q = '') => {
    let list = await GET('/api/suppliers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (dues) list = list.filter((s) => s.balance > 0);
    $('#f-list').innerHTML = list.map((s) => `<a class="it" href="#/fournisseur/${s.id}"><div class="thumb">${esc(s.name[0])}</div><div class="grow"><div class="t">${esc(s.name)}</div><div class="s">${esc(s.code || '')} · ${esc(s.phone || '—')} · ${s.items_stock} en stock · ${s.items_sold} vendu(s)</div></div>${isAdmin() && s.balance > 0 ? `<div class="right"><div class="small muted">à reverser</div><span class="price">${money(s.balance)}</span></div>` : ''}</a>`).join('') || empty('Aucun fournisseur');
  };
  $('#f-q').oninput = debounce((e) => load(e.target.value.trim()));
  $$('[data-d]').forEach((c) => (c.onclick = () => { dues = c.dataset.d === '1'; $$('[data-d]').forEach((x) => x.classList.toggle('on', x === c)); load($('#f-q').value.trim()); }));
  $('#f-new').onclick = () => supplierForm(null, (s) => { location.hash = '#/fournisseur/' + s.id; });
  await load();
}

async function viewSupplier(main, id) {
  await ensureSettings();
  const { supplier: s, items, payouts, deposits, unpaid } = await GET('/api/suppliers/' + id);
  const rate = s.items_total ? Math.round((s.items_sold / s.items_total) * 100) : 0;
  let tab = 'stock';
  const sel = new Set();
  main.innerHTML = `<a class="back" href="#/fournisseurs">‹ Fournisseurs</a>
    <div class="card"><div class="between"><div><h1 style="margin:0">${esc(s.name)}</h1><div class="muted small">${esc(s.code || '')}${s.cin ? ' · CIN/MF ' + esc(s.cin) : ''} · reversement ${PAY[s.payout_method] || ''}${s.rate !== null ? ` · commission ${s.rate} %` : ''}</div></div><button class="btn sm" id="sp-edit">✎</button></div>
      <div class="btns" style="margin-top:10px">${s.phone ? `<a class="btn sm" href="tel:${esc(s.phone)}">📞 Appeler</a><a class="btn sm" target="_blank" href="${waLink(s.phone, `Bonjour ${s.name}, `)}">💬 WhatsApp</a>` : ''}<a class="btn sm" href="#/depot" id="sp-dep">⇩ Nouveau dépôt</a></div>
      ${s.rib ? `<div class="small muted" style="margin-top:6px">RIB / compte : <span class="mono">${esc(s.rib)}</span></div>` : ''}${s.notes ? `<div class="small" style="margin-top:6px">${esc(s.notes)}</div>` : ''}</div>
    <div class="grid k4" style="margin-bottom:12px">
      <div class="kpi"><div class="lbl">Déposés</div><div class="val">${s.items_total}</div></div>
      <div class="kpi"><div class="lbl">En stock</div><div class="val">${s.items_stock}</div></div>
      <div class="kpi"><div class="lbl">Vendus</div><div class="val">${s.items_sold}</div><div class="sub">taux ${rate} %</div></div>
      <div class="kpi"><div class="lbl">CA généré</div><div class="val">${money(s.sales_total)}</div></div></div>
    ${isAdmin() ? `<div class="card" style="${s.balance > 0 ? 'border-color:var(--gold)' : ''}"><div class="between"><div><div class="small muted">Solde à reverser (${unpaid.length} vente(s))</div><div style="font-size:26px;font-weight:800">${money(s.balance)}</div></div>${s.balance > 0 ? '<button class="btn gold" id="sp-pay">Reverser</button>' : ''}</div></div>` : ''}
    <div class="chips" id="sp-tabs" style="margin-bottom:8px"><button class="chip" data-t="stock">En stock</button><button class="chip" data-t="vendu">Vendus</button><button class="chip" data-t="autres">Rendus/perdus</button>${isAdmin() ? '<button class="chip" data-t="pay">Reversements</button>' : ''}<button class="chip" data-t="dep">Dépôts</button></div>
    <div id="sp-body"></div>
    <div class="sel-bar hidden" id="sp-bar"><span class="grow" id="sp-n"></span><button class="btn sm" id="sp-exp">Expirés</button><button class="btn sm" id="sp-lbl">🖨</button><button class="btn sm" id="sp-ret">↩ Rendre</button></div>`;
  const draw = () => {
    $$('#sp-tabs .chip').forEach((c) => c.classList.toggle('on', c.dataset.t === tab));
    const body = $('#sp-body');
    $('#sp-bar').classList.toggle('hidden', !(tab === 'stock' && sel.size));
    $('#sp-n').textContent = `${sel.size} sélectionné(s)`;
    if (tab === 'stock') {
      const list = items.filter((i) => ['en_vente', 'reserve'].includes(i.status));
      body.innerHTML = `<div class="card">${list.length ? `<div class="between small muted"><span>Cochez pour rendre ou réimprimer</span><button class="btn sm" id="sp-all">Tout cocher</button></div>` : ''}<div class="list">${list.map((i) => itemRow(i, { select: true, checked: sel.has(i.id) })).join('') || empty('Aucun article en stock')}</div></div>`;
      $$('.sel', body).forEach((c) => (c.onchange = () => { c.checked ? sel.add(+c.dataset.id) : sel.delete(+c.dataset.id); draw(); }));
      $('#sp-all')?.addEventListener('click', () => { list.forEach((i) => sel.add(i.id)); draw(); });
    } else if (tab === 'vendu') {
      const list = items.filter((i) => i.status === 'vendu');
      body.innerHTML = `<div class="card"><div class="list">${list.map((i) => itemRow(i)).join('') || empty('Aucune vente')}</div></div>`;
    } else if (tab === 'autres') {
      const list = items.filter((i) => ['retourne', 'perdu'].includes(i.status));
      body.innerHTML = `<div class="card"><div class="list">${list.map((i) => itemRow(i)).join('') || empty('Aucun')}</div></div>`;
    } else if (tab === 'pay') {
      body.innerHTML = `${unpaid.length ? `<div class="card"><h3>Ventes non reversées</h3><div class="scroll-x"><table class="t"><thead><tr><th>Date</th><th>Article</th><th class="n">Vendu</th><th class="n">Part</th></tr></thead><tbody>${unpaid.map((l) => `<tr><td>${fdate(l.sale_date)}</td><td>${esc(l.title)}<div class="small muted mono">${esc(l.code)}</div></td><td class="n">${money(l.final_price)}</td><td class="n">${money(l.supplier_amount)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        <div class="card"><h3>Historique</h3><div class="list">${payouts.map((p) => `<a class="it" href="#/reversement/${p.id}"><div class="grow"><div class="t">${esc(p.number)}</div><div class="s">${fdate(p.created_at, true)} · ${PAY[p.method] || ''}${p.reference ? ' · ' + esc(p.reference) : ''}</div></div><span class="price">${money(p.amount)}</span></a>`).join('') || empty('Aucun reversement')}</div></div>`;
    } else {
      body.innerHTML = `<div class="card"><div class="list">${deposits.map((d) => `<a class="it" href="#/depot/${d.id}"><div class="grow"><div class="t">${esc(d.number)}</div><div class="s">${fdate(d.created_at, true)}</div></div><span>${d.n} art.</span></a>`).join('') || empty('Aucun dépôt')}</div></div>`;
    }
  };
  $('#sp-tabs').onclick = (e) => { const c = e.target.closest('.chip'); if (c) { tab = c.dataset.t; draw(); } };
  $('#sp-edit').onclick = () => supplierForm(s, () => router());
  $('#sp-dep').onclick = () => store.set('depot', { supplier: { id: s.id, name: s.name, phone: s.phone, code: s.code }, items: store.get('depot', {}).items || [], notes: '' });
  $('#sp-exp').onclick = () => { items.filter((i) => i.expired).forEach((i) => sel.add(i.id)); draw(); };
  $('#sp-lbl').onclick = () => printLabels(items.filter((i) => sel.has(i.id)));
  $('#sp-ret').onclick = async () => {
    const chosen = items.filter((i) => sel.has(i.id));
    if (!(await confirmDlg(`Rendre ${chosen.length} article(s) à ${s.name} ?`, { ok: 'Rendre' }))) return;
    try {
      await POST('/api/items/status', { ids: [...sel], status: 'retourne' });
      toast('Articles rendus', 'ok');
      if (s.phone && (await confirmDlg('Envoyer la liste des articles rendus au fournisseur par WhatsApp ?', { ok: 'Envoyer' }))) {
        window.open(waLink(s.phone, `Bonjour ${s.name}, vous avez récupéré ce jour (${fdate(new Date().toISOString())}) chez ${S.settings.shop_name} :\n${chosen.map((i) => `• ${i.code} — ${i.title}`).join('\n')}\nMerci !`), '_blank');
      }
      router();
    } catch (e) { fail(e); }
  };
  $('#sp-pay')?.addEventListener('click', () => {
    const m = modal('Reverser au fournisseur', `<div class="kpi dark" style="text-align:center;margin-bottom:12px"><div class="lbl">${esc(s.name)}</div><div class="val">${money(s.balance)}</div><div class="sub">${unpaid.length} article(s) vendu(s)</div></div>
      <form id="po"><label class="f"><span>Mode</span><select name="method">${['especes', 'virement', 'd17', 'flouci', 'cheque', 'autre'].map((k) => `<option value="${k}" ${s.payout_method === k ? 'selected' : ''}>${PAY[k]}</option>`).join('')}</select></label>
      <label class="f"><span>Référence (n° transaction, chèque…)</span><input name="reference"></label><label class="f"><span>Note</span><input name="notes"></label>
      <button class="btn gold block big">Confirmer le paiement de ${money(s.balance)}</button></form>`);
    $('#po', m.el).onsubmit = (e) => { e.preventDefault(); busy($('button.gold', m.el), async () => { const r = await POST('/api/payouts', { supplier_id: s.id, ...formData(e.target) }); m.close(); toast('Reversement enregistré', 'ok'); location.hash = '#/reversement/' + r.id; }); };
  });
  draw();
}

// ------------------------------------------------------------------ REVERSEMENTS
async function viewPayouts(main) {
  if (!isAdmin()) { main.innerHTML = '<div class="err">Réservé à l’administrateur</div>'; return; }
  const list = await GET('/api/payouts');
  main.innerHTML = `<div class="page-head"><h1>Reversements</h1><a class="btn sm" href="#/fournisseurs?dues=1">Soldes à reverser</a></div>
    <div class="card"><div class="list">${list.map((p) => `<a class="it" href="#/reversement/${p.id}"><div class="grow"><div class="t">${esc(p.number)} · ${esc(p.supplier_name)}</div><div class="s">${fdate(p.created_at, true)} · ${PAY[p.method] || ''}</div></div><span class="price">${money(p.amount)}</span></a>`).join('') || empty('Aucun reversement')}</div></div>`;
}
async function viewPayout(main, id) {
  await ensureSettings();
  const { payout: p, lines } = await GET('/api/payouts/' + id);
  const text = `Bonjour ${p.supplier_name},\nRelevé ${p.number} du ${fdate(p.created_at)} — ${S.settings.shop_name}\n\n${lines.map((l) => `• ${l.title} (${l.code}) vendu ${money(l.final_price)} → ${money(l.supplier_amount)}`).join('\n')}\n\nTotal reversé : ${money(p.amount)} par ${PAY[p.method] || p.method}${p.reference ? ' (réf. ' + p.reference + ')' : ''}.\nMerci pour votre confiance !`;
  main.innerHTML = `<a class="back" href="#/fournisseur/${p.supplier_id}">‹ ${esc(p.supplier_name)}</a>
    <div class="page-head"><h1>Relevé ${esc(p.number)}</h1></div>
    <div class="card"><dl class="kv"><dt>Fournisseur</dt><dd>${esc(p.supplier_name)}</dd><dt>Date</dt><dd>${fdate(p.created_at, true)}</dd><dt>Mode</dt><dd>${PAY[p.method] || ''}${p.reference ? ' · réf. ' + esc(p.reference) : ''}</dd><dt>Montant</dt><dd style="font-size:20px;font-weight:800">${money(p.amount)}</dd></dl>
      <div class="btns" style="margin-top:12px"><button class="btn primary" id="py-print">🖨 Imprimer le relevé</button>${p.supplier_phone ? `<a class="btn" target="_blank" href="${waLink(p.supplier_phone, text)}">💬 Envoyer par WhatsApp</a>` : ''}</div></div>
    <div class="card scroll-x"><table class="t"><thead><tr><th>Vente</th><th>Article</th><th class="n">Prix vendu</th><th class="n">Comm.</th><th class="n">Reversé</th></tr></thead><tbody>
    ${lines.map((l) => `<tr><td>${fdate(l.sale_date)}<div class="small muted">${esc(l.sale_number)}</div></td><td>${esc(l.title)}<div class="small muted mono">${esc(l.code)}</div></td><td class="n">${money(l.final_price)}</td><td class="n">${l.rate} %</td><td class="n">${money(l.supplier_amount)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#py-print').onclick = () => printHtml(`<div class="p-doc"><div style="display:flex;justify-content:space-between"><div class="p-brand">${esc(S.settings.shop_name)}</div><div style="text-align:right"><b>RELEVÉ DE REVERSEMENT ${esc(p.number)}</b><br>${fdate(p.created_at, true)}</div></div>
    <p><b>Déposant :</b> ${esc(p.supplier_name)} (${esc(p.supplier_code || '')})${p.supplier_rib ? ' · RIB ' + esc(p.supplier_rib) : ''}</p>
    <table><thead><tr><th>Date vente</th><th>Code</th><th>Article</th><th class="n">Prix vendu</th><th class="n">Commission</th><th class="n">Part déposant</th></tr></thead><tbody>
    ${lines.map((l) => `<tr><td>${fdate(l.sale_date)}</td><td>${esc(l.code)}</td><td>${esc(l.title)}</td><td class="n">${money(l.final_price)}</td><td class="n">${l.rate} % (${money(l.shop_amount)})</td><td class="n">${money(l.supplier_amount)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="5">Total reversé — ${PAY[p.method] || ''}${p.reference ? ' réf. ' + esc(p.reference) : ''}</th><th class="n">${money(p.amount)}</th></tr></tfoot></table>
    <div class="sig"><div>Reçu par le déposant</div><div>Pour ${esc(S.settings.shop_name)}</div></div></div>`);
}

// ------------------------------------------------------------------ VENTES
async function viewSales(main) {
  const q = qs();
  let from = q.from || localDay(), to = q.to || localDay();
  main.innerHTML = `<div class="page-head"><h1>Ventes</h1>${isAdmin() ? '<a class="btn sm" href="#/reglages">Exports</a>' : ''}</div>
    <div class="chips" id="v-ch" style="margin-bottom:8px"><button class="chip" data-r="0">Aujourd’hui</button><button class="chip" data-r="1">Hier</button><button class="chip" data-r="7">7 jours</button><button class="chip" data-r="m">Ce mois</button><button class="chip" data-r="all">Tout</button></div>
    <div class="grid k2" style="margin-bottom:10px"><input type="date" id="v-from"><input type="date" id="v-to"></div>
    <div id="v-sum"></div><div class="card"><div class="list" id="v-list"></div></div>`;
  const load = async () => {
    $('#v-from').value = from; $('#v-to').value = to;
    const list = await GET(`/api/sales?from=${from}&to=${to}`);
    const ok = list.filter((v) => v.status === 'ok');
    const tot = ok.reduce((a, v) => a + v.total, 0);
    const byPay = {};
    ok.forEach((v) => (byPay[v.payment_method] = (byPay[v.payment_method] || 0) + v.total));
    $('#v-sum').innerHTML = `<div class="grid k3" style="margin-bottom:12px"><div class="kpi dark"><div class="lbl">Total</div><div class="val">${money(tot)}</div><div class="sub">${ok.length} vente(s)</div></div>
      ${isAdmin() ? `<div class="kpi"><div class="lbl">Marge dépôt</div><div class="val">${money(ok.reduce((a, v) => a + (v.shop_total || 0), 0))}</div></div>` : ''}
      <div class="kpi"><div class="lbl">Par paiement</div><div class="small" style="margin-top:4px">${Object.entries(byPay).map(([k, v]) => `${PAY[k]} : <b>${money(v)}</b>`).join('<br>') || '—'}</div></div></div>`;
    $('#v-list').innerHTML = list.map((v) => `<a class="it" href="#/vente/${v.id}"><div class="grow"><div class="t">${esc(v.number)} ${v.status === 'annulee' ? '<span class="badge b-annulee">Annulée</span>' : ''}</div><div class="s">${fdate(v.created_at, true)} · ${v.n} art. · ${PAY[v.payment_method] || ''}${v.customer ? ' · ' + esc(v.customer) : ''} · ${esc(v.user_name || '')}</div></div><span class="price">${v.status === 'annulee' ? `<s>${money(v.total)}</s>` : money(v.total)}</span></a>`).join('') || empty('Aucune vente sur la période');
  };
  $('#v-ch').onclick = (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const r = c.dataset.r;
    $$('#v-ch .chip').forEach((x) => x.classList.toggle('on', x === c));
    if (r === '0') { from = to = localDay(); }
    else if (r === '1') { from = to = localDay(-1); }
    else if (r === '7') { from = localDay(-6); to = localDay(); }
    else if (r === 'm') { from = localDay().slice(0, 8) + '01'; to = localDay(); }
    else { from = '2000-01-01'; to = localDay(); }
    load();
  };
  $('#v-from').onchange = (e) => { from = e.target.value; load(); };
  $('#v-to').onchange = (e) => { to = e.target.value; load(); };
  $('#v-ch .chip').classList.add('on');
  await load();
}

async function viewSale(main, id) {
  await ensureSettings();
  const { sale: v, lines } = await GET('/api/sales/' + id);
  main.innerHTML = `<a class="back" href="#/ventes">‹ Ventes</a>
    <div class="page-head"><h1>Vente ${esc(v.number)}</h1>${v.status === 'annulee' ? '<span class="badge b-annulee">Annulée</span>' : ''}</div>
    <div class="card"><dl class="kv"><dt>Date</dt><dd>${fdate(v.created_at, true)}</dd><dt>Vendeur</dt><dd>${esc(v.user_name || '')}</dd><dt>Paiement</dt><dd>${PAY[v.payment_method] || ''}</dd>${v.customer || v.customer_phone ? `<dt>Client</dt><dd>${esc(v.customer || '')} ${esc(v.customer_phone || '')}</dd>` : ''}
      ${v.discount ? `<dt>Remise</dt><dd>${money(v.discount)}</dd>` : ''}<dt>Total</dt><dd style="font-size:22px;font-weight:800">${money(v.total)}</dd>${isAdmin() ? `<dt>Marge dépôt</dt><dd>${money(v.shop_total)}</dd>` : ''}
      ${v.status === 'annulee' ? `<dt>Annulée le</dt><dd>${fdate(v.cancelled_at, true)} ${esc(v.cancel_reason || '')}</dd>` : ''}</dl>
      <div class="btns" style="margin-top:12px"><button class="btn" id="vs-print">🖨 Ticket</button>${v.customer_phone ? `<a class="btn" target="_blank" href="${waLink(v.customer_phone, ticketText(v, lines))}">💬 Ticket WhatsApp</a>` : ''}${isAdmin() && v.status === 'ok' ? '<button class="btn danger" id="vs-cancel">Annuler la vente / retour client</button>' : ''}</div></div>
    <div class="card scroll-x"><table class="t"><thead><tr><th>Article</th><th>Fournisseur</th><th class="n">Prix</th>${isAdmin() ? '<th class="n">Dépôt</th><th class="n">Fournisseur</th>' : ''}</tr></thead><tbody>
    ${lines.map((l) => `<tr><td><a href="#/article/${l.item_id}">${esc(l.title)}</a><div class="small muted mono">${esc(l.code)}</div></td><td>${esc(l.supplier_name)}</td><td class="n">${l.discount > 0 ? `<s class="muted small">${money(l.unit_price)}</s><br>` : ''}${money(l.final_price)}</td>${isAdmin() ? `<td class="n">${money(l.shop_amount)}<div class="small muted">${l.rate} %</div></td><td class="n">${money(l.supplier_amount)}${l.payout_id ? '<div class="small muted">reversé</div>' : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  $('#vs-print').onclick = () => printTicket(v, lines);
  $('#vs-cancel')?.addEventListener('click', async () => {
    const r = await confirmDlg('Annuler cette vente ? Les articles seront remis en vente.', { ok: 'Annuler la vente', danger: true, input: 'Motif (retour client, erreur…)' });
    if (!r) return;
    try { await POST(`/api/sales/${v.id}/cancel`, { reason: r.value }); toast('Vente annulée', 'ok'); router(); } catch (e) { fail(e); }
  });
}

// ------------------------------------------------------------------ INVENTAIRE
async function viewInventory(main, alive) {
  const codes = new Set(store.get('inventory', []));
  const save = () => store.set('inventory', [...codes]);
  const hist = await GET('/api/inventory');
  const draw = () => {
    main.innerHTML = `<div class="page-head"><h1>Inventaire</h1></div>
      <div class="note" style="margin-bottom:12px">Scannez toutes les étiquettes présentes en boutique (portants, étagères, réserve). L’application compare avec le stock théorique et signale les articles manquants ou ceux encore en rayon alors qu’ils sont vendus. Le comptage est sauvegardé même si vous fermez l’application.</div>
      <div class="card"><div class="between"><div><div class="small muted">Articles scannés</div><div id="iv-n" style="font-size:34px;font-weight:800">${codes.size}</div></div><button class="btn primary big" id="iv-scan">⌗ Scanner</button></div>
        <form id="iv-code" class="row" style="margin-top:8px"><input name="code" placeholder="Code ou douchette" autocapitalize="characters" autocomplete="off"><button class="btn">Ajouter</button></form>
        <div class="btns" style="margin-top:10px"><button class="btn ok" id="iv-end" ${codes.size ? '' : 'disabled'}>✓ Terminer et comparer</button>${codes.size ? '<button class="btn danger" id="iv-reset">Recommencer</button>' : ''}</div>
        ${codes.size ? `<details style="margin-top:8px"><summary class="small muted">Voir les codes scannés</summary><div class="small mono">${[...codes].reverse().map(esc).join(' · ')}</div></details>` : ''}</div>
      <div id="iv-res"></div>
      ${hist.length ? `<div class="card"><h3>Inventaires précédents</h3><div class="list">${hist.map((h) => `<div class="it"><div class="grow"><div class="t">${fdate(h.created_at, true)}</div><div class="s">${esc(h.user_name || '')} · ${h.scanned} scannés · ${h.found} trouvés</div></div><span class="small">${h.missing} manquant(s)<br>${h.unexpected} anomalie(s)</span></div>`).join('')}</div></div>` : ''}`;
    const add = (raw) => { const c = normCode(raw); if (!c) return ''; const isNew = !codes.has(c); codes.add(c); save(); const n = $('#iv-n'); if (n) n.textContent = codes.size; return isNew ? '✓' : 'déjà compté'; };
    $('#iv-scan').onclick = () => openScanner({ title: 'Inventaire', continuous: true, onCode: add, onClose: draw });
    $('#iv-code').onsubmit = (e) => { e.preventDefault(); add(e.target.code.value); e.target.code.value = ''; draw(); };
    $('#iv-reset')?.addEventListener('click', async () => { if (await confirmDlg('Effacer le comptage en cours ?', { danger: true, ok: 'Effacer' })) { codes.clear(); save(); draw(); } });
    $('#iv-end')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const r = await POST('/api/inventory', { codes: [...codes] });
      codes.clear(); save();
      draw();
      $('#iv-res').innerHTML = `<div class="card"><h3>Résultat</h3><div class="grid k3" style="margin-bottom:10px"><div class="kpi"><div class="lbl">Trouvés</div><div class="val">${r.found} / ${r.expected}</div></div><div class="kpi"><div class="lbl">Manquants</div><div class="val" style="color:var(--bad)">${r.missing.length}</div></div><div class="kpi"><div class="lbl">Anomalies</div><div class="val" style="color:var(--warn)">${r.unexpected.length}</div></div></div>
        ${r.missing.length ? `<h3>Manquants (en stock mais non scannés)</h3><div class="list">${r.missing.map((m) => `<a class="it" href="#/article/${m.id}"><div class="grow"><div class="t">${esc(m.title)}</div><div class="s mono">${esc(m.code)} · ${esc(m.supplier_name || '')}${m.location ? ' · 📍' + esc(m.location) : ''}</div></div></a>`).join('')}</div>
          ${isAdmin() ? `<button class="btn danger" id="iv-lost" style="margin-top:8px">Déclarer ces ${r.missing.length} article(s) perdus</button>` : ''}` : '<p>✓ Aucun article manquant.</p>'}
        ${r.unexpected.length ? `<h3 style="margin-top:12px">Anomalies (scannés mais pas censés être en rayon)</h3><div class="list">${r.unexpected.map((u) => `<${u.id ? `a href="#/article/${u.id}"` : 'div'} class="it"><div class="grow"><div class="t">${esc(u.title)}</div><div class="s mono">${esc(u.code)}</div></div>${badge(u.status)}</${u.id ? 'a' : 'div'}>`).join('')}</div>` : ''}</div>`;
      $('#iv-lost')?.addEventListener('click', async () => {
        if (!(await confirmDlg(`Déclarer ${r.missing.length} article(s) perdus ?`, { danger: true, ok: 'Déclarer perdus' }))) return;
        try { const x = await POST('/api/items/status', { ids: r.missing.map((m) => m.id), status: 'perdu', note: 'Inventaire du ' + fdate(new Date().toISOString()) }); toast(`${x.changed} article(s) déclaré(s) perdus`, 'ok'); } catch (er) { fail(er); }
      });
    }));
  };
  draw();
}

// ------------------------------------------------------------------ RÉGLAGES
async function viewSettings(main) {
  const admin = isAdmin();
  let s = admin ? await ensureSettings(true) : null;
  const users = admin ? await GET('/api/users') : [];
  if (admin) await ensureCats(true);
  main.innerHTML = `<div class="page-head"><h1>Réglages</h1></div>
    ${admin ? `
    <form class="card" id="st-shop"><h3>Boutique</h3>
      <label class="f"><span>Nom</span><input name="shop_name" value="${esc(s.shop_name)}"></label>
      <div class="grid k2"><label class="f"><span>Téléphone</span><input name="shop_phone" value="${esc(s.shop_phone)}"></label><label class="f"><span>Devise</span><input name="currency" value="${esc(s.currency)}"></label></div>
      <label class="f"><span>Adresse</span><input name="shop_address" value="${esc(s.shop_address)}"></label>
      <label class="f"><span>Message en bas du ticket</span><input name="ticket_footer" value="${esc(s.ticket_footer)}"></label>
      <label class="f"><span>Couleur principale</span><input type="color" name="color" value="${esc(s.color)}" style="height:44px;padding:4px"></label>
      <button class="btn primary">Enregistrer</button></form>

    <form class="card" id="st-com"><h3>Commissions du dépôt</h3>
      <p class="small muted">Ordre de priorité : taux de l’article › taux négocié du fournisseur › taux de la catégorie › paliers de prix › taux par défaut.</p>
      <label class="f"><span>Taux par défaut (%)</span><input name="default_rate" inputmode="decimal" value="${esc(s.default_rate)}"></label>
      <div class="small muted" style="margin-bottom:6px">Paliers de prix (facultatif) — ex : jusqu’à 50 ${esc(s.currency)} → 35 %, au-delà → 25 %</div>
      <div id="st-tiers">${(s.tiers.length ? s.tiers : []).map((t) => tierRow(t)).join('')}</div>
      <div class="btns"><button type="button" class="btn sm" id="st-addtier">＋ Palier</button><button class="btn primary">Enregistrer</button></div></form>

    <form class="card" id="st-md"><h3>Durée de dépôt & démarque automatique</h3>
      <label class="f"><span>Durée du dépôt (jours) — au-delà, l’article est signalé « à rendre »</span><input name="deposit_days" inputmode="numeric" value="${esc(s.deposit_days)}"></label>
      <label class="f row"><input type="checkbox" name="markdown_enabled" ${s.markdown_enabled === '1' ? 'checked' : ''}><span style="margin:0">Baisser automatiquement les prix avec le temps</span></label>
      <div id="st-rules">${s.markdown_rules.map((r) => ruleRow(r)).join('')}</div>
      <div class="btns"><button type="button" class="btn sm" id="st-addrule">＋ Étape</button><button class="btn primary">Enregistrer</button></div></form>

    <form class="card" id="st-lbl"><h3>Étiquettes</h3>
      <label class="f"><span>Format</span><select name="label_format"><option value="a4" ${s.label_format !== 'roll' ? 'selected' : ''}>Planche A4 autocollante 3 × 8 (70 × 37 mm) — toute imprimante AirPrint</option><option value="roll" ${s.label_format === 'roll' ? 'selected' : ''}>Rouleau d’étiquettes 50 × 30 mm</option></select></label>
      <label class="f"><span>Code imprimé</span><select name="label_code"><option value="both" ${s.label_code === 'both' ? 'selected' : ''}>QR code + code-barres</option><option value="qr" ${s.label_code === 'qr' ? 'selected' : ''}>QR code seul (lisible par l’appareil photo de l’iPhone)</option><option value="barcode" ${s.label_code === 'barcode' ? 'selected' : ''}>Code-barres seul</option></select></label>
      <label class="f"><span>Préfixe des codes articles</span><input name="code_prefix" value="${esc(s.code_prefix)}" maxlength="4"></label>
      <div class="btns"><button class="btn primary">Enregistrer</button><button type="button" class="btn" id="st-test">🖨 Étiquette de test</button></div></form>

    <div class="card"><h3>Catégories</h3><div class="list">${S.cats.map((c) => `<div class="it"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${c.in_stock} en stock · commission ${c.rate !== null ? c.rate + ' %' : 'par défaut'}</div></div><button class="btn sm" data-cat="${c.id}">✎</button><button class="icon-btn" data-catdel="${c.id}">✕</button></div>`).join('')}</div>
      <form class="row" id="st-cat" style="margin-top:8px"><input name="name" placeholder="Nouvelle catégorie" class="grow"><input name="rate" placeholder="%" inputmode="decimal" style="width:70px"><button class="btn">＋</button></form></div>

    <div class="card"><h3>Utilisateurs</h3><p class="small muted">Le caissier peut vendre, enregistrer des dépôts et faire l’inventaire, sans voir les marges ni payer les fournisseurs.</p>
      <div class="list">${users.map((u) => { const canEdit = u.id !== S.user.id && (isSuper() || u.role === 'caissier'); return `<div class="it" style="flex-wrap:wrap"><div class="grow"><div class="t">${esc(u.name)} ${u.role === 'superadmin' ? '<span class="badge b-vendu">Super admin</span>' : ''} ${u.active ? '' : '<span class="badge b-perdu">désactivé</span>'}</div><div class="s">${esc(u.username)} · ${ROLE_LABEL[u.role] || u.role}</div></div>${u.id === S.user.id ? '<span class="small muted">vous</span>' : canEdit ? `<div class="btns">${isSuper() ? `<select class="btn sm" data-urole="${u.id}" style="width:auto;min-height:34px;padding:4px 8px">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}<button class="btn sm" data-upw="${u.id}">Mot de passe</button><button class="btn sm" data-uact="${u.id}" data-a="${u.active ? 0 : 1}">${u.active ? 'Désactiver' : 'Activer'}</button></div>` : '<span class="small muted">géré par le super admin</span>'}</div>`; }).join('')}</div>
      <form id="st-user" class="grid k2" style="margin-top:10px"><input name="name" placeholder="Nom" required><input name="username" placeholder="Identifiant" autocapitalize="none" required><input name="password" placeholder="Mot de passe (6+)" required><select name="role"><option value="caissier">Caissier</option>${isSuper() ? '<option value="admin">Administrateur</option><option value="superadmin">Super admin</option>' : ''}</select><button class="btn" style="grid-column:1/-1">＋ Ajouter l’utilisateur</button></form></div>

    ${isSuper() ? `<div class="card" style="border-color:#f0d0d0"><h3>Zone super admin</h3>
      <p class="small muted">Vous seul voyez cette zone. Le <a href="#/journal">journal d’activité</a> trace les connexions, annulations, reversements, suppressions et changements de réglages.</p>
      <p class="small"><b>Remise à zéro</b> : efface tous les articles, ventes, dépôts, fournisseurs et reversements (par exemple après les essais). Les utilisateurs, réglages et catégories sont conservés. Téléchargez une sauvegarde avant.</p>
      <button class="btn danger" id="st-reset">Remettre les données à zéro…</button></div>` : ''}

    <div class="card"><h3>Exports & sauvegarde</h3><p class="small muted">Fichiers CSV ouvrables dans Excel / Numbers. Pensez à télécharger une sauvegarde complète chaque mois.</p>
      <div class="btns">${['articles', 'ventes', 'lignes', 'fournisseurs', 'reversements'].map((n) => `<a class="btn sm" href="/api/export/${n}.csv" download>⬇ ${n}</a>`).join('')}<a class="btn sm primary" href="/api/backup" download>⬇ Sauvegarde complète</a></div></div>` : ''}

    <div class="card"><h3>Installer sur l’iPhone</h3><ol class="small" style="padding-left:18px;margin:0"><li>Ouvrez cette page dans <b>Safari</b>.</li><li>Touchez le bouton <b>Partager</b> (carré avec une flèche).</li><li>Choisissez <b>« Sur l’écran d’accueil »</b> puis <b>Ajouter</b>.</li><li>L’application s’ouvre ensuite en plein écran comme une vraie app.</li></ol></div>

    <form class="card" id="st-pw"><h3>Mon compte</h3><div class="small muted" style="margin-bottom:8px">${esc(S.user.name)} · ${esc(S.user.username)}</div>
      <div class="grid k2"><input name="current" type="password" placeholder="Mot de passe actuel" required><input name="password" type="password" placeholder="Nouveau mot de passe" required></div>
      <div class="btns" style="margin-top:10px"><button class="btn">Changer le mot de passe</button><button type="button" class="btn danger" id="st-logout">Se déconnecter</button></div>
      ${!isSuper() ? '<details style="margin-top:12px"><summary class="small muted">Activer le super admin avec un code</summary><div class="row" style="margin-top:8px"><input id="st-code" type="password" placeholder="Code SUPERADMIN_CODE" class="grow"><button type="button" class="btn" id="st-claim">Activer</button></div></details>' : ''}</form>`;

  $('#st-logout').onclick = async () => { await POST('/api/logout').catch(() => {}); S.user = null; location.hash = '#/'; renderAuth(); };
  $('#st-pw').onsubmit = (e) => { e.preventDefault(); busy($('button', e.target), async () => { await POST('/api/me/password', formData(e.target)); e.target.reset(); toast('Mot de passe modifié', 'ok'); }); };
  $('#st-claim')?.addEventListener('click', (e) => busy(e.currentTarget, async () => { await POST('/api/superadmin/claim', { code: $('#st-code').value }); toast('Vous êtes maintenant super admin', 'ok'); await boot(); location.hash = '#/reglages'; }));
  if (!admin) return;

  $('#st-reset')?.addEventListener('click', async () => {
    const r = await confirmDlg('Cette action efface définitivement toutes les données de la boutique (articles, ventes, fournisseurs, dépôts, reversements). Tapez SUPPRIMER pour confirmer.', { ok: 'Tout effacer', danger: true, input: 'Tapez SUPPRIMER' });
    if (!r) return;
    try { await POST('/api/superadmin/reset', { confirm: r.value.trim().toUpperCase() }); store.set('cart', null); store.set('depot', null); toast('Données remises à zéro', 'ok'); location.hash = '#/'; } catch (e) { fail(e); }
  });
  $$('[data-urole]').forEach((sel) => (sel.onchange = async () => {
    if (!(await confirmDlg(`Changer le rôle en « ${ROLE_LABEL[sel.value]} » ?`))) { router(); return; }
    try { await PUT('/api/users/' + sel.dataset.urole, { role: sel.value }); toast('Rôle modifié', 'ok'); } catch (e) { fail(e); }
    router();
  }));

  const saveSettings = async (data, btn) => busy(btn, async () => { await PUT('/api/settings', data); await ensureSettings(true); S.status = await GET('/api/status'); toast('Réglages enregistrés', 'ok'); });
  $('#st-shop').onsubmit = (e) => { e.preventDefault(); saveSettings(formData(e.target), $('button.primary', e.target)).then(() => { renderShell(); router(); }); };
  $('#st-addtier').onclick = () => $('#st-tiers').insertAdjacentHTML('beforeend', tierRow({}));
  $('#st-addrule').onclick = () => $('#st-rules').insertAdjacentHTML('beforeend', ruleRow({}));
  main.addEventListener('click', (e) => { const x = e.target.closest('[data-rmrow]'); if (x) x.parentElement.remove(); });
  $('#st-com').onsubmit = (e) => {
    e.preventDefault();
    const tiers = $$('#st-tiers .row').map((r) => ({ max: $('[name=tmax]', r).value, rate: $('[name=trate]', r).value })).filter((t) => t.rate !== '');
    saveSettings({ default_rate: e.target.default_rate.value, tiers }, $('button.primary', e.target));
  };
  $('#st-md').onsubmit = (e) => {
    e.preventDefault();
    const rules = $$('#st-rules .row').map((r) => ({ days: $('[name=rdays]', r).value, pct: $('[name=rpct]', r).value })).filter((r) => r.days && r.pct);
    saveSettings({ deposit_days: e.target.deposit_days.value, markdown_enabled: e.target.markdown_enabled.checked, markdown_rules: rules }, $('button.primary', e.target));
  };
  $('#st-lbl').onsubmit = (e) => { e.preventDefault(); saveSettings(formData(e.target), $('button.primary', e.target)); };
  $('#st-test').onclick = () => printLabels([{ code: (S.settings.code_prefix || 'GS') + '000000', title: 'Article de test', price: 45, size: 'M', brand: 'Marque' }]);
  $('#st-cat').onsubmit = (e) => { e.preventDefault(); busy($('button', e.target), async () => { await POST('/api/categories', formData(e.target)); await ensureCats(true); router(); }); };
  $$('[data-cat]').forEach((b) => (b.onclick = () => {
    const c = S.cats.find((x) => x.id === +b.dataset.cat);
    const m = modal('Catégorie', `<form id="cf"><label class="f"><span>Nom</span><input name="name" value="${esc(c.name)}"></label><label class="f"><span>Commission spécifique (%) — vide = défaut</span><input name="rate" inputmode="decimal" value="${esc(c.rate ?? '')}"></label><button class="btn primary block">Enregistrer</button></form>`);
    $('#cf', m.el).onsubmit = (e) => { e.preventDefault(); busy($('button', m.el), async () => { await PUT('/api/categories/' + c.id, formData(e.target)); m.close(); await ensureCats(true); router(); }); };
  }));
  $$('[data-catdel]').forEach((b) => (b.onclick = async () => { if (await confirmDlg('Supprimer cette catégorie ? Les articles resteront, sans catégorie.', { danger: true, ok: 'Supprimer' })) { await DEL('/api/categories/' + b.dataset.catdel).catch(fail); await ensureCats(true); router(); } }));
  $('#st-user').onsubmit = (e) => { e.preventDefault(); busy($('button', e.target), async () => { await POST('/api/users', formData(e.target)); toast('Utilisateur ajouté', 'ok'); router(); }); };
  $$('[data-uact]').forEach((b) => (b.onclick = async () => { await PUT('/api/users/' + b.dataset.uact, { active: b.dataset.a === '1' }).catch(fail); router(); }));
  $$('[data-upw]').forEach((b) => (b.onclick = async () => { const r = await confirmDlg('Nouveau mot de passe pour cet utilisateur', { ok: 'Changer', input: 'Mot de passe (6 caractères min.)' }); if (r) { try { await PUT('/api/users/' + b.dataset.upw, { password: r.value }); toast('Mot de passe changé', 'ok'); } catch (e) { fail(e); } } }));
}
const tierRow = (t) => `<div class="row" style="margin-bottom:8px"><input name="tmax" inputmode="decimal" placeholder="Prix max (vide = au-delà)" value="${esc(t.max ?? '')}"><input name="trate" inputmode="decimal" placeholder="%" value="${esc(t.rate ?? '')}" style="width:80px"><button type="button" class="icon-btn" data-rmrow>✕</button></div>`;
const ruleRow = (r) => `<div class="row" style="margin-bottom:8px"><span class="small muted nowrap">Après</span><input name="rdays" inputmode="numeric" value="${esc(r.days ?? '')}" placeholder="jours"><span class="small muted nowrap">jours :</span><input name="rpct" inputmode="decimal" value="${esc(r.pct ?? '')}" placeholder="%" style="width:80px"><span class="small muted">%</span><button type="button" class="icon-btn" data-rmrow>✕</button></div>`;

// ------------------------------------------------------------------ JOURNAL (super admin)
async function viewJournal(main) {
  if (!isSuper()) { main.innerHTML = '<div class="err">Réservé au super admin</div>'; return; }
  const list = await GET('/api/audit');
  main.innerHTML = `<div class="page-head"><h1>Journal d’activité</h1></div>
    <div class="search" style="margin-bottom:10px"><input id="j-q" placeholder="Filtrer : utilisateur, action…"></div>
    <div class="card"><div class="list" id="j-list"></div></div>`;
  const draw = (q = '') => {
    const f = q.toLowerCase();
    const rows = list.filter((a) => !f || `${a.user_name} ${a.action} ${a.detail}`.toLowerCase().includes(f));
    $('#j-list').innerHTML = rows.map((a) => `<div class="it"><div class="grow"><div class="t" style="white-space:normal">${esc(a.action)}${/ZÉRO|annul|supprim|perdu/i.test(a.action) ? ' ⚠️' : ''}</div><div class="s" style="white-space:normal">${fdate(a.created_at, true)} · ${esc(a.user_name || '—')}${a.detail ? ' · ' + esc(a.detail) : ''}</div></div></div>`).join('') || empty('Aucune activité');
  };
  $('#j-q').oninput = (e) => draw(e.target.value);
  draw();
}

// ------------------------------------------------------------------ PLUS (menu mobile)
async function viewMore(main) {
  main.innerHTML = `<h1>Menu</h1><div class="menu-grid">
    <a href="#/fournisseurs"><span class="ic">☺</span>Fournisseurs<div class="d">fiches, soldes, retours</div></a>
    <a href="#/ventes"><span class="ic">€</span>Ventes<div class="d">historique, tickets, annulations</div></a>
    <a href="#/depots"><span class="ic">▦</span>Bons de dépôt<div class="d">étiquettes, bons signés</div></a>
    <a href="#/inventaire"><span class="ic">✓</span>Inventaire<div class="d">comptage par scan</div></a>
    ${isAdmin() ? '<a href="#/reversements"><span class="ic">⇄</span>Reversements<div class="d">relevés fournisseurs</div></a>' : ''}
    ${isSuper() ? '<a href="#/journal"><span class="ic">☷</span>Journal<div class="d">qui a fait quoi, quand</div></a>' : ''}
    <a href="#/reglages"><span class="ic">⚙</span>Réglages<div class="d">${isAdmin() ? 'marges, étiquettes, équipe' : 'mon compte'}</div></a>
  </div><p class="small muted" style="margin-top:16px;text-align:center">${esc(S.user.name)} · ${roleLabel()}</p>`;
}

// ------------------------------------------------------------------ démarrage
async function boot() {
  try { S.status = await GET('/api/status'); }
  catch (e) { $('#app').innerHTML = `<div class="auth"><div class="box"><div class="err">${esc(e.message)}</div><button class="btn primary block" onclick="location.reload()">Réessayer</button></div></div>`; return; }
  document.title = (S.status.shop_name || 'Golsh') + ' — Dépôt-vente';
  S.user = S.status.user;
  if (!S.user) return renderAuth();
  S.settings = null; S.cats = [];
  ensureSettings().catch(() => {});
  renderShell();
  router();
}
window.addEventListener('hashchange', router);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
