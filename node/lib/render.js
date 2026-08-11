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
  // network segments FIRST (live finding: a virt's "segment" classifier warns
  // "Invalid Segment id" if the segment is not defined yet — the segmentation
  // guide also orders segment definitions before everything else)
  if (ctx.segments) {
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
  // reals
  for (const [name, real] of ctx.reals) {
    out += '\n/c/slb/real ' + name + '\n    ' + (real.disabled ? 'dis' : 'ena') + '\n';
    for (const [k, v] of real.attrs) out += '    ' + k + ' ' + v + '\n';
  }
  // groups
  for (const [name, pool] of ctx.pools) {
    out += '\n/c/slb/group ' + name + '\n    ipver v4\n';
    // an empty "health " makes the CLI prompt interactively and swallow the
    // next pasted line (live finding); omit it and keep the Alteon default
    if (pool.attrs.get('advhc')) out += '    health ' + pool.attrs.get('advhc') + '\n';
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
    wfiltId += 10;
    if (wfiltId >= 1790) {                 // stay clear of the segment filter range (1800+) and the 2048 cap
      ctx.warnManual('Filter', name, 'Filter ID budget exhausted; convert this wildcard virtual manually!');
      return;
    }
    const fid = wfiltId;
    const isRedir = !!v.service.get('group');
    out += '/c/slb/filt ' + fid + '\n    ena\n    name "' + name.slice(0, 32) + '"\n    ipver v4\n';
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
    // vlan restriction: one vlan -> exact match; several -> any + verify note
    const tags = (v.vlanList || []).map((vn) => (ctx.vlans.get(vn) || {}).tag).filter(Boolean);
    if (tags.length === 1) out += '    vlan ' + tags[0] + '\n';
    else {
      out += '    vlan any\n';
      if (tags.length > 1) ctx.warnManual('Filter', name, 'Wildcard virtual was restricted to ' + tags.length +
        ' VLANs (' + tags.join(', ') + '); Alteon filters match ONE vlan or any — emitted "vlan any", tighten manually (e.g. one filter per VLAN)!');
    }
    // bind to the ports of the restricting VLANs; else the engineer must pick
    const ports = new Set();
    for (const vn of v.vlanList || []) for (const p of ((ctx.vlans.get(vn) || {}).interfaces || [])) ports.add(p);
    if (ports.size) {
      for (const p of ports) out += '/c/slb/port ' + p + '\n    client ena\n    server ena\n    proxy ena\n    filt ena\n    add ' + fid + '\n';
    } else {
      ctx.warnManual('Filter', name, 'Filter ' + fid + ' (from wildcard virtual ' + name +
        ') is NOT bound to any port — no VLAN restriction was present to derive ports from. Bind it to the ingress ports manually (/c/slb/port <p>/filt ena + add ' + fid + ') or it matches nothing!');
    }
    if (v.pip) ctx.warnManual('Filter', name, 'Wildcard virtual used SNAT (pool or automap); filter-based NAT is not converted automatically — configure the filter NAT/proxy IP manually!');
    if (v.persist) ctx.warnManual('Filter', name, 'Persistence on a wildcard virtual is not carried to the filter — review stickiness requirements manually!');
    if (ctx.segments && v.rd && v.rd !== '0') ctx.warnManual('Filter', name, 'Wildcard virtual belongs to route domain ' + v.rd +
      ' (a segment); the filter matches by VLAN instead of a segment binding (a segment supports only ONE associated filter — its gateway redirect). Verify interaction with the segment redirect filter!');
    ctx.warnManual('Virt', name, 'Wildcard virtual converted to filter ' + fid + ' (' + (isRedir ? 'redirect to group ' + v.service.get('group') : 'allow/forward') + '). Review the filter and its port bindings!');
  };
  // virts
  const HARD_RESERVED = { '21': 'ftp', '22': 'ssh', '25': 'smtp', '53': 'dns', '110': 'pop3', '111': 'sunrpc', '123': 'ntp',
    '143': 'imap', '389': 'ldap', '1812': 'radius-auth', '1813': 'radius-acc' };   // LIVE-18 + pop3/imap (live-confirmed 110) + sunrpc (live-confirmed 111 on 34.0.12)
  // VLANF-1 (field question): F5 "vlans-enabled" means the virtual listens
  // ONLY on the listed VLANs. Collected here per VIP, emitted as a filter
  // pair after the virt loop (see the emission block for the traffic proof).
  const vlanRestricted = new Map();      // vip -> {vlans:Set, names:[], lists:[]}
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
    ctx.warnManual('Group', 'capacity', 'Config defines ' + ctx.pools.size + ' groups; the Alteon VA used for validation caps at 1024 Real Server Groups — verify the target platform capacity or split the config!');
  }
  for (const [name, v] of ctx.virts) {
    if (v.wildcard) {
      if (v.vip !== undefined) renderWildcardFilter(name, v);
      continue;                            // wildcards become filters, never virts
    }
    if (v.vip === '0.0.0.0') continue;
    if (!v.vip || !v.dport) {
      // live finding: a virtual with no destination (GTM-managed listener)
      // rendered "service undefined" — refuse instead
      ctx.warnManual('Virt', name, 'Virtual has no destination in bigip.conf (GTM-managed listener?); NOT converted — address manually!');
      continue;
    }
    // live findings: Alteon reserves well-known service ports for matching
    // applications ('port 80 reserved for http', 'port 53 reserved for dns', …)
    if (v.dport === '80' && (v.aplic === 'https' || v.aplic === 'ssl')) {
      ctx.warnManual('Virt', name, 'Port 80 is reserved for the http application on Alteon; service emitted as http (F5 had SSL on port 80 — verify the SSL policy attachment).');
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
    if (v.vname) out += '    vname ' + v.vname + '\n';
    // segment mode: the virt's Network Segment classifier also auto-updates
    // the segment's membership (per the segmentation guide). rtsrcmac =
    // Return-to-Last-Hop: responses go back via the gateway that forwarded
    // the request — keeps cross-segment paths symmetric, matching F5
    // route-domain return behavior (both verified applied on live 34.5.7).
    if (ctx.segments && v.rd && v.rd !== '0') {
      out += '    segment "' + v.rd + '"\n    rtsrcmac ena\n';
    }
    out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '\n';
    if (v.proto === 'udp') out += '    protocol udp\n';   // DNS-1: TCP is the device default
    for (const [k, val] of v.service) out += '    ' + k + ' ' + val + '\n';
    // LIVE-19: persistence (pbind/ptmout) must be emitted INSIDE the service
    // menu — i.e. BEFORE the /pip block switches the CLI into the pip submenu
    // (found live: 'unknown command "pbind"' on virts with both SNAT pool and
    // persistence)
    if (v.persist) {
      if (v.persist.type === 'cookie' && !['http', 'https'].includes(v.aplic)) {
        // live finding: pbind cookie is only available on HTTP-parsing
        // services ("Usage: pbind clientip|disable" on an ip/basic service)
        ctx.warnManual('Virt', name, 'Cookie persistence needs an HTTP/HTTPS service; this service is "' + v.aplic +
          '" so persistence was omitted. Configure clientip persistence manually if stickiness is required!');
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
          // cookie name — the legacy tool's trailing "10 10" (passive-mode
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
        if (['https', 'ssl'].includes(v.aplic)) {
          out += '    pbind sslid\n    ptmout ' + (v.persist.timeout || '10') + '\n';
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
          out += '    pbind clientip\n    ptmout ' + (v.persist.timeout || '10') + '\n';
        }
      }
    }
    if (v.pip) {
      out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/pip\n';
      for (const [k, val] of v.pip) out += '    ' + k + ' ' + val + '\n';
    }
    for (const [k, val] of v.adv) {
      out += '/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + k + ' ' + val + '\n';
    }
    if (v.ssl) {
      const n32 = name.slice(0, 32);
      const fe = v.ssl.fe ? 'e' : 'd', be = v.ssl.be ? 'e' : 'd';
      out += '/c/slb/ssl/sslpol ' + n32 + '/fessl ' + fe + '/convert d/backend/ssl ' + be +
        '\n/c/slb/virt ' + name + '/service ' + v.dport + ' ' + v.aplic + '/ssl/sslpol ' + n32 + '\n';
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
  for (const [name, vlan] of ctx.vlans) {
    if (vlan.invalid) continue;         // tag > 4090, diagnostic already recorded
    out += '\n/c/l2/vlan ' + vlan.tag + '\n    ena\n    name ' + name;
    for (const port of vlan.interfaces) out += '\n    add ' + port;
  }
  // interfaces. Alteon refuses to apply two IP interfaces in one subnet
  // ("Error: IP Interfaces N and M are on the same subnet." - verified live
  // on 34.5.7); F5 configs can carry several same-subnet self-IPs (typically
  // both HA units' selfs). Emit the first, flag the rest.
  const ifNets = new Map();
  const netOf = (ip, mask) => {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(mask || '')) return null;
    const n = (s) => s.split('.').reduce((a, o) => (a * 256) + (+o), 0);
    return (((n(ip) & n(mask)) >>> 0) + '/' + mask);
  };
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
  for (const [, f] of ctx.floats) {
    const ifId = ctx.floatVlanToIf.get(f.vlanTag);
    if (!ifId) continue; // diagnostic already recorded
    floatId += 1;
    out += '\n/c/l3/ha/floatip ' + floatId + '\n    ena\n    ipver v4\n    addr ' + f.addr + '\n    if ' + ifId + '\n';
  }
  // system (device-level: only in the default/RD0 output when splitting)
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
  // routes — Alteon static route add is a single command under /c/l3/route/ip4
  // (verified on live 34.0.12.0: "/c/l3/route" then "add ..." errors with
  // 'unknown command "add"'). CLI guide: /cfg/l3/route/ip4/add <dst> <mask> <gw>.
  for (const r of ctx.routes) out += '/c/l3/route/ip4/add ' + (r.line !== undefined ? r.line : r) + '\n';
  for (const [id, gw] of ctx.gws) {
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
