---
name: alteon-device-validation
description: Prove converter output on a live Alteon VA - probe CLI syntax, stage and APPLY generated configs (validate4), classify the findings, run traffic proofs, and record the round. Use for any change that alters emitted Alteon CLI, before every release, when a field config must be checked before it goes to a customer, or when someone asks "does Alteon support X / did you validate it".
---

# Live Alteon validation

Standing rule from the owner: **always send apply and check for errors.**
Line-level staging alone shipped an apply-blocker once (two gateways with one
IP); never treat staging as a pass again.

Prerequisites: Radware VPN; hosts and logins in `private/LAB-ACCESS.md`
(dev repo only). On a fresh clone install the one harness dependency once:
`cd validation && npm install ssh2@1 --ignore-scripts --no-audit --no-fund`
(not committed; `run_validation.ps1` does the same).

## Tools

| Tool | Use |
|---|---|
| `node validation/alteon-exec.js <host> <user> <pass> <cmds.txt> [transcript]` | send a hand-written command file; MAY contain `apply`; blocks save/boot/reset/shutdown. For probes and traffic-test setup. |
| `node validation/validate4.js <host> <user> <pass> <config.txt> <report.json>` | THE GATE: `revert`, every line, `apply` (all apply errors captured as `line: "APPLY"`), `revert apply`, logout. Prints `DONE ... sent=N [UNSENT=N] realErrors=N APPLY-ERRORS=N`. |
| `validation/validate3.js` | same without apply - only when apply is impossible on purpose |
| `node validation/tools/dangling-refs.js <out-root>` | offline pre-check: virt->group, group->real, backup refs that point at nothing in the same file (each one is an apply-blocker) |
| `node validation/tools/classify-report.js <report.json>` | groups findings by normalized message with an example line |
| `powershell -File validation/tools/apply-gate-lanes.ps1 -TargetHost <ip> -User <u> -Pass <p> -ListFile <files.txt> -Log <lane.log>` | gate many files sequentially on one device (run one lane per lab Alteon in parallel) |

Set `SETTLE_MS=250` for long files (calibrated; the echo check and resend are
the safety net). Runs take ~1 s per line: start long runs detached and watch
the log.

## Procedure for a change

1. `npm test` green; run `dangling-refs.js` on the regenerated outputs (must be 0).
2. Gate **each output file separately** - the main file and every
   `alteon-config-routedomain-N.txt` (in production each goes to its own
   instance; concatenating them creates false cross-file artifacts).
3. Read the DONE line first. `UNSENT>0` or `sent=0` = connection lockout ->
   discard the run, wait 15-20 min with no sessions to that device, rerun.
4. `APPLY-ERRORS` must be 0. Any apply error is a converter defect until
   proven otherwise: find the objects it names in the file, trace them to the
   F5 source, reproduce minimally with `alteon-exec.js`, fix, re-gate.
5. Classify line-level findings with `classify-report.js`. Everything left
   must be in the environmental classes listed at the end of
   `docs/ALTEON-CLI-FACTS.md` (absent chassis ports and their cascade,
   adminkey, DHCP mgmt, per-RD advhc redeclaration, script BOM). Anything else
   is a converter bug.
5b. Gate the all-enabled copy too when the file has disabled virtuals or
   reals: `node validation/tools/enable-all.js <file> <file>.allena.txt`. The
   device skips the apply checks of a disabled virtual (SSLID-1), so a file
   with disabled objects can pass and still refuse when someone enables one.
6. Record a round in `validation/VALIDATION_STATUS.md`: what was gated, on
   which version, the SENT/UNSENT/APPLY numbers, every defect found and fixed,
   and the environmental residue.

## Probing syntax (device truth)

Write a command file and send it with `alteon-exec.js`:

```
/c/slb/virt probe1
ena
ipver v4
vip 10.99.99.1
/c/slb/virt probe1/service 53 dns
zzz            <- prints the whole menu
protocol       <- prints the current value / Usage
apply
/c/slb/virt probe1/service 53 dns/cur   <- read back what the device kept
/c/slb/virt probe1/del
apply
```

Use 10.99.99.x for probe VIPs (no data path needed). Delete what you created
and apply, or `revert apply` at the end. To prove an APPLY-time rule, build
the minimal pair that triggers it (two gws with one IP, two reals with one
ip:addport...), apply, record the exact error text, then delete.

## Traffic proofs (behavior, not just syntax)

Needed when a mapping changes what traffic does (NAT, filters, segmentation,
persistence, content rules). Lab wiring and VM servers are in
`private/LAB-ACCESS.md`. Pattern used for every proof so far:

1. Baseline WITHOUT the feature (show the behavior F5 would forbid, e.g. the
   VIP answers from both VLANs).
2. Apply the converted construct; show the intended behavior (allowed path
   answers, other path times out; backend's `CLIENT-SEEN-BY-BACKEND=` shows the
   NAT source; tcpdump `-e` on the VM shows MAC-level redirects).
3. A CONTROL that must stay unaffected (a second VIP without the feature).
4. Clean up every object, re-check port PVIDs and VLAN membership (a port left
   in two untagged VLANs refuses the next apply), `revert apply` if unsure.

## Lessons that cost time

- A validator that reported 0 errors once had sent nothing (lockout). Always
  check SENT/UNSENT.
- The first long file is slower than estimated; one 7,455-line file takes ~1.5 h.
- Results written to a temp folder disappear with the session - copy the
  reports you cite into `validation/results/` (sanitized) or summarize them in
  VALIDATION_STATUS.md.
- A watcher on the lane log exits on the first apply error, but the lane
  keeps running. Stop the lane (its powershell and validate4 processes)
  BEFORE probing the same device: a probe's `revert apply` in the middle of a
  lane run corrupts both results (it happened once; the file was re-gated).
- `pip/rem` takes the PIP ID (see `/c/slb/pip/cur`), not the address.
- A line answered with only a `Usage:` line was REFUSED (USAGE-1), even
  without the word "Error". validate4 reports it; never classify it as noise.
- The harness answers every y/n prompt, but a customer PASTES the config, and
  a prompt then swallows the next line(s) (PROMPT-1). validate4 reports any
  config line that prompts as "PROMPT (paste trap)" - that is a converter
  defect. Probe the paste behavior with `PASTE_SIM=1 node validation/alteon-exec.js ...`
  (answers only the login note), and look for a non-prompting form of the
  command (e.g. `/c/port N/pvid V` before `/c/l2/vlan V/add N`).
- Probe on BOTH lab Alteons when the result depends on device state, not only
  syntax: the 34.5.7 VA has port 2 in a lab VLAN, so VLAN membership changes
  that assume factory-default ports (all in VLAN 1) refuse there and apply on
  the 34.0.12 VA. Read `/c/port N/cur` and `/c/l2/vlan 1/cur` first.
- A VPN drop stops both lanes mid-file. The lane script waits for SSH and
  reruns the file; the interrupted run shows `UNSENT>0` and is void.
- Before a release, diff every output file of the final build against the
  copy that was last gated (byte-identical = covered); anything changed or
  only gated on an old build goes into one more lane.
- Apply on a large config runs for minutes. A report is only real if the
  transcript shows "Apply complete" / "Apply not done" / "No apply needed"
  after `>>> apply` and "Unsaved changes reverted" after `>>> revert apply`
  (APPLYWAIT-1: before validate4 waited for these, big files "passed" with no
  apply result read and one left its config applied on the lab).
