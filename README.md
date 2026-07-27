# F5-to-Alteon Migrator

[![npm](https://img.shields.io/npm/v/%40radware%2Ff5-to-alteon)](https://www.npmjs.com/package/@radware/f5-to-alteon)

> **This repository is a published mirror.** Development happens in a private
> Radware repository; this repo receives sanitized, tested snapshots, so commits
> made here are overwritten by the next release.
> **Found a problem? [Open an issue](https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose)** - that is
> the right channel and it is very welcome. To contribute code or get access to
> the development repository, contact the maintainer, Sean Ramati
> (seanr@radware.com). See [PUBLISHING.md](PUBLISHING.md).

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
npx @radware/f5-to-alteon device.qkview
```

It is not limited to qkview - feed it whatever export you have, the input type
is auto-detected. `.` means "the folder I am in", which is how you bulk-convert:

```bash
npx @radware/f5-to-alteon backup.ucs                    # one UCS backup archive
npx @radware/f5-to-alteon bigip_base.conf bigip.conf    # bare tmsh config files
npx @radware/f5-to-alteon bigip.conf                    # a single bigip.conf
npx @radware/f5-to-alteon ./qkview-dir/                 # an extracted archive folder
npx @radware/f5-to-alteon .                             # BULK: every archive in this folder
npx @radware/f5-to-alteon C:\configs\qkviews             # BULK: every archive in that folder
```

**2. Global install** - same requirement, then the command is always available:

```bash
npm install -g @radware/f5-to-alteon
f5-to-alteon device.qkview
```

**3. From this repository** - no npm registry access needed:

```bash
git clone https://github.com/Radware/F5-to-Alteon-Migrator.git
cd F5-to-Alteon-Migrator/node
node bin/f5-to-alteon.js <input>
```

All three are identical on Windows (PowerShell/CMD), macOS, and Linux.

**Full step-by-step usage, options, and troubleshooting: see the
[package README](node/README.md)** (the same document shown on
[npmjs.com/package/@radware/f5-to-alteon](https://www.npmjs.com/package/@radware/f5-to-alteon)).

### Inputs (auto-detected)

`.qkview` / `.ucs` archives (streamed, multi-GB OK) / extracted archive folders /
bare `bigip.conf` / `bigip_base.conf` files / **a folder of many archives (bulk
migration - every device converted into its own output folder)**.

### Outputs

Written to a folder named after the input (or `-o <dir>`):
`alteon-config.txt` (apply this) + `needs-manual-work.txt` (every item quotes the
original F5 stanza verbatim) + `not-supported.txt`.
Nothing is ever silently dropped - every unconvertible object is logged with
guidance. With route domains in **split** mode you also get one
`alteon-config-routedomain-N.txt` per RD.

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

Nine rounds of live validation, documented in
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
- **39 defects** found and fixed along the way (8 legacy-baseline bugs, 10
  parser gaps, 21+ live-device findings, including one where the CLI accepted a
  line and silently ignored it) - each locked in by a regression
  test. The full ledger: [`DELTAS.md`](DELTAS.md).

```bash
cd node
npm test     # 84 tests, all passing
```

## Found a problem? Please tell us

**Open an issue** - conversion reports are the single biggest reason this tool
works as well as it does: 37 defects were found and fixed from real customer
configurations people sent in.

[**Report a conversion problem, bug, or missing capability**](https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose)

Include as much as you can - ideally the F5 stanza involved (`needs-manual-work.txt`
already quotes it for you), what the tool produced, the exact Alteon error if the
device rejected it, and the versions on both sides. Attaching the config or qkview
is very welcome when you are able to.

> **Before attaching files:** F5 configurations contain IPs, hostnames and
> sometimes credentials, and GitHub issues are public. Sanitize first, or attach
> only the relevant stanza. If it cannot be shared publicly, say so in the issue -
> Radware customers can send it privately through a
> [support case](https://support.radware.com) referencing the issue number.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including how to add a
regression test with your fix.

## Repository layout

| Path | Contents |
|------|----------|
| [`node/`](node/) | The npm package (CLI + library + tests) - this is what's published |
| [`fixtures/`](fixtures/) | Synthetic/sanitized test configs incl. the golden legacy-equivalence pair and the segmentation traffic-test fixture |
| [`validation/`](validation/) | Live-device validation harness (non-destructive stager, behavioral test driver) + status + result reports |
| [`DELTAS.md`](DELTAS.md) | Every deliberate difference vs the legacy tool, with the live error that motivated it |
| [`ROADMAP.md`](ROADMAP.md) | Phase plan (phases 1-3 complete) |
| [`ROADMAP-NEXT.md`](ROADMAP-NEXT.md) | What to build next, ranked by what real customer configs contain |
| [`docs/`](docs/) | Proposal + progress reports + the customer User Guide |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to report issues and contribute fixes |
| [`PUBLISHING.md`](PUBLISHING.md) | Two-repo workflow and the sanitized release procedure |
| [`legacy-reference/`](legacy-reference/) | Read-only copy of the original tool |

## For maintainers

- [`HANDOFF.md`](HANDOFF.md) - continue-from-here guide
- [`LAB.md`](LAB.md) - lab topology and validation how-to
- [`PUBLISHING.md`](PUBLISHING.md) - **the two-repo workflow**: development
  happens in a private repo with the full history; this public repo receives
  sanitized snapshots only, via `tools/publish-public.ps1` (scans for customer
  names and secrets, runs the tests, pushes one squashed commit). A pre-push
  hook blocks direct pushes to the public remote.

## License

Apache-2.0
