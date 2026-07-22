# Lab & validation environment

## Alteon appliances (Radware VMware lab) — AVAILABLE

| Version | Mgmt IP | Credentials | Notes |
|---------|---------|-------------|-------|
| 34.5.7.0  | `10.210.240.137` | internal (PS team) | Latest maintenance stream target |
| 34.0.12.0 | `10.210.240.152` | internal (PS team) | Prior stream target; mgmt interface is DHCP-managed |

> Internal lab devices reachable from the Radware network. Both are Alteon VA on
> VMware. Fresh VAs force an `admin` password change on first access.

### Alteon access notes learned during validation
- SSH (22) and HTTPS/WBM (443) both open. `ssh2` (Node) negotiates with default
  algorithms once first-login is complete.
- **`read ECONNRESET` on connect — root cause found (2026-07-05):** the device
  holds every CLI session until its idle timeout, and a script that ends with
  a submenu-level `exit` (or just drops the socket) NEVER logs out. Each
  validator run therefore leaked one session; once the concurrent-session
  table filled, the device accepted TCP (banner still sent) but reset the
  connection at/after auth. Recovery: wait ~15+ minutes with no connections
  for the leaked sessions to idle out. Prevention (in validate3.js): finish
  with `/` then `exit` so the session actually logs out. Symptom check: you
  can read the `SSH-2.0-Alteon` banner but a real login gets reset.
- On `10.210.240.152` the management port is DHCP-managed, so manual
  `/c/sys/mmgmt addr|mask|gw` is rejected — environmental, not a converter bug.
- **Never kill a validator run mid-session** (Ctrl-C / task stop): the CLI
  session leaks server-side and, combined with rapid reconnects, trips the
  device's connection protection — subsequent SSH handshakes time out for
  ~15-20 minutes on BOTH the killed device and any device you then hammer.
  Let runs finish (they always log out) or wait out the window afterwards.
- **If the device has pending (un-applied) config changes, login shows
  "Confirm seeing above note [y]:"** and every command typed before answering
  is swallowed. `validate2.js` fell into this (it "validated" a whole config
  with 0 errors while nothing executed); `validate3.js` answers the prompt and
  begins with a clean `revert`. Always use validate3.
- Long output (`diff`) triggers a pager ("Press q to quit…") even with a tall
  pty; validate3 pages through it.
- Some commands are interactive: bare `maxcon <n>` prompts for a mode and eats
  the next pasted line. validate3 flags any such value-prompt as a
  "not paste-safe" finding — treat those as converter bugs.

## Real F5 configs on Sean's machine (used 2026-07-05, NOT committed)

Kept locally (NOT in the repo) — six real production config sets
(BIG-IP 17.1.2.x, large banking environment): extracted qkview dirs, several
raw `.qkview` files, and one 2.5 GB uncompressed-tar qkview. All feed the CLI
directly (qkview support). **Customer data — never commit, even partially;
sanitize and get approval first.**

## F5 BIG-IP VE in Azure — TORN DOWN 2026-07-08 (round trip complete)

`az group delete -n rg-f5a-lab` executed after the parity verdict; redeploying
takes ~30 min using `validation/roundtrip/azure/` (PLAN.md + f5conf.js + the
cloud-init) if ever needed again. Details below kept for the record.

## (historical) F5 BIG-IP VE in Azure — provisioned 2026-07-06 (rg-f5a-lab, eastus)

| Resource | Details |
|----------|---------|
| Subscription | Radware PS Azure subscription (internal) |
| f5ve | BIG-IP VE **17.5.1.06** GOOD/25M PAYG hourly, Standard_DS3_v2, single-NIC |
| f5ve mgmt | SSH + GUI on the VM's public IP (credentials were rotated; resources deleted) |
| f5ve private / VIP | self 10.42.1.10; VIP secondary IP **10.42.1.100** behind a public IP (ports 80/443) |
| web1 | 10.42.1.11 — backend.js id `web1` on :8080 (systemd, cloud-init) |
| web2 | 10.42.1.12 — backend.js id `web2` on :8080 |
| Network | vnet-f5a 10.42.0.0/16, subnet lab 10.42.1.0/24; ALL access locked to a single admin egress IP (subnet NSG + per-NIC NSGs) |

**F5-side behavioral baseline (2026-07-07, probe run from web1 inside the VNet
— corporate egress blocks outbound 80/443 to raw IPs, so probe in-VNet):**
distribution 40:20 (= configured 2:1 ratio), RDWRLAB cookie persistence 20/20
sticky, health eject+restore clean, TLS virtual same results. Reports in the
session scratchpad + summarized in `validation/VALIDATION_STATUS.md`.

