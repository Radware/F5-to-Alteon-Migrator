# Roadmap

Modernization of the F5-to-Alteon migrator. **Phases 1, 2, and the Alteon-side
of Phase 3 are complete.** The **F5-side of validation is NOT yet done** (see
Phase 3b). **Phase 4 is explicitly out of scope for now.**

## Phase 1 — Stabilize & test  ✅ DONE
- Froze the legacy tool's output as golden fixtures (characterization tests).
- Per-run state model replaces ~40 mutable globals.
- CI (GitHub Actions) runs the test suite on push/PR.
- Surfaced and documented real defects (`KNOWN_BUGS.md`, `DELTAS.md`).

## Phase 2 — Re-platform as a cross-platform npm package  ✅ DONE
- Full parser + renderer ported from legacy Python to Node.js
  (`node/`, `@radware/f5-to-alteon`).
- Zero-install: `npx @radware/f5-to-alteon bigip.conf bigip_base.conf -o out/`.
- Runs on Windows / macOS / Linux. One parser per object type; typed model;
  structured diagnostics instead of silently-swallowed errors.

## Phase 3a — Alteon-side validation  ✅ DONE
- Non-destructive SSH validator (`validation/`) streams the generated config
  into a live Alteon, records rejected lines, then reverts everything.
- Validated on **34.0.12.0** and **34.5.7.0** — the generated config applies
  with **zero errors** on both (`validation/results/`).
- Live validation drove two fixes (BUG-6 route syntax, BUG-7 VLAN port numbers).

## Phase 3b — F5-side validation  ✅ DONE (2026-07-08)

Definition of done — met in full: `fixtures/sample02-azure` (exported from a
live BIG-IP VE 17.5.1) converts, stages with zero errors on **both** Alteon
versions, and the migrated config **passes all behavioral parity checks**
against the source F5 (distribution 0.0% delta, cookie persistence, health
eject/restore — `validation/results/roundtrip/`). Additionally six real
production configs (~900 virtuals) convert cleanly, driving 18 converter fixes
(GAP-1..10, LIVE-1..8), all live-validated.

1. **Real input configs — largely DONE (2026-07-05).** Six real production
   BIG-IP 17.1.2.x exports (bank environment qkviews on Sean's machine, incl.
   a 2.5 GB raw-tar qkview) run through the tool with zero crashes; object
   counts reconcile. Surfaced and fixed GAP-1..GAP-10 (`DELTAS.md`) plus
   BUG-8 + the `maxcon` interactive-prompt trap (both found by live Alteon
   validation of the new constructs). The CLI now ingests qkview/UCS/dir
   inputs directly. Remaining: commit a **sanitized** fixture
   (`tools/sanitize.js`; pending approval — sources are customer configs).

2. **Cloud F5 VE — pending Azure re-login (`az login`, subscription
   "PS-Training").** Deploy BIG-IP VE 17.5.x, build a representative config,
   export via tmsh, commit as `fixtures/sample02` (no customer data — freely
   committable), freeze expected output.

3. **Behavioral parity (round-trip) — NOT started.** Same backends + client;
   app behind the F5, then behind the migrated Alteon; assert equivalent
   behavior: LB distribution, health up/down reaction, persistence stickiness,
   SSL termination. Open question: Alteon VA availability on Azure Marketplace
   (else the round-trip splits across cloud F5 + lab Alteons, which cannot
   share backends — needs a design decision).

## Phase 4 — Migrate more  🔄 PARTIALLY DONE
Delivered and live-validated: **route domains** (per-RD split AND Network
Segmentation, SEG-1) and **non-/32 wildcard virtuals → filters** (WVF-1) — the
port is now a superset of the legacy tool's conversion coverage.
Still future (each ships only behind a live test): iRules → AppShape++,
GTM/GSLB, F5 partitions, iApp/AS3. Until then the tool emits a diagnostic
(log1/log2) for these rather than mis-converting them.

## Coverage status (current)

**Converted:** nodes/reals, monitors (incl. multi-monitor LOGEXP join),
pools/groups (incl. priority-group→backup, mixed-port members), profiles
(http/XFF, SSL, one-connect), persistence (clientip/cookie), virtuals
(VIP/service/persist/profiles/SNAT→PIP), VLANs, self-IPs, floating IPs, static
routes + default gateway, trunks/LACP, system (mgmt/NTP/syslog/SNMP).

**Diagnostic-only (Phase 4):** iRules, GTM/GSLB, route domains/partitions,
dynamic routing, non-/32 VIP → filter conversion.
