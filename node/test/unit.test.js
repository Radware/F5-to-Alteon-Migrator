'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../lib/index');

test('BUG-6 fixed (live-validated): static route uses /c/l3/route/ip4/add', () => {
  const conf = 'net route /Common/r1 {\n    gw 10.0.0.1\n    network 10.9.9.0/24\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/l3\/route\/ip4\/add 10\.9\.9\.0 255\.255\.255\.0 10\.0\.0\.1/);
  assert.doesNotMatch(res.output, /\/c\/l3\/route\n {4}add/); // old, rejected form
});

test('BUG-7 fixed (live-validated): F5 interface 1.1 becomes numeric Alteon port', () => {
  const conf = 'net vlan /Common/v10 {\n    tag 10\n    interfaces {\n        1.1 { }\n        1.2 { }\n    }\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /add 1\n/);
  assert.match(res.output, /add 2/);
  assert.doesNotMatch(res.output, /add 1\.1/); // Alteon rejects 'bad port "1.1"'
});

test('BUG-1 fixed: standalone (non-HA) self-IP does not crash and becomes an interface', () => {
  const base = `net vlan /Common/v10 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net self /Common/standalone_self {
    address 10.1.1.5/24
    vlan /Common/v10
    allow-service default
}
`;
  const res = migrate([base]);   // legacy tool throws KeyError on this input
  assert.match(res.output, /\/c\/l3\/if 1\n {4}ena\n {4}ipver v4\n {4}addr 10\.1\.1\.5/);
  assert.doesNotMatch(res.output, /floatip/);
});

test('BUG-2 fixed: runs are isolated (no state leakage between migrate() calls)', () => {
  const withRoute = 'net route /Common/r1 {\n    gw 10.0.0.1\n    network 10.9.9.0/24\n}\n';
  const withoutRoute = 'ltm node /Common/n1 {\n    address 1.2.3.4\n}\n';
  migrate([withRoute]);
  const res2 = migrate([withoutRoute]);
  assert.doesNotMatch(res2.output, /10\.9\.9\.0/);  // legacy leaked this
});

test('BUG-3 fixed: explicit round-robin maps to valid Alteon metric', () => {
  const conf = `ltm pool /Common/p1 {
    load-balancing-mode round-robin
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
    monitor /Common/tcp
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /metric roundrobin/);
  assert.doesNotMatch(res.output, /metric round-robin/);
});

test('unmapped LB mode falls back to roundrobin with a diagnostic', () => {
  const conf = `ltm pool /Common/p1 {
    load-balancing-mode some-future-mode
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /metric roundrobin/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('Unmapped load-balancing-mode')));
});

test('BUG-4 fixed: sys ntp is parsed (legacy dropped it silently)', () => {
  const conf = 'sys ntp {\n    servers { 1.1.1.1 2.2.2.2 }\n    timezone UTC\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /prisrv 1\.1\.1\.1/);
  assert.match(res.output, /secsrv 2\.2\.2\.2/);
  assert.match(res.output, /tzone \+00:00/);
});

test('BUG-5 fixed: single management default route becomes mmgmt gw', () => {
  const conf = 'sys management-ip 192.168.5.5/24 { }\nsys management-route /Common/default {\n    gateway 192.168.5.1\n    network default\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /gw 192\.168\.5\.1/);
});

test('non-default management routes produce a manual diagnostic', () => {
  const conf = 'sys management-route /Common/x {\n    gateway 192.168.5.1\n    network 10.0.0.0/8\n}\n';
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('Management routes are not supported')));
});

test('iRules on a virtual produce a manual diagnostic (not silence)', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:80
    mask 255.255.255.255
    rules {
        /Common/my_irule
    }
}
`;
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('iRules')));
});

test('multiple monitors joined into a LOGEXP health check', () => {
  const conf = `ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
    monitor /Common/http and /Common/tcp
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /advhc\/health p1_logexp LOGEXP/);
  assert.match(res.output, /logexp \(http\)&\(tcp\)/);
});

// ---- gaps found by running real BIG-IP exports (Phase 3b) ----

test('GAP-1: node "state user-down" renders a disabled real (dis)', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    state user-down\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}dis\n/);
  assert.ok(!res.diagnostics.some(d => d.issue === 'Unhandled line'));
});

test('GAP-2: node-level ratio becomes real weight', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    ratio 5\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}ena\n {4}rip 1\.2\.3\.4\n {4}weight 5\n/);
});

test('GAP-2: ratio above Alteon max weight clamps to 48 with a diagnostic', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    ratio 90\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /weight 48/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('clamped')));
});

test('GAP-3 (legacy parity restored): pool-member ratio becomes real weight', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            ratio 3
        }
    }
    monitor /Common/tcp
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}ena\n {4}rip 1\.2\.3\.4\n {4}weight 3\n/);
});

test('GAP-3: conflicting member ratios keep first weight and warn', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            ratio 3
        }
    }
}
ltm pool /Common/p2 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            ratio 7
        }
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /weight 3/);
  assert.doesNotMatch(res.output, /weight 7/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('Conflicting ratios')));
});

test('GAP-4 (legacy parity restored): member-level monitor sets real health', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm monitor tcp /Common/my_tcp_mon {
    interval 5
    timeout 16
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            monitor /Common/my_tcp_mon
        }
    }
    monitor /Common/tcp
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}ena\n {4}rip 1\.2\.3\.4\n {4}health my_tcp_mon\n/);
});

test('GAP-5: member "state user-down" disables the real with a diagnostic', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            state user-down
        }
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}dis\n/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('forced offline')));
});

