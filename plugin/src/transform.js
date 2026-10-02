// Serverless transform: runs on TRMNL before every render, for settings and webhook data alike.
// It decides everything that does not depend on the screen (source, QR payload, captions, price
// rows, title bar) and hands the template one `qr` object; the template only does the layout.

// One source at a time. "settings" reads the form fields and ignores webhook data; "webhook" reads
// only what was sent, because the form fields are hidden then and stale values must not leak in.
function pickSource(input) {
  const cf = (input.trmnl && input.trmnl.plugin_settings && input.trmnl.plugin_settings.custom_fields_values) || {};
  const webhookMode = cf.data_source === 'webhook';
  const sent = input.payment && typeof input.payment === 'object' ? input.payment : {};
  return { webhookMode, src: webhookMode ? sent : cf };
}

function text(v) { return v == null ? '' : String(v).trim(); }

function flag(v, fallback) {
  if (v === true || v === 'true' || v === 'yes' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === 'no' || v === '0' || v === 0) return false;
  return fallback;
}

// "12,5" -> "12.50"; empty, zero or not a number -> "" (the payer chooses)
function amountOf(v) {
  const n = Math.round(Number(text(v).replace(',', '.')) * 100) / 100;
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
}

function euro(amount) {
  const [whole, cents] = amount.split('.');
  return 'EUR ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + cents;
}

// EPC QR (European Payments Council, version 002): read by most European banking apps
function epcPayload(name, iban, amount, reference) {
  if (!name || !iban) return '';
  return ['BCD', '002', '1', 'SCT', '', name, iban, amount ? 'EUR' + amount : '', '', '', reference].join('\n');
}

// "- Espresso | €2.40" becomes a row with the price on the right. Markdown passes inline HTML
// through, so the rest of the line stays markdown.
function priceRows(body) {
  if (!body.includes(' | ')) return body;
  return body.split('\n').map((line) => {
    const l = line.replace(/\s+$/, '');
    if (!l.includes(' | ')) return l;
    const lead = /^[-*] /.test(l) ? l.slice(0, 2) : '';
    const parts = l.slice(lead.length).split(' | ');
    const item = parts[0].trim();
    const price = parts[parts.length - 1].trim();
    return lead + '<span class="flex flex--row flex--between gap--small w--full" data-qr-row><span>' + item
      + '</span><span class="shrink-0" data-qr-price>' + price + '</span></span>';
  }).join('\n');
}

function build(input) {
  const { webhookMode, src } = pickSource(input);
  const settings = (input.trmnl && input.trmnl.plugin_settings) || {};
  const paymentType = text(src.payment_type) === 'text' ? 'text' : 'epc';

  let payload = '';
  let amount = '';
  if (paymentType === 'epc') {
    amount = amountOf(src.epc_amount);
    payload = epcPayload(text(src.epc_name).slice(0, 70), text(src.epc_iban).replace(/\s+/g, '').toUpperCase(),
      amount, text(src.epc_reference).slice(0, 140));
  } else {
    payload = text(src.qr_text);
  }

  let caption = text(src.caption);
  if (!caption && paymentType === 'epc' && payload) caption = amount ? euro(amount) : 'Any amount';

  const icon = text(src.icon) || 'none';
  const imageUrl = text(src.image_url);
  return {
    webhook_mode: webhookMode,
    payload,
    caption,
    title: text(src.title),
    body: priceRows(text(src.body)),
    footer: text(src.footer),
    icon,
    image_url: imageUrl,
    has_visual: !!imageUrl || icon !== 'none',
    missing: webhookMode ? 'Send the payment details to the webhook' : 'Fill in the payment details in the plugin settings',
    title_bar: {
      show: flag(src.show_title_bar, true),
      text: text(src.title_bar) || text(settings.instance_name) || 'Payment QR Code',
      icon_url: text(src.title_bar_icon),
    },
  };
}

// TRMNL stores what run() returns in place of the webhook data, so hand the sent `payment` back
// unchanged: the web editor reads it to load what is on the screen now
async function run(input) {
  const out = { qr: build(input || {}) };
  if (input && input.payment && typeof input.payment === 'object') out.payment = input.payment;
  return out;
}

// lets test/transform.test.js load this file in plain Node; TRMNL only calls run()
if (typeof module !== 'undefined') module.exports = { run, build, amountOf, epcPayload, priceRows, flag };
