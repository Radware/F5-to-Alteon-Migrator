#!/usr/bin/env node
'use strict';
// Sanitize a real BIG-IP config so it can be committed as a fixture:
//  - every PUBLIC IPv4 is remapped deterministically into 100.64.0.0/10
//    (CGNAT space), preserving the host octet and subnet grouping so the
//    converted topology stays coherent; private/loopback/link-local IPs are
//    kept (they don't identify a customer but carry real-world variety)
//  - customer-identifying keywords (--keyword, repeatable) are replaced in
//    object names, hostnames and descriptions
//  - description free-text, SNMP communities, and any password/passphrase/
//    secret/community values are redacted
// The result is still a structurally-identical tmsh config: object counts,
// references and IP relationships survive, so converter behavior is
// representative of the original.
const fs = require('fs');
const path = require('path');

function usage() {
  console.log('usage: node sanitize.js <in.conf> <out.conf> [--keyword <word>]...');
  process.exit(1);
}

const args = process.argv.slice(2);
const keywords = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keyword') keywords.push(args[++i]);
  else files.push(args[i]);
}
if (files.length !== 2) usage();

let text = fs.readFileSync(files[0], 'utf8');

// ---- IPv4 remapping ----
const isPrivate = (a, b) =>
  a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
  (a === 169 && b === 254) || a === 0 || a >= 224;
const prefixMap = new Map();   // "a.b.c" -> "100.x.y"
let nextIdx = 0;
const mapped = new Map();      // full original ip -> replacement
for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
  const [ip, a, b, c, d] = [m[0], +m[1], +m[2], +m[3], +m[4]];
  if ([a, b, c, d].some(o => o > 255) || isPrivate(a, b) || mapped.has(ip)) continue;
  // 255.x subnet masks are never customer data
  if (a === 255 || ip === '255.255.255.255') continue;
  const pfx = a + '.' + b + '.' + c;
  if (!prefixMap.has(pfx)) {
    const x = 64 + Math.floor(nextIdx / 256), y = nextIdx % 256;
    prefixMap.set(pfx, '100.' + x + '.' + y);
    nextIdx++;
  }
  mapped.set(ip, prefixMap.get(pfx) + '.' + d);
}
for (const [from, to] of mapped) {
  text = text.split(from).join(to);
}

// ---- keyword scrubbing (names, hostnames, descriptions) ----
keywords.forEach((kw, i) => {
  text = text.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'acme' + (i || ''));
});

// ---- free-text & secret redaction ----
text = text
  .replace(/^(\s*description ).*$/gm, '$1sanitized')
  .replace(/^(\s*community(?:-name)? ).*$/gm, '$1public')
  .replace(/^(\s*(?:password|passphrase|secret|encrypted) ).*$/gm, '$1REDACTED');

fs.mkdirSync(path.dirname(path.resolve(files[1])), { recursive: true });
fs.writeFileSync(files[1], text);
console.log('sanitized ' + files[0] + ' -> ' + files[1] +
  ' (' + mapped.size + ' public IPs remapped, ' + keywords.length + ' keywords scrubbed)');
