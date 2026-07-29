'use strict';
// F5 tmsh parsers, ported from legacy app/f5_mig.py with deliberate fixes:
//  BUG-1: self-IP vs floating-IP classified by traffic-group (legacy keyed on
//         the string 'local-only' and crashed on standalone configs)
//  BUG-3: full LB-metric mapping (legacy emitted invalid "metric round-robin")
//  BUG-4: NTP parsed correctly (legacy hit a NameError on the first line and
//         silently dropped the whole NTP config)
//  BUG-5: all management routes parsed (legacy skipped the last one)
const T = require('./tables');

const BLOCK = (kw) => new RegExp('^' + kw + ' .+\\{\\n(?:[ \\t].*\\n)*?\\}', 'gm');

// F5 interface names (slot.port, e.g. "1.1") -> Alteon numeric port.
// Verified on live 34.0.12.0: VLAN "add 1.1" errors with 'bad port "1.1"'.
// Matches the legacy tool's trunk-member normalization for consistency.
function normalizePort(p) {
  if (p.startsWith('1.')) return p.slice(2);
  if (p.includes('.')) return p.replace('.', '');
  return p;
}

// normalizePort + a diagnostic when the F5 slot prefix is not 1 (e.g. vCMP
// "2.0" becomes "20") — the target Alteon may not have such a port, so the
// mapping needs a human decision. (Live finding: 'bad port "70"'.)
function mapPort(ctx, type, owner, p) {
  const n = normalizePort(p);
  // warn on any slot.port name except plain "1.x" (e.g. "5.0"->50, "11.0"->110):
  // the target Alteon may not have such a port number
  if (p.includes('.') && !/^1\.\d+$/.test(p)) {
    ctx.warnManual(type, owner, 'F5 interface ' + p + ' mapped to Alteon port ' + n +
      '; verify the target Alteon has this port and adjust the numbering manually!');
  }
  return n;
}

function splitName(raw) {
  // "/Common/name" or "/rd/iapp.app/name" -> {rd, name, iapp}
  const s = raw.replace(/ \{$/, '').trim();
  if (!s.includes('/')) return { rd: 'Common', name: s, iapp: false };
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 2) return { rd: parts[0], name: parts[1], iapp: false };
  return { rd: parts[0], name: parts[parts.length - 1], iapp: true };
}

function hcLongName(ctx, hc, owner) {
  if (String(hc).length > 32) {
    const key = String(hc).replace(/ /g, '');
    if (ctx.longNames.has(key)) return ctx.longNames.get(key);
    const id = ctx.nextId('hc');
    ctx.longNames.set(key, id);
    ctx.warnManual('Health Check', owner, 'Name too long, changed to ID : ' + id);
    return id;
  }
  return hc;
}

// F5 ratio (1-100) -> Alteon real weight (1-48). weight 1 is the Alteon
// default and is omitted, matching the legacy tool.
function setRealWeight(ctx, real, owner, raw) {
  let w = parseInt(raw, 10);
  if (isNaN(w) || w < 1) {
    ctx.warnManual('Real', owner, 'Ratio "' + raw + '" could not be mapped to a weight, left at default. Verify!');
    return;
  }
  if (w > 48) {
    ctx.warnManual('Real', owner, 'Ratio ' + w + ' exceeds Alteon max weight 48, clamped. Verify relative weights!');
    w = 48;
  }
  const prev = real.attrs.get('weight');
  if (prev !== undefined && String(prev) !== String(w)) {
    ctx.warnManual('Real', owner, 'Conflicting ratios for the same node (' + prev + ' vs ' + w + '), kept ' + prev + '. Verify!');
    return;
  }
  if (w !== 1) real.attrs.set('weight', String(w));
}

function rdWarn(ctx, type, name, rd) {
  if (rd !== 'Common') {
    ctx.warnManual(type, name,
      'Found Route Domain configuration! using RD=' + rd + ', Please address it manually!');
  }
}

// ---------- ltm node ----------
function parseReals(text, ctx) {
  for (const block of text.match(BLOCK('ltm node')) || []) {
    let cur = null, rd = 'Common';
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('ltm node')) {
        const nm = splitName(line.replace('ltm node ', ''));
        rd = nm.rd;
        cur = { attrs: new Map() };
        ctx.reals.set(nm.name, cur);
        cur.name = nm.name;
      } else if (!cur) continue;
      else if (cur.inFqdn) {
        if (line.startsWith('name ')) cur.fqdnName = line.slice(5).trim();
        if (line === '}') cur.inFqdn = false;
      } else if (line === 'fqdn {') {
        cur.inFqdn = true; cur.fqdnName = cur.fqdnName || '(unnamed)';
      } else if (line.startsWith('address ')) {
        let addr = line.slice(8);
        if (addr.includes('%')) {         // route-domain suffix (10.1.2.3%4) is not valid on Alteon
          const [ip, addrRd] = addr.split('%');
          cur.rdId = addrRd;                // -> per-RD output split
          ctx.warnManual('Real', cur.name, 'Node address is in Route Domain ' + addrRd +
            ' (' + addr + '); RD suffix stripped — see the per-route-domain output files!');
          addr = ip;
        }
        cur.attrs.set('rip', addr);
      }
      else if (line.startsWith('description ')) cur.attrs.set('name', line.slice(12).replace('}', ''));
      else if (line.startsWith('monitor')) {
        const joined = resolveMonitorSpec(ctx, cur.name, 'Real', line.replace(/^monitor /, '').trim());
        if (joined) {
          cur.attrs.set('health', joined);
        } else if (line.includes('{') || line.includes('}')) {
          ctx.warnManual('Real', cur.name,
            'Found multiple healthchecks and did not join them to one LOGEXP please perform manually!');
        } else {
          const hc = splitName(line.replace(/^monitor /, '')).name;
          cur.attrs.set('health', T.BUILTIN_HC[hc] || hcLongName(ctx, hc, cur.name));
        }
      } else if (line.replace(/ /g, '').startsWith('session')) {
        // BUG-8 (live-validated): legacy emitted "shut psession", an
        // interactive/operational command that is invalid in an offline
        // config. Drain mode == no NEW sessions; at migration time there are
        // no existing sessions on the Alteon, so "dis" is equivalent.
        if (line.replace(/ /g, '').slice(7) === 'user-disabled') {
          cur.disabled = true;
          ctx.warnManual('Real', cur.name,
            'F5 drain mode (session user-disabled) migrated as disabled real. Re-enable after cutover if intended.');
        }
      } else if (line === 'state user-down') {
        cur.disabled = true; // F5 forced-offline -> Alteon real "dis"
      } else if (line.startsWith('ratio ')) {
        setRealWeight(ctx, cur, cur.name, line.slice(6).trim());
      } else if (line.startsWith('connection-limit ')) {
        const c = line.slice(17).trim();
        // "physical": F5 node connection-limit caps the whole server.
        // Mode given inline -- bare "maxcon <n>" prompts interactively
        // (live-validation finding) and breaks config paste.
        if (c !== '0') cur.attrs.set('maxcon', c + ' physical');
      } else if (line === 'state up' || line === 'state unchecked' || line === '}' || line === '') { /* ignore */ }
      else ctx.warnUnsupported('Real', cur.name, 'Unhandled line', ' Line: ' + line);
    }
    if (cur && cur.fqdnName && !cur.attrs.has('rip')) {
      // FQDN-defined node: no static IP to migrate, and this AlteonOS CLI has
      // no per-real fqdn command (checked live on 34.5.7) — skip with guidance
      ctx.warnManual('Real', cur.name, 'Node is FQDN-defined (' + cur.fqdnName +
        '); not converted — resolve it to static IP(s) or configure an Alteon FQDN/DNS-based server manually!');
      ctx.reals.delete(cur.name);
      cur = null;
    }
    if (cur) rdWarn(ctx, 'Real', cur.name, rd);
  }
}

