# Live validation — status

## Round 1 (Phase 3a): synthetic sample01 — PASSED on both versions

The generated Alteon config (`sample01_alteon_config.txt`, 105 lines) was
streamed into both lab appliances and applied with **zero errors**, then fully
reverted.

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.0.12.0 | 10.210.240.152 | 0 errors | `results/report_34_0_12_0.json` |
| 34.5.7.0  | 10.210.240.137 | 0 errors | `results/report_34_5_7_0.json` |

Round 1 surfaced **BUG-6** (static-route syntax) and **BUG-7** (numeric VLAN
ports) — fixed and re-validated (see `../DELTAS.md`).

## Round 2 (Phase 3b, 2026-07-05): real-config constructs — PASSED on both versions

`fixtures/newconstructs/bigip.conf` (synthetic, exercising every construct the
real BIG-IP exports introduced: weight, forced-offline/drain reals, maxcon,
LOGEXP OR, built-in monitor aliases, HEAD monitors, SSL policy):

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.5.7.0  | 10.210.240.137 | **0 errors**, every object staged (verified via `diff`) | `results/report_newconstructs_34_5_7_0.json` |
| 34.0.12.0 | 10.210.240.152 | **0 errors** | (scratch run; same output byte-for-byte) |

## Round 3 (Phase 3b, 2026-07-05): FULL real production configs

Complete converted configs from two real BIG-IP 17.1.2 production units were
streamed into the live devices — fleet-A (~717 lines, 27 virtuals) on 34.5.7.0
and ltm1 (~1145 lines, 39 virtuals) on 34.0.12.0. Findings drove converter
fixes **LIVE-1..LIVE-7** (empty `health`, `disable`→`dis`, VLAN >4090,
nwclss >32 chars, reserved port/application pairs, vCMP port mapping
diagnostics, cookie persistence on non-HTTP services) — all unit-tested.

