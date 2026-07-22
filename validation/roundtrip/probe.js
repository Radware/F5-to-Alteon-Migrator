#!/usr/bin/env node
'use strict';
// Behavioral prober for the F5-vs-Alteon round-trip comparison.
// Run the SAME probe against the app behind the F5 and behind the migrated
// Alteon, then diff the two reports with compare.js.
//
//   node probe.js --vip <ip[:port]> [--https] [--label f5|alteon]
//                 [--requests 100] [--backends id1,id2,...]
//                 [--admin id=host:port,...]   (direct backend admin endpoints)
//                 [--hc-wait 20]               (seconds to wait for LB to react)
//                 [--out report.json]
//
// Scenarios (each skipped gracefully if its prerequisites are missing):
//   distribution — N plain requests; tally X-Backend per response
//   persistence  — carry cookies from the first response; M follow-ups must
//                  hit the same backend (cookie persistence)
//   health       — mark one backend down via its DIRECT admin endpoint, wait,
//                  verify the LB stops sending traffic to it; bring it back,
//                  verify it returns to rotation
//   tls          — HTTPS handshake succeeds and traffic completes (--https)
const fs = require('fs');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
const opt = { requests: 100, persistReqs: 20, hcWait: 20, label: 'lb', out: null, httpsMode: false, admin: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--vip') opt.vip = args[++i];
  else if (a === '--https') opt.httpsMode = true;
  else if (a === '--label') opt.label = args[++i];
  else if (a === '--requests') opt.requests = parseInt(args[++i], 10);
  else if (a === '--backends') opt.backends = args[++i].split(',');
  else if (a === '--hc-wait') opt.hcWait = parseInt(args[++i], 10);
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--admin') for (const kv of args[++i].split(',')) { const [id, hp] = kv.split('='); opt.admin[id] = hp; }
}
if (!opt.vip) { console.error('usage: node probe.js --vip <ip[:port]> [options]'); process.exit(2); }
const [vipHost, vipPort] = opt.vip.includes(':') ? opt.vip.split(':') : [opt.vip, opt.httpsMode ? '443' : '80'];

function get(pathname, extra) {
  const mod = opt.httpsMode ? https : http;
  return new Promise((resolve) => {
    const req = mod.request({
      host: vipHost, port: +vipPort, path: pathname, method: 'GET',
      headers: (extra && extra.headers) || {}, rejectUnauthorized: false, timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, backend: res.headers['x-backend'] || null, setCookie: res.headers['set-cookie'] || [], body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end();
  });
}

function adminPost(hostport, pathname) {
  const [h, p] = hostport.split(':');
  return new Promise((resolve) => {
    const req = http.request({ host: h, port: +(p || 8080), path: pathname, method: 'POST', timeout: 5000 },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => resolve('ERR ' + (e.code || e.message)));
    req.on('timeout', () => { req.destroy(); resolve('ERR timeout'); });
    req.end();
  });
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function distribution(n) {
  const counts = {}; let errors = 0;
  for (let i = 0; i < n; i++) {
    const r = await get('/?i=' + i);
    if (r.error || !r.backend) errors++;
    else counts[r.backend] = (counts[r.backend] || 0) + 1;
  }
  return { requests: n, errors, counts };
}

async function persistence() {
  const first = await get('/persist-start');
  if (first.error || !first.backend) return { skipped: 'no backend header on first request', error: first.error };
  const cookie = first.setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) return { skipped: 'LB did not set a cookie (cookie persistence not configured on this service?)' };
  let same = 0, other = 0, errors = 0;
  for (let i = 0; i < opt.persistReqs; i++) {
    const r = await get('/persist?i=' + i, { headers: { Cookie: cookie } });
    if (r.error || !r.backend) errors++;
    else if (r.backend === first.backend) same++;
    else other++;
  }
  return { firstBackend: first.backend, cookie: cookie.split('=')[0], stuck: same, moved: other, errors, pass: other === 0 && same > 0 };
}

async function health() {
  const ids = Object.keys(opt.admin);
  if (!ids.length) return { skipped: 'no --admin endpoints given' };
  const victim = ids[0];
  const before = await distribution(30);
  await adminPost(opt.admin[victim], '/admin/down');
  await sleep(opt.hcWait);
  const during = await distribution(30);
  await adminPost(opt.admin[victim], '/admin/up');
  await sleep(opt.hcWait);
  const after = await distribution(30);
  return {
    victim,
    before: before.counts, during: during.counts, after: after.counts,
    duringErrors: during.errors,
    ejected: !(victim in during.counts),
    restored: victim in after.counts,
    pass: !(victim in during.counts) && (victim in after.counts) && during.errors === 0
  };
}

(async () => {
  const report = { label: opt.label, vip: opt.vip, https: opt.httpsMode, when: new Date().toISOString() };
  console.log('[' + opt.label + '] distribution (' + opt.requests + ' requests)...');
  report.distribution = await distribution(opt.requests);
  console.log('  ', JSON.stringify(report.distribution.counts), 'errors=' + report.distribution.errors);
  console.log('[' + opt.label + '] persistence...');
  report.persistence = await persistence();
  console.log('  ', JSON.stringify(report.persistence));
  console.log('[' + opt.label + '] health-check reaction...');
  report.health = await health();
  console.log('  ', JSON.stringify({ ejected: report.health.ejected, restored: report.health.restored, pass: report.health.pass, skipped: report.health.skipped }));
  if (opt.out) { fs.writeFileSync(opt.out, JSON.stringify(report, null, 2)); console.log('wrote ' + opt.out); }
})();