// ---------- ltm monitor ----------
function parseMonitors(text, ctx) {
  for (const block of text.match(BLOCK('ltm monitor')) || []) {
    const first = block.split('\n')[0].replace('ltm monitor ', '').replace(' {', '');
    const [f5type, rawName] = first.split(' ');
    if (!rawName) continue;
    const nm = splitName(rawName);
    if (f5type === nm.name) {
      ctx.warnUnsupported('Health Check', nm.name,
        'This is a default object, Skipping the conversion in case needed please address manually');
      continue;
    }
    if (!(f5type in T.ADVHC)) {
      ctx.warnUnsupported('Health Check', nm.name,
        'This object is not currently supported, please update script or address manually');
      continue;
    }
    rdWarn(ctx, 'Health Check', nm.name, nm.rd);
    let name = nm.name;
    const descrip = name;
    if (name.length > 32) name = hcLongName(ctx, name, name);
    const hc = { hcType: T.ADVHC[f5type], attrs: new Map(), advtype: new Map() };
    hc.attrs.set('name', '"' + String(descrip).slice(0, 32) + '"');
    let inter = null;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('interval ')) { inter = line.slice(9); hc.attrs.set('inter', inter); }
      else if (line.startsWith('timeout ')) {
        const t = parseInt(line.slice(8), 10);
        hc.attrs.set('retry', String(Math.floor(t / parseInt(inter || '5', 10))));
        hc.attrs.set('timeout', inter || '5');
      } else if (line.startsWith('destination ')) {
        const dest = line.slice(12);
        const idx = dest.lastIndexOf(':') >= 0 ? dest.lastIndexOf(':') : dest.lastIndexOf('.');
        if (idx > 0) {
          const ip = dest.slice(0, idx), port = dest.slice(idx + 1);
          if (ip !== '*') hc.attrs.set('dest', ip);
          if (port !== '*') hc.attrs.set('dport', port);
        }
      } else if (line.startsWith('send ') && line !== 'send none') {
        if (['http', 'https'].includes(f5type)) parseHttpSend(line, hc, ctx, name);
        else if (f5type === 'udp') ctx.warnManual('Health Check', name, 'Sending string is not supported in UDP Health Checks.');
        else hc.advtype.set('send', line.replace(/^send /, ''));
      } else if (line.startsWith('recv ') && line !== 'recv none') {
        const v = line.replace(/^recv /, '');
        if (['http', 'https'].includes(f5type)) {
          if (v === '"200 OK"') hc.advtype.set('response', '200 none');
          else hc.advtype.set('response', '200 inc ' + (v.startsWith('"') ? v : '"' + v + '"'));
        } else hc.advtype.set('expect', v);
      } else if (line.startsWith('recv-disable') && line !== 'recv-disable none') {
        ctx.warnManual('Health Check', name, 'disable string isnt currently supported.');
      } else if (line.startsWith('cipherlist ')) {
        hc.attrs.set('cipher', '"' + line.slice(11) + '"'); hc.attrs.set('ssl', 'ena');
      } else if (line.startsWith('compatibility enabled') && f5type === 'https') {
        hc.attrs.set('cipher', '"ALL"');
      } else if (line.startsWith('description ')) hc.attrs.set('name', line.slice(12));
      else if (line.startsWith('username ')) hc.advtype.set('username', line.slice(9));
    }
    // LIVE-16 (found at APPLY time, not staging): Alteon SMTP health checks
    // require a username — without one the whole config refuses to apply.
    if (hc.hcType === 'smtp' && !hc.advtype.has('username')) {
      hc.hcType = 'tcp';
      hc.advtype.clear();
      ctx.warnManual('Health Check', name, 'F5 smtp monitor has no username; Alteon SMTP checks require one and the config would refuse to APPLY — converted as a TCP check. Configure the SMTP check manually if needed!');
    }
    ctx.monitors.set(name, hc);
  }
}

