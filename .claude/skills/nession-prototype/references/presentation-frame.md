# Prototype Review Page — Three Regions

This reference owns the **outer review-page layout** around a Nession interactive mock. It supersedes the older screen-first/two-zone page arrangement, **not** the separation between the product UI and design documentation.

## Fixed reading order

```text
01  OVERVIEW / REQUIREMENT
    Nession / Prototypes  ·  Issue # · PR(s) · pinned Source
    Title, concise question, target product surface, published revision

02  INTERACTIVE PRODUCT PREVIEW (dominant)
    Target: App / Web    Size: 375 | 390 | 430 (or desktop)    Reset
    ┌───────────────────────────────────────────────────────┐
    │ Actual product surface at real CSS pixel dimensions  │
    │ Realistic shell/Terminal/Workspace; interactive       │
    └───────────────────────────────────────────────────────┘

03  FUNCTIONAL DESIGN / VERIFICATION
    Features & states · interaction walkthrough · decisions
    Fidelity vs actual product · mock constraints · evidence
    [Optional collapsed state / event inspector]
```

**The overview and documentation are parts of the prototype *review page*, not product chrome.** Do not insert source links, fixture controls, fake transport messages, or testing explanations into Terminal, Workspace, title bars or functional product components.

## Reusable frame (one owner)

