'use strict';
// Field report (telco C, APAC PS): a virtual whose destination NAMES a
// virtual-address object was dropped, and SSL virtuals came out with no
// server certificate. Synthetic config in the shape of the report.
const { test } = require('node:test');
const assert = require('node:assert');
const { migrate } = require('../lib/index');

const BASE = `ltm node /Common/192.0.2.21 {
    address 192.0.2.21
}
ltm pool /Common/p_app {
    members {
        /Common/192.0.2.21:8443 {
            address 192.0.2.21
        }
    }
}
ltm profile client-ssl /Common/cssl_app {
    app-service none
    cert-key-chain {
        app_cert_0 {
            cert /Common/app.example.test.crt
            chain /Common/example-ca-bundle.crt
            key /Common/app.example.test.key
        }
    }
    defaults-from /Common/clientssl
    inherit-certkeychain false
}
ltm profile client-ssl /Common/cssl_child {
    defaults-from /Common/cssl_app
    inherit-certkeychain true
}
`;

const virt = (name, dest, prof) => `ltm virtual /Common/${name} {
    destination ${dest}
    ip-protocol tcp
    mask 255.255.255.255
    pool /Common/p_app
    profiles {
        /Common/${prof} {
            context clientside
        }
        /Common/http { }
        /Common/tcp { }
    }
}
`;

test('VADDR-1: a destination naming a virtual-address object resolves to its address', () => {
  const conf = BASE + virt('vs_named', '/Common/app-vip-61:443', 'cssl_app') + `ltm virtual-address /Common/app-vip-61 {
    address 192.0.2.61
    mask 255.255.255.255
    traffic-group /Common/traffic-group-1
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt vs_named\n    ena\n    ipver v4\n    vip 192\.0\.2\.61\n/);
  assert.doesNotMatch(res.output, /vs_named\n[^/]*    dis\n/);
  assert.ok(!res.diagnostics.some(d => d.name === 'vs_named' && d.issue.includes('NOT converted')));
});

test('VADDR-1: a disabled virtual-address ("enabled no") converts the virtual DISABLED, with a note', () => {
  const conf = BASE + virt('vs_off', '/Common/app-vip-62:443', 'cssl_app') + `ltm virtual-address /Common/app-vip-62 {
    address 192.0.2.62
    arp disabled
    enabled no
    icmp-echo disabled
    mask 255.255.255.255
}
`;
  const res = migrate([conf]);
  assert.match(res.output, /\/c\/slb\/virt vs_off\n    ena\n    ipver v4\n    vip 192\.0\.2\.62\n    dis\n/);
  assert.ok(res.diagnostics.some(d => d.name === 'vs_off' && d.issue.includes('DISABLED') && d.issue.includes('/c/slb/virt vs_off/ena')));
});

test('VADDR-1: a named destination with no virtual-address object is still put aside, saying why', () => {
  const res = migrate([BASE + virt('vs_lost', '/Common/no-such-vaddr:443', 'cssl_app')]);
  assert.doesNotMatch(res.output, /\/c\/slb\/virt vs_lost\n/);
  assert.ok(res.diagnostics.some(d => d.name === 'vs_lost' && d.issue.includes('no "ltm virtual-address no-such-vaddr" object')));
});

test('SSLCERT-1: no srvrcert line is emitted (refused at apply without the cert), steps name the F5 cert, key and chain', () => {
  const res = migrate([BASE + virt('vs_ssl', '/Common/192.0.2.63:443', 'cssl_app')]);
  assert.doesNotMatch(res.output, /srvrcert/);
  assert.doesNotMatch(res.output, /\/c\/slb\/ssl\/certs/);
  const d = res.diagnostics.find(x => x.name === 'vs_ssl' && x.issue.includes('server certificate NOT bound'));
  assert.ok(d, 'certificate diagnostic');
  assert.ok(d.issue.includes('app.example.test.crt'));
  assert.ok(d.detail.includes('key "app.example.test.key"'));
  assert.ok(d.detail.includes('component ID app.example.test.crt'));
  assert.ok(d.detail.includes('/c/slb/ssl/sslpol f5ssl_fe_ch1/intermca cert example-ca-bundle.crt'));
  assert.ok(d.detail.includes('/c/slb/virt vs_ssl/service 443 https/ssl/srvrcert cert app.example.test.crt'));
});

test('SSLCERT-1: a profile that inherits its cert-key-chain uses the parent certificate; a built-in profile says default.crt', () => {
  const conf = BASE + virt('vs_child', '/Common/192.0.2.64:443', 'cssl_child') + virt('vs_builtin', '/Common/192.0.2.65:443', 'clientssl');
  const res = migrate([conf]);
  const child = res.diagnostics.find(x => x.name === 'vs_child' && x.issue.includes('server certificate NOT bound'));
  assert.ok(child && child.issue.includes('app.example.test.crt'));
  const bi = res.diagnostics.find(x => x.name === 'vs_builtin' && x.issue.includes('server certificate NOT bound'));
  assert.ok(bi && bi.issue.includes('default.crt'));
});
