# Roadmap - what to build next

Proposed after converting 39 real production devices (2 banking fleets, 1 telco
fleet, plus a live BIG-IP 17.5 we deployed ourselves) and taking a census of
every tmsh construct those configs contain. Counts below are **from the real
customer configs**, not estimates - they are why each item is ranked where it
is. iRule-to-AppShape++ translation is deliberately excluded.

Every item ships under the standing rule: **no capability is claimed until it
has been applied on a live Alteon and observed doing what it should.**

---

## Tier 1 - Quick wins (days each, reuse machinery we already have)

| # | Capability | Seen in configs | Why it is cheap |
|---|---|---|---|
| 1.1 | **Source-match forwarding virtuals** (`traffic-matching-criteria` + `address-list`) to filters with source matching | 29 virtuals (12 at the telco alone) | The wildcard-to-filter engine already exists; this adds a source network class. Closes the largest remaining "manual" class for the telco. |
| 1.2 | **Address/port lists to network classes** (`net address-list`, `net port-list`, `ltm data-group internal`) | 49 + 80 + 109 | Same nwclss renderer used for SNAT pools. Prerequisite for 1.1 and 3.2. |
| 1.3 | **SSL persistence** (`ltm persistence ssl`) to `pbind sslid` | 12 | One table entry in the persistence mapper. |
| 1.4 | **DNS monitors** to Alteon DNS health checks | 12 | One entry in the monitor table. |
| 1.5 | **Standalone SNAT / snat-translation** objects to NAT filters | 13 + 273 | Filter renderer exists; only the object mapping is new. |
| 1.6 | **VIP advertisement attributes** (`ltm virtual-address`: ARP, route-advertisement, traffic-group) | 937 | Parse and attach to the virt; today these attributes are dropped silently. |

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
