#!/usr/bin/env node
'use strict';
// Compare two probe.js reports (F5 vs migrated Alteon) and give a
// behavioral-parity verdict.
//
//   node compare.js report_f5.json report_alteon.json
//
// Parity criteria (per scenario, both sides must agree):
//   distribution — same backend set in rotation; no request errors; if both
//                  sides look weighted, the ratios must roughly match (25%)
//   persistence  — same outcome: both stick to one backend (or both skipped)
//   health       — both eject the downed backend and restore it, no errors
const fs = require('fs');
const [fa, fb] = process.argv.slice(2);
if (!fb) { console.error('usage: node compare.js <report_f5.json> <report_alteon.json>'); process.exit(2); }
const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

// distribution
{
  const ka = Object.keys(A.distribution.counts).sort(), kb = Object.keys(B.distribution.counts).sort();
  check('distribution: same backend set', JSON.stringify(ka) === JSON.stringify(kb), ka.join(',') + ' vs ' + kb.join(','));
  check('distribution: no errors', A.distribution.errors === 0 && B.distribution.errors === 0,
    A.label + '=' + A.distribution.errors + ' ' + B.label + '=' + B.distribution.errors);
  if (JSON.stringify(ka) === JSON.stringify(kb) && ka.length > 1) {
    let maxDelta = 0;
    for (const k of ka) {
      const ra = A.distribution.counts[k] / A.distribution.requests;
      const rb = B.distribution.counts[k] / B.distribution.requests;
      maxDelta = Math.max(maxDelta, Math.abs(ra - rb));
    }
    check('distribution: ratios match (±25%)', maxDelta <= 0.25, 'max share delta ' + (maxDelta * 100).toFixed(1) + '%');
  }
}
// persistence
{
  const sa = A.persistence.skipped ? 'skipped' : (A.persistence.pass ? 'sticky' : 'NOT sticky');
  const sb = B.persistence.skipped ? 'skipped' : (B.persistence.pass ? 'sticky' : 'NOT sticky');
  check('persistence: same outcome', sa === sb, A.label + '=' + sa + ' ' + B.label + '=' + sb);
}
// health
{
  const sa = A.health.skipped ? 'skipped' : (A.health.pass ? 'eject+restore' : 'FAILED');
  const sb = B.health.skipped ? 'skipped' : (B.health.pass ? 'eject+restore' : 'FAILED');
  check('health: same outcome', sa === sb && sa !== 'FAILED', A.label + '=' + sa + ' ' + B.label + '=' + sb);
}

let failed = 0;
console.log('\nBehavioral parity: ' + A.label + ' (' + A.vip + ') vs ' + B.label + ' (' + B.vip + ')\n');
for (const r of results) {
  if (!r.pass) failed++;
  console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + '   [' + r.detail + ']');
}
console.log('\n' + (failed ? failed + ' parity check(s) FAILED' : 'ALL parity checks passed'));
process.exit(failed ? 1 : 0);
