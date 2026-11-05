# Web / App Shell Fidelity

Read when a mock displays an entire Nession product page, navigation between Sessions/Terminal/Workspace, or global shell chrome. Pair with [presentation-frame.md](presentation-frame.md).

## Read these owners before drawing

- Product: [Vision](../../../../VISION.md), [Principles](../../../../PRINCIPLE.md), [composition](../../../../docs/design/composition.md) and [visual language](../../../../docs/design/visual-language.md).
- Experience: [Web interaction](../../../../docs/design/interaction/web.md), [App interaction](../../../../docs/design/interaction/app.md), [product patterns](../../../../docs/design/design-system/patterns.md).
- Current code: [WebLayout](../../../../web/src/app/experiences/web/WebLayout.tsx), [AppLayout](../../../../web/src/app/experiences/app/AppLayout.tsx), [AppLayers](../../../../web/src/app/experiences/app/AppLayers.tsx), [ShellMain](../../../../web/src/app/ShellMain.tsx), [Sidebar](../../../../web/src/app/Sidebar.tsx).
- Canonical deterministic visual baseline: [FixtureShell](../../../../web/src/app/fixture/FixtureShell.tsx) and [FixtureApp](../../../../web/src/app/fixture/FixtureApp.tsx). Compare real fixture/browser pixels at the relevant viewport; old prototype screenshots are not the source of truth.
- Color/material, typography, spacing, radius, state and chrome geometry: [generated Web CSS](../../../../design/generated/web.css), [token sources](../../../../design/tokens/) and [design-system token policy](../../../../docs/design/design-system/tokens.md).

## Composition

**Wide Web:** current Session work is visually primary, with Session navigation secondary; the shipped layout has a collapsible sidebar/one-action summary rail. At narrow widths navigation becomes an overlay. Do not add an invented product-wide top banner, permanent navigation for every capability, or obligatory Terminal/Workspace/Files tab row.

**App:** Sessions ← Terminal → Workspace expresses a spatial relationship, not a reduced desktop sidebar or three permanently mounted columns. Use the App's page/depth, gesture and safe-area behavior. No Session means home, not a fake terminal.

**Both:** the active work surface dominates. Infrastructure metadata remains quiet. Workspace is contextual depth and capabilities emerge when relevant; their availability does not justify permanent chrome. Preserve Session continuity.

## Visual fidelity

A product viewport **must follow the current Nession design vocabulary and core component grammar**: generated `--nession-*` semantic tokens, appropriate Web/App experience values, real shell/capsule/button/row anatomy, typography roles, interactions and responsive behavior. For standalone HTML, a minimal **local snapshot** of the relevant generated values/recipes is permitted; pin the source revision and list approximations in README. Never invent an unrelated `--bg`/`--panel`/`--accent` palette and call it Nession. Do not import live application services/auth/network into public prototypes. Never hand-edit generated token outputs.

A proposed **different** shell is valid only if the owning Issue asks to evaluate that design. Document baseline vs proposal externally and clearly flag the visual divergence; do not present a candidate as the current product.

## Review questions

- Does current work own the frame, without a prototype-only header inside?
- Does Web sidebar/rail/overlay behave appropriately? Is App a genuinely different composition?
- Do controls, typography, materials and spacing match current source/fixture?
- Can the outer harness be hidden without changing the simulated product?
- Were a desktop and narrow/touch layout inspected, with the comparison method recorded?
