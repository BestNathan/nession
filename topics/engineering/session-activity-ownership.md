---
title: "Session Activity ownership"
description: "Capability-reported Session work (working/idle/unknown plus orthogonal input_required), semantic Pane ownership and generation fencing, the Shell and Claude providers, and the Server/Web/App projection delivered by #3800, #3801, #3802 and #3804"
topic: engineering
categories: ["agent","architecture","protocol","session","web"]
status: verified
created_at: 2026-11-18T04:51:45Z
updated_at: 2026-11-27T15:20:00Z
sources: ["https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/architecture/session-activity.md","https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/design/design-system/patterns/session-item.md","https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/architecture/agent-process-discovery.md","https://github.com/BestNathan/nession/issues/3800","https://github.com/BestNathan/nession/issues/3801","https://github.com/BestNathan/nession/issues/3802","https://github.com/BestNathan/nession/issues/3804"]
---

# Session Activity ownership

## Decision

Nession Sessions expose a fourth, independent state dimension — **Session
Activity**: `working`, `idle` or `unknown`, with an orthogonal
`attention: input_required` signal. It is not lifecycle, Agent connectivity or
client attachment, and none of those may be inferred from or written by it.

- **One Agent-owned coordinator.** A capability provider interprets its own
  workload; `SessionActivityCoordinator` resolves Pane ownership, fences stale
  observations and aggregates the Session. Server and UI consume only that
  projection. `SessionWatcher` supplies verified tmux facts; it is not a second
  activity oracle.
- **Ownership is semantic, not a priority.** A specialized claim (including a
  specialized `unknown`) precedes a generic Shell claim; two claims of the same
  class are an ambiguity, so the Pane is `unknown`. A changed foreground
  workload or a recreated Session incarnation retires the previous owner before
  new claims are read.
- **Aggregation.** Any observed `working` wins; otherwise any `unknown` makes
  the Session `unknown`; only all-observed-idle is `idle`; a Session with no
  observable Pane is `unknown`, never `idle`.
- **Shell evidence.** `ShellActivityProvider` compares the Pane root's own and
  terminal-foreground process groups (`/proc/<pid>/stat` `pgrp`/`tpgid` on
  Linux, `PROC_PIDTBSDINFO` `pbi_pgid`/`e_tpgid` on macOS). Same group with a
  known interactive shell is the prompt (`idle`); a different foreground group
  or a non-shell command is `working`. A backgrounded job leaves the shell in
  front, and missing evidence is `unknown`.
- **Claude evidence.** `ClaudeActivityProvider` consumes #3779's verified
  `ClaudeControl::status`: busy → working, waiting → working + input_required,
  idle → idle. It owns a Pane only when the verified Claude PID is in that
  Pane's process tree; an unbound PID or unreadable status while Claude is in
  the tree is owned as `unknown`, so Shell cannot claim it. No Claude process
  releases the Pane. The command name `claude` alone never proves ownership.
  The same verified-observation cache is the conversation read path's window
  onto the live identity (#4664) — one cache, not a second observation engine:
  [Claude conversation identity resolution](claude-conversation-identity-resolution.md).
- **Transport.** The Agent publishes a dedicated, one-way
  `server.agent.session-activity` notification (incarnation, Agent epoch,
  monotonic generation, state, attention, capability, observed time). It is
  separate from `session-update` because Activity is not interaction recency.
  The Server keeps the level in memory, refuses stale
  incarnation/epoch/generation, preserves a same-incarnation level across
  inventory and force-refresh replacement, and shares one serializer between
  `server.session.list` and `server.sessions.changed`.
- **Presentation.** The existing Session row gains one fixed-size monochrome
  glyph slot: working arc, quiet idle outline, explicit `?` for unknown, and a
  warning glyph plus a `Needs input` line for attention. A row projects
  `unknown` whenever its Agent is offline or stale and never rewrites recency,
  selection, the row menu or the resting Terminal Capsule.

## Context and evidence

Delivered on staging at `7e82d7d21` through #3800 (core), #3801 (Claude
adapter), #3802 (Shell provider) and #3804 (Server/Web/App projection). All
Issue Success Criteria passed on the merged staging SHA; the native Cases use
real tmux Panes and a CLI-compatible Claude fixture, and the browser Cases use
Chromium at Web 1180/1024 and App 390/375 with touch.

The canonical technical owner is
[`docs/architecture/session-activity.md`](https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/architecture/session-activity.md);
the row contract is
[`session-item.md`](https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/design/design-system/patterns/session-item.md);
the one-process group read is documented in
[`agent-process-discovery.md`](https://github.com/BestNathan/nession/blob/7e82d7d21e0ab368e816d7633bd495a3cf78fa5b/docs/architecture/agent-process-discovery.md).

## Related knowledge

- [Claude conversation identity resolution](claude-conversation-identity-resolution.md)
- [Nession sandbox policy and execution isolation architecture](nession-sandbox-policy-and-execution-isolation-architecture.md)
- [Session metadata and display identity ownership](session-metadata-and-display-identity-ownership.md)
- [Terminal parser progress and exception reconciliation](../terminal/terminal-parser-progress-and-exception-reconciliation.md)

## Limits / when to revisit

- Real Claude CLI version/credential compatibility remains #3779's acceptance
  scope; #3801 proves the mapping against a controlled CLI-compatible fixture.
- macOS Shell runtime accuracy is not claimed from Linux CI; the process-group
  read is portable and verified locally, but Linux is the acceptance runtime.
- There is no shell prompt hook / OSC 133 integration yet; the process-group
  evidence is the current detector.
- Background jobs started with `&`, CPU use, output volume and attachment are
  deliberately not activity signals.
- No durable Activity history, no sorting/filtering by Activity yet, and no
  second Claude status engine.
