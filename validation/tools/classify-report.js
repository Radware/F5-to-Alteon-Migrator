#!/usr/bin/env node
'use strict';
// Group the findings of a validate3/validate4 report by normalized message,
// so environmental residue (absent ports, adminkey, DHCP mgmt) separates from
// converter defects at a glance. Apply-time errors are listed first.
//
//   node classify-report.js <report.json>
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('usage: node classify-report.js <report.json>'); process.exit(2); }
const rep = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log('lines=' + rep.totalLines + ' sent=' + rep.linesSent + ' unsent=' + rep.linesUnsent +
  ' findings=' + rep.findings.length + (rep.applyErrorCount !== undefined ? ' APPLY-ERRORS=' + rep.applyErrorCount : ''));
if (rep.linesUnsent > 0 || rep.linesSent === 0) {
  console.log('!! UNSENT lines: this run is NOT a pass (connection lockout?) - wait 15-20 min and rerun');
}

const apply = rep.findings.filter((f) => f.line === 'APPLY');
if (apply.length) {
  console.log('\nAPPLY-TIME ERRORS (the device refused the whole config):');
  for (const f of apply) console.log('  ' + f.error);
}

const norm = (e) => e.replace(/"[^"]*"/g, '"X"').replace(/\d+\.\d+\.\d+\.\d+/g, 'IP').replace(/\d+/g, 'N').slice(0, 100);
const groups = new Map();
for (const f of rep.findings.filter((x) => x.line !== 'APPLY')) {
  const k = norm(f.error);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(f.line.trim());
}
console.log('\nLINE-LEVEL FINDINGS by class:');
for (const [k, lines] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(String(lines.length).padStart(5) + '  ' + k);
  console.log('       e.g. ' + lines[0]);
}
