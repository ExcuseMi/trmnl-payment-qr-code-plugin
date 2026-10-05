# frozen_string_literal: true

# Render tests for the payment QR plugin, run with `trmnlp test` (see ../../test.sh).
# Every render checks that the right layout was chosen, that the QR scans to exactly the expected
# payload, and that nothing overflows or covers the code.
require 'json'
require 'fileutils'
require 'open3'
require 'tmpdir'

module PaymentQr
  BASE = {
    data_source: 'settings', payment_type: 'epc', epc_name: 'Jane Doe', epc_iban: 'BE71 0961 2345 6769',
    epc_amount: '12.50', epc_reference: 'Coffee fund', qr_text: '', title: 'Buy me a coffee', show_caption: true,
    caption: '',
    body: "## Coffee fund\n\nEvery cup is **EUR 0.50**. Pay whenever you like.\n\n- Open your banking app\n- Scan the code",
    footer: 'Thank you!', icon: 'coffee', image_url: ''
  }.freeze
  WEBHOOK = { data_source: 'webhook' }.freeze
  DEVICES = %w[og_plus v2 amazon_kindle_2024].freeze
  VIEWS = %w[full half_horizontal half_vertical quadrant].freeze
  COFFEE_SHOP = JSON.parse(File.read(File.expand_path('../../assets/examples/coffee-shop.json', __dir__)),
                           symbolize_names: true).fetch(:merge_variables).freeze
  CAPTION = '[data-accent^="bg--"]'

  def self.epc(name, iban, amount, ref)
    ['BCD', '002', '1', 'SCT', '', name, iban, amount.empty? ? '' : "EUR#{amount}", '', '', ref].join("\n")
  end
  JANE = epc('Jane Doe', 'BE71096123456769', '12.50', 'Coffee fund')
  NORTHBEAN = epc('Northbean Coffee', 'BE71096123456769', '', 'Northbean Coffee')

  # elements drawn past their view (a mashup slot is smaller than the screen) or past a box that hides
  # its overflow. trmnlp's own have_no_overflow compares scrollHeight with clientHeight instead, which
  # also counts the empty space a font keeps under its line: it reports the caption where nothing is cut
  CUT_OFF = <<~JS
    (() => {
      const past = (r, b) => r.right > b.right + 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.top < b.top - 1;
      return [...document.querySelectorAll('.view *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if ((r.width === 0 && r.height === 0) || (el.closest('svg') && el.tagName !== 'svg')) return false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const view = a.classList.contains('view'), s = getComputedStyle(a);
          if ((view || ['hidden', 'clip'].includes(s.overflowX) || ['hidden', 'clip'].includes(s.overflowY)) && past(r, a.getBoundingClientRect())) return true;
          if (view) return false;
        }
        return false;
      }).map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.'));
    })()
  JS
  # text past the layout's padded edge, or wider than its own box (a word that does not fit spills out
  # of it). A long title once ran out of its column, and the column grew along with it, so the layout
  # edge is what to compare with, not only the view
  SPILLING = <<~JS
    (() => {
      const layout = document.querySelector('[data-qr-layout]');
      const cs = getComputedStyle(layout), l = layout.getBoundingClientRect();
      const zoom = l.width / layout.offsetWidth || 1;
      const right = l.right - parseFloat(cs.paddingRight) * zoom;
      return Array.from(layout.querySelectorAll('.title, .label, [data-qr-fit], [data-qr-body]'))
        .filter((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && (r.right > right + 1 || t.scrollWidth > t.clientWidth + 1); })
        .map((t) => t.textContent.trim().slice(0, 30));
    })()
  JS
  # text boxes that touch the code's box
  ON_THE_CODE = <<~JS
    (() => {
      const q = document.querySelector('[data-qr-box]').getBoundingClientRect();
      return Array.from(document.querySelectorAll('.view .title, .view .label, [data-qr-body]'))
        .filter((t) => { const r = t.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.left < q.right - 0.5 && r.right > q.left + 0.5 && r.top < q.bottom - 0.5 && r.bottom > q.top + 0.5; })
        .map((t) => t.textContent.trim().slice(0, 30));
    })()
  JS
  # module size in px, the share of its box's padded area the code fills, and the quiet zone the box
  # padding leaves (module size 40 in the template: viewBox width / 40 = modules)
  GEOMETRY = <<~JS
    (() => {
      const svg = document.querySelector('svg.qr-code');
      const boxEl = document.querySelector('[data-qr-box]');
      const box = boxEl.getBoundingClientRect(), r = svg.getBoundingClientRect(), cs = getComputedStyle(boxEl);
      const zoom = box.width / boxEl.offsetWidth || 1;
      const pad = parseFloat(cs.paddingLeft) * zoom;
      const side = Math.min(r.width, r.height);
      return { module: side / (svg.viewBox.baseVal.width / 40), fill: side / (Math.min(box.width, box.height) - 2 * pad),
        quiet: Math.min(r.left - box.left, box.right - r.right, r.top - box.top) };
    })()
  JS
  # the price rows of a list: the price's distance from the right edge, the list's share of its column, the mark
  PRICE_ROWS = <<~JS
    Array.from(document.querySelectorAll('[data-qr-row]')).map((row) => {
      const content = row.closest('.content').getBoundingClientRect();
      const column = row.closest('[data-qr-body]').parentElement.getBoundingClientRect();
      const price = row.lastElementChild.getBoundingClientRect();
      return { gap: content.right - price.right, span: content.width / column.width, marked: !!row.closest('li').querySelector('[data-qr-mark]') };
    })
  JS

  module Helpers
    # the layout the plugin should choose, written from the rules rather than from the template
    def expected_layout(content, view)
      has_body = !content[:body].to_s.strip.empty?
      has_side = [content[:title], content[:footer], content[:image_url]].any? { !it.to_s.empty? } ||
                 !['', 'none'].include?(content[:icon].to_s)
      return view == 'half_vertical' ? 'stacked' : 'beside' if has_body
      return 'beside' if has_side && %w[half_horizontal quadrant].include?(view)

      'centered'
    end

    # what a scanner reads in the device picture: the code's text, or nil when there is none
    def scan(screen)
      out, status = Open3.capture2('zbarimg', '--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', screen.png_path)
      status.success? ? out.force_encoding('UTF-8').delete_suffix("\n") : nil
    end

    def expect_clean(screen)
      expect(screen).to have_no_problems
      expect(screen).to have_no_text('Liquid error')
      cut = screen.evaluate(CUT_OFF)
      expect(cut).to be_empty, "cut off or outside their view: #{cut.join(', ')}"
    end

    # checks every render shares: layout, QR, nothing overflowing or on the code, quiet zone, size
    def check_screen(screen, content:, view:, payload:)
      expect_clean(screen)
      spilling = screen.evaluate(SPILLING)
      expect(spilling).to be_empty, "text spilling out of its box or the layout: #{spilling.join(', ')}"
      expect(screen).to have_css("[data-qr-layout='#{expected_layout(content, view)}']")
      expect(scan(screen)).to eq(payload)
      check_text_share(screen, content, view)
      return if payload.nil?

      covering = screen.evaluate(ON_THE_CODE)
      expect(covering).to be_empty, "text on the code: #{covering.join(', ')}"
      geometry = screen.evaluate(GEOMETRY)
      expect(geometry['module']).to be >= 2, "QR modules of #{geometry['module']} px"
      expect(geometry['fill']).to be >= 0.98, "the code fills #{geometry['fill']} of its box"
      expect(geometry['quiet']).to be >= 6, "quiet zone of #{geometry['quiet']} px"
    end

    # when there is text it keeps a fair share of the space: once only its heading was left
    def check_text_share(screen, content, view)
      body = content[:body].to_s
      return if body.strip.empty? || view == 'quadrant'

      shown = screen.evaluate("(document.querySelector('[data-qr-body]') || {}).innerText || ''")
      expect(shown.gsub(/\s+/, ' ').strip.length).to be >= [40, body.length].min, 'visible text length'
    end

    # a copy of the plugin with shared.liquid changed, for what TRMNL does differently from trmnlp
    def patched_plugin
      dir = Dir.mktmpdir('payment-qr-')
      FileUtils.cp_r(File.join(TRMNLP::Testing.plugin_dir, '.'), dir)
      file = File.join(dir, 'src/shared.liquid')
      before = File.binread(file)
      after = yield before
      raise 'the patch changed nothing: update it to the template' if after == before

      File.binwrite(file, after)
      trmnl.plugin(dir)
    end
  end
