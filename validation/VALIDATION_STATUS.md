# Live validation - status

## Round 1 (Phase 3a): synthetic sample01 - PASSED on both versions

The generated Alteon config (`sample01_alteon_config.txt`, 105 lines) was
streamed into both lab appliances and applied with **zero errors**, then fully
reverted.

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.0.12.0 | 10.210.240.152 | 0 errors | `results/report_34_0_12_0.json` |
| 34.5.7.0  | 10.210.240.137 | 0 errors | `results/report_34_5_7_0.json` |

Round 1 surfaced **BUG-6** (static-route syntax) and **BUG-7** (numeric VLAN
ports) - fixed and re-validated (see `../DELTAS.md`).

## Round 2 (Phase 3b, 2026-07-05): real-config constructs - PASSED on both versions

`fixtures/newconstructs/bigip.conf` (synthetic, exercising every construct the
real BIG-IP exports introduced: weight, forced-offline/drain reals, maxcon,
LOGEXP OR, built-in monitor aliases, HEAD monitors, SSL policy):

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.5.7.0  | 10.210.240.137 | **0 errors**, every object staged (verified via `diff`) | `results/report_newconstructs_34_5_7_0.json` |
| 34.0.12.0 | 10.210.240.152 | **0 errors** | (scratch run; same output byte-for-byte) |

## Round 3 (Phase 3b, 2026-07-05): FULL real production configs

Complete converted configs from two real BIG-IP 17.1.2 production units were
streamed into the live devices - fleet-A (~717 lines, 27 virtuals) on 34.5.7.0
and ltm1 (~1145 lines, 39 virtuals) on 34.0.12.0. Findings drove converter
fixes **LIVE-1..LIVE-7** (empty `health`, `disable`→`dis`, VLAN >4090,
nwclss >32 chars, reserved port/application pairs, vCMP port mapping
diagnostics, cookie persistence on non-HTTP services) - all unit-tested.

