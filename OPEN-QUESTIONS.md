# Open questions - conversions we deliberately did NOT ship

This file exists because "we are not sure" is a legitimate, recorded outcome in
this project. Everything below was investigated on a live Alteon and stopped
short of shipping, with the exact unknown written down so the next person picks
up where the last one stopped instead of re-deriving it.

**The rule:** a conversion ships only when the appliance has demonstrated the
same behavior the F5 had. Otherwise the tool emits a diagnostic and the object
stays a manual task. A missing conversion is recoverable; a plausible but wrong
one is not.

---

## 1. DNS health monitors (`ltm monitor dns`)

**Status:** platform support confirmed, field mapping unproven. Nothing emitted.

**What is proven (live 34.5.7):** `/c/slb/advhc/health <id> DNS` creates a DNS
health check whose menu offers `dns` (a parameters submenu), `protocol`
(TCP/UDP), `dport`, `dest`, `inter`, `retry`, `restr`, `timeout`; the advanced
health-check menu also exposes `domain - Set the domain to be resolved`.

**What is NOT proven:**

- How F5's `qname` (query name) maps: to `domain`, or to a field inside the
  `dns` submenu? The submenu contents were never captured.
- How F5's `qtype` (a / aaaa / etc.) is expressed.
- How F5's `recv` (the expected answer, e.g. a specific IP in the response)
  maps - or whether Alteon only checks that a valid response came back. **This
  is the risky one:** if Alteon cannot assert the answer content, a monitor
  that F5 used to detect a *wrong* answer would silently become a weaker check,
  and a server that should be ejected would stay in rotation.

**To close it:** capture `/c/slb/advhc/health <id> DNS/dns` submenu, build a
check against a real resolver, and prove both the healthy and the *unhealthy*
case (wrong answer -> real server ejected), the same way the other monitors
were traffic-proven in Round 6.

---

## 2. Standalone SNAT (`ltm snat`, `ltm snat-translation`)

**Status:** platform support confirmed, semantic equivalence unproven. Nothing
emitted. (SNAT **pools attached to a virtual** are already converted, as proxy
IPs - this item is only about standalone SNAT objects.)

**What is proven (live 34.5.7):** filters support NAT -
`action allow|deny|redir|nat|monitor|goto|outbound-llb` and
`nat source|dest|mcast`.

**What is NOT proven:**

- Whether a filter with `action nat` + `nat source` reproduces F5 standalone
  SNAT: "traffic *from* these origins leaves with source address X".
- How the translation address itself is specified for a filter (proxy IP,
  PIP per port, or something else) - not captured.
- The **return path**: F5 keeps state so replies are un-translated correctly.
  Whether the filter equivalent needs `rtsrcmac` / `reverse` / `nbind` to
  behave identically was never tested.

**To close it:** build both sides in the lab (client, translated origin,
backend), prove with tcpdump that the backend sees the translated source and
that replies return correctly - i.e. the same packet-level standard used for
the segmentation proof in Round 8.

---

## 3. LTM policies (`ltm policy`) - mechanism PROVEN, conversion not built

**Status:** the URI-routing mapping is fully validated with live traffic, but
the tool does not generate it yet, because the census showed it would apply to
almost nothing. Decision needed (see "What this means" below).

### What the real configs actually contain

Census of **all 94 policies** across the customer fleets:

| | count |
|---|---|
| policies | 94 (70 published, **24 unpublished Drafts**, 7 with no rules) |
| rules | 92 (**36 of them have no condition at all**) |
| strategies | first-match 76, best-match 12, all-match 6 |

Conditions: `http-uri` 26, `http-host` 25, `http-header` 8, `http-cookie` 5,
`geoip` 3, `http-referer` 1, `tcp` 1.

Actions: `asm enable` **34**, `http-header response` 25, `http-header insert`
18, `log write` 16, `tcl set-variable` 8, `http-host replace` 5, `http-reply
response` 5, `shutdown connection` 4, **`forward select` (pool selection) 3**,
`server-ssl disable` 2, `client-ssl` 2, `http-set-cookie` 1. **32 actions embed
TCL expressions.**