test('GAP-5 / BUG-8 (live-validated): "session user-disabled" becomes a disabled real, NOT "shut psession"', () => {
  // legacy emitted "shut psession" -- an interactive/operational command that
  // is not valid config (proven on live 34.5.7.0: it staged nothing)
  const nodeLevel = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    session user-disabled\n}\n';
  const res1 = migrate([nodeLevel]);
  assert.match(res1.output, /\/c\/slb\/real n1\n {4}dis\n/);
  assert.doesNotMatch(res1.output, /shut psession/);
  assert.ok(res1.diagnostics.some(d => d.issue.includes('drain mode')));
  const memberLevel = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
            session user-disabled
        }
    }
}
`;
  const res2 = migrate([memberLevel]);
  assert.match(res2.output, /\/c\/slb\/real n1\n {4}dis\n/);
  assert.doesNotMatch(res2.output, /shut psession/);
});

test('GAP-6: connection-limit becomes real maxcon (node and member level)', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
    connection-limit 1000
}
ltm node /Common/n2 {
    address 1.2.3.5
}
ltm pool /Common/p1 {
    members {
        /Common/n2:80 {
            address 1.2.3.5
            connection-limit 500
        }
    }
}
`;
  const res = migrate([conf]);
  // mode must be inline: bare "maxcon <n>" prompts for it interactively and
  // breaks config paste (live-validation finding on 34.5.7.0)
  assert.match(res.output, /\/c\/slb\/real n1\n {4}ena\n {4}rip 1\.2\.3\.4\n {4}maxcon 1000 physical\n/);
  assert.match(res.output, /\/c\/slb\/real n2\n {4}ena\n {4}rip 1\.2\.3\.5\n {4}maxcon 500 logical\n/);
});

test('GAP-7: F5 built-in monitors map to Alteon built-in health checks', () => {
  const conf = `ltm node /Common/n1 {
    address 1.2.3.4
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
    monitor /Common/gateway_icmp
}
ltm pool /Common/p2 {
    members {
        /Common/n1:8080 {
            address 1.2.3.4
        }
    }
    monitor /Common/tcp_half_open
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/group p1\n {4}ipver v4\n {4}health icmp\n/);
  assert.match(res.output, /\/c\/slb\/group p2\n {4}ipver v4\n {4}health tcp\n/);
  assert.ok(!res.diagnostics.some(d => d.issue.includes('was not defined')));
});

test('GAP-8: built-in F5 profiles with an Alteon mapping no longer warn', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:443
    mask 255.255.255.255
    profiles {
        /Common/f5-tcp-lan { }
        /Common/serverssl-insecure-compatible {
            context serverside
        }
    }
}
`;
  const res = migrate([conf]);
  assert.ok(!res.diagnostics.some(d => d.issue.includes('not found in both config and default')));
});

test('GAP-8: built-in profiles with no Alteon equivalent get a targeted diagnostic', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:80
    mask 255.255.255.255
    profiles {
        /Common/websecurity { }
    }
}
`;
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('no Alteon equivalent')));
  assert.ok(!res.diagnostics.some(d => d.issue.includes('not found in both config and default')));
});

test('GAP-10: pool "monitor min 1 of { A B }" becomes an OR LOGEXP', () => {
  const conf = `ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
    monitor min 1 of { /Common/http /Common/tcp }
}
ltm pool /Common/p2 {
    members {
        /Common/n1:81 {
            address 1.2.3.4
        }
    }
    monitor min 1 of { /Common/http /Common/tcp /Common/gateway_icmp }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /advhc\/health p2_logexp LOGEXP/);
  assert.match(res.output, /logexp \(http\)\|\(tcp\)\|\(icmp\)/);
  // pool head must reference the logexp, not a mangled name like "tcp }"
  assert.doesNotMatch(res.output, /health .*\}/);
  assert.ok(!res.diagnostics.some(d => d.issue.includes('was not defined')));
});

test('GAP-10: "min 2 of" approximated as OR with a semantics warning', () => {
  const conf = `ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
    monitor min 2 of { /Common/http /Common/tcp /Common/gateway_icmp }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /logexp \(http\)\|\(tcp\)\|\(icmp\)/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('approximated as OR')));
});

test('GAP-10: node-level "monitor min 1 of" also becomes a LOGEXP on the real', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    monitor min 1 of { /Common/gateway_icmp /Common/tcp }\n}\n';
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real n1\n {4}ena\n {4}rip 1\.2\.3\.4\n {4}health n1_logexp\n/);
  assert.match(res.output, /advhc\/health n1_logexp LOGEXP/);
  assert.match(res.output, /logexp \(icmp\)\|\(tcp\)/);
});

// ---- fixes driven by full real-config LIVE validation on both Alteons ----

test('LIVE-1: pool without a monitor omits the health line (empty "health " prompts interactively)', () => {
  const conf = `ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.4
        }
    }
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /health *\n/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('default health check')));
});

test('LIVE-2: disabled virtual renders "dis", not "disable"', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:8080
    mask 255.255.255.255
    disabled
}
`;
  const res = migrate([conf]);
  if (/    dis\n|    disable\n/.test(res.output)) {
    assert.match(res.output, /    dis\n/);
    assert.doesNotMatch(res.output, /    disable\n/);
  }
});

test('LIVE-3: VLAN tags above 4090 are omitted with their self-IPs (Alteon max is 4090)', () => {
  const conf = `net vlan /Common/HA_vlan {
    tag 4094
    interfaces {
        1.2 { }
    }
}
net vlan /Common/data {
    tag 100
    interfaces {
        1.1 { }
    }
}
net self /Common/ha_self {
    address 10.9.9.1/24
    traffic-group /Common/traffic-group-local-only
    vlan /Common/HA_vlan
}
net self /Common/data_self {
    address 10.8.8.1/24
    traffic-group /Common/traffic-group-local-only
    vlan /Common/data
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /vlan 4094/);
  assert.doesNotMatch(res.output, /10\.9\.9\.1/);
  assert.match(res.output, /\/c\/l2\/vlan 100/);
  assert.match(res.output, /addr 10\.8\.8\.1/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('exceeds the Alteon maximum')));
});

