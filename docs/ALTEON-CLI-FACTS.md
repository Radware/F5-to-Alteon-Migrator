# Alteon CLI facts - device truth for the converter

Everything here was observed on a live AlteonOS VA (34.5.7.0 and/or 34.0.12.0),
not taken from documentation. Each line carries the DELTAS.md ID with the full
evidence. Before emitting a new command, check this list; when you learn
something new on a device, add it here and in DELTAS.md.

Three failure classes matter, in increasing danger:
1. **Rejected line** - the CLI prints an error for that line. Visible in
   line-level staging, but the menu context is often lost, so following lines
   cascade into "unknown command".
2. **Apply-time refusal** - every line is accepted, then `apply` refuses the
   WHOLE configuration ("Apply not done"). Only an apply-level gate sees these.
3. **Silent no-op** - accepted, applies cleanly, does nothing. Only a
   `cur` read-back or traffic sees these. The most dangerous.

## How to find device truth

- `apropos <term>` - lists commands matching a word across all menus.
- Send `zzz` inside a menu - prints the full menu (every legal command).
- Send a command with no argument - prints its `Usage:` / current value.
- A `Usage:` reply to a line that HAD arguments means the line was refused (no "Error" is printed) - USAGE-1.
- Careful: `zzz` at a prompt that asks for an ID (e.g. `/c/slb/segment` then `zzz`) creates an object with that ID - `revert` after.
- Build the object, `apply`, then `cur` - read back what the device kept.
- Clean up with `revert` (pending) or `revert apply` (applied, unsaved). Never `save`.
- Tools: `validation/alteon-exec.js` (send a command file, may apply),
  `validation/validate4.js` (the stage + apply gate).

## Names and text

| Fact | ID |
|---|---|
| Real/group/virt/hc/nwclss IDs: max 32 chars; longer is rejected and cascades | LIVE-4, LIVE-9 |
| Descriptive `name` limits (34.0.12, quotes not counted): real / group / advhc 128, nwclss 32, VLAN 32, filter 31, segment over 128. Longer is refused with a `Usage:` line only (no "Error") | NAMELEN-1, USAGE-1 |
| IDs reject special characters ("Special characters are not allowed"): `%`, `~` ... F5 names objects `10.1.2.3%1` | PART-2 |
| Any non-ASCII byte is rejected ("Non printable characters are not allowed") | LIVE-11 |
| Cookie names in `pbind cookie` are max 20 chars | LIVE-15 |
| Virt `vname` (description) is max 128 chars ("must be less than 129 characters"); longer refuses the line. Whether the quotes count is unprobed, so the converter cuts at 126 | VNAME-1 |

## Layer 2 / Layer 3

| Fact | Class | ID |
|---|---|---|
| A new VLAN is DISABLED by default and takes its member ports' links down - always emit `ena` | silent | LIVE-20 |
| VLAN IDs 1-4090 only (F5 internal 4092-4094 are rejected) | line | LIVE-3 |
| Ports are numeric (`add 1`, not `add 1.1`) | line | BUG-7 |
| `add 1/113` is parsed as `add 1` + junk: "Port 1 added." then 'unknown command "113"' - a WRONG port applies. Never emit a non-numeric port | silent | PORTNAME-1 |
| An enabled VLAN with no ports applies ("ports empty, enabled") | - | VCMP-1 |
| Trunk refusals at apply: "Trunk group N contains no ports but is enabled", "Trunk groups 1 and 2 cannot share the same port", "Trunk group 2 contains ports with different PVIDs" | apply | VCMP-1 |
| Static route: `/c/l3/route/ip4/add <dst> <mask> <gw>` (`/c/l3/route` has no `add`) | line | BUG-6 |
| Two IP interfaces in the same subnet are refused ("IP Interfaces N and M are on the same subnet") | apply | LIVE-21 |
| Two default gateways with the same IP are refused ("Gateways 2 and 3 have the same IP address"); a gateway needs an interface in its subnet | apply | ROUTE-1 |
| A duplicate `route/ip4/add` line is tolerated | - | ROUTE-1 |
| `/c/sys/mmgmt` is rejected when the mgmt port is DHCP-managed | line (environmental) | LAB |
| One routing table per instance: identical IPs in two F5 route domains cannot share one Alteon (use per-RD split / vADCs) | apply | LIVE-17, LIVE-21 |

## Real servers and groups

