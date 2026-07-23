# Documented deltas: Node port output vs legacy Python golden output

The Node implementation (`node/`) reproduces the legacy tool's output
byte-for-byte EXCEPT for the following deliberate bug fixes. The test
`node/test/golden.test.js` asserts that the diff between the two outputs
contains exactly these lines and nothing else.

| # | Delta | Reason |
|---|-------|--------|
| BUG-3 | `metric round-robin` → `metric roundrobin` | Legacy metric table only mapped least-connections modes; an explicit F5 `round-robin` passed through verbatim, which is **invalid Alteon CLI** (guide: `roundrobin`). |
| BUG-4 | `/c/sys/ntp` now has `prisrv` / `secsrv` / `tzone` lines | Legacy NTP parser hit a NameError on its first line and silently dropped the entire NTP config (bare header emitted). |
| BUG-5 | `/c/sys/mmgmt` now has a `gw` line | Legacy iterated `findall(...)[:-1]` over management routes, skipping the last one — with a single default route, the management gateway was silently dropped. |
| BUG-6 | `/c/l3/route` + `add …` → `/c/l3/route/ip4/add …` | **Live validation finding (34.0.12.0):** the `/c/l3/route` menu has no `add` command — the device returned `unknown command "add"`. Correct syntax (CLI guide + device) is `/c/l3/route/ip4/add <dst> <mask> <gw>`. |
| BUG-7 | VLAN `add 1.1` / `add 1.2` → `add 1` / `add 2` | **Live validation finding (34.0.12.0):** the device rejected F5 interface names with `bad port "1.1"`. Alteon VLAN ports are numeric; F5 `slot.port` names are normalized (`1.1`→`1`). |
| BUG-2 | System / route sections appear once, not duplicated | Legacy leaked `route_list` and `mng_dict` between per-file runs, duplicating sections (and cross-contaminating concurrent web-UI runs). The Node CLI processes all input files in one isolated run. |
| BUG-8 | `session user-disabled` → real `dis` instead of `shut psession` | **Live validation finding (34.5.7.0):** `shut` is an interactive/operational command, not a config attribute — pasted into a config session it stages nothing (confirmed via `diff`: no pending change). F5 drain mode means "no NEW sessions"; on a freshly migrated Alteon there are no existing sessions, so `dis` is semantically equivalent. A diagnostic tells the operator to re-enable after cutover if intended. |

Additional fix with no fixture delta:

| # | Fix | Reason |
|---|-----|--------|
| BUG-1 | Standalone (non-HA) self-IPs become `/c/l3/if` entries instead of crashing | Legacy classified any self-IP without the string `local-only` as a floating IP and crashed with KeyError at render time — it could not process a standalone BIG-IP at all. Covered by `node/test/unit.test.js`. |

## Phase 3b: gaps found by running REAL BIG-IP exports (2026-07)

Running the tool on five real-world BIG-IP 17.1.2.x config exports (five
production units, ~900 virtuals total) surfaced conversion gaps. None affect
the sample01 golden output (the synthetic fixture contains none of these
constructs); all are covered by unit tests (`GAP-*` tests in
`node/test/unit.test.js`).

| # | Gap | Fix |
|---|-----|-----|
| GAP-1 | Node `state user-down` (forced offline) was dropped with an "Unhandled line" warning | Real renders `dis` instead of `ena` |
| GAP-2 | Node-level `ratio` was dropped | → real `weight` (clamped to Alteon max 48 with a diagnostic) |
| GAP-3 | **Regression vs legacy:** pool-member `ratio` was dropped by the Node port (legacy converted it) | → real `weight`; conflicting ratios for the same node keep the first and warn |
| GAP-4 | **Regression vs legacy:** pool-member `monitor` was dropped by the Node port | → real `health` |
| GAP-5 | Member `state user-down` / `session user-disabled` were dropped | → real `dis` (with diagnostic) / `shut psession` |
| GAP-6 | `connection-limit` (node & member) was dropped | → real `maxcon` |
| GAP-7 | Pools referencing F5 *built-in* monitors (`gateway_icmp`, `tcp_half_open`, …) warned "not defined" | mapped to Alteon built-in health checks (`icmp`, `tcp`); `http_head_f5`/`https_head_f5` generated as HEAD advhc |
| GAP-8 | F5 built-in profiles (`serverssl-insecure-compatible`, `f5-tcp-lan`, …) warned "not found"; no-equivalent built-ins (`websecurity`, `stream`, …) got the same misleading warning | mapped where an Alteon equivalent exists; targeted "no Alteon equivalent" diagnostic otherwise |
| GAP-9 | "Unhandled line" diagnostics stripped spaces (`stateuser-down`), making them unreadable | spaces kept (log-only change) |
| GAP-10 | `monitor min N of { A B C }` was mis-parsed into garbage monitor names (e.g. `tcp }`) | min 1 of → Alteon `LOGEXP` OR expression; min N>1 approximated as OR with a semantics warning |