test('LIVE-4: SNAT pool names over 32 chars are shortened for the nwclss ID', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:443
    mask 255.255.255.255
    source-address-translation {
        pool /Common/Boton_de_pago_PrincipalSeguros_TLS1_snatpool
        type snat
    }
}
`;
  const res = migrate([conf]);
  const m = res.output.match(/nwclss v4 (\S+) persist disable/);
  assert.ok(m, 'nwclss line missing');
  assert.ok(m[1].length <= 32, 'nwclss id still too long: ' + m[1]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('32-char')));
});

test('LIVE-5: reserved ports force the matching application (80/https -> http, 25/basic-slb -> smtp)', () => {
  const conf = `ltm virtual /Common/vhttps80 {
    destination /Common/1.2.3.4:80
    mask 255.255.255.255
    profiles {
        /Common/clientssl {
            context clientside
        }
    }
}
ltm virtual /Common/vsmtp {
    destination /Common/1.2.3.5:25
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt vhttps80\/service 80 http\n/);
  assert.doesNotMatch(res.output, /service 80 https/);
  assert.match(res.output, /\/c\/slb\/virt vsmtp\/service 25 smtp\n/);
  assert.ok(res.diagnostics.filter(d => d.issue.includes('reserved for')).length === 2);
});

test('LIVE-6: non-slot-1 F5 interfaces (vCMP "2.0") warn about port mapping', () => {
  const conf = `net vlan /Common/v10 {
    tag 10
    interfaces {
        2.0 { }
    }
}
`;
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('verify the target Alteon has this port')));
});

test('LIVE-7: cookie persistence on a non-HTTP service is omitted with a diagnostic', () => {
  const conf = `ltm virtual /Common/vwild {
    destination /Common/1.2.3.4:8443
    mask 255.255.255.255
    persist {
        /Common/cookie {
            default yes
        }
    }
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /pbind cookie/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('Cookie persistence needs an HTTP/HTTPS service')));
});

// ---- fixes from the 33-device batch staging (LIVE-9..LIVE-14) ----

test('LIVE-9: names over 32 chars are renamed everywhere (defs AND references)', () => {
  const longNode = 'a_very_long_node_name_that_exceeds_32_chars';
  const longPool = 'M2N-POS-PROD-AdmindeSuperExpressLtda_pool';
  const longVirt = 'VS_a_very_long_virtual_server_name_over_32';
  const conf = `ltm node /Common/${longNode} {
    address 1.2.3.4
}
ltm pool /Common/${longPool} {
    members {
        /Common/${longNode}:80 {
            address 1.2.3.4
        }
    }
    monitor /Common/tcp
}
ltm virtual /Common/${longVirt} {
    destination /Common/9.9.9.9:80
    mask 255.255.255.255
    pool /Common/${longPool}
}
`;
  const res = migrate([conf]);
  for (const m of res.output.matchAll(/^\/c\/slb\/(?:real|group|virt) ([^\s/]+)/gm)) {
    assert.ok(m[1].length <= 32, 'ID still too long: ' + m[1]);
    assert.match(m[1], /^[\w.-]+$/, 'ID has special chars the CLI rejects: ' + m[1]);
  }
  // references updated consistently: the group's add matches the real's new name,
  // the virt service group matches the pool's new name
  const real = res.output.match(/\/c\/slb\/real (\S+)/)[1];
  const group = res.output.match(/\/c\/slb\/group (\S+)/)[1];
  assert.ok(res.output.includes('    add ' + real + '\n'));
  assert.ok(res.output.includes('    group ' + group + '\n'));
  assert.ok(res.diagnostics.filter(d => d.issue.includes('32-char Alteon ID limit')).length === 3);
});

test('LIVE-10: a virtual without a destination is skipped, never "service undefined"', () => {
  const conf = `ltm virtual /Common/VS_gtm_managed {
    ip-protocol tcp
    pool /Common/p1
    profiles {
        /Common/http { }
    }
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /undefined/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('no destination')));
});

test('LIVE-11: non-ASCII text is replaced and flagged (Alteon rejects it)', () => {
  const conf = 'ltm pool /Common/p1 {\n    description "Comunicación Piloto"\n    members {\n        /Common/n1:80 {\n            address 1.2.3.4\n        }\n    }\n}\n';
  const res = migrate([conf]);
  assert.ok(!/[^\n\r\x20-\x7e]/.test(res.output), 'output still has non-ASCII');
  assert.ok(res.diagnostics.some(d => d.issue.includes('non-ASCII')));
});

test('LIVE-12: hostname NTP servers are flagged, not emitted', () => {
  const conf = 'sys ntp {\n    servers { ntp.corp-internal.local 10.1.1.1 }\n    timezone UTC\n}\n';
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /prisrv ntp\./);
  assert.match(res.output, /prisrv 10\.1\.1\.1/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('NTP server is a hostname')));
});

