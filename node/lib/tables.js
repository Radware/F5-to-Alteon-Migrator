'use strict';
// Mapping tables ported from the legacy global_variables.py (which contained
// every table twice -- the file was duplicated wholesale; deduplicated here).

// F5 load-balancing-mode -> Alteon group metric.
// LEGACY BUG (fixed here): the old table only mapped the two least-connections
// modes; every other F5 mode (incl. an explicit "round-robin") passed through
// verbatim, producing invalid Alteon CLI like "metric round-robin".
// Alteon metrics (CLI guide 34.5.7): roundrobin | leastconns | minmisses |
// hash | phash | response | bandwidth | svcleast.
const METRIC = {
  'round-robin': 'roundrobin',
  'ratio-member': 'roundrobin',        // approximation; weights are carried on reals
  'ratio-node': 'roundrobin',
  'least-connections-node': 'leastconns',
  'least-connections-member': 'leastconns',
  'weighted-least-connections-member': 'leastconns',
  'weighted-least-connections-node': 'leastconns',
  'fastest-node': 'response',
  'fastest-app-response': 'response',
  'observed-member': 'leastconns',
  'observed-node': 'leastconns',
  'predictive-member': 'leastconns',
  'predictive-node': 'leastconns',
  'least-sessions': 'leastconns',
  'dynamic-ratio-member': 'leastconns',
  'dynamic-ratio-node': 'leastconns'
};

// F5 monitor type -> Alteon advanced health check type
const ADVHC = {
  'none': 'NoCheck', 'dns': 'dns', 'ftp': 'ftp', 'http': 'http', 'https': 'https',
  'gateway-icmp': 'icmp', 'gateway_icmp': 'icmp', 'icmp': 'icmp', 'imap': 'imap',
  'ldap': 'ldap', 'logexp': 'logexp', 'pop3': 'pop3', 'radius': 'radius',
  'radius_accounting': 'radius', 'radius-accounting': 'radius', 'sip': 'sip',
  'smtp': 'smtp', 'snmp_dca': 'snmp', 'snmp_dca_base': 'snmp', 'tcp': 'tcp',
  'tcp_echo': 'tcp', 'tcp-half-open': 'tcp', 'udp': 'udp', 'real_server': 'snmp',
  'wmi': 'snmp'
};

// default (built-in) F5 profiles -> type
const DEF_PROF = {
  'http': 'http', 'serverssl': 'server-ssl', 'clientssl': 'client-ssl',
  'serverssl-insecure-compatible': 'server-ssl',
  'clientssl-secure': 'client-ssl', 'clientssl-insecure-compatible': 'client-ssl',
  'one-connect': 'one-connect', 'oneconnect': 'one-connect',
  'tcp-lan-optimized': 'tcp', 'tcp-wan-optimized': 'tcp', 'tcp': 'tcp',
  'f5-tcp-lan': 'tcp', 'f5-tcp-wan': 'tcp', 'f5-tcp-progressive': 'tcp',
  'f5-tcp-mobile': 'tcp', 'tcp-mobile-optimized': 'tcp',
  'fastL4': '', 'mptcp-mobile-optimized': '', 'udp': 'udp',
  'apm-forwarding-fastL4': '', 'security-fastL4': '', 'fastl4-route-friendly': '',
  'ipother': '', 'udp_gtm_dns': 'udp'
};

// built-in F5 profiles with NO Alteon equivalent: the service converts without
// them; emit one concise manual-check diagnostic instead of "not found".
const NOEQUIV_PROF = new Set([
  'websecurity', 'stream', 'ntlm', 'rewrite-uri-translation',
  'optimized-caching', 'wan-optimized-compression', 'webacceleration',
  'httpcompression', 'ftp'
]);

// built-in F5 monitor names -> Alteon built-in health check names
const BUILTIN_HC = {
  'gateway_icmp': 'icmp', 'gateway-icmp': 'icmp',
  'tcp_half_open': 'tcp', 'tcp-half-open': 'tcp', 'tcp_echo': 'tcp'
};

const DEF_PERSIST = {
  'cookie': { type: 'cookie', timeout: '10' },
  'source_addr': { type: 'clientip', timeout: '10' }
};

const DEFAULT_ADVHC = {
  'https_443': { name: '"https_443"', hcType: 'http', dport: '443', ssl: 'ena',
    inter: '5', retry: '3', timeout: '5', advtype: {} },
  'http_head_f5': { name: '"http_head_f5"', hcType: 'http',
    inter: '5', retry: '3', timeout: '5', advtype: { method: 'HEAD', path: '"/"' } },
  'https_head_f5': { name: '"https_head_f5"', hcType: 'http', ssl: 'ena',
    inter: '5', retry: '3', timeout: '5', advtype: { method: 'HEAD', path: '"/"' } }
};

// F5 named service ports (subset; extend as needed)
const DPORT = {
  'http': '80', 'https': '443', 'ssh': '22', 'telnet': '23', 'smtp': '25',
  'domain': '53', 'dns': '53', 'ftp': '21', 'pop3': '110', 'imap': '143',
  'ldap': '389', 'ldaps': '636', 'radius': '1812', 'snmp': '161', 'ntp': '123',
  'mysql': '3306', 'rdp': '3389', 'sip': '5060', 'any': '0'
};

function prefixToMask(prefix) {
  const p = parseInt(prefix, 10);
  if (isNaN(p) || p < 0 || p > 32) return null;
  const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return [m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join('.');
}

// F5 tz name -> UTC offset (legacy table style: '-04:00'); subset + fallback
const TIMEZONE = {
  'America/New_York': '-04:00', 'America/Chicago': '-05:00',
  'America/Denver': '-06:00', 'America/Los_Angeles': '-07:00',
  'Europe/London': '+01:00', 'Europe/Paris': '+02:00', 'Europe/Berlin': '+02:00',
  'Asia/Jerusalem': '+03:00', 'Asia/Tokyo': '+09:00', 'Australia/Sydney': '+10:00',
  'UTC': '+00:00', 'Etc/UTC': '+00:00'
};

module.exports = { METRIC, ADVHC, DEF_PROF, NOEQUIV_PROF, BUILTIN_HC, DEF_PERSIST, DEFAULT_ADVHC, DPORT, prefixToMask, TIMEZONE };
