# f5-to-alteon

Convert an **F5 BIG-IP** (tmsh) configuration into a ready-to-apply **Radware
Alteon** CLI configuration - in one command, from whatever file you have.

Every conversion path in this tool has been validated against live Alteon
appliances (34.0.x / 34.5.x), including packet-level traffic tests of the
generated configs. It converts everything Radware's legacy F5-Migration tool
converted, plus route domains (as Alteon Network Segmentation or per-RD
splits), wildcard/forwarding virtuals (as Alteon filters), and dozens of
live-found fixes the legacy tool never had.

## Requirements

- **Node.js 16 or newer** - Windows, macOS, and Linux are all supported.
  Check with `node --version`. If you don't have it, install from
  [nodejs.org](https://nodejs.org) (LTS is fine) or your package manager:
  - Windows: `winget install OpenJS.NodeJS.LTS`
  - macOS: `brew install node`
  - Linux (Debian/Ubuntu): `sudo apt install nodejs npm`

Nothing else. No Python, no build tools, no dependencies - the package is
self-contained (~30 kB).

## Quick start

The fastest way (no installation at all):

```bash
npx @radware/f5-to-alteon device.qkview
```

The input type is auto-detected, so every one of these works. `.` means "the
folder I am in right now" - use it to convert a whole folder of archives:

```bash
npx @radware/f5-to-alteon device.qkview                 # one qkview support archive
npx @radware/f5-to-alteon backup.ucs                    # one UCS backup archive
npx @radware/f5-to-alteon bigip_base.conf bigip.conf    # bare tmsh config files
npx @radware/f5-to-alteon bigip.conf                    # a single bigip.conf
npx @radware/f5-to-alteon ./qkview-dir/                 # an extracted archive folder
npx @radware/f5-to-alteon .                             # BULK: every archive in this folder
npx @radware/f5-to-alteon C:\configs\qkviews             # BULK: every archive in that folder
```

No output path is needed: each device gets a folder named after its input,
created next to it. Add `-o <dir>` to send the results somewhere else.

Or install once, then use anywhere:

```bash
npm install -g @radware/f5-to-alteon
f5-to-alteon device.qkview
```

Both work identically in Windows PowerShell / CMD, macOS Terminal, and any
Linux shell.

## Step by step

**1. Get your F5 configuration.** Any ONE of these works - the tool
auto-detects what you give it:

| You have | Example |
|----------|---------|
| A qkview support archive (even multi-GB) | `f5-to-alteon device.qkview` |
| A UCS backup archive | `f5-to-alteon backup.ucs` |
| An extracted qkview/UCS folder | `f5-to-alteon ./extracted-dir/` |
| Bare config files | `f5-to-alteon bigip_base.conf bigip.conf` |
| A single bigip.conf | `f5-to-alteon bigip.conf` |
| A folder holding many archives | `f5-to-alteon .` from inside it, or `f5-to-alteon <path>` (BULK: every device into its own folder) |

Large archives are streamed - the config files inside are found in seconds
without unpacking the whole archive to disk.

**2. Run the conversion.**

```bash
f5-to-alteon device.qkview
```

No output path needed: a folder named after the input is created next to it
(`device.qkview` -> `device/`). Use `-o <dir>` to put it somewhere else.
You get a one-line summary plus three clearly named files:

| File | What it is |
|------|-----------|
| `alteon-config.txt` | The Alteon CLI configuration - paste/stream it into the Alteon CLI |
| `needs-manual-work.txt` | Items to finish manually (renamed IDs, port mappings, gateway targets, ...). **Each entry quotes the original F5 configuration block**, so you can act without opening the source config |
| `not-supported.txt` | F5 features with no automatic Alteon equivalent (iRules, GTM, ...), each with guidance |

With route domains in split mode you also get one
`alteon-config-routedomain-<N>.txt` per route domain.

**Bulk migration.** Point the tool at a folder holding several archives and it
converts every one of them, each into its own output folder:

```bash
f5-to-alteon .            # or: f5-to-alteon C:\configs\qkviews
```

```
the-folder-you-ran-it-in/
  device-a.qkview
  device-b.qkview
  device-a/    <- alteon-config.txt, needs-manual-work.txt, not-supported.txt
  device-b/    <- same
```

A folder containing a single extracted qkview (`config/bigip.conf`) is still
treated as one device. Force either behavior with `--bulk` or `--single`.

**3. Review the two logs.** The tool never silently drops anything: every F5
object it cannot fully convert appears in a log with the object name, the
issue, and the suggested course of action.

**4. Apply on the Alteon.** Paste the output into an Alteon CLI session (or
stream it over SSH), then run `apply`. Review before `save`. The output is
ordered so objects are defined before they are referenced (segments before
virtuals, persistence before proxy-IP blocks, etc.).

## Options

| Option | Meaning |
|--------|---------|
| `-o, --out <dir>` | Write here instead of the auto-named folder (in bulk mode: the parent folder) |
| `--name <name>` | Override the output folder name (single input only) |
| `--bulk` / `--single` | Force bulk or single-device handling of a folder |
| `--rd-mode auto\|segment\|split` | How to handle F5 **route domains** (see below). Default `auto`. |

## Route domains

F5 route domains (`10.1.2.3%4` addressing) are converted, not ignored:

- **`--rd-mode auto`** (default): if the route domains have **non-overlapping**
  address space, everything lands on ONE Alteon using **Network Segmentation**
  - each RD becomes `/c/slb/segment N` with its VLANs, its virtuals get
  segment classifiers (+ Return-to-Last-Hop for symmetric paths), and a
  per-segment redirect filter sends cross-segment traffic to that segment's
  gateway (taken from the RD's default route). If address spaces overlap, it
  automatically falls back to per-RD splitting.
- **`--rd-mode split`**: one self-contained output file per route domain
  (`alteon-config-routedomain-N.txt`), each meant for its OWN Alteon instance (vADC/VA).
- **`--rd-mode segment`**: force segmentation (falls back to split, with a
  warning, if RDs overlap).

Both modes were validated on live Alteons, including a packet-level
cross-segment traffic test (VIP service, cross-segment redirect, and segment
isolation all verified with tcpdump).

## What it converts

- **SLB**: nodes/reals (state, ratio -> weight, connection limits), monitors
  (built-in mappings + custom, multi-monitor AND/OR -> LOGEXP), pools/groups
  (LB metric, priority-group -> backup, member-level overrides), virtual
  servers (VIP/service/port, reserved-port application coercion, disabled
  state), persistence (client-IP, cookie insert), profiles (HTTP/XFF, SSL ->
  ssl policies, one-connect), SNAT pools -> proxy-IP network classes
- **Wildcard/forwarding virtuals** (non-/32 destination, `any:0`,
  `ip-forward`) -> Alteon **filters** (allow or redirect-to-group) with
  automatic port bindings from the virtual's VLAN restriction
- **Network**: VLANs (enabled, with port membership), self-IPs -> interfaces,
  floating IPs, static routes + default gateways, trunks/LACP, route domains
  (above)
- **System**: management IP/gateway, NTP, syslog, SNMP
- Anything else -> a named diagnostic in the logs (never silently dropped)

## Troubleshooting

- **`npx: command not found`** - Node.js isn't installed or isn't on PATH;
  see Requirements above.
- **"No F5 config found" on an archive** - the archive doesn't contain
  `config/bigip.conf`. If it's a folder of configs from several devices, the
  tool lists what it found so you can pick one.
- **Output rejected by the Alteon** - check the version (validated on 34.x)
  and check `needs-manual-work.txt`: platform-capacity items (e.g. more pools than the
  target supports) and physical-port mappings are flagged there.
- **Windows note**: PowerShell, CMD, and Git Bash all work; paths with spaces
  need quotes, same as any CLI.

## Found a problem? Please open an issue

Conversion reports are how this tool improves - most of its fixes came from real
customer configurations that did not convert cleanly.

**[Report it here](https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose)**
and include as much as you can: the F5 stanza involved (`needs-manual-work.txt`
already quotes it for you), what the tool produced, the exact Alteon error if the
device rejected the line, and both versions. Attaching the config or qkview is
welcome - but sanitize it first, because GitHub issues are public. If the data
cannot be shared publicly, say so and send it privately through a
[Radware support case](https://support.radware.com).

## Found a problem? Please open an issue

Conversion reports are how this tool improves - most of its fixes came from real
customer configurations that did not convert cleanly.

**[Report it here](https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose)**
and include as much as you can: the F5 stanza involved (`needs-manual-work.txt`
already quotes it for you), what the tool produced, the exact Alteon error if the
device rejected the line, and both versions. Attaching the config or qkview is
welcome - but sanitize it first, because GitHub issues are public. If the data
cannot be shared publicly, say so and send it privately through a
[Radware support case](https://support.radware.com).

## Project

Source, validation reports, and issue tracking:
[github.com/Radware/F5-to-Alteon-Migrator](https://github.com/Radware/F5-to-Alteon-Migrator)

License: Apache-2.0
