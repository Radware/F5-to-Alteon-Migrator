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
    this.sourceBlocks = new Map(); // object name -> original tmsh stanza (verbatim)
    this.renamedFrom = new Map();  // shortened name -> original F5 name (32-char renames)
  }
  // Index every top-level tmsh stanza so diagnostics can quote the ORIGINAL F5
  // config next to the explanation (customer request: log1 must be actionable
  // without opening the source config).
  indexSource(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // one-line empty stanza: "ltm rule /Common/x { }"
      const one = lines[i].match(/^([a-z][^{]*?)\s*\{\s*\}\s*$/);
      // opening line of a multi-line stanza: "ltm virtual /Common/x {"
      const m = one || lines[i].match(/^([a-z][^\s{][^{]*?)\s*\{\s*$/);
      if (!m) continue;
      const header = m[1].trim();
      // A top-level tmsh stanza always closes with "}" in column 0. Counting
      // braces instead breaks on iRule bodies (their nested braces are inside
      // TCL code), which silently swallowed every later object in the file.
      let j = i + 1;
      if (!one) {
        while (j < lines.length && !/^\}\s*$/.test(lines[j])) j++;
        j = Math.min(j + 1, lines.length);
      }
      const block = lines.slice(i, j).join('\n');
      const parts = header.split(/\s+/);
      const path = parts[parts.length - 1];                  // /Common/name
      const short = path.split('/').pop();                   // name
      for (const key of [header, path, short]) {
        if (key && !this.sourceBlocks.has(key)) this.sourceBlocks.set(key, block);
      }
      i = j - 1;
    }
  }
  sourceFor(name) {
    if (!name) return '';
    const key = String(name);
    const orig = this.renamedFrom.get(key);   // 32-char renames point back
    return this.sourceBlocks.get(key) ||
      this.sourceBlocks.get(key.split('/').pop()) ||
      (orig ? (this.sourceBlocks.get(orig) || this.sourceBlocks.get(orig.split('/').pop())) : '') || '';
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
  logText(sev, opts) {
    const withSource = !opts || opts.withSource !== false;
    return this.diagnostics.filter(d => d.sev === sev).map(d => {
      let out = '\n###\n Object type: ' + d.type + ' \n Object name: ' + d.name +
        ' \n Issue: ' + d.issue + (d.detail ? '\n' + d.detail : '') + '\n';
      if (withSource) {
        const src = this.sourceFor(d.name);
        if (src) {
          out += '\n --- ORIGINAL F5 CONFIGURATION ---\n' +
            src.split('\n').map(l => ' | ' + l).join('\n') + '\n --- END ---\n';
        }
      }
      return out;
    }).join('');
  }
}

module.exports = { Context, SEV };
