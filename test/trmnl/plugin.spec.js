// Render tests for the payment QR plugin on trmnlp-test (https://github.com/ExcuseMi/trmnlp-test).
// Every render checks that the right layout was chosen, that the QR scans to exactly the expected
// payload, and that nothing overflows or covers the code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, matrix, VIEWS } = require('trmnlp-test');
const coffeeShop = require('../../assets/examples/coffee-shop.json');

const BASE = {
  data_source: 'settings', payment_type: 'epc', epc_name: 'Jane Doe', epc_iban: 'BE71 0961 2345 6769', epc_amount: '12.50',
  epc_reference: 'Coffee fund', qr_text: '', title: 'Buy me a coffee', caption: '',
  body: '## Coffee fund\n\nEvery cup is **EUR 0.50**. Pay whenever you like.\n\n- Open your banking app\n- Scan the code',
  footer: 'Thank you!', icon: 'coffee', image_url: '',
};
const epc = (name, iban, amount, ref) => ['BCD', '002', '1', 'SCT', '', name, iban, amount ? 'EUR' + amount : '', '', '', ref].join('\n');
const JANE = epc('Jane Doe', 'BE71096123456769', '12.50', 'Coffee fund');
const NORTHBEAN = epc('Northbean Coffee', 'BE71096123456769', '', 'Northbean Coffee');
const WEBHOOK = { data_source: 'webhook' };
const DEVICES = ['og_plus', 'v2', 'amazon_kindle_2024'];

// the layout the plugin should choose, written from the rules rather than from the template
function expectedLayout(c, view) {
  const hasBody = !!(c.body || '').trim();
  const hasSide = !!(c.title || c.footer || c.image_url || (c.icon && c.icon !== 'none'));
  if (hasBody) return view === 'half_vertical' ? 'stacked' : 'beside';
  if (hasSide && (view === 'half_horizontal' || view === 'quadrant')) return 'beside';
  return 'centered';
}

// checks every render shares: layout, QR, nothing overflowing or on the code, quiet zone, size
async function checkScreen(screen, { content, view, payload }) {
  expect(screen).toRenderCleanly();
  // text stays inside the layout's padded area, not only inside the view: a long title once ran out
  // of its column, and the column grew along with it, so the layout edge is what to compare with
  const outside = await screen.page.evaluate(() => {
    const layout = document.querySelector('[data-qr-layout]');
    const cs = getComputedStyle(layout), l = layout.getBoundingClientRect();
    const zoom = l.width / layout.offsetWidth || 1;
    const right = l.right - parseFloat(cs.paddingRight) * zoom;
    return Array.from(layout.querySelectorAll('.title, .label, [data-qr-fit], [data-qr-body]'))
      // past the layout edge, or wider than its own box (a word that does not fit spills out of it)
      .filter((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && (r.right > right + 1 || t.scrollWidth > t.clientWidth + 1); })
      .map((t) => t.textContent.trim().slice(0, 30));
  });
  expect(outside, 'text spilling out of its box or the layout').toEqual([]);
  await expect(screen.locator('[data-qr-layout]')).toHaveAttribute('data-qr-layout', expectedLayout(content, view));
  await expect(screen).toHaveQr(payload);
  await expect(screen).toHaveNoOverflow();
  // when there is text it keeps a fair share of the space: once only its heading was left
  if ((content.body || '').trim() && view !== 'quadrant') {
    const shown = await screen.page.evaluate(() => (document.querySelector('[data-qr-body]') || {}).innerText || '');
    expect(shown.replace(/\s+/g, ' ').trim().length, 'visible text length').toBeGreaterThanOrEqual(Math.min(40, content.body.length));
  }
  if (payload === null) return;
  await expect(screen).toHaveNoOverlap('.title, .label, [data-qr-body]', '[data-qr-box]');
  // the code has modules of at least 2 device px, fills the padded area of its box, and keeps the
  // box padding as its quiet zone (module size 40 in the template: viewBox width / 40 = modules)
  const g = await screen.page.evaluate(() => {
    const svg = document.querySelector('svg.qr-code');
    const boxEl = document.querySelector('[data-qr-box]');
    const box = boxEl.getBoundingClientRect(), r = svg.getBoundingClientRect(), cs = getComputedStyle(boxEl);
    const zoom = box.width / boxEl.offsetWidth || 1;
    const pad = parseFloat(cs.paddingLeft) * zoom;
    const side = Math.min(r.width, r.height);
    return { module: side / (svg.viewBox.baseVal.width / 40), fill: side / (Math.min(box.width, box.height) - 2 * pad),
      quiet: Math.min(r.left - box.left, box.right - r.right, r.top - box.top) };
  });
  expect(g.module, 'QR module size in px').toBeGreaterThanOrEqual(2);
  expect(g.fill, 'share of its box the code fills').toBeGreaterThanOrEqual(0.98);
  expect(g.quiet, 'quiet zone in px').toBeGreaterThanOrEqual(6);
}

