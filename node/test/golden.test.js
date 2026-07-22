'use strict';
// Equivalence proof for the Node port:
//  1. Output must equal the frozen expected file byte-for-byte.
//  2. The diff between the Node output and the LEGACY tool's golden output
//     must consist ONLY of the documented bug-fix deltas (see DELTAS.md).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../lib/index');

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'sample01');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function run() {
  return migrate([read(FIX, 'bigip_base.conf'), read(FIX, 'bigip.conf')]);
}

test('output matches frozen expected file byte-for-byte', () => {
  assert.strictEqual(run().output, read(FIX, 'expected-node', 'output.txt'));
});

test('diff vs legacy golden contains ONLY the documented bug-fix deltas', () => {
  const legacy = read(FIX, 'golden', 'main_output.txt') + read(FIX, 'golden', 'base_output.txt');
  const node = run().output;
  const legacyLines = new Set(legacy.split('\n'));
  const nodeLines = new Set(node.split('\n'));
  const added = [...nodeLines].filter(l => !legacyLines.has(l));
  const removed = [...legacyLines].filter(l => !nodeLines.has(l));
  // Deliberate, documented deltas (see DELTAS.md):
  //  BUG-3 metric fix; BUG-4 NTP restored; BUG-5 mgmt gw restored;
  //  BUG-6 static route syntax (live-validated); BUG-7 numeric VLAN ports
  //  (live-validated); BUG-8 drain mode -> dis (live-validated: legacy's
  //  "shut psession" is an interactive command, invalid in offline config)
  assert.deepStrictEqual(added.sort(), [
    '    add 1',
    '    add 2',
    '    dis',
    '    gw 192.168.1.1',
    '    metric roundrobin',
    '    prisrv 10.0.0.10',
    '    secsrv 10.0.0.11',
    '    tzone -04:00',
    '/c/l3/route/ip4/add 10.10.30.0 255.255.255.0 10.10.20.1'
  ]);
  assert.deepStrictEqual(removed.sort(), [
    '    add 1.1',
    '    add 1.2',
    '    add 10.10.30.0 255.255.255.0 10.10.20.1',
    '    metric round-robin',
    '    shut psession',
    '/c/l3/route'
  ]);
});
