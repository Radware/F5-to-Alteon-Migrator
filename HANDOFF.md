# HANDOFF - current state and next steps

> **Two repos - read [PUBLISHING.md](PUBLISHING.md) before pushing.**
> `origin` = **private** dev repo (full history, `private/` lab + customer
> context): commit freely, `git push origin main`.
> `radware` = **public** `Radware/F5-to-Alteon-Migrator`: sanitized snapshots
> only, published **exclusively** via `tools/publish-public.ps1`.
> On a fresh clone: `git config core.hooksPath .githooks` (npm install does it too).

Rules and how to work: **[AGENTS.md](AGENTS.md)**. This file is the state.
Last updated: 2026-11-23.

## Where things stand

| | Version | Content |
|---|---|---|
| npm `@radware/f5-to-alteon` | **0.10.1** | latest release (2026-11-23) |
| public repo `main` | 0.10.1 | snapshot from private `main` via `tools/publish-public.ps1` |
| private `main` | 0.10.1 | the PR #1 / #2 work (HTTP API `serve`, Dockerfile, GHCR image) is merged in |

**In 0.10.1** (field requests from the PS team, 2026-11-19 / 21): IDLEN-1
(real / group / virt IDs kept up to 255 characters, `--max-id-len 32` for
older Alteons), MGMTRT-1 (management routes listed in needs-manual-work.txt
with the exact `/c/sys/mmgmt/route/ipv4/add` command - never in the config:
an off-subnet gateway refuses the whole apply), MGMTDHCP-1 (`dhcp ena` only
when the F5 management uses DHCP). Tests: 163. Gate evidence: Round 15.

**In 0.10.0** (since 0.9.1; all with tests + DELTAS rows, found by the
apply-level gate on field data): validate4 (stage + apply gate), LOGEXP-1,
PART-5, SPLIT-2, VIP-PAIR, ADDPORT-1, ROUTE-1, GW-1, COOKIE-1, SSLIP-1,
FILT-1, PORTNAME-1, VCMP-1, JOIN-1, REAL-HC-1, SNATPOOL-1, REALVIP-1,
FLOATVIP-1, FLOATSUB-1, APPLYWAIT-1, VNAME-1, VADDR-1, SSLCERT-1, SSLPOL-1,
RPORT-1, PTMOUT-1, SYSLOG-1, FTP-1, SSLID-1, IPHC-1, IFVIP-1, BOM-1, USAGE-1,
SEGVLAN-1, SEGPORT-1, HCDEST-1, NAMELEN-1, REALID-1, ICMPDPORT-1, TCPSEND-1,
BODY-1, VTAG-1, PVIDP-1, PROMPT-1, plus the HTTP API / container. Tests: 156.
Gate evidence: validation/VALIDATION_STATUS.md Round 14 (every field output
of the release build applied with 0 apply errors, except dev19 which exceeds
the lab VA capacity).

**What the tool converts today:** virtuals (tcp/udp, VLAN-restricted ->
filter pairs), pools, nodes, monitors (incl. AND/OR -> LOGEXP), persistence
(cookie, source IP, SSL session ID), HTTP/SSL profiles, SNAT pools and SNAT
Automap, administrative partitions, route domains (segmentation on one device,
or per-RD split), wildcard / forwarding / source-match virtuals -> filters,
VLANs (tagged / untagged members, paste-safe PVID order), interfaces, floating
IPs, routes, trunks/LACP, mgmt/NTP/syslog/SNMP (management static routes as
manual steps with the command).
Not converted (diagnostics): iRules, LTM policies, GTM, ASM, DNS monitors,
standalone SNAT objects, POST monitor bodies with quotes or line breaks, TCP
monitors with send/expect (need a script-type check).

## Open threads - read before acting

1. **Ownership hand-off to PS.** The PR #1 author answered (2026-11-11) that
   PS takes ownership starting Q1 2027; the owner wants it to move sooner.
   Details and the drafted hand-over mail: `private/CONTEXT.md`.
