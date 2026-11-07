// Test navigateur (format iPhone) : node test/e2e.mjs  (serveur local lancé sur :8787)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('/opt/npm-tools/node_modules/');
const { chromium, devices } = require('playwright');

const BASE = 'http://localhost:8787';
const OUT = process.env.OUT || '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const errors = [];
const shot = async (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const iphone = devices['iPhone 13'];
const ctx = await browser.newContext({ ...iphone, locale: 'fr-FR', timezoneId: 'Africa/Tunis' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
// impression : on capture le contenu au lieu d'ouvrir la boîte de dialogue
await page.addInitScript(() => { window.__prints = []; window.print = () => window.__prints.push(document.getElementById('print-root').innerHTML); });
page.on('dialog', (d) => d.dismiss());

const step = async (name, fn) => {
  try { await fn(); console.log('✓', name); }
  catch (e) { console.log("✗", name, "—", e.message.split("\n").slice(0,12).join(" | ")); errors.push(name + ': ' + e.message.split('\n')[0]); await shot(page, 'FAIL-' + name.replace(/\W+/g, '_')); }
};

await step('installation (compte admin)', async () => {
  await page.goto(BASE + '/');
  await page.fill('input[name=name]', 'Med');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'golsh2026');
  await shot(page, '01-setup');
  await page.click('button:has-text("Créer et commencer")');
  await page.waitForSelector('text=Nouvelle vente');
  await shot(page, '02-dashboard-vide');
});

await step('nouveau fournisseur + dépôt', async () => {
  await page.click('nav.tabs a[data-h=depot]');
  await page.click('#d-new');
  await page.fill('#sf input[name=name]', 'Amira Ben Salah');
  await page.fill('#sf input[name=phone]', '22333444');
  await page.click('#sf button.primary');
  await page.waitForSelector('#d-add');
  const add = async (title, price, extra = {}) => {
    await page.fill('#d-add input[name=title]', title);
    await page.fill('#d-add input[name=price]', String(price));
    if (extra.size) await page.fill('#d-add input[name=size]', extra.size);
    if (extra.brand) await page.fill('#d-add input[name=brand]', extra.brand);
    if (extra.qty) await page.fill('#d-add input[name=qty]', String(extra.qty));
    if (extra.cat) await page.selectOption('#d-add select[name=category_id]', { label: extra.cat });
    await page.click('#d-add button.gold');
  };
  await add('Robe longue fleurie', 85, { size: 'M', brand: 'Mango', cat: 'Femme' });
  await add('Sac à main cuir camel', 120, { brand: 'Michael Kors', cat: 'Sacs & accessoires' });
  await add('T-shirt enfant', 15, { size: '8 ans', qty: 3, cat: 'Enfant' });
  await shot(page, '03-depot-saisie');
  await page.click('#d-save');
  await page.waitForSelector('text=Dépôt D00001');
  await shot(page, '04-depot-enregistre');
  await page.click('#dp-lbl');
  await page.waitForFunction(() => window.__prints.length === 1);
  const html = await page.evaluate(() => window.__prints[0]);
  if ((html.match(/class="lbl"/g) || []).length !== 5) throw new Error('5 étiquettes attendues');
  writeFileSync(`${OUT}/labels.html`, html);
  await page.click('#dp-bon');
  await page.waitForFunction(() => window.__prints.length === 2);
});

await step('impression étiquettes → PDF', async () => {
  // rendu réel des étiquettes en mode impression
  await page.evaluate(() => { document.getElementById('print-root').innerHTML = window.__prints[0]; document.body.classList.add('printing'); });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: `${OUT}/labels.pdf`, preferCSSPageSize: true, printBackground: true });
  await page.evaluate(() => { document.getElementById('print-root').innerHTML = window.__prints[1]; });
  await page.pdf({ path: `${OUT}/bon-depot.pdf`, preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => document.body.classList.remove('printing'));
});

await step('caisse : vente de 2 articles', async () => {
  await page.click('nav.tabs a[data-h=caisse]');
  await page.waitForSelector('#c-code');
  await page.fill('#c-code input', 'gs000001');
  await page.press('#c-code input', 'Enter');
  await page.waitForSelector('text=Robe longue fleurie');
  await page.fill('#c-code input', 'https://x.workers.dev/#/a/GS000002');
  await page.press('#c-code input', 'Enter');
  await page.waitForSelector('text=Sac à main cuir camel');
  await page.fill('#c-disc', '5');
  await page.dispatchEvent('#c-disc', 'change');
  await page.waitForSelector('text=Encaisser 200 DT');
  await page.fill('#c-recu', '250');
  await page.waitForFunction(() => document.getElementById('c-rendu').textContent.includes('50'));
  await shot(page, '05-caisse-panier');
  await page.click('#c-pay');
  await page.waitForSelector('text=Vente enregistrée');
  await shot(page, '06-vente-ok');
  await page.click('#sd-print');
  await page.waitForFunction(() => window.__prints.length === 3);
  await page.click('.modal button[data-close].primary');
});

await step('caisse : article déjà vendu refusé', async () => {
  await page.fill('#c-code input', 'GS000001');
  await page.press('#c-code input', 'Enter');
  await page.waitForSelector('.toast.bad');
});

await step('stock + fiche article', async () => {
  await page.click('nav.tabs a[data-h=stock]');
  await page.waitForSelector('#s-list .it');
  const n = await page.$$eval('#s-list .it', (a) => a.length);
  if (n !== 3) throw new Error('3 articles en stock attendus, trouvé ' + n);
  await shot(page, '07-stock');
  await page.click('#s-list .it >> nth=0');
  await page.waitForSelector('text=Historique');
  await shot(page, '08-article');
  await page.click('button:has-text("Réserver")');
  await page.fill('#cf-in', 'Mme Sana 55 111 222');
  await page.click('#cf-ok');
  await page.waitForSelector('text=Réservé pour');
});

await step('fournisseur + reversement', async () => {
  await page.goto(BASE + '/#/fournisseurs');
  await page.waitForSelector('#f-list .it');
  await page.click('#f-list .it');
  await page.waitForSelector('#sp-pay');
  await shot(page, '09-fournisseur');
  await page.click('#sp-pay');
  await page.click('#po button.gold');
  await page.waitForSelector('text=Relevé R00001');
  await shot(page, '10-releve');
});

await step('inventaire', async () => {
  await page.goto(BASE + '/#/inventaire');
  await page.fill('#iv-code input', 'GS000003');
  await page.press('#iv-code input', 'Enter');
  await page.fill('#iv-code input', 'GS000001');
  await page.press('#iv-code input', 'Enter');
  await page.click('#iv-end');
  await page.waitForSelector('text=Résultat');
  await shot(page, '11-inventaire');
});

await step('ventes, réglages, menu, tableau de bord', async () => {
  await page.goto(BASE + '/#/ventes');
  await page.waitForSelector('#v-list .it');
  await shot(page, '12-ventes');
  await page.click('#v-list .it');
  await page.waitForSelector('#vs-print');
  await page.goto(BASE + '/#/reglages');
  await page.waitForSelector('#st-com');
  await page.fill('#st-com input[name=default_rate]', '35');
  await page.click('#st-com button.primary');
  await page.waitForSelector('text=Réglages enregistrés');
  await shot(page, '13-reglages');
  await page.goto(BASE + '/#/plus');
  await shot(page, '14-menu');
  await page.goto(BASE + '/#/');
  await page.waitForSelector('text=Ventes aujourd’hui');
  await shot(page, '15-dashboard');
});

await step('scanner (ouverture sans caméra → saisie manuelle)', async () => {
  await page.click('#tb-scan');
  await page.waitForSelector('#scan-manual');
  await page.fill('#scan-manual input', 'GS000004');
  await page.press('#scan-manual input', 'Enter');
  await page.waitForSelector('text=T-shirt enfant');
});

await step('caissier : accès limité', async () => {
  await page.goto(BASE + '/#/reglages');
  await page.waitForSelector('#st-user');
  await page.fill('#st-user input[name=name]', 'Sami');
  await page.fill('#st-user input[name=username]', 'sami');
  await page.fill('#st-user input[name=password]', 'caisse1');
  await page.click('#st-user button');
  await page.waitForSelector('text=Utilisateur ajouté');
  await page.click('#st-logout');
  await page.waitForSelector('#f-login');
  await page.fill('input[name=username]', 'sami');
  await page.fill('input[name=password]', 'caisse1');
  await page.click('#f-login button');
  await page.waitForSelector('text=Nouvelle vente');
  const txt = await page.textContent('main');
  if (txt.includes('À reverser')) throw new Error('Le caissier voit les montants à reverser');
  await shot(page, '16-caissier');
});

// format PC
await step('affichage PC', async () => {
  const pc = await browser.newContext({ viewport: { width: 1366, height: 820 }, locale: 'fr-FR' });
  const p2 = await pc.newPage();
  p2.on('pageerror', (e) => errors.push('pageerror(pc): ' + e.message));
  await p2.goto(BASE + '/');
  await p2.fill('input[name=username]', 'admin');
  await p2.fill('input[name=password]', 'golsh2026');
  await p2.click('#f-login button');
  await p2.waitForSelector('nav.side');
  await p2.waitForSelector('text=Ventes aujourd’hui');
  await p2.screenshot({ path: `${OUT}/17-pc-dashboard.png` });
  await p2.goto(BASE + '/#/caisse');
  await p2.waitForSelector('#c-code');
  await p2.screenshot({ path: `${OUT}/18-pc-caisse.png` });
});

await browser.close();
console.log(errors.length ? '\nERREURS:\n' + errors.join('\n') : '\nAucune erreur.');
process.exit(errors.length ? 1 : 0);
