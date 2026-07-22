'use strict';
const { Context, SEV } = require('./context');
const { parseAll } = require('./parsers');
const { render } = require('./render');

const LOG1_BANNER = `
##########################################################
# Commands unsupported by script but supported by Alteon #
# Syntax :                                               #
# Object type                                            # 
# Object name - as appears in F5 Config                 #
# Issue/unparsable line in f5 config                     #
# Suggested course of action                             #
##########################################################
`;
const LOG2_BANNER = `
#####################################################################
# Commands unsupported by script and MAY not be supported by Alteon #
# Syntax :                                                          #
# Object type                                                       #
# Object name - as appears in F5 Config                             #
# Issue/unparsable line in f5 config                                #
#####################################################################
`;

/**
 * Migrate one or more F5 tmsh config texts to a single Alteon CLI config.
 * @param {string[]} texts - contents of bigip.conf / bigip_base.conf (any order)
 * @returns {{output: string, log1: string, log2: string, diagnostics: object[]}}
 */
// Alteon IDs (real/group/virt names) are limited to 32 characters — longer
// names make the CLI reject the definition line and every line after it
// cascades into the wrong menu (found live: 1,400+ long names across two
// production fleets). Rename deterministically and fix every reference.
function shortenIds(ctx) {
  const renamed = (kind, oldName) => {
    // suffix must stay alphanumeric/underscore: the CLI rejects '~' and other
    // punctuation in IDs with "Special characters are not allowed"
    const suffix = '_' + ctx.nextId('id');
    const n = oldName.slice(0, 32 - suffix.length) + suffix;
    ctx.warnManual(kind, oldName, 'Name exceeds the 32-char Alteon ID limit; renamed to "' + n + '". All references were updated.');
    return n;
  };
  // reals (incl. any that end up with no IP at all -> cannot be configured)
  const realRen = new Map();
  for (const [k, v] of [...ctx.reals]) {
    if (!v.attrs.has('rip')) {
      ctx.warnManual('Real', k, 'Node has no usable IP address; real skipped — resolve manually!');
      ctx.reals.delete(k);
      continue;
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v.attrs.get('rip')) && !v.attrs.get('rip').includes(':')) {
      ctx.warnManual('Real', k, 'Node address "' + v.attrs.get('rip') +
        '" is not a valid IPv4 address (redacted or placeholder?); fix it before applying on Alteon!');
    }
    if (k.length > 32) {
      const n = renamed('Real', k);
      realRen.set(k, n); v.name = n;
      ctx.reals.delete(k); ctx.reals.set(n, v);
    }
  }
  // pools: rename keys, remap member keys to renamed reals, fix backup refs
  const poolRen = new Map();
  for (const [k, v] of [...ctx.pools]) {
    for (const [mk, mv] of [...v.members]) {
      const [rn, port] = mk.split(':');
      if (realRen.has(rn)) { v.members.delete(mk); v.members.set(realRen.get(rn) + (port ? ':' + port : ''), mv); }
    }
    if (k.length > 32) {
      const n = renamed('Group', k);
      poolRen.set(k, n);
      ctx.pools.delete(k); ctx.pools.set(n, v);
    }
  }
  for (const [pk, v] of ctx.pools) {
    if (v.attrs.has('backup')) {
      const bkpKey = v.attrs.get('backup').slice(1);            // 'g<name>'
      if (poolRen.has(bkpKey)) v.attrs.set('backup', 'g' + poolRen.get(bkpKey));
    }
    // a member whose real was skipped would emit "add <nonexistent>" -> error
    for (const mk of [...v.members.keys()]) {
      if (!ctx.reals.has(mk.split(':')[0])) {
        v.members.delete(mk);
        ctx.warnManual('Group', pk, 'Member ' + mk + ' has no migrated real server (skipped/unresolvable node); removed from the group — verify!');
      }
    }
  }
  // virts: rename keys, fix group references
  for (const [k, v] of [...ctx.virts]) {
    const gn = v.service.get('group');
    if (gn && poolRen.has(gn)) v.service.set('group', poolRen.get(gn));
    if (k.length > 32) {
      const n = renamed('Virt', k);
      ctx.virts.delete(k); ctx.virts.set(n, v);
    }
  }
}

