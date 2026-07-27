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

## 3. `ltm virtual-address` attributes - REJECTED, not open

**Status:** closed. There is nothing to build.

Per-VIP ARP and route-advertisement settings have **no configuration surface**
on Alteon 34.5.7: `apropos advertise` returns no commands at all, and
`apropos arp` returns only `/stats/l3/arp`. This is a platform difference, not
a gap in the tool. The attributes stay unconverted; if a migration depends on
them, it needs a network design decision, not a converter feature.

---

## 4. Known environmental (not converter) limits

These recur in every validation round and are **not** defects:

- **Physical ports.** Source chassis/vCMP devices reference ports (3.0, 5.0,
  30, 50, ...) that a 2-port lab VA does not have, so port bindings fail there.
  Flagged per object at conversion time (LIVE-6).
- **Platform capacity.** One real device defines 1,649 pools; the lab VA caps
  at 1,024 real server groups. Warned at conversion time.
- **DHCP-managed management port** on one lab device rejects `/c/sys/mmgmt`.
- **Redacted customer configs.** One customer supplied `x.x.*` placeholders;
  those addresses cannot apply anywhere. Flagged per object.