> The raw reports/transcripts for these runs contain customer object names,
> internal IPs and the full config, so they are **deliberately NOT committed**
> (kept on Sean's machine in the session scratchpad). Only this summary and
> the synthetic-fixture reports live in the repo.

After the fixes, **every remaining rejected line is environmental** - i.e.
expected on these lab VAs and not a converter defect:

| Remaining error | Why it is environmental |
|-----------------|-------------------------|
| `License for Cookie persistence is not installed/enabled` | Lab VAs have no cookie-persistence license; `pbind cookie insert …` is correct syntax on licensed units |
| `Management port cannot be set manually when DHCP client is enabled` | Both lab VAs manage `mmgmt` via DHCP |
| `bad port "3"/"4"/"70"/"80"` (+ cascaded `adminkey`) | The source F5s are multi-slot vCMP hosts; the 2-port lab VA physically lacks those ports. The converter now emits a port-mapping diagnostic (LIVE-6) telling the engineer to re-map ports to the target chassis |

## Round 4 (Phase 3b, 2026-07-07): config EXPORTED FROM A REAL BIG-IP

`fixtures/sample02-azure` - exported from the live BIG-IP VE 17.5.1 deployed
in Azure (`rg-f5a-lab`), whose behavior was baselined first with the
round-trip probe (2:1 weighted distribution, RDWRLAB cookie persistence,
health eject/restore, TLS termination - all pass, see LAB.md).

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.5.7.0 | 10.210.240.137 | **0 converter errors** (only the 2 known license-environment rejects: `pbind cookie` needs the cookie-persistence license, absent on the lab VA) | `results/report_sample02_34_5_7_0.json` |

With the cookie-persistence license installed (2026-07-08) the same config
also staged with **0 errors on 34.0.12.0**
(`results/report_sample02_34_0_12_0.json`), after the license exposed and we
fixed LIVE-8 (`pbind cookie insert` argument bug present in the legacy tool).

## Round 5 (Phase 3b, 2026-07-08): BEHAVIORAL ROUND-TRIP - **ALL PARITY CHECKS PASSED**

The sample02 config was applied (apply only, never saved) on live Alteon
**34.5.7.0** with lab backends (`backend.py` web1/web2 on 10.210.240.158/.203),
VIP 10.210.240.210, PIP 10.210.240.211, and probed with the same scenarios and
parameters as the source F5 in Azure:

| Scenario | F5 BIG-IP VE 17.5.1 | Migrated Alteon 34.5.7.0 | Verdict |
|----------|--------------------|--------------------------|---------|
| Weighted distribution (ratio 2:1, 60 req) | web1:40 / web2:20, 0 errors | web1:40 / web2:20, 0 errors | **PASS - 0.0% delta** |
| Cookie persistence (RDWRLAB) | 20/20 stuck | 20/20 stuck | **PASS** |
| Health-check reaction (backend down→up) | eject + restore, 0 errors | eject + restore, 0 errors | **PASS** |
| TLS termination | baselined (2:1, sticky, health pass) | not run (needs a cert created on the Alteon - manual step, see MIGRATION_GUIDE) | partial |

Reports + verdict: `results/roundtrip/`. Field notes: the first VIP choice
collided with an existing lab VM (ping-scans over VPN give false negatives -
scan from inside the L2), and the F5's SNAT automap became an explicit Alteon
PIP (the converter's log2 diagnostic covers exactly this decision).

**ROADMAP Phase 3b definition of done is met**: a config exported from a real
BIG-IP converts, applies with zero errors on both target Alteon versions, and
the migrated device behaves identically to the source F5 for live traffic.

## Round 6 (2026-07-09): PER-FEATURE behavioral validation on live Alteon - ALL TRAFFIC TESTS PASS

Requirement (Sean): a conversion counts as SUPPORTED only when the construct
was applied on a live Alteon and observed doing what it is supposed to do.
Executed on 34.5.7.0 with four identifiable backends and live traffic:

| Converted construct | Traffic proof | Verdict |
|---------------------|---------------|---------|
| virt/service (http application) | VIP serves, backends respond via LB | **PASS** |
| ratio → real weight | 30 req → exactly 20:10 (2:1) | **PASS** |
| round-robin group | split across members | **PASS** |
| cookie persistence (`pbind cookie insert`) | 20/20 requests stuck via RDWRLAB cookie | **PASS** |
| clientip persistence (`pbind clientip`+`ptmout`) | one client → one backend, 20/20 | **PASS** |
| custom HTTP monitor (send/recv strings) | member ejected on /health 503, restored on 200, zero client errors | **PASS** |
| `min 1 of {...}` → LOGEXP OR | HTTP submonitor down + ICMP up → member correctly KEPT in service | **PASS** |
| priority-group → backup group | primary down → backup real took 100%; restore verified | **PASS** |
| `state user-down`/drain → `dis` | disabled real (live backend!) received 0 of 30 requests | **PASS** |
| SNAT pool → PIP (`pip mode address`) | backend sees source = PIP 10.210.240.211 | **PASS** |
| XFF insertion (`/http/xforward ena`) | backend received `X-Forwarded-For: <true client IP>` | **PASS** |
| maxcon | applied & verified in config (limit not saturable with a sequential prober) | applied-only |
| SSL policy / TLS termination | F5 side traffic-baselined; Alteon side stages cleanly but needs a certificate installed manually before traffic | applied-only |

New defect found BY the apply (invisible to staging): **LIVE-16** - F5 `smtp`
monitors without a username convert to Alteon SMTP checks that **block the
entire apply** ("Username value is missing"). Now converted as TCP checks with
a diagnostic.

Operational note: interrupted validator runs leave pending config on the
device; a later `apply` then validates THOSE leftovers too. validate3/alteon-exec
begin with `revert` for exactly this reason.

## Round 7 (2026-07-10/12): 33-device fleet batch + telco customer route-domain set - ZERO remaining converter defects

**Fleet batch** - all 33 real production devices (two LatAm banking production fleets: VIPRION,
vCMP hosts/guests, GTM-DMZ, WAF, link controllers, 17.1-17.5) staged on both
Alteons, 54,500 lines streamed, every config to completion. Findings drove
LIVE-15..19 (cookie-name 20-char limit, `_` not `~` rename suffix, session
resync, radius/pop3 reserved ports, **persistence-before-pip ordering**) - all
fixed + regression-tested. After fixes, every remaining rejected line is
environmental:

| Class | Example | Nature |
|-------|---------|--------|
| Platform capacity | agg008: group #1025 refused ("maximum of 1024 Real Server Groups") - the box has 1,649 pools | target sizing; the converter now warns at conversion time when >1024 groups |
| Physical ports | vCMP/chassis interfaces 2.1/3.0/5.0/11.0 → ports absent on the 2-port lab VA | target sizing; every mapping is flagged |
| DHCP mgmt port | `/c/sys/mmgmt addr` rejected | lab quirk |
| Cookie persistence | **0 errors - licensed and passing** (incl. LIVE-8/15 syntax) | resolved |

**Telco route-domain set** (heavy route domains, redacted addresses) - all outputs incl.
every per-route-domain split file staged cleanly; remaining rejects = the
customer's `x.x` redaction placeholders (pre-flagged by the converter),
physical ports, DHCP mgmt. LIVE-18 (radius ports) found and fixed here.

## Round 8 (2026-07-22): NETWORK SEGMENTATION - FULL CROSS-SEGMENT TRAFFIC PROOF on live 34.0.12

Two-route-domain F5 fixture (`fixtures/seglab/`) converted in auto (segment)
mode and applied on 10.210.240.152; backend VM dual-homed into both segments
(ens192 = VLAN 10 / segment 1, ens224 = VLAN 20 / segment 2). Three proofs, all
at packet level:

1. **Segment-classified VIP serves traffic** - routed corporate client (192.168.44.x,
   3 router hops) → `vs_seg1` (VIP 10.210.240.211, `segment 1`, `rtsrcmac ena`)
   → real 10.210.240.158:8080 → `OK seg1web` 3/3. (Needed a manual service PIP,
   exactly as the converter's SNAT-automap diagnostic instructs - the backend's
   default gw is not the Alteon.)
2. **Cross-segment redirect filter works** - segment-2 client packet to an
   out-of-segment destination (8.8.8.8) entered port 2 and came back ~150 µs
   later from the Alteon's port-2 MAC toward the segment-2 gateway group:
   converter-generated `filt 1810` redirecting, MAC-level tcpdump proof.
3. **Segment isolation holds** - a segment-2 client's SYN to the segment-1 VIP
   was NOT served (curl timeout); tcpdump shows every SYN bounced to the
   segment-2 gateway instead. Matches F5 route-domain isolation semantics.

Two converter defects found by this round (both fixed + regression-locked):
**LIVE-20** - VLANs rendered without `ena`; a new Alteon VLAN is disabled by
default and silently takes its member ports' links down (legacy tool had the
same bug - it shipped in every VLAN-creating conversion ever made with it).
**SEG-2** - RD-scoped routes (`network default%N`, the form tmsh actually
writes) were dropped, leaving segments without their redirect-filter gateway.

Lab note: 10.210.240.137's data links are down for the same pre-fix reason
(disabled VLANs 110/120 from the earlier segment demo, unsaved) - a reboot
restores its saved config and clears it. .152 carries the (unsaved) round-8
config.

## Round 9 (2026-07-27): Tier-1 constructs - device-driven discovery, 3 of 6 shipped

Standing instruction for this round: **do not invent anything.** Every mapping
had to be demonstrated on the appliance, and any construct that could not be
proven equivalent to the F5 behavior would ship as a diagnostic instead of a
conversion. Target: live Alteon 34.5.7.0.

### Method

Syntax was discovered from the device, never from memory or documentation:

1. `apropos <term>` - the CLI's own command search - to find whether a
   configuration surface exists at all.
2. Deliberate invalid values (`pbind ZZZINVALID`) to make the CLI print its
   **own usage string**, which is authoritative for accepted keywords.
3. Build the object, `apply`, then read it back with `cur` and confirm the
   device reports the intended relationships.
4. Finally: convert a **real customer config** through the tool and apply the
   tool's own output.

### Shipped (proven)

| Construct | Evidence |
|---|---|
| `net address-list` -> `/c/slb/nwclss` | The element syntax took four attempts; the device rejected `net <ip> <mask>` ("Invalid zero netmask"), `net <ip>/<prefix>` and `net host ...` ("Invalid network type"), and `net subnet <ip> <mask>` ("Invalid **match** type") before accepting **`net subnet <ip> <mask> include`**. Applied from a real customer config: class created with all 10 addresses, each `match include`. |
| `traffic-matching-criteria` virtual -> filter with `sip <class>` | The filter menu itself documents `sip - Set source IP address **or network class**`. Applied live: `Current filter 1040: enabled, sip Inside_ESA-Ties, dip any, proto any, action allow`, and the class reports "is associated to the following filter". 6 such filters generated from one real device config. |
| SSL persistence -> `pbind sslid` | See LIVE-22: `pbind ssl` is accepted by the CLI and **silently does nothing** (mode stays `disabled`). `pbind sslid` applied and `cur` reported `pbind sslid ... ptmout 30 mins`. Valid only on SSL-terminating services - an http service's usage string offers `clientip\|cookie\|disable` only. |

### Not shipped - proven partially, mapping unproven

**DNS monitors.** `/c/slb/advhc/health <id> DNS` exists and opens a DNS health
check menu with `dns` (parameters), `protocol` (TCP/UDP), `dport`, `dest`,
`inter`, `retry`, `restr`, `timeout`, plus a `domain` parameter at the advhc
level. What is **not** established: how F5's `qname`, `qtype` and `recv`
(expected answer) map onto those fields, and whether a mismatch of `recv`
semantics would silently change health behavior. Nothing is emitted; the
monitor keeps its existing fallback + diagnostic.

**Standalone SNAT (`ltm snat` / `snat-translation`).** Alteon filters do
support NAT - `action allow|deny|redir|nat|monitor|goto|outbound-llb` and
`nat source|dest|mcast`. What is **not** established: the equivalence of F5
standalone SNAT semantics (which origin addresses get translated to which
address, and the reverse-path behavior) to a filter-based NAT, which affects
traffic correctness rather than just syntax. Nothing is emitted.

### Rejected - no equivalent exists on the platform

**`ltm virtual-address` attributes** (per-VIP ARP, route advertisement).
`apropos advertise` returns **no commands at all**; `apropos arp` returns only
`/stats/l3/arp`. There is no configuration surface for these on 34.5.7, so no
tool could migrate them. They remain unconverted by design.

### Note on the real-config apply run

Applying the tool's own output from a real customer device produced
`Error: bad port "30"` / `"50"` and cascading `unknown command client/server`
lines. These are the long-standing **environmental** limit (LIVE-6): that F5
uses chassis ports 30/50 which do not exist on a 2-port lab VA, so the port
bindings cannot apply there. The network classes and filters themselves applied
and verified correctly.

## Round 10 (2026-07-29): SNAT Automap -> pip mode egress (field request, traffic-proven)

A partner testing against a prospect's config (18/18 virtuals on SNAT Automap)
asked for automatic conversion to "rtsrcmac or pip mode egress". The two
suggestions have different semantics, so the device decided:

- `pip mode egress` EXISTS (`mode [disable|ingress|egress|address|nwclss]`)
  and, **combined with a per-VLAN Proxy IP** (`/c/slb/pip/type vlan` +
  `add <free-IP> <vlan>`), reproduces automap's data plane exactly: the
  client-echo backend reported `CLIENT-SEEN-BY-BACKEND=<PIP>` and the
  one-armed return path worked.
- **Trap proven:** `pip mode egress` with an empty PIP table does NOT NAT -
  traffic times out. So the conversion emits the mode AND a REQUIRED-companion
  diagnostic quoting the exact PIP-table commands; a free IP cannot be
  invented by a converter.
- `rtsrcmac` is a no-NAT alternative (servers keep seeing real client IPs);
  it is offered in the diagnostic, not silently substituted.

Follow-up (same day, after Sean asked "doesn't the F5 config provide the
IP?") - it does, and the device decided which of them Alteon can reuse:

- The device REFUSES its own interface IP as PIP ("The IP Address of
  Interface 1 conflicts with the Client NAT") - F5's self-IP sharing does not
  exist on Alteon.
- The FLOATING self-IP IS accepted as PIP and NATs correctly under traffic
  (backend saw CLIENT-SEEN-BY-BACKEND=<float-IP>) - the exact address F5
  automap prefers. The converter now fills the PIP table from the config's
  floats automatically (per VLAN, per RD split); only float-less configs keep
  the REQUIRED free-IP warning.

The prospect's actual qkview now converts with 14 egress-pip services, the
PIP table generated from its two floating self-IPs, and the generated config
staged non-destructively on the lab device. 86 regression tests.

## Round 11 (2026-08-11): PARTITIONS included (field report) - three defects fixed, gated on live staging

A user reported the tool "reads the Common partition and nothing more": their
device kept 6 of its 9 route domains inside config/partitions/*/bigip*.conf.
Verified against their qkview, then fixed and validated:

1. **Partitions now convert** (PART-1): partition configs extracted, objects
   prefixed per partition (CORP_...), partition RDs feed split/segmentation.
   Their device: 18 -> 203 virtuals, 2 -> 8 per-RD outputs.
2. **Staging the result found two more defects** that unit tests could not:
   - PART-2: partition nodes NAMED by RD-scoped address put "%" into Alteon
     IDs -> 60x "Special characters are not allowed" + cascades.
   - LIVE-23: authenticated http/https/ldap monitors emitted a "username"
     line the device rejects; F5 stores those passwords encrypted, so the
     checks fall back to TCP with the device-verified auth recipe in the log
     (HTTP(S): /http/auth basic user password; LDAP: dnformat/bind).
3. **False-pass caught and discarded**: one staging run reported 0 errors
   while SENT=0 - the device's connection protection had refused the session
   (two 2,100-line stagings back-to-back). The run was repeated after an
   18-minute quiet window; reports now always show SENT/UNSENT.

Final gate on live 34.0.12: 2,061/2,061 lines SENT, 21 errors, every one in
the four known environmental classes (chassis ports 50/60/90/100 absent on
the 2-port lab VA + cascaded adminkey, DHCP-managed mgmt port). Zero
converter defects. 88 regression tests.

## Round 12 (2026-08-11): two field reports -> six defects + one traffic-proven feature

A user reported the DNS tcp/udp pair bug ("same DNS TCP setting" at apply)
and an SE asked whether F5 "vlans-enabled" can be expressed with filters.
Working both surfaced far more:

1. **DNS-1** - F5 `ip-protocol` was ignored on regular virtuals. Device
   truth: EVERY protocol-capable virt service defaults to TCP (dns,
   basic-slb, ntp, radius-auth, radius-acc, ip, sunrpc all answer "Current
   protocol: tcp"); http(s) and the app services have no protocol command.
   The field error was reproduced live and resolved by "protocol udp" on one
   of the pair (apply completed). 26 UDP listeners across the two field
   devices were previously emitted TCP-only.
2. **PART-3** - the partition prefix leaked into vip addresses (302 + 385
   virtuals!). Round 11's gate missed it: only the MAIN file was staged
   then; the per-RD files hold all partition virtuals. Gate widened to
   EVERY output file, permanently.
3. **PART-4** - folder-nested partition objects collided on their leaf name
   (both devices lost one partition's mail stack, silently).
4. **COLL-1** - same-kind same-short-name from two paths merged (a real
   folder-vs-root LDAP monitor pair + seven self-IPs literally named
   "<ip>%<rd>/24" that collapsed onto "24": device A had silently lost 22
   of its 34 interfaces).
5. **LIVE-24** - port 111 is reserved for sunrpc (map extended); a port-0
   member emitted "addport 0" which the device rejects (now omitted);
   34.0.12 validates pip adds against the CURRENT base type (version note
   added to the automap diagnostic).
6. **LIVE-25 / LDAP-1** - imap/pop3 monitor credentials have no Alteon
   commands (fall back to TCP like LIVE-23; smtp KEEPS username - the
   device requires it); the ldap virt service has NO pbind on BOTH 34.5.7
   and 34.0.12 - persistence there is now omitted with a diagnostic.
7. **VLANF-1 (feature)** - F5 "vlans-enabled" converted to a filter pair
   per VIP (allow per listed VLAN + deny elsewhere, IDs 200-989, bound to
   all VLAN member ports). TRAFFIC-PROVEN on live 34.0.12 before shipping:
   baseline VIP answered from BOTH VLANs; with filters it answered from the
   allowed VLAN, timed out from the other, and an unrestricted control VIP
   on the same filter-enabled ports stayed reachable throughout. 328 + 205
   virtuals across the two field devices use this construct.

Net effect on the field devices: device A 321 -> 379 virtuals, 12 -> 34
interfaces; device B 203 -> 249 virtuals; plus 110/71 allow + 109/69 deny
VLAN-restriction filters.

Gate history this round: full-file staging (main + every per-RD file) ran
THREE times - (1) pre-COLL-1 bits on both devices (found LIVE-24/25/LDAP-1),
(2) killed once mid-run when PART-4 landed (stale bits), (3) FINAL gate on
the exact v0.9.0 bits: device A (34.5.7) 11,170/11,170 lines SENT with 661 findings and device B (34.0.12) 7,323/7,323 SENT with 461 findings - every one in the known environmental classes (chassis ports absent on the 2-port lab VA + their menu cascades, now multiplied by the VLANF port bindings; trunk adminkey; DHCP-managed mgmt port) plus two same-session staging artifacts (one advhc redeclared across two per-RD files that target SEPARATE devices in reality; one BOM injected by the staging concatenation script, not by the tool). ZERO converter defects; the LDAP-1/LIVE-24/LIVE-25 fixes verified clean on-device. 102 regression tests.

## Round 13 (2026-11-16): field report (telco C) - named virtual-address + SSL certificates

An APAC engineer reported two gaps on a live migration:

1. **VADDR-1** - a virtual whose destination names a `ltm virtual-address`
   object was put aside instead of resolved. Fixed: the name resolves to the
   object's address; `enabled no` converts the virtual disabled.
2. **SSLCERT-1** - SSL virtuals had no server certificate and no diagnostic.
   Probed on 34.0.12 first: the `srvrcert` binding to a missing certificate
   refuses the whole apply, an empty key stub refuses it too, binding an
   existing certificate applies and reads back. So the binding stays out of
   the config and every SSL virtual gets exact import + bind steps naming the
   F5 cert, key and chain.

Gate: a synthetic config in the shape of the report (named disabled
virtual-address, client-ssl with cert + chain, automap, VLAN restriction) on
34.0.12 with validate4: 23 lines, sent 28, UNSENT 0, 0 line findings,
APPLY-ERRORS 0 ("Apply complete", then "Unsaved changes reverted").
Fleet re-convert (30 devices): no emitted CLI line changed; 4-104
certificate diagnostics per device, none undetermined. 127 regression tests.
Not executed: the certificate import itself (it pulls the files from an SCP
server).

## Round 14 (2026-11-16): apply-level fleet sweep finished - the harness now reads every apply result

**Harness defect first (APPLYWAIT-1):** validate4 moved on 1.5 s after
`apply` while large configs were still applying, so on 11 files over ~3,600
lines the apply RESULT was never read and the reports said APPLY-ERRORS=0.
Every big-file "apply clean" claim before 2026-11-10 (rounds 12-13 and the
first pass of this sweep) is VOID. validate4 now waits for "Apply complete" /
"Apply not done" / "No apply needed" and for "Unsaved changes reverted"
(30 min cap = an APPLY finding). The lane script now waits for SSH and
reruns a file that sent nothing.

Re-gating the big files with the fixed harness found five more whole-apply
refusals and the field repro found one silent rewrite, all fixed and proven
on 34.0.12 first: SSLPOL-1 (47-policy cap), PTMOUT-1 (ptmout below the real
tmout), SYSLOG-1 (duplicate syslog host), FTP-1 (ftp without ftp-data,
TRAFFIC-PROVEN passive + active with a parsing-off control), VNAME-1 (vname
over 128 chars, line-level) and RPORT-1 (rport 443 rewritten to 80).

Earlier in the sweep: GW-1, COOKIE-1, SSLIP-1, FILT-1, PORTNAME-1, VCMP-1,
JOIN-1, REAL-HC-1, SNATPOOL-1, REALVIP-1, FLOATVIP-1, FLOATSUB-1.

### Round 14 gate results (2026-11-16 to 2026-11-19, final build = v0.10.0)

**Method.** Every field output was gated with validate4 (revert, every line,
apply, `revert apply`) on an **all-enabled** copy (`validation/tools/enable-all.js`:
F5-disabled virtuals / services / reals turned on). A disabled object is
skipped by many apply-time checks, so the normal file could pass while the
same config, once the customer enables an object, would refuse; the
all-enabled run is the stricter gate. 34.0.12 was rebooted to a clean device
before the segment re-gates (SEGVLAN-1: `revert apply` leaves stale VLAN
entries). Before the release, every output of the final build was diffed
against the copy that was last gated: each gated file below is
byte-identical to the final build's output, and the files that were only
gated on early builds (sweep 2-7) were gated again (lane 20).

**Defects found and fixed this round** (each with a regression test, a DELTAS
row and a device probe): SSLID-1, IPHC-1, IFVIP-1, BOM-1, SEGVLAN-1,
SEGPORT-1, HCDEST-1, NAMELEN-1, REALID-1, ICMPDPORT-1, TCPSEND-1, BODY-1,
VTAG-1, PVIDP-1, plus two harness defects: USAGE-1 (a line answered with only
a `Usage:` line is a refusal) and PROMPT-1 (a config line that triggers a y/n
prompt is a paste trap; `alteon-exec.js` got `PASTE_SIM=1` to reproduce a
paste). VTAG-1/PVIDP-1 were probed in paste mode with apply on 34.5.7; the
PASTE_SIM switch itself was checked on 34.0.12 (the PVID prompt swallowed
every following line, as in a real paste).

**Results on the final build** (SENT = lines + 5 harness lines, UNSENT 0 on
every run; "env" = only the environmental classes listed in
docs/ALTEON-CLI-FACTS.md):

| Device | Files | Lines | APPLY errors | Line findings |
|---|---|---|---|---|
| 34.0.12 | dev04 | 2,123 | 0 | 3 env (DHCP mgmt) |
| 34.0.12 | dev05 main + rd1 (segment mode) | 5,351 + 83 | 0 | 3 env |
| 34.0.12 | dev09 main + rd1 (segment mode) | 5,351 + 83 | 0 | 3 env |
| 34.0.12 | dev06 | 7,338 | 0 | 3 env |
| 34.0.12 | dev16 rd1 / rd2 / rd3 | 3,607 / 453 / 50 | 0 | 0 |
| 34.0.12 | dev17 rd1 | 2,403 | 0 | 0 |
| 34.0.12 | dev20 | 5,963 | 0 | 3 env |
| 34.0.12 | dev22 | 11,052 | 0 | 1 env (rerun in full after a VPN drop) |
| 34.0.12 | dev23 rd3 / rd4 | 10 / 37 | 0 | 0 |
| 34.0.12 | dev28 | 4,550 | 0 | 3 env |
| 34.0.12 | dev01 (port 2 moved to VLAN 1 first = factory default) | 788 | 0 | 25 env (absent ports 3/4 + their cascade, DHCP mgmt) |
| 34.0.12 | seglab fixture (segment mode, clean device) | 139 | 0 | 0 (rebooted device, port 2 moved to VLAN 1 first) |
| 34.5.7 | dev02 / dev07 | 1,825 / 1,828 | 0 | 3 env each |
| 34.5.7 | dev03, dev11, dev12, dev13, dev14, dev15, dev18 | 153 - 1,176 | 0 | env only (absent chassis ports + cascade, LACP adminkey, DHCP mgmt) |
| 34.5.7 | dev16 main | 2,573 | 0 | 1 env |
| 34.5.7 | dev17 main, dev23 main + rd2, dev16 rd4, dev25, dev26, dev27, dev30 | 53 - 2,198 | 0 | env only (DHCP mgmt) |

dev24 is byte-identical to dev23 (covered). dev23/dev24 rd1 are empty.

**Lab-only apply refusal, not a converter defect:** on 34.5.7 (and on 34.0.12
as saved) port 2 sits in lab VLAN 2, so the PVIDP-1 sequence (pvid, add, then
`/c/l2/vlan 1/rem`) leaves port 2 in two untagged VLANs: "Port 2 is a member of
multiple VLANs (2,173) without tagging" (dev01, seglab on 34.5.7). The
converter assumes factory-default ports and says so in needs-manual-work.txt,
with the manual step `/c/l2/vlan <old>/rem <port>` before pasting - proven on
34.5.7 in paste mode: apply complete. With port 2 moved to VLAN 1 first,
dev01 applied clean on 34.0.12.

**Not proven:** dev19 (34,559 lines) exceeds the lab VA's capacity (1,024
groups, 1,024 virtual servers, 1,023 virtual services) and refuses the apply on
capacity alone, so its remaining apply-time checks are unproven on this lab;
it needs a larger Alteon. Twin devices dev08, dev10, dev21 and dev29 were
skipped at the owner's request (their pairs are gated).

Tests: 156. `node tools/scan-sensitive.js`: clean. `dangling-refs.js` on the
final build: clean (45 files).

## Harness & safety

Use **`validate3.js`** (`validate.js`/`validate2.js` kept for reference only -
v2 silently validates nothing when the device has pending config changes).
validate3:

1. answers the pending-changes login note and starts with a clean `revert`;
2. streams the config line by line, paced on the CLI prompt;
3. auto-answers confirm prompts, pages through the `diff` pager, and flags any
   interactive value-prompt as a "not paste-safe" finding (converter bug);
4. records every line the device rejects (`Error`/`bad port`/`unknown
   command`/...);
5. ends with `diff` → `revert` → `/` → `exit` so the CLI session actually logs
   out (a leaked session counts against the device's session limit until idle
   timeout; enough of them and the device resets new SSH connects);
6. persists the report + transcript even when the device closes the socket
   with an RST (normal Alteon logout behavior).

Never sends `apply`, `save`, `boot`, `reset`, or `shutdown` - a hard gate skips
those even if present in the input. All changes are pending-only and reverted.

## Re-running

```bash
cd validation
npm install ssh2 --ignore-scripts
node validate3.js 10.210.240.137 <user> <password> sample01_alteon_config.txt results/report_34_5_7_0.json
node validate3.js 10.210.240.152 <user> <password> sample01_alteon_config.txt results/report_34_0_12_0.json
```

If SSH connections reset (`ECONNRESET`) but you can still read the
`SSH-2.0-Alteon` banner: leaked/parallel CLI sessions have filled the device's
session table - wait ~15 min with no connection attempts.
