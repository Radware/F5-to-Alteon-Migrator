# Contributing

**Please open an issue whenever something does not convert the way you expect.**
Almost every improvement in this tool came from someone sending a real
configuration that did not work - 37 defects were found and fixed exactly that
way. If you hit something, we want to hear about it, even if you are not sure
it is a bug.

## Reporting an issue

Use one of the [issue templates](https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose):

- **Conversion problem** - something converted wrongly, was skipped, or the
  Alteon rejected the generated line.
- **Tool bug** - a crash, a CLI/packaging problem, valid input refused.
- **Feature request** - support for an F5 construct we do not convert yet.

### What makes a report immediately actionable

The more of this you can include, the faster it gets fixed:

1. **The F5 configuration involved** - the actual tmsh stanza. If the tool
   flagged the object, `needs-manual-work.txt` already quotes the original
   block for you; paste it from there.
2. **What the tool produced** - the matching lines from `alteon-config.txt`,
   plus the relevant entries from `needs-manual-work.txt` / `not-supported.txt`.
3. **The exact Alteon error**, if the device rejected the config, with the
   command that triggered it.
4. **Versions** - the tool version, the BIG-IP version (`#TMSH-VERSION` on line
   one of `bigip.conf`), and the target Alteon version/platform.
5. **The command you ran.**

Attaching the full config or qkview is welcome when you are able to - it lets us
reproduce exactly and add a regression test. See the privacy note below first.

### Privacy - please read before attaching files

F5 configurations contain IP addresses, hostnames, certificate names, SNMP
communities and sometimes credentials. **GitHub issues are public.**

- Sanitize before attaching, or attach only the specific stanza.
- Never attach `.ucs` archives or private keys - they contain secrets.
- If the configuration cannot be shared publicly at all, say so in the issue.
  Radware customers can send it privately via a
  [Radware support case](https://support.radware.com) or their Radware contact,
  referencing the issue number. We will work from the private copy and keep the
  public issue to the technical discussion.

We never commit customer configurations to this repository. Every fixture here
is synthetic or generated from lab devices we own.

## Contributing code

1. Fork, branch, and make your change.
2. **Add a regression test.** Every behavioral change in this project is locked
   by a test in `node/test/`, and every fix that came from a live device
   records the device error in `DELTAS.md`.
3. Run the suite:
   ```bash
   cd node
   npm test
   ```
4. Keep the CLI dependency-free - the package ships with zero runtime
   dependencies and must stay that way.
5. Open a pull request describing the F5 construct involved and the Alteon
   syntax it maps to. If you validated on a real appliance, say which version -
   that is the bar for calling a conversion supported.

## Validating against a real Alteon

`validation/` holds the harness used for every release: it streams a generated
config into a device, records any rejected line, and reverts everything
(it never sends `apply`, `save`, `boot`, or `reset`). See
[`validation/VALIDATION_STATUS.md`](validation/VALIDATION_STATUS.md) for how
each round was run and what it proved.