| Fact | Class | ID |
|---|---|---|
| `addport 0` is rejected (must be 5-65534) - omit it for F5 port-0 members | line | LIVE-24 |
| Two reals with the same IP AND the same addport are refused ("Duplicate listening port(addport)") | apply | ADDPORT-1 |
| A group member must reference a configured real ("Real server X is not configured") | apply | SPLIT-2 |
| Real `weight` max 48 (F5 ratio clamps) | line | GAP-2 |
| An empty `health ` line opens an interactive prompt and SWALLOWS the next pasted line | line (worst kind) | LIVE-1 |
| A logexp health check that references an undefined check is refused ("Undefined health check 'Y' is used") | apply | LOGEXP-1 |
| A health check's type cannot change once defined ("already defined as HTTP") | line | staging note |
| SMTP health checks REQUIRE a username, else the whole config refuses to apply | apply | LIVE-16 |
| HTTP(S) checks have no `username`; credentials are `/http/auth basic <user> <password>` (also `ntlm2`, `ntlmssp`) | line | LIVE-23 |
| LDAP checks: `dnformat` / `bind`, no username/password commands | line | LIVE-23 |
| imap/pop3 checks reject `username` | line | LIVE-25 |
| The lab VA caps at 1024 real-server groups | line | LIVE capacity |
| A BUILT-IN health check with inherit parameters is refused on a REAL ("cannot have parameters with \"inherit\" values"): http, https, dns, ftp, pop3, smtp, imap, nntp, ldap. tcp, icmp, udp, sslh, link, arp are accepted; custom advhc objects are accepted even without `dport` (34.0.12) | apply | REAL-HC-1 |
| `radius` is NOT a built-in health check ("health check \"radius\" is not defined") | apply | REAL-HC-1 |

## Virtual servers and services

| Fact | Class | ID |
|---|---|---|
| Disable keyword is `dis`, not `disable` | line | LIVE-2 |
| Reserved ports force the application: 80 http, 21 ftp, 22 ssh, 25 smtp, 53 dns, 110 pop3, 111 sunrpc, 123 ntp, 143 imap, 389 ldap, 1812 radius-auth, 1813 radius-acc | line | LIVE-5, LIVE-14, LIVE-18, LIVE-24 |
| `protocol tcp\|udp\|stateless` exists on dns, basic-slb, ntp, radius-auth, radius-acc, ip and sunrpc services and DEFAULTS TO TCP on all of them; http/https and other app services have no protocol command | silent (UDP lost) | DNS-1 |
| Same vip:port twice: allowed for dns and basic-slb when the protocols differ; refused for ntp even with `protocol udp` ("same IP address and vport ... overlapping Source Networks") | apply | VIP-PAIR |
| Same VIP on different ports in separate virts: accepted | - | LIVE-21 |
| Max 8 services per virt; the 9th is ignored and the config still applies. The F5 tool emits one service per virt, so it is immune | silent | 8-vport note |
| `service undefined` if a virt has no destination - skip such virtuals | line | LIVE-10 |
| `pbind`/`ptmout` must be sent inside the service menu, before `/pip` | line | LIVE-19 |
| `pbind cookie` only on http/https services (`Usage: pbind clientip\|disable` elsewhere) | line | LIVE-7 |
| `pbind cookie insert "<name>"` takes no offset/length args | line | LIVE-8 |
| `pbind ssl` is ACCEPTED AND IGNORED; the keyword is `sslid`, only on SSL services without an SSL policy (SSLID-1) | silent | LIVE-22 |
| The `ldap` service has no `pbind` at all (34.5.7 and 34.0.12) | line | LDAP-1 |
| Interactive commands like `shut` stage nothing when pasted | silent | BUG-8 |
| Server certificate binding: `/c/slb/virt V/service P https/ssl/srvrcert cert <id>` (menu `ssl` has only `srvrcert`, `sslpol`, `cur`). A pending value does not show in `ssl/cur` until applied | - | SSLCERT-1 |
| `srvrcert cert <id>` for a certificate NOT in the repository refuses the WHOLE apply: "certificate key <id> must be defined" / "certificate <id> must be defined" (34.0.12) | apply | SSLCERT-1 |
| Entering `/c/slb/ssl/certs/key <id>` or `cert <id>` creates an EMPTY object; an empty key refuses the whole apply ("Unable to find a PRIVATE KEY matching ... for key <id>") | apply | SSLCERT-1 |
| Certificate IDs accept `.`, `-`, `_` (e.g. `my.cert-name_1.crt`). `/c/slb/ssl/certs/import` is interactive: component type (key, certificate, cert+key, intermca, trustca, ...), component ID, then SCP server, file, user, password | - | SSLCERT-1 |
| SSL policy chain: `intermca cert <name>` (Usage line on 34.0.12 also allows `group` or `none`) | - | SSLCERT-1 |
| An https service with an SSL policy and NO certificate applies without any error - it simply has no certificate | silent | SSLCERT-1 |
| A new SSL policy is DISABLED by default; enabling it on a service without a certificate refuses the whole apply ("both the SSL Policy and Certificate/Group must be defined") | apply | SSLPOL-1 |
| At most 47 SSL policies (34.0.12 VA): "The maximum of 47 SSL policies has been reached"; the services naming the missing ones then refuse the apply | apply | SSLPOL-1 |
| Attaching an SSL policy with `backend/ssl d` rewrites the service rport 443 to 80 (printed as a Note); setting rport again afterwards keeps it | silent | RPORT-1 |
| `ptmout` below the real servers' `tmout` (default 10) refuses the whole apply, for sslid and clientip | apply | PTMOUT-1 |
| Two syslog hosts with the same IP/port refuse the whole apply ("Configured Duplicate Syslog Server") | apply | SYSLOG-1 |
| The `ftp` service parses FTP by default (`ftpp`); it then needs `dataport 20` + `service 20 ftp-data` (same group, same pip) or the whole apply is refused. `ftpp d` = plain TCP (applies). Traffic-proven: parsing rewrites PASV and PORT through the PIP | apply | FTP-1 |
| `pbind sslid` on a service with ANY SSL policy (fessl, fessl+backend or backend only; ssl or https) refuses the whole apply ("SSL ID persistency cannot be used in conjunction with SSL Offloading"). On pass-through (no policy) it applies. With a policy the ssl service offers `pbind clientip|sslid|disable`, https adds `cookie`; clientip and cookie insert both apply | apply | SSLID-1 |
| The apply checks of a DISABLED virtual are skipped: sslid + SSL policy applies with the virtual `dis` and refuses once it is enabled. Gate an all-enabled copy (`validation/tools/enable-all.js`) | gate | SSLID-1 |
| The group of an `ip` (any-port) service needs a health check with a destination port ("must be defined with a destination port", whole apply refused): icmp, an advhc with `dport`, or a LOGEXP of such parts apply; built-in https/tcp, the default and an advhc without dport refuse | apply | IPHC-1 |
| A virtual whose VIP equals an IP interface address refuses the whole apply ("has the same IP address as IP interface N"), like a VIP on the HA floating IP (FLOATVIP-1) | apply | IFVIP-1 |

