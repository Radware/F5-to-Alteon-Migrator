'use strict';
// Input auto-detection & extraction so the CLI accepts whatever the user has:
// a .qkview / .ucs (gzipped tar), a plain .tar, an extracted qkview directory,
// or bare tmsh .conf files. Zero runtime dependencies: gunzip via zlib and a
// streaming ustar reader (qkviews can be gigabytes; only the config files are
// kept in memory, and reading stops as soon as they have been found).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// archive entry names we want, in migrate() input order (base first, then main)
const WANTED = ['config/bigip_base.conf', 'config/bigip.conf'];

function detectKind(file) {
  const st = fs.statSync(file);
  if (st.isDirectory()) return 'dir';
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, 4096, 0);
  fs.closeSync(fd);
  if (head[0] === 0x1f && head[1] === 0x8b) return 'targz';           // gzip magic
  if (n >= 262 && head.slice(257, 262).toString('ascii') === 'ustar') return 'tar';
  if (head.slice(0, n).includes(0)) return 'binary';                  // NUL byte: not a text config
  return 'conf';
}

// Streaming ustar reader. Resolves with {entryName: contentString} for every
// wanted entry found.
// Partition configs are CONVERTED (each partition's objects get a
// "<PARTITION>_" prefix); GTM remains detected-only (Phase 4).
const NOTEWORTHY_RE = /^config\/bigip_gtm\.conf$/;
const PARTITION_RE = /^config\/partitions\/([^/]+)\/bigip(_base)?\.conf$/;

function extractFromTar(file, gzipped, wantedNames, maxConfigBytes) {
  return new Promise((resolve, reject) => {
    const wanted = new Set(wantedNames);
    const found = {};
    const noteworthy = [];
    let keptBytes = 0;
    const src = fs.createReadStream(file);
    const input = gzipped ? src.pipe(zlib.createGunzip()) : src;
    let pending = Buffer.alloc(0);      // partial header block
    let mode = 'header';
    let entry = null;                   // {name, keep, chunks, bodyLeft, totalLeft}
    let finished = false;
    const finish = (err) => {
      if (finished) return; finished = true;
      src.destroy();
      if (err) reject(err); else resolve({ found, noteworthy });
    };
    input.on('data', (data) => {
      let buf = pending.length ? Buffer.concat([pending, data]) : data;
      pending = Buffer.alloc(0);
      while (buf.length && !finished) {
        if (mode === 'header') {
          if (buf.length < 512) { pending = buf; return; }
          const block = buf.slice(0, 512); buf = buf.slice(512);
          if (block.every(b => b === 0)) continue;          // end-of-archive padding
          let name = block.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
          const prefix = block.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
          if (prefix) name = prefix + '/' + name;
          name = name.replace(/^\.\//, '');
          const size = parseInt(block.slice(124, 136).toString('ascii').trim(), 8) || 0;
          if (size > 0 && NOTEWORTHY_RE.test(name)) noteworthy.push(name);
          // NOTE: no early-stop any more - partition configs
          // (config/partitions/*/bigip*.conf) can sit anywhere in the archive
          // and their number is unknown up front, so the whole tar is scanned.
          const pad = (512 - (size % 512)) % 512;
          entry = { name, keep: wanted.has(name) || PARTITION_RE.test(name), chunks: [], bodyLeft: size, totalLeft: size + pad };
          if (entry.keep && (keptBytes += size) > maxConfigBytes) {
            finish(new Error('the config files inside ' + file + ' are too large to convert'));
            return;
          }
          if (entry.totalLeft > 0) mode = 'body';
        } else {
          const take = Math.min(buf.length, entry.totalLeft);
          const part = buf.slice(0, take); buf = buf.slice(take);
          if (entry.keep && entry.bodyLeft > 0) {
            entry.chunks.push(part.slice(0, Math.min(part.length, entry.bodyLeft)));
          }
          entry.bodyLeft = Math.max(0, entry.bodyLeft - take);
          entry.totalLeft -= take;
          if (entry.totalLeft === 0) {
            if (entry.keep) found[entry.name] = Buffer.concat(entry.chunks).toString('utf8');
            mode = 'header';
          }
        }
      }
    });
    input.on('end', () => finish());
    input.on('error', finish);
    src.on('error', finish);
  });
}

// Extracted qkview/UCS directory (or any directory containing the confs,
// optionally under config/).
function readFromDir(dir) {
  const out = {};
  for (const want of WANTED) {
    const base = path.basename(want);
    for (const cand of [path.join(dir, 'config', base), path.join(dir, base)]) {
      if (fs.existsSync(cand)) { out[want] = fs.readFileSync(cand, 'utf8'); break; }
    }
  }
  const noteworthy = [];
  if (fs.existsSync(path.join(dir, 'config', 'bigip_gtm.conf'))) noteworthy.push('config/bigip_gtm.conf');
  const pdir = path.join(dir, 'config', 'partitions');
  if (fs.existsSync(pdir)) {
    for (const p of fs.readdirSync(pdir)) {
      for (const f of ['bigip_base.conf', 'bigip.conf']) {
        const cand = path.join(pdir, p, f);
        if (fs.existsSync(cand)) out['config/partitions/' + p + '/' + f] = fs.readFileSync(cand, 'utf8');
      }
    }
  }
  return { found: out, noteworthy };
}

// A directory that is NOT itself a device config may still be a folder the
// user dumped everything into. Scan one level for device-config candidates:
// .qkview/.ucs/.tar archives and subdirectories containing bigip.conf.
function scanDirForCandidates(dir) {
  const candidates = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(full, 'config', 'bigip.conf')) ||
          fs.existsSync(path.join(full, 'bigip.conf'))) candidates.push(full);
    } else if (entry.isFile()) {
      if (/\.(qkview|ucs)$/i.test(entry.name)) candidates.push(full);
      else if (/^bigip.*\.conf$/i.test(entry.name)) { /* handled by readFromDir */ }
      else {
        try { if (detectKind(full) === 'tar' || detectKind(full) === 'targz') candidates.push(full); }
        catch (e) { /* unreadable file: skip */ }
      }
    }
  }
  return candidates;
}