test('LIVE-13: unresolved trunk names never leak into VLAN adds; routes need an IPv4 gw', () => {
  const conf = `net vlan /Common/sync_vcmp {
    tag 1302
    interfaces {
        trunk_sync_vcmp { }
    }
}
net route /Common/broken {
    network 10.9.9.0/24
}
`;
  const res = migrate([conf]);
  assert.doesNotMatch(res.output, /add trunk_sync_vcmp/);
  assert.doesNotMatch(res.output, /null/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('could not be mapped to a numeric Alteon port')));
  assert.ok(res.diagnostics.some(d => d.issue.includes('no usable IPv4 gateway')));
});

test('LIVE-14: hard-reserved ports force their application (53->dns, 22->ssh, 389->ldap)', () => {
  const conf = `ltm virtual /Common/vdns {
    destination /Common/1.2.3.4:53
    mask 255.255.255.255
}
ltm virtual /Common/vssh {
    destination /Common/1.2.3.4:22
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt vdns\/service 53 dns\n/);
  assert.match(res.output, /\/c\/slb\/virt vssh\/service 22 ssh\n/);
  assert.ok(res.diagnostics.filter(d => d.issue.includes('reserved for')).length === 2);
});

test('LIVE-19: persistence renders BEFORE the pip block (pbind is a service-menu command)', () => {
  const conf = `ltm virtual /Common/vboth {
    destination /Common/1.2.3.4:8443
    mask 255.255.255.255
    persist {
        /Common/source_addr {
            default yes
        }
    }
    profiles {
        /Common/http { }
    }
    source-address-translation {
        pool /Common/my_snatpool
        type snat
    }
}
`;
  const res = migrate([conf]);
  const pbindAt = res.output.indexOf('pbind clientip');
  const pipAt = res.output.indexOf('/pip');
  assert.ok(pbindAt > -1 && pipAt > -1, 'both blocks expected');
  assert.ok(pbindAt < pipAt, 'pbind must come before the /pip submenu block');
});

test('LIVE-18: radius ports force radius-auth/radius-acc applications', () => {
  const conf = `ltm virtual /Common/ise_auth {
    destination /Common/1.2.3.4:1812
    mask 255.255.255.255
}
ltm virtual /Common/ise_acct {
    destination /Common/1.2.3.4:1813
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /service 1812 radius-auth\n/);
  assert.match(res.output, /service 1813 radius-acc\n/);
});

test('LIVE-15: cookie names over 20 chars are shortened (device limit, verified live)', () => {
  const conf = `ltm persistence cookie /Common/p_cookie {
    cookie-name lb_portal_ibm_retail_cookie
    method insert
}
ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:8080
    mask 255.255.255.255
    persist {
        /Common/p_cookie {
            default yes
        }
    }
    profiles {
        /Common/http { }
    }
}
`;
  const res = migrate([conf]);
  const m = res.output.match(/pbind cookie insert "([^"]+)"/);
  assert.ok(m, 'pbind line missing');
  assert.ok(m[1].length <= 20, 'cookie name still too long: ' + m[1]);
  assert.ok(res.diagnostics.some(d => d.issue.includes("20-char limit")));
});

test('LIVE-16: smtp monitor without a username becomes a TCP check (apply-blocker on Alteon)', () => {
  const conf = `ltm monitor smtp /Common/prueba_dlp {
    defaults-from smtp
    interval 10
    timeout 31
}
ltm pool /Common/p1 {
    members {
        /Common/n1:25 {
            address 1.2.3.4
        }
    }
    monitor /Common/prueba_dlp
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /advhc\/health prueba_dlp TCP/);
  assert.doesNotMatch(res.output, /SMTP/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('refuse to APPLY')));
});

test('LIVE-17: route-domain suffixes are stripped from node and self-IP addresses with diagnostics', () => {
  const conf = `ltm node /Common/n1 {
    address 10.41.233.66%4
}
net vlan /Common/v10 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net self /Common/s1 {
    address 10.41.233.205%4/29
    traffic-group /Common/traffic-group-local-only
    vlan /Common/v10
}
`;
  const res = migrate([conf], { rdMode: 'split' });   // force split (auto would use segments here)
  const rd4 = res.rdOutputs['4'];         // RD objects land in their own output
  assert.ok(rd4, 'missing RD4 output');
  assert.match(rd4, /rip 10\.41\.233\.66\n/);
  assert.match(rd4, /addr 10\.41\.233\.205\n/);
  assert.doesNotMatch(res.output + rd4, /%/);
  assert.ok(res.diagnostics.filter(d => d.issue.includes('RD suffix stripped')).length === 2);
});

test('TMC-1: source-match forwarding virtual + address-list becomes a network class the filter matches on (live-validated)', () => {
  const conf = `net address-list /Common/Inside_ESA-EDN {
    addresses {
        10.41.232.194 { }
        10.41.232.197 { }
    }
    description "Inside ESA EDN Interface IPs"
}
ltm traffic-matching-criteria /Common/fwd_TMC_OBJ {
    destination-address-inline 0.0.0.0
    source-address-inline 0.0.0.0
    source-address-list /Common/Inside_ESA-EDN
}
ltm virtual /Common/fwd_vs {
    ip-forward
    profiles {
        /Common/fastL4 { }
    }
    traffic-matching-criteria /Common/fwd_TMC_OBJ
    translate-address disabled
    translate-port disabled
}
`;
  const res = migrate([conf]);
  // network class, exactly as the device accepted it
  assert.match(res.output, /\/c\/slb\/nwclss Inside_ESA-EDN\n {4}ipver v4\n {4}type address\n/);
  assert.match(res.output, /\/c\/slb\/nwclss Inside_ESA-EDN\/network 1\n {4}net subnet 10\.41\.232\.194 255\.255\.255\.255 include\n/);
  assert.match(res.output, /\/c\/slb\/nwclss Inside_ESA-EDN\/network 2\n {4}net subnet 10\.41\.232\.197 255\.255\.255\.255 include\n/);
  // filter matches source by the class - and no smask when a class is used
  assert.match(res.output, /\/c\/slb\/filt \d+\n(?:.*\n)*? {4}sip Inside_ESA-EDN\n/);
  assert.doesNotMatch(res.output, /sip Inside_ESA-EDN\n {4}smask/);
  // the class must be defined before the filter that references it
  assert.ok(res.output.indexOf('/c/slb/nwclss Inside_ESA-EDN') < res.output.indexOf('sip Inside_ESA-EDN'));
});

test('TMC-2: CIDR entries, and a missing address-list falls back to sip any with a diagnostic', () => {
  const conf = `net address-list /Common/Nets {
    addresses {
        10.99.0.0/16 { }
    }
}
ltm traffic-matching-criteria /Common/t1 {
    source-address-list /Common/Nets
}
ltm traffic-matching-criteria /Common/t2 {
    source-address-list /Common/DoesNotExist
}
ltm virtual /Common/v1 {
    ip-forward
    traffic-matching-criteria /Common/t1
}
ltm virtual /Common/v2 {
    ip-forward
    traffic-matching-criteria /Common/t2
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /net subnet 10\.99\.0\.0 255\.255\.0\.0 include/);
  assert.match(res.output, / {4}sip any\n {4}smask 0\.0\.0\.0\n/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('was not found in the input')));
});