## Proxy IP / SNAT

| Fact | Class | ID |
|---|---|---|
| `pip mode egress` with an EMPTY Proxy IP table applies cleanly and does NOT NAT (one-armed traffic times out) | silent | AUTOMAP-1 |
| The device REFUSES its own interface IP as a PIP ("conflicts with the Client NAT"); a FLOATING IP is accepted and NATs correctly | apply / traffic-proven | AUTOMAP-1/2 |
| `/c/slb/pip/type vlan` + `/c/slb/pip/add <ip> <vlan>`; on 34.0.x the add is validated against the CURRENT base type, so apply `type vlan` first | line (34.0.x) | LIVE-24 |
| `pip/rem` takes the PIP ID, not the address | line | lab note |
| `pip mode nwclss` + `nwclss v4 <id> persist disable` refuses the WHOLE apply when class `<id>` is not defined ("IPv4 Network Class ID 'X' must be defined (PIP mode is set to 'network class')", 34.0.12) | apply | SNATPOOL-1 |
| A virtual on the same IP as an HA floating IP refuses the whole apply ("has the same IP address as HA floating ip id: N", 34.0.12) | apply | FLOATVIP-1 |
| A floating IP outside the subnet of its `if` refuses the whole apply ("The floating IP N should belong to the same subnet as its assigned interface", 34.0.12) | apply | FLOATSUB-1 |
| A real on the same IP as a virtual refuses the whole apply ("Real server X has the same IP address as virtual server Y", 34.0.12) | apply | REALVIP-1 |

## Filters, network classes, segments

