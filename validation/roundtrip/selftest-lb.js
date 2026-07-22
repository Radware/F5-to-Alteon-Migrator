#!/usr/bin/env node
'use strict';
// Tiny reference LB used ONLY to self-test the round-trip harness locally
// (round-robin + cookie stickiness + health polling), so probe.js/compare.js
// are proven before pointing them at real F5/Alteon devices.
//
//   node selftest-lb.js <listenPort> <id1=host:port> <id2=host:port> ...
const http = require('http');
const listen = parseInt(process.argv[2], 10);
const backends = process.argv.slice(3).map((s) => {
  const [id, hp] = s.split('=');
  const [host, port] = hp.split(':');
  return { id, host, port: +port, healthy: true };
});
let rr = 0;

setInterval(() => {
  for (const b of backends) {
    const req = http.request({ host: b.host, port: b.port, path: '/health', timeout: 2000 }, (res) => {
      b.healthy = res.statusCode === 200; res.resume();
    });
    req.on('error', () => { b.healthy = false; });
    req.on('timeout', () => { req.destroy(); b.healthy = false; });
    req.end();
  }
}, 2000);

http.createServer((creq, cres) => {
  const up = backends.filter((b) => b.healthy);
  if (!up.length) { cres.writeHead(503); return cres.end('no backends'); }
  const m = /lbstick=([^;]+)/.exec(creq.headers.cookie || '');
  let target = m ? up.find((b) => b.id === m[1]) : null;
  if (!target) target = up[rr++ % up.length];
  const preq = http.request({ host: target.host, port: target.port, path: creq.url, method: creq.method, headers: creq.headers }, (pres) => {
    const headers = Object.assign({}, pres.headers);
    if (!m) headers['set-cookie'] = ['lbstick=' + target.id + '; Path=/'];
    cres.writeHead(pres.statusCode, headers);
    pres.pipe(cres);
  });
  preq.on('error', () => { cres.writeHead(502); cres.end('backend error'); });
  creq.pipe(preq);
}).listen(listen, () => console.log('selftest-lb on :' + listen + ' -> ' + backends.map((b) => b.id).join(',')));
