#!/usr/bin/env node
'use strict';
// SSLID-1 / gate coverage: Alteon skips the apply-time checks of a DISABLED
// virtual (proven on 34.0.12: sslid + SSL policy applies on a disabled
// virtual and refuses the whole apply once it is enabled). The converter
// emits F5-disabled virtuals and members disabled, so a plain validate4 run
// never checks them. Gate the copy this tool writes as well: it drops the
// `dis` line of every /c/slb/virt and /c/slb/real block, nothing else.
//
// usage: node enable-all.js <alteon-config.txt> <out.txt>
const fs = require('fs');
const [inp, out] = process.argv.slice(2);
if (!inp || !out) { console.error('usage: node enable-all.js <alteon-config.txt> <out.txt>'); process.exit(2); }
let inBlock = false, dropped = 0;
const lines = fs.readFileSync(inp, 'utf8').split('\n').filter((l) => {
  const t = l.replace(/\r$/, '');
  if (t.startsWith('/')) { inBlock = /^\/c\/slb\/(virt|real) [^/\s]+$/.test(t); return true; }
  if (inBlock && t === '    dis') { dropped++; return false; }
  return true;
});
fs.writeFileSync(out, lines.join('\n'));
console.log('enabled ' + dropped + ' disabled virt/real block(s) -> ' + out);