| Fact | ID |
|---|---|
| `action allow\|deny\|redir\|nat\|monitor\|goto\|outbound-llb`; `nat source\|dest\|mcast` | WVF-1 |
| `vlan <1-4090\|any>`; `sip`/`dip` take an address OR a network class name | WVF-1, TMC-1 |
| A filter does nothing until bound: `/c/slb/port <p>` + `filt ena` + `add <id>` | WVF-1 |
| Filters are first-match by ascending ID; unmatched traffic proceeds normally (no implicit deny). TRAFFIC-PROVEN: allow (vip, vlan X) + deny (vip, any) restricts a VIP to VLAN X | VLANF-1 |
| Network class: `/c/slb/nwclss <id>` / `type address` / `network N` / `net subnet <ip> <mask> include`; filter `sip <class>` with no smask | TMC-1 |
| A segment supports only ONE associated filter (its gateway redirect); `rtsrcmac ena` for symmetric return | SEG-1 |
| `/c/slb/segment N/addvlan V` takes only an existing VLAN: on a clean device a not-yet-created VLAN is refused (`Usage: addvlan <Add a configured VLAN, 1-4090>`) and the empty segment refuses the whole apply ("Segment N does not have any vlans configured"). Declare `/c/l2/vlan V` + `ena` first. Lab trap: after earlier sessions the device ACCEPTS the line and apply fails naming a random VLAN from a previous session - stale entries that revert / revert apply do not clear; only a reboot does | SEGVLAN-1 |
| A segment redirect filter must be added to the ports of every segment VLAN (`/c/slb/port <p>/filt ena`, `add <id>`), else the whole apply is refused ("Segment N - filter F is not added to the port(s) in VLAN V") | SEGPORT-1 |
| advhc alias destination: `dest 4 <ip>` (IP version first); a bare `dest <ip>` is refused with `Usage:` | HCDEST-1 |
| Real IDs refuse `:` like other special characters ("Special characters are not allowed"); allowed set used: `[A-Za-z0-9_.-]` | REALID-1 |
| The ICMP advhc menu has no `dport` (name, dest, inter, retry, restr, timeout, downtime, invert, transp) | ICMPDPORT-1 |
| The TCP advhc is connect-only: no `tcp` submenu, no `send` / `expect` (34.0.12). Health check types list: arp dhcp dns ftp http(s) icmp imap ldap(s) nntp pop3 radius rtsp script sip smtp snmp sslhello tcp tftp udp wap wts logexp advvirtualwire extscrhc ocsp (`SCRIPTED` is not a type) | TCPSEND-1 |
| HTTP advhc `body` is a paste prompt (bare `body`, body lines, `...`); `body "x"` ignores the argument and SWALLOWS the next pasted lines (34.5.7) | BODY-1 |
| `/c/l2/vlan V/add <p>` on an UNTAGGED port asks "Confirm changing PVID from X to V [y/n]" - a pasted config feeds the next lines in as the answer (port not added, next lines lost). `/c/port <p>/pvid V` first (no prompt), then the add is prompt-free - but the port STAYS in VLAN 1 and the apply refuses "Port 1 is a member of multiple VLANs (1,40) without tagging"; `/c/l2/vlan 1/rem <p>` after the add (no prompt) fixes it (34.5.7). `/c/l2/vlan V/rem <p>` on the port's ONLY VLAN is accepted at the line but the apply refuses ("Port 2 is not in VLAN 2; its current PVID (2) needs to be changed..."); answering y to the PVID prompt of `/c/l2/vlan 1/add <p>` moves the port out of its old VLAN (34.0.12). A port already in another VLAN: `/c/l2/vlan <old>/rem <p>` first, then pvid + add, applies (34.5.7) | PVIDP-1 |
| `/c/port <p>/tag ena` ("Port N changed to tagged", no prompt); a tagged port can then be added to several VLANs without prompts; read back "VLAN tagged" (34.5.7). Port menu: pvid, alias, name, cont, nonip, egbw, rmon, tag, iponly, ena, dis, cur | VTAG-1 |
| VA capacity (34.5.7 VA): 1024 real server groups, 1024 virtual servers, 1023 virtual services per device ("Switch cannot support more than 1023 virtual services" refuses the whole apply). A fleet config above that cannot be gated whole on a VA | env |

## Layer 7 content rules (proven, not yet generated - OPEN-QUESTIONS 3)

| Fact |
|---|
| Content class path is stored WITHOUT the leading slash - `/appb` silently matches the wrong requests |
| The prefix match keyword is `prefx` (`prefix` is rejected and the class stays `include` = substring) |
| Matching is case-INSENSITIVE by default; F5 `starts-with` needs `case ena` |

## Platform gaps (nothing to build)

| Fact | ID |
|---|---|
| Per-VIP ARP / route-advertisement (F5 `ltm virtual-address`) has no CLI surface | OPEN-QUESTIONS 4 |
| F5 stores monitor passwords encrypted (`$M$...`): credentials can never be carried over | LIVE-23 |

## Lab-environment classes (NOT converter bugs)

When classifying a validation report, these are environmental on the 2-port lab VA:
- `bad port "50"/"60"/"90"/"100"` and the menu cascade after it (`client ena`,
  `server ena`, `proxy ena`, `filt ena`, `add <filter>`): the source chassis
  has ports the VA does not.
- `unknown command "adminkey"` after a LACP port that does not exist.
- APPLY: `Trunk group N contains no ports but is enabled.` when every trunk
  member was a `bad port` on the VA (the trunk is valid on the real chassis).
  Confirm the trunk's `add` lines all failed as `bad port` before classifying.
- `Management port cannot be set manually when DHCP client is enabled` (34.0.12).
- A health check "already defined as ..." when several per-RD files are staged
  in one session (in production each file goes to a separate instance).
- A garbled first line from a UTF-8 BOM added by a concatenation script.
