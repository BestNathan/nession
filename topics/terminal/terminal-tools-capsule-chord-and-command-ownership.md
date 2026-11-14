---
title: "Terminal tools capsule chord and command ownership"
description: "One upper Capsule slot for Terminal Keys and Quick Commands: one-shot modifier chords, Insert vs Run, and mode-aware upper-panel clearance (reversible scroll for shells, reserved rows for full-screen TUIs)"
topic: terminal
categories: ["terminal","interaction","capsule","design","ownership"]
status: verified
created_at: 2026-11-04T08:40:00Z
updated_at: 2026-11-14T11:33:51Z
sources: ["https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/terminal/interaction-semantics.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/docs/design/design-system/patterns/terminal-capsule-2710-prototype.md","https://github.com/BestNathan/nession/blob/f775b00ee22c32b27538d2dc97aef464508190bc/web/src/platform/terminal-runtime/interaction/TerminalInteractionController.ts","https://github.com/BestNathan/nession/issues/2710","https://github.com/BestNathan/nession/pull/2736", "https://github.com/BestNathan/nession/issues/3492", "https://github.com/BestNathan/nession/pull/3501", "https://github.com/BestNathan/nession/blob/4ac01c982d4da0cbb48e1bdde2c1759e4318bf04/web/src/platform/terminal-runtime/capsule/clearancePolicy.ts", "https://github.com/BestNathan/nession/blob/4ac01c982d4da0cbb48e1bdde2c1759e4318bf04/web/src/platform/terminal-runtime/view/TerminalGeometry.ts", "https://github.com/BestNathan/nession/blob/4ac01c982d4da0cbb48e1bdde2c1759e4318bf04/web/src/platform/terminal-runtime/xterm/XtermEmulator.ts", "https://github.com/BestNathan/nession/blob/4ac01c982d4da0cbb48e1bdde2c1759e4318bf04/web/src/platform/terminal-runtime/controller/TerminalController.ts"]
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

**Clearance is mode-aware.** The composer fit occlusion
(`--nession-local-terminal-capsule-occlusion`) remains the base fit input. The
upper-panel clearance
(`--nession-local-terminal-capsule-panel-clearance`) is measured separately
from the highest open surface, and `clearancePolicy.ts` selects how it is
spent from the terminal's actual `buffer.active.type` and
`mouseTrackingMode`:

- **Normal buffer, no mouse tracking:** `scroll-clearance`. #2710's reversible
  visual pan; `CapsuleOcclusionScroll` translates `.xterm-screen` and keeps
  rows, PTY and tmux size unchanged.
- **Alternate screen or mouse tracking:** `viewport-reserve`. The panel height
  reduces the usable grid height in `TerminalGeometry`, so xterm rows and the
  authorized PTY/tmux rows follow the reduced height, columns stay canonical,
  and the application redraws its own bottom/status/input rows above the panel.
  The grid is not translated.
- **No ControlLease authority or too little usable height:** a latched,
  bounded Compact/Expand Peek. The fallback is sticky for one open panel so the
  compact panel's own smaller height cannot re-expand it into an oscillation.

`XtermEmulator` emits a deduplicated `onModesChange` event, so a buffer/mouse
transition re-selects the policy without remounting. Only the authorized
Controller may send the resize; an observer publishes no resize and cannot move
the Session. Geometry deduplicates stable rows and keeps the existing debounce;
closing or rotating derives rows from current geometry, not a remembered size.
This is the deliberate #3492 exception to #2710's earlier global no-resize
contract, limited to applications whose screen cannot safely be panned.

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

**#3492 follow-up (2026-11-14).** The conditional reserve was delivered by PR
[#3501](https://github.com/BestNathan/nession/pull/3501), merged at
`4ac01c982d4da0cbb48e1bdde2c1759e4318bf04`. Exact-head browser and Agent
evidence at `c4296bda5357bb63affdc0afd5766d5e1b08d6db`: SC-01..SC-05 Pass in
Acceptance run `43589593821`; the real-stack `terminal-io` and
`terminal-consistency-faults` suites passed in E2E run `43589595948`
(shell rows unchanged; alternate reserve and authoritative tmux rows; SGR mouse
wheel reports preserved; observer Peek sent zero resize frames; short-viewport
rotation stable). The prototype was revised in place at `prototype` SHA
`1998fbd8e8a0f9400b5de343d327665e7f4d417f` and published to Pages.

The live interactive prototype is at
<https://bestnathan.github.io/nession/prototypes/terminal-keys-commands-2710/index.html>,
source-pinned on the shared orphan `prototype` branch. It is a mock: the record
explicitly limits it to the interaction and does not claim PTY bytes, xterm
mode encoding, tmux sizing or alternate-screen/mouse behavior.

## Related knowledge

- [Web terminal emulator engine and component ownership](web-terminal-emulator-engine-and-component-ownership.md) — the engine/port and interaction-controller boundary these tools consume.
- [Nession instruction architecture and knowledge ownership](../engineering/nession-instruction-architecture-and-knowledge-ownership.md)

## Limits / when to revisit

- The fit occlusion and the panel reserve are separate inputs: the composer
  occlusion stays the base fit value, and only the reserve policy subtracts the
  measured panel height through `TerminalGeometry`. Feeding the panel into the
  base fit for every mode would re-open #2710's reflow defect.
- Scroll clearance applies only to the normal local buffer without mouse
  tracking. Alternate-screen and mouse-reporting applications deliberately
  reserve rows instead; do not shift them without a new product decision and
  fresh TUI evidence. The reserve must stay on the authorized Controller path.
- Quick Commands has no add/edit/delete UI and no local persistence. A second
  command registry or a composer-independent store would be a separate owner.
- Revisit if the Capsule upper-slot switch becomes a general tab system, if a
  second interactive terminal key surface appears, or if xterm's screen/scroll
  model changes enough that a transform-based clearance is insufficient.
