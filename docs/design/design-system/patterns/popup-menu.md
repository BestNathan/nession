# PopupMenu

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [interaction/app.md](../../interaction/app.md)

The list a control collapses into — what `DropdownMenu` and `Popover` open, and
what `category.control` names when it says a control that cannot fit its content
"collapses into a menu (web) or sheet (app)".

**This is not a Nession product concept.** It has no Session, Agent or capability
semantics, and it would make sense unchanged in another product; by the pattern
catalog's own test it is a generic primitive, and it lives in
`web/src/components/ui/`. It is documented and contracted *here* because
`design/contracts/` addresses patterns — a contract with no `patternRef` cannot
be resolved — and because the one property worth pinning is a UI consequence
that needs a name to be asserted against. Read it as the contract home of a
shared primitive, not as product behaviour.

## Why it needs its own block

Every other contract in this directory measures an element that is a descendant
of the surface it belongs to. A popup is not: base-ui mounts it on
`document.body`, so it is a sibling of `#root` and inherits nothing from the
control that opened it — including the `[data-experience]` scope that decides
which density applies. Measured on the App's session-row `…` menu: items
`184×28`, in an experience whose floor is 44px, with `--control-sm` resolving to
Web's 28. The capability `+` menu was identical, and had been shipping that way.

The consequence is a *contract* consequence, not only a styling one: a
`session-item-row` can pass `touchTargetToken` — the row's own box measures
374×60 — while a sub-floor control sits inside it, and no popup is measured at
all. Both halves are asserted in `e2e/specs/ui-contract-matrix.spec.ts`.

## Anatomy

```text
     ┌ trigger ┐
     │    +    │          ← belongs to its own pattern (session-item,
     └────┬────┘            terminal-capsule, workspace-navigation)
          │
     ┌────▼─────────────┐
     │ [•] Files        │  ← `role="menuitem"`, one control per row
     │ [ ] Session      │     height: the experience's control band
     │ [ ] Agent        │
     └──────────────────┘
```

The trigger is not this pattern's; it belongs to whatever surface hosts it. What
this pattern owns is the list: its rows are controls, and a list row is a control
whose *whole row* is the hit target.

## Rules

- **A row's height is the experience's control band, and it resolves from the
  popup's own container.** On App that is 44px — `control.sm`, which equals
  `control.md` there precisely so no App hit target sits below
  `touchTarget.min`. On Web it is 28px, which is what a menu row already
  measured before this was stated.
- **Web does not adopt App's density.** `control.md` (32px on Web) is the wrong
  band here: it would raise Web's menu rows by 4px to fix a problem Web does not
  have. A pointer has no minimum hit area, so Web's menu stays as dense as it was.
- **The popup carries the scope it was opened from.** A popup opened inside the
  App experience mounts into a container that states `data-experience="app"`; one
  opened from the Web shell mounts on `body`, as it always has. Which experience
  a popup belongs to is decided by where its trigger is — not by the primitive,
  and not by each menu restating a size.
- **The list scrolls rather than clipping.** A long list is bounded by the
  available height and scrolls its own overflow; it must not push past the
  viewport edge or hide rows without a scroll owner.
- **Rows stay single-line.** An item that wraps is a layout bug, not a second
  line of information — the same rule the row patterns state.

## States

- **resting** — rows at the experience's band, unmarked.
- **focused** — the focused row takes the accent surface. Keyboard reachability
  is the primitive's, and this pattern does not narrow it.
- **absent** — nothing to disclose means no trigger at all; a menu that opens
  empty is the anti-pattern (see `workspace-navigation.md`, which owns
  "contextual, not a permanent catalog").

## Not this pattern

- A **sheet** — the App's other `category.control` overflow. A sheet takes the
  screen; this is anchored to its trigger.
- A **dialog** — a decision the user must answer, not a list they choose from.
- **Switching surfaces or tools** — `surface-switcher.md` and
  `workspace-navigation.md` own those, and their controls are triggers here.

## Contracts and visual baselines

`design/contracts/patterns/popup-menu.json` pins, per experience: single-line
rows, the row height token, the App touch floor, and that the list owns its
scroll. Asserted by `e2e/specs/ui-contract-matrix.spec.ts` at every canonical
viewport — the Web rows pin 28px so an App fix cannot move Web silently, and the
App rows pin 44px plus the enumeration that a *control inside* the row meets the
floor.

The App baseline `app-capability-entry.png` draws the capability menu open and
moves with any change to this pattern; it is the only baseline that does.

## Anti-patterns

- A menu row sized by a local metric (`h-8`, `py-1`) instead of the experience's
  control band.
- Fixing the App by giving each menu its own `min-h-11`, leaving the next menu
  wrong.
- Raising Web's rows to the App's floor because the token made it one edit.
- Measuring the trigger, the row, or the menu container and calling the list
  checked — the controls are what a thumb has to hit.
