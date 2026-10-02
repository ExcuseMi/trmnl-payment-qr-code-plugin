#!/usr/bin/env node
// Pure-logic tests for plugin/src/transform.js: no browser, runs in milliseconds.
'use strict';
const assert = require('assert');
const { run, amountOf, priceRows, flag } = require('../plugin/src/transform.js');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('✓ ' + name); }
  catch (e) { fail++; console.log('✗ ' + name + '\n    ' + e.message.split('\n').join('\n    ')); }
}
const settings = (cf, extra) => Object.assign({ trmnl: { plugin_settings: { instance_name: 'My QR', custom_fields_values: cf } } }, extra);
const qrOf = async (input) => (await run(input)).qr;
const EPC = (name, iban, amount, ref) => ['BCD', '002', '1', 'SCT', '', name, iban, amount ? 'EUR' + amount : '', '', '', ref].join('\n');
const JANE = { epc_name: 'Jane', epc_iban: 'be71 0961 2345 6769' };

(async () => {
  await test('settings: EPC payload, IBAN cleaned up, amount formatted', async () => {
    const q = await qrOf(settings(Object.assign({ epc_amount: '7,5', epc_reference: 'Coffee' }, JANE)));
    assert.strictEqual(q.payload, EPC('Jane', 'BE71096123456769', '7.50', 'Coffee'));
    assert.strictEqual(q.caption, 'EUR 7.50');
    assert.strictEqual(q.webhook_mode, false);
  });
  await test('amount: empty, zero and garbage let the payer choose', async () => {
    for (const a of ['', '0', 'abc', '-3', null, undefined]) assert.strictEqual(amountOf(a), '', JSON.stringify(a));
    assert.strictEqual(amountOf('12.345'), '12.35');
    assert.strictEqual(amountOf(3), '3.00');
    const q = await qrOf(settings(Object.assign({ epc_amount: '0' }, JANE)));
    assert.strictEqual(q.caption, 'Any amount');
  });
  await test('big amounts get a thousands separator in the caption only', async () => {
    const q = await qrOf(settings(Object.assign({ epc_amount: '1234.5' }, JANE)));
    assert.strictEqual(q.caption, 'EUR 1,234.50');
    assert.ok(q.payload.includes('\nEUR1234.50\n'));
  });
  await test('name and reference are cut to the EPC limits', async () => {
    const q = await qrOf(settings({ epc_name: 'N'.repeat(90), epc_iban: 'BE71096123456769', epc_reference: 'R'.repeat(200) }));
    const lines = q.payload.split('\n');
    assert.strictEqual(lines[5].length, 70);
    assert.strictEqual(lines[10].length, 140);
  });
  await test('no name or no IBAN: no payload and no caption, a message instead', async () => {
    for (const cf of [{ epc_name: 'Jane' }, { epc_iban: 'BE71096123456769' }, {}]) {
      const q = await qrOf(settings(cf));
      assert.strictEqual(q.payload, '');
      assert.strictEqual(q.caption, '');
      assert.ok(/plugin settings/.test(q.missing));
    }
  });
  await test('link type encodes the text as is and has no default caption', async () => {
    const q = await qrOf(settings({ payment_type: 'text', qr_text: ' https://paypal.me/jane/5 ' }));
    assert.strictEqual(q.payload, 'https://paypal.me/jane/5');
    assert.strictEqual(q.caption, '');
  });
  await test('settings mode ignores webhook data', async () => {
    const q = await qrOf(settings(Object.assign({ data_source: 'settings', title: 'From settings' }, JANE), { payment: { title: 'From webhook' } }));
    assert.strictEqual(q.title, 'From settings');
  });
  await test('webhook mode uses only the webhook, never the hidden settings', async () => {
    const q = await qrOf(settings(Object.assign({ data_source: 'webhook', title: 'Stale', footer: 'Stale' }, JANE), { payment: { title: 'Fresh' } }));
    assert.strictEqual(q.title, 'Fresh');
    assert.strictEqual(q.footer, '');
    assert.strictEqual(q.payload, '');
    assert.ok(/webhook/.test(q.missing));
  });
  await test('webhook mode with nothing sent yet', async () => {
    const q = await qrOf(settings({ data_source: 'webhook' }));
    assert.strictEqual(q.payload, '');
    assert.strictEqual(q.webhook_mode, true);
  });
  await test('title bar: shown by default with the plugin name', async () => {
    const q = await qrOf(settings(JANE));
    assert.deepStrictEqual(q.title_bar, { show: true, text: 'My QR', icon_url: '' });
  });
  await test('title bar: text, icon and visibility from the webhook', async () => {
    const q = await qrOf(settings({ data_source: 'webhook' }, { payment: { title_bar: 'Northbean', title_bar_icon: 'https://x/i.png', show_title_bar: false } }));
    assert.deepStrictEqual(q.title_bar, { show: false, text: 'Northbean', icon_url: 'https://x/i.png' });
  });
  await test('flags accept the shapes settings and webhooks send', async () => {
    for (const v of [true, 'true', 'yes', '1', 1]) assert.strictEqual(flag(v, false), true);
    for (const v of [false, 'false', 'no', '0', 0]) assert.strictEqual(flag(v, true), false);
    assert.strictEqual(flag(undefined, true), true);
    assert.strictEqual(flag('', true), true);
  });
  await test('price rows: list and plain lines, other lines untouched', async () => {
    const out = priceRows('## Coffee\n- Espresso | €2.40\nTea | 2\n* A | B | C\nplain').split('\n');
    assert.strictEqual(out[0], '## Coffee');
    assert.ok(out[1].startsWith('- <span') && out[1].includes('<span>Espresso</span>') && out[1].includes('>€2.40</span>'));
    assert.ok(out[2].startsWith('<span') && out[2].includes('<span>Tea</span>'));
    assert.ok(out[3].startsWith('* <span') && out[3].includes('<span>A</span>') && out[3].includes('>C</span>'));
    assert.strictEqual(out[4], 'plain');
  });
  await test('icon and image: has_visual follows either', async () => {
    assert.strictEqual((await qrOf(settings(JANE))).has_visual, false);
    assert.strictEqual((await qrOf(settings(Object.assign({ icon: 'coffee' }, JANE)))).has_visual, true);
    assert.strictEqual((await qrOf(settings(Object.assign({ image_url: 'https://x/l.png' }, JANE)))).has_visual, true);
  });
  await test('passes the webhook data through, so the editor can load it back', async () => {
    const sent = { title: 'Fresh', epc_amount: '2.40' };
    const out = await run(settings({ data_source: 'webhook' }, { payment: sent }));
    assert.deepStrictEqual(out.payment, sent);
    assert.strictEqual('payment' in (await run(settings(JANE))), false);
  });
  await test('survives an empty input', async () => {
    const q = (await run(undefined)).qr;
    assert.strictEqual(q.payload, '');
    assert.strictEqual(q.title_bar.text, 'Payment QR Code');
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
