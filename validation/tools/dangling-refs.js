#!/usr/bin/env node
'use strict';
// Offline apply-blocker pre-check: within each generated alteon-config*.txt,
// every reference must point at an object defined in the SAME file (each file
// is applied on its own instance). A dangling reference makes the device
// refuse the whole apply ("Real server X is not configured", group not found).
// Checks: group member adds -> reals, virt service group -> groups,
// group backup -> groups. Exit 1 if anything dangles.
//
//   node dangling-refs.js <folder>     (searched recursively)
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) { console.error('usage: node dangling-refs.js <folder>'); process.exit(2); }

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^alteon-config.*\.txt$/.test(e.name)) files.push(p);
  }
})(root);

let total = 0;
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const reals = new Set([...t.matchAll(/^\/c\/slb\/real (\S+)/gm)].map((m) => m[1]));
  const groups = new Set([...t.matchAll(/^\/c\/slb\/group (\S+)/gm)].map((m) => m[1]));
  const bad = { member: new Set(), group: new Set(), backup: new Set() };
  for (const gb of t.match(/^\/c\/slb\/group [\s\S]*?(?=\n\/c\/|\n*$)/gm) || []) {
    for (const m of gb.matchAll(/^ {4}add ([A-Za-z]\S*)$/gm)) if (!reals.has(m[1])) bad.member.add(m[1]);
    for (const m of gb.matchAll(/^ {4}backup g(\S+)$/gm)) if (!groups.has(m[1])) bad.backup.add(m[1]);
  }
  for (const m of t.matchAll(/^ {4}group ([A-Za-z]\S*)$/gm)) if (!groups.has(m[1])) bad.group.add(m[1]);
  const n = bad.member.size + bad.group.size + bad.backup.size;
  if (n) {
    total += n;
    console.log(path.relative(root, f) + ': members->missing reals=' + bad.member.size +
      ', virt->missing groups=' + bad.group.size + ', missing backups=' + bad.backup.size);
    for (const [k, s] of Object.entries(bad)) for (const x of [...s].slice(0, 5)) console.log('    ' + k + ': ' + x);
  }
}
console.log((total ? 'DANGLING references: ' + total : 'clean - no dangling references') + ' (' + files.length + ' file(s) checked)');
process.exit(total ? 1 : 0);
