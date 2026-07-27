# Roadmap - what to build next

Proposed after converting 39 real production devices (2 banking fleets, 1 telco
fleet, plus a live BIG-IP 17.5 we deployed ourselves) and taking a census of
every tmsh construct those configs contain. Counts below are **from the real
customer configs**, not estimates - they are why each item is ranked where it
is. iRule-to-AppShape++ translation is deliberately excluded.

Every item ships under the standing rule: **no capability is claimed until it
has been applied on a live Alteon and observed doing what it should.**

---

## Tier 1 - status after the 2026-07-27 device-validation pass

Everything below was decided **on the appliance**, not from documentation or
assumption: each construct was probed with `apropos` and the CLI's own usage
strings, then built, applied and read back on live 34.5.7.

| # | Capability | Status |
|---|---|---|
| 1.1 | **Source-match forwarding virtuals** to filters matching a source **network class** | **DONE - live-validated** with a real customer config (see TMC-1 in DELTAS.md). 6 filters + their classes applied on the device; `filt cur` confirms `sip <class>`. |
| 1.2 | **`net address-list` to network classes** | **DONE - live-validated** (same run). Exact element syntax `net subnet <ip> <mask> include` was found by probing; the first three guesses were rejected by the device. |
| 1.3 | **SSL persistence** (`ltm persistence ssl`) | **DONE - and it turned out to be a silent-failure BUG**, not a new feature: the tool emitted `pbind ssl`, which the CLI accepts while doing nothing. Correct keyword is `pbind sslid`, valid only on SSL-terminating services (LIVE-22). |
| 1.4 | **DNS monitors** to Alteon DNS health checks | **NOT DONE - partially proven.** `/c/slb/advhc/health <id> DNS` exists with `dns`/`protocol`/`dport`/`dest`/`inter`/`retry`/`restr`/`timeout` and a `domain` parameter. The mapping of F5's `qname`/`qtype`/`recv` onto those fields has **not** been validated, so nothing is emitted yet - the monitor still falls back with a diagnostic. |
| 1.5 | **Standalone SNAT / snat-translation** to NAT filters | **NOT DONE - partially proven.** Filters do support NAT (`action allow\|deny\|redir\|nat\|monitor\|goto\|outbound-llb`, `nat source\|dest\|mcast`), but F5 standalone `ltm snat` semantics (which origins get translated to which address, and the return path) were not proven equivalent, so nothing is emitted. |
| 1.6 | **VIP advertisement attributes** (`ltm virtual-address`) | **REJECTED - no Alteon equivalent.** `apropos advertise` returns nothing and `apropos arp` returns only `/stats/l3/arp`: there is no configuration surface for per-VIP ARP or route advertisement on this version. Converting these attributes would mean inventing behavior, so they stay unconverted. |

**Rule applied throughout:** if the device could not demonstrate the same
behavior the F5 had, the tool does not emit a line for it. A missing conversion
with a clear diagnostic is always preferable to a plausible-looking one.

## Tier 2 - High value, well-defined (1-3 weeks each)

| # | Capability | Seen in configs | Notes |
|---|---|---|---|
| 2.1 | **LTM policies to content rules** (host/path routing, redirects, pool selection) | 94 policies | Most are simple host/URI to pool routing, which maps to Alteon content-based server selection. Ship the mappable subset, diagnose the rest. **Highest customer-visible value in this tier.** |
| 2.2 | **SSL profile deep mapping** - cipher rules/groups, TLS version bounds, SNI, client-cert auth, OCSP | 347 client-ssl + 172 server-ssl + 46 cipher objects | Today we emit a basic SSL policy. This makes migrated HTTPS services behave like the source without hand-tuning. |
| 2.3 | **Certificate and key migration plan** - inventory every cert/key a virtual actually references, emit the import checklist and `/c/slb/ssl` scaffolding | 755 certs / 608 keys present (the referenced subset is far smaller) | Key material must move out-of-band; the tool produces the exact plan so nothing is missed at cutover. |
| 2.4 | **AFM firewall rules to Alteon filters** (`security firewall rule-list` + address/port lists) | 108 rule-lists | Same filter engine; needs an ordering/priority model. |
| 2.5 | **GTM / GSLB to Alteon GSLB** | 61 wideips, 85 GTM pools, 49 servers (telco) + 2 dedicated GTM devices in the bank fleet | wideip to GSLB rule, GTM pool to remote real, server/datacenter to site. Self-contained and high value for DNS-heavy customers. |

## Tier 3 - Platform and topology (bigger bets)

| # | Capability | Seen in configs | Notes |
|---|---|---|---|
| 3.1 | **Dynamic routing (BGP/OSPF)** - parse the ZebOS config already inside the qkview and emit `/c/l3/bgp` / OSPF | Telco runs BGP per route domain; routing bundle licensed on the bank fleet too | Closes the last gap for the segmentation deployments we now support: today the segments are right but the routing is manual. |
| 3.2 | **Partitions to per-instance splits** | 32 partitions (2 devices carry `config/partitions/*/bigip.conf`) | Reuses the route-domain split machinery; also requires reading partition configs from the archive (detected today, not parsed). |
| 3.3 | **vCMP guest inventory to Alteon VX/vADC sizing plan** | 32 guests across 15 host devices | Turns today's near-empty conversions of vCMP *hosts* into a deliverable: which vADCs to create, with what resources. |
| 3.4 | **HA pair awareness** - detect the F5 device-group / peer self-IPs and emit a matching Alteon HA (VRRP) config instead of flagging the peer self-IP | Every production pair in all three fleets | Follow-on to LIVE-21: we now flag the peer self-IP; the next step is generating the second unit's config and the sync/failover settings. |

## Tier 4 - Product quality (continuous)

- **Migration report (HTML/DOCX)** per device: what converted, what needs work,
  with the original F5 stanza - a customer-ready deliverable generated straight
  from the conversion instead of hand-written.
- **Pre-flight capacity check**: compare object counts against the target
  Alteon platform limits (we already hit the 1024-group ceiling on one device)
  and warn at conversion time, per model.
- **Apply-and-verify mode**: optional SSH push of the generated config to a
  target Alteon with automatic revert on error (the validation harness already
  does exactly this internally - productize it).
- **Post-migration diff**: re-read the Alteon after apply and diff against the
  intended config, so cutover has an objective sign-off.

## Explicitly NOT planned

- **iRules to AppShape++** (643 definitions across the fleets) - excluded by
  direction; the tool keeps inventorying them with attachment points.
- **APM access policies** (410 policy items) and **ASM/AWF policies** (97) -
  different products on both sides. The right deliverable is an inventory
  report for the security team, not a CLI conversion.

## Suggested order

1.2 -> 1.1 -> 1.3/1.4/1.5/1.6 (one release, closes most "manual" noise)
-> 2.1 -> 2.2 + 2.3 (makes HTTPS migrations turnkey)
-> 2.5 or 3.1 (customer-driven: DNS-heavy vs routing-heavy)
-> 3.4 (HA) -> 4.x continuously.
