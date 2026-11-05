---
title: "Web primitive focus treatment and visual vocabulary ownership"
description: "Modality-aware focus for Web primitives: pointer/touch adds no outer chrome, keyboard focus is an inset token outline or a border repaint, and invalid/disabled semantics plus the regression owners keep the recipe from drifting"
topic: web
categories: ["design","interaction","web","accessibility","ownership"]
status: verified
created_at: 2026-11-05T08:36:00Z
updated_at: 2026-11-05T08:36:00Z
sources: ["https://github.com/BestNathan/nession/blob/5e6b195d2b6e06494eb2c6d0dcc85ff8f93ae498/docs/design/design-system/components.md","https://github.com/BestNathan/nession/blob/5e6b195d2b6e06494eb2c6d0dcc85ff8f93ae498/design/tokens/experience/web.json","https://github.com/BestNathan/nession/blob/5e6b195d2b6e06494eb2c6d0dcc85ff8f93ae498/web/src/components/ui/button.tsx","https://github.com/BestNathan/nession/issues/2750","https://github.com/BestNathan/nession/pull/2767"]
---

# Web primitive focus treatment and visual vocabulary ownership

## Decision

Focus is a modality-aware interaction state owned by the Web primitive recipe and
the Experience focus tokens, not a reason to add decorative outer chrome
(#2750). Pointer and touch interaction must not paint a halo or a second frame;
keyboard focus must stay locatable inside the control's own geometry.

The recipe has two branches, chosen by what `:focus-visible` can honestly
promise:

- **Bordered field primitives** (`Input`, `Textarea`, `SelectTrigger`) repaint
  their existing border in semantic `ring`. Text-entry fields match
  `:focus-visible` on pointer focus too, so a second frame would appear on every
  click; the border is the quietest honest indicator.
- **Controls without a usable border to repaint** (`Button`, `Toggle`, `Tabs`,
  `Checkbox`, `Badge`, `ScrollArea`, borderless action/row buttons) draw an
  inset outline in `ring`: `focus.ringWidth` thick, placed `focus.ringOffset`
  inside the edge by a negated offset. The indicator is an `outline`, not a
  `box-shadow` ring, so it survives forced-colors mode and is not clipped by a
  scrolling ancestor.

Invalid keeps ownership of the border (`destructive`); a focused invalid field
also shows the inset outline, so focus never disappears when validation fails.
Disabled controls receive no focus treatment. Popup menu rows keep their focused
accent surface. The generated `--nession-focus-ring-width/-offset` tokens and
their values are unchanged; the primitive consumers now use them instead of the
inherited shadcn `ring-3` literal.

Feature-local outer `ring-2`/`ring-1` recipes on the capsule, Git, Claude Code,
conversation and JSON-tree actions were converged to the same inset vocabulary.
The Terminal Capsule's ghost composer keeps its existing explicit exception: it
is a text-entry surface whose caret is the focus affordance, and the requirement
lists it as renderer-owned.

## Context and evidence

The capability owner is `docs/design/design-system/components.md` §Focus
treatment plus the `experience.web.focus` token group. The browser regression
owner is `e2e/tests/browser/ui-contract-web.spec.ts`; its helper failure proofs
live in `ui-contract-assertions.spec.ts`, and both are selected by the single
`design/scripts/browser-design-catalog.mjs` consumed by the design gate. The
source-aligned Cases `e2e/acceptance/cases/2750/SC-02|SC-03|SC-05` prove the
modality directions and the fail-closed guard at the PR head.

Observed on the implementation at PR #2767:

- pointer/touch on a field changed only the border to `--nession-ring`; no
  outline and no painted box-shadow;
- pointer/touch on a button added no focus chrome;
- keyboard Tab/Shift+Tab, tablist arrows and menu open/close kept the token
  inset outline, and Escape returned focus to a visible trigger;
- a focused invalid field kept `border-destructive` plus the inset outline;
- no `web/src/components/ui` source contains `focus-visible:ring-3` or
  `ring-[3px]`.

## Related knowledge

- [Web terminal emulator engine and component ownership](../terminal/web-terminal-emulator-engine-and-component-ownership.md) — the renderer boundary that owns xterm's own focus/caret rendering, separate from chrome primitives.

## Limits / when to revisit

- The inset outline uses `outline` for forced-colors resilience; do not replace
  it with a `box-shadow` ring without re-proving that mode.
- The two-branch recipe is intentional: text-entry fields must not gain a second
  frame on pointer focus. Do not "normalize" fields back to an inset ring.
- Revisit if a primitive gains a border it can repaint, if a new focus modality
  (for example a low-motion/contrast preference) needs a distinct treatment, or
  if a new interactive primitive family is added outside `components/ui`.
- Acceptance evidence is PR-head scoped (`when: pr`); production acceptance is
  not implied by this article.