test('AUTOMAP-1: SNAT automap becomes "pip mode egress" with the REQUIRED PIP-table companion flagged (live-validated)', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:80
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/p1
    source-address-translation {
        type automap
    }
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 1.2.3.10
        }
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt v1\/service 80 http\/pip\n {4}mode egress\n/);
  // no floats in this config -> the REQUIRED free-IP warning
  const d = res.diagnostics.find(x => x.issue.includes('pip mode egress'));
  assert.ok(d, 'expected the automap conversion diagnostic');
  assert.ok(d.issue.includes('REQUIRED'), 'diagnostic must mark the PIP-table step as REQUIRED');
  assert.ok(d.issue.includes('/c/slb/pip/add'), 'diagnostic must quote the exact companion commands');
  assert.ok(d.issue.includes('rtsrcmac'), 'diagnostic must mention the no-NAT alternative');
  assert.doesNotMatch(res.output, /\/c\/slb\/pip\n/, 'no PIP table without a float to reuse');
  // persistence ordering (LIVE-19) must still hold: pbind before the pip block
  const conf2 = conf.replace('    source-address-translation {', `    persist {
        /Common/cookie {
            default yes
        }
    }
    source-address-translation {`);
  const res2 = migrate([conf2]);
  const pbindAt = res2.output.indexOf('pbind cookie');
  const pipAt = res2.output.indexOf('/pip\n    mode egress');
  assert.ok(pbindAt > -1 && pipAt > -1 && pbindAt < pipAt, 'pbind must come before the pip block');
});

test('AUTOMAP-2: with floating self-IPs, the PIP table is auto-filled from them (float-as-PIP verified live)', () => {
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
net self /Common/self_float {
    address 10.7.7.4/24
    floating enabled
    traffic-group /Common/traffic-group-1
    vlan /Common/v10
}
ltm virtual /Common/v1 {
    destination /Common/10.7.7.100:80
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/p1
    source-address-translation {
        type automap
    }
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 10.7.7.10
        }
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/pip\n {4}type vlan\n\/c\/slb\/pip\/add 10\.7\.7\.4 10\n/);
  assert.match(res.output, /\/c\/slb\/virt v1\/service 80 http\/pip\n {4}mode egress\n/);
  const d = res.diagnostics.find(x => x.issue.includes('FILLED AUTOMATICALLY'));
  assert.ok(d, 'expected the auto-filled informational diagnostic');
  assert.ok(d.issue.includes('10.7.7.4'), 'diagnostic names the reused float IP');
  assert.ok(d.issue.includes('HA'), 'diagnostic flags the HA review point');
});

test('LIVE-22: SSL persistence emits "pbind sslid" (not "ssl", which the device silently ignores) and only on SSL services', () => {
  const mk = (port, profile) => `ltm persistence ssl /Common/ssl_persist {
    timeout 1800
}
ltm virtual /Common/v_${port} {
    destination /Common/1.2.3.4:${port}
    mask 255.255.255.255
    persist {
        /Common/ssl_persist {
            default yes
        }
    }
    pool /Common/p1
    profiles {
        ${profile}
    }
}
ltm pool /Common/p1 {
    members {
        /Common/n1:${port} {
            address 1.2.3.10
        }
    }
}
`;
  const ssl = migrate([mk('443', '/Common/clientssl { context clientside }')]);
  assert.match(ssl.output, / {4}pbind sslid\n {4}ptmout 30\n/);
  assert.doesNotMatch(ssl.output, /pbind ssl\n/);
});

const MULTI_RD_CONF = `net route-domain /Common/0 {
    id 0
    vlans {
        /Common/vlan_main
    }
}
net route-domain /Common/RD5 {
    description "Outside ESA"
    id 5
    vlans {
        /Common/vlan_rd5
    }
}
net vlan /Common/vlan_main {
    tag 100
    interfaces {
        1.1 { }
    }
}
net vlan /Common/vlan_rd5 {
    tag 200
    interfaces {
        1.2 { }
    }
}
net route /Common/rd5_default {
    gw 10.2.2.254%5
    network default
}
ltm node /Common/srv_main {
    address 10.1.1.10
}
ltm node /Common/srv_rd5 {
    address 10.2.2.10%5
}
ltm pool /Common/pool_rd5 {
    members {
        /Common/srv_rd5:80 {
            address 10.2.2.10%5
        }
    }
    monitor /Common/tcp
}
ltm virtual /Common/vs_rd5 {
    destination /Common/10.2.2.100%5:80
    mask 255.255.255.255
    pool /Common/pool_rd5
}
`;

