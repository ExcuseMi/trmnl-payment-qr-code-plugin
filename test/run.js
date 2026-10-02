#!/usr/bin/env node
// Builds the plugin with trmnlp for many content/device/view combinations, renders each in
// headless Chromium against TRMNL's real stylesheet and fonts, and checks what a person would:
// the right layout was chosen, the QR scans to exactly the right payload, it is big enough,
// and nothing overflows, overlaps the QR or runs under the title bar.
// Usage: node test/run.js [filter]   (needs trmnlp, zbarimg and a Playwright Chromium)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'plugin');
const CACHE = path.join(__dirname, '.cache');
const SHOTS = path.join(__dirname, 'shots');
const FILTER = process.argv[2] || '';

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort();
  return path.join(base, dirs[dirs.length - 1], 'chrome-linux64/chrome');
}

// ---------------------------------------------------------------- devices and views
const OG = 'screen--og screen--md screen--1bit screen--density-1x screen--fonts-trmnl';
const DEVICES = {
  og: { w: 800, h: 480, classes: OG },
  og_portrait: { w: 480, h: 800, classes: OG + ' screen--portrait' },
  x: { w: 1872, h: 1404, classes: 'screen--v2 screen--lg screen--4bit screen--density-2x screen--fonts-trmnl' },
  sm: { w: 1400, h: 840, classes: 'screen--amazon_kindle_2024 screen--sm screen--density-2x screen--4bit screen--fonts-trmnl' },
  // TRMNL's dark mode inverts the whole screen except images
  og_dark: { w: 800, h: 480, classes: OG + ' screen--dark-mode', css: '.screen{filter:invert(1)} .screen img{filter:invert(1)}' },
  bwry: { w: 800, h: 480, classes: 'screen--og screen--md screen--density-1x screen--color-4bwry screen--fonts-trmnl' },
  classic: { w: 800, h: 480, classes: 'screen--og screen--md screen--1bit screen--density-1x screen--fonts-classic' },
};
// a half or quarter is a slot inside the screen, not a smaller screen
const VIEWS = { 1: ['full', 1, 1], 2: ['half_horizontal', 1, 0.5], 3: ['half_vertical', 0.5, 1], 4: ['quadrant', 0.5, 0.5] };
const ALL_VIEWS = [1, 2, 3, 4];

// ---------------------------------------------------------------- content
const BASE = {
  payment_type: 'epc', epc_name: 'Jane Doe', epc_iban: 'BE71 0961 2345 6769', epc_amount: '12.50',
  epc_reference: 'Coffee fund', qr_text: '', title: 'Buy me a coffee', caption: '',
  body: '## Coffee fund\n\nEvery cup is **EUR 0.50**. Pay whenever you like.\n\n- Open your banking app\n- Scan the code',
  footer: 'Thank you!', icon: 'coffee', image_url: '',
};
const LONG = Array(12).fill('Pay your yearly membership before the end of the month.').join(' ');
const IMG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString('base64');

function epc(name, iban, amount, reference) {
  return ['BCD', '002', '1', 'SCT', '', name, iban, amount ? 'EUR' + amount : '', '', '', reference].join('\n');
}
const EPC_BASE = epc('Jane Doe', 'BE71096123456769', '12.50', 'Coffee fund');

// what the plugin should choose; written from the rules, not from the template
function expectedLayout(c, view) {
  const hasBody = !!(c.body || '').trim();
  const hasSide = !!(c.title || c.footer || c.image_url || (c.icon && c.icon !== 'none'));
  if (hasBody) return view === 3 ? 'stacked' : 'beside';
  if (hasSide && (view === 2 || view === 4)) return 'beside';
  return 'centered';
}

