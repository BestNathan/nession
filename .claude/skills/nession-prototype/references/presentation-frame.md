# Prototype Presentation Frame

This reference defines the **outer presentation of a clickable prototype**, not the Nession product UI. Read for every new or materially revised standalone prototype.

## Two clearly separate layers

```text
Prototype page
┌──────────────────────────────────────────────────────────────┐
│ PRODUCT VIEWPORT — DOMINANT, MOST OF THE AREA                  │
│   Real Nession screen, composition, controls, interactions    │
│   Only feedback a real end user would encounter               │
├──────────────────────────────────────────────────────────────┤
│ Prototype harness — outside product UI, quiet/compact          │
│ [Web/App if needed] [Scenario] [Reset] [Issue] [View source]  │
│ [collapsed: design notes / mock limits / inspector / logs]    │
└──────────────────────────────────────────────────────────────┘
```

**Inside the product viewport:** render the actual target Web/App/Terminal/Workspace surface. All apparent product controls must work in the mock or show a truthful unavailable/disabled state. Keep the page's real initial/loading/empty/error/confirmation behavior. Do not embed "prototype", "mock", requirement text, test instructions, state dumps, developer shortcuts, or device measurement labels into product headers, content, terminal cells, or capability UI.

**Outside the viewport:** place prototype identity, Issue/pinned source, scenario or experience selector, reset/replay, mock warnings, concise test notes, and an optional collapsible inspector. It must not cover/take permanent room from the product area. Put it below the viewport or as a small secondary side area on wide screens; collapse or move it below on mobile.

## Minimal semantic skeleton (no extra product design system)

```html
<div class="prototype-page">
  <main class="prototype-stage" aria-label="Interactive Nession preview">
    <section class="product-viewport" data-experience="web">
      <!-- Actual Nession Web/App UI for the scenario -->
    </section>
  </main>
  <aside class="prototype-harness" aria-label="Prototype controls">
    <!-- Scenario, device, reset, Issue and View source -->
    <details>
      <summary>Notes and mock limitations</summary>
      <!-- Never overlay the product viewport -->
    </details>
  </aside>
</div>
```

This is a **semantic boundary**, not a universal CSS or component runtime. The stage is screen-first, near full available width/height, with no mandatory presentation header, device bezel, permanent debug sidebar or fake OS chrome. If viewport framing is needed to explain mobile gestures/safe areas, the frame belongs to the external simulator and must not change the inner product UI. A prototype exploring a single component can omit unrelated global shell elements.

## Interaction / delivery contract

1. Initial state loads immediately as a usable product screen, not a teaching splash.
2. Demonstrate a complete, deterministic interaction, including key alternate states; reset and simulation controls belong to the harness.
3. Separate test controls from real product controls in markup, event handling and accessibility labels. Product interaction still works when harness notes are collapsed.
4. User-facing in-product text is allowed only if genuinely part of the product design. Decision rationale, test narrative and simulated transport notes stay outside.
5. Record in README: target surface, baseline source/fixture revision, scenario, explicit design departures, fixture/mock fidelity, harness placement, desktop/narrow behavior, exact checks and unverified gaps. Verification/publishing remains owned by the parent [Skill](../SKILL.md).

**Migration:** apply to newly authored and substantively revised prototypes. Do not mass-edit historical published mocks or silently invalidate pinned source links.
