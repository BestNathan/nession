---
title: "Unified overlay and operation surface system"
description: "One cross-family overlay contract: six roles, action/resource anchored-choice anatomies, token-owned Web size and choice-width roles, trigger-relative Select placement with collision as an exception, one scrim/surface/title vocabulary, one scroll owner, explicit stacking, Experience-scoped and modal-owned popup hosts, and first-innermost Escape/dismissal semantics"
topic: web
categories: ["design", "interaction", "overlay", "dialog", "ownership", "web", "app"]
status: verified
created_at: 2026-11-10T04:45:00Z
updated_at: 2026-11-11T05:04:45Z
sources: ["https://github.com/BestNathan/nession/issues/3142", "https://github.com/BestNathan/nession/pull/3144", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/docs/design/design-system/patterns/overlay-surfaces.md", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/docs/design/design-system/patterns.md", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/contracts/patterns/overlay-surfaces.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/experience/web.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/experience/app.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/design/tokens/semantic.json", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/overlayStyles.ts", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/dialog.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/alert-dialog.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/web/src/components/ui/select.tsx", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/e2e/acceptance/cases/3142/SC-02/verify.spec.ts", "https://github.com/BestNathan/nession/blob/d59b62c2a79a4a9786484c5880232e0dc5e19dc1/e2e/acceptance/cases/3142/SC-04/verify.spec.ts", "https://github.com/BestNathan/nession/issues/3164", "https://github.com/BestNathan/nession/pull/3184", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/docs/design/design-system/patterns/popup-menu.md", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/design/contracts/patterns/choice-item.json", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/web/src/components/ui/choice-item.tsx", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/web/src/components/ui/choice-itemStyles.ts", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/web/src/components/ui/dialog.tsx", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/web/src/components/ui/select.tsx", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/e2e/acceptance/cases/3164/SC-02/verify.spec.ts", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/e2e/acceptance/cases/3164/SC-03/verify.spec.ts", "https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/e2e/acceptance/cases/3164/SC-04/verify.spec.ts", "https://github.com/BestNathan/nession/issues/3246", "https://github.com/BestNathan/nession/pull/3254", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/web/src/components/ui/select.tsx", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/docs/design/design-system/patterns/popup-menu.md", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/design/contracts/patterns/popup-menu.json", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/e2e/helpers/selectAnchor.ts", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/e2e/acceptance/cases/3246/SC-01/verify.spec.ts", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/e2e/acceptance/cases/3246/SC-02/verify.spec.ts", "https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/e2e/acceptance/cases/3246/SC-03/verify.spec.ts"]
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
| Anchored choice (Select, ContextMenu, DropdownMenu) | Pick one value from a bounded list at a trigger | One choice per row; an action or resource anatomy; never becomes a form |
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

### Anchored choice anatomy

