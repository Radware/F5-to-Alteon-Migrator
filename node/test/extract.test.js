'use strict';
// Tests for input auto-detection: .qkview/.ucs (gzipped tar), raw tar,
// extracted directory, and plain conf files.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { detectKind, resolveInput } = require('../lib/extract');

const MAIN = 'ltm node /Common/n1 {\n    address 1.2.3.4\n}\n';
const BASE = 'net vlan /Common/v10 {\n    tag 10\n}\n';

function tarEntry(name, content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);                 // checksum field = spaces while summing
  header.write('0', 156);                        // regular file
  header.write('ustar\x0000', 257);
  let sum = 0; for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTar(entries) {
  const parts = entries.map(([n, c]) => tarEntry(n, c));
  parts.push(Buffer.alloc(1024));                // end-of-archive
  return Buffer.concat(parts);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'f5a-extract-'));
}

test('qkview (gzipped tar) input: config files are found and ordered base-first', async () => {
  const dir = tmpdir();
  const tar = buildTar([
    ['VERSION', 'Product: BIG-IP\n'],
    ['config/bigip.conf', MAIN],
    ['config/bigip_base.conf', BASE],
    ['config/bigip_user.conf', '# ignored\n']
  ]);
  const qk = path.join(dir, 'unit.qkview');
  fs.writeFileSync(qk, zlib.gzipSync(tar));
  assert.strictEqual(detectKind(qk), 'targz');
  const sources = await resolveInput(qk);
  assert.strictEqual(sources.length, 2);
  assert.match(sources[0].label, /bigip_base\.conf$/);
  assert.strictEqual(sources[0].text, BASE);
  assert.strictEqual(sources[1].text, MAIN);
});

test('raw tar input works and ./-prefixed entry names are handled', async () => {
  const dir = tmpdir();
  const tar = buildTar([['./config/bigip.conf', MAIN]]);
  const f = path.join(dir, 'unit.tar');
  fs.writeFileSync(f, tar);
  assert.strictEqual(detectKind(f), 'tar');
  const sources = await resolveInput(f);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].text, MAIN);
});

test('extracted qkview directory input finds config/bigip*.conf', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'bigip.conf'), MAIN);
  fs.writeFileSync(path.join(dir, 'config', 'bigip_base.conf'), BASE);
  assert.strictEqual(detectKind(dir), 'dir');
  const sources = await resolveInput(dir);
  assert.strictEqual(sources.length, 2);
  assert.strictEqual(sources[0].text, BASE);
  assert.strictEqual(sources[1].text, MAIN);
});

test('plain conf file passes through unchanged', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'bigip.conf');
  fs.writeFileSync(f, MAIN);
  assert.strictEqual(detectKind(f), 'conf');
  const sources = await resolveInput(f);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].label, f);
  assert.strictEqual(sources[0].text, MAIN);
});

test('binary junk is rejected with a clear message, not converted to empty output', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'junk.bin');
  fs.writeFileSync(f, Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x00, 0x90]));
  assert.strictEqual(detectKind(f), 'binary');
  await assert.rejects(() => resolveInput(f), /not an F5 config/);
});

test('a dump folder with ONE device config inside is resolved automatically', async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'mydevice', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mydevice', 'config', 'bigip.conf'), MAIN);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'customer notes\n');
  const sources = await resolveInput(dir);
  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].text, MAIN);
});

test('a dump folder with SEVERAL device configs lists them and asks to pick one', async () => {
  const dir = tmpdir();
  for (const d of ['dev1', 'dev2']) {
    fs.mkdirSync(path.join(dir, d, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, d, 'config', 'bigip.conf'), MAIN);
  }
  fs.writeFileSync(path.join(dir, 'dev3.qkview'), zlib.gzipSync(buildTar([['config/bigip.conf', MAIN]])));
  await assert.rejects(() => resolveInput(dir), (e) => {
    assert.match(e.message, /contains 3 device configs/);
    assert.match(e.message, /dev1/);
    assert.match(e.message, /dev3\.qkview/);
    return true;
  });
});

test('migrate() reports an object-count summary (zero for non-F5 text)', () => {
  const { migrate } = require('../lib/index');
  const good = migrate([MAIN]);
  assert.strictEqual(good.summary.reals, 1);
  assert.ok(good.objectCount > 0);
  const junk = migrate(['# just a comment\nhello world\n']);
  assert.strictEqual(junk.objectCount, 0);
});

test('GTM and partition configs in an archive produce Phase-4 notes', async () => {
  const dir = tmpdir();
  const tar = buildTar([
    ['config/bigip.conf', MAIN],
    ['config/bigip_base.conf', BASE],
    ['config/bigip_gtm.conf', 'gtm wideip a { }\n'],
    ['config/partitions/DMZ/bigip.conf', MAIN]
  ]);
  const f = path.join(dir, 'gtmbox.qkview');
  fs.writeFileSync(f, zlib.gzipSync(tar));
  const sources = await resolveInput(f);
  assert.strictEqual(sources.length, 2);
  assert.strictEqual(sources.notes.length, 2);
  assert.ok(sources.notes.some(n => n.includes('GTM')));
  assert.ok(sources.notes.some(n => n.includes('PARTITION')));
});

test('FQDN-defined nodes are skipped with guidance, not emitted without an IP', () => {
  const { migrate } = require('../lib/index');
  const conf = `ltm node /Common/mimecast1 {
    fqdn {
        address-family all
        autopopulate enabled
        name eu-smtp-outbound-1.mimecast.com
    }
}
ltm node /Common/normal {
    address 1.2.3.4
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /real mimecast1/);
  assert.match(res.output, /real normal/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('FQDN-defined')));
  assert.ok(!res.diagnostics.some(d => d.issue === 'Unhandled line'));
});

test('archive without bigip.conf fails with a clear error', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'empty.qkview');
  fs.writeFileSync(f, zlib.gzipSync(buildTar([['VERSION', 'x\n']])));
  await assert.rejects(() => resolveInput(f), /no config\/bigip\.conf found/);
});

test('large non-config entries are streamed past, not buffered (early stop)', async () => {
  const dir = tmpdir();
  // config files first, then a 5 MB blob: extraction should stop early
  const tar = buildTar([
    ['config/bigip_base.conf', BASE],
    ['config/bigip.conf', MAIN],
    ['var/big.blob', 'x'.repeat(5 * 1024 * 1024)]
  ]);
  const f = path.join(dir, 'big.qkview');
  fs.writeFileSync(f, zlib.gzipSync(tar));
  const t0 = Date.now();
  const sources = await resolveInput(f);
  assert.strictEqual(sources.length, 2);
  assert.ok(Date.now() - t0 < 5000);
});