// Resolve one CLI input (archive/dir/conf) to an ordered list of
// {label, text} config sources. opts.maxConfigBytes caps what is held in memory
// (the HTTP service sets it; a bad upload must not exhaust the pod's RAM).
async function resolveInput(file, opts) {
  const maxConfigBytes = (opts && opts.maxConfigBytes) || Infinity;
  const kind = detectKind(file);
  if (kind === 'binary') {
    throw new Error(file + ' is not an F5 config, qkview/UCS archive, or config directory (binary content).');
  }
  if (kind === 'conf') {
    if (fs.statSync(file).size > maxConfigBytes) throw new Error(file + ' is too large to convert');
    return [{ label: file, text: fs.readFileSync(file, 'utf8') }];
  }
  let res;
  if (kind === 'dir') {
    res = readFromDir(file);
    if (!res.found['config/bigip.conf']) {
      // not a device dir itself -- maybe a folder full of qkviews/exports
      const candidates = scanDirForCandidates(file);
      if (candidates.length === 1) return resolveInput(candidates[0]);
      if (candidates.length > 1) {
        throw new Error('the folder ' + file + ' contains ' + candidates.length +
          ' device configs - run the tool on ONE of them (each is a separate BIG-IP):\n' +
          candidates.map(c => '    ' + c).join('\n'));
      }
    }
  } else res = await extractFromTar(file, kind === 'targz', WANTED, maxConfigBytes);
  const out = [];
  for (const want of WANTED) {
    if (res.found[want]) out.push({ label: file + ' -> ' + want, text: res.found[want] });
  }
  if (!out.some(o => o.label.endsWith('bigip.conf'))) {
    throw new Error('no config/bigip.conf found inside ' + file +
      (kind === 'dir' ? ' (expected <dir>/config/bigip.conf, <dir>/bigip.conf, or qkview/UCS files inside the folder)' : ' (is this a qkview/UCS archive?)'));
  }
  // Administrative PARTITIONS: converted alongside /Common. Each partition's
  // object paths (/CORP/name) are rewritten to a prefixed name under /Common
  // (/Common/CORP_name) IN EVERY FILE, so definitions, intra-partition
  // references and cross-partition references all stay consistent, and two
  // partitions can never collide on a short name. Route domains defined
  // inside partitions become visible to the RD split/segmentation logic
  // (field report: a device kept 6 of its 9 route domains in partitions).
  const partitions = [];
  for (const name of Object.keys(res.found)) {
    const m = name.match(PARTITION_RE);
    if (m && !partitions.includes(m[1])) partitions.push(m[1]);
  }
  for (const p of partitions.sort()) {
    for (const f of ['config/partitions/' + p + '/bigip_base.conf', 'config/partitions/' + p + '/bigip.conf']) {
      if (res.found[f]) out.push({ label: file + ' -> ' + f, text: res.found[f] });
    }
  }
  if (partitions.length) {
    for (const s of out) {
      for (const p of partitions) {
        // PART-4 (field data): prefix the LEAF of the path, not its first
        // segment. An object nested in a folder (/CORP/APP/pool1) used to
        // become /Common/CORP_APP/pool1, whose short name is plain "pool1" -
        // colliding silently with /RTCS/APP/pool1 (both devices in the field
        // report carry such pairs; the later partition overwrote the earlier
        // one). Now /CORP/APP/pool1 -> /Common/APP/CORP_pool1: the folder
        // chain is preserved (and later dropped), the leaf carries the
        // partition. Non-nested paths are unchanged by this form.
        const re = new RegExp('/' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/((?:[^/\\s:{}]+/)*)([^/\\s:{}]+)', 'g');
        s.text = s.text.replace(re, '/Common/$1' + p + '_$2');
      }
    }
  }
  // surfaced to the CLI
  out.notes = (res.noteworthy || []).map(n =>
    'device also has a GTM/DNS config (' + n + ') - GTM/GSLB is NOT converted (Phase 4)');
  for (const p of partitions.sort()) {
    out.notes.push('partition ' + p + ' INCLUDED - its objects are prefixed "' + p + '_" in the output');
  }
  out.partitions = partitions;   // PART-3: the parser un-prefixes address destinations
  return out;
}

module.exports = { detectKind, resolveInput, WANTED };