// ---------------------------------------------------------------- layouts across devices and views
const CONTENT = {
  everything: {},
  'no text': { body: '' },
  'qr only': { body: '', title: '', footer: '', icon: 'none' },
  // a link has no default caption: in a short view that once sized the QR above 100 % and collapsed it
  'link without caption': { payment_type: 'text', qr_text: 'https://paypal.me/yourname' },
  'long text': { body: '# Club membership\n\n' + Array(24).fill('Pay your yearly membership before the end of the month.').join(' ') + '\n\n- One\n- Two' },
};
for (const [name, fields] of Object.entries(CONTENT)) {
  for (const s of matrix({ device: DEVICES, view: VIEWS })) {
    test(`${name} · ${s.label}`, async ({ trmnl }) => {
      const content = { ...BASE, ...fields };
      const screen = await trmnl.render({ ...s, fields: content });
      await checkScreen(screen, { content, view: s.view, payload: content.payment_type === 'text' ? content.qr_text : JANE });
    });
  }
}
for (const s of matrix({ device: ['og_plus'], orientation: ['portrait'], view: ['full'] })) {
  test(`portrait stacks the side-by-side layout · ${s.label}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ ...s, fields: BASE });
    await checkScreen(screen, { content: BASE, view: 'full', payload: JANE });
    const qr = await screen.box('[data-qr-box]');
    const title = await screen.box('[data-qr-layout] .title.title--large');
    expect(title.y, 'title below the QR').toBeGreaterThanOrEqual(qr.y + qr.height - 1);
  });
}

// ---------------------------------------------------------------- big screens give the text room
for (const s of matrix({ device: ['v2'], view: ['full'] })) {
  test(`large screen caps the code beside text · ${s.label}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ ...s, fields: WEBHOOK, webhook: coffeeShop });
    await checkScreen(screen, { content: coffeeShop.merge_variables.payment, view: 'full', payload: NORTHBEAN });
    const qr = await screen.box('[data-qr-box]');
    const layout = await screen.box('[data-qr-layout]');
    const text = await screen.box('[data-qr-body]');
    expect(qr.height / layout.height, 'code height share').toBeLessThanOrEqual(0.62);
    expect(text.width / layout.width, 'text column width share').toBeGreaterThanOrEqual(0.4);
  });
}
test('large screen keeps the full code without text', async ({ trmnl }) => {
  const content = { ...BASE, body: '' };
  const screen = await trmnl.render({ device: 'v2', fields: content });
  await checkScreen(screen, { content, view: 'full', payload: JANE });
  const qr = await screen.box('[data-qr-box]');
  const layout = await screen.box('[data-qr-layout]');
  expect(qr.height / layout.height).toBeGreaterThan(0.62);
});

