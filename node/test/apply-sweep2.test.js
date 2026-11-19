'use strict';
// Apply-level fleet sweep, round 2 (harness now reads the apply result):
// whole-apply refusals and one silent rport rewrite, each proven on 34.0.12.
const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../lib/index');

const pool = (name, port) => `ltm pool /Common/${name} {
    members {
        /Common/192.0.2.31:${port} {
            address 192.0.2.31
        }
    }
}
`;
const NODE = 'ltm node /Common/192.0.2.31 {\n    address 192.0.2.31\n}\n';
const CSSL = `ltm profile client-ssl /Common/cssl_a {
    cert-key-chain {
        a_0 {
            cert /Common/a.example.test.crt
            key /Common/a.example.test.key
        }
    }
    defaults-from /Common/clientssl
}
`;
const sslVirt = (n, ip, poolName) => `ltm virtual /Common/${n} {
    destination /Common/${ip}:443
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/${poolName}
    profiles {
        /Common/cssl_a {
            context clientside
        }
        /Common/http { }
        /Common/tcp { }
    }
}
`;

test('SSLPOL-1: SSL virtuals share one policy per fessl/backend combination (device caps policies at 47)', () => {
  let conf = NODE + pool('p443', 80) + CSSL;
  for (let i = 0; i < 60; i++) conf += sslVirt('vs' + i, '192.0.2.' + (100 + i), 'p443');
  const res = migrate([conf]);
  const defs = res.output.match(/^\/c\/slb\/ssl\/sslpol \S+\/fessl/mg) || [];
  assert.strictEqual(defs.length, 1, 'one policy definition');
  assert.strictEqual((res.output.match(/\/ssl\/sslpol f5ssl_fe\n/g) || []).length, 60);
  assert.doesNotMatch(res.output, /sslpol f5ssl_fe\/ena/);   // stays disabled until certs exist
});

test('SSLPOL-1: per route-domain split files each define the policy they use', () => {
  const conf = 'net route-domain /Common/2 {\n    id 2\n}\n' + NODE +
    'ltm node /Common/192.0.2.32%2 {\n    address 192.0.2.32%2\n}\n' + pool('p443', 80) +
    'ltm pool /Common/p2 {\n    members {\n        /Common/192.0.2.32%2:80 {\n            address 192.0.2.32%2\n        }\n    }\n}\n' +
    CSSL + sslVirt('vs_rd0', '192.0.2.150', 'p443') + sslVirt('vs_rd2', '192.0.2.151%2', 'p2');
  const res = migrate([conf], { rdMode: 'split' });
  const files = [res.output, ...Object.values(res.rdOutputs || {})];
  assert.strictEqual(files.length, 2, 'main + RD 2 file');
  for (const o of files) {
    assert.match(o, /\/ssl\/sslpol f5ssl_fe\n/);
    assert.match(o, /^\/c\/slb\/ssl\/sslpol f5ssl_fe\/fessl e/m);   // each separate device gets its own definition
  }
});

test('RPORT-1: rport 443 is set again after an SSL policy without backend SSL (device rewrites it to 80)', () => {
  const res = migrate([NODE + pool('p443', 443) + CSSL + sslVirt('vs_r', '192.0.2.160', 'p443')]);
  assert.match(res.output, /\/c\/slb\/virt vs_r\/service 443 https\/ssl\/sslpol f5ssl_fe\n\/c\/slb\/virt vs_r\/service 443 https\n {4}rport 443\n/);
});

