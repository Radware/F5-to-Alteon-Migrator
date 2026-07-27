#!/usr/bin/env node
'use strict';
// Gate for anything that must never reach the PUBLIC repo.
//
// The private repo (origin) intentionally keeps the full development history,
// customer names and lab details. The public repo (radware) must not. This
// script scans the working tree that is about to be published and exits
// non-zero on any hit, so publishing fails loudly instead of leaking.
//
//   node tools/scan-sensitive.js [--quiet]
const { execSync } = require('child_process');
const fs = require('fs');

const PATTERNS = [
  // customer identities seen in the source configs
  [/\bitau\b/i, 'customer name (bank fleet A)'],
  [/\btransbank\b/i, 'customer name (bank fleet B)'],
  [/\btelstra\b/i, 'customer name (telco)'],
  [/\bitauchile\b/i, 'customer hostname'],
  [/\bclayton\b/i, 'customer site name'],
  [/\bst ?leonards\b/i, 'customer site name'],
  [/\bnsp[a-z]{3}\d{4}[a-z]{2}\d{2}\b/i, 'customer device hostname'],
  // credentials / secrets
  [/radware5\?/, 'lab VM password'],
  [/Rdwr-F5lab/i, 'lab F5 password'],
  [/npm_[A-Za-z0-9]{30,}/, 'npm access token'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\badmin radware\b/, 'device credentials in a command example'],
  [/\$M\$[A-Za-z0-9]/, 'F5 encrypted secret blob'],
  // internal identifiers
  [/\b47ed22ae-36f9-4075-b8f6-e2c5645a76c1\b/, 'Azure subscription id'],
  [/\b8a7ed4db-2227-4134-9da4-8e02e9b43643\b/, 'Azure subscription id'],
  [/\b192\.115\.180\.14\b/, 'personal egress IP'],
];

// Files that legitimately contain scanner patterns (this file itself).
const SKIP = new Set(['tools/scan-sensitive.js']);

const quiet = process.argv.includes('--quiet');
let files;
try {
  files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (e) {
  console.error('scan-sensitive: not a git repository');
  process.exit(2);
}

const hits = [];
for (const f of files) {
  if (SKIP.has(f)) continue;
  if (/^(validation\/node_modules|node\/node_modules)\//.test(f)) continue;
  let text;
  try {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue;             // binary (docx/pdf/images)
    text = buf.toString('utf8');
  } catch (e) { continue; }
  const lines = text.split('\n');
  for (const [re, what] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ file: f, line: i + 1, what, text: lines[i].trim().slice(0, 110) });
        break;                                  // one hit per pattern per file
      }
    }
  }
}

if (!hits.length) {
  if (!quiet) console.log('scan-sensitive: clean - ' + files.length + ' tracked files, no customer names, credentials or secrets found.');
  process.exit(0);
}

console.error('\nSCAN FAILED - ' + hits.length + ' item(s) must not reach the PUBLIC repo:\n');
for (const h of hits) {
  console.error('  ' + h.file + ':' + h.line + '  [' + h.what + ']');
  console.error('      ' + h.text);
}
console.error('\nSanitize these (use neutral descriptors such as "bank fleet A" / "the telco'
  + ' customer", and placeholders for credentials), then publish again.');
console.error('The full unsanitized record stays in the PRIVATE repo (origin) - that is by design.\n');
process.exit(1);
