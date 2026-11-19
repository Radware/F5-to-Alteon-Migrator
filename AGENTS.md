# AGENTS.md - start here (Claude, Codex, or any coding agent)

This repo converts an **F5 BIG-IP (tmsh) configuration into a Radware Alteon
CLI configuration**. It ships as the npm package `@radware/f5-to-alteon`
(`node/`), used by Radware PS engineers on real customer migrations. It
replaced the legacy Python tool `F5-Migration` (read-only copy in
`legacy-reference/`).

The bar is not "plausible output". The bar is **output that applies on a real
Alteon and behaves like the F5 did** - proven on live devices. Everything in
this file exists to keep that bar.

## Read in this order

1. **[HANDOFF.md](HANDOFF.md)** - current state, what is unreleased, open
   threads, prioritized next steps. Read before changing anything.
2. **This file** - rules and how to work.
3. **[docs/ALTEON-CLI-FACTS.md](docs/ALTEON-CLI-FACTS.md)** - device truths
   learned the hard way (syntax, silent traps, apply-time refusals). Check it
   before emitting any new Alteon command.
4. **[DELTAS.md](DELTAS.md)** - every behavior change, with its ID (BUG-*,
   GAP-*, LIVE-*, PART-*, ...), the evidence, and the fix.
5. **[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)** - conversions deliberately NOT
   shipped, with the exact unknown that blocks each.
6. **[validation/VALIDATION_STATUS.md](validation/VALIDATION_STATUS.md)** - the
   validation rounds, what was proven on which device and how.
7. **[PUBLISHING.md](PUBLISHING.md)** - two-repo model; how to release.
8. If you are in the private dev repo: **`private/`** - lab logins, customer
   context, people, and how the owner works. It is not in the public repo.

Workflows packaged as skills (Claude loads them automatically; any agent can
read them as plain docs):
- [.claude/skills/f5-field-issue/SKILL.md](.claude/skills/f5-field-issue/SKILL.md) - a user reports a problem
- [.claude/skills/alteon-device-validation/SKILL.md](.claude/skills/alteon-device-validation/SKILL.md) - prove a change on a live Alteon

## Repo map

```
node/                    the npm package (zero runtime dependencies)
  bin/f5-to-alteon.js    CLI: auto-detects input, auto-named output folder, bulk mode
  lib/extract.js         qkview/UCS/tar/dir/conf input; partitions; partition tags
  lib/parsers.js         one parser per F5 object type -> model on the Context
  lib/render.js          model -> Alteon CLI (+ pre-render consistency passes)
  lib/index.js           migrate(); name folding; route-domain split / segmentation
  lib/context.js         per-run state + diagnostics (log1 = manual, log2 = unsupported)
  lib/tables.js          F5 -> Alteon mapping tables
  test/                  node:test suites (golden, unit, extract, fixtures)
fixtures/                synthetic + sanitized configs with frozen expected output
validation/              live-device harness (validate4 = the gate), results, roundtrip
  tools/                 report classifier, cross-reference checker, fleet lanes
tools/                   publish-public.ps1, scan-sensitive.js, sanitize.js, dev-setup.js
docs/                    user guide (DOCX+PDF), ALTEON-CLI-FACTS.md, proposal/report
legacy-reference/        original Python tool - reference only, never edit
private/                 dev repo only - stripped from every public release
```

## Golden rules

DO:
- **Validate on a live Alteon, with apply.** Every change to emitted CLI is
  staged line-by-line AND applied, and apply errors are captured
  (`validation/validate4.js`). Line staging alone misses cross-object checks
  (duplicate gateways, dangling health checks, duplicate addports...) - a field
  user found one before we did. See the device-validation skill.
- **Find device truth before writing syntax.** `apropos <term>`, send a
  deliberately invalid command (`zzz`) to list a menu, send a command with no
  argument to get its Usage line, then build -> apply -> `cur` read-back.
  Record what you learned in DELTAS.md and docs/ALTEON-CLI-FACTS.md.
- **Put aside, don't guess.** If a construct cannot be converted with certainty
  (an address you can't resolve, a reference into another route domain, an
  unproven mapping), do not emit it. Emit a `ctx.warnManual(...)` diagnostic
  that says what was not converted, why, and the exact manual step, quoting the
  F5 source. A missing line is recoverable; a wrong line that applies is not.
- **Every fix carries its proof**: a regression test named with the DELTAS ID,
  a DELTAS.md row (symptom, evidence, fix), and - for device-visible changes -
  a validation round in VALIDATION_STATUS.md.
- Run the real field data you have (fixtures + any qkviews the owner points
  to) through the CLI after a change and look at the diff, not just the tests.
- Keep HANDOFF.md current at the end of a work session: state, unreleased
  work, next steps. The repo must be enough for the next agent.