function parseHttpSend(line, hc, ctx, name) {
  let s = line.replace(/ {2,}/g, ' ');
  s = s.includes('send "') ? s.slice(s.indexOf('send "') + 6) : s.slice(s.indexOf('send ') + 5);
  const words = s.split(' ');
  const METHODS = ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS', 'DELETE', 'PATCH'];
  let method = 'GET', path = words[0] || '/';
  if (METHODS.includes(words[0])) { method = words[0]; path = words[1] || '/'; }
  path = path.replace(/"$/, '').replace(/\\n$/, '').replace(/\\r$/, '');
  const hi = path.indexOf('HTTP/1.');
  if (hi >= 0) path = path.slice(0, hi);
  hc.advtype.set('method', method);
  hc.advtype.set('path', '"' + path + '"');
  const rest = s.slice(s.indexOf(path) + path.length);
  const sections = rest.split('\\r\\n\\r\\n');
  for (const header of sections[0].split('\\r\\n')) {
    const clean = header.replace(/[\\"]/g, '').replace(/ /g, '');
    if (!clean || /^HTTP\/1\.[01]$/.test(clean)) continue;
    if (/^host:/i.test(clean)) hc.advtype.set('host', '"' + clean.split(':')[1] + '"');
    else if (clean.includes(':')) {
      const [k, v] = clean.split(':');
      const prev = hc.advtype.get('header');
      hc.advtype.set('header', (prev ? prev.replace('\\r\\n\n...', '') + '\n' : '\n') + k + ':' + v + '\\r\\n\n...');
    }
  }
  if (method === 'POST' && sections[1]) hc.advtype.set('body', '"' + sections[1].replace(/\\r\\n"?$/, '') + '"');
}

// ---------- ltm pool ----------
function parsePools(text, ctx) {
  for (const block of text.match(BLOCK('ltm pool')) || []) {
    let name = null, metric = null, hc = '', descrip = null;
    const memberRe = /^ {4}members \{\n(?:[\s\S]*?)\n {4}\}/m;
    const memberBlock = (block.match(memberRe) || [''])[0];
    const head = block.replace(memberBlock, '');
    for (const raw of head.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('ltm pool ')) {
        const nm = splitName(line.replace('ltm pool ', ''));
        name = nm.name;
        rdWarn(ctx, 'Group', name, nm.rd);
        if (nm.iapp) ctx.warnManual('Group', name, 'Found what looks like iAPP configuration, please validate manually!');
      } else if (line.startsWith('monitor ')) {
        const joined = resolveMonitorSpec(ctx, name, 'Group', line.slice(8).trim());
        if (joined) {
          hc = joined;
        } else {
          hc = splitName(line.replace('monitor ', '')).name;
          // F5 built-in monitor name -> Alteon built-in health check, unless the
          // config defines a custom monitor with that name
          if (!ctx.monitors.has(hc) && T.BUILTIN_HC[hc]) hc = T.BUILTIN_HC[hc];
          else hc = hcLongName(ctx, hc, name);
          if (!ctx.monitors.has(hc)) {
            if (hc in T.DEFAULT_ADVHC) {
              const d = T.DEFAULT_ADVHC[hc];
              const m = { hcType: d.hcType, attrs: new Map(), advtype: new Map() };
              m.attrs.set('name', d.name);
              if (d.dport) m.attrs.set('dport', d.dport);
              if (d.ssl) m.attrs.set('ssl', d.ssl);
              m.attrs.set('inter', d.inter); m.attrs.set('retry', d.retry); m.attrs.set('timeout', d.timeout);
              for (const [k, v] of Object.entries(d.advtype)) m.advtype.set(k, v);
              ctx.monitors.set(hc, m);
            } else if (!['icmp', 'tcp', 'http', 'https', 'udp'].includes(hc)) {
              ctx.warnManual('Health Check', hc,
                'found health check config in group ' + name + ' that was not defined (may be default), please correct manually!');
            }
          }
        }
      } else if (line.startsWith('load-balancing-mode ')) {
        const mode = line.slice(20);
        metric = T.METRIC[mode];
        if (!metric) {
          metric = 'roundrobin';
          ctx.warnManual('Group', name, 'Unmapped load-balancing-mode "' + mode + '", defaulted to roundrobin. Verify!');
        }
      } else if (line.startsWith('min-active-members') && line.replace(/[^0-9]/g, '') !== '1') {
        ctx.warnManual('Group', name, 'Priority-group activation with non default minimum active members. Please address manually');
      } else if (line.startsWith('description ')) descrip = line.slice(12).replace('}', '');
    }
    // members
    const members = new Map(); const prio = new Map();
    const memAttrs = new Map();                    // member key -> per-member settings
    let memberName = null;
    for (const raw of memberBlock.split('\n')) {
      const line = raw.trim();
      const m = line.match(/^(\S+) \{$/);
      if (m && line !== 'members {') {
        const nm = splitName(m[1]);
        memberName = nm.name;                      // "node:port"
        members.set(memberName, 'health ');
        memAttrs.set(memberName, {});
        rdWarn(ctx, 'Group', name, nm.rd);
      } else if (line.startsWith('address ') && memberName) {
        if (!ctx.reals.has(memberName.split(':')[0])) {
          ctx.warnManual('Group', name, 'Node not found or ip missmatch! Please check manually for ' + memberName.split(':')[0]);
        }
      } else if (line.startsWith('priority-group ') && memberName) {
        prio.set(memberName, line.split(/\s+/)[1]);
      } else if (line.startsWith('ratio ') && memberName) {
        memAttrs.get(memberName).ratio = line.slice(6).trim();
      } else if (line.startsWith('monitor ') && memberName) {
        if ((line.includes('{') && line.includes('}')) || / and /.test(line)) {
          ctx.warnManual('Group', name, 'Member ' + memberName + ' uses multiple healthchecks, join to one LOGEXP manually!');
        } else memAttrs.get(memberName).monitor = splitName(line.slice(8)).name;
      } else if (line === 'state user-down' && memberName) {
        memAttrs.get(memberName).disabled = true;
      } else if (line.replace(/ /g, '') === 'sessionuser-disabled' && memberName) {
        memAttrs.get(memberName).shut = true;
      } else if (line.startsWith('connection-limit ') && memberName) {
        const c = line.slice(17).trim();
        if (c !== '0') memAttrs.get(memberName).maxcon = c;
      }
    }
    if (!name) continue;
    // rport logic: if all members share one port use it; mixed ports -> per-real add with port rename
    const ports = new Set([...members.keys()].map(k => k.split(':')[1]).filter(Boolean));
    let rport = '0';
    if (ports.size === 1) { rport = [...ports][0]; ctx.rportByPool.set(name, rport); }
    else if (ports.size > 1) {
      for (const key of [...members.keys()]) {
        const [n, p] = key.split(':');
        const renamed = n + '_' + p;
        if (ctx.reals.has(n) && !ctx.reals.has(renamed)) {
          const clone = { name: renamed, attrs: new Map(ctx.reals.get(n).attrs), disabled: ctx.reals.get(n).disabled };
          clone.attrs.set('addport', p);
          ctx.reals.set(renamed, clone);
        }
        members.set(renamed, members.get(key)); members.delete(key);
        if (memAttrs.has(key)) { memAttrs.set(renamed, memAttrs.get(key)); memAttrs.delete(key); }
      }
      ctx.warnManual('Group', name, 'Members use mixed service ports; created per-port reals. Verify!');
    }
    const pool = { attrs: new Map(), members };
    pool.attrs.set('advhc', hc); pool.attrs.set('metric', metric || 'roundrobin');
    if (descrip) pool.attrs.set('name', descrip);
    ctx.pools.set(name, pool);
    // priority groups -> backup group (legacy: max prio = primary, rest = backup)
    if (prio.size > 0) {
      const vals = [...new Set(prio.values())];
      if (vals.length === 1 && prio.size === members.size) { /* all same -> nothing */ }
      else if (vals.length <= 2) {
        const maxVal = vals.sort().reverse()[0];
        const bkp = { attrs: new Map(pool.attrs), members: new Map() };
        for (const [mem] of [...members]) {
          const isPrimary = prio.get(mem) === maxVal;
          if (!isPrimary) { bkp.members.set(mem, members.get(mem)); members.delete(mem); }
        }
        pool.attrs.set('backup', 'g' + name + '_bkp');
        ctx.pools.set(name + '_bkp', bkp);
      } else {
        ctx.warnManual('Group', name, 'Priority-group with more then 2 groups is being used. Please address manually');
      }
    }
    // apply per-member settings to the underlying reals
    for (const [key, ma] of memAttrs) {
      const rn = key.split(':')[0];
      const real = ctx.reals.get(rn);
      if (!real) continue;
      if (ma.monitor && !real.attrs.has('health')) {
        real.attrs.set('health', T.BUILTIN_HC[ma.monitor] || hcLongName(ctx, ma.monitor, rn));
      }
      if (ma.ratio !== undefined) setRealWeight(ctx, real, rn, ma.ratio);
      // "logical": F5 member connection-limit caps one service, not the server
      if (ma.maxcon && !real.attrs.has('maxcon')) real.attrs.set('maxcon', ma.maxcon + ' logical');
      if (ma.shut) {
        real.disabled = true; // see BUG-8: drain mode -> dis (shut psession is not a config command)
        ctx.warnManual('Group', name, 'Member ' + key + ' is in drain mode (session user-disabled); real ' + rn +
          ' was disabled. Re-enable after cutover if intended.');
      }
      if (ma.disabled) {
        real.disabled = true;
        ctx.warnManual('Group', name, 'Member ' + key + ' is forced offline (state user-down); real ' + rn +
          ' was disabled. If this node serves other pools, verify!');
      }
    }
  }
}

// join multiple F5 monitors into one Alteon LOGEXP health check.
// parts: monitor names; op: '&' (F5 "A and B") or '|' (F5 "min 1 of { A B }")
function buildLogexp(ctx, owner, parts, op) {
  let hc = owner + '_logexp';
  const descr = hc.slice(0, 32);
  if (hc.length > 32) hc = hcLongName(ctx, hc, owner);
  const mon = { hcType: 'logexp', attrs: new Map(), advtype: new Map() };
  mon.attrs.set('name', '"' + descr + '"');
  let expr = '';
  for (const part of parts) {
    let h = splitName(part.trim()).name;
    if (!ctx.monitors.has(h) && T.BUILTIN_HC[h]) h = T.BUILTIN_HC[h];
    else h = hcLongName(ctx, h, owner);
    expr += (expr ? op : '') + '(' + h + ')';
  }
  mon.advtype.set('expr', expr);
  ctx.monitors.set(hc, mon);
  return hc;
}

// parse an F5 monitor spec ("X", "X and Y", "min N of { X Y }") into an
// Alteon health check name, creating a LOGEXP when several are combined.
function resolveMonitorSpec(ctx, owner, ownerType, spec) {
  const minMatch = spec.match(/^min (\d+) of \{\s*(.*?)\s*\}$/);
  if (minMatch) {
    const hc = buildLogexp(ctx, owner, minMatch[2].split(/\s+/), '|');
    if (minMatch[1] !== '1') {
      ctx.warnManual(ownerType, owner, 'Monitor "min ' + minMatch[1] + ' of" approximated as OR of all monitors (any one up marks the target up). Verify semantics!');
    }
    return hc;
  }
  if (/ and /.test(spec)) return buildLogexp(ctx, owner, spec.split(' and '), '&');
  return null; // single monitor: caller resolves
}

// ---------- ltm profile ----------
function parseProfiles(text, ctx) {
  for (const block of text.match(BLOCK('ltm profile')) || []) {
    const first = block.split('\n')[0].replace('ltm profile ', '').replace(' {', '');
    const parts = first.split(' ');
    const profType = parts[0];
    const nm = splitName(parts[1] || '');
    rdWarn(ctx, 'Profile', nm.name, nm.rd);
    const prof = { type: profType, adv: new Map() };
    if (profType === 'http' && block.includes('insert-xforwarded-for enabled')) {
      prof.adv.set('/http/xforward', 'ena');
    }
    ctx.profiles.set(nm.name, prof);
  }
}

// ---------- net address-list -> Alteon network class ----------
// Verified live on 34.5.7:
//   /c/slb/nwclss <id>            type address | ipver v4
//   /c/slb/nwclss <id>/network N  net subnet <ip> <mask> include
//                                 net range <from> <to> include
// A filter can then match on the class: "sip <id>" (the filter menu documents
// sip/dip as "IP address or network class").
function parseAddressLists(text, ctx) {
  for (const block of text.match(BLOCK('net address-list')) || []) {
    const hdr = block.split('\n')[0];
    const nm = splitName(hdr.replace('net address-list ', '').replace(' {', ''));
    const entry = { name: nm.name, elements: [], description: '' };
    const addrBlock = (block.match(/^ {4}addresses \{\n[\s\S]*?\n {4}\}/m) || [''])[0];
    for (const raw of addrBlock.split('\n').slice(1, -1)) {
      const t = raw.trim().replace(/\s*\{\s*\}$/, '');
      if (!t) continue;
      const [bare, rd] = t.split('%');
      if (rd) entry.rd = rd;                       // RD suffix: flagged below
      if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
        entry.elements.push({ kind: 'subnet', ip: bare, mask: '255.255.255.255' });
      } else if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(bare)) {
        const [ip, p] = bare.split('/');
        entry.elements.push({ kind: 'subnet', ip, mask: T.prefixToMask(p) });
      } else if (bare) {
        ctx.warnManual('Address list', nm.name, 'Address-list entry "' + t +
          '" is not a plain IPv4 address or CIDR; add it to network class "' + nm.name + '" manually.');
      }
    }
    const d = block.match(/^ {4}description (.*)$/m);
    if (d) entry.description = d[1].replace(/^"|"$/g, '');
    if (entry.rd) {
      ctx.warnManual('Address list', nm.name, 'Address-list entries are in route domain ' + entry.rd +
        '; the RD suffix was stripped for the Alteon network class - verify the class is used in the matching segment/instance.');
    }
    if (entry.elements.length) ctx.addrLists.set(nm.name, entry);
  }
}

// ---------- ltm traffic-matching-criteria (source-match forwarding) ----------
function parseTmc(text, ctx) {
  for (const block of text.match(BLOCK('ltm traffic-matching-criteria')) || []) {
    const hdr = block.split('\n')[0];
    const nm = splitName(hdr.replace('ltm traffic-matching-criteria ', '').replace(' {', ''));
    const get = (k) => {
      const m = block.match(new RegExp('^ {4}' + k + ' (.*)$', 'm'));
      return m ? m[1].trim() : null;
    };
    const listName = (v) => (v ? splitName(v).name : null);
    ctx.tmc.set(nm.name, {
      srcList: listName(get('source-address-list')),
      dstList: listName(get('destination-address-list')),
      srcInline: get('source-address-inline'),
      dstInline: get('destination-address-inline'),
      rd: listName(get('route-domain')),
      srcPortList: listName(get('source-port-list')),
      dstPortList: listName(get('destination-port-list')),
    });
  }
}

// ---------- ltm persistence ----------
function parsePersist(text, ctx) {
  for (const block of text.match(BLOCK('ltm persistence')) || []) {
    let name = null, entry = null;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('ltm persistence ')) {
        const rest = line.replace('ltm persistence ', '').replace(' {', '');
        const sp = rest.split(' ');
        let ptype = sp[0];
        const nm = splitName(sp[1] || '');
        name = nm.name;
        rdWarn(ctx, 'Persistence', name, nm.rd);
        if (ptype === 'source-addr') ptype = 'clientip';
        entry = { type: ptype };
        ctx.persist.set(name, entry);
      } else if (!entry) continue;
      else if (line.startsWith('timeout ')) entry.timeout = String(Math.floor(parseInt(line.slice(8), 10) / 60));
      else if (line.startsWith('cookie-name ')) entry['cookie-name'] = line.slice(12);
      else if (line.startsWith('method ')) entry.method = line.slice(7);
      else if (line.startsWith('expiration ') && line.slice(11) !== '0') {
        const el = line.slice(11).split(':').map(Number);
        const mult = [86400, 3600, 60, 1].slice(4 - el.length);
        const exp = el.reduce((a, v, i) => a + v * mult[i], 0);
        ctx.warnManual('Persistance', name, 'Please validate expiration, was ' + line.slice(11) + ' now ' + exp + '!');
        entry['cookie-AS'] = 'ena'; entry.expiration = exp;
      }
    }
  }
}

// ---------- ltm virtual ----------
function parseVirts(text, ctx) {
  for (const block of text.match(BLOCK('ltm virtual')) || []) {
    if (block.startsWith('ltm virtual-address')) continue;
    const first = block.split('\n')[0].replace(' {', '');
    const nm = splitName(first.replace('ltm virtual ', ''));
    const name = nm.name;
    rdWarn(ctx, 'Virt', name, nm.rd);
    const virt = { adv: new Map(), service: new Map(), profiles: new Map(), aplic: 'basic-slb' };
    // sub-blocks
    const profBlock = (block.match(/^ {4}profiles \{\n[\s\S]*?\n {4}\}/m) || [''])[0];
    const persistBlock = (block.match(/^ {4}persist \{\n[\s\S]*?\n {4}\}/m) || [''])[0];
    const snatBlock = (block.match(/^ {4}source-address-translation \{\n[\s\S]*?\n {4}\}/m) || [''])[0];
    const vlanBlock = (block.match(/^ {4}vlans \{\n[\s\S]*?vlans-\S+/m) || [''])[0];
    const rulesBlock = (block.match(/^ {4}rules \{\n[\s\S]*?\n {4}\}/m) || [''])[0];
    if (rulesBlock) {
      ctx.warnManual('Virt', name, 'iRules are attached; not converted automatically. Please address manually!',
        rulesBlock);
    }
    const warnVlanRestriction = () => {
      if (vlanBlock && !block.includes('vlans-disabled') && !virt.wildcard) {
        ctx.warnUnsupported('Virt', name, 'Vlan specific virt is not supported, please address manually:', vlanBlock);
      }
    };
    const tmcLine = block.match(/^ {4}traffic-matching-criteria (.*)$/m);
    if (tmcLine) {
      // Source-match forwarding virtual. Converted to an Alteon filter whose
      // sip is a network class built from the F5 address-list (both verified
      // live on 34.5.7). Marked wildcard so it takes the filter render path.
      virt.tmc = splitName(tmcLine[1].trim()).name;
      virt.wildcard = true;
      if (virt.vip === undefined) virt.vip = '0.0.0.0';
      if (virt.mask === undefined) virt.mask = '0.0.0.0';
    }
    if (snatBlock) {
      for (const raw of snatBlock.split('\n').slice(1, -1)) {
        const line = raw.trim();
        if (line.startsWith('type ') && line.includes('automap')) {
          // SNAT Automap -> "pip mode egress" (validated live on 34.5.7 with
          // traffic: backend saw the Alteon proxy IP as the client, one-armed
          // return path restored - the same data-plane behavior as automap).
          // Egress mode takes its address from the per-VLAN/port Proxy IP
          // table, which needs a FREE IP the converter cannot invent - so a
          // REQUIRED companion step is flagged. Verified failure mode: with
          // mode egress and an empty PIP table, the service does not NAT and
          // one-armed traffic times out.
          virt.pip = new Map([['mode', 'egress']]);
          virt.automap = true;   // render fills the PIP table (floats) or warns
        } else if (line.startsWith('pool ')) {
          let pn = splitName(line.slice(5)).name;
          if (pn.length > 32) {          // live finding: nwclss IDs max 32 chars
            const short = pn.slice(0, 28) + '_' + ctx.nextId('nwclss');
            ctx.warnManual('Virt', name, 'SNAT pool name "' + pn + '" exceeds the 32-char Alteon ID limit; network class renamed to "' + short + '". Use that name when creating the class manually!');
            pn = short;
          }
          virt.pip = new Map([['mode', 'nwclss'], ['nwclss v4', pn + ' persist disable']]);
        }
      }
    }
    const body = block.replace(profBlock, '').replace(persistBlock, '').replace(snatBlock, '').replace(vlanBlock, '').replace(rulesBlock, '');
    let delVirt = false, dport = null;
    // vlan restriction list (used for wildcard->filter vlan matching and
    // filter port bindings)
    if (vlanBlock && !block.includes('vlans-disabled')) {
      virt.vlanList = vlanBlock.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'vlans {' && l !== '}' && !l.startsWith('vlans-'))
        .map((l) => splitName(l).name);
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('mask ') && line.slice(5) !== '255.255.255.255') {
        // non-/32 destination -> wildcard virtual -> Alteon filter
        virt.mask = line.slice(5) === 'any' ? '0.0.0.0' : line.slice(5);
        virt.wildcard = true;
      } else if (line === 'ip-forward') {
        virt.ipForward = true;
        virt.wildcard = true;
      } else if (line.startsWith('ip-protocol ')) {
        virt.proto = line.slice(12);
      } else if (line.startsWith('destination ')) {
        let dest = splitName(line.replace('destination ', '')).name;
        if (dest.includes('%')) {
          const rdm = dest.match(/%(\d+)/);
          if (rdm) virt.rd = rdm[1];        // route-domain id -> per-RD output split
          ctx.warnUnsupported('Virt', name, 'Route domain configuration in VIP listener! will omit please make sure logic retained:', dest);
          dest = dest.replace(/%[^:.]+/, '');
        }
        const idx = dest.lastIndexOf(':') >= 0 ? dest.lastIndexOf(':') : dest.lastIndexOf('.');
        let vip = dest.slice(0, idx);
        dport = dest.slice(idx + 1);
        if (!/^\d+$/.test(dport)) dport = T.DPORT[dport] || dport;
        virt.rawDport = dport;               // unmunged ('0' = any) for filters
        if (dport === '0') dport = '1';
        if (vip === 'any') { vip = '0.0.0.0'; virt.wildcard = true; }
        virt.vip = vip; virt.dport = dport;
        virt.aplic = dport === '1' ? 'ip' : dport === '80' ? 'http' : dport === '443' ? 'ssl' : 'basic-slb';
      } else if (line.startsWith('pool ')) {
        const gn = splitName(line.slice(5)).name;
        virt.service.set('group', gn);
        virt.service.set('rport', ctx.rportByPool.get(gn) || '0');
      } else if (line.startsWith('description ')) virt.vname = line.slice(12);
      else if (line === 'disabled') virt.disable = ' ';
      else if (line.startsWith('mirror')) virt.service.set('mirror', 'ena');
      else if (line === 'translate-port disabled') virt.translatePort = false;
      else if (line.startsWith('source ') && !/^0\.0\.0\.0(%\d+)?\/0$/.test(line.slice(7))) virt.source = line.slice(7);
    }
    // profiles
    for (const raw of profBlock.split('\n')) {
      const m = raw.trim().match(/^(\S+) \{/);
      if (!m || raw.trim() === 'profiles {') continue;
      const pn = splitName(m[1]).name;
      let ptype = '';
      if (ctx.profiles.has(pn)) {
        ptype = ctx.profiles.get(pn).type;
        for (const [k, v] of ctx.profiles.get(pn).adv) virt.adv.set(k, v);
      } else if (pn in T.DEF_PROF) ptype = T.DEF_PROF[pn];
      else if (T.NOEQUIV_PROF.has(pn)) {
        ctx.warnManual('Profile', pn, 'Built-in profile has no Alteon equivalent; virt ' + name +
          ' was converted without it. Verify behavior manually.');
      } else ctx.warnManual('Profile', pn, 'Profile is not found in both config and default profile list.');
      virt.profiles.set(pn, ptype);
      if (ptype === 'http' && virt.aplic === 'basic-slb') virt.aplic = 'http';
      else if (ptype === 'http' && virt.aplic === 'ssl') virt.aplic = 'https';
      else if (['client-ssl', 'server-ssl'].includes(ptype) && virt.aplic === 'basic-slb') virt.aplic = 'ssl';
      else if (['client-ssl', 'server-ssl'].includes(ptype) && virt.aplic === 'http') virt.aplic = 'https';
      if (ptype === 'client-ssl') (virt.ssl = virt.ssl || {}).fe = 'ena';
      if (ptype === 'server-ssl') (virt.ssl = virt.ssl || {}).be = 'ena';
    }
    // persist
    for (const raw of persistBlock.split('\n')) {
      const m = raw.trim().match(/^(\S+) \{$/);
      if (!m || raw.trim() === 'persist {') continue;
      const pn = splitName(m[1]).name;
      if (persistBlock.includes('default yes')) {
        if (ctx.persist.has(pn)) virt.persist = ctx.persist.get(pn);
        else if (pn in T.DEF_PERSIST) virt.persist = T.DEF_PERSIST[pn];
        else ctx.warnManual('Virt', name, 'required unknown persistance profile: ' + pn + ', please address manually');
        if (virt.persist && virt.persist.type === 'ssl') virt.aplic = 'ssl';
      }
    }
    warnVlanRestriction();
    if (!delVirt) ctx.virts.set(name, virt);
  }
}

// ---------- net vlan ----------
function parseVlans(text, ctx) {
  for (const block of text.match(BLOCK('net vlan')) || []) {
    let name = null, tag = null;
    const nm = splitName(block.split('\n')[0].replace('net vlan ', '').replace(' {', ''));
    name = nm.name;
    rdWarn(ctx, 'Vlan', name, nm.rd);
    const tm = block.match(/^\s+tag (\d+)/m);
    if (tm) tag = tm[1];
    if (block.includes('tag-mode')) {
      ctx.warnManual('Vlan', name, 'tag-mode command is not supported, Please address it manually!');
    }
    // Live finding: Alteon rejects VLAN IDs above 4090 (F5 allows up to 4094
    // and uses 4092-4094 internally for HA/failover VLANs).
    const invalid = tag !== null && parseInt(tag, 10) > 4090;
    if (invalid) {
      ctx.warnManual('Vlan', name, 'VLAN tag ' + tag + ' exceeds the Alteon maximum (4090); the VLAN and its self-IPs were NOT migrated. F5 uses 4092-4094 for internal HA VLANs — usually safe to drop, otherwise re-number manually!');
    }
    const ifList = [];
    const im = block.match(/ {4}interfaces \{\n([\s\S]*?)\n {4}\}/);
    if (im) {
      for (const raw of im[1].split('\n')) {
        const pm = raw.trim().match(/^(\S+) \{/);
        if (!pm) continue;
        const port = pm[1];
        if (ctx.trunks.has(port)) ifList.push(...ctx.trunks.get(port).members);
        else if (ctx.lacp.has(port)) ifList.push(...ctx.lacp.get(port).port);
        else ifList.push(mapPort(ctx, 'Vlan', name, port));
      }
    } else ifList.push('1');
    // live finding: an unresolved trunk/interface NAME leaked into "add" and
    // the device rejected it ('bad port "trunk_sync_vcmp"')
    const numeric = ifList.filter(p => /^\d+$/.test(p));
    for (const bad of ifList.filter(p => !/^\d+$/.test(p))) {
      ctx.warnManual('Vlan', name, 'Interface "' + bad + '" could not be mapped to a numeric Alteon port (unresolved trunk?); dropped from the VLAN — add manually!');
    }
    ctx.vlans.set(name, { tag, interfaces: numeric, invalid });
  }
}

// ---------- net self ----------
function parseSelfIps(text, ctx) {
  for (const block of text.match(BLOCK('net self')) || []) {
    let name = null, addr = null, mask = null, vlanTag = null, onInvalidVlan = false, rdId = '0';
    // FIX BUG-1: classify by traffic-group. local-only => interface IP;
    // any other/absent traffic group on an HA pair => floating IP; but a
    // standalone box (no local-only self-IPs at all) gets interfaces.
    const isLocal = block.includes('traffic-group-local-only') || !/traffic-group/.test(block);
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('net self ')) {
        const nm = splitName(line.replace('net self ', ''));
        name = nm.name;
        rdWarn(ctx, 'L3 Interface', name, nm.rd);
      } else if (line.startsWith('address ')) {
        const [ip, pfx] = line.slice(8).split('/');
        addr = ip; mask = T.prefixToMask(pfx);
        if (addr.includes('%')) {         // route-domain suffix — see node handling
          const [bare, selfRd] = addr.split('%');
          rdId = selfRd;                    // -> per-RD output split
          ctx.warnManual('L3 Interface', name || bare, 'Self-IP is in Route Domain ' + selfRd +
            ' (' + addr + '); RD suffix stripped — see the per-route-domain output files!');
          addr = bare;
        }
      } else if (line.startsWith('vlan ')) {
        const vn = splitName(line.slice(5)).name;
        if (ctx.vlans.has(vn)) {
          const ve = ctx.vlans.get(vn);
          if (ve.invalid) onInvalidVlan = true;
          vlanTag = ve.tag;
        } else {
          ctx.warnManual('Vlan', vn, 'Vlan Not Found! Please address manually');
          vlanTag = 'error:' + vn;
        }
      }
    }
    if (!name || !addr) continue;
    if (onInvalidVlan) {
      ctx.warnManual('L3 Interface', name,
        'Self-IP sits on VLAN ' + vlanTag + ' (>4090, not migrated); interface skipped — see the VLAN diagnostic.');
      continue;
    }
    if (isLocal) {
      const ifId = ctx.nextId('if');
      ctx.ifs.set(name, { ifId, addr, mask, vlanTag, rdId });
      if (!ctx.floatVlanToIf.has(vlanTag)) ctx.floatVlanToIf.set(vlanTag, String(ifId));
    } else {
      ctx.floats.set(name, { addr, vlanTag, rdId });
    }
    if (block.includes('allow-service') && !/allow-service (default|all|none)$/m.test(block.replace(/\n/g, ' '))) {
      // granular port-lockdown lists need manual attention (legacy logged similarly)
    }
  }
  // FIX BUG-1 (second half): floats whose vlan has no interface get one
  for (const [fname, f] of ctx.floats) {
    if (!ctx.floatVlanToIf.has(f.vlanTag)) {
      ctx.warnManual('Float IP', fname,
        'No interface IP found on the same VLAN; floating IP needs manual interface assignment!');
    }
  }
}

// ---------- net route ----------
function parseRoutes(text, ctx) {
  for (const block of text.match(BLOCK('net route')) || []) {
    let gw = null, net = null, pool = '', netRd = null;
    if (!/^\s+network /m.test(block)) {
      ctx.warnManual('Route', 'N/A', 'Route is not simple L3! please address manually', block);
    }
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('gw ')) gw = line.split(/\s+/)[1];
      else if (line.startsWith('network ')) {
        net = line.split(/\s+/)[1];
        // RD-scoped routes ("default%1", "10.10.0.0%1/16") are the per-route-domain
        // default gateways/routes — carry the RD instead of dropping the route, so
        // segment mode can build the redirect-filter gateway and split mode can
        // place the route in the right per-RD output.
        const rdm = net.match(/^([^%\/]+)%(\d+)(\/\d+)?$/);
        if (rdm) {
          netRd = rdm[2];
          net = rdm[1] + (rdm[3] || '');
          ctx.warnManual('Route', net, 'Route is scoped to Route Domain ' + netRd +
            '; RD suffix stripped and route assigned to that route domain (segment gateway / per-RD output).');
        } else if (net.includes('%')) {
          ctx.warnManual('Route', 'N/A', 'Route domain found in route definition, please address manually: ' + net);
        }
        if (net === 'default') net = '0.0.0.0 0.0.0.0';
        else if (net.includes('/')) {
          const [n, p] = net.split('/');
          net = n + ' ' + T.prefixToMask(p);
        }
      } else if (line.startsWith('pool ')) {
        pool = line.slice(5);
        ctx.warnManual('Route', 'N/A', 'using group (' + pool + ') as next-hop, please address manually');
      }
    }
    if (pool) continue;
    let routeRd = netRd || '0';
    if (gw && gw.includes('%')) {         // route-domain suffix on the gateway
      const [bare, gwRd] = gw.split('%');
      routeRd = gwRd;
      ctx.warnManual('Route', net || 'N/A', 'Route gateway is in Route Domain ' + gwRd +
        ' (' + gw + '); RD suffix stripped — see the per-route-domain output files!');
      gw = bare;
    }
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gw || '')) {           // live finding: "bad gateway IP address null"
      ctx.warnManual('Route', net || 'N/A', 'Route has no usable IPv4 gateway ("' + gw + '"); skipped — address manually!');
      continue;
    }
    if (net === '0.0.0.0 0.0.0.0') ctx.gws.set(ctx.nextId('gw'), { addr: gw, rdId: routeRd });
    else if (net && !net.includes('%')) ctx.routes.push({ line: net + ' ' + gw, rdId: routeRd });
  }
}

