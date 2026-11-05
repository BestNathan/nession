---
title: "App mobile spatial navigation and Terminal touch ownership"
description: "One owned physical contact for the App shell swipe: slop and axis arbitration, a frozen destination, release-only commit, interactive-owner deference and stable Terminal/Workspace context"
topic: app
categories: ["app","interaction","navigation","ownership","terminal","touch"]
status: candidate
created_at: 2026-11-05T03:28:50Z
updated_at: 2026-11-05T03:28:50Z
sources: ["https://github.com/BestNathan/nession/issues/2724","https://github.com/BestNathan/nession/pull/2753","https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/docs/design/interaction/app.md","https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/web/src/app/experiences/app/gesture.ts","https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/web/src/app/experiences/app/swipeGesture.ts","https://github.com/BestNathan/nession/blob/3ba12b8de09e7d608501c14797e505082dcc8a13/mobile-swipe-2724/index.html"]
---

# App mobile spatial navigation and Terminal touch ownership

## Decision

The App keeps the product model `Sessions ← Terminal → Workspace`, with the
selected Session's Terminal as the stable root. The top-level swipe is an
accelerator over the header's visible controls, never the only route.

A physical touch is **one owned contact**: `touchstart → touchmove* →
touchend/touchcancel`, correlated by `Touch.identifier`. Touch Events own it;
touch-generated `pointercancel`/`lostpointercapture` do not end it, and Pointer
Events are only a mouse/pen rehearsal path.

Ownership is not assumed at `touchstart`. The shell is a *candidate* until the
contact moves past a 12px slop without turning vertical (`abs(dy) > 0.85 *
abs(dx)` wins for content). Once claimed, the destination index and direction
are frozen for the rest of the contact: reversing past the origin clamps the
preview to zero, and only release (or a genuine cancellation) commits or snaps
back.

Release commits at `max(64px, 18% of the shell width)`, or on a deliberate
flick of at least 40px at 0.45 px/ms or faster. Speed alone cannot commit a
shorter travel. Multitouch, a real `touchcancel`, the browser committing the
contact to native scrolling, page hiding, or another surface claiming the
finger all cancel; the reason is recorded in `data-swipe-reason` and one
console line for device diagnostics.

## Edge band and interactive owners

Where a page may begin is unchanged from #1049/#1081:

```text
shell chrome                            -> whole width
work surface, within 28px of shell edge -> that edge's one direction
work surface interior                   -> the surface
```

The shell resolves both the band and the commit threshold from the App shell's
own rect, never `window`. On top of that, #2724 makes **interactive owners
unconditional**: a button, input/textarea, select, link, contenteditable,
`role=button`, dialog/alertdialog, an expanded Capsule Peek, a nested
horizontal scroller (including the Workspace capability row), an active text
selection, or `[data-swipe-owner]` keeps its touch even inside the band.
Claiming there would spend the first pixels of the action the user aimed at.
A pushed Workspace detail still owns its own leave, so the shell pages neither
its chrome nor its editor.

The Terminal's long-press direction pad (#2657) is a second consumer of the
same finger. It arms after a stationary hold and claims the identifier in the
shared `touchOwnership` registry; the shell subscribes to claims and stands
down immediately, rather than waiting for events the pad now consumes. A
direction pad never arms inside the shell's band.

## In-flight feedback and routes

Only after the shell claims a drag does it add chrome: the adjacent layer
reveals progressively, the moving slab carries a floating shadow, and a
transient pill names the frozen destination with an arrow. Release removes all
of it. There is no resting tutorial, edge rail or navigation overlay. The
no-Session root's index-1 destination is labelled **Home**, never a fake
Terminal, and the Workspace layer does not exist before a Session does.

A settle animates the current layer fully off-screen (or the preview back to
its parked position) over the shell motion token; `prefers-reduced-motion`
collapses it to the same instant decision. During a settle only the outgoing
layer and the frozen destination render, so Workspace → Terminal cannot flash
Sessions at the moment the offset crosses one shell width.

Opening, cancelling or completing a layer never remounts xterm, changes the
PTY/tmux grid, resets scrollback, clears the composer, changes the selected
Session, or drops a pushed Workspace depth.

## Context and evidence

Owned by [Requirement #2724](https://github.com/BestNathan/nession/issues/2724)
and implemented in
[`gesture.ts`](https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/web/src/app/experiences/app/gesture.ts)
(constants), [`swipeGesture.ts`](https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/web/src/app/experiences/app/swipeGesture.ts)
(pure state machine), `swipeTouchBinding.ts` (native listeners),
`useSwipeSettle.ts` (release animation) and `useSwipePager.ts` (React state).
The product contract is
[`docs/design/interaction/app.md`](https://github.com/BestNathan/nession/blob/da808a966b6f6d35a9dcbcc301ad1e740f8e3a72/docs/design/interaction/app.md).
The interaction was shaped by the approved
[mobile prototype](https://github.com/BestNathan/nession/blob/3ba12b8de09e7d608501c14797e505082dcc8a13/mobile-swipe-2724/index.html)
on the shared `prototype` branch.

Pre-merge Cases SC-01…SC-05 pin continuity, xterm ownership, interactive-owner
deference, routes/dirty leave and context preservation. The canonical
regression is the App block of `ui-contract-matrix`, run at 375/390/430 and
844×390.

## Related knowledge

- [Web terminal emulator engine and component ownership](../terminal/web-terminal-emulator-engine-and-component-ownership.md) — the xterm engine, mode-owned touch scrolling and the boundary the App band must not steal from.
- [Terminal tools capsule chord and command ownership](../terminal/terminal-tools-capsule-chord-and-command-ownership.md) — the upper Capsule slot and the Terminal tools that the composer/Peek owners protect from shell swipes.

## Limits / when to revisit

- SC-07 is **Pending**: real iOS Safari/installed-PWA OS edge ownership and
  keyboard/IME geometry cannot be proven by Chromium emulation. A physical
  device must confirm whether the platform consumes the 28px edge before the
  band and velocity values are treated as measured.
- The band, slop, commit fraction and flick thresholds are the approved
  prototype's initial hypotheses, not device measurements.
- The screenshot/Pages prototype source is not trusted Acceptance evidence, and
  a source commit is not proof of a deployed preview.
- Revisit if a second gesture consumer appears outside the `touchOwnership`
  registry, if a work surface needs a different edge rule, or if the App stops
  rendering the Terminal as a mounted root layer.