## Phase 3b: fixes driven by FULL real-config live validation (LIVE-1..7)

Streaming the complete converted production configs (fleet-A ~717 lines on
34.5.7.0, ltm1 ~1145 lines on 34.0.12.0) surfaced seven more defects — none
visible in syntax-only review, all found by the device itself. All fixed +
unit-tested (`LIVE-*` tests); none affect the sample01 golden.

| # | Live error | Fix |
|---|-----------|-----|
| LIVE-1 | empty `health ` (pool without monitor) → device prompts interactively and **swallows the next config line** | omit the line (Alteon default health = tcp) + diagnostic |
| LIVE-2 | `disable` → `unknown command` on a disabled virtual | correct keyword `dis` |
| LIVE-3 | `bad VLAN number 4094; must be between 1 and 4090` (F5 internal HA VLANs 4092–4094) | VLAN + its self-IPs omitted with diagnostics |
| LIVE-4 | `Id is too long, must be less than 33 characters` (nwclss from long SNAT-pool names) | deterministic 32-char rename + diagnostic |
| LIVE-5 | `port 80 reserved for http application` / `port 25 reserved for smtp application` | reserved-port→application coercion (80/https→http, 25/basic-slb→smtp) + diagnostic |
| LIVE-6 | `bad port "70"` (vCMP interface `7.0` normalized to `70`; target has no such port) | port-mapping diagnostic on every non-slot-1 interface |
| LIVE-7 | `Usage: pbind clientip\|disable` (cookie persistence on a wildcard/ip service) | cookie persistence only on http/https services; otherwise omitted + diagnostic |
| LIVE-8 | `Invalid command-line argument 10.` — found on a cookie-LICENSED 34.5.7.0 (the license error masked it before): legacy emitted `pbind cookie insert "<name>" 10 10`, but the trailing offset/length args belong to *passive* mode | emit `pbind cookie insert "<name>"` (verified applied: insert mode, default 10-day expiry) + diagnostic about the expiry default |
| LIVE-9 | 1,400+ object names over Alteon's 32-char ID limit across two production fleets — each cascaded into dozens of "unknown command" errors | post-parse rename pass (defs + every reference: members, group refs, backups) + diagnostic per rename |
| LIVE-10 | `service undefined` — virtuals with no `destination` in bigip.conf (GTM-managed listeners) | virtual skipped with a targeted diagnostic |
| LIVE-11 | `Non printable characters are not allowed` — UTF-8 descriptions (e.g. "Comunicación") | output-wide ASCII guard: replaced with `?` + diagnostic per affected line |
| LIVE-12 | `bad Primary NTP server "ntp.corp-internal.local"` — hostname NTP servers | IPs emitted, hostnames flagged |
| LIVE-13 | `bad port "trunk_sync_vcmp"` (unresolved trunk name in a VLAN) and `bad gateway IP address "null"` (route without gw) | non-numeric VLAN ports dropped + flagged; routes require an IPv4 gateway |
| LIVE-14 | `port 53 reserved for dns application` (and 22/ssh, 21/ftp, 123/ntp, 389/ldap) | hard-reserved port→application coercion extended + diagnostics |
| LIVE-17 | Route domains (`10.1.2.3%4` addressing) were flattened into one address space — wrong whenever RDs exist for isolation/overlap | **per-route-domain output splitting**: one self-contained config file per RD (`<name>_rdN_output.txt`), each targeting its own Alteon instance (vADC/VA); the default output keeps RD0 + device-level system config. Cross-RD virt↔pool references and IP overlaps across RDs are flagged. Single-RD configs are unaffected. |
| WVF-1 | (feature, previously log2-only) Non-/32 / `any:0` / `ip-forward` **wildcard virtuals** were dropped with "convert to filter manually" | **full wildcard-virtual → Alteon filter conversion**: `action redir` (pool-backed) or `allow`/forward (ip-forward); sip/smask+dip/dmask from F5 source/destination+mask; proto; group+rport (honoring `translate-port disabled`); VLAN match + automatic port `filt` bindings from the virtual's VLAN restriction. Overlap-safe filter-ID range (990–1780, clear of the 1800+ segment filters). SNAT-pool NAT, persistence, multi-VLAN (Alteon filters match one VLAN or any), and unbound-filter cases each emit targeted diagnostics. **Live-verified applied & operational on 34.5.7** (`filt cur` shows the redirect filter enabled with the exact sip/dip/proto/group). 9 edge-case unit tests (WVF-1..9). This is the last legacy conversion path; the port is now a superset of the legacy tool. |
| LIVE-20 | **VLANs were emitted without `ena`** - a newly created Alteon VLAN is DISABLED by default and silently takes its member ports' links down (`/info/link` shows `disabled` despite the port being enabled). Found during the live segmentation traffic test: both lab devices' data ports died right after applying converted VLANs; enabling the VLANs brought links up instantly. The legacy tool had the same omission - every legacy conversion that created VLANs shipped this landmine | `/c/l2/vlan N` now renders `ena` first (regression-locked in the golden fixture) |
| SEG-2 | RD-scoped routes (`network default%N` - the form real tmsh writes) were dropped entirely, so segment mode found "no default gateway for route domain N" and emitted segments WITHOUT their redirect filter/gateway group | parseRoutes strips the `%N` off the network, assigns the route to that RD: segment mode builds the redirect-filter gateway from it, split mode places the route in the right per-RD output |
| LIVE-21 | **Duplicate-IP semantics validated live on 34.5.7**: (a) two virts with the SAME VIP on different services are ACCEPTED by Alteon (matches F5 same-VIP-multi-port practice; 218 such cases across the fleets staged 0-errors); (b) two IP interfaces in the SAME SUBNET are REFUSED at apply ("Error: IP Interfaces 3 and 4 are on the same subnet.") - and F5 configs DO carry same-subnet self-IP pairs (HA-unit selfs; found in 1 of 33 fleet devices) | (1) cross-RD overlap check now covers interface/float/gateway addresses too - interfaces compared at SUBNET level - any cross-RD duplicate refuses segmentation and forces the per-RD split (separate Alteon instances, which is how F5's same-IP-in-two-RDs must land); (2) within one output, only the FIRST interface per subnet is emitted; later ones (typically the HA peer's self) are flagged to configure on the second unit of the Alteon HA pair |
| SEG-1 | (feature) F5 route domains with NON-overlapping address space can live on ONE Alteon | **Network Segmentation mode** (`--rd-mode auto\|segment\|split`, default auto): each RD becomes `/c/slb/segment N` (VLAN bindings + virt `segment` classifiers + `rtsrcmac ena` for symmetric return paths), with a per-segment gateway real/group from the RD default route, an `action redir` filter bound to the segment, and port `filt` bindings. Live-verified applied & operational on 34.5.7 (segment cur shows VLANs/filter/virts associated); CLI shape confirmed on 34.0.12 too. Ordering matters: segments must be defined before the virts that reference them (live finding). Overlapping RDs auto-fall back to the split. |

Remaining rejected lines on the lab devices are purely environmental (cookie
persistence license, DHCP-managed mgmt port, 2-port VA vs multi-slot source
hardware) — see `validation/VALIDATION_STATUS.md`.

## Live validation status

Both fixes BUG-6 and BUG-7 were **confirmed on the live lab devices** — after
the fixes, the full generated config applies with **zero errors** on both
Alteon **34.0.12.0** and **34.5.7.0** (reports under `validation/results/`).
