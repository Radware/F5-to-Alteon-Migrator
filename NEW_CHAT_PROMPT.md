# Prompt to continue this project in a new chat (Claude, Codex, any agent)

Claude Code and Codex load `CLAUDE.md` / `AGENTS.md` automatically, so in this
repo a one-line start is enough. Paste this if you want to be explicit:

---

```
Continue the F5-to-Alteon migrator. Repo: rdwr-seanr/F5-to-Alteon-Migrator
(private dev repo, branch main).

Before doing anything: read AGENTS.md (rules, reading order, how to work),
HANDOFF.md (current state, open threads, next steps), and private/CONTEXT.md
(customers, people, how I want answers). For device work also read
private/LAB-ACCESS.md and .claude/skills/alteon-device-validation/SKILL.md.

Then tell me in a few lines what state you found and what you would do first.
Do not publish anything to the public repo or npm without my explicit OK.
```

---

## Notes for whoever starts the chat

- The agent needs access to the PRIVATE repo; `gh` on the owner's machine is
  authenticated as `rdwr-seanr`.
- Live device work needs the Radware VPN (lab is internal).
- Field qkviews are customer data on the owner's machine, never in the repo;
  `private/CONTEXT.md` says where they are.
- Alteon CLI guides (proprietary PDFs) are not in the repo. The device itself
  is the ground truth - see docs/ALTEON-CLI-FACTS.md for how to ask it.