- Use normal hyphens `-`, never long dashes, in every doc and message.

DO NOT:
- **Never publish with `git push radware`.** Release only via
  `tools/publish-public.ps1` (it scans, tests, strips `private/`, squashes).
  The pre-push hook blocks direct pushes.
- **Never commit a customer config, hostname, domain or credential** outside
  `private/`. Use neutral names ("bank fleet A", "device A"). Fixtures must be
  synthetic or run through `tools/sanitize.js`. `node tools/scan-sensitive.js`
  must stay clean.
- Never `save` on a lab Alteon. `revert apply` restores the config, but the
  device keeps stale VLAN entries (SEGVLAN-1) that only a reboot clears. The
  owner gave a standing OK to reboot the lab VA when a clean device is needed:
  a command file with the single line `/boot/reset`, run with
  `ALLOW_REBOOT=1 node validation/alteon-exec.js ...` (executed 2026-11-17: the
  device confirms and resets, SSH drops with ECONNRESET). Never reboot while a
  gate lane is running.
- Never trust a validation run that shows `UNSENT>0` or `sent=0`: that is a
  connection lockout, not a pass.
- Never "fix" a field report about the legacy Python tool (Python traceback,
  `local_runner.py`, `f5_mig.py`). Point the user to `@radware/f5-to-alteon`.
- Don't add runtime dependencies to `node/` (zero-dependency is deliberate).
- Don't build iRule -> AppShape++ conversion: the owner excluded it. iRule ->
  content rules and ASM -> SecWA were requested by the field but are not
  started (see HANDOFF.md).

## Dev loop

```bash
cd node && npm test                                   # all suites must pass
node bin/f5-to-alteon.js ../fixtures/sample01/bigip_base.conf ../fixtures/sample01/bigip.conf -o ../out/sample01
node bin/f5-to-alteon.js device.qkview                # -> ./device/ next to the input
node bin/f5-to-alteon.js C:\path\to\qkviews           # bulk: one folder per device
node bin/f5-to-alteon.js device.qkview --rd-mode split   # auto | segment | split
node ../tools/scan-sensitive.js                       # must print "clean"
```

Outputs per device: `alteon-config.txt` (route domain 0 + device-level
system config), `alteon-config-routedomain-N.txt` (one per RD in split mode,
each for its own Alteon instance), `needs-manual-work.txt` (log1, each item
quotes the original F5 stanza), `not-supported.txt` (log2).

## Definition of done for a change

1. Root cause understood and stated (not just the symptom silenced).
2. Device truth recorded if new syntax/behavior was involved.
3. Regression test(s) named `<ID>: ...`; `npm test` green.
4. DELTAS.md row; OPEN-QUESTIONS.md updated if something was left unproven.
5. Field data re-converted; the relevant output files pass `validate4`
   (zero apply errors, every remaining line-level finding classified as
   environmental - the classes are listed in the validation skill).
6. VALIDATION_STATUS.md round written for device-visible changes.
7. Committed and pushed to the private repo (`git push origin main`).
8. Released only when the owner asks: bump `node/package.json`, then
   `powershell -NoProfile -File tools\publish-public.ps1 -Message "..." -Npm`.

## Code conventions

- CommonJS, Node >= 16 (CI tests 18/20/22). No dependencies.
- Diagnostics: `ctx.warnManual(type, name, issue, detail)` for things the
  engineer must finish; `ctx.warnUnsupported(...)` for no-equivalent items.
  The message names the object, says what was or was not emitted, and gives
  the exact Alteon command to finish the job.
- Comment a fix with its ID and evidence, e.g.
  `// LIVE-22: pbind ssl is silently ignored (verified on 34.5.7)`. Comments
  state device constraints the code cannot show; no narration.
- Names: Alteon IDs are max 32 chars, no special characters; rename
  deterministically and fix every reference (see `shortenIds`, `foldNameCollisions`).
- Per-RD split: `splitByRouteDomain` creates sub-contexts; anything that
  references across them must be resolved there (SPLIT-2), never left dangling.

## Environment notes (owner's Windows machine)

- Shells: PowerShell 5.1 (no `&&`, no ternary) and Git Bash both work. The
  agent permission checker sometimes misreads regex strings containing `\S+`
  or `\+` as paths; move such logic into a script file.
- Long jobs (device gates take 30-120 min): run detached
  (`Start-Process ... -RedirectStandardOutput`) and watch the log; a single
  foreground command is capped at 10 minutes.
- Outlook `.msg` attachments from users: open with Outlook COM
  (`OpenSharedItem`) to read body and attachments.
- Radware-branded Word/PDF (the user guide): use the `radware-technical-writer`
  skill (copy in `private/skills/` in the dev repo) and its official template;
  every copy-pastable command in a shaded code box. There is no generator
  script for the guide - edit the DOCX per the skill, then re-export the PDF.