An anchored list has two item anatomies, owned by
[PopupMenu](https://github.com/BestNathan/nession/blob/dae365aa51972495086360eb1e8d0f9c18e72f00/docs/design/design-system/patterns/popup-menu.md)
(#3164):

- **Action / one-line choice** — a command or short label. It stays single-line
  at the Experience control band (28px Web, 44px App), with one title, optional
  leading mark/shortcut and the trailing check. This is the original PopupMenu
  contract and it is unchanged.
- **Resource / rich choice** — choosing among resources that carry an identity
  plus source, status or path. `ChoiceItemContent`
  (`web/src/components/ui/choice-item.tsx`) owns the slot grammar: a body-role
  title, optional caption-role status (destructive only when unavailable),
  optional metadata and a mono technical detail that wraps anywhere. The row
  wraps and takes its content's height; the Experience control band is its
  minimum, so App never falls below the 44px touch floor. Selected state is a
  quiet neutral surface plus the stable check, focus keeps the one accent
  surface, and an unavailable resource says so in text rather than relying on
  opacity.

`SelectItem`, `DropdownMenuItem` and `ContextMenuItem` accept
`anatomy="resource"`; the row surface has one owner in
`choice-itemStyles.ts`, and the action band keeps
`popupMenuItemBandClass`. A resource list is never narrower than its trigger
and may grow up to `experience.*.overlay.choiceMaxWidth` (30rem), with Base UI's
available width as the final viewport clamp; simple lists keep the anchor width.
The resource anatomy is opt-in for data that actually has a resource identity —
it is not a global menu restyle, and it never changes the 28/44 action band.

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

**Inside a modal, the popup host lives in that modal.** `DialogContent` supplies
a `dialog-popup-portal` host inside the dialog's floating tree and copies the
inherited `data-experience` scope onto it. A body-level container would be
hidden from assistive technology by the modal's outside-content protection,
outside its focus trap, and could resolve a different Experience density. The
modal host changes only where the popup mounts; the anchored layer still owns
its token z-order and still paints above the dialog. This applies to both Web
and App dialogs, including dialogs that do not themselves state an Experience
scope (for example the App Env import dialog).

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

### Resource-choice rows and the modal popup host (#3164)

PR [#3184](https://github.com/BestNathan/nession/pull/3184) merged to staging at
`dae365aa51972495086360eb1e8d0f9c18e72f00` extended the anchored choice without
changing the action-row contract:

- **Two anatomies, one family.** Action rows keep the 28px Web / 44px App band
  and the original `popupMenuItemBandClass`; resource rows use the new
  `resourceChoiceItemClass` and `ChoiceItemContent` slot grammar, with
  `SelectItem`/`DropdownMenuItem`/`ContextMenuItem` accepting
  `anatomy="resource"`. Resource rows wrap, use the control band as their
  minimum, show a quiet status and optional metadata/mono path, keep the check
  aligned and mark unavailable state in text.
- **Choice width.** Resource lists are never narrower than their trigger and
  grow up to `experience.*.overlay.choiceMaxWidth` (30rem), clamped by Base UI's
  available width. Simple lists keep `w-(--anchor-width)`.
- **Pilot consumers.** Project Existing Location and Agent choices, Create
  Session Agent/Existing Location, and the Env import/editor Agent choices. The
  action rows beside them (for example Env import Location) stayed at 28px Web
  and 44px App.
- **Modal host.** `DialogContent` now supplies a dialog-owned
  `dialog-popup-portal` host and copies the inherited Experience scope onto it.
  This keeps an anchored layer inside the modal's focus trap, accessible subtree
  and token scope; the body-level App container was aria-hidden by the modal's
  outside-content protection. The App Env import dialog (which does not state an
  Experience scope itself) still resolves the 44px row band through the copied
  scope.
- **Proof.** Pre-merge SC-01 agent run `42810517154` and Case Smoke run
  `42810520569` passed at the PR head: SC-02 4/4 browser tests (351 assertions),
  SC-03 5/5 (84), SC-04 runtime + 2/2 browser (61), including Web
  1440/1180/1024, App 375/390/430, the 23-agent available-height scroll fixture,
  long paths, outside dismissal, dark contrast, and the live prototype. Selected
  E2E run `42810520511` passed `app-attach-presentation` 2/2,
  `fixture-visual-app` 22/22, `project-management` 3/3 and
  `ui-contract-matrix` 100/100. The `choice-list-3164` prototype remained pinned
  at `5906b9d946fd9e117ed89072fc52d874b85e61e4` and published unchanged. Staging
  `deploy-watch` verified server, agent and ui pods on image `dae365a`.

### Trigger-relative placement and collision (#3246)

PR [#3254](https://github.com/BestNathan/nession/pull/3254) merged to staging at
`1c2e06b81a62e40d51c829c44813b3f6ed665497` fixed the standard anchored Select's placement by changing the
shared `SelectContent` defaults in
[`web/src/components/ui/select.tsx`](https://github.com/BestNathan/nession/blob/1c2e06b81a62e40d51c829c44813b3f6ed665497/web/src/components/ui/select.tsx),
not by adding consumer offsets:

- **Standard placement.** `SelectContent` defaults to `side="bottom"`,
  `sideOffset=4`, `align="start"` and `alignItemWithTrigger=false`. Measured
  after the opening animation settles, the popup's start edge matches the
  trigger's start edge within 2px and the vertical gap is the configured
  `sideOffset` within 2px. The selected option index does not move that anchor,
  and `width="content"` grows the list from the same start edge. Base UI keeps
  ownership of collision avoidance.
- **Why item-aligned was wrong here.** Base UI's `alignItemWithTrigger` overlaps
  the selected row with the trigger and writes viewport-fixed coordinates.
  Outside a dialog the old default covered the trigger vertically (measured
  gap `-32px`); inside a Dialog the `dialog-popup-portal` host lives in the
  dialog's translated containing block, so fixed coordinates were re-anchored by
  the dialog origin (measured ≈360px horizontal / ≈58px vertical at 1440).
  Normal absolute anchoring is the form that survives the modal host.
  `alignItemWithTrigger` remains an explicit opt-in for a future surface that
  genuinely needs selected-row overlap; no current consumer opts in.
- **Collision is a documented exception.** Near a viewport edge Base UI may
  shift horizontally or flip above the trigger (`data-side="top"`). The
  invariant then is visibility, operability, continued horizontal overlap with
  the trigger, and one list scroll owner — not always-bottom/always-left.
  `DropdownMenu` keeps its trigger anchor, `ContextMenu` its pointer origin, and
  `Popover` its scene-specific centring; none were restyled by this fix.
- **Proof.** Pre-merge cases: SC-01 2/2 (214 assertions) and SC-02 2/2 (229) at
  `d30cf5858e73ddaaff2744a0b7146a8e67edcc03`; SC-03 4/4 (105) at
  `849a32af2611748181902a68ec0a0005dc35d73e` (run `42962531168`). The web unit,
  integration and coverage gates and the selected E2E regressions
  (`ui-contract-matrix`, `project-session-create`, `project-management`, run
  `42962531171`) verify the same behavior. The linked #3089
  `session-operation-surfaces-3089` and #3164 `choice-list-3164` prototypes were
  audited at `2126adf00`: both already place options start-aligned below the
  trigger, so no prototype revision or stale marking was required.

## Related knowledge

- [Session and Project operation surface presentation by Experience](session-and-project-operation-surface-presentation-by-experience.md)
  owns the Attach/create/Project compositions that select these roles and the
  one-owner-per-operation rule.
- [Web primitive focus treatment and visual vocabulary ownership](web-primitive-focus-treatment-and-visual-vocabulary-ownership.md)
  owns the modality-aware focus recipe used inside these surfaces.
- [Web Session-first navigation, reserved rail and explicit experience mode](web-session-first-navigation-reserved-rail-and-explicit-experience-mode.md)
  owns the Experience route and navigation shell the App compositions live in.
- [Shared content-region visual recipes](shared-content-region-visual-recipes.md)
  owns the body/action grammar inside a detail, configuration or operation
  region; it composes these overlay roles rather than forking them.

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
- The 28/44 action band remains the only contract for action rows. A resource
  row growing taller is not evidence for raising Web's action density or
  lowering App's touch floor.
- The resource anatomy is opt-in for data with a real resource identity. Do not
  convert plain command menus, or a free-entry ComboBox such as the Sandbox KV
  editor, without a separate interaction-model decision.
- The dialog popup host is a mount point that carries scope, focus and
  accessibility. It is not a layout container; do not hang scroll ownership or
  positioning assumptions on it.