test('PTMOUT-1: a persistence timeout under 10 min is raised to 10 (below the real tmout refuses the apply)', () => {
  const conf = NODE + pool('p1', 80) + `ltm persistence source-addr /Common/src_short {
    defaults-from /Common/source_addr
    timeout 180
}
ltm persistence source-addr /Common/src_long {
    defaults-from /Common/source_addr
    timeout 3600
}
ltm virtual /Common/vs_short {
    destination /Common/192.0.2.170:8000
    ip-protocol tcp
    mask 255.255.255.255
    persist {
        /Common/src_short {
            default yes
        }
    }
    pool /Common/p1
}
ltm virtual /Common/vs_long {
    destination /Common/192.0.2.171:8000
    ip-protocol tcp
    mask 255.255.255.255
    persist {
        /Common/src_long {
            default yes
        }
    }
    pool /Common/p1
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /vs_short\/service 8000 basic-slb\n[\s\S]*?pbind clientip\n {4}ptmout 10\n/);
  assert.match(res.output, /vs_long\/service 8000 basic-slb\n[\s\S]*?pbind clientip\n {4}ptmout 60\n/);
  assert.ok(res.diagnostics.some((d) => d.name === 'vs_short' && d.issue.includes('ptmout 10')));
  assert.ok(!res.diagnostics.some((d) => d.name === 'vs_long' && d.issue.includes('ptmout 10')));
});

test('SYSLOG-1: two F5 syslog servers with the same host:port are emitted once; remote-port after local-ip is read', () => {
  const conf = `sys syslog {
    remote-servers {
        /Common/FIREMON {
            host 192.0.2.220
        }
        /Common/remotesyslog1 {
            host 192.0.2.220
        }
        /Common/remotesyslog2 {
            host 192.0.2.221
            local-ip 192.0.2.5
            remote-port 1514
        }
    }
}
`;
  const res = migrate([conf]);
  assert.strictEqual((res.output.match(/hst\d 192\.0\.2\.220 /g) || []).length, 1);
  assert.match(res.output, /hst2 192\.0\.2\.221 7 7 all 1514\n/);
  assert.ok(res.diagnostics.some((d) => d.type === 'Syslog' && d.name === 'remotesyslog1'));
});

const ftpVirt = (n, ip, prof, extra) => `ltm virtual /Common/${n} {
    destination /Common/${ip}:21
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/pftp
    profiles {
${prof ? '        /Common/' + prof + ' { }\n' : ''}        /Common/tcp { }
    }
${extra || ''}}
`;

test('FTP-1: an F5 FTP virtual (ftp profile) gets dataport 20 and an ftp-data service with the same group and pip', () => {
  const conf = NODE + pool('pftp', 21) + ftpVirt('vs_ftp', '192.0.2.180', 'ftp',
    '    source-address-translation {\n        type automap\n    }\n');
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt vs_ftp\/service 21 ftp\n {4}group pftp\n {4}rport 21\n {4}dataport 20\n/);
  assert.match(res.output, /\/c\/slb\/virt vs_ftp\/service 20 ftp-data\n {4}group pftp\n {4}rport 20\n/);
  assert.ok(!res.diagnostics.some((d) => d.name === 'ftp' && d.issue.includes('no Alteon equivalent')));
});

test('FTP-1: a port-21 virtual WITHOUT an ftp profile is plain TCP (ftpp d), and a custom data port is put aside', () => {
  const conf = NODE + pool('pftp', 21) + ftpVirt('vs_tcp21', '192.0.2.181', null) +
    'ltm profile ftp /Common/ftp_odd {\n    data-port 10020\n    defaults-from /Common/ftp\n}\n' +
    ftpVirt('vs_odd', '192.0.2.182', 'ftp_odd');
  const res = migrate([conf]);
  assert.match(res.output, /vs_tcp21\/service 21 ftp\n {4}group pftp\n {4}rport 21\n {4}ftpp d\n/);
  assert.doesNotMatch(res.output, /vs_tcp21\/service 20 ftp-data/);
  assert.match(res.output, /vs_odd\/service 21 ftp\n {4}group pftp\n {4}rport 21\n {4}ftpp d\n/);
  assert.ok(res.diagnostics.some((d) => d.name === 'vs_odd' && d.issue.includes('data port 10020')));
});

test('SSLID-1: SSL session-ID persistence is omitted (with the manual step) on a virtual with an SSL policy, kept on SSL pass-through', () => {
  const persist = `ltm persistence ssl /Common/sslp {
    defaults-from /Common/ssl
    timeout 300
}
`;
  const withPersist = (v) => v.replace('    pool ', '    persist {\n        /Common/sslp {\n            default yes\n        }\n    }\n    pool ');
  const passthru = `ltm virtual /Common/vs_pt {
    destination /Common/192.0.2.181:443
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/p443
    profiles {
        /Common/tcp { }
    }
}
`;
  const res = migrate([NODE + pool('p443', 443) + CSSL + persist + withPersist(sslVirt('vs_off', '192.0.2.180', 'p443')) + withPersist(passthru)]);
  const off = res.output.split('/c/slb/virt vs_off\n')[1].split('/c/slb/virt vs_pt\n')[0];
  assert.match(off, /sslpol f5ssl_fe/);
  assert.doesNotMatch(off, /pbind/);
  const d = res.diagnostics.find((x) => x.name === 'vs_off' && x.issue.includes('SSL ID persistency cannot be used'));
  assert.ok(d, 'manual-step diagnostic');
  assert.match(d.issue, /\/c\/slb\/virt vs_off\/service 443 ssl\/pbind clientip and ptmout 10/);
  assert.doesNotMatch(d.issue, /pbind cookie/);  // device: an ssl service offers clientip|sslid|disable only
  const pt = res.output.split('/c/slb/virt vs_pt\n')[1];
  assert.doesNotMatch(pt.split('\n/c/slb/virt ')[0], /sslpol/);
  assert.match(pt, /pbind sslid\n {4}ptmout 10\n/);
});

test('IPHC-1: an any-port virtual whose group health check has no destination port is put aside; icmp / dport / LOGEXP of such parts are kept', () => {
  const anyPool = (n, mon, port) => `ltm pool /Common/${n} {
    members {
        /Common/192.0.2.41:${port} {
            address 192.0.2.41
        }
    }
${mon ? '    monitor ' + mon + '\n' : ''}}
`;
  const anyVirt = (n, ip, p) => `ltm virtual /Common/${n} {
    destination /Common/${ip}:0
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/${p}
    translate-port disabled
}
`;
  const mon = `ltm monitor http /Common/mon_10210 {
    defaults-from /Common/http
    destination *:10210
    interval 5
    timeout 16
}
`;
  const conf = 'ltm node /Common/192.0.2.41 {\n    address 192.0.2.41\n}\n' + mon +
    anyPool('p_https', '/Common/https', '443') + anyPool('p_none', '', '0') + anyPool('p_icmp', '/Common/gateway_icmp', '0') +
    anyPool('p_port', '/Common/mon_10210', '0') + anyPool('p_and', '/Common/gateway_icmp and /Common/mon_10210', '0') +
    anyVirt('va_https', '192.0.2.190', 'p_https') + anyVirt('va_none', '192.0.2.191', 'p_none') + anyVirt('va_icmp', '192.0.2.192', 'p_icmp') +
    anyVirt('va_port', '192.0.2.193', 'p_port') + anyVirt('va_and', '192.0.2.194', 'p_and');
  const res = migrate([conf]);
  for (const n of ['va_https', 'va_none']) {
    assert.doesNotMatch(res.output, new RegExp('^/c/slb/virt ' + n + '$', 'm'), n + ' put aside');
    assert.ok(res.diagnostics.some((d) => d.name === n && d.issue.includes('must be defined with a destination port')), n + ' diagnostic');
  }
  for (const n of ['va_icmp', 'va_port', 'va_and']) assert.match(res.output, new RegExp('^/c/slb/virt ' + n + '/service [0-9]+ ip$', 'm'), n + ' kept');
});

test('IFVIP-1: a virtual on a (non-floating) self-IP is put aside (refused at apply: same IP address as IP interface)', () => {
  const conf = `net vlan /Common/v10 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net self /Common/self_local {
    address 10.7.7.5/24
    vlan /Common/v10
}
ltm virtual /Common/dns_self {
    destination /Common/10.7.7.5:53
    ip-protocol udp
    mask 255.255.255.255
}
ltm virtual /Common/dns_other {
    destination /Common/10.7.7.9:53
    ip-protocol udp
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/l3\/if \d+\n {4}ena\n {4}ipver v4\n {4}addr 10\.7\.7\.5\n/);
  assert.doesNotMatch(res.output, /\/c\/slb\/virt dns_self/);
  assert.match(res.output, /\/c\/slb\/virt dns_other/);
  assert.ok(res.diagnostics.some((d) => d.name === 'dns_self' && d.issue.includes('same IP address as IP interface')));
});

