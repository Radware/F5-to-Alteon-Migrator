'use strict';
// Field requests from the PS team thread (2026-11-19 / 2026-11-21), each
// proven on live Alteon 34.0.12 and 34.5.7 with apply.
const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../lib/index');

const mgmt = (routes) => 'sys management-ip 192.168.5.10/24 { }\n' +
  'sys management-route /Common/default {\n    gateway 192.168.5.1\n    network default\n}\n' + routes;
const route = (name, net, gw) => `sys management-route /Common/${name} {\n    gateway ${gw}\n    network ${net}\n}\n`;

test('MGMTRT-1: management routes are put aside with the exact one-line /c/sys/mmgmt/route/ipv4/add command', () => {
  const r = migrate([mgmt(route('h1', '192.0.2.10/32', '192.168.5.1') + route('n1', '198.51.100.0/24', '192.168.5.254'))]);
  // never in the config: an off-subnet gateway refuses the whole apply
  assert.ok(!r.output.includes('mmgmt/route'));
  const d1 = r.diagnostics.find((d) => d.issue.includes('Management route 192.0.2.10/32 via 192.168.5.1 NOT added'));
  assert.ok(d1 && d1.issue.includes('"/c/sys/mmgmt/route/ipv4/add 192.0.2.10 255.255.255.255 192.168.5.1"') && d1.issue.includes('whole apply'));
  assert.ok(r.diagnostics.some((d) => d.issue.includes('"/c/sys/mmgmt/route/ipv4/add 198.51.100.0 255.255.255.0 192.168.5.254"')));
  // the default route stays the management gateway
  assert.match(r.output, /\/c\/sys\/mmgmt\n(?:    .*\n)*    gw 192\.168\.5\.1\n/);
  // never the old "not supported" message
  assert.ok(!r.log1.includes('not supported by Alteon'));
});

test('MGMTRT-1: a gateway outside the F5 management subnet is flagged in the manual step', () => {
  const r = migrate([mgmt(route('off', '203.0.113.0/24', '10.20.30.1'))]);
  assert.ok(!r.output.includes('203.0.113.0'));
  assert.ok(r.diagnostics.some((d) => d.issue.includes('203.0.113.0/24 via 10.20.30.1 NOT added') && d.issue.includes('not on the F5 management subnet')));
});

test('MGMTRT-1: IPv6 and host-bit destinations are put aside; duplicates are listed once', () => {
  const r = migrate([mgmt(route('v6', '2001:db8:1::/64', '2001:db8::1') + route('hb', '198.51.100.7/24', '192.168.5.1') +
    route('d1', '192.0.2.20/32', '192.168.5.1') + route('d2', '192.0.2.20/32', '192.168.5.1'))]);
  assert.ok(r.diagnostics.some((d) => d.issue.includes('2001:db8:1::/64') && d.issue.includes('IPv6')));
  assert.ok(r.diagnostics.some((d) => d.issue.includes('198.51.100.7/24') && d.issue.includes('host bits')));
  assert.strictEqual(r.diagnostics.filter((d) => d.issue.includes('ipv4/add 192.0.2.20 ')).length, 1);
});

test('MGMTDHCP-1: "dhcp ena" follows sys global-settings mgmt-dhcp, not the always-present management-dhcp stanza', () => {
  const dhcpStanza = 'sys management-dhcp /Common/sys-mgmt-dhcp-config {\n    request-options { subnet-mask routers }\n}\n';
  const off = migrate([mgmt('') + dhcpStanza + 'sys global-settings {\n    hostname a.example\n    mgmt-dhcp disabled\n}\n']);
  assert.ok(!/^\s+dhcp /m.test(off.output));
  assert.match(off.output, /\/c\/sys\/mmgmt\n    addr 192\.168\.5\.10\n    mask 255\.255\.255\.0\n    gw 192\.168\.5\.1\n/);
  assert.ok(off.diagnostics.some((d) => d.issue.includes('/c/sys/mmgmt/dhcp disable')));
  // default (mgmt-dhcp not listed) keeps the previous output
  const def = migrate([mgmt('') + dhcpStanza + 'sys global-settings {\n    hostname a.example\n}\n']);
  assert.match(def.output, /^    dhcp ena$/m);
});

const longConf = (node, pool, virt) => `ltm node /Common/${node} {
    address 1.2.3.4
}
ltm pool /Common/${pool} {
    members {
        /Common/${node}:80 {
            address 1.2.3.4
        }
    }
    monitor /Common/tcp
}
ltm virtual /Common/${virt} {
    destination /Common/9.9.9.9:80
    mask 255.255.255.255
    pool /Common/${pool}
}
`;

test('IDLEN-1: real/group/virt names up to 255 characters are kept as is (no rename, no diagnostic)', () => {
  const node = 'n'.repeat(66), pool = 'p'.repeat(120), virt = 'v'.repeat(255);
  const r = migrate([longConf(node, pool, virt)]);
  assert.match(r.output, new RegExp('^/c/slb/real ' + node + '$', 'm'));
  assert.match(r.output, new RegExp('^/c/slb/group ' + pool + '$', 'm'));
  assert.match(r.output, new RegExp('^/c/slb/virt ' + virt + '$', 'm'));
  assert.match(r.output, new RegExp('^    add ' + node + '$', 'm'));
  assert.match(r.output, new RegExp('^    group ' + pool + '$', 'm'));
  assert.ok(!r.log1.includes('Alteon ID limit'));
});

test('IDLEN-1: a name over 255 characters is renamed to fit, with every reference updated', () => {
  const pool = 'p'.repeat(300);
  const r = migrate([longConf('n1', pool, 'v1')]);
  const g = (r.output.match(/^\/c\/slb\/group (\S+)$/m) || [])[1];
  assert.ok(g && g.length <= 255 && g !== pool);
  assert.match(r.output, new RegExp('^    group ' + g + '$', 'm'));
  assert.ok(r.log1.includes('255-char Alteon ID limit'));
});

test('IDLEN-1: maxIdLen 32 restores the old renaming (older Alteon releases)', () => {
  const r = migrate([longConf('n'.repeat(40), 'p'.repeat(40), 'v'.repeat(40))], { maxIdLen: 32 });
  for (const m of r.output.matchAll(/^\/c\/slb\/(?:real|group|virt) (\S+)$/gm)) assert.ok(m[1].length <= 32, m[1]);
  assert.ok(r.log1.includes('32-char Alteon ID limit'));
});