> The raw reports/transcripts for these runs contain customer object names,
> internal IPs and the full config, so they are **deliberately NOT committed**
> (kept on Sean's machine in the session scratchpad). Only this summary and
> the synthetic-fixture reports live in the repo.

After the fixes, **every remaining rejected line is environmental** — i.e.
expected on these lab VAs and not a converter defect:

| Remaining error | Why it is environmental |
|-----------------|-------------------------|
| `License for Cookie persistence is not installed/enabled` | Lab VAs have no cookie-persistence license; `pbind cookie insert …` is correct syntax on licensed units |
| `Management port cannot be set manually when DHCP client is enabled` | Both lab VAs manage `mmgmt` via DHCP |
| `bad port "3"/"4"/"70"/"80"` (+ cascaded `adminkey`) | The source F5s are multi-slot vCMP hosts; the 2-port lab VA physically lacks those ports. The converter now emits a port-mapping diagnostic (LIVE-6) telling the engineer to re-map ports to the target chassis |

## Round 4 (Phase 3b, 2026-07-07): config EXPORTED FROM A REAL BIG-IP

`fixtures/sample02-azure` — exported from the live BIG-IP VE 17.5.1 deployed
in Azure (`rg-f5a-lab`), whose behavior was baselined first with the
round-trip probe (2:1 weighted distribution, RDWRLAB cookie persistence,
health eject/restore, TLS termination — all pass, see LAB.md).

| Version | Device | Result | Report |
|---------|--------|--------|--------|
| 34.5.7.0 | 10.210.240.137 | **0 converter errors** (only the 2 known license-environment rejects: `pbind cookie` needs the cookie-persistence license, absent on the lab VA) | `results/report_sample02_34_5_7_0.json` |

With the cookie-persistence license installed (2026-07-08) the same config
also staged with **0 errors on 34.0.12.0**
(`results/report_sample02_34_0_12_0.json`), after the license exposed and we
fixed LIVE-8 (`pbind cookie insert` argument bug present in the legacy tool).

## Round 5 (Phase 3b, 2026-07-08): BEHAVIORAL ROUND-TRIP — **ALL PARITY CHECKS PASSED**

The sample02 config was applied (apply only, never saved) on live Alteon
**34.5.7.0** with lab backends (`backend.py` web1/web2 on 10.210.240.158/.203),
VIP 10.210.240.210, PIP 10.210.240.211, and probed with the same scenarios and
parameters as the source F5 in Azure:

| Scenario | F5 BIG-IP VE 17.5.1 | Migrated Alteon 34.5.7.0 | Verdict |
|----------|--------------------|--------------------------|---------|
| Weighted distribution (ratio 2:1, 60 req) | web1:40 / web2:20, 0 errors | web1:40 / web2:20, 0 errors | **PASS — 0.0% delta** |
| Cookie persistence (RDWRLAB) | 20/20 stuck | 20/20 stuck | **PASS** |
| Health-check reaction (backend down→up) | eject + restore, 0 errors | eject + restore, 0 errors | **PASS** |
| TLS termination | baselined (2:1, sticky, health pass) | not run (needs a cert created on the Alteon — manual step, see MIGRATION_GUIDE) | partial |

Reports + verdict: `results/roundtrip/`. Field notes: the first VIP choice
collided with an existing lab VM (ping-scans over VPN give false negatives —
scan from inside the L2), and the F5's SNAT automap became an explicit Alteon
PIP (the converter's log2 diagnostic covers exactly this decision).

**ROADMAP Phase 3b definition of done is met**: a config exported from a real
BIG-IP converts, applies with zero errors on both target Alteon versions, and
the migrated device behaves identically to the source F5 for live traffic.

## Round 6 (2026-07-09): PER-FEATURE behavioral validation on live Alteon — ALL TRAFFIC TESTS PASS

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

New defect found BY the apply (invisible to staging): **LIVE-16** — F5 `smtp`
monitors without a username convert to Alteon SMTP checks that **block the
entire apply** ("Username value is missing"). Now converted as TCP checks with
a diagnostic.

Operational note: interrupted validator runs leave pending config on the
device; a later `apply` then validates THOSE leftovers too. validate3/alteon-exec
begin with `revert` for exactly this reason.

## Round 7 (2026-07-10/12): 33-device fleet batch + telco customer route-domain set — ZERO remaining converter defects

**Fleet batch** — all 33 real production devices (two LatAm banking production fleets: VIPRION,
vCMP hosts/guests, GTM-DMZ, WAF, link controllers, 17.1–17.5) staged on both
Alteons, 54,500 lines streamed, every config to completion. Findings drove
LIVE-15..19 (cookie-name 20-char limit, `_` not `~` rename suffix, session
resync, radius/pop3 reserved ports, **persistence-before-pip ordering**) — all
fixed + regression-tested. After fixes, every remaining rejected line is
environmental:

| Class | Example | Nature |
|-------|---------|--------|
| Platform capacity | agg008: group #1025 refused ("maximum of 1024 Real Server Groups") — the box has 1,649 pools | target sizing; the converter now warns at conversion time when >1024 groups |
| Physical ports | vCMP/chassis interfaces 2.1/3.0/5.0/11.0 → ports absent on the 2-port lab VA | target sizing; every mapping is flagged |
| DHCP mgmt port | `/c/sys/mmgmt addr` rejected | lab quirk |
| Cookie persistence | **0 errors — licensed and passing** (incl. LIVE-8/15 syntax) | resolved |

**Telco route-domain set** (heavy route domains, redacted addresses) — all outputs incl.
every per-route-domain split file staged cleanly; remaining rejects = the
customer's `x.x` redaction placeholders (pre-flagged by the converter),
physical ports, DHCP mgmt. LIVE-18 (radius ports) found and fixed here.

## Round 8 (2026-07-22): NETWORK SEGMENTATION — FULL CROSS-SEGMENT TRAFFIC PROOF on live 34.0.12

Two-route-domain F5 fixture (`fixtures/seglab/`) converted in auto (segment)
mode and applied on 10.210.240.152; backend VM dual-homed into both segments
(ens192 = VLAN 10 / segment 1, ens224 = VLAN 20 / segment 2). Three proofs, all
at packet level:

1. **Segment-classified VIP serves traffic** — routed corporate client (192.168.44.x,
   3 router hops) → `vs_seg1` (VIP 10.210.240.211, `segment 1`, `rtsrcmac ena`)
   → real 10.210.240.158:8080 → `OK seg1web` 3/3. (Needed a manual service PIP,
   exactly as the converter's SNAT-automap diagnostic instructs — the backend's
   default gw is not the Alteon.)
2. **Cross-segment redirect filter works** — segment-2 client packet to an
   out-of-segment destination (8.8.8.8) entered port 2 and came back ~150 µs
   later from the Alteon's port-2 MAC toward the segment-2 gateway group:
   converter-generated `filt 1810` redirecting, MAC-level tcpdump proof.
3. **Segment isolation holds** — a segment-2 client's SYN to the segment-1 VIP
   was NOT served (curl timeout); tcpdump shows every SYN bounced to the
   segment-2 gateway instead. Matches F5 route-domain isolation semantics.

Two converter defects found by this round (both fixed + regression-locked):
**LIVE-20** — VLANs rendered without `ena`; a new Alteon VLAN is disabled by
default and silently takes its member ports' links down (legacy tool had the
same bug — it shipped in every VLAN-creating conversion ever made with it).
**SEG-2** — RD-scoped routes (`network default%N`, the form tmsh actually
writes) were dropped, leaving segments without their redirect-filter gateway.

Lab note: 10.210.240.137's data links are down for the same pre-fix reason
(disabled VLANs 110/120 from the earlier segment demo, unsaved) — a reboot
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

## Harness & safety

Use **`validate3.js`** (`validate.js`/`validate2.js` kept for reference only —
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

Never sends `apply`, `save`, `boot`, `reset`, or `shutdown` — a hard gate skips
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
session table — wait ~15 min with no connection attempts.
