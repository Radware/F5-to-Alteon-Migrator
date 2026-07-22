# HANDOFF — read this first to continue the project

This document lets a new engineer (or a new AI chat) pick up exactly where the
last session finished. Everything needed is in this repo.

## What this project is

A modernization of Radware's internal `F5-Migration` tool, which converts an F5
BIG-IP (tmsh) configuration into a Radware Alteon CLI configuration for PS
engineers doing F5→Alteon migrations. The original tool
(`github.com/Radware/F5-Migration`) is a single ~2,700-line Python function
driving ~40 global variables, shipped as a Flask app + committed .exe, with no
tests. A read-only reference copy is under `legacy-reference/`.

## Current state (as of this commit)

- **Rebuilt tool** — `node/`, an npm package `@radware/f5-to-alteon`. Cross-platform
  Node.js CLI. Accepts a **.qkview/.ucs archive, an extracted qkview directory,
  or bare conf files** (auto-detected; multi-GB qkviews stream in seconds):
  `node node/bin/f5-to-alteon.js <device.qkview | dir | bigip.conf ...> -o out/`.
- **Tests** — `node/test/`, 35 tests, all passing (`cd node && npm test`):
  - `golden.test.js` asserts the Node output equals the frozen legacy output
    byte-for-byte except a fixed, documented set of bug-fix deltas.
  - `unit.test.js` covers each fixed bug (BUG-*) + real-config gaps (GAP-*).
  - `extract.test.js` covers qkview/tar/dir input auto-detection.
- **Alteon-side validation — PASSED** on both target Alteons (0 errors), configs
  applied and reverted non-destructively. Reports in `validation/results/`.
  Lab details (IPs, creds, quirks) in `LAB.md`. Use **`validation/validate3.js`**
  (prompt-aware; `validate2.js` silently validates nothing if the device has
  pending config changes — kept only for reference).
- **Bugs fixed** (all in the legacy tool): see `DELTAS.md` / `KNOWN_BUGS.md`.
  BUG-6/7/8 were found *by* live Alteon validation.

## Phase 3b status (F5-side validation) — IN PROGRESS

Done so far (2026-07-05 session):

1. **Real BIG-IP exports tested.** Six real production config sets (BIG-IP
   17.1.2.x, from qkviews under `C:\Users\SeanR\Documents\F5 config examples`
   on Sean's machine — customer data, NOT committed) all convert cleanly.
   ~900 virtuals total. This surfaced **10 conversion gaps (GAP-1..GAP-10 in
   `DELTAS.md`)** — all fixed + unit-tested, including two regressions vs the
   legacy tool (member ratio, member monitor) and a mis-parse of
   `monitor min N of {...}`.
2. **Live-validated end-to-end on BOTH Alteon versions.** The synthetic
   new-constructs fixture applies with **0 errors** on 34.5.7.0 and 34.0.12.0,
   and the FULL converted production configs (fleet-A ~717 lines, ltm1 ~1145
   lines) apply with **zero converter-attributable errors** — every remaining
   rejected line is environmental (cookie-persistence license, DHCP mgmt
   port, 2-port VA vs multi-slot source hardware). This drove fixes BUG-8 +
   LIVE-1..LIVE-7 (`DELTAS.md`) and a rewritten prompt-aware validator
   (`validation/validate3.js`).
3. **qkview/UCS/dir direct input** (`node/lib/extract.js`) — big ease-of-use
   win: users feed the tool whatever they have.
4. **`tools/sanitize.js`** — remaps public IPs / scrubs customer identifiers so
   a real config can be committed as a fixture (pending Sean's approval on
   policy; sources are bank configs).

Still to do:

1. Commit a sanitized real-config fixture (needs Sean's OK).
2. Deploy F5 BIG-IP VE 17.5.x in Azure (subscription "PS-Training" exists but
   the token expired — **Sean must run `az login`**), build a representative
   config, export, add as a committable fixture.
3. Behavioral round-trip: same backends behind F5 then behind the migrated
   Alteon; compare LB / health / persistence / SSL behavior. Check whether
   Radware publishes an Alteon VA image on Azure Marketplace (else lab Alteons
   + a license question for the cloud).

## Explicitly OUT OF SCOPE right now

**Phase 4 ("migrate more": iRules, GTM/GSLB, route domains, dynamic routing,
non-/32 VIP→filter).** Do not implement unless asked. The tool currently emits a
clear diagnostic (log1/log2) for these instead of mis-converting them.

## Repo layout

```
node/                 The npm package (lib/, bin/, test/, package.json)
  lib/context.js      Per-run state + diagnostics (no globals)
  lib/tables.js       Mapping tables (ported + de-duplicated from legacy)
  lib/parsers.js      One parser per F5 object type -> typed model
  lib/render.js       Model -> Alteon CLI (byte-compatible w/ legacy + fixes)
  lib/index.js        migrate(texts) entry point
  bin/f5-to-alteon.js CLI
fixtures/sample01/    SYNTHETIC config, frozen legacy golden, expected output
validation/           Non-destructive live Alteon validator + results + runbook
legacy-reference/     Read-only copy of the original Python tool
docs/                 Proposal + progress report (Word)
DELTAS.md             Exact documented differences vs legacy output
KNOWN_BUGS.md         The defects found while baselining
ROADMAP.md            Phased plan (Phase 3b = F5 validation is the next step)
LAB.md                Alteon IPs/creds + F5 (to be provisioned) + how-to
NEW_CHAT_PROMPT.md    Copy-paste prompt to continue in a fresh chat
.github/workflows/ci.yml   CI (tests on push/PR)
```

## Verify everything quickly

```bash
cd node
node bin/f5-to-alteon.js ../fixtures/sample01/bigip_base.conf ../fixtures/sample01/bigip.conf -o /tmp/out --name demo
node --test test/golden.test.js test/unit.test.js      # expect: 13 pass
# optional: live Alteon validation (see LAB.md for prereqs)
cd ../validation && ./run_validation.ps1 -Pass radware
```

## Suggested next steps (in order)

1. **Phase 3b — F5-side validation (do this first):**
   a. Deploy an F5 BIG-IP VE (AWS/Azure, v17.5.x), build a representative config,
      export `bigip.conf`/`bigip_base.conf`, add as a new fixture with expected output.
   b. Convert it, apply to both Alteons via `validation/`, confirm zero errors.
   c. Build the behavioral round-trip (same backends+client behind F5 then Alteon)
      and assert equivalent behavior.
2. Expand fixtures with 3–5 sanitized real customer BIG-IP configs.
3. Publish: enable CI on GitHub and `npm publish` under the Radware org.
4. Only then consider Phase 4, one object type at a time, each gated behind a live
   round-trip test.

## Known gotchas

- Alteon fresh VAs force an admin password change at first login; repeated failed
  SSH logins cause a temporary source-IP lockout (`ECONNRESET`). Wait it out.
- `node/lib/tables.js` timezone + service-port maps are subsets; extend as real
  configs require (unmapped values emit a diagnostic and a safe default).
- Non-/32 VIPs are dropped with a diagnostic (legacy tried a filter conversion;
  that path is not yet ported).
- On the deep Windows session path, `git` hits MAX_PATH; work in a short path
  (e.g. `C:\gh\...`) with `git config --global core.longpaths true`.
