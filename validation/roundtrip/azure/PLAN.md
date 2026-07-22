# Azure F5 lab — deployment plan (Phase 3b items 2-3)

Decision (Sean, 2026-07-06): **Alteon side = the on-prem lab devices**;
**F5 side = BIG-IP VE in Azure** (subscription "PS-Training").

## Topology

```
Azure VNet 10.42.0.0/16, subnet "lab" 10.42.1.0/24
  f5ve        Standard_DS3_v2   BIG-IP VE 17.x PAYG (single NIC: mgmt via :8443, traffic same NIC)
              public IP #1 -> primary ipconfig (mgmt/SSH)
              public IP #2 -> secondary ipconfig 10.42.1.100 (the VIP)
  web1, web2  Standard_B1s Ubuntu 22.04, cloud-init runs backend.js (:8080) with ids web1/web2
NSG: 22/8443/443/80 allowed ONLY from Sean's egress IP.
```

- F5 config built via tmsh over SSH: nodes web1/web2, http monitor
  (GET /health), pool with ratio 2:1, cookie-persist HTTP virtual on
  10.42.1.100:80, clientssl HTTPS virtual on :443 (self-signed), plus a
  second pool/virtual without persistence for distribution testing.
- Export: `tmsh save sys config` -> scp `bigip.conf`/`bigip_base.conf`
  (also take a qkview to exercise archive input end-to-end)
  -> commit as `fixtures/sample02-azure/` (no customer data, freely committable).

## Round-trip execution

1. probe.js (from Sean's machine) -> F5 public VIP: distribution,
   persistence, health eject/restore (backends' /admin endpoints exposed to
   Sean's IP only), TLS. -> `report_f5.json`.
2. Convert the exported config. Re-address reals/VIP/self-IPs to the on-prem
   lab (tools/readdress or manual sed — documented), backends = backend.js
   on Sean's machine (same ids). Stage on lab Alteon via validate3, then
   `apply` (window: backup current config first, restore after).
3. probe.js -> Alteon VIP -> `report_alteon.json`; `compare.js` verdict.

## Teardown

`az group delete -n rg-f5a-lab --yes` removes everything (single resource
group). Sean's standing instruction: kill cloud resources when done.
