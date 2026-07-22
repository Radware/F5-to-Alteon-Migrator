# Copy-paste prompt to continue this project in a new chat

Paste the block below into a fresh chat. It assumes the chat has access to the
private GitHub repo `rdwr-seanr/F5-to-Alteon-Migrator` (and, for live work, the
Radware network / a browser + terminal on Sean's machine).

---

```
I'm continuing an existing project: modernizing Radware's F5-to-Alteon config
migrator. Everything so far is in the PRIVATE GitHub repo:

    rdwr-seanr/F5-to-Alteon-Migrator   (branch: main)

FIRST: read HANDOFF.md, then ROADMAP.md and LAB.md — they describe the full
state. Short version:

DONE (Phases 1-3a + most of 3b item 1):
- Legacy Python tool rebuilt as tested cross-platform Node package
  `@radware/f5-to-alteon` (node/); 35 tests pass (cd node && npm test).
- CLI ingests .qkview/.ucs archives, extracted dirs, or bare conf files
  (auto-detected; multi-GB qkviews stream in seconds).
- Alteon-side live validation PASSED (0 errors) on both lab Alteons:
    Alteon 34.5.7.0  = 10.210.240.137  (admin/radware)
    Alteon 34.0.12.0 = 10.210.240.152  (admin/radware)
  Use validation/validate3.js (NOT validate2 — see LAB.md gotchas: pending-
  changes login prompt, pager, source-IP lockout after rapid SSH connects).
- SIX real production BIG-IP 17.1.2 configs (qkviews on Sean's machine under
  C:\Users\SeanR\Documents\F5 config examples — customer data, NOT committed)
  convert cleanly; the gaps they exposed are fixed (GAP-1..10 + BUG-8 in
  DELTAS.md).
- tools/sanitize.js can scrub a real config for committing as a fixture.

REMAINING (ROADMAP.md Phase 3b):
1. Commit a sanitized real-config fixture (needs Sean's approval of the
   sanitization policy — sources are bank configs).
2. Deploy F5 BIG-IP VE 17.5.x in Azure (subscription "PS-Training"; Sean must
   run `az login` first), build a representative config, export, commit as a
   freely-committable fixture with frozen expected output.
3. Behavioral round-trip: same backends behind the F5 and behind the migrated
   Alteon; compare LB / health / persistence / SSL behavior. Open question:
   Alteon VA availability on Azure Marketplace.
Kill any cloud resources when done.

DO NOT do Phase 4 (iRules, GTM/GSLB, route domains, dynamic routing) — out of scope.

Everything must be validated and verified. Keep the repo as the source of truth:
push changes to GitHub, keep HANDOFF.md / ROADMAP.md / LAB.md current, and make
sure a future chat can continue from the repo state. Bear in mind the tool is
for PS engineers: intuitive, simple, bulletproof.
```

---

## Notes for whoever runs the new chat
- The repo is **private**; grant the new chat/tool access to `rdwr-seanr/F5-to-Alteon-Migrator`.
- `gh` is authenticated on Sean's machine as `rdwr-seanr`.
- Git on the deep Claude session path hits Windows MAX_PATH — work in a short
  path like `C:\gh\...` and `git config --global core.longpaths true`.
- The Alteon guides (proprietary PDFs) are not in the repo; re-attach them if the
  new chat needs CLI-syntax ground truth.