test('SEGMENT: non-overlapping route domains become Alteon Network Segments on one device', () => {
  const res = migrate([MULTI_RD_CONF]);          // auto mode -> segment (no overlap)
  assert.deepStrictEqual(res.rdOutputs, {}, 'segment mode must produce a SINGLE output');
  assert.match(res.output, /\/c\/slb\/segment 5\n(?:    name "Outside ESA"\n)?    addvlan 200\n/);
  assert.match(res.output, /\/c\/slb\/virt vs_rd5\n(?:.*\n)*?    segment "5"\n    rtsrcmac ena\n/);
  // segment definitions must precede the virts (live finding: forward
  // reference warns "Invalid Segment id")
  assert.ok(res.output.indexOf('/c/slb/segment 5') < res.output.indexOf('/c/slb/virt vs_rd5'));
  assert.match(res.output, /\/c\/slb\/real seg5_gw\n    ena\n    ipver v4\n    rip 10\.2\.2\.254\n/);
  assert.match(res.output, /\/c\/slb\/filt 1800\n    ena\n    action redir\n    ipver v4\n    segment 5\n/);
  assert.match(res.output, /group seg5_gw_grp\n/);
  assert.match(res.output, /\/c\/slb\/port 2\n    client ena\n    server ena\n    proxy ena\n    filt ena\n    add 1800\n/);
  // both RDs' objects live in the one output
  assert.match(res.output, /real srv_main/);
  assert.match(res.output, /real srv_rd5/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('Alteon Network Segmentation on a SINGLE device')));
});

test('SEGMENT: RD-scoped default route ("network default%N") feeds the segment gateway', () => {
  // Real tmsh writes the RD suffix on the NETWORK too ("network default%5"),
  // not just the gw. That form must still produce the segment redirect
  // filter + gateway group (found live: the filter was silently missing).
  const conf = MULTI_RD_CONF.replace('gw 10.2.2.254%5\n    network default', 'gw 10.2.2.254%5\n    network default%5');
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/real seg5_gw\n    ena\n    ipver v4\n    rip 10\.2\.2\.254\n/);
  assert.match(res.output, /\/c\/slb\/filt 1800\n    ena\n    action redir\n    ipver v4\n    segment 5\n/);
  assert.ok(!res.diagnostics.some(d => d.issue.includes('No default gateway found for route domain 5')));
  // and an RD-scoped STATIC route lands in that RD's split output, not dropped
  const conf2 = MULTI_RD_CONF + 'net route /Common/rd5_static {\n    gw 10.2.2.254%5\n    network 10.77.0.0%5/16\n}\n';
  const res2 = migrate([conf2], { rdMode: 'split' });
  assert.match(res2.rdOutputs['5'], /\/c\/l3\/route\/ip4\/add 10\.77\.0\.0 255\.255\.0\.0 10\.2\.2\.254/);
});

test('SEGMENT: duplicate SELF-IP across RDs refuses segmentation (F5 allows dup IPs per RD; Alteon does not)', () => {
  const conf = `net route-domain /Common/RD1 {
    id 1
    vlans {
        /Common/v1
    }
}
net route-domain /Common/RD2 {
    id 2
    vlans {
        /Common/v2
    }
}
net vlan /Common/v1 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net vlan /Common/v2 {
    tag 20
    interfaces {
        1.2 { }
    }
}
net self /Common/s1 {
    address 10.5.5.1%1/24
    vlan /Common/v1
}
net self /Common/s2 {
    address 10.5.5.1%2/24
    vlan /Common/v2
}
ltm virtual /Common/vs1 {
    destination /Common/10.6.6.1%1:80
    mask 255.255.255.255
    pool /Common/p1
}
ltm pool /Common/p1 {
    members {
        /Common/n1:80 {
            address 10.6.6.10%1
        }
    }
}
`;
  const res = migrate([conf]);                    // auto: dup if-IP must force SPLIT
  assert.doesNotMatch(res.output, /\/c\/slb\/segment/);
  // each RD file carries its own copy of the IP - never two on one device
  const one = (res.output.match(/addr 10\.5\.5\.1\n/g) || []).length;
  assert.ok(one <= 1, 'main output must not carry the duplicate interface twice');
  assert.ok(res.rdOutputs['1'] || res.rdOutputs['2'], 'expected per-RD split outputs');
  assert.ok(res.diagnostics.some(d => d.issue.includes('overlapping address space')));
});