// F5 route domains have no Alteon equivalent (one routing table per Alteon
// instance). The correct migration is ONE ALTEON INSTANCE PER ROUTE DOMAIN
// (vADC / separate VA), so a multi-RD config is split into one output per RD:
// the default output carries RD0 + device-level system config; each other RD
// gets its own self-contained config file. Cross-RD references and IP overlaps
// are flagged.
function splitByRouteDomain(ctx) {
  const ids = new Set(['0']);
  for (const [, r] of ctx.reals) ids.add(r.rdId || '0');
  for (const [, v] of ctx.virts) ids.add(v.rd || '0');
  for (const [, i] of ctx.ifs) ids.add(i.rdId || '0');
  for (const [, f] of ctx.floats) ids.add(f.rdId || '0');
  for (const r of ctx.routes) ids.add(r.rdId || '0');
  for (const [, g] of ctx.gws) ids.add(g.rdId || '0');
  for (const id of ctx.rdVlans.values()) ids.add(id);
  if (ids.size === 1) return null;                    // single-RD config: no split

  // pool RD: from its first resolvable member real, else from a referencing virt
  const poolRd = new Map();
  for (const [pk, p] of ctx.pools) {
    let rd = null;
    for (const mk of p.members.keys()) {
      const real = ctx.reals.get(mk.split(':')[0]);
      if (real) { rd = real.rdId || '0'; break; }
    }
    poolRd.set(pk, rd);
  }
  for (const [vk, v] of ctx.virts) {
    const gn = v.service.get('group');
    if (!gn || !ctx.pools.has(gn)) continue;
    const vrd = v.rd || '0';
    if (poolRd.get(gn) === null) poolRd.set(gn, vrd);
    else if (poolRd.get(gn) !== vrd) {
      ctx.warnManual('Virt', vk, 'Virtual is in route domain ' + vrd + ' but group ' + gn +
        ' has members in route domain ' + poolRd.get(gn) + '; the group is emitted in the RD' +
        poolRd.get(gn) + ' output — verify which instance should own this service!');
    }
  }
  for (const [pk, rd] of poolRd) if (rd === null) poolRd.set(pk, '0');

  // overlapping address space across RDs = MUST use separate instances
  const seenIp = new Map();
  const track = (ip, rd, what) => {
    if (!ip || !/^\d/.test(ip)) return;
    const prev = seenIp.get(ip);
    if (prev && prev.rd !== rd) {
      ctx.warnManual('RouteDomain', ip, 'IP ' + ip + ' exists in BOTH route domain ' + prev.rd +
        ' (' + prev.what + ') and ' + rd + ' (' + what + ') — overlapping address space; these RDs MUST stay on separate Alteon instances!');
    } else if (!prev) seenIp.set(ip, { rd, what });
  };
  for (const [k, r] of ctx.reals) track(r.attrs.get('rip'), r.rdId || '0', 'real ' + k);
  for (const [k, v] of ctx.virts) track(v.vip, v.rd || '0', 'virt ' + k);

  // per-RD monitor usage (logexp components included)
  const monRd = new Map();                            // monitor key(string) -> Set(rd)
  const useMon = (mk, rd) => {
    if (mk === undefined || mk === null || mk === '') return;
    const key = String(mk);
    if (!monRd.has(key)) monRd.set(key, new Set());
    monRd.get(key).add(rd);
    const mon = ctx.monitors.get(mk) || ctx.monitors.get(key) || ctx.monitors.get(+key);
    if (mon && mon.hcType === 'logexp') {
      for (const part of (mon.advtype.get('expr') || '').split(/[&|]/)) {
        useMon(part.replace(/[()]/g, ''), rd);
      }
    }
  };
  for (const [pk, p] of ctx.pools) useMon(p.attrs.get('advhc'), poolRd.get(pk));
  for (const [, r] of ctx.reals) useMon(r.attrs.get('health'), r.rdId || '0');

  const partitions = new Map();
  for (const id of [...ids].sort((a, b) => +a - +b)) {
    const sub = Object.create(ctx);                   // shares mgmt/diagnostics/methods
    sub.skipSystem = id !== '0';
    sub.reals = new Map([...ctx.reals].filter(([, r]) => (r.rdId || '0') === id));
    sub.pools = new Map([...ctx.pools].filter(([pk]) => poolRd.get(pk) === id));
    sub.virts = new Map([...ctx.virts].filter(([, v]) => (v.rd || '0') === id));
    sub.monitors = new Map([...ctx.monitors].filter(([mk]) => monRd.has(String(mk)) && monRd.get(String(mk)).has(id)));
    sub.vlans = new Map([...ctx.vlans].filter(([vn]) => (ctx.rdVlans.get(vn) || '0') === id));
    sub.ifs = new Map([...ctx.ifs].filter(([, i]) => (i.rdId || '0') === id));
    sub.floats = new Map([...ctx.floats].filter(([, f]) => (f.rdId || '0') === id));
    sub.floatVlanToIf = new Map();
    for (const [, i] of sub.ifs) if (!sub.floatVlanToIf.has(i.vlanTag)) sub.floatVlanToIf.set(i.vlanTag, String(i.ifId));
    sub.routes = ctx.routes.filter((r) => (r.rdId || '0') === id);
    sub.gws = new Map([...ctx.gws].filter(([, g]) => (g.rdId || '0') === id));
    partitions.set(id, sub);
  }
  ctx.warnManual('RouteDomain', 'split', 'Config uses ' + (ids.size - 1) + ' non-default route domain(s); ' +
    'output was SPLIT per route domain — deploy each _rdN file on its own Alteon instance (vADC or separate VA). ' +
    'Alteon has one routing table per instance.');
  return partitions;
}

