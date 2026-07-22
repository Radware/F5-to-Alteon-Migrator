#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { migrate } = require('../lib/index');

function usage() {
  console.log(`f5-to-alteon — migrate F5 BIG-IP (tmsh) config to Radware Alteon CLI

Usage:
  f5-to-alteon <input> [more inputs ...] [-o <outdir>] [--name <project>]

Inputs (auto-detected, mix freely):
  bigip.conf / bigip_base.conf   tmsh config file(s)
  device.qkview / device.ucs     F5 support archive — config files are
                                 extracted automatically
  extracted-qkview-directory/    directory containing config/bigip.conf

Options:
  -o, --out <dir>     Output directory (default: current directory)
      --name <name>   Project name used as output file prefix (default: migration)
      --rd-mode <m>   Route-domain strategy: auto (default) | segment | split
                      segment: RDs become Alteon Network Segments on ONE device
                               (auto picks this when RD address spaces don't overlap)
                      split:   one config file per RD (vADC / separate VA each)
      --stdout        Print the Alteon config to stdout instead of files
  -h, --help          Show this help

Outputs:
  <name>_output.txt   Generated Alteon CLI configuration
  <name>_log1.txt     Items to complete manually (supported by Alteon)
  <name>_log2.txt     Items that may not be supported by Alteon`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) { usage(); process.exit(args.length ? 0 : 1); }

const files = [];
let outDir = '.', name = 'migration', toStdout = false, rdMode = 'auto';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '--out') outDir = args[++i];
  else if (a === '--name') name = args[++i];
  else if (a === '--rd-mode') rdMode = args[++i];
  else if (a === '--stdout') toStdout = true;
  else files.push(a);
}
if (!['auto', 'segment', 'split'].includes(rdMode)) { console.error('error: --rd-mode must be auto, segment, or split'); process.exit(1); }
if (!files.length) { console.error('error: no input files'); process.exit(1); }

async function collectTexts() {
  const { resolveInput } = require('../lib/extract');
  const sources = [];
  for (const f of files) {
    try {
      const resolved = await resolveInput(f);
      for (const s of resolved) {
        if (s.label !== f) console.log('extracted: ' + s.label);
        sources.push(s.text);
      }
      for (const n of resolved.notes || []) console.log('NOTE: ' + n);
    } catch (e) { console.error('error: cannot read ' + f + ': ' + e.message); process.exit(1); }
  }
  return sources;
}

collectTexts().then((texts) => {
const res = migrate(texts, { rdMode });
if (res.objectCount === 0) {
  console.error('error: no F5 configuration objects found in the input.');
  console.error('       Expected tmsh config (ltm virtual/pool/node..., net vlan/self...),');
  console.error('       a .qkview/.ucs archive, or a directory containing config/bigip.conf.');
  process.exit(1);
}
if (toStdout) { process.stdout.write(res.output); process.exit(0); }

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, name + '_output.txt'), res.output);
for (const [rdId, rdOut] of Object.entries(res.rdOutputs || {})) {
  fs.writeFileSync(path.join(outDir, name + '_rd' + rdId + '_output.txt'), rdOut);
  const desc = res.rdInfo[rdId] ? ' ("' + res.rdInfo[rdId].trim() + '")' : '';
  console.log('ROUTE DOMAIN ' + rdId + desc + ': wrote ' + name + '_rd' + rdId + '_output.txt — deploy on its OWN Alteon instance (vADC / separate VA)');
}
fs.writeFileSync(path.join(outDir, name + '_log1.txt'), res.log1);
fs.writeFileSync(path.join(outDir, name + '_log2.txt'), res.log2);
const manual = res.diagnostics.filter(d => d.sev === 'log1').length;
const unsupported = res.diagnostics.filter(d => d.sev === 'log2').length;
const parts = Object.entries(res.summary).filter(([, v]) => v > 0).map(([k, v]) => v + ' ' + k);
console.log('Converted: ' + parts.join(', '));
console.log('Wrote ' + name + '_output.txt / _log1.txt / _log2.txt to ' + outDir);
console.log('Diagnostics: ' + manual + ' manual-completion item(s) (see _log1.txt), ' + unsupported + ' possibly-unsupported item(s) (see _log2.txt)');
}).catch((e) => { console.error('error: ' + e.message); process.exit(1); });
