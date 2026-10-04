# ContextCapsule

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/app.md](../../interaction/app.md) / [interaction/web.md](../../interaction/web.md) → [capability-emergence.md](../../capability-emergence.md)

The upper Capsule of the stacked pair — what `+` opens on the Terminal capsule
(#1347 SC-41–44). One flat list: the capabilities sensed right now first
(work-sensed, then context-sensed), the ordinary catalog below them, in one
bounded scrollable surface.

## Why it needs its own block

Three properties are measurable and none of them is owned anywhere else.

**It is a Capsule, not a menu.** Its surface, radius, padding and elevation are
the `terminal-capsule` family's, and its height is a *ceiling* — the surface
takes its content's height and clamps only when the list outgrows it. It was a
fixed height until 2026-10-04, on the reasoning that a box which cannot resize
cannot move anything; the owner retired that when a real deployment with three
capabilities registered showed the rest of the box empty. What the fixed height
was protecting still holds, and for a better reason: the flat list renders every
capability, so the sense states differ in row *order* and never in row *count*.
The pattern it replaces, [`popup-menu.md`](popup-menu.md), exists to
pin a menu's rows and to explain why a *portalled* popup inherits no experience
scope; this surface is rendered inside the capsule's dock, so it inherits the
scope, rides the App's Conversation↔Capability exchange transform, and needs the
opposite rule stated: **a generic menu's sizing is a violation here** (SC-42).

**Its rows carry two lines on App.** Icon, title, and one line of *why* — the
reason a work-sensed or context-sensed capability is here at all (SC-19). A
two-line row is taller than one band, which no row pattern measures today, so
the row height is this pattern's own token.

**The lower Capsule must not move.** Opening it adds a sibling above the
Conversation Capsule; the shell's box is identical open and closed, and the gap
between the two is one token rather than a measured offset (SC-41, SC-43).

## Anatomy

```text
     ┌─ Context Capsule ──────────────────────────┐
     │ ✦ Claude Code                            › │  ← sensed: icon + title
     │   Working in this Session                  │     + one line of reason
     │ ⑂ Git                                      │
     │   Running pre-commit                       │
     │ ─────────────────────────────────────────  │  ← section, not a step
     │ ▤ Files    ⚙ Session    ✦ Claude Code    › │  ← ordinary catalog, same list
     └────────────────────────────────────────────┘
                    ↕ inter-Capsule gap (one token)
     ╭─ Conversation Capsule ─────────────────────╮
     │ [+]  Ask Nession…                       ↑  │  ← unchanged, and stays so
     ╰────────────────────────────────────────────╯
```

The trigger (`+`) is not this pattern's; it belongs to `terminal-capsule.md`.
What this pattern owns is the surface above it and the rows inside it.

## Rules

- **One list, no second step.** Sensed capabilities lead, in the order the
  resolver gives them (work-sensed, then context-sensed); every non-sensed
  capability follows in the same list. A capability appears **once** — a sensed
  id is not repeated in the catalog half.
- **The height is a ceiling, and the same ceiling in every sense state.** The
  surface is as tall as its content and no taller than the ceiling; a list that
  outgrows the ceiling scrolls inside it, and the surface owns that scroll rather
  than handing the gesture to the work behind it. Quiet, working and context-only
  still come out the same height — because the one flat list renders every
  capability, so those states reorder rows and never add or drop one. That is an
  invariant now rather than a property of a box, so it is asserted (the matrix
  compares the surface's box across the App states that can differ).
- **Every row is exactly one row band.** A sensed row carries a title and a line
  of reason and an ordinary row carries a title, and both are one band tall, so
  the list's rhythm does not change with the sense state. Two lines only fit a
  44px band if the leading says so: `contextCapsule.rowLineHeight` is what keeps
  them inside it, and without it the pair measured 48px against a 44px band.
  The band is 44px because that is the App touch floor, so a row is a legal App
  target by construction as well as one band.
- **The lower Capsule is the anchor.** Opening, closing and deepening change the
  upper surface only: the shell's box, clearance and occlusion are identical
  with the surface open and closed. The gap between them is a token.
- **A row is a control whose whole row is the target**, and on App it meets the
  touch floor. The row's *height* is this pattern's token — the same band for
  every row; the icon and title are the capability's display identity and the
  reason is Nession's copy — an id is never the row's text (SC-19).
- **Selecting any row opens that capability's detail**, sensed or ordinary
  alike. Choosing is asking to look at it, so it lands at Peek where the way on
  to the Workspace lives; a capability that has no Workspace view simply has no
  destination beyond the Peek, which is `capability-emergence.md`'s "explicit
  path into Workspace **when deeper inspection is useful**". Signal is not
  something selection produces — it is what Nession shows on its own, and what a
  dismissed Peek steps back to.
- **Sensed rows carry a reason; ordinary rows do not, and the rhythm does not
  change.** A row without a reason keeps the same band so the list does not
  jitter between sense states.
- **The surface is not modal.** No backdrop, no focus trap, no `role="dialog"`,
  no page title, no separate close chrome (SC-33). The trigger carries
  `aria-expanded` and `aria-controls`; Escape is handled by the surface and the
  key is **not** forwarded to the terminal.
- **What closes it:** the trigger again, Escape, a pointer outside, or selecting
  a row. A sense that ends while the surface is open dismisses it (SC-36); a
  Peek the user opened itself is not taken back.
- **Terminal-local capabilities deepen to their Peek like any other**, and by
  having no Workspace view they simply have no destination beyond it.

## States

- **quiet** — the ordinary catalog alone, in the same shell.
- **working** — the work-sensed rows lead, with their reasons.
- **context-only** — the context-sensed rows lead (App with a Session: Terminal
  Keys), with no Work Ring anywhere: context is not work (SC-37).
- **deepened** — selecting a row puts that capability's Peek in the same slot,
  at the same width, with the same gap to the shell below. The surface's height
  follows whatever is in the slot, so the list and the Peek may differ in height;
  what does not change is the anchor below them.

## Not this pattern

- **A popup menu** — `popup-menu.md` owns the list a *control* collapses into,
  and its rows are one line in the experience's control band. The session row's
  `…` menu is that pattern; this is not.
- **The Peek** — it occupies the same slot, but its body is the capability's and
  its sizing is `terminal-capsule`'s projection. This pattern owns the *list*.
- **A sheet or a dialog** — a sheet takes the App's screen; a dialog asks for an
  answer. This is a list the user chooses from, anchored to the capsule.
- **The Workspace capability band** — `workspace-navigation.md`. That one is the
  Capability *Form*; it has no `+` and never opens this surface.

## Contracts and visual baselines

`design/contracts/patterns/context-capsule.json` pins, per experience: the height
ceiling, the row band, the semantic Capsule radius, the horizontal padding, the
scroll ownership, and — on App — the touch floor every row must meet. The
inter-Capsule gap is asserted against its token rather than a literal, and the
"the lower Capsule does not move" claim is asserted by measuring `capsule-shell`
before and after, in `e2e/specs/ui-contract-matrix.spec.ts`.

Two claims have no one-line assertion, so both are asserted in the matrix by
name. **The height is a ceiling and not a height** takes two comparisons, because
"at most the ceiling" passes on a fixed height too whenever the content is taller
— so the surface is also required to come in *under* it on the canonical fixture,
where three capabilities cannot fill it. And **the three sense states agree**
compares the surface's box between the App states that can actually differ.

The App baselines `app-capability-entry.png` and `app-work-context-disclosure.png`
draw it open and move with this pattern; they are the only ones that do.

## Anti-patterns

- A generic menu or popover wearing Capsule colours — `w-60`, `bg-popover`,
  `ring-1`, shadow-md. This is the shape SC-42 fails, and it is what the
  disclosure shipped as before this pattern existed.
- A fixed height, so a short list reserves room for rows it does not have. This
  was a rule here until 2026-10-04, when the ceiling replaced it: the concern
  behind the old wording — a surface that resizes as rows come and go, dragging
  the pair around — cannot happen on this surface, because the flat list gives
  every state the same row count. The rule was guarding against a cause that does
  not exist, at the cost of a box that was mostly empty.
- A second step (`All capabilities`) or any secondary layer: the catalog is
  reachable in the list the user is already looking at.
- A row taller than the row band — a sensed row carrying two lines is the case
  that keeps trying to happen, and it is what `rowLineHeight` is for. A taller
  sensed row makes the list's rhythm change with the sense state, and it is
  invisible while the surface is tall enough to absorb it.
- Rendering the surface outside the capsule's dock — it then inherits no
  experience scope, does not ride the App's exchange transform, and reads as a
  second object rather than the Capsule's upper half.
- Taking the work surface's scroll or drag: the surface scrolls itself and
  hands every other gesture back.
