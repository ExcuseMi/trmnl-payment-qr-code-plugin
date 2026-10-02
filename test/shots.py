#!/usr/bin/env python3
"""Render every layout at real device/slot sizes. Usage: test/shots.py [filter]"""
import json, os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(ROOT, 'plugin')
OUT = os.path.join(ROOT, 'test', 'shots')
CACHE = os.path.join(ROOT, 'test', '.cache')
CHROME = os.environ.get('CHROME') or sorted(
    p for p in (os.path.expanduser('~/.cache/ms-playwright/') + d + '/chrome-linux64/chrome'
                for d in os.listdir(os.path.expanduser('~/.cache/ms-playwright')) if d.startswith('chromium-'))
    if os.path.exists(p))[-1]

OG = 'screen--og screen--md screen--1bit screen--density-1x'
X = 'screen--v2 screen--lg screen--4bit screen--density-2x'
DEVICES = {  # name: (view, window w, h, slot or None, classes)
    'full': ('full', 800, 480, None, OG),
    'half_h': ('half_horizontal', 800, 480, (800, 240), OG),
    'half_v': ('half_vertical', 800, 480, (400, 480), OG),
    'quad': ('quadrant', 800, 480, (400, 240), OG),
    'portrait': ('full', 480, 800, None, OG + ' screen--portrait'),
    'x': ('full', 1872, 1404, None, X),
    'sm': ('full', 1400, 840, None, 'screen--amazon_kindle_2024 screen--sm screen--density-2x screen--4bit'),
    'sm_half_v': ('half_vertical', 1400, 840, (400, 480), 'screen--amazon_kindle_2024 screen--sm screen--density-2x screen--4bit'),
    'bwry': ('full', 800, 480, None, 'screen--og screen--md screen--density-1x screen--color-4bwry'),
}
CASES = {  # name: (custom field overrides, devices)
    'split': ({}, list(DEVICES)),
    'text_large': ({'text_size': 'large'}, ['full', 'x', 'half_h']),
    'bwry_yellow': ({'accent': 'yellow', 'layout': 'poster', 'visual_position': 'top'}, ['bwry']),
    'split_reverse_open': ({'layout': 'split_reverse', 'amount_mode': 'open', 'show_details': 'true'}, ['full', 'half_h']),
    'poster': ({'layout': 'poster', 'visual_position': 'top', 'icon': 'heart', 'title': 'Support the team'}, ['full', 'half_v', 'half_h', 'quad']),
    'qr_only': ({'layout': 'qr_only', 'title': '', 'caption': 'Scan to pay'}, ['full', 'half_v', 'quad']),
    'qr_icon': ({'layout': 'poster', 'visual_position': 'qr', 'icon': 'beer', 'title': 'Friday drinks', 'footer': ''}, ['full', 'half_h', 'quad', 'x']),
    'qr_icon_long': ({'layout': 'split', 'visual_position': 'qr', 'icon': 'heart', 'epc_reference': 'Membership 2026 for the tennis club, family plan, two adults and three kids'}, ['full', 'quad']),
    'link_long_text': ({'payment_type': 'text', 'qr_text': 'https://paypal.me/yourname/5', 'caption': 'PayPal', 'text_size': 'large',
                        'body': '# Club membership\n\n' + 'Pay your yearly membership before the end of the month. ' * 6 + '\n\n- One\n- Two\n- Three'},
                       ['full', 'half_v', 'portrait']),
    'webhook': ({'__payment': {'epc_amount': '42', 'epc_reference': 'Pizza night', 'title': 'Pizza night', 'icon': 'food',
                              'body': 'Thanks for joining! **EUR 42** for the pizzas.', 'updated_at': 1700000000}}, ['full']),
    'webhook_expired': ({'override_hours': '1', '__payment': {'title': 'SHOULD NOT SHOW', 'updated_at': 1700000000}}, ['full']),
    'webhook_open': ({'__payment': {'amount_mode': 'open', 'caption': 'Pay what you like'}}, ['full']),
    'empty': ({'epc_iban': '', 'body': ''}, ['full']),
}

def cached(url):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, re.sub(r'[^A-Za-z0-9.]+', '_', url))
    if not os.path.exists(path):
        subprocess.run(['curl', '-fsSL', '-o', path, url], check=True)
    return path

def localize(html):
    for url in set(re.findall(r'https://trmnl\.com/(?:css|js)/[^"]+', html)):
        local = cached(url)
        if url.endswith('.css'):
            raw = open(local).read()
            fonts = set(re.findall(r'url\("/fonts/([^"]+)"\)', raw))
            fdir = os.path.join(CACHE, 'fonts'); os.makedirs(fdir, exist_ok=True)
            for f in fonts:
                dst = os.path.join(fdir, os.path.basename(f))
                if not os.path.exists(dst):
                    if subprocess.run(['curl', '-fsSL', '-o', dst, 'https://trmnl.com/fonts/' + f]).returncode:
                        print('font missing, text measured in a fallback:', f)
            local = local + '.local.css'
            open(local, 'w').write(raw.replace('url("/fonts/', 'url("file://' + fdir + '/'))
        html = html.replace(url, 'file://' + local)
    return html

def build(overrides):
    tmp = tempfile.mkdtemp(prefix='qrplugin-')
    shutil.copytree(os.path.join(PLUGIN, 'src'), os.path.join(tmp, 'src'))
    yml = open(os.path.join(PLUGIN, '.trmnlp.yml')).read()
    fields = dict(re.findall(r'^  (\w+): (.*)$', yml.split('custom_fields:')[1].split('variables:')[0], re.M))
    fields = {k: json.loads(v) if v.startswith('"') else v.strip("'") for k, v in fields.items()}
    payment = overrides.pop('__payment', None)
    fields.update(overrides)
    head = yml.split('custom_fields:')[0]
    rest = 'variables:' + yml.split('variables:')[1]
    if payment is not None:
        rest = rest.rstrip('\n') + '\n  payment: ' + json.dumps(payment) + '\n'
    open(os.path.join(tmp, '.trmnlp.yml'), 'w').write(head + 'custom_fields: ' + json.dumps(fields) + '\n\n' + rest)
    subprocess.run(['trmnlp', 'build'], cwd=tmp, check=True, capture_output=True)
    return tmp

def main():
    flt = sys.argv[1] if len(sys.argv) > 1 else ''
    os.makedirs(OUT, exist_ok=True)
    for case, (overrides, devices) in CASES.items():
        overrides = dict(overrides)
        if flt not in case: continue
        tmp = build(overrides)
        for dev in devices:
            view, w, h, slot, classes = DEVICES[dev]
            html = localize(open(os.path.join(tmp, '_build', view + '.html')).read())
            html = re.sub(r'class="screen([^"]*)"', lambda m: 'class="screen%s %s"' % (m.group(1), classes), html, count=1)
            if slot:
                html = html.replace('</head>', '<style>.screen{--full-w:%dpx !important;--full-h:%dpx !important}</style></head>' % slot)
            page = os.path.join(tmp, dev + '.html'); open(page, 'w').write(html)
            png = os.path.join(OUT, '%s-%s.png' % (case, dev))
            subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
                            '--window-size=%d,%d' % (w, h), '--virtual-time-budget=6000',
                            '--screenshot=' + png, 'file://' + page], check=True, capture_output=True)
            # every code must still scan, icon overlay and all
            ok = case == 'empty' or not shutil.which('zbarimg') or \
                subprocess.run(['zbarimg', '-q', png], capture_output=True).returncode == 0
            print(png, '' if ok else ' QR DOES NOT DECODE')
        shutil.rmtree(tmp)

main()
