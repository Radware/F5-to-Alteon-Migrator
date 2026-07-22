#!/usr/bin/env python3
"""Behavioral prober — Python twin of probe.js (for vantage hosts without
Node). Same scenarios and report format, so compare.js works across reports
from either prober.

  python3 probe.py --vip <ip[:port]> [--https] [--label X] [--requests N]
                   [--admin id=host:port,...] [--hc-wait S] [--out report.json]
"""
import sys, json, time, ssl, urllib.request, urllib.error

opt = {'requests': 100, 'persist_reqs': 20, 'hc_wait': 20, 'label': 'lb',
       'out': None, 'https': False, 'admin': {}, 'vip': None}
args = sys.argv[1:]
i = 0
while i < len(args):
    a = args[i]
    if a == '--vip': i += 1; opt['vip'] = args[i]
    elif a == '--https': opt['https'] = True
    elif a == '--label': i += 1; opt['label'] = args[i]
    elif a == '--requests': i += 1; opt['requests'] = int(args[i])
    elif a == '--hc-wait': i += 1; opt['hc_wait'] = int(args[i])
    elif a == '--out': i += 1; opt['out'] = args[i]
    elif a == '--admin':
        i += 1
        for kv in args[i].split(','):
            k, v = kv.split('='); opt['admin'][k] = v
    i += 1
if not opt['vip']:
    print('usage: probe.py --vip <ip[:port]> [options]'); sys.exit(2)

host, _, port = opt['vip'].partition(':')
port = port or ('443' if opt['https'] else '80')
base = ('https' if opt['https'] else 'http') + '://' + host + ':' + port
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def get(path, cookie=None):
    req = urllib.request.Request(base + path)
    if cookie:
        req.add_header('Cookie', cookie)
    try:
        with urllib.request.urlopen(req, timeout=5, context=ctx if opt['https'] else None) as r:
            return {'status': r.status, 'backend': r.headers.get('X-Backend'),
                    'set_cookie': r.headers.get_all('Set-Cookie') or []}
    except urllib.error.HTTPError as e:
        return {'status': e.code, 'backend': e.headers.get('X-Backend'), 'set_cookie': []}
    except Exception as e:
        return {'error': type(e).__name__}

def admin(hostport, path):
    h, _, p = hostport.partition(':')
    try:
        req = urllib.request.Request('http://%s:%s%s' % (h, p or '8080', path), method='POST', data=b'')
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except Exception as e:
        return 'ERR ' + type(e).__name__

def distribution(n):
    counts, errors = {}, 0
    for k in range(n):
        r = get('/?i=%d' % k)
        if r.get('error') or not r.get('backend'):
            errors += 1
        else:
            counts[r['backend']] = counts.get(r['backend'], 0) + 1
    return {'requests': n, 'errors': errors, 'counts': counts}

def persistence():
    first = get('/persist-start')
    if first.get('error') or not first.get('backend'):
        return {'skipped': 'no backend header on first request', 'error': first.get('error')}
    cookie = '; '.join(c.split(';')[0] for c in first['set_cookie'])
    if not cookie:
        return {'skipped': 'LB did not set a cookie (cookie persistence not configured on this service?)'}
    same = other = errors = 0
    for k in range(opt['persist_reqs']):
        r = get('/persist?i=%d' % k, cookie)
        if r.get('error') or not r.get('backend'):
            errors += 1
        elif r['backend'] == first['backend']:
            same += 1
        else:
            other += 1
    return {'firstBackend': first['backend'], 'cookie': cookie.split('=')[0],
            'stuck': same, 'moved': other, 'errors': errors,
            'pass': other == 0 and same > 0}

def health():
    ids = list(opt['admin'].keys())
    if not ids:
        return {'skipped': 'no --admin endpoints given'}
    victim = ids[0]
    before = distribution(30)
    admin(opt['admin'][victim], '/admin/down')
    time.sleep(opt['hc_wait'])
    during = distribution(30)
    admin(opt['admin'][victim], '/admin/up')
    time.sleep(opt['hc_wait'])
    after = distribution(30)
    return {'victim': victim, 'before': before['counts'], 'during': during['counts'],
            'after': after['counts'], 'duringErrors': during['errors'],
            'ejected': victim not in during['counts'],
            'restored': victim in after['counts'],
            'pass': victim not in during['counts'] and victim in after['counts'] and during['errors'] == 0}

report = {'label': opt['label'], 'vip': opt['vip'], 'https': opt['https'],
          'when': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
print('[%s] distribution (%d requests)...' % (opt['label'], opt['requests']))
report['distribution'] = distribution(opt['requests'])
print('  ', json.dumps(report['distribution']['counts']), 'errors=%d' % report['distribution']['errors'])
print('[%s] persistence...' % opt['label'])
report['persistence'] = persistence()
print('  ', json.dumps(report['persistence']))
print('[%s] health-check reaction...' % opt['label'])
report['health'] = health()
print('  ', json.dumps({k: report['health'].get(k) for k in ('ejected', 'restored', 'pass', 'skipped')}))
if opt['out']:
    with open(opt['out'], 'w') as f:
        json.dump(report, f, indent=2)
    print('wrote ' + opt['out'])
