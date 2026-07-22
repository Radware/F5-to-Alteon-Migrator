'use strict';
// Per-run state. The legacy Python tool kept ~40 module-level globals which
// leaked between runs (confirmed: routes from one file appeared in the next
// file's output). Everything lives on a Context created fresh per run.

const SEV = { MANUAL: 'log1', UNSUPPORTED: 'log2' };

class Context {
  constructor() {
    this.reals = new Map();      // name -> {attrs in insertion order}
    this.pools = new Map();
    this.monitors = new Map();
    this.profiles = new Map();
    this.persist = new Map();
    this.virts = new Map();
    this.vlans = new Map();      // name -> {tag, interfaces[]}
    this.ifs = new Map();        // self IPs -> {ifId, addr, mask, vlanTag}
    this.floats = new Map();     // floating IPs -> {addr, vlanTag}
    this.floatVlanToIf = new Map(); // vlan tag -> if id
    this.routes = [];            // "net mask gw"
    this.gws = new Map();        // id -> {addr}
    this.trunks = new Map();
    this.lacp = new Map();
    this.mgmt = { hprompt: 'ena', mmgmt: new Map(), ntp: new Map(), syslog: new Map(), ssnmp: new Map() };
    this.rportByPool = new Map();
    this.longNames = new Map();
    this.counters = new Map();
    this.rdVlans = new Map();    // vlan name -> route-domain id (net route-domain)
    this.rdInfo = new Map();     // route-domain id -> description
    this.diagnostics = [];       // {sev, type, name, issue, detail}
  }
  nextId(kind) {
    const v = (this.counters.get(kind) || 0) + 1;
    this.counters.set(kind, v);
    return v;
  }
  warnManual(type, name, issue, detail) {
    this.diagnostics.push({ sev: SEV.MANUAL, type, name, issue, detail: detail || '' });
  }
  warnUnsupported(type, name, issue, detail) {
    this.diagnostics.push({ sev: SEV.UNSUPPORTED, type, name, issue, detail: detail || '' });
  }
  logText(sev) {
    return this.diagnostics.filter(d => d.sev === sev).map(d =>
      '\n###\n Object type: ' + d.type + ' \n Object name: ' + d.name +
      ' \n Issue: ' + d.issue + (d.detail ? '\n' + d.detail : '') + '\n'
    ).join('');
  }
}

module.exports = { Context, SEV };
