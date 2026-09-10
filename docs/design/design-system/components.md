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