test('BOM-1: a UTF-8 BOM before the first stanza does not drop it (seglab: rd1 VLAN binding lost -> empty segment 1)', () => {
  const conf = '﻿' + `net route-domain /Common/rd1 {
    id 1
    vlans {
        /Common/v_seg1
    }
}
net vlan /Common/v_seg1 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net self /Common/self_seg1 {
    address 10.210.240.201%1/16
    vlan /Common/v_seg1
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/segment 1\n {4}addvlan 10\n/);
  const tagged = migrate([{ text: conf, partition: null }]);
  assert.match(tagged.output, /\/c\/slb\/segment 1\n {4}addvlan 10\n/);
});

test('HCDEST-1: a monitor alias destination becomes "dest 4 <ip>" (a bare address is refused with Usage:)', () => {
  const conf = `ltm monitor gateway-icmp /Common/HM_Google {
    defaults-from /Common/gateway_icmp
    destination 8.8.8.8:*
    interval 5
    timeout 16
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /^ {4}dest 4 8\.8\.8\.8$/m);
  assert.doesNotMatch(res.output, /^ {4}dest 8\.8\.8\.8$/m);
});

test('NAMELEN-1: descriptive names fit the per-menu limits (filter 31, VLAN 32, group/real/hc 128)', () => {
  const long = 'D'.repeat(140);
  const conf = `net vlan /Common/Standalone-No-PCI_vlan_standalone_no-pci {
    tag 77
    interfaces {
        1.1 { }
    }
}
ltm monitor http /Common/hm_long {
    defaults-from /Common/http
    description "${long}"
}
ltm node /Common/n1 {
    address 10.9.9.1
    description "${long}"
}
ltm pool /Common/p1 {
    description "${long}"
    members {
        /Common/n1:80 {
            address 10.9.9.1
        }
    }
    monitor /Common/hm_long
}
ltm virtual /Common/vs_forwarder_office365_exchange2 {
    destination /Common/0.0.0.0:443
    ip-protocol tcp
    mask any
    pool /Common/p1
}
`;
  const res = migrate([conf]);
  for (const m of res.output.matchAll(/^\/c\/slb\/filt \d+\n {4}ena\n {4}name "([^"]*)"/gm)) assert.ok(m[1].length <= 31, 'filter name ' + m[1]);
  assert.match(res.output, /\/c\/l2\/vlan 77\n {4}ena\n {4}name Standalone-No-PCI_vlan_standalon\n/);
  const names = [...res.output.matchAll(/^ {4}name "(D+)"$/gm)].map((m) => m[1].length);
  assert.ok(names.length >= 3 && names.every((n) => n === 128), 'got ' + names);
  assert.ok(res.diagnostics.some((d) => d.issue.includes('allows 128')));
});

