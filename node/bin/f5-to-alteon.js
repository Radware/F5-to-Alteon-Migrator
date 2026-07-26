#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { migrate } = require('../lib/index');
const { resolveInput, detectKind } = require('../lib/extract');

// output file names describe their ROLE (the folder carries the device name)
const F_CONFIG = 'alteon-config.txt';
const F_MANUAL = 'needs-manual-work.txt';
const F_UNSUP = 'not-supported.txt';

function usage() {
  console.log(`f5-to-alteon - migrate F5 BIG-IP (tmsh) config to Radware Alteon CLI

Usage:
  f5-to-alteon <input> [more inputs ...] [options]

Inputs (auto-detected, mix freely):
  device.qkview / device.ucs     F5 support archive (config extracted for you)
  bigip.conf bigip_base.conf     tmsh config file(s)
  extracted-qkview-directory/    directory containing config/bigip.conf
  folder-with-many-archives/     BULK: every archive inside is converted,
                                 each into its own output folder

Output (default):
  A folder named after the input, created NEXT TO the input file.
  device.qkview  ->  device/
      ${F_CONFIG}          Alteon CLI configuration to apply
      ${F_MANUAL}       items to finish manually (each with the original F5 config)
      ${F_UNSUP}         items with no automatic Alteon equivalent

Options:
  -o, --out <dir>     Write here instead of the auto-named folder
                      (in bulk mode: parent folder for the per-device folders)
      --name <name>   Override the output folder name (single input only)
      --bulk          Force bulk mode on a folder
      --single        Force single-device mode on a folder
      --rd-mode <m>   Route-domain strategy: auto (default) | segment | split
      --stdout        Print the Alteon config to stdout (single input only)
  -h, --help          Show this help`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) { usage(); process.exit(args.length ? 0 : 1); }

const files = [];
let outDir = null, name = null, toStdout = false, rdMode = 'auto', bulkFlag = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o' || a === '--out') outDir = args[++i];
  else if (a === '--name') name = args[++i];
  else if (a === '--rd-mode') rdMode = args[++i];
  else if (a === '--stdout') toStdout = true;
  else if (a === '--bulk') bulkFlag = true;
  else if (a === '--single') bulkFlag = false;
  else files.push(a);
}
if (!['auto', 'segment', 'split'].includes(rdMode)) { console.error('error: --rd-mode must be auto, segment, or split'); process.exit(1); }
if (!files.length) { console.error('error: no input files'); process.exit(1); }

const ARCHIVE_RE = /\.(qkview|ucs|tar|tgz|tar\.gz)$/i;

// A folder is a BULK job when it holds 2+ archives and is not itself one
// device's extracted dump. --bulk / --single override the detection.
function bulkMembers(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  if (entries.includes('config') && fs.existsSync(path.join(dir, 'config', 'bigip.conf'))) return null;
  const archives = entries.filter(f => ARCHIVE_RE.test(f) && fs.statSync(path.join(dir, f)).isFile());
  if (bulkFlag === false) return null;
  if (archives.length >= 2 || (bulkFlag === true && archives.length >= 1)) {
    return archives.map(f => path.join(dir, f));
  }
  return null;
}

// device folder name from an input path: device.qkview -> "device"
function baseName(input) {
  const b = path.basename(input.replace(/[\\/]+$/, ''));
  return b.replace(ARCHIVE_RE, '').replace(/\.(conf|log|txt)$/i, '') || 'migration';
}

function writeResult(res, dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, F_CONFIG), res.output);
  for (const [rdId, rdOut] of Object.entries(res.rdOutputs || {})) {
    fs.writeFileSync(path.join(dir, 'alteon-config-routedomain-' + rdId + '.txt'), rdOut);
  }
  fs.writeFileSync(path.join(dir, F_MANUAL), res.log1);
  fs.writeFileSync(path.join(dir, F_UNSUP), res.log2);
  const manual = res.diagnostics.filter(d => d.sev === 'log1').length;
  const unsupported = res.diagnostics.filter(d => d.sev === 'log2').length;
  const parts = Object.entries(res.summary).filter(([, v]) => v > 0).map(([k, v]) => v + ' ' + k);
  const rd = Object.keys(res.rdOutputs || {}).length;
  console.log((label ? label + ': ' : '') + 'converted ' + (parts.join(', ') || 'nothing') +
    (rd ? ' | ' + rd + ' route-domain file(s)' : '') +
    ' | ' + manual + ' to finish manually, ' + unsupported + ' unsupported');
  console.log('  -> ' + dir);
  return { manual, unsupported, objects: res.objectCount };
}

async function convertOne(inputs, dir, label) {
  const texts = [];
  for (const f of inputs) {
    const resolved = await resolveInput(f);
    for (const s of resolved) texts.push(s.text);
    for (const n of resolved.notes || []) console.log('  NOTE: ' + n);
  }
  const res = migrate(texts, { rdMode });
  if (res.objectCount === 0) throw new Error('no F5 configuration objects found');
  return writeResult(res, dir, label);
}

(async () => {
  // ---- bulk: a folder holding several archives ----
  let bulk = null;
  if (files.length === 1) {
    try { if (detectKind(files[0]) === 'dir') bulk = bulkMembers(files[0]); } catch (e) { /* fall through */ }
  }
  if (bulk && bulk.length) {
    const parent = outDir || files[0];
    console.log('Bulk migration: ' + bulk.length + ' device archive(s) in ' + files[0] + '\n');
    let ok = 0, failed = [];
    for (const f of bulk) {
      const dir = path.join(parent, baseName(f));
      try { await convertOne([f], dir, path.basename(f)); ok++; }
      catch (e) { failed.push(path.basename(f) + ' (' + e.message + ')'); console.log(path.basename(f) + ': SKIPPED - ' + e.message); }
    }
    console.log('\nDone: ' + ok + ' of ' + bulk.length + ' converted' + (failed.length ? '; skipped: ' + failed.join(', ') : ''));
    console.log('Output folders are under ' + parent);
    process.exit(failed.length && !ok ? 1 : 0);
  }

  // ---- single device (one or more files belonging to it) ----
  if (toStdout) {
    const texts = [];
    for (const f of files) for (const s of await resolveInput(f)) texts.push(s.text);
    const res = migrate(texts, { rdMode });
    if (res.objectCount === 0) { console.error('error: no F5 configuration objects found in the input.'); process.exit(1); }
    process.stdout.write(res.output);
    process.exit(0);
  }
  const dirName = name || baseName(files[0]);
  const dir = outDir || path.join(path.dirname(path.resolve(files[0])), dirName);
  try {
    await convertOne(files, dir, null);
  } catch (e) {
    console.error('error: ' + e.message);
    if (/no F5 configuration objects/.test(e.message)) {
      console.error('       Expected tmsh config (ltm virtual/pool/node..., net vlan/self...),');
      console.error('       a .qkview/.ucs archive, or a directory containing config/bigip.conf.');
    }
    process.exit(1);
  }
})().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