2. **The contributor has WRITE access to the public repo.** The release
   script refuses to publish while the public repo has work missing from the
   private repo (`tools/public-drift.js`, see PUBLISHING.md). Check before
   every release; the guard lists the commits.
3. **dev19 is not apply-proven.** Its 34,559-line output exceeds the lab VA
   (1,024 groups / virtual servers, 1,023 services) and refuses on capacity
   alone. Gate it on a larger Alteon when one is available.
4. **Lab VAs are not factory default:** both have port 2 in lab VLAN 2. Output
   that moves access ports out of VLAN 1 (PVIDP-1) refuses there; move port 2
   back to VLAN 1 first (`/c/l2/vlan 1/add 2`, answer y to the PVID prompt -
   that moves it out of VLAN 2 - then `apply`; verified on 34.0.12). The gate's `revert apply` restores the saved lab state after each
   file, so redo it per file.
5. **Inter-route-domain services on device A/B.** About half of those
   services are F5 inter-RD load balancing (virtual and backends in different
   RDs). SPLIT-2 puts them aside, correctly - but this is a migration-design
   decision for that customer (local backends per instance, or an
   inter-instance path), not something to "fix" in the converter.
6. **VPN drops stall the gate lanes.** On 2026-11-22 both lanes lost SSH at
   the same moment and `apply-gate-lanes.ps1` kept waiting after SSH was
   back. Watch lanes with a stall check (a lane "waiting for" over 30 min)
   and restart the remaining files; a cut run that never reached apply only
   needs `revert` on the device.
7. **Legacy tool still in use.** Reports with a Python traceback
   (`local_runner.py`, `app/f5_mig.py`, `KeyError: 'vip'`) are about the old
   tool: reply with "use @radware/f5-to-alteon", do not fix the old code.

## Next steps (prioritized)

1. Field requests (not started, owner to prioritize): iRule -> Alteon
   content-based rules (the URI-routing mapping is already traffic-proven,
   see OPEN-QUESTIONS 3; iRule -> AppShape++ is EXCLUDED by the owner), and
   ASM policy -> Alteon SecWA mapping (no research done yet).
2. LTM policies: decide between a policy inventory report (recommended in
   OPEN-QUESTIONS 3) and the `forward select` converter.
3. Gate dev19 on a larger Alteon (thread 3).
4. Still open from OPEN-QUESTIONS: DNS monitor field mapping (prove the
   unhealthy case), standalone SNAT equivalence (prove with tcpdump), and
   traffic-proof that a SECOND same-VIP virt serves (applies today, only the
   first was ever traffic-tested).

## Verify the repo quickly

```bash
cd node && npm test                       # 163 pass
node ../tools/scan-sensitive.js           # clean
node bin/f5-to-alteon.js ../fixtures/sample01/bigip_base.conf ../fixtures/sample01/bigip.conf -o ../out/sample01
```

Device validation needs the Radware VPN and the lab in
`private/LAB-ACCESS.md`; the procedure is in
`.claude/skills/alteon-device-validation/SKILL.md`.

## History in one paragraph

Phase 1-3: the legacy Python tool was characterized (golden files), rebuilt in
Node with every legacy path covered, and its bugs fixed (BUG-1..8). Real
customer exports exposed GAP-1..10 and live staging exposed LIVE-1..25.
Features were added one at a time, each device-proven: qkview input, bulk mode,
wildcard filters (WVF), route domains (split, then segmentation - traffic
proven), partitions (PART-1..5), SNAT automap (traffic proven), source-match
filters (TMC), tcp/udp (DNS-1), VLAN restriction filters (VLANF-1, traffic
proven). In August 2026, after a field user found an apply-blocker that line
staging had missed, the owner made apply-level validation mandatory; the new
gate then found five more apply-blocker classes in field data. See
validation/VALIDATION_STATUS.md for every round.
