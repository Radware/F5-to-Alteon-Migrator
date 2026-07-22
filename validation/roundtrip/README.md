# Behavioral round-trip lab (Phase 3b item 3)

Proves the migrated Alteon *behaves* like the source F5 for live traffic, not
just that the config applies. Everything here is LB-agnostic and
zero-dependency (Node built-ins only).

## Pieces

| File | Role |
|------|------|
| `backend.js` | Identifiable test backend (`X-Backend` header, toggleable `/health`) |
| `probe.js` | Runs the behavioral scenarios against ONE VIP and writes a JSON report |
| `compare.js` | Diffs two probe reports (F5 vs Alteon) → parity verdict |

## Scenarios measured

1. **Distribution** — N requests, per-backend tally (catches broken pool
   membership, dead members, weight mistakes).
2. **Persistence** — cookie from first response replayed; all follow-ups must
   hit the same backend.
3. **Health reaction** — one backend is administratively downed via its
   *direct* admin endpoint; the LB must eject it (zero traffic, zero errors)
   and restore it afterwards.
4. **TLS** — run the probe with `--https`; handshake + traffic through the
   TLS-terminating virtual must succeed.

## Intended topology (cloud or lab)

```
client (probe.js)
   │
   ├──> F5 BIG-IP VE VIP ────┐
   │                          ├──> backend.js  web1:8080  web2:8080 ...
   └──> Alteon VIP ──────────┘        (same backends behind both)
```

## Run

```bash
# on each backend VM (ids must match pool members)
node backend.js web1 8080
node backend.js web2 8080

# from a client that can reach both VIPs and the backends directly
node probe.js --vip 10.0.1.100      --label f5     \
  --admin web1=10.0.2.11:8080,web2=10.0.2.12:8080  \
  --hc-wait 20 --out report_f5.json

node probe.js --vip 10.0.1.200      --label alteon \
  --admin web1=10.0.2.11:8080,web2=10.0.2.12:8080  \
  --hc-wait 20 --out report_alteon.json

node compare.js report_f5.json report_alteon.json   # exit 0 = parity
```

Add `--https` for the SSL-terminating virtual. `--hc-wait` should exceed
`interval × retries` of the health monitor on both LBs.