// ---------------------------------------------------------------- the coffee shop price list
for (const s of matrix({ device: DEVICES, view: VIEWS })) {
  test(`price list · ${s.label}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ ...s, fields: WEBHOOK, webhook: coffeeShop });
    await checkScreen(screen, { content: coffeeShop.merge_variables.payment, view: s.view, payload: NORTHBEAN });
    if (s.view === 'quadrant') return;
    // prices on the right edge of a list that spans its column; every item has a mark
    const rows = await screen.page.evaluate(() => Array.from(document.querySelectorAll('[data-qr-row]')).map((row) => {
      const content = row.closest('.content').getBoundingClientRect();
      const column = row.closest('[data-qr-body]').parentElement.getBoundingClientRect();
      const price = row.lastElementChild.getBoundingClientRect();
      return { gap: content.right - price.right, span: content.width / column.width, marked: !!row.closest('li').querySelector('[data-qr-mark]') };
    }));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.gap, 'price right-aligned').toBeLessThanOrEqual(2);
      expect(r.span, 'list spans its column').toBeGreaterThanOrEqual(0.9);
      expect(r.marked, 'list item has a mark').toBe(true);
    }
    if (s.view === 'full') await expect(screen.locator('[data-qr-row]')).toHaveCount(7);
    await expect(screen).toShowText('Thank you!');
  });
}

// ---------------------------------------------------------------- dark mode and color
// Framework 3's dark mode remaps the framework's colours; the inline code keeps its own black on
// white, so the box behind it (the quiet zone) must stay white too or scanners lose the code.
for (const s of matrix({ device: ['og_plus', 'v2'], view: ['full', 'quadrant'], darkMode: [true] })) {
  test(`dark mode: the code keeps a white quiet zone and scans · ${s.label}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ ...s, fields: BASE });
    expect(screen).toRenderCleanly();
    await expect(screen).toHaveNoOverflow();
    await expect(screen).toHaveQr(JANE);
  });
}
test('color panel: red accent on the caption', async ({ trmnl }) => {
  const screen = await trmnl.render({ device: 'og_bwry', fields: BASE });
  await checkScreen(screen, { content: BASE, view: 'full', payload: JANE });
  await expect(screen.locator('[data-accent^="bg--"]')).toHaveClass(/bg--red/);
});
test('classic fonts', async ({ trmnl }) => {
  const screen = await trmnl.render({ fonts: 'classic', fields: BASE });
  await checkScreen(screen, { content: BASE, view: 'full', payload: JANE });
});

// ---------------------------------------------------------------- payload and caption rules
const PAYLOADS = [
  ['amount open', { epc_amount: '' }, epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), 'Any amount'],
  ['amount zero is open', { epc_amount: '0' }, epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), 'Any amount'],
  ['amount comma', { epc_amount: '7,5' }, epc('Jane Doe', 'BE71096123456769', '7.50', 'Coffee fund'), '€7.50'],
  ['amount not a number', { epc_amount: 'abc' }, epc('Jane Doe', 'BE71096123456769', '', 'Coffee fund'), 'Any amount'],
  ['big amount', { epc_amount: '1234.5' }, epc('Jane Doe', 'BE71096123456769', '1234.50', 'Coffee fund'), '€1,234.50'],
  ['iban cleanup', { epc_iban: 'be71 0961 2345 6769 ' }, JANE, '€12.50'],
  ['name limit', { epc_name: 'N'.repeat(90) }, epc('N'.repeat(70), 'BE71096123456769', '12.50', 'Coffee fund'), '€12.50'],
  ['reference limit', { epc_reference: 'R'.repeat(200) }, epc('Jane Doe', 'BE71096123456769', '12.50', 'R'.repeat(140)), '€12.50'],
  ['own caption', { caption: 'Scan to pay' }, JANE, 'Scan to pay'],
  ['link', { payment_type: 'text', qr_text: ' https://paypal.me/jane/5 ' }, 'https://paypal.me/jane/5', null],
  ['bancontact fixed amount', { payment_type: 'bancontact', bc_profile_id: '5bb37284e35e2b29e363df22', epc_amount: '2.40', epc_reference: 'Espresso', title: 'Northbean Coffee' },
    'https://pay.bancontact.net/t/1/5bb37284e35e2b29e363df22?D=Northbean%20Coffee&A=240&R=Espresso', 'Pay €2.40 with Bancontact'],
  ['bancontact open amount', { payment_type: 'bancontact', bc_profile_id: '5bb37284e35e2b29e363df22', epc_amount: '', epc_reference: '', title: '' },
    'https://pay.bancontact.net/t/1/5bb37284e35e2b29e363df22', 'Pay with Bancontact'],
  ['bancontact encodes and caps D and R', { payment_type: 'bancontact', bc_profile_id: 'abc123', epc_amount: '0', epc_reference: 'Invoice #12 & co', title: 'Café Brussel: the coffee corner on the first floor' },
    'https://pay.bancontact.net/t/1/abc123?D=Caf%C3%A9%20Brussel%3A%20the%20coffee%20corner%20on&R=Invoice%20%2312%20%26%20co', 'Pay with Bancontact'],
];
for (const [name, fields, payload, caption] of PAYLOADS) {
  test(`payload · ${name}`, async ({ trmnl }) => {
    const content = { ...BASE, ...fields };
    const screen = await trmnl.render({ fields: content });
    await checkScreen(screen, { content, view: 'full', payload });
    const captions = screen.locator('[data-accent^="bg--"]');
    if (caption) await expect(captions).toHaveText(caption);
    else await expect(captions).toHaveCount(0);
  });
}
for (const [name, fields] of [['no IBAN', { epc_iban: '' }], ['no name', { epc_name: '' }], ['bancontact without profile', { payment_type: 'bancontact', bc_profile_id: '' }]]) {
  test(`missing payment details · ${name}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ fields: { ...BASE, ...fields } });
    await expect(screen).toHaveQr(null);
    await expect(screen).toShowText('Fill in the payment details in the plugin settings');
  });
}

// ---------------------------------------------------------------- the account language
const LOCALES = [
  ['nl', { epc_amount: '1234.5' }, '€ 1.234,50'],
  ['fr', { epc_amount: '' }, 'Montant libre'],
  ['de-DE', { payment_type: 'bancontact', bc_profile_id: 'abc123', epc_amount: '3', epc_reference: '', title: '' }, '3,00 € mit Bancontact bezahlen'],
];
for (const [locale, fields, caption] of LOCALES) {
  test(`language · ${locale}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ locale, fields: { ...BASE, ...fields } });
    await expect(screen.locator('[data-accent^="bg--"]')).toHaveText(caption);
  });
}
test('language · Dutch message when nothing is set', async ({ trmnl }) => {
  const screen = await trmnl.render({ locale: 'nl', fields: { ...BASE, epc_iban: '' } });
  await expect(screen).toShowText('Vul de betaalgegevens in bij de plugin-instellingen');
});