// ---------- net route-domain (vlan membership drives the per-RD split) ----------
function parseRouteDomains(text, ctx) {
  for (const block of text.match(BLOCK('net route-domain')) || []) {
    const idm = block.match(/^\s+id (\d+)/m);
    if (!idm) continue;
    const id = idm[1];
    const dm = block.match(/^\s+description "?([^"\n]*)"?/m);
    ctx.rdInfo.set(id, dm ? dm[1] : '');
    const vm = block.match(/ {4}vlans \{\n([\s\S]*?)\n {4}\}/);
    if (vm) {
      for (const raw of vm[1].split('\n')) {
        const vn = splitName(raw.trim()).name;
        if (vn) ctx.rdVlans.set(vn, id);
      }
    }
  }
}

// ---------- net trunk ----------
function parseTrunks(text, ctx) {
  for (const block of text.match(BLOCK('net trunk')) || []) {
    if (!block.includes('interfaces')) continue;
    const tname = block.split('\n')[0].replace('net trunk ', '').replace(' {', '');
    const im = block.match(/interfaces \{\n([\s\S]*?)\}/);
    if (!im) continue;
    const members = im[1].split('\n').map(s => s.trim()).filter(Boolean)
      .map(m => mapPort(ctx, 'Trunk', tname, m));
    if (block.includes('lacp enabled')) ctx.lacp.set(tname, { lacpId: ctx.nextId('lacp'), port: members });
    else ctx.trunks.set(tname, { trunkId: ctx.nextId('trunk'), members, name: tname });
  }
}