**Teardown when done (Sean's standing instruction):**
`az group delete -n rg-f5a-lab --yes --no-wait`

## Round-trip lab state (2026-07-08) — PARITY PASSED

- **Backend VM (Sean-deployed)**: Ubuntu 22.04, `10.210.240.158`
  (credentials internal), second NIC on Sean-Servers-2121 (unused — the mgmt
  net path sufficed). Runs `backend.py web1` on 10.210.240.158:8080 and
  `backend.py web2` on secondary IP 10.210.240.203:8080 (setsid, survives
  logout; secondary IP added via `ip addr add`, NOT persistent across VM
  reboot). `probe.py` + reports in `/home/radware/`.
- **Alteon .137 applied (NOT saved) round-trip config**: L3 if 1 =
  10.210.240.200/24, gw 10.210.240.1, SLB on, reals web1/web2 → the backend
  VM, VIP **10.210.240.210** (vs_web :80 cookie-persist, vs_api :8081), PIP
  10.210.240.211. A reboot wipes all of it by design.
- **IP-conflict lesson**: ping-scanning the lab subnet from the VPN gives
  FALSE negatives (ICMP filtered). 10.210.240.201 was actually an existing
  VM. Always scan from a host inside the L2 (see `scan.sh` approach) before
  picking VIPs/PIPs.
- The VPN path to the lab passes 22/80/443 but filters high ports
  (18081+ unreachable even when listening) — run probes from inside the lab.
- `.152` was left untouched (staging validations only, always reverted).

## (historical) On-prem Alteon data-plane discovery (2026-07-07)

- `.137` now has an **applied but NOT saved** L3 config for the round-trip:
  `/c/l3/if 1` = 10.210.240.200/24 vlan 1, `/c/l3/gw 1` = 10.210.240.1.
  A reboot wipes it (nothing was saved to FLASH).
- Finding: VA data ports 1/2 are link-up and see busy L2 segments (FDB shows
  live VMware MACs; port 1 → VLAN 1 segment, port 2 → VLAN 2 segment), but
  **neither segment is the mgmt subnet**: gateway 10.210.240.1 never ARPs and
  the interface IP is unreachable from the VPN. The VAs' data NICs sit on
  different vSphere port groups than management.
- **Needed from Sean**: which subnet/VLAN the data port groups carry, a free
  IP for the Alteon interface + one for the VIP, whether that segment has
  internet egress (to reach the Azure backends), and whether the lab VAs can
  get a **cookie-persistence license** (otherwise the persistence parity test
  must use clientip persistence).
- Fallback if the lab segment is unusable: Radware publishes Alteon VA on
  Azure Marketplace (`radware:radware-alteon-va:radware-alteon-ng-va-adc`,
  latest 33.5.9, presumably BYOL) — an in-VNet Alteon next to the F5.

## (superseded) F5 deployment prerequisites

- Azure CLI on the admin machine has an internal PS subscription but the token
  may be expired — **run `az login` first**. (AWS CLI exists but hits SSL
  interception errors on this network.)
- **Deploy a BIG-IP VE**, target **v17.5.x** (current LTS), PAYG marketplace
  image; a small instance (2 vCPU/8 GB, e.g. Standard_DS3_v2) is enough.
- **Build a representative config** (VLANs, self-IPs, nodes, pools, monitors,
  virtuals, persistence, profiles) mirroring what PS sees.
- **Export** `bigip.conf` + `bigip_base.conf` via tmsh (`tmsh save sys config`,
  pull `/config/bigip*.conf`) — or just take a qkview; the CLI eats it whole —
  and add under `fixtures/` with frozen expected output (no customer data, so
  freely committable).
- **Behavioral round-trip:** deploy backends + a client, place the app behind
  the F5, then behind the migrated Alteon, compare behavior. Check Alteon VA
  availability on Azure Marketplace; if BYOL-only, a license is needed.
- **Tear down all cloud resources when done** (Sean's standing instruction).

Record the F5 IP/creds/version here once provisioned.

## Reference documentation (not committed)
Proprietary and large, so not in this repo:
- `AlteonOS-34-5-7-CLI_Application_Guide.pdf` (~17 MB)
- `AlteonOS-34-5-7-WBM_GettingStartedGuide.pdf`

Key Alteon syntax confirmed from the guide + live devices:
- Group metric: `roundrobin`, `leastconns`, `response`, … (NOT `round-robin`).
- Health check: `/c/slb/advhc/health <name> <TYPE>`.
- Virtual service: `/c/slb/virt <name>/service <port> <application>`.
- Floating IP: `/c/l3/ha/floatip <id>`.
- **Static route** (validation finding): `/c/l3/route/ip4/add <dst> <mask> <gw>`
  as a single command — the `/c/l3/route` menu has no `add`.
- **VLAN port** (validation finding): `add <numeric-port>` — F5 `1.1`/`1.2`
  interface names are rejected as "bad port".

## How to run live Alteon validation

Prereq: a machine on the Radware network with Node.js; device first-login done.

```bash
cd validation
npm install ssh2 --ignore-scripts
node validate3.js 10.210.240.137 <user> <password> sample01_alteon_config.txt results/report_34_5_7_0.json
node validate3.js 10.210.240.152 <user> <password> sample01_alteon_config.txt results/report_34_0_12_0.json
```

(`validate2.js` is kept for reference only — it silently validates nothing
when the device has pending config changes; see access notes above.)

The validator streams the generated config, records any rejected line, then
**reverts every change** and exits. It never sends `apply`, `save`, `boot`,
`reset`, or `shutdown` (hard-gated). See `validation/VALIDATION_STATUS.md`.
