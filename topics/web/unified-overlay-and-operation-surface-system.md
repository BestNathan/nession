---
title: "Unified overlay and operation surface system"
description: "One cross-family overlay contract: six roles, token-owned Web size roles and viewport clamp, one scrim/surface/title vocabulary, one scroll owner, explicit tooltip/anchored/dialog stacking, Experience-scoped popups, and first-innermost Escape/dismissal semantics"
topic: web
categories: ["design", "interaction", "overlay", "dialog", "ownership", "web", "app"]
status: verified
created_at: 2026-11-10T04:45:00Z
updated_at: 2026-11-10T04:45:00Z
sources: ["https://github.com/BestNathan/nession/issues/3142", "https://github.com/BestNathan/nession/pull/3144", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/docs/design/design-system/patterns/overlay-surfaces.md", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/docs/design/design-system/patterns.md", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/contracts/patterns/overlay-surfaces.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/experience/web.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/experience/app.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/semantic.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/overlayStyles.ts", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/dialog.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/alert-dialog.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/select.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/e2e/acceptance/cases/3142/SC-02/verify.spec.ts", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/e2e/acceptance/cases/3142/SC-04/verify.spec.ts"]
---

# Unified overlay and operation surface system

## Decision

Every surface that interrupts, anchors over, or temporarily replaces the work
region belongs to **one overlay system** (#3142). The canonical presentation
owner is
[`docs/design/design-system/patterns/overlay-surfaces.md`](https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/docs/design/design-system/patterns/overlay-surfaces.md);
the executable vocabulary is
[`web/src/components/ui/overlayStyles.ts`](https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/overlayStyles.ts),
and the shared constraints are pinned by
[`design/contracts/patterns/overlay-surfaces.json`](https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/contracts/patterns/overlay-surfaces.json)
(id `pattern.overlay-surfaces`).

### Six surface roles

| Role | User job | Owns |
|---|---|---|
| Tooltip | Name/explain a control without taking focus | Non-interactive hover/focus text |
| Anchored choice (Select, ContextMenu, DropdownMenu) | Pick one value from a bounded list at a trigger | One choice per row; never becomes a form |
| Popover | Brief contextual controls beside their trigger | One or two compact controls |
| Confirmation (AlertDialog) | Interrupt for one consequential/destructive decision | Explicit confirm, safe default, no entry |
| Simple dialog | Short, non-destructive focused action | A handful of fields that fit a compact surface |
| Complex operation | Multi-step edit/creation over the current work | Web body-scrolling dialog; App full-height depth |

Rules: an anchored surface never grows into an operation editor — if content
outgrows the anchor, promote the role. A modal is not the default container for
actions that can continue beside the surface. Destructive actions use the
confirmation role and never ride along as an undisclosed side effect.

### Web size roles and viewport clamp

Centered overlays select a **semantic role**, never a pixel literal
(`experience.web.overlay.*` → `--nession-overlay-*`):

| Role | Token | Initial value | Typical use |
|---|---|---|---|
| Compact | `compactMaxWidth` | 30rem | Confirmations, rename, short details |
| Standard | `standardMaxWidth` | 40rem | Create Session, bounded forms |
| Wide | `wideMaxWidth` | 45rem | Attach, Project create/settings |

Every centered overlay is clamped by `viewportMaxWidth` (`calc(100% - 2rem)`) and
`viewportMaxHeight` (`calc(100dvh - 2rem)`). The clamp, not the role, decides on
a small viewport; roles do not imply a fixed height. `DialogContent` exposes
`size="compact" | "standard" | "wide"` (default compact, `data-size` recorded)
and the App shares the same roles through its sheet/fullscreen arrangements.
Per-consumer `sm:max-w-[…]` literals are an anti-pattern wherever a role exists.

### Anatomy and one scroll owner

```text
┌──────────────────────────────┐
│ Header — sticky, opaque      │  title/identity, close/back
├──────────────────────────────┤
│ Body — the sole scroll owner │  fields, lists, anchored controls
├──────────────────────────────┤
│ Footer — sticky, opaque,     │  cancel + one primary action
│ flush with the surface edge  │
└──────────────────────────────┘
```

Content takes natural height until the viewport clamp applies; after that the
body scrolls and the header/footer stay put. The sticky footer is an opaque band
flush with the dialog edge (#3128), so scrolling content cannot show through. A
form inside the body must not create a second vertical scroller; lists that need
their own scroll own a bounded region with one axis. Long paths/URLs wrap or
scroll horizontally inside their own field and provide a copy/inspect affordance.

### Experience composition

The explicit Experience route, not the viewport alone, selects the presentation.
Web renders content-capable centered dialogs. App renders a bottom **sheet** for
a short one-action intent (quick Attach over the mounted Terminal), a
**full-height operation page** with exactly one header/Back for substantial
create/edit/configuration, a small confirmation for destructive decisions, and
anchored choices at the App control band. Back/cancel preserves the draft and
selected Session/Terminal until an explicit commit; only the primary action
commits. `?experience=app` at wide keeps the App hierarchy; `?experience=web` at
narrow keeps the Web dialog/drawer behavior.

### One visual grammar

`Dialog` (Base UI) and `AlertDialog` (Radix) keep separate primitives for their
semantics, but they must not keep different values. Both use the one scrim
(`semantic.overlay-scrim`, `oklch(0 0 0 / 0.4)`), the popover surface, a
surface-family radius, ring border, `elevation-floating` shadow, and the one
`overlayTitleClass` title role. Warning/destructive meaning comes from the
action variant and message, never from an unrelated surface palette.

### Portal, stacking and dismissal

Layer order is token-owned and explicit:

```text
tooltip (experience.*.overlay.tooltipZ = 110)
  > anchored popup (anchoredZ = 100)
    > dialog/alert (dialogZ = 50)
```

An anchored Select/Menu opened from a dialog paints above that dialog; a tooltip
may paint above the choice it explains. **A popup carries the Experience scope
of the layer that opened it**: in App, menus, Selects, context menus, popovers and
tooltips portal into the App popup container (`data-experience="app"`), so rows
resolve the App control band (44px touch floor); Web popups keep the default body
mount. The menu-like row band is one owner,
`popupMenuItemBandClass` (`min-h: var(--nession-control-sm)`), shared by
`DropdownMenu`, `Select` and `ContextMenu` — 28px Web, 44px App.

Modality semantics:

- Modal surfaces trap focus and have an accessible name; anchored nonmodal
  surfaces do not trap.
- Escape closes the innermost owned layer first (tooltip → anchored choice →
  dialog), then the dialog.
- Outside click dismisses dismissible layers but never a confirmation. Cancel
  and outside dismissal never execute the primary action; a destructive
  confirmation acts only through its explicit confirm control.
- Focus returns to the trigger after a nonmodal close and to a meaningful
  element after a modal close.

### Boundary with #3137

[#3137](https://github.com/BestNathan/nession/issues/3137) owns what an operation
page/detail/configuration says and its content hierarchy. This system owns which
overlay family presents that content, its size role, anatomy, scroll owner,
stacking, dismissal and focus. A change to one must not silently re-specify the
other. The overlay system also owns no domain state and no second form DSL;
Attach, Session create, Project forms and capability operations keep their
existing owners.

## Context and evidence

Issue [#3142](https://github.com/BestNathan/nession/issues/3142) was the approved
user request for a unified Overlay & Operation Surface design system, delivered
with an interactive prototype. PR
[#3144](https://github.com/BestNathan/nession/pull/3144) merged to staging at
`d59b62c2a79a4a9786484c5880232e0dc5e19dc1`.

- **Production migrations**: Attach uses the wide role; Create Session standard;
  Project create/settings wide; Project rename and the delete alert compact; the
  alert shares the one scrim. `Select`, `ContextMenu`, `Tooltip`, `DropdownMenu`
  and `Popover` portal through the popup container and use the shared anchored z
  and row band. `WorkspaceRegion` now forwards `terminal` to the App layout so a
  forced App Experience at a wide viewport renders without crashing.
- **Web proof**: pre-merge Case Smoke run `42756638022` passed SC-02 through
  SC-05 at the PR head. SC-02 measured the role widths, anchored z above the
  dialog, 28px Web row band, Escape/focus order, 8-location body scroll, flush
  opaque footer and no horizontal overflow at 1440/1180/1024.
- **App proof**: SC-03 measured the 44px menu band inside
  `[data-experience="app"]` at 375/390/430 and 844×390, sheet → settings depth →
  Back draft preservation, one-header App create/location/ENV depths, and the
  explicit Experience route winning at 900 and 390.
- **Stack and dismissal proof**: SC-04 verified a nested Select above the
  Project dialog, child-first Escape with trigger focus, outside dismissal that
  creates nothing, Cancel/Escape/outside never confirming delete, and
  invalid/offline states staying readable without mutation.
- **Prototype proof**: the mock is pinned at reviewed commit
  `82945fb47342a98b8ac5ab2110247079060a285b` under `overlay-system-3142/` on the
  orphan `prototype` branch and published unchanged at `b10943d6`; SC-05 checks
  the public manifest/tree and performs a live Chromium walkthrough. It is mock
  evidence, not production React proof.
- **Agent criterion**: SC-01 (canonical pattern/contract) was evaluated by
  Acceptance / Orchestrator run `42756637562` on the merged SHA and projected
  Pass; selected E2E run `42756638084` passed all five declared regressions
  (`project-management` 3/3, `app-attach-presentation` 2/2,
  `app-session-operations` 1/1, `ui-contract-matrix` 100/100,
  `fixture-visual-app` 22/22).

The migration inventory in the pattern document is a map, not a mandate for bulk
restyling: each row migrates when its owner changes, and the proof is the
browser Case for that surface.

## Related knowledge

- [Session and Project operation surface presentation by Experience](session-and-project-operation-surface-presentation-by-experience.md)
  owns the Attach/create/Project compositions that select these roles and the
  one-owner-per-operation rule.
- [Web primitive focus treatment and visual vocabulary ownership](web-primitive-focus-treatment-and-visual-vocabulary-ownership.md)
  owns the modality-aware focus recipe used inside these surfaces.
- [Web Session-first navigation, reserved rail and explicit experience mode](web-session-first-navigation-reserved-rail-and-explicit-experience-mode.md)
  owns the Experience route and navigation shell the App compositions live in.

## Limits / when to revisit

- Size roles define widths, not heights; the viewport clamp and the body scroll
  are the only height behavior. Do not turn a role into a fixed-height contract.
- The App full-height operation page is a Dialog arrangement over the mounted
  shell, not a new App spatial layer; a future App navigation model must preserve
  the selected Session/Terminal and draft before replacing it.
- `Dialog` and `AlertDialog` intentionally remain different primitives. Unifying
  their semantics (e.g. making outside click dismiss a confirmation) is a product
  decision, not a styling refactor.
- Native iOS/Safari behavior is not claimed; App layout, touch, landscape and
  safe-area behavior is asserted through Chromium fixture runs.
- The prototype is a deterministic mock and never proves production behavior.
- A surface that genuinely needs a fourth Web size role or a new layer must
  change the token owner, the pattern document, the contract and the browser
  proof together. Consumers should opt into an existing role first.