- The shared static component library lives on the orphan `prototype` branch at `prototype-frame-2758/frame.css` and `frame.js`. The directory also has a [clickable frame showcase](https://github.com/BestNathan/nession/blob/prototype/prototype-frame-2758/index.html) in that branch, and an explicit fidelity record. Use these relative references from another sibling prototype directory: `../prototype-frame-2758/frame.css` and `../prototype-frame-2758/frame.js`. The trusted Pages publisher copies the library as ordinary allowlisted static assets; neither build-time nor browser-time code from the untrusted branch runs inside the trusted runner.
- This is a presentation-layer library, **not** a second Nession product component library. CSS selectors are scoped to `np-*` and do **not** supply or override `--nession-*` product tokens. Product geometry/styles must still be sourced from `web/src/*`, `docs/design/*` and `design/generated/web.css`.
- Required anatomy: `np-page` page root; `np-overview` header; `np-preview` section; `np-preview-toolbar` with `data-np-size` and `data-np-reset` controls; `np-stage` containing one `np-device` viewport; `np-details` functional documentation.
- The actual product screen should be the **only** child/inner subtree of the `np-device`. App switch/navigation stays inside it only when it is genuinely product behavior. All simulation controls remain outside it.
- `data-np-size="375"`, `390`, `430` switches the CSS pixel width of the preview without `transform:scale(...)`, zoom or fit-to-width shrinking; `data-np-reset` replays from a known initial state. If the browser is narrower than the device, scroll the preview stage horizontally, do not silently reduce its pixels. Web scenarios can provide their own sizes.
- Component primitives: `np-eyebrow`, `np-title`, `np-subtitle`, `np-links`, `np-steps`, `np-detail-grid`, `np-detail`, `np-status`, and `np-inspector` (collapsible). These are restrained review-page building blocks, not business components.

## Viewport geometry and resize verification

**The selected viewport size is the product's usable layout input, not merely a decorative outer box.** #2758/#2789 exposed two shared-frame regressions: a centered, overflowing Web preview lost access to its left edge, and a non-bubbling resize event left the embedded product in Web mode after selecting an App width. Address these at the shared frame owner; do not patch every business prototype with divergent offsets or duplicate controls.

### Geometry and overflow

- **One width contract:** a selection such as `Web 1180` must yield an actual **1180 CSS px product content area**; check the computed layout width and the box model. If the `np-device` has an in-flow border/padding, either account for it explicitly or use an exterior `outline`/shadow. The label is not measurement evidence.
- **No hidden edges:** if reviewer-page padding, stage padding or a smaller browser makes the device wider than the stage, keep native horizontal scrolling and ensure the **leftmost and rightmost product pixels remain reachable**. Centering that creates negative/hidden start-side overflow is invalid. The reviewer page's max width does not guarantee room for the preview once its own paddings are subtracted.
- **Never silently fit:** do not shrink, `zoom`, CSS-transform, clip or rewrap the actual product to make the review stage appear tidy. A wide Web target may scroll within the review stage. Preserve the product's own intended vertical scrolling; avoid unintended double-scroll or height clipping in App.
- **One CSS owner:** fix `prototype-frame-2758/frame.css` for stage/device geometry. A business mock owns its content and responsive behavior, not the shared viewport box.

### Device-size event and responsive handoff

- The shared `prototype-frame-2758/frame.js` owns the chosen width and emits `np:resize` from `[data-np-device]` with `detail.width`. **Current contract: the event bubbles** so listeners on `[data-np-root]` can react. New consumers may attach directly to the device; do not assume a non-bubbling event reaches an ancestor.
- When a button selects Web/App width, update the **product's mode, shell/navigation, content layout and relevant size-dependent measurements**, not just `--np-device-width`. Where useful, use container queries or a `ResizeObserver` rooted in the device. `window.innerWidth` describes the reviewer's browser and is **not** the selected simulated device width.
- Register consumers before the first selected-size notification; initialize the product from the current device size even when no resize event has fired. Switching to App then back to Web must restore a genuine Web composition, not retain App navigation or stale/hidden content.
- The frame must not implement business mock state, React layout semantics or Terminal column fitting. Keep preview width handoff separate from Session/Agent/Workspace actions.

### Mandatory regression matrix when changing a viewport, frame, or responsive mock

1. In a desktop browser with enough space, select each supported Web size and inspect the actual product width/height and left/right edges.
2. In a **review browser narrower than the selected Web device** (e.g. 960px browser against Web 1180), scroll the stage fully left and fully right. Confirm neither edge is unreachable, and no product pixels were reduced to fit.
3. On the **same page without refresh**, switch `Web 1180 → App 390 → Web 1180` (use the prototype's own applicable presets). Assert the inside actually changes to App then back to Web, not just the outer frame.
4. At an App target width, inspect App-specific navigation/depth, safe-area/height, keyboard/focus and content scrolling. Do not infer App validity solely from the width label.
5. Test a real primary interaction **after switching modes**, plus Reset, to catch stale listeners or state. Check console/network errors.
6. Record in README/Issue: selected widths, reviewer-browser width, **measured product dimensions**, scroll-edge reachability, product layout change, real-browser method and residual differences. The branch's dependency-free `prototype-frame-2758/frame-geometry.test.mjs` can guard source/event contracts but **does not replace actual Chromium/Playwright measurements**. Trusted Pages SHA verification proves publication, not layout or interactions.

## Exact GitHub provenance / Pages navigation

Structured review pages opt into `<body data-nession-prototype-frame="v1">`. The header **must** contain exactly one anchor of each form:

```html
<a data-nession-gallery-link href="../../#/prototypes">Back to Nession prototype gallery</a>
<a data-nession-source-link href="https://github.com/BestNathan/nession/tree/prototype">View source</a>
```

The trusted main-owned `pages/scripts/publish-prototypes.mjs` validates both slots, replaces the Source `href` with the **pinned published SHA + exact HTML path**, injects its existing CSP, and **does not** inject the legacy fixed bottom nav. This remains compatible with old unstructured prototypes, whose publisher-managed nav continues unchanged. Never rely on an unpinned branch-relative Source link as public provenance; README records the exact commit. **The trusted publisher is the sole owner of the Source URL after publication**: prototype scripts must not `fetch` a manifest to rewrite, relink, or downgrade that anchor to a branch-relative `tree/` URL. Keep the exact pinned HTML-source `blob/<sha>/<path>` supplied by the publisher.

## Fidelity classification (do not confuse 1:1 with pixel-perfect)

**1:1 preview** = target CSS width/height at a one-to-one browser CSS pixel ratio with no scale transform. It **does not** mean every visual and every interaction equals production.

- **Visual baseline:** identify actual Nession Web/App fixture components, generated token revision, product layout and typography. A plain HTML mock can approximate them but should not be labeled “production matched” without side-by-side screenshots/geometry inspection. Keep a short baseline-vs-mock gap note in `np-details` and README.
- **Behavior baseline:** test actual product-owned control semantics (Terminal sizing, Capsule/Peek, Files/Workspace ownership, nav/gesture). Mock transport is not live terminal / PTY / TUI proof.
- **Evidence:** separate source/static checks, published Pages manifest SHA, real browser interaction (desktop and mobile widths), and production Acceptance. An older receipt cannot prove a new revision.
- **Mobile layout:** header then preview then documentation; hero does not overlay the app; documentation does not resize its viewport. Viewer may scroll down to the preview. The stage may horizontally scroll while preserving the target size.

## Review checklist

1. Is the requirement title, one-line goal, GitHub Issue / related PR / pinned source visible at top?
2. Is a complete, usable 1:1 interactive product screen visually dominant in the center, with **no** prototype-only UI inside?
3. Are device/reset/fixture selectors external and useful? Are all apparently actionable product controls functional or explicitly disabled?
4. Is the lower area sufficient to understand functionality, critical states, deliberate design changes, fidelity gaps, and exact evidence?
5. Does the public publisher avoid covering the preview and still provide gallery navigation and exact pinned source?
6. Were the real product fixture and this new preview compared at target sizes? Is the browser result recorded without overstating it?

**Migration:** adopt on newly authored and materially revised mocks; keep old ones compatible with the publisher-managed footer until migrated. No bulk rewrite of unrelated prototypes.