// Alteon Network Segmentation mapping for F5 route domains: when RD address
// spaces do NOT overlap, all RDs can live on ONE Alteon as segments
// (/c/slb/segment): each segment binds the RD's VLANs + virtuals, and a
// redirect filter forces cross-segment traffic through the RD's gateway
// (typically the firewall) — same isolation intent as F5 RDs, one device.
// Overlapping address space still requires the per-RD split (segments share
// one routing table).
function buildSegments(ctx) {
  const ids = new Set();
  for (const [, r] of ctx.reals) if (r.rdId && r.rdId !== '0') ids.add(r.rdId);
  for (const [, v] of ctx.virts) if (v.rd && v.rd !== '0') ids.add(v.rd);
  for (const id of ctx.rdVlans.values()) if (id !== '0') ids.add(id);
  if (!ids.size) return false;
  // overlap check (same test as the split path)
  const seen = new Map();
  for (const [k, r] of ctx.reals) {
    const ip = r.attrs.get('rip'), rd = r.rdId || '0';
    if (ip && seen.has(ip) && seen.get(ip) !== rd) return false;
    if (ip) seen.set(ip, rd);
  }
  for (const [, v] of ctx.virts) {
    const rd = v.rd || '0';
    if (v.vip && seen.has(v.vip) && seen.get(v.vip) !== rd) return false;
    if (v.vip) seen.set(v.vip, rd);
  }
  ctx.segments = [];
  let filtId = 1800;
  for (const id of [...ids].sort((a, b) => +a - +b)) {
    const vlans = [];
    const ports = new Set();
    for (const [vn, rdId] of ctx.rdVlans) {
      if (rdId !== id || !ctx.vlans.has(vn)) continue;
      const vl = ctx.vlans.get(vn);
      if (vl.invalid) continue;
      vlans.push(vl.tag);
      for (const p of vl.interfaces) ports.add(p);
    }
    const gwEntry = [...ctx.gws.values()].find((g) => (g.rdId || '0') === id);
    if (!gwEntry) {
      ctx.warnManual('Segment', 'RD' + id, 'No default gateway found for route domain ' + id +
        ' in the F5 config; the segment redirect filter needs one (usually the firewall interface of that segment) — set the filter group target manually!');
    }
    ctx.segments.push({ id, name: (ctx.rdInfo.get(id) || '').trim(), vlans, ports: [...ports], gw: gwEntry ? gwEntry.addr : null, filtId });
    filtId += 10;
    ctx.warnManual('Segment', 'RD' + id, 'Route domain ' + id + ' converted to Alteon Network Segment ' + id +
      '. Verify: (1) the redirect filter is bound to ALL ports this segment\'s traffic traverses; (2) enable Return-to-Last-Hop for symmetric cross-segment paths (see the segmentation guide); (3) the gateway group targets the segment firewall.');
  }
  ctx.warnManual('Segment', 'mode', 'Config uses ' + ids.size + ' route domain(s) with NON-overlapping address space; converted to Alteon Network Segmentation on a SINGLE device (segments + redirect filters). Use --rd-mode split to force the one-instance-per-RD layout instead.');
  return true;
}

