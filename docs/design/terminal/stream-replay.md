# Terminal stream & replay (#1094)

> Requirement: [GitHub #1094](https://github.com/BestNathan/nession/issues/1094).

Session-scoped ordered terminal events (output + resize in one timeline), bounded checkpoints, gap detection on resume, and a **read-only Replay** instance while live continues. Not a replacement for #321 local scrollback.

Depends on #1096 (resize in timeline) and interoperates with #1095 (Observer replay while not Controller).

Protocol direction: independently evolvable terminal Protocol Units (e.g. stream resume, checkpoint, replay range) per `docs/architecture/protocol.md` — not overloaded onto fire-and-forget `agent.terminal.output` alone.
