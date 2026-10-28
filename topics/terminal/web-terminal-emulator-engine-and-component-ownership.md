---
title: "Web terminal emulator engine and component ownership"
description: "One Xterm Engine owns the raw @xterm/xterm instance; Product/UI consumes a narrow emulator port"
topic: terminal
categories: ["architecture","ownership","terminal","web"]
status: verified
created_at: 2026-10-28T17:46:56Z
updated_at: 2026-10-28T17:46:56Z
sources: ["https://github.com/BestNathan/nession/blob/df39f65fec7825903d1f9f0f87c6c63dffb03e1d/docs/architecture/terminal-engine.md","https://github.com/BestNathan/nession/pull/2583"]
---

# Web terminal emulator engine and component ownership

## Decision

Nession's Web terminal has one business-neutral **Xterm Engine** in
`web/src/platform/terminal-runtime/xterm/`. `XtermEmulator` is the only
production owner of an `@xterm/xterm` `Terminal`: it constructs the instance,
mounts/reparents/unmounts it without destroying the buffer, installs the
renderer/theme/addon lifecycle, and maps logical-line text offsets to buffer
cells. `XtermMetrics` is the single compatibility adapter allowed to read
xterm's private `_core` render service.

Product/UI consumes the port in `platform/terminal-runtime/emulator.ts`:
typed disposables, buffer/mode/cursor read models, bounded font configuration
and a link matcher. It does not import `@xterm/*`, does not import the engine
adapter module, and has no raw-terminal escape hatch.

The surrounding correctness owners are unchanged and are not duplicated by the
engine: `SessionRuntime` owns route/attach/lease/stream synchronization,
`SerializedTerminalWriter` owns ordered buffer/grid mutation,
`TerminalGeometry` owns fixed-column font/rows policy,
`TerminalInteractionController` owns PTY-bound input semantics, and Product
owns Workspace file-link recognition and navigation.

## Context and evidence

- Requirement: [#2581](https://github.com/BestNathan/nession/issues/2581);
  implementation PR [#2583](https://github.com/BestNathan/nession/pull/2583).
- Canonical architecture: `docs/architecture/terminal-engine.md` at
  `df39f65fec7825903d1f9f0f87c6c63dffb03e1d` (writable-owner table, final
  dependency graph, test owners).
- `nession/no-direct-xterm` enforces the boundary: no `@xterm/*` outside the
  engine, no engine-module import from Product/UI, `_core` only in
  `XtermMetrics.ts`. Negative fixtures prove each rejected shape.
- Geometry only refits the font when the observed width changes; a height-only
  observation reuses the measured cell. The ordered writer drops a resize that
  repeats the grid it already applied, while keeping the operation in FIFO
  position so its parser-completed callback cannot overtake an earlier write.
- Workspace-link cell mapping is proved for ASCII, wide characters, combining
  sequences and wrapped continuations; out-of-range matches are dropped rather
  than clamped.
- The canonical fixture constructs through the engine's public barrel, so
  fixture and product terminal construction share the renderer/theme/metrics
  rules.

## Related knowledge

- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md)

## Limits / when to revisit

- This article covers the Web/xterm component boundary only. Backend tmux SDK
  work remains owned by #2469; session transport and stream recovery remain
  owned by #1309/#1645.
- Revisit if xterm's private render-service shape changes (the negative fixture
  and `XtermMetrics` are the compatibility point), if a second raw xterm
  consumer appears outside the engine, or if Addon/link ownership moves.
- The engine is internal to `platform/terminal-runtime/xterm/`; there is no npm
  package extraction decision.