// ---------------------------------------------------------------- data source and webhook
test('webhook data is used in webhook mode', async ({ trmnl }) => {
  const screen = await trmnl.render({ fields: { ...BASE, ...WEBHOOK }, webhook: { merge_variables: { payment: { ...BASE, epc_amount: '42', epc_reference: 'Pizza', title: 'Pizza night' } } } });
  await expect(screen).toHaveQr(epc('Jane Doe', 'BE71096123456769', '42.00', 'Pizza'));
  await expect(screen).toShowText('Pizza night');
});
test('webhook mode ignores the (hidden) settings', async ({ trmnl }) => {
  const screen = await trmnl.render({ fields: { ...BASE, ...WEBHOOK }, webhook: { merge_variables: { payment: { title: 'Only a title' } } } });
  await expect(screen).toHaveQr(null);
  await expect(screen).toShowText('Send the payment details to the webhook');
  await expect(screen).toShowText('Only a title');
});
test('webhook mode, nothing sent yet', async ({ trmnl }) => {
  const screen = await trmnl.render({ fields: { ...BASE, ...WEBHOOK } });
  await expect(screen).toHaveQr(null);
  await expect(screen).toShowText('Send the payment details to the webhook');
});
test('settings mode ignores webhook data', async ({ trmnl }) => {
  const screen = await trmnl.render({ fields: BASE, webhook: { merge_variables: { payment: { ...BASE, title: 'From webhook', epc_amount: '42' } } } });
  await expect(screen).toHaveQr(JANE);
  await expect(screen).toShowText('Buy me a coffee');
});
test('a session: data posted later replaces the earlier post', async ({ trmnl }) => {
  const s = trmnl.session({ fields: { ...BASE, ...WEBHOOK } });
  await s.webhook({ merge_variables: { payment: { ...BASE, epc_amount: '1' } } });
  await s.webhook({ merge_variables: { payment: { ...BASE, epc_amount: '2' } } });
  const screen = await s.render();
  await expect(screen).toHaveQr(epc('Jane Doe', 'BE71096123456769', '2.00', 'Coffee fund'));
});

