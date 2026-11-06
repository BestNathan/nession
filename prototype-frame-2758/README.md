# Shared Prototype Page Kit — #2758

The authored review-page components are **presentation only**, not Nession product runtime and not a forked UI design-system.

## API and assets

- `frame.css`: namespaced `np-*` classes for three-region review page, links, preview stage, viewport, and documentation cards; never overrides product CSS tokens.
- `frame.js`: deterministic viewport-size selectors (`data-np-size="375"` etc.) and Reset (`data-np-reset`), plus read-only `np:resize` event on the simulated screen; no product transport/side effects.
- `index.html`: standalone example of the **page frame only**, with an explicit placeholder product surface. Not an end-user UI acceptance artifact.

## Inclusion in sibling prototype

```html
<link rel="stylesheet" href="../prototype-frame-2758/frame.css">
<div class="np-page" data-np-root>
  <header class="np-overview">…</header>
  <main>
    <section class="np-preview">
      <div class="np-preview-toolbar">
        <button data-np-size="375">375</button>
        <button data-np-size="390" aria-pressed="true">390</button>
        <button data-np-size="430">430</button>
        <button data-np-reset>Reset</button>
      </div>
      <div class="np-stage">
        <div class="np-device" data-np-device><!-- Real product mock only --></div>
      </div>
    </section>
    <section class="np-details">…</section>
  </main>
</div>
<script src="../prototype-frame-2758/frame.js"></script>
```

The `data-nession-prototype-frame="v1"` body and one each of `data-nession-gallery-link` / `data-nession-source-link` are required by the trusted publisher to pin Source and skip the legacy fixed footer. Published assets are read-only files from the orphan branch. Source SHA: always use the currently published prototype commit, never assume branch HEAD equals public Pages.

## Fidelity

**1:1 device size** is 1 CSS px to 1 CSS px, with no zoom or transform, not proof of matching React UI. Use real `web/src/app/fixture/*` and relevant production components to validate the product area; keep baseline revision and differences in each prototype README. This showcase does not validate any actual Nession Terminal UI behavior.

## Verification

Source-only checks: import paths are relative, CSS namespaced, no product commands/API, controls mutate only preview width/reset; browser/PAGES SHA and viewport checks must be recorded separately.

## Legacy mock adoption (2026-11-06)

The shared kit also provides `review-bridge.css` and `review-bridge.js`. They are narrowly scoped presentation adapters for the 12 historical demos that have their own product layout/interaction code. A migrated `index.html` contains the publisher-required static gallery/source anchors, a self-contained interactive `np-device` and a JSON `np-review-config`. The bridge moves the existing product DOM under the target device (preserving element IDs/event listeners), moves mock-only controls/inspectors to the external review surface, and mirrors width-based media rules as CSS container queries so selecting a device size does not depend solely on the outer reviewer's browser width.

The review adapter is **not** a product-side feature or a substitute for a proper rewrite against current Nession patterns. For example, window-width JavaScript decisions, old CSS palettes, or fake Terminal cells may still diverge from the actual App/Web viewport. The controlling Requirement remains authoritative. Never put network/real Session behavior in this branch. Before claiming completion, run the original scenario smoke and Chromium + Playwright at each provided viewport and compare with the current fixtures. This migration has static source review but no new browser screenshots or Pages manifest proof yet.
