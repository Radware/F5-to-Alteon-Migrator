'use strict';
// Renders the parsed model into Alteon CLI text.
// Formatting is byte-compatible with the legacy tool (including its quirks:
// no leading newline before virts, vlan lines built without trailing newline,
// "ena  " with trailing spaces under /c/l3/gw) so outputs remain diffable
// against the frozen legacy golden files.
const T = require('./tables');

// Alteon network-class IDs follow the same 32-char / ASCII rules as other IDs.
function nwclssId(name) {
  const clean = String(name).replace(/[^\w.-]/g, '_');
  return clean.length > 32 ? clean.slice(0, 32) : clean;
}

function render(ctx) {
  let out = '';
  // SNAT Automap support (AUTOMAP-1, all verified live on 34.5.7 with traffic):
  // each automap service got "pip mode egress"; egress mode draws its NAT
  // address from the per-VLAN Proxy IP table. F5 automap NATs from the
  // FLOATING self-IP - and the device accepts exactly that float as a PIP
  // (while it REFUSES the interface IP: "The IP Address of Interface N
  // conflicts with the Client NAT"). So when the config has floats, the PIP
  // table is filled from them - same NAT source the servers and firewalls
  // already know from the F5. Without floats a free IP is required and only
  // the engineer can pick one.
  const automapVirts = [...ctx.virts.values()].filter((v) => v.automap);
  if (automapVirts.length) {
    const floatByVlan = new Map();
    for (const [, f] of ctx.floats) {
      if (f.addr && f.vlanTag && !floatByVlan.has(f.vlanTag)) floatByVlan.set(f.vlanTag, f.addr);
    }
    if (floatByVlan.size) {
      out += '/c/slb/pip\n    type vlan\n';
      for (const [vlan, addr] of floatByVlan) out += '/c/slb/pip/add ' + addr + ' ' + vlan + '\n';
      ctx.warnManual('Virt', 'SNAT Automap', 'SNAT Automap: ' + automapVirts.length + ' service(s) converted to "pip mode egress", and the Proxy IP table was FILLED AUTOMATICALLY from the F5 floating self-IPs (' +
        [...floatByVlan].map(([v, a]) => a + ' on VLAN ' + v).join(', ') + ') - the same NAT source addresses F5 automap used, so downstream firewall rules keep matching. ' +
        'Verified live on a standalone device (float-as-PIP applies and NATs correctly). For an Alteon HA pair, review: the float also serves HA - consider peerpip / a dedicated PIP per unit. ' +
        'NOTE for 34.0.x targets (found live on 34.0.12): the device validates "pip/add <ip> <vlan>" against the CURRENT pip base type, not the pending one - paste "/c/slb/pip/type vlan", APPLY, and only then paste the pip add lines (34.4+ accepts the whole block in one paste).');
    } else {
      // No float to reuse -> the config cannot be made complete automatically.
      // "pip mode egress" with an empty PIP table APPLIES CLEANLY but silently
      // does not NAT (verified live: one-armed traffic times out) - the worst
      // failure mode. Per the project rule, an incomplete construct is PUT
      // ASIDE, not half-emitted: strip the pip block and leave the whole step
      // in the log.
      for (const v of automapVirts) v.pip = null;
      ctx.warnManual('Virt', 'SNAT Automap', 'SNAT Automap: ' + automapVirts.length + ' service(s) used it, but the config has NO floating self-IP that Alteon can reuse as the Proxy IP ' +
        '(the interface IP is refused by the device: "conflicts with the Client NAT"). NOTHING was emitted for it - emitting "pip mode egress" without a Proxy IP would apply cleanly yet silently NOT translate (verified live). ' +
        'To restore automap behavior once you have ONE free IP per server-side VLAN: "/c/slb/pip/type vlan", "/c/slb/pip/add <free-IP> <vlan-id>", then per service "/c/slb/virt <virt>/service <port> <app>/pip/mode egress". ' +
        'Alternative if servers must see real client IPs: Return-to-Last-Hop ("rtsrcmac ena") - different behavior (no NAT).');
    }
  }
  // Network classes first: a filter's "sip <class>" needs the class to exist
  // (same forward-reference rule that segments have). Which classes are needed
  // is known up front from the source-match virtuals.
  const needed = new Set();
  for (const [, v] of ctx.virts || []) {
    const t = v.tmc && ctx.tmc ? ctx.tmc.get(v.tmc) : null;
    if (t && t.srcList && ctx.addrLists && ctx.addrLists.has(t.srcList)) needed.add(t.srcList);
  }
  for (const listName of needed) {
    const list = ctx.addrLists.get(listName);
    const id = nwclssId(listName);
    if (id !== listName) {
      ctx.warnManual('Network class', listName, 'Address-list name exceeds the 32-char Alteon ID limit or has invalid characters; network class created as "' + id + '".');
    }
    out += '/c/slb/nwclss ' + id + '\n    ipver v4\n    type address\n';
    if (list.description) out += '    name "' + list.description.slice(0, 32) + '"\n';
    let n = 0;
    for (const el of list.elements) {
      n += 1;
      out += '/c/slb/nwclss ' + id + '/network ' + n + '\n    net subnet ' + el.ip + ' ' + el.mask + ' include\n';
    }
  }
  // SNATPOOL-1 (apply-level sweep): "pip mode nwclss" + "nwclss v4 <id>"
  // refuses the whole apply unless the class exists ("IPv4 Network Class ID
  // 'X' must be defined (PIP mode is set to 'network class')"). Build the
  // class from the F5 snatpool members (one /32 entry each); a pool that is
  // missing or has members that are not plain IPv4 in the virtual's own route
  // domain is put aside - the service is emitted without NAT and flagged.
  const snatEmitted = new Set();
  for (const [name, v] of ctx.virts || []) {
    if (!v.snatPool || !v.pip || v.wildcard) continue;
    const sp = v.snatPool;
    const members = ctx.snatPools ? ctx.snatPools.get(sp.name) : null;
    const vrd = v.rd || '0';
    const addrs = (members || []).map((m) => {
      const [ip, rd] = m.split('%');
      return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && (rd === undefined || rd === vrd) ? ip : null;
    });
    if (!members || !members.length || addrs.includes(null)) {
      v.pip = null;
      ctx.warnManual('Virt', name, 'SNAT pool "' + sp.name + '" ' + (!members ? 'was not found in the input' : !members.length ? 'has no members' :
        'has members that are not plain IPv4 addresses of this route domain (' + members.join(', ') + ')') +
        '; the service was emitted WITHOUT source NAT (put aside) - a pip pointing at an undefined network class refuses the whole apply. ' +
        'Create "/c/slb/nwclss ' + sp.id + '" (ipver v4, type address, one "network N/net subnet <ip> 255.255.255.255 include" per SNAT address), then set "/c/slb/virt ' + name + '/service <port> <app>/pip/mode nwclss" and "nwclss v4 ' + sp.id + ' persist disable"!');
      continue;
    }
    if (snatEmitted.has(sp.id)) continue;
    snatEmitted.add(sp.id);
    out += '/c/slb/nwclss ' + sp.id + '\n    ipver v4\n    type address\n';
    addrs.forEach((ip, i) => {
      out += '/c/slb/nwclss ' + sp.id + '/network ' + (i + 1) + '\n    net subnet ' + ip + ' 255.255.255.255 include\n';
    });
  }
  // network segments FIRST (live finding: a virt's "segment" classifier warns
  // "Invalid Segment id" if the segment is not defined yet - the segmentation
  // guide also orders segment definitions before everything else)
  if (ctx.segments) {
    // SEGVLAN-1: "addvlan" only takes a VLAN that already exists - on a clean
    // 34.0.12 it answers 'Usage: addvlan <Add a configured VLAN, 1-4090>' and
    // the empty segment refuses the whole apply ("Segment 1 does not have any
    // vlans configured"). The full VLAN blocks come near the end, so declare
    // each segment VLAN (enabled, LIVE-20) here first.
    for (const s of ctx.segments) {
      for (const t of s.vlans) out += '/c/l2/vlan ' + t + '\n    ena\n';
    }
    for (const s of ctx.segments) {
      out += '/c/slb/segment ' + s.id + '\n';
      if (s.name) out += '    name "' + s.name.slice(0, 32) + '"\n';
      for (const t of s.vlans) out += '    addvlan ' + t + '\n';
    }
    for (const s of ctx.segments) {
      if (!s.gw) continue;
      out += '/c/slb/real seg' + s.id + '_gw\n    ena\n    ipver v4\n    rip ' + s.gw + '\n';
      out += '/c/slb/group seg' + s.id + '_gw_grp\n    ipver v4\n    health icmp\n    metric roundrobin\n    add seg' + s.id + '_gw\n';
      out += '/c/slb/filt ' + s.filtId + '\n    ena\n    action redir\n    ipver v4\n    segment ' + s.id +
        '\n    sip any\n    smask 0.0.0.0\n    dip any\n    dmask 0.0.0.0\n    group seg' + s.id + '_gw_grp\n    rport 0\n    vlan any\n';
      for (const p of s.ports) {
        out += '/c/slb/port ' + p + '\n    client ena\n    server ena\n    proxy ena\n    filt ena\n    add ' + s.filtId + '\n';
      }
    }
  }
  // LOGEXP-1 (found by the APPLY-level gate, invisible to line staging):
  // a health-check REFERENCE that names a check which never became an
  // Alteon advhc (e.g. F5 passive "inband" monitors have no equivalent)
  // makes the device refuse the ENTIRE apply: "Logical expression health
  // check 'X' - Undefined health check 'Y' is used." Resolve every logexp
  // and every group/real health reference against the checks that will
  // actually exist; drop what cannot resolve, with a diagnostic each.
  // "radius" is NOT a built-in: 'health check "radius" is not defined' at
  // apply (probed on 34.0.12, REAL-HC-1 probe).
  const BUILTIN_HC = new Set(['icmp', 'tcp', 'udp', 'http', 'https', 'dns', 'ftp', 'pop3', 'smtp', 'imap', 'nntp', 'ldap', 'sslh', 'link', 'arp']);
  const REAL_REFUSED_HC = new Set(['http', 'https', 'dns', 'ftp', 'pop3', 'smtp', 'imap', 'nntp', 'ldap']);
  const hcDefined = (k) => BUILTIN_HC.has(String(k)) ||
    (ctx.monitors.has(k) && !!ctx.monitors.get(k).hcType) ||
    (ctx.monitors.has(String(k)) && !!ctx.monitors.get(String(k)).hcType) ||
    (ctx.monitors.has(+k) && !!ctx.monitors.get(+k).hcType);
  for (const [name, hc] of [...ctx.monitors]) {
    if (hc.hcType !== 'logexp') continue;
    const expr = hc.advtype.get('expr') || '';
    const parts = [...expr.matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
    const kept = parts.filter((p) => hcDefined(p));
    if (kept.length === parts.length) continue;
    const dropped = parts.filter((p) => !hcDefined(p));
    if (!kept.length) {
      ctx.monitors.delete(name);
      ctx.warnManual('Health Check', name, 'No component of this logical expression exists as an Alteon health check (' + dropped.join(', ') +
        ' - F5 passive/inband or otherwise unconvertible monitors); the expression was NOT emitted and anything referencing it keeps the Alteon default health check. Verify!');
    } else {
      // clone: the monitor object is shared across the per-RD sub-renders
      const clone = { hcType: hc.hcType, attrs: new Map(hc.attrs), advtype: new Map(hc.advtype) };
      clone.advtype.set('expr', kept.map((p) => '(' + p + ')').join(expr.includes('&') ? '&' : '|'));
      ctx.monitors.set(name, clone);
      ctx.warnManual('Health Check', name, 'Component check(s) ' + dropped.join(', ') + ' have no Alteon equivalent (F5 passive/inband or unconvertible monitor); ' +
        'the expression was reduced to: ' + kept.join(expr.includes('&') ? ' AND ' : ' OR ') + '. Verify the reduced health logic!');
    }
  }
  // ADDPORT-1 (found by the APPLY gate): the device refuses two real
  // servers with the same IP AND the same addport ("Duplicate listening
  // port(addport) used for real servers with the same IP address") - F5
  // happily keeps several node objects for one backend endpoint. Merge
  // same-endpoint reals into the first one and remap group references.
  {
    const endpointSeen = new Map();      // rip|addport -> kept real name
    const realRemap = new Map();
    for (const [name, r] of [...ctx.reals]) {
      const ap = r.attrs.get('addport');
      if (!ap) continue;
      const key = r.attrs.get('rip') + '|' + ap;
      if (endpointSeen.has(key)) {
        const kept = endpointSeen.get(key);
        realRemap.set(name, kept);
        ctx.reals.delete(name);
        ctx.warnManual('Real', name, 'Same backend endpoint (' + r.attrs.get('rip') + ' addport ' + ap + ') as real "' + kept +
          '" - the device refuses two reals with one IP and the same addport (verified at apply). Merged into "' + kept + '"; verify any per-real settings (health, state, name) that differed!');
      } else endpointSeen.set(key, name);
    }
    if (realRemap.size) {
      for (const [, p] of ctx.pools) {
        for (const mk of [...p.members.keys()]) {
          const [rn, port] = mk.split(':');
          if (!realRemap.has(rn)) continue;
          p.members.delete(mk);
          const nk = realRemap.get(rn) + (port ? ':' + port : '');
          if (!p.members.has(nk)) p.members.set(nk, true);
        }
      }
    }
  }
  // REALVIP-1 (apply-level sweep): "Real server X has the same IP address as
  // virtual server Y" refuses the whole apply. F5 keeps a node object on a
  // virtual address without complaint (often an unused leftover). Put the
  // real aside and drop it from its groups.
  {
    const vipOwner = new Map();
    for (const [vn, v] of ctx.virts) {
      if (!v.wildcard && v.vip && v.vip !== '0.0.0.0' && !vipOwner.has(v.vip)) vipOwner.set(v.vip, vn);
    }
    for (const [name, r] of [...ctx.reals]) {
      const rip = r.attrs.get('rip');
      if (!vipOwner.has(rip)) continue;
      const inGroups = [];
      for (const [pn, p] of ctx.pools) {
        for (const mk of [...p.members.keys()]) {
          if (mk.split(':')[0] === name) { p.members.delete(mk); if (!inGroups.includes(pn)) inGroups.push(pn); }
        }
      }
      ctx.reals.delete(name);
      ctx.warnManual('Real', name, 'Real server IP ' + rip + ' is also the address of virtual "' + vipOwner.get(rip) +
        '"; Alteon refuses that at apply ("Real server X has the same IP address as virtual server Y"). Real NOT converted (put aside)' +
        (inGroups.length ? ' and removed from group(s) ' + inGroups.join(', ') + ' - review how that pool reached the backend!' : ' - it was not a member of any pool.'));
    }
  }
  // reals
  for (const [name, real] of ctx.reals) {
    out += '\n/c/slb/real ' + name + '\n    ' + (real.disabled ? 'dis' : 'ena') + '\n';
    for (const [k, v] of real.attrs) {
      if (k === 'health' && !hcDefined(v)) {
        ctx.warnManual('Real', name, 'Member-level monitor "' + v + '" has no Alteon health check (unconvertible monitor type); the real keeps the group/default health check - verify!');
        continue;
      }
      // REAL-HC-1 (apply-level sweep, probed on 34.0.12): a BUILT-IN check
      // with "inherit" parameters refuses the whole apply when set on a REAL
      // ("Health checks configured on a real server cannot have parameters
      // with "inherit" values"). tcp/icmp/udp/sslh/link/arp and custom advhc
      // objects (even without dport) apply.
      if (k === 'health' && REAL_REFUSED_HC.has(String(v))) {
        ctx.warnManual('Real', name, 'Member-level monitor maps to the built-in "' + v + '" check, which Alteon refuses on a real server at apply. NOT set on the real (put aside) - it keeps the group health check. To check this member on its own, create an advhc ("/c/slb/advhc/health <id> ' + String(v).toUpperCase() + '") and set "/c/slb/real ' + name + '/health <id>".');
        continue;
      }
      out += '    ' + k + ' ' + v + '\n';
    }
  }
  // groups
  for (const [name, pool] of ctx.pools) {
    out += '\n/c/slb/group ' + name + '\n    ipver v4\n';
    // an empty "health " makes the CLI prompt interactively and swallow the
    // next pasted line (live finding); omit it and keep the Alteon default
    const advhc = pool.attrs.get('advhc');
    if (advhc && hcDefined(advhc)) out += '    health ' + advhc + '\n';
    else if (advhc) ctx.warnManual('Group', name, 'Pool monitor "' + advhc + '" has no Alteon health check (unconvertible monitor type or dropped expression); group keeps the Alteon default health check (tcp). Verify!');
    else ctx.warnManual('Group', name, 'Pool has no monitor; group keeps the Alteon default health check (tcp). Verify!');
    out += '    metric ' + pool.attrs.get('metric') + '\n';
    if (pool.attrs.has('backup')) out += '    backup ' + pool.attrs.get('backup') + '\n';
    if (pool.attrs.has('name')) out += '    name ' + pool.attrs.get('name') + '\n';
    for (const member of pool.members.keys()) out += '    add ' + member.split(':')[0] + '\n';
  }
  // monitors
  for (const [name, hc] of ctx.monitors) {
    if (!hc.hcType) continue;
    out += '\n/c/slb/advhc/health ' + name + ' ' + hc.hcType.toUpperCase() + '\n';
    for (const [k, v] of hc.attrs) out += '    ' + k + ' ' + v + '\n';
    if (hc.advtype.size === 0) continue; // legacy: submenu only when advanced attrs exist
    if (hc.hcType.includes('http')) out += '    http\n';
    else if (hc.hcType === 'logexp') { out += '    logexp ' + hc.advtype.get('expr') + '\n'; continue; }
    else out += '    ' + hc.hcType + '\n';
    for (const [k, v] of hc.advtype) out += '        ' + k + ' ' + v + '\n';
  }
  // wildcard virtuals (non-/32 destination, any:0, ip-forward) -> Alteon
  // FILTERS. Unlike the legacy tool this emits complete, live-validated
  // syntax AND binds the filter to ports (an unbound filter matches nothing).
  let wfiltId = 990;
  const renderWildcardFilter = (name, v) => {
    // FILT-1 (found by the apply-level sweep): a wildcard restricted ONLY to
    // VLANs that cannot exist on Alteon (F5 internal 4092-4094) would become
    // "vlan any" - broader than the F5. Put it aside instead.
    if ((v.vlanList || []).length &&
        v.vlanList.every((vn) => { const vl = ctx.vlans.get(vn); return vl && vl.invalid; })) {
      ctx.warnManual('Filter', name, 'Wildcard virtual is restricted to VLAN(s) ' + v.vlanList.join(', ') +
        ' that cannot exist on Alteon (F5 internal VLANs 4092-4094). NOT converted (put aside) - converting it without the VLAN match would forward traffic on every VLAN!');
      return;
    }
    wfiltId += 10;
    if (wfiltId >= 1790) {                 // stay clear of the segment filter range (1800+) and the 2048 cap
      ctx.warnManual('Filter', name, 'Filter ID budget exhausted; convert this wildcard virtual manually!');
      return;
    }
    const fid = wfiltId;
    const isRedir = !!v.service.get('group');
    // NAMELEN-1: filter name is max 31 characters (34.0.12: 'Usage: name <"31 character name">')
    out += '/c/slb/filt ' + fid + '\n    ena\n    name "' + name.slice(0, 31) + '"\n    ipver v4\n';
    out += '    action ' + (isRedir ? 'redir' : 'allow') + '\n';
    if (v.proto && v.proto !== 'any') out += '    proto ' + v.proto + '\n';
    // Source matching. A traffic-matching-criteria virtual matches a whole F5
    // address-list, which becomes an Alteon network class referenced directly
    // by sip (no smask then - verified live: "sip <class>" applies and the
    // device reports the class as associated to the filter).
    const tmc = v.tmc ? ctx.tmc.get(v.tmc) : null;
    const srcClass = tmc && tmc.srcList && ctx.addrLists.has(tmc.srcList) ? tmc.srcList : null;
    if (srcClass) {
      out += '    sip ' + nwclssId(srcClass) + '\n';
      ctx.usedNwclss.add(srcClass);
    } else if (v.source) {                 // "10.1.2.0/28" (RD suffix already possible)
      let [sip, spfx] = v.source.split('/');
      if (sip.includes('%')) sip = sip.split('%')[0];
      const smask = T.prefixToMask(spfx);
      if (sip !== '0.0.0.0' && smask) out += '    sip ' + sip + '\n    smask ' + smask + '\n';
      else out += '    sip any\n    smask 0.0.0.0\n';
    } else out += '    sip any\n    smask 0.0.0.0\n';
    if (tmc && tmc.srcList && !srcClass) {
      ctx.warnManual('Filter', name, 'Source-match virtual references address-list "' + tmc.srcList +
        '" which was not found in the input; filter emitted with "sip any" - add the network class and set sip manually!');
    }
    if (tmc && tmc.dstList) {
      ctx.warnManual('Filter', name, 'Source-match virtual also restricts the DESTINATION by address-list "' +
        tmc.dstList + '"; only the source list was converted - set "dip <network class>" manually.');
    }
    if (tmc && (tmc.srcPortList || tmc.dstPortList)) {
      ctx.warnManual('Filter', name, 'Source-match virtual uses a port-list; Alteon filters take a single port or range - configure sport/dport manually.');
    }
    if (v.vip && v.vip !== '0.0.0.0') {
      out += '    dip ' + v.vip + '\n    dmask ' + (v.mask || '255.255.255.255') + '\n';
    } else out += '    dip any\n    dmask 0.0.0.0\n';
    if (v.rawDport && v.rawDport !== '0') out += '    dport ' + v.rawDport + '\n';
    if (isRedir) {
      out += '    group ' + v.service.get('group') + '\n';
      out += '    rport ' + (v.translatePort === false ? '0' : (v.service.get('rport') || '0')) + '\n';
    }
    // vlan restriction: one vlan -> exact match; several -> any + verify note.
    // FILT-1: VLANs the converter dropped (F5 internal 4092-4094, LIVE-3) are
    // not valid filter VLANs ("bad vlan id 4093").
    const tags = (v.vlanList || []).map((vn) => ctx.vlans.get(vn) || {}).filter((vl) => vl.tag && !vl.invalid).map((vl) => vl.tag);
    if (tags.length === 1) out += '    vlan ' + tags[0] + '\n';
    else {
      out += '    vlan any\n';
      if (tags.length > 1) ctx.warnManual('Filter', name, 'Wildcard virtual was restricted to ' + tags.length +
        ' VLANs (' + tags.join(', ') + '); Alteon filters match ONE vlan or any - emitted "vlan any", tighten manually (e.g. one filter per VLAN)!');
    }
    // bind to the ports of the restricting VLANs; else the engineer must pick
    const ports = new Set();
    for (const vn of v.vlanList || []) {
      const vl = ctx.vlans.get(vn) || {};
      if (vl.invalid) continue;
      // FILT-1: "/c/slb/port 0" is not a port (seen on a vCMP-guest VLAN)
      for (const p of (vl.interfaces || [])) if (/^[1-9]\d*$/.test(String(p))) ports.add(p);
    }
    if (ports.size) {
      for (const p of ports) out += '/c/slb/port ' + p + '\n    client ena\n    server ena\n    proxy ena\n    filt ena\n    add ' + fid + '\n';
    } else {
      ctx.warnManual('Filter', name, 'Filter ' + fid + ' (from wildcard virtual ' + name +
        ') is NOT bound to any port - ' + ((v.vlanList || []).length ? 'its VLAN(s) ' + v.vlanList.join(', ') + ' have no known Alteon port' : 'no VLAN restriction was present to derive ports from') + '. Bind it to the ingress ports manually (/c/slb/port <p>/filt ena + add ' + fid + ') or it matches nothing!');
    }
    if (v.pip) ctx.warnManual('Filter', name, 'Wildcard virtual used SNAT (pool or automap); filter-based NAT is not converted automatically - configure the filter NAT/proxy IP manually!');
    if (v.persist) ctx.warnManual('Filter', name, 'Persistence on a wildcard virtual is not carried to the filter - review stickiness requirements manually!');
    if (ctx.segments && v.rd && v.rd !== '0') ctx.warnManual('Filter', name, 'Wildcard virtual belongs to route domain ' + v.rd +
      ' (a segment); the filter matches by VLAN instead of a segment binding (a segment supports only ONE associated filter - its gateway redirect). Verify interaction with the segment redirect filter!');
    ctx.warnManual('Virt', name, 'Wildcard virtual converted to filter ' + fid + ' (' + (isRedir ? 'redirect to group ' + v.service.get('group') : 'allow/forward') + '). Review the filter and its port bindings!');
  };
  // virts
  const HARD_RESERVED = { '21': 'ftp', '22': 'ssh', '25': 'smtp', '53': 'dns', '110': 'pop3', '111': 'sunrpc', '123': 'ntp',
    '143': 'imap', '389': 'ldap', '1812': 'radius-auth', '1813': 'radius-acc' };   // LIVE-18 + pop3/imap (live-confirmed 110) + sunrpc (live-confirmed 111 on 34.0.12)
  // VLANF-1 (field question): F5 "vlans-enabled" means the virtual listens
  // ONLY on the listed VLANs. Collected here per VIP, emitted as a filter
  // pair after the virt loop (see the emission block for the traffic proof).
  const vlanRestricted = new Map();      // vip -> {vlans:Set, names:[], lists:[]}
  // VIP-PAIR (found by the APPLY gate): two virtuals on the SAME vip:port
  // refuse to apply UNLESS the service type discriminates by protocol -
  // proven to coexist for dns and basic-slb with differing tcp/udp
  // protocols (both live-verified), proven REFUSED for ntp even with
  // "protocol udp" ("Virtual server X has the same IP address and vport as
  // virtual server Y and overlapping Source Networks"). Keep the first
  // virtual per (vip, port[, protocol]) and put the clashing ones aside.
  const sslPolDone = new Set();          // SSLPOL-1: policies emitted in THIS output file
  const PAIR_OK = new Set(['dns', 'basic-slb']);
  const UDP_STANDARD_PORTS = new Set(['123', '1812', '1813']);   // IANA-UDP: prefer the udp twin there
  const pairSkip = new Map();            // name -> kept twin's name
  {
    const seen = new Map();              // vip:port -> [[name, proto, effAplic]]
    const protoOf = (v) => (v.proto === 'udp' ? 'udp' : 'tcp');
    const skip = (loser, winner, why) => {
      pairSkip.set(loser, winner);
      ctx.warnManual('Virt', loser, 'Virtual shares vip:port with "' + winner + '"' + why +
        '; the device refuses the pair at apply ("same IP address and vport ... overlapping Source Networks"). NOT converted (put aside) - review whether both listeners are needed!');
    };
    for (const [name, v] of ctx.virts) {
      if (v.wildcard || !v.vip || v.vip === '0.0.0.0' || !v.dport) continue;
      const eff = HARD_RESERVED[v.dport] || v.aplic;
      const key = v.vip + ':' + v.dport;
      const list = seen.get(key) || [];
      const sameProto = list.find((e) => e[1] === protoOf(v));
      if (sameProto) { skip(name, sameProto[0], ' on the same protocol'); continue; }
      if (!PAIR_OK.has(eff) && list.length) {
        // protocol-blind service type: only one twin can exist. On a port
        // whose standard transport is UDP (ntp/radius) keep the UDP twin -
        // the TCP one could never serve the port's real traffic anyway.
        const why = ' and the Alteon "' + eff + '" service cannot tell tcp/udp apart (only dns and basic-slb can - verified live)';
        if (UDP_STANDARD_PORTS.has(v.dport) && protoOf(v) === 'udp') {
          skip(list[0][0], name, why);
          seen.set(key, [[name, 'udp', eff]]);
        } else skip(name, list[0][0], why);
        continue;
      }
      list.push([name, protoOf(v), eff]);
      seen.set(key, list);
    }
  }
  // DNS-1 (field report): every protocol-capable Alteon virt service defaults
  // to TCP - verified live on 34.5.7, where dns, basic-slb, ntp, radius-auth,
  // radius-acc and ip ALL answer "Current protocol: tcp" - so the tcp/udp
  // pair of F5 DNS virtuals collided at apply ("Virtual server X has the
  // same DNS TCP setting as virtual server Y") and every F5 UDP listener
  // came out TCP-only. F5 "ip-protocol udp" now emits an explicit
  // "protocol udp"; a UDP virtual whose port maps to a TCP-only application
  // (http, https, ftp, ...: no protocol command on those services) is put
  // aside instead of emitting a listener with the wrong protocol.
  const PROTO_CAPABLE = new Set(['ip', 'basic-slb', 'dns', 'ntp', 'radius-auth', 'radius-acc', 'sunrpc']);   // sunrpc: protocol cmd + tcp default verified live on 34.0.12
  // live finding (agg008, 1649 pools): the lab VA refuses group #1025
  if (ctx.pools.size > 1024) {
    ctx.warnManual('Group', 'capacity', 'Config defines ' + ctx.pools.size + ' groups; the Alteon VA used for validation caps at 1024 Real Server Groups - verify the target platform capacity or split the config!');
  }
  // FLOATSUB-1 (apply-level sweep): a floating IP must sit in the subnet of
  // its interface ("The floating IP N should belong to the same subnet as its
  // assigned interface", refused at apply). A VLAN can carry several self-IP
  // subnets, so the interface is chosen by VLAN AND subnet, never by VLAN
  // alone. Mirrors the interface loop below (first interface per subnet wins).
  const netOf = (ip, mask) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(mask || '')) return null;
    const n = (s) => s.split('.').reduce((a, o) => (a * 256) + (+o), 0);
    return (((n(ip) & n(mask)) >>> 0) + '/' + mask);
  };
  const ifEmitted = [];
  {
    const seenNet = new Set();
    for (const [, itf] of ctx.ifs) {
      const net = netOf(itf.addr, itf.mask);
      if (net && seenNet.has(net)) continue;
      if (net) seenNet.add(net);
      ifEmitted.push(itf);
    }
  }
  const floatIfOf = (f) => {
    const m = ifEmitted.find((i) => i.vlanTag === f.vlanTag && netOf(i.addr, i.mask) && netOf(f.addr, i.mask) === netOf(i.addr, i.mask));
    return m ? String(m.ifId) : null;
  };
  // floats that will be emitted (same condition as the floatip loop below)
  const floatAddrs = new Set([...ctx.floats.values()].filter((f) => floatIfOf(f)).map((f) => f.addr));
  for (const [name, v] of ctx.virts) {
    if (v.wildcard) {
      if (v.vip !== undefined) renderWildcardFilter(name, v);
      continue;                            // wildcards become filters, never virts
    }
    if (v.vip === '0.0.0.0') continue;
    if (pairSkip.has(name)) continue;      // VIP-PAIR: put aside (diagnostic above)
    if (floatAddrs.has(v.vip)) {
      // FLOATVIP-1 (apply-level sweep, GTM listener on the floating
      // self-IP): "Virtual server X has the same IP address as HA floating
      // ip id: N" refuses the whole apply.
      ctx.warnManual('Virt', name, 'VIP ' + v.vip + ' is also an F5 floating self-IP, emitted as an Alteon HA floating IP; Alteon refuses a virtual on that address at apply ("has the same IP address as HA floating ip"). NOT converted (put aside) - move the service to a free VIP, or drop the floating IP if this address only served the listener!');
      continue;
    }
    const ifHit = ifEmitted.find((i) => i.addr === v.vip);
    if (ifHit) {
      // IFVIP-1 (all-enabled gate, 34.0.12): "Virtual server X has the same
      // IP address as IP interface N" refuses the whole apply (F5 allows a
      // virtual on a self-IP; the check is skipped while the virtual is dis).
      ctx.warnManual('Virt', name, 'VIP ' + v.vip + ' is also an F5 self-IP, emitted as Alteon IP interface ' + ifHit.ifId + '; Alteon refuses a virtual on an interface address at apply ("has the same IP address as IP interface"). NOT converted (put aside) - move the service to a free VIP!');
      continue;
    }
    if (v.ssl && v.aplic === 'ip') {
      // SSLIP-1 (apply-level sweep): an SSL policy on a port-any (ip) service
      // refuses the whole apply ("Dbind ena/forceproxy is not supported for
      // service IP"). Emitting the listener WITHOUT SSL would hand clients
      // undecrypted traffic, a different behavior - put the virtual aside.
      ctx.warnManual('Virt', name, 'F5 terminates/re-encrypts SSL on this any-port virtual, but Alteon cannot attach an SSL policy to an "ip" (any-port) service (refused at apply: "Dbind ... is not supported for service IP"). NOT converted (put aside) - recreate it as a virtual with explicit service port(s) and the SSL policy!');
      continue;
    }
    if (v.aplic === 'ip' && v.service.get('group') && ctx.pools.has(v.service.get('group'))) {
      // IPHC-1 (all-enabled gate, 34.0.12): the group of an "ip" (any-port)
      // service needs a health check with a destination port, else the whole
      // apply is refused ("the health check of Group G associated to service
      // IP, must be defined with a destination port"). Proven: icmp, an advhc
      // with dport, and a LOGEXP of such parts apply; built-in https/tcp, the
      // default and an advhc without dport refuse.
      const gname = v.service.get('group');
      const adv = ctx.pools.get(gname).attrs.get('advhc');
      const eff = adv && hcDefined(adv) ? String(adv) : 'tcp';
      const hasPort = (k, depth) => {
        if (k === 'icmp') return true;
        const hc = ctx.monitors.get(k) || ctx.monitors.get(+k);
        if (!hc || !hc.hcType || depth > 4) return false;
        if (hc.hcType === 'logexp') {
          const parts = [...(hc.advtype.get('expr') || '').matchAll(/\(([^()]+)\)/g)].map((m) => m[1]);
          return parts.length > 0 && parts.every((p) => hasPort(p, depth + 1));
        }
        const dp = hc.attrs.get('dport');
        return !!dp && dp !== '0';
      };
      if (!hasPort(eff, 0)) {
        ctx.warnManual('Virt', name, 'Any-port virtual (Alteon service "ip") on group "' + gname + '", whose health check "' + eff + (adv && hcDefined(adv) ? '' : '" (Alteon default, the F5 pool has no pool-level monitor') + '" has no destination port. Alteon refuses this at apply ("the health check of Group ' + gname + ' associated to service IP, must be defined with a destination port"). NOT converted (put aside). To convert it: give the group a check with a port, e.g. /c/slb/advhc/health <id> HTTP, dport <member port>, then /c/slb/group ' + gname + '/health <id> (or health icmp), and create the virtual with /c/slb/virt ' + name + '/service ' + v.dport + ' ip, group ' + gname + ', rport ' + (v.service.get('rport') || '0') + ', then apply.');
        continue;
      }
    }
    if (!v.vip || !v.dport) {
      // live finding: a virtual with no destination (GTM-managed listener)
      // rendered "service undefined" - refuse instead
      ctx.warnManual('Virt', name, 'Virtual has no destination in bigip.conf (GTM-managed listener?); NOT converted - address manually!');
      continue;
    }
    // live findings: Alteon reserves well-known service ports for matching
    // applications ('port 80 reserved for http', 'port 53 reserved for dns', …)
    if (v.dport === '80' && (v.aplic === 'https' || v.aplic === 'ssl')) {
      ctx.warnManual('Virt', name, 'Port 80 is reserved for the http application on Alteon; service emitted as http (F5 had SSL on port 80 - verify the SSL policy attachment).');
      v.aplic = 'http';
    } else if (HARD_RESERVED[v.dport] && v.aplic !== HARD_RESERVED[v.dport]) {
      ctx.warnManual('Virt', name, 'Port ' + v.dport + ' is reserved for the ' + HARD_RESERVED[v.dport] + ' application on Alteon; service emitted as ' + HARD_RESERVED[v.dport] + '. Verify!');
      v.aplic = HARD_RESERVED[v.dport];
    }
    if (v.proto === 'udp' && !PROTO_CAPABLE.has(v.aplic)) {
      ctx.warnManual('Virt', name, 'F5 restricts this virtual to UDP, but its port/profiles map to the Alteon "' + v.aplic +
        '" application, which is TCP-only (no protocol setting on that service; verified live). NOT converted (put aside) - address manually!');
      continue;
    }
    if (v.proto && !['tcp', 'udp'].includes(v.proto)) {
      if (v.proto === 'any') {
        ctx.warnManual('Virt', name, 'F5 allows BOTH TCP and UDP on this virtual (ip-protocol any); the Alteon service was emitted with its TCP default - if UDP must also be balanced, add a second virtual on the same vip with "protocol udp"!');
      } else {
        ctx.warnManual('Virt', name, 'F5 ip-protocol "' + v.proto + '" cannot be expressed on an Alteon virt service (protocol is tcp/udp/stateless). NOT converted (put aside) - address manually!');
        continue;
      }
    }
    if (v.vlanList && v.vlanList.length) {
      if (!vlanRestricted.has(v.vip)) vlanRestricted.set(v.vip, { vlans: new Set(), names: [], lists: [] });
      const g = vlanRestricted.get(v.vip);
      for (const vn of v.vlanList) g.vlans.add(vn);
      g.names.push(name);
      g.lists.push(v.vlanList.join(','));
    }
    out += '/c/slb/virt ' + name + '\n    ena\n    ipver v4\n    vip ' + v.vip + '\n';
    if (v.disable) out += '    dis\n';   // live finding: the config keyword is "dis", not "disable"
    if (v.vname) {
      // VNAME-1: "Virtual server name is too long, must be less than 129
      // characters" (34.0.12) - the line is refused and the description lost.
      // Cap the text at 126 so it fits whether or not the quotes count.
      let vn = String(v.vname).trim();
      const t = vn.replace(/^"(.*)"$/s, '$1');
      if (t.length > 126) {
        ctx.warnManual('Virtual', name, 'F5 description is ' + t.length + ' characters; Alteon vname allows 128. Emitted the first 126 characters.',
          'Full description: ' + t);
        vn = '"' + t.slice(0, 126).replace(/\\+$/, '') + '"';
      }
      out += '    vname ' + vn + '\n';
    }
    // segment mode: the virt's Network Segment classifier also auto-updates
    // the segment's membership (per the segmentation guide). rtsrcmac =
    // Return-to-Last-Hop: responses go back via the gateway that forwarded
    // the request - keeps cross-segment paths symmetric, matching F5
    // route-domain return behavior (both verified applied on live 34.5.7).
    if (ctx.segments && v.rd && v.rd !== '0') {
      out += '    segment "' + v.rd + '"\n    rtsrcmac ena\n';
    }
    out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '\n';
    if (v.proto === 'udp') out += '    protocol udp\n';   // DNS-1: TCP is the device default
    for (const [k, val] of v.service) out += '    ' + k + ' ' + val + '\n';
    // LIVE-19: persistence (pbind/ptmout) must be emitted INSIDE the service
    // menu - i.e. BEFORE the /pip block switches the CLI into the pip submenu
    // (found live: 'unknown command "pbind"' on virts with both SNAT pool and
    // persistence)
    // PTMOUT-1 (apply-level sweep, 34.0.12): a persistence timeout below the
    // real servers' idle timeout refuses the WHOLE apply ("Virtual server V
    // has real(R) server timeout greater than persistent timeout") - for
    // sslid and clientip alike. Reals keep the device default tmout 10 (the
    // converter sets no real tmout), so ptmout is raised to 10.
    const ptmout = (t) => {
      const n = parseInt(t || '10', 10);
      if (!(n >= 10)) {
        ctx.warnManual('Virt', name, 'F5 persistence timeout is ' + (Number.isNaN(n) ? t : n + ' min') + '; Alteon refuses a persistence timeout below the real servers\' idle timeout (10 min default). Emitted ptmout 10 - clients stay sticky up to 10 min idle instead.');
        return '10';
      }
      return String(n);
    };
    if (v.persist) {
      if (v.persist.type === 'cookie' && !['http', 'https'].includes(v.aplic)) {
        // live finding: pbind cookie is only available on HTTP-parsing
        // services ("Usage: pbind clientip|disable" on an ip/basic service)
        ctx.warnManual('Virt', name, 'Cookie persistence needs an HTTP/HTTPS service; this service is "' + v.aplic +
          '" so persistence was omitted. Configure clientip persistence manually if stickiness is required!');
      } else if (v.persist.type === 'cookie' && v.aplic === 'https' && !(v.ssl && v.ssl.fe)) {
        // COOKIE-1 (apply-level sweep): an https service that does not
        // decrypt cannot carry cookie persistence - the device refuses the
        // whole apply ("Persistency cannot be set as cookie for encrypted
        // traffic"). The F5 virtual had no client-ssl profile either, so its
        // cookie persistence could not have worked there.
        ctx.warnManual('Virt', name, 'Cookie persistence on HTTPS traffic that is NOT decrypted (no client-ssl profile on the F5 virtual) - Alteon refuses it at apply ("Persistency cannot be set as cookie for encrypted traffic"). Persistence omitted; use clientip persistence or add SSL offload if stickiness is required!');
      } else if (v.persist.type === 'cookie') {
        const method = v.persist.method || 'insert';
        let rawName = v.persist['cookie-name'] || 'MyPersistCookie';
        if (rawName.length > 20) {          // LIVE-15: pbind cookie names max 20 chars (verified on 34.5.7.0)
          const shortName = rawName.slice(0, 20);
          ctx.warnManual('Virt', name, 'Cookie name "' + rawName + '" exceeds Alteon\'s 20-char limit; shortened to "' + shortName + '". Update anything that reads this cookie by name!');
          rawName = shortName;
        }
        const cname = '"' + rawName + '"';
        if (v.persist['cookie-AS']) {
          const exp = v.persist.expiration || 600;
          out += '/c/slb/appshape/script ' + name + '_cookie/ena/import text\nwhen HTTP_REQUEST  {\n\tpersist cookie ' +
            method + ' ' + cname + ' expires ' + exp + ' relative\n}\n';
          out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/appshape/add 5 ' + name + '_cookie\n';
        } else {
          // LIVE-8 (validated on licensed 34.5.7.0): "insert" takes only the
          // cookie name - the legacy tool's trailing "10 10" (passive-mode
          // offset/length) is rejected with "Invalid command-line argument".
          // The device defaults inserted-cookie expiry to 10 days.
          out += '    pbind cookie ' + method + ' ' + cname + '\n';
          ctx.warnManual('Virt', name, 'Cookie persistence: Alteon defaults the inserted-cookie expiry to 10 days; adjust via the service pbind menu if the F5 used a different lifetime.');
        }
      } else if (v.persist.type === 'ssl') {
        // LIVE-22 (verified live on 34.5.7): the keyword is "sslid", not "ssl".
        // "pbind ssl" is accepted by the parser but silently does NOTHING -
        // the mode stays "disabled" - so the virtual lost persistence without
        // any error. Valid only on SSL-terminating services (an http service
        // offers "clientip|cookie|disable" only).
        // SSLID-1 (apply-level sweep, 34.0.12): sslid on a service with ANY
        // SSL policy (fessl e, fessl+backend, backend only) refuses the whole
        // apply ("SSL ID persistency cannot be used in conjunction with SSL
        // Offloading"). On a disabled virtual the check is skipped and fires
        // when the virtual is enabled.
        if (v.ssl) {
          const svc = '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic;
          ctx.warnManual('Virt', name, 'F5 uses SSL session-ID persistence on a virtual that also decrypts or re-encrypts SSL. Alteon refuses session-ID persistence on a service with an SSL policy (at apply: "SSL ID persistency cannot be used in conjunction with SSL Offloading"). Persistence omitted - if stickiness is required, set it manually: ' + svc + '/pbind clientip and ptmout ' + Math.max(10, parseInt(v.persist.timeout, 10) || 10) +
            (v.aplic === 'https' && v.ssl.fe ? ', or cookie persistence: ' + svc + '/pbind cookie insert "<name>"' : '') + ', then apply.');
        } else if (['https', 'ssl'].includes(v.aplic)) {
          out += '    pbind sslid\n    ptmout ' + ptmout(v.persist.timeout) + '\n';
        } else {
          ctx.warnManual('Virt', name, 'SSL session-ID persistence needs an SSL-terminating service; this service is "' +
            v.aplic + '", where Alteon offers only clientip/cookie. Persistence omitted - review stickiness manually!');
        }
      } else if (v.persist.type === 'clientip') {
        if (v.aplic === 'ldap') {
          // LDAP-1 (full-file staging, confirmed on BOTH 34.5.7 and 34.0.12):
          // the ldap virt service has NO pbind command at all - emitting it
          // cascades "unknown command" into the following lines
          ctx.warnManual('Virt', name, 'F5 uses source-address persistence on this LDAP virtual, but the Alteon "ldap" service type has no persistence setting (verified on 34.5.7 and 34.0.12). Persistence omitted - review stickiness requirements manually!');
        } else {
          out += '    pbind clientip\n    ptmout ' + ptmout(v.persist.timeout) + '\n';
        }
      }
    }
    // FTP-1 (apply-level sweep, 34.0.12): the Alteon ftp service (port 21 is
    // reserved for it) parses FTP by default, and a parsing ftp service with
    // no ftp-data service refuses the WHOLE apply ("FTP service 21 without
    // related FTP-DATA service", plus "port N must have proxy enabled ... or
    // DAM"). Proven to apply: "dataport 20" + a "service 20 ftp-data" with the
    // same group (and the same pip, egress included). An F5 virtual WITHOUT
    // an ftp profile is plain TCP there, so its parsing is turned off
    // ("ftpp d", applies).
    let ftpData = null;
    if (v.aplic === 'ftp') {
      const dp = v.ftp && v.ftp.dataPort;
      const clash = dp && [...ctx.virts].some(([n2, o]) => n2 !== name && o.vip === v.vip && o.dport === dp && !o.wildcard);
      if (v.ftp && dp === '20' && !clash) {
        out += '    dataport 20\n';
        ftpData = '20';
      } else {
        out += '    ftpp d\n';
        if (v.ftp) {
          ctx.warnManual('Virt', name, 'The F5 FTP profile "' + v.ftp.profile + '" ' + (clash
            ? 'needs the data port ' + dp + ', but ' + v.vip + ':' + dp + ' is used by another virtual'
            : 'uses data port ' + dp + '; only data port 20 is proven on Alteon') +
            '. Converted with FTP parsing OFF (plain TCP): passive FTP works only if the servers announce a client-reachable address. Configure FTP parsing manually: ' +
            '/c/slb/virt ' + name + '/service 21 ftp/ftpp e, dataport <port>, and a "service <port> ftp-data" with the same group.');
        }
      }
    } else if (v.ftp) {
      ctx.warnManual('Virt', name, 'The F5 virtual uses FTP profile "' + v.ftp.profile + '" on port ' + v.dport + '; Alteon parses FTP only on the ftp service (port 21). Converted as plain TCP - FTP data-channel handling is NOT carried over. Verify active/passive FTP manually!');
    }
    if (v.pip) {
      out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/pip\n';
      for (const [k, val] of v.pip) out += '    ' + k + ' ' + val + '\n';
    }
    if (ftpData) {
      out += '/c/slb/virt ' + name + '/service ' + ftpData + ' ftp-data\n';
      if (v.service.get('group')) out += '    group ' + v.service.get('group') + '\n';
      out += '    rport ' + ftpData + '\n';
      if (v.pip) {
        out += '/c/slb/virt ' + name + '/service ' + ftpData + ' ftp-data/pip\n';
        for (const [k, val] of v.pip) out += '    ' + k + ' ' + val + '\n';
      }
    }
    for (const [k, val] of v.adv) {
      out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + k + ' ' + val + '\n';
    }
    if (v.ssl) {
      const fe = v.ssl.fe ? 'e' : 'd', be = v.ssl.be ? 'e' : 'd';
      // SSLPOL-1 (apply-level sweep, 34.0.12): one policy per virtual hit
      // "The maximum of 47 SSL policies has been reached" and every virtual
      // past it refused the whole apply ("SSL policy X must be defined").
      // The policies only differ in fessl/backend (and in the chain the
      // engineer attaches after the import - SSLCERT-1), so virtuals share one
      // policy per combination (two virtuals on one policy: applies).
      const firstCert = ((v.sslCerts || [])[0] || { certs: [] }).certs[0];
      const chain = firstCert && firstCert.chain ? firstCert.chain.split('/').pop() : '';
      const pkey = fe + be + '|' + chain;
      if (!ctx.sslPolIds.has(pkey)) {
        const tag = (fe === 'e' ? '_fe' : '') + (be === 'e' ? '_be' : '');
        const nth = chain ? [...ctx.sslPolIds.keys()].filter((k) => k.startsWith(fe + be + '|') && k !== fe + be + '|').length + 1 : 0;
        ctx.sslPolIds.set(pkey, 'f5ssl' + tag + (chain ? '_ch' + nth : ''));
      }
      const n32 = ctx.sslPolIds.get(pkey);
      if (!sslPolDone.has(n32)) {
        sslPolDone.add(n32);
        out += '/c/slb/ssl/sslpol ' + n32 + '/fessl ' + fe + '/convert d/backend/ssl ' + be + '\n';
        if (sslPolDone.size === 48) {
          ctx.warnManual('SSL', n32, 'More than 47 distinct SSL policies are needed (one per F5 fessl/backend/chain combination); Alteon 34.0.12 refuses the 48th. Merge policies that share a chain manually!');
        }
      }
      out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/ssl/sslpol ' + n32 + '\n';
      // RPORT-1 (34.0.12): attaching a policy with backend ssl off rewrites
      // rport 443 to 80 ("Backend servers listening port (rport) was changed
      // from 443 to 80 due to the use of No backend encryption") - the F5
      // sent plain text to the member port as configured. Re-setting rport
      // after the policy keeps it (read back "rport https", applied).
      const rp = v.service.get('rport');
      if (be === 'd' && rp && rp !== '0') {
        out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '\n    rport ' + rp + '\n';
      }
      // SSLCERT-1: the server certificate is NOT emitted. Verified on
      // 34.0.12: a service naming a certificate that is not in the repository
      // refuses the WHOLE apply ("certificate X must be defined"), an empty
      // cert/key stub refuses it too ("Unable to find a PRIVATE KEY"), and a
      // qkview carries no private keys. Without srvrcert the SSL service has
      // no certificate at all, so every offloaded virtual gets the exact steps.
      for (const sc of (v.sslCerts || [])) {
        const svc = '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/ssl';
        if (!sc.certs.length) {
          ctx.warnManual('Virt', name, 'SSL offload: the server certificate of client-ssl profile "' + sc.profile + '" could not be determined from the config, so NO certificate is bound. Import the certificate + key this service must present, then: ' + svc + '/srvrcert cert <id>, enable the (shared, DISABLED) SSL policy with /c/slb/ssl/sslpol ' + n32 + '/ena once every virtual on it has a certificate, and apply.');
          continue;
        }
        for (const c of sc.certs) {
          const certName = c.cert.split('/').pop();
          if (!ctx.certIds.has(certName)) {
            let id = certName.replace(/[^A-Za-z0-9._-]/g, '_');
            if (id.length > 32) id = id.slice(0, 28) + '_' + ctx.nextId('cert');
            ctx.certIds.set(certName, id);
          }
          const id = ctx.certIds.get(certName);
          const steps = [
            c.builtin ? '  1. Get the certificate and key this service should present, as PEM.'
              : '  1. Export certificate "' + c.cert + '" and key "' + (c.key || '?') + '" from the F5 as PEM' +
                (c.passphrase ? ' (the F5 key is passphrase-protected)' : '') + '.',
            '  2. Import them on the Alteon as ID ' + id + ': /c/slb/ssl/certs/import, component type cert+key, component ID ' + id + ' (the device then asks for the SCP server, file name, user and password).',
          ];
          if (c.chain) {
            const chName = c.chain.split('/').pop();
            if (!ctx.certIds.has('chain:' + chName)) {
              let cid = chName.replace(/[^A-Za-z0-9._-]/g, '_');
              if (cid.length > 32) cid = cid.slice(0, 28) + '_' + ctx.nextId('cert');
              ctx.certIds.set('chain:' + chName, cid);
            }
            const cid = ctx.certIds.get('chain:' + chName);
            steps.push('  3. Import the chain "' + c.chain + '" with component type intermca, ID ' + cid + ', then: /c/slb/ssl/sslpol ' + n32 + '/intermca cert ' + cid);
          }
          steps.push('  ' + (c.chain ? '4' : '3') + '. Bind it: ' + svc + '/srvrcert cert ' + id);
          // the policy is emitted DISABLED: enabling it while any service on
          // it lacks a certificate refuses the whole apply ("For SSL
          // Offloading capabilities, both the SSL Policy and Certificate/Group
          // must be defined", 34.0.12)
          steps.push('  ' + (c.chain ? '5' : '4') + '. Enable SSL policy ' + n32 + ' and apply: /c/slb/ssl/sslpol ' + n32 + '/ena - it is shared by every virtual with the same SSL settings and was left DISABLED, because Alteon refuses an enabled policy on any service that has no certificate yet. Enable it once all of them have their certificate.');
          ctx.warnManual('Virt', name, 'SSL offload: server certificate NOT bound - ' +
            (c.builtin ? 'the F5 profile "' + sc.profile + '" presents F5\'s built-in self-signed default.crt; import the certificate this service should really present under ID ' + id + '.'
              : 'F5 client-ssl profile "' + sc.profile + '" presents certificate "' + c.cert + '". Alteon refuses the WHOLE apply when a service names a certificate that is not in its repository, so the binding waits for the import.') +
            (sc.certs.length > 1 ? ' (The F5 profile has ' + sc.certs.length + ' certificates, e.g. RSA + ECDSA; Alteon binds one per service.)' : ''),
            steps.join('\n'));
          if (sc.certs.length > 1) break;
        }
      }
      if ((v.sslCerts || []).length > 1) {
        ctx.warnManual('Virt', name, 'The F5 virtual has ' + v.sslCerts.length + ' client-ssl profiles (SNI: one certificate per server name). Only the steps per profile are listed; SNI certificate selection must be designed manually on the Alteon.');
      }
    }
  }
  // VLANF-1 emission: F5 "vlans-enabled" -> one ALLOW filter per listed VLAN
  // (dip = the VIP, vlan <tag>) plus one DENY filter (dip = the VIP,
  // vlan any), bound to every known VLAN member port. TRAFFIC-PROVEN on live
  // 34.0.12: with the pair applied, the VIP answered from the allowed VLAN,
  // timed out from another VLAN, and an unrestricted control VIP on the same
  // ports stayed reachable from BOTH VLANs throughout (filters are
  // first-match by ascending ID; unmatched traffic proceeds normally - no
  // implicit deny). Filter IDs 200-989, below the wildcard-filter range.
  let vfId = 200;
  const vfPortAdds = new Map();          // port -> [filter ids]
  const vfAllPorts = new Set();
  for (const [, vl] of ctx.vlans) {
    if (vl.invalid) continue;
    for (const p of vl.interfaces) if (/^\d+$/.test(String(p))) vfAllPorts.add(p);
  }
  for (const [vip, g] of vlanRestricted) {
    const tags = [], missing = [];
    for (const vn of g.vlans) {
      const vl = ctx.vlans.get(vn);
      if (vl && !vl.invalid && vl.tag) tags.push(vl.tag);
      else missing.push(vn);
    }
    if (!tags.length) {
      ctx.warnManual('Virt', g.names.join(', '), 'F5 restricts this VIP (' + vip + ') to VLAN(s) "' + [...g.vlans].join(', ') +
        '", none of which resolve to a VLAN in the input; NO filters were emitted - the VIP listens on ALL VLANs. Restrict manually if required!');
      continue;
    }
    if (vfId + tags.length + 1 > 989) {
      ctx.warnManual('Filter', vip, 'VLAN-restriction filter ID budget exhausted (IDs 200-989); the remaining restricted VIPs listen on ALL VLANs - restrict manually!');
      break;
    }
    const ids = [];
    for (const tag of tags) {
      out += '\n/c/slb/filt ' + vfId + '\n    ena\n    name "vl_' + vip + '"\n    ipver v4\n    action allow\n' +
        '    sip any\n    smask 0.0.0.0\n    dip ' + vip + '\n    dmask 255.255.255.255\n    vlan ' + tag + '\n';
      ids.push(vfId); vfId += 1;
    }
    out += '\n/c/slb/filt ' + vfId + '\n    ena\n    name "vl_' + vip + '_deny"\n    ipver v4\n    action deny\n' +
      '    sip any\n    smask 0.0.0.0\n    dip ' + vip + '\n    dmask 255.255.255.255\n    vlan any\n';
    ids.push(vfId); vfId += 1;
    for (const p of vfAllPorts) {
      if (!vfPortAdds.has(p)) vfPortAdds.set(p, []);
      vfPortAdds.get(p).push(...ids);
    }
    ctx.warnManual('Virt', g.names.join(', '), 'F5 VLAN restriction on VIP ' + vip + ' converted to filters ' + ids.join(',') +
      ' (allow VLAN ' + tags.join(',') + ' + deny elsewhere), bound to port(s) ' + ([...vfAllPorts].join(',') || 'NONE') +
      '. Traffic-proven mechanism; verify the port bindings match where client traffic really enters.' +
      (missing.length ? ' VLAN(s) "' + missing.join(', ') + '" were NOT found in the input and are not allowed through - verify!' : '') +
      (new Set(g.lists).size > 1 ? ' NOTE: services on this VIP had DIFFERENT F5 VLAN lists; the UNION is allowed for all of them - tighten per-service (dport) manually if needed.' : '') +
      (ctx.segments ? ' NOTE: segment mode is active on this output; the segment redirect filters (1800+) evaluate AFTER these - verify the interaction.' : ''));
  }
  if (vfPortAdds.size && !vfAllPorts.size) {
    ctx.warnManual('Filter', 'vlan-restriction', 'VLAN-restriction filters were emitted but no VLAN member ports are known; bind them manually (/c/slb/port <p>/filt ena + add <ids>)!');
  }
  for (const [p, ids] of vfPortAdds) {
    out += '\n/c/slb/port ' + p + '\n    client ena\n    server ena\n    proxy ena\n    filt ena\n';
    for (const id of ids) out += '    add ' + id + '\n';
  }
  // vlans (legacy quirk: newline-prefixed segments, no trailing newline).
  // "ena" is REQUIRED: a newly created Alteon VLAN is disabled by default and
  // takes its member ports' links DOWN with it (found live: applied VLANs
  // silently killed both data ports; legacy tool had the same omission).
  // VTAG-1: F5 "tagged" members need "tag ena" on the Alteon port - without it
  // the port joins every VLAN untagged and only its PVID VLAN carries traffic
  // (6 field configs: trunks with 15-24 tagged VLANs). PVIDP-1: "add <port>"
  // of an untagged port asks "Confirm changing PVID [y/n]" and a pasted config
  // feeds the next lines in as answers (port not added, next VLAN lost -
  // probed 34.5.7). Setting the port's pvid first makes the add prompt-free.
  // Order: VLANs (created + enabled), then ports (tag/pvid), then the adds.
  const portCfg = new Map();             // port -> { tagged, pvid }
  const addsByVlan = [];
  for (const [name, vlan] of ctx.vlans) {
    if (vlan.invalid) continue;         // tag > 4090, diagnostic already recorded
    // NAMELEN-1: VLAN name is max 32 characters (34.0.12: 33 is refused with "Usage:")
    out += '\n/c/l2/vlan ' + vlan.tag + '\n    ena\n    name ' + name.slice(0, 32);
    const adds = [];
    for (const port of vlan.interfaces) {
      const c = portCfg.get(port) || { tagged: false, pvid: null };
      if (vlan.tagged && vlan.tagged.has(String(port))) c.tagged = true;
      else if (c.pvid && c.pvid !== vlan.tag) {
        ctx.warnManual('Vlan', name, 'Port ' + port + ' is an UNTAGGED member of both VLAN ' + c.pvid + ' and VLAN ' + vlan.tag +
          '; an Alteon port has one native VLAN. Port ' + port + ' was NOT added to VLAN ' + vlan.tag + ' - decide the native VLAN and tag the other one manually!');
        continue;
      } else c.pvid = vlan.tag;
      portCfg.set(port, c);
      adds.push(port);
    }
    if (adds.length) addsByVlan.push([vlan.tag, adds]);
  }
  for (const [port, c] of portCfg) {
    out += '\n/c/port ' + port;
    if (c.tagged) out += '\n    tag ena';
    if (c.pvid) out += '\n    pvid ' + c.pvid;
  }
  for (const [tag, adds] of addsByVlan) {
    out += '\n/c/l2/vlan ' + tag;
    for (const port of adds) out += '\n    add ' + port;
  }
  // PVIDP-1: the pvid-first add leaves an UNTAGGED port in default VLAN 1 too
  // (the prompt's "y" used to move it), and the apply refuses "Port 1 is a
  // member of multiple VLANs (1,40) without tagging". Remove it from VLAN 1
  // (no prompt; apply clean, VLAN 1 read back empty - 34.5.7).
  const leaveV1 = [...portCfg].filter(([, c]) => !c.tagged && c.pvid && String(c.pvid) !== '1').map(([p]) => p);
  if (leaveV1.length) {
    out += '\n/c/l2/vlan 1';
    for (const p of leaveV1) out += '\n    rem ' + p;
    ctx.warnManual('Vlan', 'access ports', 'Access (untagged) port(s) ' + leaveV1.join(', ') + ' are moved out of default VLAN 1 into their F5 VLAN (pvid, add, then /c/l2/vlan 1/rem). ' +
      'This assumes the target Alteon still has them in VLAN 1 (factory default). If a port is already in another VLAN on the target, remove it there first (/c/l2/vlan <old>/rem <port>, before pasting this config) - otherwise apply refuses "Port N is a member of multiple VLANs (...) without tagging". ' +
      'In that case the /c/l2/vlan 1/rem <port> line answers "port N is not in VLAN 1", which is harmless.');
      // PVIDP-1: remove-first proven on 34.5.7 (port 2 in lab VLAN 2): rem from VLAN 2, pvid 173, add, apply complete.
  }
  // interfaces. Alteon refuses to apply two IP interfaces in one subnet
  // ("Error: IP Interfaces N and M are on the same subnet." - verified live
  // on 34.5.7); F5 configs can carry several same-subnet self-IPs (typically
  // both HA units' selfs). Emit the first, flag the rest.
  const ifNets = new Map();
  for (const [name, itf] of ctx.ifs) {
    const net = netOf(itf.addr, itf.mask);
    if (net && ifNets.has(net)) {
      ctx.warnManual('L3 Interface', name, 'Self-IP ' + itf.addr + ' shares a subnet with interface ' +
        ifNets.get(net) + ' - Alteon rejects two IP interfaces in the same subnet at apply ' +
        '(usually this is the HA peer\'s self-IP: configure it on the SECOND Alteon of the HA pair). Interface omitted!');
      continue;
    }
    if (net) ifNets.set(net, itf.addr);
    out += '\n/c/l3/if ' + itf.ifId + '\n    ena\n    ipver v4\n    addr ' + itf.addr +
      '\n    mask ' + itf.mask + '\n    vlan ' + itf.vlanTag + '\n    descr ' + name + '\n';
    if (itf.peer) out += '    peer ' + itf.peer + '\n';
  }
  // floating IPs
  let floatId = 0;
  for (const [fname, f] of ctx.floats) {
    if (!ctx.floatVlanToIf.get(f.vlanTag)) continue; // no interface on the VLAN: diagnostic already recorded
    const ifId = floatIfOf(f);
    if (!ifId) {
      ctx.warnManual('Float IP', fname, 'Floating IP ' + f.addr + ' is in none of the subnets of the interfaces emitted on VLAN ' + f.vlanTag +
        '; Alteon refuses a floating IP outside its interface subnet at apply. NOT converted (put aside) - add the self-IP of that subnet as an interface, then "/c/l3/ha/floatip <n>/addr ' + f.addr + '" + "if <that interface>"!');
      continue;
    }
    floatId += 1;
    out += '\n/c/l3/ha/floatip ' + floatId + '\n    ena\n    ipver v4\n    addr ' + f.addr + '\n    if ' + ifId + '\n';
  }
  // system (device-level: only in the default/RD0 output when splitting)
  // JOIN-1 (apply-level sweep): the VLAN block ends without a newline; with
  // no interface or floating IP after it, the next command was glued onto
  // the last VLAN line ("add 1/c/sys").
  if (out && !out.endsWith('\n')) out += '\n';
  if (!ctx.skipSystem) {
    out += '/c/sys\n    hprompt ena\n';
    const sysSections = [['mmgmt', ctx.mgmt.mmgmt], ['ntp', ctx.mgmt.ntp]];
    for (const [label, map] of sysSections) {
      out += '/c/sys/' + label + '\n';
      for (const [k, v] of map) out += '    ' + k + ' ' + v + '\n';
    }
    out += '/c/sys/syslog\n';
    for (const [idx, s] of ctx.mgmt.syslog) out += '    hst' + idx + ' ' + s.host + ' 7 7 all ' + s.port + '\n';
    out += '/c/sys/ssnmp\n';
    for (const [k, v] of ctx.mgmt.ssnmp) out += '    ' + k + ' ' + v + '\n';
  }
  // routes - Alteon static route add is a single command under /c/l3/route/ip4
  // (verified on live 34.0.12.0: "/c/l3/route" then "add ..." errors with
  // 'unknown command "add"'). CLI guide: /cfg/l3/route/ip4/add <dst> <mask> <gw>.
  for (const r of ctx.routes) out += '/c/l3/route/ip4/add ' + (r.line !== undefined ? r.line : r) + '\n';
  // GW-1 (apply-level sweep): a default gateway with no emitted IP interface
  // in its subnet refuses the whole apply ("Gateway N has no associated IP
  // interface") - e.g. the F5 reached it through a self-IP on a VLAN that
  // was not migrated. Put it aside rather than block the configuration.
  const ipNum = (s) => s.split('.').reduce((a, o) => (a * 256) + (+o), 0);
  const onLocalSubnet = (ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip || '') && [...ifNets.keys()].some((k) => {
    const [net, mask] = k.split('/');
    return ((ipNum(ip) & ipNum(mask)) >>> 0) === +net;
  });
  for (const [id, gw] of ctx.gws) {
    if (!onLocalSubnet(gw.addr)) {
      ctx.warnManual('Route', 'default', 'Default gateway ' + gw.addr + ' is not inside the subnet of any migrated IP interface - Alteon refuses it at apply ("Gateway N has no associated IP interface"). NOT converted (put aside): add the interface for that subnet first, then "/c/l3/gw ' + id + '/addr ' + gw.addr + '/ena".');
      continue;
    }
    out += '/c/l3/gw ' + id + '\n    addr ' + gw.addr + '\n    ena  \n';
  }
  // lacp / trunks
  for (const [, l] of ctx.lacp) for (const p of l.port) out += '/c/l2/lacp/port ' + p + '\n    adminkey ' + l.lacpId + '\n';
  for (const [, t] of ctx.trunks) {
    out += '/c/l2/trunk ' + t.trunkId + '\n    ena\n    name ' + t.name + '\n';
    for (const m of t.members) out += '    add ' + m + '\n';
  }
  return out;
}

module.exports = { render };
