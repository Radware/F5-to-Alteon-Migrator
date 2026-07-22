# F5-to-Alteon Migrator

[![npm](https://img.shields.io/npm/v/%40radware%2Ff5-to-alteon)](https://www.npmjs.com/package/@radware/f5-to-alteon)

Convert an **F5 BIG-IP** (tmsh) configuration into a ready-to-apply **Radware
Alteon** CLI configuration. One command, any input form, on Windows / macOS /
Linux.

This is a tested, cross-platform rebuild of Radware's internal
[`F5-Migration`](https://github.com/Radware/F5-Migration) tool: the same
conversion knowledge re-implemented as a dependency-free Node.js package, with
the legacy tool's bugs fixed, new conversion paths added (route domains,
wildcard virtuals), and - most importantly - **every output path validated on
live Alteon appliances**, up to and including packet-level traffic tests of
the generated configs.

## Use it (pick any)

**1. Zero-install (recommended)** - needs only [Node.js](https://nodejs.org) 16+:

```bash
npx @radware/f5-to-alteon device.qkview -o out/
```

It is not limited to qkview - feed it whatever export you have, the input
type is auto-detected:

```bash
npx @radware/f5-to-alteon backup.ucs -o out/                      # UCS backup archive
npx @radware/f5-to-alteon bigip_base.conf bigip.conf -o out/      # bare tmsh config files
npx @radware/f5-to-alteon bigip.conf -o out/                      # a single bigip.conf
npx @radware/f5-to-alteon ./extracted-qkview-dir/ -o out/         # an extracted archive folder
npx @radware/f5-to-alteon ./folder-with-many-configs/ -o out/     # multi-device dump (it lists them, you pick)
```

**2. Global install** - same requirement, then the command is always available:

```bash
npm install -g @radware/f5-to-alteon
f5-to-alteon device.qkview -o out/
```

**3. From this repository** - no npm registry access needed:

```bash
git clone https://github.com/Radware/F5-to-Alteon-Migrator.git
cd F5-to-Alteon-Migrator/node
node bin/f5-to-alteon.js <input> -o out/
```

All three are identical on Windows (PowerShell/CMD), macOS, and Linux.

**Full step-by-step usage, options, and troubleshooting: see the
[package README](node/README.md)** (the same document shown on
[npmjs.com/package/@radware/f5-to-alteon](https://www.npmjs.com/package/@radware/f5-to-alteon)).

### Inputs (auto-detected)

`.qkview` / `.ucs` archives (streamed, multi-GB OK) / extracted archive
folders / bare `bigip.conf` / `bigip_base.conf` files / a folder of configs
from several devices (the tool lists them and asks which one).

### Outputs

`<name>_output.txt` (the Alteon CLI config) + `<name>_log1.txt`
(manual-completion items) + `<name>_log2.txt` (possibly-unsupported items).
Nothing is ever silently dropped - every unconvertible object is logged with
guidance. With route domains in **split** mode you also get one
`<name>_rdN_output.txt` per RD.

## What it converts

| Area | Coverage |
|------|----------|
| SLB | nodes/reals (state, ratio -> weight, maxcon), monitors (built-ins + custom, AND/OR -> LOGEXP), pools/groups (metric, priority-group -> backup), virtuals (VIP/service, reserved-port coercion), persistence (client-IP, cookie), profiles (HTTP/XFF, SSL -> ssl policy, one-connect), SNAT pools -> PIP network classes |
| Wildcard / forwarding virtuals | -> Alteon **filters** (allow or redirect-to-group) with automatic port bindings |
| Route domains | -> Alteon **Network Segmentation** on one device (non-overlapping RDs), or per-RD split outputs (`--rd-mode`) |
| Network | VLANs, self-IPs -> interfaces, floating IPs, static routes + gateways, trunks/LACP |
| System | mgmt IP/gw, NTP, syslog, SNMP |
| iRules, GTM/GSLB, partitions | named diagnostics with guidance (no automatic equivalent) |

The tool is a strict **superset of the legacy F5-Migration tool** - every
legacy conversion path is covered, byte-compatible except a documented list of
deliberate bug fixes ([`DELTAS.md`](DELTAS.md)).

## How it was validated

Eight rounds of live validation, documented in
[`validation/VALIDATION_STATUS.md`](validation/VALIDATION_STATUS.md):

- **39 real production devices** converted and staged on live Alteons
  (34.0.12.0 + 34.5.7.0): 33-device VIPRION/vCMP/GTM/WAF fleet, a 6-file
  heavy-route-domain customer set, and a config exported from a live BIG-IP
  17.5 we deployed for this purpose. **Zero remaining converter defects** -
  every residual reject is environmental (platform capacity, physical ports,
  lab DHCP).
- **Behavioral round-trip**: live F5 VE 17.5 and the migrated Alteon serving
  the same apps - load-balancing distribution delta 0.0%, persistence and
  health behavior identical.
- **Per-feature traffic tests** on live Alteon: 11 constructs traffic-proven
  (LB metrics, backup servers, cookie/client-IP persistence, XFF, health
  checks, ...).
- **Segmentation traffic proof** at packet level: segment-classified VIP
  serves a routed client; cross-segment traffic is redirected to the segment
  gateway (tcpdump MAC-level evidence); segment isolation holds (a segment-2
  client is NOT served by a segment-1 VIP).
- **37 defects** found and fixed along the way (8 legacy-baseline bugs, 10
  parser gaps, 19+ live-device findings) - each locked in by a regression
  test. The full ledger: [`DELTAS.md`](DELTAS.md).

```bash
cd node
npm test     # 79 tests, all passing
```

## Repository layout

| Path | Contents |
|------|----------|
| [`node/`](node/) | The npm package (CLI + library + tests) - this is what's published |
| [`fixtures/`](fixtures/) | Synthetic/sanitized test configs incl. the golden legacy-equivalence pair and the segmentation traffic-test fixture |
| [`validation/`](validation/) | Live-device validation harness (non-destructive stager, behavioral test driver) + status + result reports |
| [`DELTAS.md`](DELTAS.md) | Every deliberate difference vs the legacy tool, with the live error that motivated it |
| [`ROADMAP.md`](ROADMAP.md) | Phase plan and what's next (iRules, GTM, ...) |
| [`docs/`](docs/) | Proposal + progress reports |
| [`legacy-reference/`](legacy-reference/) | Read-only copy of the original tool |

## For maintainers

- [`HANDOFF.md`](HANDOFF.md) - continue-from-here guide
- [`LAB.md`](LAB.md) - lab topology and validation how-to
- Publishing: `cd node && npm publish` (prepublishOnly runs the full test
  suite; the tarball ships only `bin/`, `lib/`, `README.md`)

## License

Apache-2.0
