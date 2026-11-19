# CLAUDE.md

All project rules, the reading order and the workflows live in AGENTS.md
(shared with Codex and other agents). It is imported here so Claude Code
loads it at session start:

@AGENTS.md

## Claude Code specifics

- Project skills in `.claude/skills/` load on demand:
  `f5-field-issue` (a user reports a problem) and `alteon-device-validation`
  (prove a change on a live Alteon). Invoke them instead of improvising.
- Device gates run 30-120 minutes. Launch them detached and use a Monitor /
  background task on the log, then classify the report when it lands. Never
  poll in a loop and never report a result you have not read.
- Code from outside contributors (fork PRs) may be blocked from running by the
  auto-mode classifier. Review it statically, say what was not executed, and
  ask the owner before running it.
- In the private dev repo, read `private/CONTEXT.md` before replying to a user
  or the owner: it holds the customer mapping and how the owner wants answers
  (short, with an UPDATES section).
