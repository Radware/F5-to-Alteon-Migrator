'use strict';
// fixtures/sample02-azure: the first fixture EXPORTED FROM A REAL BIG-IP
// (VE 17.5.1 in Azure, rg-f5a-lab, 2026-07-07) rather than hand-written.
// The source device was behaviorally baselined live (2:1 weighted LB, cookie
// persistence, health eject/restore, TLS termination) before export — see
// validation/roundtrip/. No customer data: lab-built config.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../lib/index');

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'sample02-azure');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

test('sample02 (real BIG-IP 17.5 export) matches frozen output byte-for-byte', () => {
  const res = migrate([read('bigip_base.conf'), read('bigip.conf')]);
  assert.strictEqual(res.output, read(path.join('expected-node', 'output.txt')));
});

test('sample02 conversion carries the behaviorally-relevant constructs', () => {
  const res = migrate([read('bigip_base.conf'), read('bigip.conf')]);
  assert.match(res.output, /\/c\/slb\/real web1\n {4}ena\n {4}rip 10\.42\.1\.11\n {4}name "azure backend 1"\n {4}weight 2\n/);
  assert.match(res.output, /\/c\/slb\/real web2\n {4}ena\n {4}rip 10\.42\.1\.12\n {4}maxcon 500 physical\n/);
  assert.match(res.output, /health mon_web/);
  assert.match(res.output, /pbind cookie insert "RDWRLAB"\n/);   // LIVE-8: no trailing "10 10"
  assert.match(res.output, /\/c\/slb\/virt vs_web_tls\/service 443 https\/ssl\/sslpol vs_web_tls/);
  // SNAT automap converts to pip mode egress WITH the required-companion flag
  assert.ok(res.diagnostics.filter(d => d.issue.includes('SNAT Automap converted to "pip mode egress"')).length >= 3);
});
