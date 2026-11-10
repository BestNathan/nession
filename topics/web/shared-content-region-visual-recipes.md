---
title: "Shared content-region visual recipes"
description: "Resource detail, configuration form and operation surface as one domain-agnostic Nession product grammar shared by Project, Sandbox, Session and Environment surfaces"
topic: web
categories: ["design", "ui", "patterns", "ownership", "web", "app"]
status: verified
created_at: 2026-11-10T17:51:00Z
updated_at: 2026-11-10T17:51:00Z
sources: ["https://github.com/BestNathan/nession/issues/3137", "https://github.com/BestNathan/nession/pull/3226", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/resource-detail.md", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/configuration-form.md", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/operation-surface.md", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns.md", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/design/contracts/patterns/resource-detail.json", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/design/contracts/patterns/configuration-form.json", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/design/contracts/patterns/operation-surface.json", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/web/src/components/ui/resource-detail.tsx", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/web/src/components/ui/configuration-form.tsx", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/web/src/components/ui/operation-surface.tsx", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/web/src/components/ui/overlayStyles.ts", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/e2e/acceptance/cases/3137/SC-02/verify.spec.ts", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/e2e/acceptance/cases/3137/SC-03/verify.spec.ts", "https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/e2e/acceptance/cases/3137/SC-04/verify.cjs"]
---

# Shared content-region visual recipes

## Decision

Nession owns a layer above generic primitives and below feature content:
**product visual grammar / recipes**. #3137 established its first
cross-capability family — ResourceDetail, ConfigurationForm and
OperationSurface — and migrated Project, Sandbox and the Session work-context
reference onto it.

The recipes are domain-agnostic and live in `web/src/components/ui/` because
both `product` (Project, Session) and `capabilities` (Sandbox, Environment)
consume them, and the Web layer model forbids `capabilities → product` imports.
They know roles and anatomy, not Project or Sandbox meaning. They are not a
universal page DSL: each host keeps its shell, Back/header, width and scroll
ownership.

| Recipe | Owner | Job |
|---|---|---|
| ResourceDetail | `web/src/components/ui/resource-detail.tsx` | Show a resource declaration or a capability's observed state: identity, quiet scope, read-only facts, groups, local actions, recovery |
| ConfigurationForm | `web/src/components/ui/configuration-form.tsx` | Edit resource configuration: named sections, label/control/help/field error, related-field grid, repeated rows, grouped actions |
| OperationSurface | `web/src/components/ui/operation-surface.tsx` | Govern the body/action grammar inside a deliberate operation; the Web Dialog and App operation page/sheet stay owned by #3142 / #3089 |

Canonical prose:
[`resource-detail.md`](https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/resource-detail.md),
[`configuration-form.md`](https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/configuration-form.md) and
[`operation-surface.md`](https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns/operation-surface.md),
indexed as the content-region family in
[`patterns.md`](https://github.com/BestNathan/nession/blob/65e01ac09f76d8995cff69148df15dd5c070a4b1/docs/design/design-system/patterns.md).
Executable constraints are pinned by
`design/contracts/patterns/{resource-detail,configuration-form,operation-surface}.json`.

## Relationships that are now fixed

- A surface's own name uses the `title` typography role everywhere — detail,
  capability and overlay operation titles. A section heading is `secondary`;
  a read-only fact label is quiet `caption`; values are `body` or mono `code`.
- A read-only fact is a label/value pair, never an input-shaped box, a
  fieldset or a disabled control. Observed Sandbox policy therefore reads as
  facts, not as the editable composer.
- A detail/configuration section is separated by rhythm first. A repeated
  editable row may use one background shift; facts and groups do not need
  cards. This replaces the former per-page `boxClass`/fieldset family.
- Web field/action bands are `control.md` (32px); App keeps the 44px touch
  floor. Form pairs stack below the large Web width, so App landscape still
  stacks rather than shaving touch targets.
- Field validation stays on `FormField`; an operation-level failure uses
  `OperationError`. A field error is not a body paragraph.
- An operation has one close/Back owner, one scroll owner and one action line,
  secondary before primary. The App's one page header owns the pushed title; a
  body does not repeat it.

The shared owners emit `data-recipe` and `data-recipe-part` markers, which let
the production Web/App Cases compare corresponding roles between independent
surfaces instead of checking each surface in isolation.

## Consumers

- Project: `ProjectDetail.tsx`, `ProjectFormFields.tsx`,
  `ProjectLocationsEditor.tsx`, `ProjectDialogs.tsx`; App `AppProjectDetail`
  now lets its host header own the Project name.
- Sandbox: `SandboxInsideView`, `SandboxEffectivePolicy`,
  `SandboxExecutionDetails`, `SandboxUnavailableView`, `SandboxComposer`,
  `SandboxFilesystemFields`, `SandboxNetworkProcessFields`,
  `SandboxKvEditor`/`SandboxKvRow`, `SandboxSyscallProfile`,
  `SandboxConfirmView` and related summary/action surfaces.
- Session work-context detail/editor as the existing reference.

Domain semantics did not move: Project locations keep their own data/action
owner and compact row; Sandbox Key/Value keeps its Agent-measured availability;
each domain keeps validation, draft and submit.

## Evidence

- Acceptance SC-02 (Web 1440/1180/1024) and SC-03 (App 390/375/844×390) are
  computed-style/geometry Cases, not screenshot claims; both Pass.
- SC-04 revised the existing `project-session-3025`,
  `sandbox-capability-3124` and `session-operation-surfaces-3089` prototypes in
  place at orphan commit `fc09bf0613adfd0b451ff28c292311b0e6f4292c`, verified
  against the public Pages manifest and walked in Chromium.
- E2E regressions `project-management`, `sandbox-workspace-capability`,
  `fixture-visual` and `fixture-visual-app` Pass. The only baseline movement
  was the two dialogs that paint the new shared title role; the other
  sub-tolerance regeneration drift was intentionally not committed.

## Limits

The recipes do not own product semantics, navigation, capability presence or
the overlay role decision. They do not justify moving Files/Git/Claude Code
onto a new layout. A second consumer must exist before promoting another
control into this family; a genuinely feature-specific composition stays with
its feature owner. Prototype mocks are comparison artifacts, not production
Acceptance evidence.

## Related knowledge

- [Unified overlay and operation surface system](unified-overlay-and-operation-surface-system.md) — the upstream overlay roles and stacking/dismissal owner that OperationSurface composes.
- [Session and Project operation surface presentation by Experience](session-and-project-operation-surface-presentation-by-experience.md) — the #3089 Web Dialog vs App operation page/sheet decision.
- [Web primitive focus treatment and visual vocabulary ownership](web-primitive-focus-treatment-and-visual-vocabulary-ownership.md) — the token/focus vocabulary these recipes consume.