const FULL_MATRIX = [['og', ALL_VIEWS], ['og_portrait', [1]], ['x', [1, 2]], ['sm', [1, 3]], ['bwry', [1]], ['classic', [1]], ['og_dark', [1, 4]]];
const CASES = [
  { name: 'everything', fields: {}, payload: EPC_BASE, matrix: FULL_MATRIX },
  { name: 'no text', fields: { body: '' }, payload: EPC_BASE, matrix: FULL_MATRIX },
  { name: 'qr only', fields: { body: '', title: '', footer: '', icon: 'none' }, payload: EPC_BASE, matrix: [['og', ALL_VIEWS], ['og_portrait', [1]], ['x', [1]]] },
  { name: 'title only', fields: { body: '', footer: '', icon: 'none' }, payload: EPC_BASE, matrix: [['og', ALL_VIEWS]] },
  { name: 'long text', fields: { body: '# Club membership\n\n' + LONG + '\n\n' + LONG + '\n\n- One\n- Two' }, payload: EPC_BASE, matrix: [['og', ALL_VIEWS], ['og_portrait', [1]], ['x', [1]], ['sm', [1]]] },
  { name: 'long title', fields: { title: 'The annual summer barbecue of the street committee, drinks included' }, payload: EPC_BASE, matrix: [['og', ALL_VIEWS]] },
  { name: 'image instead of icon', fields: { image_url: IMG }, payload: EPC_BASE, matrix: [['og', [1, 4]]] },
  { name: 'link', fields: { payment_type: 'text', qr_text: 'https://paypal.me/yourname/5', caption: 'PayPal' }, payload: 'https://paypal.me/yourname/5', matrix: [['og', [1, 4]]] },
  // a long payload makes a dense code: it must still scan in the smallest slot
  { name: 'dense link', fields: { payment_type: 'text', qr_text: 'https://example.com/pay?' + 'invoice=2026-0042&customer=jane.doe&amount=12.50&currency=EUR&ref=' + 'x'.repeat(120) }, payload: 'https://example.com/pay?invoice=2026-0042&customer=jane.doe&amount=12.50&currency=EUR&ref=' + 'x'.repeat(120), matrix: [['og', ALL_VIEWS]] },
  // the coffee shop example from assets/examples: price rows, a logo image, payer picks the amount
  // a markdown --- becomes the framework's divider; dividers sit between QR, title, text and footer
  { name: 'dividers', fields: { body: '## Coffee\n\n- Espresso | €2.40\n\n---\n\n## Tea\n\n- Green tea | €2.20' }, payload: EPC_BASE, dividers: 4, matrix: [['og', [1]], ['og_dark', [1]]] },
  { name: 'price list', fields: {}, webhook: Object.assign({}, require('../assets/examples/coffee-shop.json').merge_variables.payment, { image_url: IMG }), payload: epc('Northbean Coffee', 'BE71096123456769', '', 'Northbean Coffee'), caption: 'Scan, pay, enjoy', expectFields: { title: 'Northbean Coffee' }, priceRows: true, rowCount: 7, matrix: [['og', ALL_VIEWS], ['og_portrait', [1]], ['x', [1]], ['sm', [1]], ['bwry', [1]]] },
  // a real instance: tiny payload (a short, low-version code) and nothing but the QR and its caption
  { name: 'short payload alone', fields: { epc_name: 'X', epc_iban: 'X', epc_amount: '', epc_reference: '', title: '', body: '', footer: '', icon: 'none' }, payload: epc('X', 'X', '', ''), caption: 'Any amount', matrix: [['og', ALL_VIEWS], ['x', [1]], ['og_portrait', [1]]] },
  // TRMNL's server returned the code at a fixed pixel size (no viewBox), which drew it small in the
  // top-left corner of its box; trmnlp's filter is scalable, so force the server's variant here
  { name: 'fixed-size svg from the server', fields: { epc_name: 'X', epc_iban: 'X', epc_amount: '', epc_reference: '', title: '', body: '', footer: '', icon: 'none' }, payload: epc('X', 'X', '', ''), patch: (src) => src.replace('qr_code: 11, level, "responsive"', 'qr_code: 11, level, "fixed"'), fillsBox: true, matrix: [['og', ALL_VIEWS], ['x', [1]]] },
  // TRMNL's server returned width/height on the svg (drawn small, see above); as an <img> the svg
  // is strict XML, where a second width attribute breaks the image, so both variants must work
  { name: 'server svg with viewBox and size', fields: {}, payload: EPC_BASE, patch: (src) => src.replace("{%- assign qr_svg = qr_svg | split: '<svg' | last | prepend: '<svg' -%}", "{%- assign qr_svg = qr_svg | split: '<svg' | last | prepend: '<svg' | replace_first: '<svg ', '<svg width=\"300\" height=\"300\" ' -%}"), fillsBox: true, matrix: [['og', [1, 4]], ['og_dark', [1]]] },
  // TRMNL stores markup with CRLF line endings: every newline the template makes itself becomes
  // \r\n, so splitting webhook text (plain \n) on it never matched and a price list collapsed
  { name: 'template with CRLF line endings', fields: {}, webhook: require('../assets/examples/coffee-shop.json').merge_variables.payment, payload: epc('Northbean Coffee', 'BE71096123456769', '', 'Northbean Coffee'), crlfOk: true, priceRows: true, rowCount: 7, patch: (src) => src.replace(/\r?\n/g, '\r\n'), matrix: [['og', [1]]] },
  // an image that cannot load falls back to the same code inline
  { name: 'image fallback', fields: {}, payload: EPC_BASE, fallback: true, patch: (src) => src.replace('src="data:image/svg+xml;base64,{{ qr_img | base64_encode }}"', 'src="data:image/svg+xml;base64,broken"'), matrix: [['og', [1, 4]]] },
  { name: 'fixed-size svg with text', fields: {}, payload: EPC_BASE, patch: (src) => src.replace('qr_code: 11, level, "responsive"', 'qr_code: 11, level, "fixed"'), fillsBox: true, matrix: [['og', [1, 2]], ['x', [1]]] },
  // rules the serverless transform's unit tests used to cover, now checked on the render
  { name: 'big amount', fields: { epc_amount: '1234.5' }, payload: epc('Jane Doe', 'BE71096123456769', '1234.50', 'Coffee fund'), caption: 'EUR 1,234.50', matrix: [['og', [1]]] },
  { name: 'reference limit', fields: { epc_reference: 'R'.repeat(200) }, payload: epc('Jane Doe', 'BE71096123456769', '12.50', 'R'.repeat(140)), matrix: [['og', [1]]] },
  { name: 'link has no default caption', fields: { payment_type: 'text', qr_text: ' https://paypal.me/jane/5 ', caption: '' }, payload: 'https://paypal.me/jane/5', noCaption: true, matrix: [['og', [1]]] },
  { name: 'title bar hidden by a "no" string', fields: {}, webhook: Object.assign({}, BASE, { show_title_bar: 'no' }), payload: EPC_BASE, noTitleBar: true, matrix: [['og', [1]]] },
  // payload rules
  { name: 'amount open', fields: { epc_amount: '' }, payload: epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), caption: 'Any amount', matrix: [['og', [1]]] },
  { name: 'amount zero is open', fields: { epc_amount: '0' }, payload: epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), caption: 'Any amount', matrix: [['og', [1]]] },
  { name: 'amount comma', fields: { epc_amount: '7,5' }, payload: epc('Jane Doe', 'BE71096123456769', '7.50', 'Coffee fund'), caption: 'EUR 7.50', matrix: [['og', [1]]] },
  { name: 'amount not a number', fields: { epc_amount: 'abc' }, payload: epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), matrix: [['og', [1]]] },
  { name: 'iban cleanup', fields: { epc_iban: 'be71 0961 2345 6769 ' }, payload: EPC_BASE, matrix: [['og', [1]]] },
  { name: 'name limit', fields: { epc_name: 'N'.repeat(90) }, payload: epc('N'.repeat(70), 'BE71096123456769', '12.50', 'Coffee fund'), matrix: [['og', [1]]] },
  { name: 'own caption', fields: { caption: 'Scan to pay' }, payload: EPC_BASE, caption: 'Scan to pay', matrix: [['og', [1]]] },
  { name: 'missing iban', fields: { epc_iban: '' }, payload: null, matrix: [['og', [1, 4]]] },
  // webhook: overrides win field by field, empty values fall back to the settings
  { name: 'webhook data', fields: {}, webhook: Object.assign({}, BASE, { epc_amount: '42', epc_reference: 'Pizza', title: 'Pizza night' }), payload: epc('Jane Doe', 'BE71096123456769', '42.00', 'Pizza'), expectFields: { title: 'Pizza night' }, matrix: [['og', [1, 2]]] },
  // in webhook mode the (hidden) settings never leak through: only the webhook counts
  { name: 'webhook ignores settings', fields: {}, webhook: { title: 'Only a title' }, payload: null, expectFields: { title: 'Only a title' }, matrix: [['og', [1, 4]]] },
  // a QR without a caption in a short view once computed a height above 100% and collapsed
  { name: 'no caption, short view', fields: { payment_type: 'text', qr_text: 'https://paypal.me/yourname' }, payload: 'https://paypal.me/yourname', matrix: [['og', [1, 2, 4]], ['x', [2]]] },
  { name: 'webhook open amount', fields: {}, webhook: Object.assign({}, BASE, { epc_amount: '0' }), payload: epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), caption: 'Any amount', matrix: [['og', [1]]] },
  { name: 'webhook cleared', fields: {}, webhook: { updated_at: 1700000000 }, payload: null, matrix: [['og', [1, 4]]] },
  { name: 'webhook mode, nothing sent yet', fields: { data_source: 'webhook' }, payload: null, matrix: [['og', [1]]] },
  { name: 'title bar text', fields: { title_bar: 'Pay at the counter' }, payload: EPC_BASE, titleBar: 'Pay at the counter', matrix: [['og', [1, 4]]] },
  { name: 'title bar from webhook', fields: { title_bar: 'From settings' }, webhook: Object.assign({}, BASE, { title_bar: 'From webhook' }), payload: EPC_BASE, titleBar: 'From webhook', matrix: [['og', [1]]] },
  { name: 'title bar defaults to plugin name', fields: {}, payload: EPC_BASE, titleBar: 'Payment QR Code', matrix: [['og', [1]]] },
  { name: 'settings ignore webhook data', fields: { data_source: 'settings' }, webhook: { title: 'From webhook', epc_amount: '42' }, payload: EPC_BASE, expectFields: { title: 'Buy me a coffee' }, matrix: [['og', [1]]] },
  // without a title bar the content gets the whole screen and must still fit it
  { name: 'webhook hides the title bar', fields: {}, webhook: Object.assign({}, BASE, { show_title_bar: false }), payload: EPC_BASE, noTitleBar: true, matrix: [['og', ALL_VIEWS], ['x', [1]]] },
  { name: 'title bar icon', fields: { title_bar_icon: IMG, title_bar: 'Northbean' }, payload: EPC_BASE, titleBar: 'Northbean', titleBarIcon: true, matrix: [['og', [1, 4]]] },
  { name: 'webhook link', fields: {}, webhook: Object.assign({}, BASE, { payment_type: 'text', qr_text: 'https://revolut.me/jane' }), payload: 'https://revolut.me/jane', matrix: [['og', [1]]] },
];

