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

test('GTM stays a Phase-4 note; partition configs are INCLUDED as sources', async () => {
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
  assert.strictEqual(sources.length, 3, 'base + main + DMZ partition config');
  assert.strictEqual(sources.notes.length, 2);
  assert.ok(sources.notes.some(n => n.includes('GTM')));
  assert.ok(sources.notes.some(n => n.includes('partition DMZ INCLUDED')));
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

test('PARTITIONS: partition configs are extracted, prefixed, and their route domains become visible', async () => {
  const dir = tmpdir();
  const BASE = 'net vlan /Common/v_main {\n    tag 10\n    interfaces {\n        1.1 { }\n    }\n}\nnet self /Common/s_main {\n    address 10.1.1.5/24\n    vlan /Common/v_main\n}\n';
  const MAIN = 'ltm node /Common/app {\n    address 10.1.1.10\n}\nltm pool /Common/p_main {\n    members {\n        /Common/app:80 {\n            address 10.1.1.10\n        }\n    }\n}\n';
  const CORP_BASE = 'net route-domain /CORP/RD500 {\n    id 500\n    vlans {\n        /CORP/v_corp\n    }\n}\nnet vlan /CORP/v_corp {\n    tag 500\n    interfaces {\n        1.2 { }\n    }\n}\nnet self /CORP/s_corp {\n    address 10.50.1.5%500/24\n    vlan /CORP/v_corp\n}\n';
  const CORP_MAIN = 'ltm node /CORP/app {\n    address 10.50.1.10%500\n}\nltm pool /CORP/p_corp {\n    members {\n        /CORP/app:80 {\n            address 10.50.1.10%500\n        }\n    }\n}\nltm virtual /CORP/vs_corp {\n    destination /CORP/10.50.1.100%500:80\n    ip-protocol tcp\n    mask 255.255.255.255\n    pool /CORP/p_corp\n}\n';
  const tar = buildTar([
    ['config/bigip_base.conf', BASE],
    ['config/bigip.conf', MAIN],
    ['config/partitions/CORP/bigip_base.conf', CORP_BASE],
    ['config/partitions/CORP/bigip.conf', CORP_MAIN],
  ]);
  const f = path.join(dir, 'parts.qkview');
  fs.writeFileSync(f, zlib.gzipSync(tar));
  const sources = await resolveInput(f);
  assert.strictEqual(sources.length, 4, 'Common base+main plus CORP base+main');
  assert.ok(sources.notes.some(n => n.includes('partition CORP INCLUDED')));
  assert.deepStrictEqual(sources.partitions, ['CORP'], 'partition list surfaced for the parser');
  const { migrate } = require('../lib/index');
  const res = migrate(sources.map(s => s.text), { partitions: sources.partitions });
  // the partition route domain is now visible and drives split/segmentation
  const all = res.output + Object.values(res.rdOutputs || {}).join('\n');
  assert.match(all, /rip 10\.50\.1\.10/);
  // objects are partition-prefixed and no longer collide with /Common names
  assert.match(all, /\/c\/slb\/real CORP_app\n/);
  assert.match(all, /\/c\/slb\/real app\n/);
  assert.match(all, /CORP_p_corp/);
  assert.match(all, /CORP_vs_corp/);
  // PART-3: the vip is the plain ADDRESS - the partition prefix must never
  // reach an address field (the device rejects "vip CORP_10.50.1.100")
  assert.match(all, /vip 10\.50\.1\.100\n/);
  assert.doesNotMatch(all, /vip CORP_/);
});

test('PART-4: folder-nested objects in two partitions with the SAME leaf name do not collide', async () => {
  const dir = tmpdir();
  const mkPart = (prefix, subnet) =>
    'ltm node /' + prefix + '/APP/mail1 {\n    address ' + subnet + '.10\n}\n' +
    'ltm pool /' + prefix + '/APP/mail-pool {\n    members {\n        /' + prefix + '/APP/mail1:25 {\n            address ' + subnet + '.10\n        }\n    }\n}\n' +
    'ltm virtual /' + prefix + '/APP/mail-vs {\n    destination /' + prefix + '/' + subnet + '.1:25\n    ip-protocol tcp\n    mask 255.255.255.255\n    pool /' + prefix + '/APP/mail-pool\n}\n';
  const tar = buildTar([
    ['config/bigip_base.conf', 'net vlan /Common/v_main {\n    tag 10\n    interfaces {\n        1.1 { }\n    }\n}\n'],
    ['config/bigip.conf', 'ltm node /Common/normal {\n    address 1.2.3.4\n}\n'],
    ['config/partitions/CORP/bigip.conf', mkPart('CORP', '10.60.1')],
    ['config/partitions/PARTB/bigip.conf', mkPart('PARTB', '10.70.1')],
  ]);
  const f = path.join(dir, 'parts4.qkview');
  fs.writeFileSync(f, zlib.gzipSync(tar));
  const sources = await resolveInput(f);
  const { migrate } = require('../lib/index');
  const res = migrate(sources.map(s => s.text), { partitions: sources.partitions });
  const all = res.output + Object.values(res.rdOutputs || {}).join('\n');
  // BOTH partitions' objects must exist, partition-prefixed, with their own addresses
  assert.match(all, /\/c\/slb\/real CORP_mail1\n(    \w[^\n]*\n)*    rip 10\.60\.1\.10\n/);
  assert.match(all, /\/c\/slb\/real PARTB_mail1\n(    \w[^\n]*\n)*    rip 10\.70\.1\.10\n/);
  assert.match(all, /group CORP_mail-pool/);
  assert.match(all, /group PARTB_mail-pool/);
  assert.match(all, /virt CORP_mail-vs\n/);
  assert.match(all, /virt PARTB_mail-vs\n/);
  assert.match(all, /vip 10\.60\.1\.1\n/);
  assert.match(all, /vip 10\.70\.1\.1\n/);
});