end

RSpec.describe 'Payment QR Code' do
  include PaymentQr::Helpers

  base = PaymentQr::BASE
  webhook = PaymentQr::WEBHOOK
  jane = PaymentQr::JANE
  northbean = PaymentQr::NORTHBEAN
  coffee_shop = PaymentQr::COFFEE_SHOP
  caption_css = PaymentQr::CAPTION

  # trmnlp's own checks before publishing: every view on TRMNL's devices without overflow or page errors
  let(:custom_fields) { base }
  it_behaves_like 'a publishable recipe'

  describe 'layouts across devices and views' do
    {
      'everything' => {},
      'no text' => { body: '' },
      'qr only' => { body: '', title: '', footer: '', icon: 'none' },
      # a link has no default caption: in a short view that once sized the QR above 100 % and collapsed it
      'link without caption' => { payment_type: 'text', qr_text: 'https://paypal.me/yourname' },
      'long text' => { body: "# Club membership\n\n#{(['Pay your yearly membership before the end of the month.'] * 24).join(' ')}\n\n- One\n- Two" }
    }.each do |name, fields|
      PaymentQr::DEVICES.product(PaymentQr::VIEWS).each do |device, view|
        it "#{name} · #{device} · #{view}" do
          content = base.merge(fields)
          screen = trmnl.render(device:, view:, custom_fields: content)
          check_screen(screen, content:, view:, payload: content[:payment_type] == 'text' ? content[:qr_text] : jane)
        end
      end
    end

    # a portrait screen: the full view and the narrow quarter stack the code above the text, and the
    # half views keep the layout their shape asks for. The mashup views once kept the full view's
    # stacking classes, which pushed title and footer out of the slot
    %w[og_plus v2].product(PaymentQr::VIEWS).each do |device, view|
      it "portrait · #{device} · #{view}" do
        screen = trmnl.render(device:, view:, orientation: :portrait, custom_fields: base)
        check_screen(screen, content: base, view:, payload: jane)
        next unless %w[full quadrant].include?(view)

        expect(screen.box('[data-qr-layout] .title').top).to be >= screen.box('[data-qr-box]').bottom - 1
      end
    end
  end

  describe 'big screens give the text room' do
    it 'caps the code beside text' do
      screen = trmnl.render(device: 'v2', custom_fields: webhook, data: coffee_shop)
      check_screen(screen, content: coffee_shop[:payment], view: 'full', payload: northbean)
      layout = screen.box('[data-qr-layout]')
      expect(screen.box('[data-qr-box]').height / layout.height).to be <= 0.62
      expect(screen.box('[data-qr-body]').width / layout.width).to be >= 0.4
    end

    it 'keeps the full code without text' do
      content = base.merge(body: '')
      screen = trmnl.render(device: 'v2', custom_fields: content)
      check_screen(screen, content:, view: 'full', payload: jane)
      expect(screen.box('[data-qr-box]').height / screen.box('[data-qr-layout]').height).to be > 0.62
    end
  end

  describe 'the coffee shop price list' do
    PaymentQr::DEVICES.product(PaymentQr::VIEWS).each do |device, view|
      it "#{device} · #{view}" do
        screen = trmnl.render(device:, view:, custom_fields: webhook, data: coffee_shop)
        check_screen(screen, content: coffee_shop[:payment], view:, payload: northbean)
        next if view == 'quadrant'

        # prices on the right edge of a list that spans its column; every item has a mark
        rows = screen.evaluate(PaymentQr::PRICE_ROWS)
        expect(rows).not_to be_empty
        rows.each do |row|
          expect(row['gap']).to be <= 2, 'price right-aligned'
          expect(row['span']).to be >= 0.9, 'list spans its column'
          expect(row['marked']).to be(true), 'list item has a mark'
        end
        expect(screen).to have_css('[data-qr-row]', count: 7) if view == 'full'
        expect(screen).to have_text('Thank you!')
      end
    end
  end

  describe 'dark mode and color' do
    # Framework 3's dark mode remaps the framework's colours; the inline code keeps its own black on
    # white, so the box behind it (the quiet zone) must stay white too or scanners lose the code.
    %w[og_plus v2].product(%w[full quadrant]).each do |device, view|
      it "dark mode: the code keeps a white quiet zone and scans · #{device} · #{view}" do
        screen = trmnl.render(device:, view:, dark_mode: true, custom_fields: base)
        expect_clean(screen)
        expect(scan(screen)).to eq(jane)
      end
    end

    it 'color panel: red accent on the caption' do
      screen = trmnl.render(device: 'og_bwry', custom_fields: base)
      check_screen(screen, content: base, view: 'full', payload: jane)
      expect(screen).to have_css("#{caption_css}.bg--red")
    end

    it 'classic fonts' do
      og = TRMNLP::Testing::DeviceModels.find('og_plus')
      device = og.render_params.merge(screen_classes: "#{og.screen_classes} screen--fonts-classic")
      screen = trmnl.render(device:, custom_fields: base)
      expect(screen).to have_css('.screen--fonts-classic')
      check_screen(screen, content: base, view: 'full', payload: jane)
    end
  end

  describe 'payload and caption rules' do
    epc = PaymentQr.method(:epc)
    iban = 'BE71096123456769'
    [
      ['amount open', { epc_amount: '' }, epc.call('Jane Doe', iban, '', 'Coffee fund'), 'Any amount'],
      ['amount zero is open', { epc_amount: '0' }, epc.call('Jane Doe', iban, '', 'Coffee fund'), 'Any amount'],
      ['amount comma', { epc_amount: '7,5' }, epc.call('Jane Doe', iban, '7.50', 'Coffee fund'), '€7.50'],
      ['amount not a number', { epc_amount: 'abc' }, epc.call('Jane Doe', iban, '', 'Coffee fund'), 'Any amount'],
      ['big amount', { epc_amount: '1234.5' }, epc.call('Jane Doe', iban, '1234.50', 'Coffee fund'), '€1,234.50'],
      ['iban cleanup', { epc_iban: 'be71 0961 2345 6769 ' }, jane, '€12.50'],
      ['name limit', { epc_name: 'N' * 90 }, epc.call('N' * 70, iban, '12.50', 'Coffee fund'), '€12.50'],
      ['reference limit', { epc_reference: 'R' * 200 }, epc.call('Jane Doe', iban, '12.50', 'R' * 140), '€12.50'],
      ['own caption', { caption: 'Scan to pay' }, jane, 'Scan to pay'],
      ['link', { payment_type: 'text', qr_text: ' https://paypal.me/jane/5 ' }, 'https://paypal.me/jane/5', nil],
      ['bancontact fixed amount',
       { payment_type: 'bancontact', bc_profile_id: '5bb37284e35e2b29e363df22', epc_amount: '2.40', epc_reference: 'Espresso', title: 'Northbean Coffee' },
       'https://pay.bancontact.net/t/1/5bb37284e35e2b29e363df22?D=Northbean%20Coffee&A=240&R=Espresso', 'Pay €2.40 with Bancontact'],
      ['bancontact open amount',
       { payment_type: 'bancontact', bc_profile_id: '5bb37284e35e2b29e363df22', epc_amount: '', epc_reference: '', title: '' },
       'https://pay.bancontact.net/t/1/5bb37284e35e2b29e363df22', 'Pay with Bancontact'],
      ['bancontact encodes and caps D and R',
       { payment_type: 'bancontact', bc_profile_id: 'abc123', epc_amount: '0', epc_reference: 'Invoice #12 & co', title: 'Café Brussel: the coffee corner on the first floor' },
       'https://pay.bancontact.net/t/1/abc123?D=Caf%C3%A9%20Brussel%3A%20the%20coffee%20corner%20on&R=Invoice%20%2312%20%26%20co', 'Pay with Bancontact']
    ].each do |name, fields, payload, caption|
      it name do
        content = base.merge(fields)
        screen = trmnl.render(custom_fields: content)
        check_screen(screen, content:, view: 'full', payload:)
        if caption
          expect(screen).to have_css(caption_css, exact_text: caption)
        else
          expect(screen).to have_no_css(caption_css)
        end
      end
    end

    { 'no IBAN' => { epc_iban: '' }, 'no name' => { epc_name: '' },
      'bancontact without profile' => { payment_type: 'bancontact', bc_profile_id: '' } }.each do |name, fields|
      it "missing payment details · #{name}" do
        screen = trmnl.render(custom_fields: base.merge(fields))
        expect(scan(screen)).to be_nil
        expect(screen).to have_text('Fill in the payment details in the plugin settings')
      end
    end
  end

  describe 'the account language' do
    [
      ['nl', { epc_amount: '1234.5' }, '€ 1.234,50'],
      ['fr', { epc_amount: '' }, 'Montant libre'],
      ['de-DE', { payment_type: 'bancontact', bc_profile_id: 'abc123', epc_amount: '3', epc_reference: '', title: '' }, '3,00 € mit Bancontact bezahlen']
    ].each do |locale, fields, caption|
      it locale do
        screen = trmnl.render(variables: { trmnl: { user: { locale: } } }, custom_fields: base.merge(fields))
        expect(screen).to have_css(caption_css, exact_text: caption)
      end
    end

    it 'Dutch message when nothing is set' do
      screen = trmnl.render(variables: { trmnl: { user: { locale: 'nl' } } }, custom_fields: base.merge(epc_iban: ''))
      expect(screen).to have_text('Vul de betaalgegevens in bij de plugin-instellingen')
    end
  end

  # data: is what TRMNL has stored from the last webhook post
  describe 'data source and webhook' do
    it 'webhook data is used in webhook mode' do
      screen = trmnl.render(custom_fields: base.merge(webhook),
                            data: { payment: base.merge(epc_amount: '42', epc_reference: 'Pizza', title: 'Pizza night') })
      expect(scan(screen)).to eq(PaymentQr.epc('Jane Doe', 'BE71096123456769', '42.00', 'Pizza'))
      expect(screen).to have_text('Pizza night')
    end

    it 'webhook mode ignores the (hidden) settings' do
      screen = trmnl.render(custom_fields: base.merge(webhook), data: { payment: { title: 'Only a title' } })
      expect(scan(screen)).to be_nil
      expect(screen).to have_text('Send the payment details to the webhook')
      expect(screen).to have_text('Only a title')
    end

    it 'webhook mode, nothing sent yet' do
      screen = trmnl.render(custom_fields: base.merge(webhook))
      expect(scan(screen)).to be_nil
      expect(screen).to have_text('Send the payment details to the webhook')
    end

    it 'settings mode ignores webhook data' do
      screen = trmnl.render(custom_fields: base, data: { payment: base.merge(title: 'From webhook', epc_amount: '42') })
      expect(scan(screen)).to eq(jane)
      expect(screen).to have_text('Buy me a coffee')
    end
  end

  describe 'title bar' do
    it 'text, icon and default' do
      icon = "data:image/svg+xml;base64,#{['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'].pack('m0')}"
      screen = trmnl.render(custom_fields: base.merge(title_bar: 'Pay at the counter', title_bar_icon: icon))
      expect(screen).to have_css('.title_bar .title', exact_text: 'Pay at the counter')
      expect(screen).to have_css('.title_bar img', count: 1)
      expect(trmnl.render(custom_fields: base)).to have_css('.title_bar .title', text: /\S/)
    end

    [false, 'false', 'no'].each do |flag|
      it "hidden by #{flag.inspect}" do
        screen = trmnl.render(custom_fields: base.merge(webhook), data: { payment: base.merge(show_title_bar: flag) })
        expect(screen).to have_no_css('.title_bar')
        expect(scan(screen)).to eq(jane)
      end
    end
  end

  # the caption is off unless show_caption is on; a typed caption alone does not show
  describe 'caption' do
    { 'off by default' => { show_caption: nil }, 'off with text typed' => { show_caption: false, caption: 'Scan me' },
      'off as a string' => { show_caption: 'false', caption: 'Scan me' } }.each do |name, fields|
      it name do
        content = base.merge(fields).compact
        screen = trmnl.render(custom_fields: content)
        check_screen(screen, content:, view: 'full', payload: jane)
        expect(screen).to have_no_css(caption_css)
      end
    end

    it 'on through the webhook, as a string' do
      screen = trmnl.render(custom_fields: webhook, data: { payment: base.except(:show_caption).merge(show_caption: 'true') })
      expect(screen).to have_css(caption_css, exact_text: '€12.50')
    end
  end

  # Seen on trmnl.com (2026-10-02): webhook text arrived with CR LF line endings, and splitting it on
  # a plain newline left it as one line
  it 'CR LF line endings in webhook text still split it' do
    payment = coffee_shop[:payment].merge(body: coffee_shop[:payment][:body].gsub("\n", "\r\n"))
    screen = trmnl.render(custom_fields: webhook, data: { payment: })
    expect(scan(screen)).to eq(northbean)
    expect(screen).to have_css('[data-qr-row]', count: 7)
  end

  # The template itself with CR LF newlines (TRMNL's web markup editor stores it so): a newline typed in
  # the template then no longer matches the "\n" in the text. This is the test that fails without newline_to_br.
  it 'CR LF line endings in the template still split the text' do
    plugin = patched_plugin { it.gsub(/\r?\n/, "\r\n") }
    screen = plugin.render(custom_fields: webhook, data: coffee_shop)
    expect(scan(screen).to_s.gsub("\r\n", "\n")).to eq(northbean)
    expect(screen).to have_css('[data-qr-row]', count: 7)
  end

  it 'dividers between QR and text, under the title, above the footer, and for markdown ---' do
    screen = trmnl.render(custom_fields: base)
    expect(screen).to have_css('[data-qr-layout] .divider, [data-qr-layout] .divider--v', count: 3)
    screen = trmnl.render(custom_fields: base.merge(body: "## Coffee\n\n- Espresso | €2.40\n\n---\n\n## Tea\n\n- Green tea | €2.20"))
    expect(screen).to have_css('[data-qr-body] .divider:not([data-qr-leader])', count: 1, visible: :all)
  end

  it 'a single word too long for a quarter view shrinks, then is cut' do
    content = base.merge(title: 'Supercalifragilisticexpialidocious', body: '')
    screen = trmnl.render(device: 'v2', view: 'quadrant', custom_fields: content)
    check_screen(screen, content:, view: 'quadrant', payload: jane)
    expect(screen.first('[data-qr-fit]')).to have_text('Supercali')
  end
end
