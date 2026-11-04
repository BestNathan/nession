---
title: "Terminal tools capsule chord and command ownership"
description: "One upper Capsule slot for Terminal Keys and Quick Commands: one-shot modifier chords, Insert vs Run, and separate fit and scroll clearances"
topic: terminal
categories: ["terminal","interaction","capsule","design","ownership"]
status: verified
created_at: 2026-11-04T08:40:00Z
updated_at: 2026-11-04T08:40:00Z
sources: ["https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/terminal/interaction-semantics.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule-2710-prototype.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/web/src/platform/terminal-runtime/interaction/TerminalInteractionController.ts","https://github.com/BestNathan/nession/issues/2710","https://github.com/BestNathan/nession/pull/2736"]
---

# Terminal tools capsule chord and command ownership

## Decision

Terminal Keys and Quick Commands are two explicit views of **one** upper Capsule
slot. The `+` entry remains the entry; a compact header switch replaces the
title while a view is open; the close control remains the one dismissal owner.
The lower composer is unchanged, and neither view is a composer mode or a
second persistent toolbar.

**Terminal Keys owns interaction, not escapes.** Esc/Tab/Space/Enter/Delete and
arrows stay direct semantic keys. Ctrl/Alt/Shift are one-shot panel state:
selecting one sends nothing, the next compatible key produces one atomic chord
through `TerminalInteractionController.sendChord`, and the selection clears.
Cancel clears without a write. Encoding mirrors xterm's keyboard evaluator
(Ctrl+letter C0 byte, Alt ESC prefix, Shift+Tab `CSI Z`, mode-independent
`CSI 1;<modifier>` for modified arrows/Delete). The old long-press chain is
retired; a chord is never a sequence of literal key writes.

**Quick Commands owns actions, not storage.** It reads the existing saved-command
owner (`server.commands.list`, with `server.commands.changed` refetch) through the
commands transport plugin. **Insert** puts the command in the composer without
Return and returns typing to the composer; **Run** sends the command with Return
and does not edit the composer. Expanding the view never executes. A
disconnected server disables Run; an uncontrollable Session disables both, with
the reason stated rather than a local echo.

**Clearance has two owners.** The composer fit occlusion
(`--nession-local-terminal-capsule-occlusion`) still decides xterm rows, PTY and
tmux size. The upper-panel scroll clearance
(`--nession-local-terminal-capsule-panel-clearance`) is measured separately from
the highest open surface and is spent by `CapsuleOcclusionScroll` as a visual
translate of `.xterm-screen`. Following keeps the live bottom above the panel;
history applies no shift and preserves its anchor; closing restores
composer-only clearance. Alternate-screen and mouse-reporting applications are
never shifted. Collapsing the two values would reflow the terminal on every
panel open.

## Context and evidence

Issue [#2710](https://github.com/BestNathan/nession/issues/2710) and PR
[#2736](https://github.com/BestNathan/nession/pull/2736) implemented the
redesign. The PR merged to `staging` as
`f775b00ee22c32b27538d2dc97aef464508190bc`; the canonical owners
([interaction semantics](https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/terminal/interaction-semantics.md),
[terminal capsule](https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule.md))
and the [prototype record](https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule-2710-prototype.md)
carry the same decision.

Evidence at the exact PR head `e0c2bbb32976b79140961af3ac37bb76a8a55617`:

- The Acceptance Case Smoke batch (`run 41796445784/1`, artifact
  `acceptance-case-smoke-41796445784-1`) passed SC-01, SC-02, SC-03, SC-04,
  SC-05, SC-06, SC-08 and SC-09. SC-03/SC-04 assert the exact PTY-bound chord
  frames on the production-controller fixture; SC-08/SC-09 assert the live
  clearance, preserved history anchor, stable xterm rows and tmux pane,
  alternate-screen/mouse no-shift, touch scrolling and the #2657 direction pad.
- The SC-07 Agent evaluation passed against the repository prototype record,
  which pins the live preview and immutable source.
- The selected `fixture-app` / `fixture-visual-app` E2E obligations passed at
  the PR head (`run 41796445551/1`), including the regenerated visual baselines.

The live interactive prototype is at
<https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html>,
source-pinned on the shared orphan `prototype` branch. It is a mock: the record
explicitly limits it to the interaction and does not claim PTY bytes, xterm
mode encoding, tmux sizing or alternate-screen/mouse behavior.

## Related knowledge

- [Web terminal emulator engine and component ownership](web-terminal-emulator-engine-and-component-ownership.md) — the engine/port and interaction-controller boundary these tools consume.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md)

## Limits / when to revisit

- The two-clearance split assumes the composer-only occlusion stays the xterm
  fit input. If a future change feeds the panel height into the fit value, it
  re-opens the reflow defect this design exists to prevent.
- The visual shift applies only in the normal local buffer with no mouse
  tracking. Alternate-screen and mouse-reporting applications are deliberately
  left unshifted; do not "fix" that by shifting them without a new product
  decision and TUI evidence.
- Quick Commands has no add/edit/delete UI and no local persistence. A second
  command registry or a composer-independent store would be a separate owner.
- Revisit if the Capsule upper-slot switch becomes a general tab system, if a
  second interactive terminal key surface appears, or if xterm's screen/scroll
  model changes enough that a transform-based clearance is insufficient.