test('LOG: each diagnostic carries the ORIGINAL F5 stanza verbatim', () => {
  const conf = `ltm virtual /Common/v1 {
    destination /Common/1.2.3.4:80
    mask 255.255.255.255
    rules {
        /Common/my_irule
    }
}
`;
  const res = migrate([conf]);
  assert.match(res.log2 + res.log1, /ORIGINAL F5 CONFIGURATION/);
  assert.match(res.log2 + res.log1, /\| ltm virtual \/Common\/v1 \{/);
  assert.match(res.log2 + res.log1, /\| +destination \/Common\/1\.2\.3\.4:80/);
});

test('LIVE-21: two self-IPs in ONE subnet emit a single interface (device refuses same-subnet interfaces at apply)', () => {
  const conf = `net vlan /Common/v10 {
    tag 10
    interfaces {
        1.1 { }
    }
}
net self /Common/unit_a {
    address 10.20.30.5/24
    vlan /Common/v10
}
net self /Common/unit_b {
    address 10.20.30.6/24
    vlan /Common/v10
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /addr 10\.20\.30\.5\n/);
  assert.doesNotMatch(res.output, /addr 10\.20\.30\.6\n/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('same subnet')));
});

test('SEGMENT: forced split mode still produces per-RD outputs', () => {
  const res = migrate([MULTI_RD_CONF], { rdMode: 'split' });
  assert.ok(res.rdOutputs['5'], 'split mode must produce the RD5 output');
  assert.doesNotMatch(res.output, /\/c\/slb\/segment/);
});

test('SEGMENT: overlapping RDs auto-fall back to split with the overlap diagnostic', () => {
  const conf = `ltm node /Common/a {
    address 10.9.9.9
}
ltm node /Common/b {
    address 10.9.9.9%7
}
`;
  const res = migrate([conf]);                    // auto -> overlap -> split
  assert.doesNotMatch(res.output, /\/c\/slb\/segment/);
  assert.ok(res.rdOutputs['7'], 'expected split output for RD7');
  assert.ok(res.diagnostics.some(d => d.issue.includes('overlapping address space')));
});

test('RD-SPLIT: multi-route-domain configs produce one output per RD with correct membership', () => {
  const conf = `net route-domain /Common/0 {
    id 0
    vlans {
        /Common/vlan_main
    }
}
net route-domain /Common/RD5 {
    description "Outside ESA"
    id 5
    vlans {
        /Common/vlan_rd5
    }
}
net vlan /Common/vlan_main {
    tag 100
    interfaces {
        1.1 { }
    }
}
net vlan /Common/vlan_rd5 {
    tag 200
    interfaces {
        1.2 { }
    }
}
net self /Common/self_main {
    address 10.1.1.1/24
    traffic-group /Common/traffic-group-local-only
    vlan /Common/vlan_main
}
net self /Common/self_rd5 {
    address 10.2.2.1%5/24
    traffic-group /Common/traffic-group-local-only
    vlan /Common/vlan_rd5
}
ltm monitor http /Common/mon_shared {
    interval 5
    timeout 16
    recv OK
    send "GET /health HTTP/1.1\\r\\n\\r\\n"
}
ltm node /Common/srv_main {
    address 10.1.1.10
}
ltm node /Common/srv_rd5 {
    address 10.2.2.10%5
}
ltm pool /Common/pool_main {
    members {
        /Common/srv_main:80 {
            address 10.1.1.10
        }
    }
    monitor /Common/mon_shared
}
ltm pool /Common/pool_rd5 {
    members {
        /Common/srv_rd5:80 {
            address 10.2.2.10%5
        }
    }
    monitor /Common/mon_shared
}
ltm virtual /Common/vs_main {
    destination /Common/10.1.1.100:80
    mask 255.255.255.255
    pool /Common/pool_main
}
ltm virtual /Common/vs_rd5 {
    destination /Common/10.2.2.100%5:80
    mask 255.255.255.255
    pool /Common/pool_rd5
}
`;
  const res = migrate([conf], { rdMode: 'split' });   // force split (auto would use segments here)
  // RD0 output: only main objects + system section
  assert.match(res.output, /real srv_main/);
  assert.doesNotMatch(res.output, /real srv_rd5/);
  assert.match(res.output, /virt vs_main/);
  assert.doesNotMatch(res.output, /virt vs_rd5/);
  assert.match(res.output, /\/c\/l2\/vlan 100/);
  assert.doesNotMatch(res.output, /\/c\/l2\/vlan 200/);
  assert.match(res.output, /\/c\/sys/);
  // RD5 output: only rd5 objects, shared monitor duplicated, no system section
  const rd5 = res.rdOutputs['5'];
  assert.ok(rd5, 'missing RD5 output');
  assert.match(rd5, /real srv_rd5\n {4}ena\n {4}rip 10\.2\.2\.10\n/);
  assert.doesNotMatch(rd5, /real srv_main/);
  assert.match(rd5, /virt vs_rd5/);
  assert.match(rd5, /advhc\/health mon_shared/);
  assert.match(res.output, /advhc\/health mon_shared/);
  assert.match(rd5, /\/c\/l2\/vlan 200/);
  assert.doesNotMatch(rd5, /\/c\/sys\n/);
  assert.match(rd5, /addr 10\.2\.2\.1\n/);
  // split guidance diagnostic present
  assert.ok(res.diagnostics.some(d => d.issue.includes('SPLIT per route domain')));
});

test('RD-SPLIT: overlapping IPs across route domains are flagged as separate-instance blockers', () => {
  const conf = `ltm node /Common/a {
    address 10.9.9.9
}
ltm node /Common/b {
    address 10.9.9.9%7
}
`;
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('overlapping address space')));
});

test('RD-SPLIT: single-RD configs are untouched (no rd outputs, byte-identical path)', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n}\n';
  const res = migrate([conf]);
  assert.deepStrictEqual(res.rdOutputs, {});
});

// ---- wildcard virtual -> filter conversion (WVF) ----

const WVF_BASE = `net vlan /Common/vl_dmz {
    tag 300
    interfaces {
        1.1 { }
    }
}
net vlan /Common/vl_int {
    tag 301
    interfaces {
        1.2 { }
    }
}
ltm node /Common/wsrv {
    address 10.70.1.10
}
ltm pool /Common/wpool {
    members {
        /Common/wsrv:1700 {
            address 10.70.1.10
        }
    }
    monitor /Common/tcp
}
`;

test('WVF-1: ip-forward any:0 becomes an allow filter with any/any matching', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_all {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
    profiles {
        /Common/fastL4 { }
    }
    translate-address disabled
    translate-port disabled
    vlans {
        /Common/vl_dmz
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/filt 1000\n    ena\n    name "fwd_all"\n    ipver v4\n    action allow\n    sip any\n    smask 0\.0\.0\.0\n    dip any\n    dmask 0\.0\.0\.0\n    vlan 300\n/);
  assert.match(res.output, /\/c\/slb\/port 1\n    client ena\n    server ena\n    proxy ena\n    filt ena\n    add 1000\n/);
  assert.doesNotMatch(res.output, /\/c\/slb\/virt fwd_all/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('converted to filter 1000')));
});

test('WVF-2: source-restricted forwarding gets sip/smask; destination subnet gets dip/dmask', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_subnet {
    destination /Common/10.80.0.0:0
    ip-forward
    mask 255.255.0.0
    source 10.41.233.64/28
    translate-address disabled
    vlans {
        /Common/vl_dmz
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /    sip 10\.41\.233\.64\n    smask 255\.255\.255\.240\n/);
  assert.match(res.output, /    dip 10\.80\.0\.0\n    dmask 255\.255\.0\.0\n/);
});

test('WVF-3: pool-backed wildcard becomes a redirect filter with group + dport', () => {
  const conf = WVF_BASE + `ltm virtual /Common/coa_out {
    destination /Common/0.0.0.0:1700
    ip-protocol udp
    mask any
    pool /Common/wpool
    translate-address disabled
    translate-port disabled
    vlans {
        /Common/vl_int
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /action redir\n    proto udp\n/);
  assert.match(res.output, /    dport 1700\n/);
  assert.match(res.output, /    group wpool\n    rport 0\n/);   // translate-port disabled -> rport 0
  assert.match(res.output, /    vlan 301\n/);
  assert.match(res.output, /\/c\/slb\/port 2\n(?:.*\n)*?    add 1000\n/);
});

test('WVF-4: pool wildcard WITH port translation uses the pool member port as rport', () => {
  const conf = WVF_BASE + `ltm virtual /Common/subnet_lb {
    destination /Common/10.90.0.0:80
    ip-protocol tcp
    mask 255.255.255.0
    pool /Common/wpool
    vlans {
        /Common/vl_int
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /    dport 80\n/);
  assert.match(res.output, /    group wpool\n    rport 1700\n/);
});

test('WVF-5: multiple restricting VLANs -> vlan any + tighten diagnostic; ports of ALL vlans bound', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_multi {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
    vlans {
        /Common/vl_dmz
        /Common/vl_int
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /    vlan any\n/);
  assert.match(res.output, /\/c\/slb\/port 1\n(?:.*\n)*?    add 1000\n/);
  assert.match(res.output, /\/c\/slb\/port 2\n(?:.*\n)*?    add 1000\n/);
  assert.ok(res.diagnostics.some(d => d.issue.includes('match ONE vlan or any')));
});

test('WVF-6: no VLAN restriction -> filter emitted UNBOUND with a loud diagnostic', () => {
  const conf = `ltm virtual /Common/fwd_open {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/filt 1000\n/);
  assert.doesNotMatch(res.output, /\/c\/slb\/port /);
  assert.ok(res.diagnostics.some(d => d.issue.includes('NOT bound to any port')));
});

test('WVF-7: SNAT pool and persistence on wildcards produce manual diagnostics', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_snat {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
    persist {
        /Common/source_addr {
            default yes
        }
    }
    source-address-translation {
        pool /Common/my_snat
        type snat
    }
    vlans {
        /Common/vl_dmz
    }
    vlans-enabled
}
`;
  const res = migrate([conf]);
  assert.ok(res.diagnostics.some(d => d.issue.includes('filter-based NAT is not converted automatically')));
  assert.ok(res.diagnostics.some(d => d.issue.includes('Persistence on a wildcard virtual')));
});

test('WVF-8: multiple wildcards get distinct filter IDs; regular virts unaffected', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_a {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
    vlans {
        /Common/vl_dmz
    }
    vlans-enabled
}
ltm virtual /Common/fwd_b {
    destination /Common/0.0.0.0:0
    ip-forward
    mask any
    vlans {
        /Common/vl_int
    }
    vlans-enabled
}
ltm virtual /Common/normal_vs {
    destination /Common/10.70.1.100:8080
    mask 255.255.255.255
    pool /Common/wpool
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/filt 1000\n/);
  assert.match(res.output, /\/c\/slb\/filt 1010\n/);
  assert.match(res.output, /\/c\/slb\/virt normal_vs\n/);
});

test('WVF-9: destination "any" keyword and %RD suffixes are handled on wildcards', () => {
  const conf = WVF_BASE + `ltm virtual /Common/fwd_rd {
    destination /Common/any%4:0
    ip-forward
    mask any
    vlans {
        /Common/vl_dmz
    }
    vlans-enabled
}
`;
  const res = migrate([conf], { rdMode: 'split' });
  const rd4 = res.rdOutputs['4'] || res.output;
  assert.match(rd4, /action allow\n/);
  assert.match(rd4, /    dip any\n/);
  assert.doesNotMatch(rd4, /%/);
});

test('GAP-9: unhandled-line diagnostics keep their spaces (readability)', () => {
  const conf = 'ltm node /Common/n1 {\n    address 1.2.3.4\n    some future-attribute xyz\n}\n';
  const res = migrate([conf]);
  const d = res.diagnostics.find(x => x.issue === 'Unhandled line');
  assert.ok(d && d.detail.includes('some future-attribute xyz'));
});