function migrate(texts, opts) {
  const rdMode = (opts && opts.rdMode) || 'auto';
  const ctx = new Context();
  for (const text of texts) parseAll(text.replace(/\r\n/g, '\n'), ctx);
  shortenIds(ctx);
  let segmented = false;
  if (rdMode === 'segment' || rdMode === 'auto') {
    segmented = buildSegments(ctx);
    if (!segmented && rdMode === 'segment') {
      ctx.warnManual('Segment', 'mode', 'Segment mode requested but route domains have OVERLAPPING address space (or none found); fell back to per-RD split — overlapping RDs cannot share one Alteon routing table!');
    }
  }
  const partitions = segmented ? null : splitByRouteDomain(ctx);
  const rdOutputs = {};
  let output;
  if (partitions) {
    for (const [id, sub] of partitions) {
      if (id === '0') output = render(sub);
      else rdOutputs[id] = render(sub);
    }
  } else {
    output = render(ctx);
  }
  // live finding: the Alteon CLI rejects non-ASCII anywhere ("Non printable
  // characters are not allowed") — e.g. UTF-8 descriptions like "Comunicación"
  const asciiGuard = (text) => {
    if (!/[^\n\r\x20-\x7e]/.test(text)) return text;
    const bad = new Set();
    const clean = text.split('\n').map((l) => {
      if (/[^\r\x20-\x7e]/.test(l)) {
        bad.add(l.trim().slice(0, 70));
        return l.replace(/[^\r\x20-\x7e]/g, '?');
      }
      return l;
    }).join('\n');
    for (const b of bad) {
      ctx.warnManual('Output', 'encoding', 'Line contained non-ASCII characters (the Alteon CLI rejects them); replaced with "?" — fix the text manually: ' + b);
    }
    return clean;
  };
  output = asciiGuard(output);
  for (const id of Object.keys(rdOutputs)) rdOutputs[id] = asciiGuard(rdOutputs[id]);
  const summary = {
    virtuals: ctx.virts.size,
    groups: ctx.pools.size,
    reals: ctx.reals.size,
    monitors: ctx.monitors.size,
    vlans: ctx.vlans.size,
    interfaces: ctx.ifs.size,
    floatIps: ctx.floats.size,
    routes: ctx.routes.length + ctx.gws.size,
    trunks: ctx.trunks.size + ctx.lacp.size
  };
  return {
    output,
    rdOutputs,                     // route-domain id -> config (empty when single-RD)
    rdInfo: Object.fromEntries(ctx.rdInfo),
    log1: LOG1_BANNER + ctx.logText(SEV.MANUAL),
    log2: LOG2_BANNER + ctx.logText(SEV.UNSUPPORTED),
    diagnostics: ctx.diagnostics,
    summary,
    objectCount: Object.values(summary).reduce((a, b) => a + b, 0)
  };
}

module.exports = { migrate };
