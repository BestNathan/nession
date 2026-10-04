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
     ┌─ Upper Capsule / Context ──────────────────┐
     │ · ✦ Claude Code                            │  ← sensed: mark + icon + title
     │     Working in this Session                │     + one line of reason
     │   ⑂ Git                                    │  ← ordinary: same columns
     │   ▤ Files                                  │
     └────────────────────────────────────────────┘
                    ↕ inter-Capsule gap (one token)
     ╭─ Conversation Capsule ────────────────╮  ○ Workspace
     │ [+]  Ask Nession…                  ↑  │
     ╰──────────────────────────────────────╯
```

Choosing a row deepens the **same upper slot** rather than introducing another
surface family:

```text
Context list
     ↓ choose
Peek
     ↓ dismiss
nothing
```

Context and Peek share one Nession-owned **Upper Capsule visual grammar**:
surface material, capsule radius, elevation/blur, horizontal bounds,
inter-Capsule gap and host chrome. Their content, height and internal density may
differ. On Web, the upper Capsule aligns with the actual Conversation Capsule
shell — column one of the dock — and does **not** span the Workspace destination
circle in column two.

The trigger (`+`) is not this pattern's; it belongs to `terminal-capsule.md`.
This pattern owns the Context list semantics. The shared Upper Capsule chrome is
owned by the Capsule product recipe, not by either Context or a capability body.

## Visual grammar ownership

The upper slot follows the product-level ownership chain defined in
[patterns.md](../patterns.md):

```text
tokens → generic primitives → Capsule visual recipe → Context / Peek content
```

Nession owns the outer surface, host header, title role, dismiss affordance,
Workspace destination, focus treatment and placement. A capability owns the
domain content it renders inside the Peek body and may compose shared primitives
there; it does not redefine the host radius, material, elevation or typography.

The Conversation composer is a **writing surface** and may keep its 16px input
role where the platform needs it. That value is not a generic Capsule chrome
size. Context rows and Peek host chrome use semantic chrome typography roles
instead of inheriting the composer's text scale.

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
  the list's rhythm does not change with the sense state. The pair fits the 44px
  band on the role sizes alone — 14 + 11.5 at the inherited 1.5 is 38.25px on App
  (Web 36px) — and the role leadings only tighten it, to 34.55px / 31.85px. A
  pair set in the capsule's own font size did not fit: at 1rem a line is 24px at
  the inherited 1.5, so 48px for the pair, which is what stood a sensed row 4px
  prouder than an ordinary one. The band is 44px because that is the App touch
  floor, so a row is a legal App target by construction as well as one band.
- **The row's two lines are typeset in the design language's roles, not in the
  Capsule's font size.** The title takes `body` and the reason `caption`, read
  through `chromeSansRole`. The Capsule's own `fontSize` / `captionFontSize` both
  resolve to `primitive.typography`, so a row that named them rendered every line
  at the same 16px and told title from reason by colour alone — a list with no
  typographic hierarchy. `body` is the role the design language writes for
  controls (the role's note on Web names "button labels, menu items, filters"),
  and its size plus `caption`'s hold the pair inside the 44px band — 38.25px on
  App, 36px on Web — with the two role leadings tightening it to 34.55px and
  31.85px.
- **The lower Capsule is the anchor.** Opening, closing and deepening change the
  upper surface only: the shell's box, clearance and occlusion are identical
  with the surface open and closed. The gap between them is a token. Context
  and Peek use the same gap, material, capsule radius and horizontal bounds; a
  depth change changes content, not visual family.
- **A row is a control whose whole row is the target**, and on App it meets the
  touch floor. The row's *height* is this pattern's token — the same band for
  every row; the icon and title are the capability's display identity and the
  reason is Nession's copy — an id is never the row's text (SC-19).
- **Selecting any row opens that capability's detail**, sensed or ordinary
  alike. Choosing is asking to look at it, so it lands at Peek where the way on
  to the Workspace lives; a capability that has no Workspace view simply has no
  destination beyond the Peek, which is `capability-emergence.md`'s "explicit
  path into Workspace **when deeper inspection is useful**". A dismissed Peek
  steps back to nothing: the Signal depth it used to return to was removed on
  2026-10-04, so closing it returns the slot to dormant.
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
- **The Peek body** — the capability owns its domain content and composition,
  while Nession owns the same Upper Capsule host used by Context. This pattern
  owns the *list semantics*, not a second outer-surface recipe.
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

The matrix also carries the **relational** contract that individual pattern
blocks cannot express alone: Context and Peek must resolve to the same computed
surface material, capsule radius, border treatment, elevation/blur and gap; their
x/width must match each other and the Conversation shell; and deepening must not
move the lower shell. This is intentionally stronger than proving that both
components independently use allowed tokens.

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
  that keeps trying to happen, and the role sizes are what hold it in the band
  (the leadings only tighten the pair). A taller sensed row makes the list's
  rhythm change with the sense state, and it is invisible while the surface is
  tall enough to absorb it.
- Rendering the surface outside the capsule's dock — it then inherits no
  experience scope, does not ride the App's exchange transform, and reads as a
  second object rather than the Capsule's upper half.
- Taking the work surface's scroll or drag: the surface scrolls itself and
  hands every other gesture back.