test('SEGVLAN-1: every segment VLAN is declared before its addvlan (clean 34.0.12 refuses addvlan of a not-yet-configured VLAN)', () => {
  const conf = `net route-domain /Common/rd1 {
    id 1
    vlans {
        /Common/v_seg1
    }
}
net vlan /Common/v_seg1 {
    tag 23
    interfaces {
        1.1 { }
    }
}
net self /Common/self_seg1 {
    address 192.168.2.30%1/24
    vlan /Common/v_seg1
}
`;
  const out = migrate([conf]).output;
  const decl = out.indexOf('/c/l2/vlan 23\n    ena\n');
  const add = out.indexOf('    addvlan 23\n');
  assert.ok(decl >= 0 && add > decl, 'VLAN 23 declared before addvlan');
});

test('SEGPORT-1: a route domain whose VLANs have no known port falls back to the per-RD split (segment filter cannot be bound)', () => {
  const conf = `net route-domain /Common/rd1 {
    id 1
    vlans {
        /Common/v_dmz
    }
}
net vlan /Common/v_dmz {
    tag 23
}
net self /Common/self_dmz {
    address 192.168.2.30%1/24
    vlan /Common/v_dmz
}
ltm virtual /Common/vs_dmz {
    destination /Common/192.168.2.26%1:80
    ip-protocol tcp
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /\/c\/slb\/segment/);
  assert.ok(Object.keys(res.rdOutputs || {}).length >= 1, 'per-RD output produced');
  assert.ok(res.diagnostics.some((d) => d.issue.includes('Network Segmentation NOT used')));
  const forced = migrate([conf], { rdMode: 'segment' });
  assert.doesNotMatch(forced.output, /\/c\/slb\/segment/);
});

// ---- gate round 14 (34.0.12): lines refused inside an otherwise clean apply ----
test('REALID-1: a node name with ":" is renamed and pool members follow', () => {
  const conf = 'ltm node /Common/QA_192.0.2.40:9002 {\n    address 192.0.2.40\n}\n' +
    'ltm pool /Common/p_colon {\n    members {\n        /Common/QA_192.0.2.40:9002:9002 {\n            address 192.0.2.40\n        }\n    }\n}\n';
  const r = migrate([conf]);
  assert.ok(!/\/c\/slb\/real [^\n]*:/.test(r.output), 'no real ID with ":"');
  assert.match(r.output, /\/c\/slb\/real QA_192\.0\.2\.40_9002\n/);
  assert.match(r.output, /\/c\/slb\/group p_colon\n(?:[^\n]*\n)*?    add QA_192\.0\.2\.40_9002\n/);
  assert.match(r.log1, /renamed to "QA_192\.0\.2\.40_9002"/);
});

test('ICMPDPORT-1: an ICMP check never gets a dport (F5 alias port *.8585)', () => {
  const conf = 'ltm monitor gateway-icmp /Common/icmp_8585 {\n    defaults-from /Common/gateway_icmp\n    destination *.8585\n    interval 5\n    timeout 16\n}\n';
  const r = migrate([conf]);
  const blk = r.output.split('/c/slb/advhc/health ').find((b) => / ICMP\n/.test(b.split('\n')[0] + '\n'));
  assert.ok(blk, 'ICMP check emitted');
  assert.ok(!/dport/.test(blk), 'no dport under ICMP');
});

test('TCPSEND-1: a tcp monitor send/recv never emits tcp/send/expect lines', () => {
  const noRecv = 'ltm monitor tcp /Common/t_send {\n    defaults-from /Common/tcp\n    destination *:*\n    interval 15\n    recv none\n    send "GET / HTTP/1.1\\r\\nConnection: Close \\r\\n\\r\\n"\n    timeout 46\n}\n';
  const withRecv = 'ltm monitor tcp /Common/t_recv {\n    defaults-from /Common/tcp\n    destination *:*\n    interval 5\n    recv "OK"\n    send "PING"\n    timeout 16\n}\n';
  const r = migrate([noRecv + withRecv]);
  assert.match(r.output, /\/c\/slb\/advhc\/health t_send TCP\n/);
  assert.match(r.output, /\/c\/slb\/advhc\/health t_recv TCP\n/);
  assert.ok(!/^\s+(tcp|send|expect)\b/m.test(r.output), 'no tcp submenu, send or expect');
  assert.match(r.log1, /t_recv[\s\S]*WEAKER/);
  assert.match(r.log1, /t_send[\s\S]*only checks that the connection opens/);
});

test('BODY-1: a POST send string never emits body """; a real body uses the paste form', () => {
  const mon = (n, send) => 'ltm monitor http /Common/' + n + ' {\n    defaults-from /Common/http\n    destination *:*\n    interval 5\n    recv "HTTP/1.1 200 OK"\n    send ' + send + '\n    timeout 16\n}\n';
  const empty = mon('p_empty', '"POST /api/create HTTP/1.1\\r\\nConnection: Close\\r\\nHost: \\r\\n\\r\\n"');
  const withBody = mon('p_body', '"POST /api/create HTTP/1.1\\r\\nHost: a.example.test\\r\\n\\r\\na=b&c=d"');
  const multi = mon('p_multi', '"POST /api/create HTTP/1.1\\r\\nHost: a.example.test\\r\\n\\r\\nline1\\r\\nline2"');
  const r = migrate([empty + withBody + multi]);
  assert.ok(!/body "/.test(r.output), 'no quoted body argument (it would be ignored and swallow lines)');
  const blk = (n) => r.output.split('/c/slb/advhc/health ').find((b) => b.startsWith(n + ' '));
  assert.ok(!/body/.test(blk('p_empty')), 'empty body not emitted');
  assert.match(blk('p_body'), /\n {8}body \na=b&c=d\n\.\.\.\n/);
  assert.ok(!/body/.test(blk('p_multi')), 'multi-line body put aside');
  assert.match(r.log1, /p_multi[\s\S]*NOT converted/);
});

const VL = (n, tag, members) => 'net vlan /Common/' + n + ' {\n    interfaces {\n' + members + '    }\n    tag ' + tag + '\n}\n';
test('VTAG-1: F5 tagged members get "tag ena" on the Alteon port before the VLAN adds', () => {
  const trunk = 'net trunk tr_ext {\n    interfaces {\n        1.1\n        1.2\n    }\n    lacp enabled\n}\n';
  const conf = trunk + VL('v101', 101, '        tr_ext {\n            tagged\n        }\n') + VL('v102', 102, '        tr_ext {\n            tagged\n        }\n');
  const out = migrate([conf]).output;
  for (const p of ['1', '2']) assert.match(out, new RegExp('/c/port ' + p + '\\n    tag ena\\n'), 'port ' + p + ' tagged');
  const iTag = out.indexOf('    tag ena'), iAdd = out.search(/\n    add [12]\n/);
  assert.ok(iTag > 0 && iAdd > iTag, 'tag ena precedes every add');
  assert.match(out, /\/c\/l2\/vlan 101\n    add 1\n    add 2/);
  assert.match(out, /\/c\/l2\/vlan 102\n    add 1\n    add 2/);
  assert.ok(!/pvid/.test(out), 'no native VLAN on F5 -> no pvid');
});

test('PVIDP-1: an untagged member gets its pvid before the add (no PVID prompt in a paste); native + tagged on one port', () => {
  const conf = VL('v10', 10, '        1.1 { }\n') + VL('v20', 20, '        1.2 {\n            untagged\n        }\n') +
    VL('v30', 30, '        1.2 {\n            tagged\n        }\n');
  const out = migrate([conf]).output;
  assert.match(out, /\/c\/port 1\n    pvid 10\n/);
  assert.match(out, /\/c\/port 2\n    tag ena\n    pvid 20\n/);
  const iPvid = out.indexOf('    pvid 10'), iAdd = out.indexOf('/c/l2/vlan 10\n    add 1');
  const iCreate = out.indexOf('/c/l2/vlan 10\n    ena');
  assert.ok(iCreate >= 0 && iCreate < iPvid && iPvid < iAdd, 'VLAN created, then pvid, then add');
  // the access port leaves VLAN 1 after the add (apply refused "member of multiple VLANs (1,40) without tagging");
  // the tagged port 2 stays (tagged multi-VLAN membership is allowed)
  assert.match(out, /\/c\/l2\/vlan 1\n    rem 1(\n|$)/);
  assert.ok(out.indexOf('/c/l2/vlan 1\n    rem 1') > iAdd, 'rem after the add');
  assert.ok(!/rem 2/.test(out));
  assert.ok(migrate([conf]).diagnostics.some((d) => /moved out of default VLAN 1/.test(d.issue)), 'factory-default assumption is logged');
  // the manual step proven on 34.5.7 for a port already in another VLAN on the target
  assert.ok(migrate([conf]).diagnostics.some((d) => /\/c\/l2\/vlan <old>\/rem <port>, before pasting/.test(d.issue)));
});

test('PVIDP-1: a port untagged in two VLANs keeps the first, the second is put aside', () => {
  const conf = VL('va', 40, '        1.1 { }\n') + VL('vb', 41, '        1.1 { }\n');
  const r = migrate([conf]);
  assert.match(r.output, /\/c\/l2\/vlan 40\n    add 1/);
  assert.ok(!/\/c\/l2\/vlan 41\n    add 1/.test(r.output));
  assert.match(r.log1, /UNTAGGED member of both VLAN 40 and VLAN 41/);
});