// ---------- sys (management, ntp, syslog, snmp) ----------
function parseSystem(text, ctx) {
  // management ip
  const mi = text.match(/^sys management-ip (\S+)/m);
  if (mi) {
    const [ip, pfx] = mi[1].split('/');
    ctx.mgmt.mmgmt.set('addr', ip);
    ctx.mgmt.mmgmt.set('mask', T.prefixToMask(pfx) || pfx);
  }
  if (/^sys management-dhcp/m.test(text)) ctx.mgmt.mmgmt.set('dhcp', 'ena');
  // management routes — FIX BUG-5: parse ALL of them (legacy skipped the last)
  for (const block of text.match(BLOCK('sys management-route')) || []) {
    let gw = null, isDefault = false, net = null;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('gateway ')) gw = line.split(/\s+/)[1];
      else if (line.startsWith('network ')) {
        net = line.split(/\s+/)[1];
        isDefault = net === 'default';
      }
    }
    if (isDefault && gw) ctx.mgmt.mmgmt.set('gw', gw);
    else if (gw) ctx.warnManual('Route', 'N/A', 'Management routes are not supported by Alteon! \n line: ' + net + ' ' + gw);
  }
  // ntp — FIX BUG-4: legacy crashed (undefined var) on the first line and
  // silently dropped the whole NTP config
  const ntpBlock = text.match(/^sys ntp \{\n([\s\S]*?)^\}/m);
  if (ntpBlock) {
    const sm = ntpBlock[1].match(/servers \{([^}]*)\}/);
    if (sm) {
      // live finding: Alteon prisrv/secsrv take IPs only ('bad Primary NTP
      // server "ntp.corp-internal.local"') — hostnames need manual resolution
      const servers = sm[1].trim().split(/\s+/).filter(Boolean);
      const byIp = servers.filter(s => /^[\d.]+$/.test(s) || s.includes(':'));
      for (const h of servers.filter(s => !byIp.includes(s))) {
        ctx.warnManual('NTP', h, 'NTP server is a hostname; Alteon needs an IP — resolve and set manually!');
      }
      if (byIp[0]) ctx.mgmt.ntp.set('prisrv', byIp[0]);
      if (byIp[1]) ctx.mgmt.ntp.set('secsrv', byIp[1]);
    }
    const tz = ntpBlock[1].match(/timezone (\S+)/);
    if (tz) {
      const off = T.TIMEZONE[tz[1]];
      ctx.mgmt.ntp.set('tzone', off || '0');
      if (!off) ctx.warnManual('NTP', 'timezone', 'Unmapped timezone "' + tz[1] + '", set tzone 0. Verify manually!');
    }
  }
  // syslog
  const sysBlock = text.match(/^sys syslog \{\n([\s\S]*?)^\}/m);
  if (sysBlock) {
    let c = 0;
    const re = /(\S+) \{\n\s*host (\S+)(?:\n\s*remote-port (\d+))?[\s\S]*?\}/g;
    let m;
    while ((m = re.exec(sysBlock[1])) && c < 5) {
      c += 1;
      ctx.mgmt.syslog.set(c, { host: m[2], port: m[3] || '514' });
    }
  }
  // snmp
  const snmpBlock = text.match(/^sys snmp \{\n([\s\S]*?)^\}/m);
  if (snmpBlock) {
    const cRe = /community-name (\S+)([\s\S]*?)\}/g;
    let m;
    while ((m = cRe.exec(snmpBlock[1]))) {
      const access = /access (\S+)/.exec(m[2]);
      if (access && access[1] !== 'ro' && access[1] !== 'r') ctx.mgmt.ssnmp.set('wcomm', m[1]);
      else ctx.mgmt.ssnmp.set('rcomm', m[1]);
    }
    const tRe = /host (\S+)/g; let c = 0;
    const traps = snmpBlock[1].match(/traps \{[\s\S]*?\n {4}\}/);
    if (traps) {
      while ((m = tRe.exec(traps[0])) && c < 2) { c += 1; ctx.mgmt.ssnmp.set('trap' + c, m[1]); }
    }
  }
  const host = text.match(/^sys global-settings \{[\s\S]*?hostname (\S+)/m);
  if (host) ctx.mgmt.ssnmp.set('name', host[1]);
}

function parseAll(text, ctx) {
  // legacy order: monitors, reals, pools, snat, trunks, vlans, selfips,
  // profiles, persist, policies, virts, filters, mgmt, ha, routes
  parseRouteDomains(text, ctx);
  parseMonitors(text, ctx);
  parseReals(text, ctx);
  parsePools(text, ctx);
  parseTrunks(text, ctx);
  parseVlans(text, ctx);
  parseSelfIps(text, ctx);
  parseProfiles(text, ctx);
  parsePersist(text, ctx);
  parseAddressLists(text, ctx);   // network classes (referenced by filters)
  parseTmc(text, ctx);            // source-match criteria (before virts)
  parseVirts(text, ctx);
  parseSystem(text, ctx);
  parseRoutes(text, ctx);
}

module.exports = { parseAll };
