# Migration guide — F5 BIG-IP → Alteon, start to finish

The complete journey for a PS engineer (or customer) migrating an F5 BIG-IP
to a Radware Alteon with this tool. Every step is designed to work with
**whatever you already have** — you don't need to prepare anything special.

## 1. Get the F5 configuration (any of these works)

| What you have | How to get it | Then run |
|---------------|---------------|----------|
| **A qkview** (customer sent one / F5 support archive) | nothing — use as-is | `f5-to-alteon device.qkview -o out/` |
| **A UCS archive** (`tmsh save sys ucs my.ucs`, in `/var/local/ucs/`) | copy it off the box | `f5-to-alteon my.ucs -o out/` |
| **An extracted qkview folder** | nothing | `f5-to-alteon <folder>/ -o out/` |
| **Just the config files** (`/config/bigip.conf` + `/config/bigip_base.conf`, via scp after `tmsh save sys config`) | copy them | `f5-to-alteon bigip_base.conf bigip.conf -o out/` |
| **A folder with several devices' files** | nothing | run it on the folder — the tool lists the devices it finds so you pick one |

Input type is auto-detected (magic bytes, not file extensions). Multi-GB
qkviews are streamed — the config is extracted in seconds. Non-F5 input is
rejected with a clear message instead of producing an empty config.

> An HA pair is TWO devices — migrate the active unit's config (the peer's
> config is nearly identical; floating IPs and self-IPs come across from
> whichever unit you convert).

## 2. Convert

```bash
npx @radware/f5-to-alteon <your input> -o out/ --name mydevice
```

You get three files and a console summary (`Converted: 27 virtuals, 31
groups, ...`):

| File | What it is | What to do with it |
|------|-----------|--------------------|
| `mydevice_output.txt` | The Alteon CLI configuration | review, then stage on the Alteon |
| `mydevice_log1.txt` | Items needing **manual completion** (supported by Alteon, but a human must decide — e.g. SNAT pools, port re-mapping, drained members) | work through every item |
| `mydevice_log2.txt` | Items **possibly unsupported** on Alteon (iRules, VLAN-restricted virtuals, non-/32 VIPs) | design decisions per item |

The converter never silently drops something it can't translate — everything
lands in one of the two logs.

## 3. Stage & syntax-validate on the target Alteon (non-destructive)

`validation/validate3.js` streams the config into the device, records any
rejected line, shows the staged `diff`, then **reverts everything** (it never
sends `apply`/`save`):

```bash
cd validation && npm install ssh2 --ignore-scripts
node validate3.js <alteon-ip> admin <password> ../out/mydevice_output.txt report.json
```

`realErrors=0` means every line staged cleanly. Findings in `report.json`
name the exact line and the device's error. Environment-dependent lines
(license-gated features like cookie persistence, DHCP-managed mgmt ports,
ports that don't exist on the target chassis) are the usual suspects — see
`validation/VALIDATION_STATUS.md` for the reference list.

## 4. Behavioral round-trip (optional but recommended before cutover)

`validation/roundtrip/` compares live behavior of the app behind the F5 vs
behind the migrated Alteon: LB distribution, cookie persistence stickiness,
health-check eject/restore, TLS. See `validation/roundtrip/README.md`.

## 5. Cutover checklist

1. Every `log1` item resolved; every `log2` item has a decision.
2. `validate3` reports 0 unexplained errors on the TARGET device (right
   version, right licenses, right port count).
3. Re-map physical ports (F5 slot.port names ≠ Alteon port numbers — the tool
   flags every mapping it guessed).
4. Apply during a window: paste config, `apply`, test with the round-trip
   probe, only then `save`.

## What the tool converts today

nodes/reals (state, ratio→weight, connection-limit→maxcon) · monitors incl.
multi-monitor AND/OR joins and F5 built-ins · pools/groups (LB metrics,
priority-group→backup, mixed-port members, per-member monitors/ratios) ·
profiles (http/XFF, client/server-SSL incl. built-in variants, one-connect,
fastL4 family) · persistence (cookie→pbind/AppShape, source-addr→clientip) ·
virtuals (VIP/services, reserved-port applications, SNAT pools→PIP nwclss) ·
VLANs (≤4090, with >4090 flagged) · self-IPs/floating IPs · static routes +
gateways · trunks/LACP · system (mgmt/NTP/syslog/SNMP).

**Diagnostic-only (Phase 4, not converted):** iRules, GTM/GSLB, route
domains/partitions, dynamic routing, non-/32 wildcard VIPs, ASM/APM policies.