So pool selection - the part that maps cleanly onto Alteon content rules - is
**3 actions in the entire fleet**. The bulk is WAF policy attachment (ASM),
header manipulation and logging, which belong to AppWall and AppShape++, not to
content-based server selection.

### What IS proven (live 34.5.7, real traffic through the VIP)

F5 `http-uri starts-with /appb` + `forward select pool_b` maps **exactly** to:

```
/c/slb/layer7/slb/cntclss <id> http/path 1/path appb   <- NO leading slash
/c/slb/layer7/slb/cntclss <id> http/path 1/match prefx <- not "prefix"
/c/slb/layer7/slb/cntclss <id> http/path 1/case ena    <- F5 is case-sensitive
/c/slb/virt <v>/service <p> http/cntrules 1/cntclss <id>
/c/slb/virt <v>/service <p> http/cntrules 1/action group
/c/slb/virt <v>/service <p> http/cntrules 1/group <pool_b>
```

Verified request-by-request: `/appb`, `/appb/`, `/appb/test`,
`/appb/deep/path?q=1`, `/appbextra` reach pool B; `/`, `/index.html`,
`/appa/page`, `/other`, `/xx/appb/yy`, `/APPB/test` reach the default pool -
identical to the F5 policy in every case tested.

### Three traps this test exposed (any of them silently misroutes traffic)

1. **The path value must NOT carry a leading slash.** Configured as `/appb`,
   the rule matched `/xx/appb/yy` but **not** `/appb/test` - the exact inverse
   of the intended routing, with no error anywhere.
2. **The match keyword is `prefx`, not `prefix`.** `match prefix` is rejected
   and the class silently stays at the default `include` (substring), which
   turns "starts with" into "contains".
3. **Matching is case-INSENSITIVE by default** (`case disabled`), while F5
   `starts-with` is case-sensitive. `case ena` is required for equivalence.

### What is still NOT proven

- `http-host`, `http-header` and `http-cookie` conditions (25 + 8 + 5 uses).
  The content class has `hostname`, `header` and `cookie` submenus that look
  analogous, but none were traffic-tested.
- Rule **ordering and strategy**: F5 `first-match` vs `best-match` vs
  `all-match` against Alteon's content-rule evaluation order.
- Negation (`not contains`), multi-value conditions, and multi-condition rules
  (Alteon has `logexp` for combining classes - untested).

### What this means

Building a converter for `forward select` alone would touch **3 objects across
39 devices** while implying that "LTM policies are migrated". The higher-value
deliverable is a **policy inventory** in the logs: per policy, list its rules,
conditions and actions, classify each as *content rule* / *AppShape++* /
*AppWall (ASM)* / *not applicable (draft)*, and quote the F5 source. That turns
94 opaque objects into an actionable worklist without pretending they are
converted.

---

## 4. `ltm virtual-address` attributes - REJECTED, not open

**Status:** closed. There is nothing to build.

Per-VIP ARP and route-advertisement settings have **no configuration surface**
on Alteon 34.5.7: `apropos advertise` returns no commands at all, and
`apropos arp` returns only `/stats/l3/arp`. This is a platform difference, not
a gap in the tool. The attributes stay unconverted; if a migration depends on
them, it needs a network design decision, not a converter feature.

---

## 5. Known environmental (not converter) limits

These recur in every validation round and are **not** defects:

- **Physical ports.** Source chassis/vCMP devices reference ports (3.0, 5.0,
  30, 50, ...) that a 2-port lab VA does not have, so port bindings fail there.
  Flagged per object at conversion time (LIVE-6).
- **Platform capacity.** One real device defines 1,649 pools; the lab VA caps
  at 1,024 real server groups. Warned at conversion time.
- **DHCP-managed management port** on one lab device rejects `/c/sys/mmgmt`.
- **Redacted customer configs.** One customer supplied `x.x.*` placeholders;
  those addresses cannot apply anywhere. Flagged per object.