// ---------------------------------------------------------------- build (one trmnlp build per content)
const builds = new Map();
function build(fields, webhook, patch) {
  // webhook data only counts when the data source says so
  if (webhook && !fields.data_source) fields = Object.assign({}, fields, { data_source: 'webhook' });
  const key = JSON.stringify([fields, webhook || null, patch ? patch.toString() : null]);
  if (builds.has(key)) return builds.get(key);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrplugin-'));
  fs.cpSync(path.join(PLUGIN, 'src'), path.join(dir, 'src'), { recursive: true });
  if (patch) {
    const shared = path.join(dir, 'src', 'shared.liquid');
    const before = fs.readFileSync(shared, 'utf8');
    const after = patch(before);
    if (after === before) throw new Error('the source patch changed nothing: the template moved, update the test');
    fs.writeFileSync(shared, after);
  }
  const variables = { trmnl: { plugin_settings: { instance_name: 'Payment QR Code' } } };
  if (webhook) variables.payment = webhook;
  // JSON is valid YAML, and a build in a copy never touches the tracked .trmnlp.yml
  fs.writeFileSync(path.join(dir, '.trmnlp.yml'), JSON.stringify({ watch: ['src'], custom_fields: fields, variables }));
  execFileSync('trmnlp', ['build'], { cwd: dir, stdio: 'pipe' });
  const out = {};
  for (const [n, [name]] of Object.entries(VIEWS)) out[n] = fs.readFileSync(path.join(dir, '_build', name + '.html'), 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  builds.set(key, out);
  return out;
}

// ---------------------------------------------------------------- framework assets, cached with real fonts
function cached(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, url.replace(/[^A-Za-z0-9.]+/g, '_'));
  if (!fs.existsSync(file)) execFileSync('curl', ['-fsSL', '-o', file, url]);
  return file;
}
function localize(html) {
  for (const url of new Set(html.match(/https:\/\/trmnl\.com\/(?:css|js)\/[^"]+/g) || [])) {
    let local = cached(url);
    if (url.endsWith('.css')) {
      const raw = fs.readFileSync(local, 'utf8');
      const fontDir = path.join(CACHE, 'fonts');
      fs.mkdirSync(fontDir, { recursive: true });
      for (const f of new Set((raw.match(/url\("\/fonts\/[^"]+"\)/g) || []).map((u) => u.slice(12, -2)))) {
        const dst = path.join(fontDir, path.basename(f));
        if (!fs.existsSync(dst) && spawnSync('curl', ['-fsSL', '-o', dst, 'https://trmnl.com/fonts/' + f]).status !== 0) {
          console.error('font missing, text is measured in a fallback: ' + f);
        }
      }
      local += '.local.css';
      if (!fs.existsSync(local)) fs.writeFileSync(local, raw.split('url("/fonts/').join('url("file://' + fontDir + '/'));
    }
    html = html.split(url).join('file://' + local);
  }
  return html;
}

// ---------------------------------------------------------------- measuring a render
function measure() {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  const view = document.querySelector('.view');
  const layout = document.querySelector('[data-qr-layout]');
  const fb = document.querySelector('[data-qr-fallback]:not(.hidden) svg');
  const img = fb || document.querySelector('img[data-qr-img]');
  const out = { fallback: !!fb, layout: layout && layout.dataset.qrLayout, view: r(view), titleBar: null, qr: null, texts: [], bodyOverflow: false };
  const tb = view.querySelector('.title_bar');
  if (tb) { out.titleBar = r(tb); out.titleBarText = tb.textContent.trim(); out.titleBarImg = !!tb.querySelector('img'); }
  if (img) {
    // the image is square (object-fit default keeps the svg's 1:1 inside); the code itself is the
    // middle 84 %, the outer 8 % on each side is the quiet zone drawn into the image
    const box = r(img);
    const side = Math.min(box.w, box.h);
    const x = box.x + (box.w - side) / 2, y = box.y + (box.h - side) / 2;
    out.image = { x, y, w: side, h: side, r: x + side, b: y + side };
    const modules = fb ? fb.viewBox.baseVal.width / 11 : Number(img.dataset.qrModules);
    const inset = fb ? 0 : 0.08;
    out.qr = { x: x + side * inset, y: y + side * inset, w: side * (1 - 2 * inset), h: side * (1 - 2 * inset), modules };
    out.qr.r = out.qr.x + out.qr.w; out.qr.b = out.qr.y + out.qr.h;
    // the fallback's quiet zone is its box padding
    out.quiet = fb ? (fb.getBoundingClientRect().left - fb.parentElement.getBoundingClientRect().left) : side * 0.08;
  }
  const qbox = document.querySelector('[data-qr-box]');
  if (img && qbox) {
    const b = qbox.getBoundingClientRect();
    // the code fills the box's smaller side (a portrait box is taller than it is wide)
    out.fill = out.image.w / Math.min(b.width, b.height);
  }
  layout.querySelectorAll('.title, .label, [data-qr-body], [data-qr-box] .label').forEach((el) => {
    if (el.closest('.title_bar')) return;
    const b = r(el);
    if (b.w > 0 && b.h > 0) out.texts.push(Object.assign(b, { text: el.textContent.trim().slice(0, 40), cls: el.className }));
  });
  view.querySelectorAll('[data-qr-body]').forEach((box) => {
    const c = box.firstElementChild;
    if (c.scrollHeight > box.clientHeight + 1) out.bodyOverflow = true;
  });
  out.rows = Array.from(view.querySelectorAll('[data-qr-row]')).filter((row) => row.getBoundingClientRect().height > 0).map((row) => {
    const box = row.closest('.content').getBoundingClientRect();
    const name = row.firstElementChild.getBoundingClientRect();
    const price = row.lastElementChild.getBoundingClientRect();
    const column = row.closest('[data-qr-body]').parentElement.getBoundingClientRect();
    return { text: row.textContent.trim(), gapRight: box.right - price.right, apart: price.left - name.right, span: box.width / column.width };
  });
  out.items = Array.from(layout.querySelectorAll('[data-qr-body] li')).filter((li) => li.getBoundingClientRect().height > 0)
    .map((li) => ({ marked: !!li.querySelector('[data-qr-mark]') }));
  out.placeholder = !!document.querySelector('[data-qr-box] .label');
  out.dividers = Array.from(layout.querySelectorAll('.divider, .divider--v')).filter((d) => {
    const b = d.getBoundingClientRect(); return b.width > 0 && b.height > 0;
  }).length;
  const foot = Array.from(layout.querySelectorAll('.label')).find((l) => !l.closest('[data-qr-box]') && !l.dataset.accent);
  if (foot) {
    out.footerWant = foot.textContent.trim();
    // what is visible: a clamp or ellipsis shows as overflowing text
    out.footerText = foot.scrollWidth > foot.clientWidth + 1 || /\u2026|\.\.\.$/.test(foot.innerText) ? foot.innerText.trim() : out.footerWant;
  }
  out.caption = Array.from(layout.querySelectorAll('[data-accent^="bg--"]')).map((e) => e.textContent.trim());
  out.bodyText = Array.from(layout.querySelectorAll('[data-qr-body]')).map((e) => e.textContent.trim()).join(' ');
  out.titleText = Array.from(layout.querySelectorAll('.title:not([data-accent])')).map((e) => e.textContent.trim()).join(' ');
  return out;
}

const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.x, b.x) > 1 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 1;
const inside = (a, b) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.r <= b.r + 1 && a.b <= b.b + 1;

function decode(png) {
  const file = path.join(os.tmpdir(), 'qr-test-' + process.pid + '.png');
  fs.writeFileSync(file, png);
  const res = spawnSync('zbarimg', ['-q', '--raw', '-Sbinary', file], { encoding: 'utf8' });
  // -Sbinary prints the payload as is, without a trailing newline to strip
  return res.status === 0 ? res.stdout : null;
}

// ---------------------------------------------------------------- run
(async () => {
  if (spawnSync('zbarimg', ['--version']).status !== 0) { console.error('zbarimg is needed: apt install zbar-tools'); process.exit(2); }
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: findChrome() });
  let pass = 0, fail = 0, renders = 0;
  const t0 = Date.now();

  for (const c of CASES) {
    for (const [dev, views] of c.matrix) {
      for (const view of views) {
        const name = `${c.name} / ${dev} / ${VIEWS[view][0]}`;
        if (FILTER && !name.includes(FILTER)) continue;
        const errors = [];
        const d = DEVICES[dev];
        const [, fw, fh] = VIEWS[view];
        let html = localize(build(Object.assign({}, BASE, c.fields), c.webhook, c.patch)[view]);
        html = html.replace(/class="screen([^"]*)"/, (m, rest) => `class="screen${rest} ${d.classes}"`);
        if (d.css) html = html.replace('</head>', `<style>${d.css}</style></head>`);
        if (view !== 1) html = html.replace('</head>', `<style>.screen{--full-w:calc(var(--screen-w) * ${fw}) !important;--full-h:calc(var(--screen-h) * ${fh}) !important}</style></head>`);
        const file = path.join(os.tmpdir(), `qr-test-${process.pid}.html`);
        fs.writeFileSync(file, html);

        const page = await browser.newPage({ viewport: { width: d.w, height: d.h } });
        page.on('pageerror', (e) => errors.push('script error: ' + e.message));
        await page.goto('file://' + file, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250); // the template fits text again 100ms after load
        const m = await page.evaluate(measure);
        const png = await page.screenshot();
        await page.close();
        renders++;
        const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        fs.writeFileSync(path.join(SHOTS, slug + '.png'), png);

        const webhookMode = !!c.webhook && c.fields.data_source !== 'settings' || c.fields.data_source === 'webhook';
        const fields = Object.assign({}, webhookMode ? (c.webhook || {}) : Object.assign({}, BASE, c.fields), c.expectFields || {});
        const want = expectedLayout(fields, view);
        if (m.layout !== want) errors.push(`layout is "${m.layout}", expected "${want}"`);

        if (c.payload === null) {
          if (m.qr) errors.push('drew a QR code without payment details');
          if (!m.placeholder) errors.push('no "fill in the payment details" message');
        } else if (!m.qr) {
          errors.push('no QR code drawn');
        } else {
          const got = decode(png);
          if (got === null) errors.push('QR code does not scan');
          // EPC allows CR LF between lines as well as LF
          else if ((c.crlfOk ? got.replace(/\r\n/g, '\n') : got) !== c.payload) errors.push(`QR says ${JSON.stringify(got)}, expected ${JSON.stringify(c.payload)}`);
          // at least 2 device pixels per module, below that phone cameras struggle on e-ink;
          // the viewport is the device's pixel size, so rects are device pixels already
          const px = m.qr.w / m.qr.modules;
          if (px < 2) errors.push(`QR modules are ${px.toFixed(1)}px, too small to scan reliably`);
          if (!inside(m.qr, m.view)) errors.push('QR code sticks out of the view');
          if (m.titleBar && m.qr.b > m.titleBar.y + 1) errors.push('QR code runs under the title bar');
          for (const t of m.texts) if (overlap(t, m.qr)) errors.push(`"${t.text}" overlaps the QR code`);
        }
        for (const t of m.texts) {
          if (!inside(t, m.view)) errors.push(`"${t.text}" sticks out of the view`);
          if (m.titleBar && t.b > m.titleBar.y + 1) errors.push(`"${t.text}" runs under the title bar`);
        }
        if (m.bodyOverflow) errors.push('text overflows its box');
        // the code must fill its box whatever size the filter drew it at
        // a quiet zone: white space between the code and anything else, scanners need it
        if (m.qr && m.quiet !== undefined && m.quiet < 6) errors.push(`QR quiet zone is only ${m.quiet.toFixed(0)}px`);
        // (the inline fallback keeps its quiet zone as padding, so it is exempt)
        if (m.qr && !m.fallback && m.fill !== undefined && m.fill < 0.98) errors.push(`QR fills only ${(m.fill * 100).toFixed(0)}% of its box`);
        if (c.noTitleBar && m.titleBar) errors.push('title bar shown, expected none');
        if (!c.noTitleBar && !m.titleBar) errors.push('no title bar');
        if (c.titleBarIcon && !m.titleBarImg) errors.push('title bar icon not shown');
        if (c.fallback && !m.fallback) errors.push('a broken image did not switch to the inline fallback');
        if (!c.fallback && m.fallback) errors.push('the inline fallback shows although the image is fine');
        if (c.dividers && m.dividers !== c.dividers) errors.push(`${m.dividers} dividers drawn, expected ${c.dividers}`);
        if (m.footerText !== undefined && m.footerText !== m.footerWant) errors.push(`footer reads "${m.footerText}", expected "${m.footerWant}"`);
        if (c.titleBar && m.titleBarText !== c.titleBar) errors.push(`title bar says "${m.titleBarText}", expected "${c.titleBar}"`);
        // lists get a mark (bullet or number) in front of every visible item
        if (m.items.some((i) => !i.marked)) errors.push('a list item has no mark');
        // every row of the example fits the full screen, and no markdown is left unrendered
        if (c.rowCount && view === 1 && dev !== 'og_portrait' && m.rows.length !== c.rowCount) errors.push(`${m.rows.length} price rows, expected ${c.rowCount}`);
        if (/(^|\s)#{1,6} /.test(m.bodyText)) errors.push('raw markdown in the text: ' + JSON.stringify(m.bodyText.slice(0, 60)));
        if (c.priceRows && view !== 4) {
          if (!m.rows.length) errors.push('no price rows drawn');
          for (const row of m.rows) {
            if (row.gapRight > 2) errors.push(`price in "${row.text}" is not right-aligned (${row.gapRight.toFixed(0)}px short)`);
            if (row.apart < 0) errors.push(`price in "${row.text}" overlaps the item`);
            // the list spans its column; a centered column once shrank it to a narrow strip
            if (row.span < 0.9) errors.push(`price list uses only ${(row.span * 100).toFixed(0)}% of its column`);
          }
        }
        if (c.noCaption && m.caption.length) errors.push(`expected no caption, got ${JSON.stringify(m.caption)}`);
        if (c.caption && m.layout && !m.caption.includes(c.caption)) errors.push(`caption is ${JSON.stringify(m.caption)}, expected "${c.caption}"`);
        if (c.expectFields && c.expectFields.title && !m.titleText.includes(c.expectFields.title)) errors.push(`title "${c.expectFields.title}" not shown`);
        // portrait stacks the side-by-side layout: the QR comes first, the text below it
        if (dev === 'og_portrait' && m.layout === 'beside' && m.qr) {
          for (const t of m.texts) if (!t.cls.includes('text--center') && t.y < m.qr.b - 1 && !t.cls.includes('bg--')) errors.push(`"${t.text}" is beside the QR in portrait`);
        }

        if (errors.length) { fail++; console.log(`✗ ${name}\n    ${errors.join('\n    ')}\n    shot: test/shots/${slug}.png`); }
        else { pass++; console.log(`✓ ${name}`); }
      }
    }
  }
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed, ${renders} renders, ${builds.size} builds, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
