# Publishing - two repos, one direction

This project lives in **two GitHub repositories on purpose**. Read this before
pushing anywhere.

| Remote | Repository | Visibility | Contains |
|--------|-----------|-----------|----------|
| `origin` | `rdwr-seanr/F5-to-Alteon-Migrator` | **PRIVATE** | The full development history: every commit, customer device names, lab addresses and credentials, validation transcripts. This is the working record and it stays private. |
| `radware` | [`Radware/F5-to-Alteon-Migrator`](https://github.com/Radware/F5-to-Alteon-Migrator) | **PUBLIC** | Sanitized snapshots only. Linked from the npm package; this is what customers and the community see. |

Work normally against `origin`. Publish to `radware` only through the release
script. **Never push a branch to `radware` directly** - that would publish the
entire private history, including the unsanitized early commits.

## Day-to-day development

```bash
git add -A
git commit -m "..."
git push origin main          # PRIVATE repo, full history - always fine
```

Nothing here is restricted. Commit real device names, lab notes and validation
transcripts freely; that is what the private repo is for.

## Publishing a release

```powershell
pwsh tools/publish-public.ps1 -Message "Update: <what changed>; v0.6.0"
```

Add `-Npm` to publish the npm package in the same run, or `-DryRun` to run every
check without pushing anything.

The script refuses to publish unless all of these pass:

1. **Clean working tree** - everything committed to the private repo first.
2. **Sensitive-content scan** (`tools/scan-sensitive.js`) - customer names,
   their site and device hostnames, lab and appliance credentials, npm and
   GitHub tokens, private keys, cloud subscription ids and personal IPs. The
   authoritative pattern list lives in that script. Any hit aborts the publish
   and prints file, line and reason.
3. **Full test suite** (`cd node && npm test`).
4. It then squashes the current tree into **one snapshot commit** on top of the
   public branch and pushes that - the private history never travels.

## Why you cannot do it by accident

`.githooks/pre-push` blocks every push to the public remote unless it comes from
the release script:

```
  BLOCKED: direct push to the PUBLIC repo (Radware/F5-to-Alteon-Migrator).
  Pushing this branch would publish the FULL private development history...
```

The hook is enabled per clone by `core.hooksPath`. **On a fresh clone, run this
once:**

```bash
git config core.hooksPath .githooks
```

Verify it is active at any time:

```bash
git config core.hooksPath        # must print .githooks
```

If that prints nothing, the guard is OFF - set it before you push anything.

## Sanitization conventions

When something must be described in the public repo, use neutral descriptors:

| Private wording | Public wording |
|---|---|
| A named banking customer | "bank fleet A" / "bank fleet B", "a LatAm banking fleet" |
| A named telco customer or one of its sites | "the telco customer", "site A / site B" |
| Real device or appliance credentials | `<user>` / `<password>` placeholders |
| Real device hostnames | omit, or "a production LTM pair" |
| Lab IPs that identify internal infrastructure | keep only where needed for the validation record, never next to credentials |

(This file is scanned like any other, so it deliberately does not spell out the
names it is telling you to remove - see `tools/scan-sensitive.js` for the list.)

Customer configurations are **never** committed to either repo. Every fixture in
`fixtures/` is synthetic or exported from lab devices we own.

## If something sensitive reaches the public repo

1. Do not just delete the file in a new commit - the content stays in history.
2. Rewrite the public branch: build a fresh sanitized snapshot from the current
   tree and force-push it as a new single commit (the public repo has no
   history worth preserving - it is snapshots by design).
3. Rotate anything that leaked (tokens, device passwords).
4. Add a pattern for it to `tools/scan-sensitive.js` so it cannot recur.