// ---------------------------------------------------------------- title bar
test('title bar text, icon and default', async ({ trmnl }) => {
  const icon = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>').toString('base64');
  let screen = await trmnl.render({ fields: { ...BASE, title_bar: 'Pay at the counter', title_bar_icon: icon } });
  await expect(screen.locator('.title_bar .title')).toHaveText('Pay at the counter');
  await expect(screen.locator('.title_bar img')).toHaveCount(1);
  screen = await trmnl.render({ fields: BASE });
  await expect(screen.locator('.title_bar .title')).toHaveText(/\S/);
});
for (const flag of [false, 'false', 'no']) {
  test(`title bar hidden by ${JSON.stringify(flag)}`, async ({ trmnl }) => {
    const screen = await trmnl.render({ fields: { ...BASE, ...WEBHOOK }, webhook: { merge_variables: { payment: { ...BASE, show_title_bar: flag } } } });
    await expect(screen.locator('.title_bar')).toHaveCount(0);
    await expect(screen).toHaveQr(JANE);
  });
}

// ---------------------------------------------------------------- what TRMNL's server does differently
// trmnlp-test runs trmnlp's code; these patch a copy of the plugin to behave the way TRMNL did.
// Seen on trmnl.com (2026-10-02): the server's qr_code returns, with or without "responsive",
//   <svg width="N" height="N" style="max-width:100%;height:auto" ... viewBox="0 0 N N">
// where trmnlp's has only the viewBox; and the web editor's preview made the template's newline CR LF.
function patchedPlugin(name, patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qr-${name}-`));
  fs.cpSync(path.join(__dirname, '../../plugin'), dir, { recursive: true });
  const file = path.join(dir, 'src/shared.liquid');
  const before = fs.readFileSync(file, 'utf8');
  const after = patch(before);
  if (after === before) throw new Error(`the ${name} patch changed nothing: update it to the template`);
  fs.writeFileSync(file, after);
  return dir;
}
const SERVER = {
  // the server's svg: its natural width/height plus max-width:100%, so it shrinks but never grows;
  // module size 40 makes it larger than any box, so it still fills
  "server's qr_code svg": (s) => s.replace('{{ payload | qr_code: 40, level }}',
    "{{ payload | qr_code: 40, level | replace_first: '<svg ', '<svg width=\"1480\" height=\"1480\" style=\"max-width:100%;height:auto\" ' }}"),
  // the web editor's preview made the template's newline CR LF, so it never split webhook text
  'CRLF line endings': (s) => s.replace(/\r?\n/g, '\r\n'),
};
for (const [name, patch] of Object.entries(SERVER)) {
  test(`server variant · ${name}`, async ({ trmnl }) => {
    const plugin = trmnl.plugin(patchedPlugin(name.replace(/\W+/g, '-'), patch));
    const screen = await plugin.render({ fields: WEBHOOK, webhook: coffeeShop });
    const payload = await screen.qr();
    expect((payload || '').replace(/\r\n/g, '\n')).toBe(NORTHBEAN);
    await expect(screen.locator('[data-qr-row]')).toHaveCount(7);
  });
}

test('dividers between QR and text, under the title, above the footer, and for markdown ---', async ({ trmnl }) => {
  let screen = await trmnl.render({ fields: BASE });
  await expect(screen.locator('[data-qr-layout] .divider:visible, [data-qr-layout] .divider--v:visible')).toHaveCount(3);
  screen = await trmnl.render({ fields: { ...BASE, body: '## Coffee\n\n- Espresso | €2.40\n\n---\n\n## Tea\n\n- Green tea | €2.20' } });
  await expect(screen.locator('[data-qr-body] .divider:not([data-qr-leader])')).toHaveCount(1);
});

test('a single word too long for a quarter view shrinks, then is cut', async ({ trmnl }) => {
  const content = { ...BASE, title: 'Supercalifragilisticexpialidocious', body: '' };
  const screen = await trmnl.render({ device: 'v2', view: 'quadrant', fields: content });
  await checkScreen(screen, { content, view: 'quadrant', payload: JANE });
  await expect(screen.locator('[data-qr-fit]').first()).toContainText('Supercali');
});

test('passes trmnlp lint', async ({ trmnl }) => {
  expect(await trmnl.lint()).toPassLint();
});
