# Components (primitives)

> Upstream: [`VISION.md`](../../../VISION.md) → [`PRINCIPLE.md`](../../../PRINCIPLE.md) → [patterns](patterns.md)

Primitive components stay generic. Nession product identity lives in product patterns, interaction models, and contextual composition — not in a custom button kit.

```text
Button
Input
Tabs
Toggle
List
Menu
Popover
Sheet
Dialog
Status
```

This list is illustrative, not an install inventory. Web continues to prefer shadcn/ui primitives; App uses corresponding native primitives.

## Boundary

A primitive answers **how a generic interaction is rendered**. It does not decide **whether a capability deserves product presence**.

```text
extension / capability
    -> semantic contribution
    -> product context decides presence
    -> pattern decides composition
    -> primitive renders the interaction
```

That ordering matters. A plugin registering a view must not automatically create a new primitive, tab, or permanent navigation slot.

## Rules

- Primitives have no Session / Workspace / Agent / Terminal / capability-state knowledge.
- Primitives consume Semantic and platform Experience tokens, never Primitive palette tokens directly ([tokens.md](tokens.md)).
- If a control needs product semantics (Session row, connection context, contextual capability presence, workspace navigation), it is a **pattern/composition**, not a new primitive.
- Product patterns may compose the same primitives differently on Web and App without forking the product meaning.
- Extension-specific components may exist inside an extension, but shared/global chrome still follows Nession patterns and visual language.
- A primitive should not encode product policy such as `always show this tab`, `Agent is navigation parent`, or `one extension = one button`.

### Focus treatment

Focus is a modality-aware interaction state, not decoration (#2750). Pointer and
touch interaction must not add an outer halo, glow, or second frame; keyboard
focus must stay locatable inside the control's own geometry.

| Control family | Keyboard-visible focus |
|---|---|
| Bordered field primitives — `Input`, `Textarea`, `Select` trigger | the existing border repaints in `ring`; no outline or ring is added |
| Controls with no usable border to repaint — `Button`, `Toggle`, `Tabs`, `Checkbox`, `ScrollArea`, borderless action/row buttons | an inset outline `focus.ringWidth` thick in `ring`, placed `focus.ringOffset` inside the border edge |

The split follows what `:focus-visible` can promise. Text-entry fields match it
on pointer focus too, so a second frame would appear on every click; repainting
the existing border is the quietest honest indicator. Controls that only match
it after keyboard interaction can afford a stronger, still in-geometry outline.
The inset outline uses `outline` rather than a `box-shadow` ring so it survives
forced-colors mode and is not clipped by a scrolling ancestor.

- Invalid keeps its own border (`destructive`); a focused invalid control also
  shows the inset outline, so focus does not disappear when validation fails.
- Disabled controls do not receive focus, so they carry no focus treatment.
- Popup menu rows keep their focused-row surface; a popup trigger follows the
  control that renders it (`Button`, `SelectTrigger`).
- Do not suppress focus globally, add per-page overrides, or restore an outset
  `ring-*` halo.
- Values live in `experience.web.focus`; consumers use the generated
  `--nession-focus-ring-*` vocabulary instead of literal widths or offsets.

### Which upstream geometry gets an owner

shadcn primitives arrive with their own geometry. Replacing all of it is
tokenising for its own sake; replacing none of it means every `shadcn add`
re-imports a second design system. The line:

| Gets a Nession owner | Stays upstream |
|---|---|
| the control's **height**, from the Experience control band (`Button.size.sm` → `--control-sm`) | padding and gap steps (`px-2.5`, `gap-1.5`) — accepted Tailwind scale |
| the control's **corner radius**, from the radius token | icon sizes *inside* a control (`size-3.5` next to a 28px button) |
| | steps with no band (`h-6` — 24px sits below `--control-sm`) |

Driving height from the band is not cosmetic. The band is remapped per
experience (`--control-md` is 32px on Web and 44px on App), so a primitive whose
height comes from it inherits the App touch floor for free — which is what
`experience/app.json` says the floor is for: *"no control size may sit below
it"*. A hardcoded `h-8` bypasses that and renders a 32px control on a phone.

A literal **inside** an arbitrary value counts as geometry too:
`rounded-[min(var(--radius-md),10px)]` chooses a 10px cap and, before #774,
nothing objected — the scanner only saw brackets holding nothing but a number.
`calc()` is exempt: `h-[calc(100%-1px)]` is arithmetic against an
already-resolved dimension, not a design choice.

### A tap target has two geometries, and the band owns only one

The band above is the control's **hit target** — the box that receives the tap.
A control may also paint something **inside** that box, and that is a second
owner, not a second band:

| Gets a Nession owner | Detail |
|---|---|
| the **hit target** | the Experience control band (`--control-md`) — `category.control`'s `heightToken`, and the touch floor on App |
| the **affordance drawn in it** | `control.visualSize`, named per Experience by `pattern.terminal-capsule`'s `visualSizeToken` |

Both are Nession's, and they are deliberately different sizes on App: the touch
floor makes a full-band **hit target** correct, while a control that *paints* the
whole band makes every secondary icon action read as a primary button. On Web
there is no touch floor, so the drawn affordance may fill the control it sits in
and the split is a no-op — which is why the token is declared in both
experiences rather than App-only.

**Two DOM nodes, never two values on one element.** Everything that asserts a
control's geometry (`expectTokenHeight`, `expectTouchTarget`) measures the
element it is handed, so shrinking the *class* would shrink the tap target —
the opposite of the intent — and the smaller painting would be unmeasurable
anywhere. The design gate fails a control whose painting reached its hit target,
which is what stops the two from quietly converging back into one.

## Product identity

Do not fork Button, Input, Tabs, Sheet, or Menu into Nession-branded variants merely to create identity.

Nession's identity should come from:

- what dominates and what recedes;
- contextual capability presence;
- progressive disclosure;
- precise spacing, typography, state transitions, and motion;
- coherent Session/Workspace interaction;
- consistent composition across built-in and extension capabilities.

Examples of product-level patterns include [SessionList](patterns/session-list.md), [TerminalCapsule](patterns/terminal-capsule.md), [WorkspaceNavigation](patterns/workspace-navigation.md), and contextual infrastructure/detail views.

`SurfaceSwitcher`, tabs, menus, or sheets are presentation choices that may realize a product relationship; the primitive itself is never the product model.

## Anti-patterns

- A feature creates its own global visual language by wrapping every primitive.
- One plugin ships a custom permanent navigation control outside Nession composition.
- Primitive API names encode current IA assumptions such as `workspaceToolTab`.
- A design decision is justified because a generic primitive already exists.
- Product growth is expressed as an ever-growing set of top-level buttons/tabs.
