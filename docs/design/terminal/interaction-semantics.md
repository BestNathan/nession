# Terminal interaction semantics (#1096)

> Requirement: [GitHub #1096](https://github.com/BestNathan/nession/issues/1096).  
> Upstream: [terminal-surface.md](../design-system/patterns/terminal-surface.md).

One **TerminalInteractionController** owns PTY-bound bytes: keyboard (via xterm `onData`), semantic special keys (via xterm helper keyboard events), paste (`terminal.paste`), and committed IME text (`terminal.input`). UI adapters must not embed VT escape tables.

**In scope for this design:** Ctrl+D and other control bytes reach the PTY unchanged; Nession disconnect is an explicit product action only. Bracketed paste, mouse routing, and the deterministic TUI fixture are specified in #1096 Success Criteria and land in implementation phases.

**Out of scope here:** multi-client resize authority (#1095), durable replay (#1094).
