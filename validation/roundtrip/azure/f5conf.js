#!/usr/bin/env node
'use strict';
// Drive tmsh over SSH to build the representative config on the Azure BIG-IP
// VE (single-NIC deployment: VIP = secondary private IP, SNAT automap
// required for return traffic).
//
//   node f5conf.js <host> <user> <pass> [--check-only]
//
// Idempotent-ish: each create logs errors but continues ("already exists" is
// fine on re-run). Ends with "save sys config" (this is OUR lab F5 — saving
// is the point; the config is exported as the fixture afterwards).
const { Client } = require('ssh2');
const [host, user, pass, flag] = process.argv.slice(2);
if (!pass) { console.error('usage: node f5conf.js <host> <user> <pass> [--check-only]'); process.exit(2); }

const CHECK = ['tmsh show sys version', 'tmsh list ltm virtual one-line', 'tmsh list ltm pool one-line'];
const CONFIG = [
  // nodes (web2 gets extras so the exported fixture exercises those paths)
  'tmsh create ltm node web1 address 10.42.1.11 description "azure backend 1"',
  'tmsh create ltm node web2 address 10.42.1.12 connection-limit 500',
  // custom HTTP monitor hitting backend.js /health
  'tmsh create ltm monitor http mon_web defaults-from http interval 5 timeout 16 send "GET /health HTTP/1.1\\r\\nHost: lab.local\\r\\nConnection: Close\\r\\n\\r\\n" recv "OK"',
  // weighted pool (ratio 2:1) with the custom monitor
  'tmsh create ltm pool pool_web load-balancing-mode ratio-member monitor mon_web members add { web1:8080 { ratio 2 } web2:8080 { ratio 1 } }',
  // plain round-robin pool with built-in tcp monitor
  'tmsh create ltm pool pool_api monitor tcp members add { web1:8080 web2:8080 }',
  // cookie persistence profile
  'tmsh create ltm persistence cookie persist_web defaults-from cookie cookie-name RDWRLAB',
  // HTTP virtual: cookie persistence + SNAT automap (mandatory single-NIC)
  'tmsh create ltm virtual vs_web destination 10.42.1.100:80 ip-protocol tcp pool pool_web profiles add { http } persist replace-all-with { persist_web } source-address-translation { type automap }',
  // HTTPS virtual: TLS termination with the default clientssl (self-signed)
  'tmsh create ltm virtual vs_web_tls destination 10.42.1.100:443 ip-protocol tcp pool pool_web profiles add { http clientssl { context clientside } } persist replace-all-with { persist_web } source-address-translation { type automap }',
  // API virtual: no persistence, source-addr NOT set -> pure distribution
  'tmsh create ltm virtual vs_api destination 10.42.1.100:8081 ip-protocol tcp pool pool_api profiles add { http } source-address-translation { type automap }',
  'tmsh save sys config'
];
const cmds = flag === '--check-only' ? CHECK : [...CHECK, ...CONFIG, 'tmsh list ltm virtual one-line'];

const conn = new Client();
let buf = '', stream = null, queue = [...cmds], current = null, idle = null;
function send() {
  clearTimeout(idle);
  if (!queue.length) { try { conn.end(); } catch (e) {} return process.exit(0); }
  current = queue.shift();
  console.log('\n### ' + current);
  buf = '';
  // the F5 admin user lands directly in the tmos shell -> no "tmsh" prefix
  stream.write(current.replace(/^tmsh /, '') + '\n');
  idle = setTimeout(onIdle, 6000);
}
function onIdle() {
  if (current === null) return send();   // login banner settled; start the queue
  const out = buf.split('\n').filter(l => l.trim() && !l.includes(current.slice(0, 30))).join('\n');
  if (out.trim()) console.log(out.trim());
  send();
}
conn.on('ready', () => conn.shell({ term: 'vt100', rows: 500, cols: 200 }, (err, s) => {
  if (err) { console.error(err.message); process.exit(2); }
  stream = s;
  s.on('data', (d) => { buf += d.toString('utf8'); clearTimeout(idle); idle = setTimeout(onIdle, 2500); });
  s.on('close', () => process.exit(0));
  setTimeout(() => { buf = ''; send(); }, 4000);
}));
conn.on('error', (e) => { console.error('SSH error: ' + e.message); process.exit(2); });
conn.on('keyboard-interactive', (n, i, il, p, cb) => cb([pass]));
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 25000 });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); process.exit(3); }, 300000);
