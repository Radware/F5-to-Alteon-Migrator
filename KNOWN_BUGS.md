# Known bugs found while capturing the Phase 1 baseline

These are real defects in the current tool, surfaced immediately by running
it against a representative config. They are documented here (not yet fixed)
so they can be fixed deliberately during the refactor, each with a regression
test and a golden-file update under review.

## BUG-1 — Standalone (non-HA) self-IP crashes the tool

**Symptom:** running against a config whose `net self` stanzas have no
`traffic-group-local-only` variant throws `KeyError` at output time:

```
File "app/f5_mig.py", line 2587, in fun_f5_mig
    float_id, floatIfDict[x]['addr'], floatVlanDict[floatIfDict[x]['vlan']]))
KeyError: '10'
```

**Root cause:** `isSelf` is only set when the string `local-only` appears in
the self-IP block (f5_mig.py:1437). Any self-IP without a local-only traffic
group is misclassified as a floating IP and pushed into `floatIfDict`. At
render time (f5_mig.py:2583) the code looks up `floatVlanDict[<vlan tag>]`,
which is only populated for `isSelf` interfaces — so a config without HA
local-only self-IPs has an empty `floatVlanDict` and crashes.

**Impact:** the tool cannot process a standalone (non-HA) BIG-IP config, a
very common case. Today it must be an HA pair with local-only + floating
self-IPs (as our sample01 fixture now is).

**Fix direction:** treat float/self classification explicitly from
`traffic-group`, and emit a diagnostic (not a crash) when a referenced VLAN
is missing.

## BUG-2 — State leaks between runs (global-state bug, confirmed live)

**Symptom:** parsing `bigip_base.conf` (which has routes) and then
`bigip.conf` (which has none) in the same process produces a `bigip.conf`
output that **contains the base file's route**:

```
# main_output.txt, though bigip.conf defines no routes:
/c/l3/route
    add 10.10.30.0 255.255.255.0 10.10.20.1
```

**Root cause:** `route_list` (and other module-level state) is not reset by
`fun_create_empty_dicts()`, so values carry over between `fun_f5_mig()`
calls. In the Flask app this same mechanism lets one user's upload leak into
another's — a correctness and data-isolation bug.

**Fix direction:** the new `f5alteon` package eliminates this entire class of
bug by moving all state onto a per-run `RunContext` (see
`f5alteon/context.py`). `tests/test_reals.py::test_runs_are_isolated` is the
regression guard.

> The frozen golden files under `fixtures/*/golden/` currently capture this
> buggy behavior on purpose — that is what "characterization" means. When
> BUG-2 is fixed in the legacy path (or the legacy path is retired in favor
> of `f5alteon`), the affected golden file is updated in the same reviewed
> commit.
