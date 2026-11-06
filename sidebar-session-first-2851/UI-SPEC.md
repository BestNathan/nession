# Session-first Web Sidebar — High-fidelity UI specification
> Owner: [Requirement #2851](https://github.com/BestNathan/nession/issues/2851)
> Source of existing tokens: `BestNathan/nession` main `0f3b2a012a9203a68ca5f38d56dd1393f6cf74b0`, `design/tokens/experience/web.json`, `design/generated/web.css`, `design/contracts/`, `docs/design/visual-language.md`, `web/src/app/Sidebar.tsx`, `web/src/app/experiences/web/WebLayout.tsx`.
> Prototype revision: see shared `prototype` branch. This is a **candidate design** whose measured browser fidelity is pending.

## Spec ownership / priority
1. **Existing Nession design grammar is authoritative.** In production, consume the generated `--nession-*` variables; never copy these reference values as new magic numbers in the Web app.
2. **Candidate IA** (Session-first top, Agent on demand, rail removed) belongs to Issue #2851 and its future `docs/design/interaction/web.md` / pattern update. This mock has not changed the production contract.
3. **Prototype CSS snapshot** exists only to render without a build or live dependencies, pinned to the main SHA above. It is NOT a second token owner, nor proof of pixel-exact production styling.
4. When a value is deliberately novel (e.g. new top-actions arrangement), describe the decision and derivation rather than falsely claiming an existing `shell` token owns it.

## Baseline → candidate metrics: desktop Web

| UI property | Main canonical token / source | Computed baseline | Prototype candidate rule | Provenance |
| --- | --- | --- | --- | --- |
| Expanded Sidebar width | `--nession-shell-sidebar-width` | **246px** | **246px** (not the earlier 272px) | Reuse |
| Sidebar background | `--nession-sidebar` | `oklch(0.9782 0.0034 247.858)` | same, on white `--nession-background` work canvas | Reuse |
| Main work width | `WebLayout` flex | available width - nav | `flex:1;min-width:0` | Existing layout relationship |
| Toggle / icon button box | `--nession-shell-icon-button-size` | **36×36px** | **36×36px**, centrally aligned | Reuse |
| Icon size | `--nession-icon-md` | **16px** | 16px for navigation controls | Reuse |
| New Session action | `--nession-control-lg`, `typography.body` | **36px** control, **13px** label | 36px height, 13px label, control radius | Reuse |
| Top actions group | control 36px + `space-2` insets | no existing group token | **52px** minimum group height (36 + 8 + 8), not a separate permanent top header | **Candidate arrangement** |
| Search field | `--nession-control-lg` / `radius-control` | 36px control, radius **10px** | **36px** min-height, radius 10px | Reuse geometry / candidate placement |
| Session title | `--nession-typography-primary-*` | **14px / weight 550 / line-height 1.3** | same | Reuse |
| Session metadata | `--nession-typography-metadata-*` | **11.5px / weight 475 / line-height 1.3** | same | Reuse |
| Section title | `--nession-typography-secondary-*` | **12.5px / weight 500 / line-height 1.3** | same | Reuse |
| Sidebar footer state | `--nession-typography-caption-*` | **11px / weight 500 / line-height 1.3** | same | Reuse |
| Session item horizontal padding | `--nession-shell-space-2` | **8px each side** | same | Reuse |
| Session item vertical padding | `--nession-shell-session-row-pad-y` | **7px top/bottom** | same; total row height content-derived, never a fake fixed 58px | Reuse |
| Session row radius | `--nession-shell-session-row-radius` | **7px** | same | Reuse |
| Selected and hovered row | `--nession-sidebar-accent` | `oklch(0.9519 0.0013 106.424)` | same semantic fill | Reuse |
| Status dot | `--nession-shell-status-dot-size` | **5×5px** | same; standalone Server status, no aggregate health | Reuse |
| Shell transition | `--nession-motion-shell-*` | **180ms**, `cubic-bezier(0.2,0,0,1)` | same; disabled/reduced when `prefers-reduced-motion` | Reuse |
| Focus ring | `--nession-focus-ring-width/offset` / `--nession-ring` | **2px** / **2px** | same; visible by keyboard focus | Reuse |

**Important:** the 246px width, typography and row geometry come from the **current main** Design System. They are not newly invented just because the candidate resembles ChatGPT/Claude. If 246px proves too narrow for the new IA, explicitly propose a new width Token change with screenshots and measured comparison; do not silently use 272px.

## States / variants to specify and validate

| Component | Rest | Hover / focus | Selected / active | Disabled / error / empty |
| --- | --- | --- | --- | --- |
| Sidebar toggle | single 36px control | focus ring / subtle fill | expanded or fully tucked away | always discoverable; no duplicate Rail controls |
| Session row | name + secondary metadata | subtle surface fill; overflow action appears also via keyboard focus | a single selected fill | offline Agent: row remains visible with local notice |
| Search | quiet input, empty text | focus ring, text entry | filter applied without redefining global total | no matches: query-specific message and clear affordance |
| New Session | explicit button, 36px desktop | hover / focus | opens scoped form, no creation yet | online Agent needed for submit; invalid name and offline Agent produce text errors |
| Agent entry | bottom secondary row | hover/focus | explicitly reveal Agent detail | offline node does not turn Server status into failure |
| Footer | one quiet 5px Server dot | no unrelated badge activity | connected/reconnecting/error are distinct | no fleet/session aggregate indicator |
| Collapse | expanded Sidebar owns 246px | toggle is keyboard focusable | collapsed Sidebar reserves **0px**, minimal reopening affordance remains in work shell | current Terminal/Workspace persists, no detach/reconnect |
| Narrow Web drawer | initially off-canvas | explicit open button and scrim close | overlay over work without underlying width change | no Rail, no desktop toggle; ESC/selection close |

## Responsive, height and scrolling contract

- **Canonical validation viewport matrix:** Web **1280×800**, **1440×900**, **1920×1080** from `design/contracts/viewports.json`; App 375×812, 390×844, 430×932, 844×390 for regressions to the separate App experience.
- **Additional exploratory Web widths** 1180 and 1024 are design scenarios, not replacements for canonical matrix. Narrow **Web** drawer at 390×844 and 375×812 is intentionally *not* `AppLayout`.
- **Drawer width (existing Web):** `min(20rem, 90vw)` (up to 320px) from `web/src/app/SessionDrawer.tsx`. The earlier mock used 272px here without justification.
- Sidebar: full available Web shell height, upper actions/search and footer intrinsically sized, **only Session list scroll area** owns vertical scrolling (and an explicitly opened Agent view can have its own scroll viewport). No independent full-height scroll inside each row.
- Main work: `flex:1; min-width:0`; width gained after collapse belongs to Terminal/Workspace. No **extra** permanent header or nested product shell.
- Desktop expanded Sidebar 246px; collapsed 0px in the **candidate** (contrasts with historical main's 50px static summary Rail); active work must remain mounted. Reopen control is a small affordance, not a second permanent navigation bar.
- **Time buckets:** labels once per bucket, never repeat the same recency in every Session row. Buckets with no records are hidden. Sessions are not grouped by Agent.
- For full-size mock, use real CSS pixels (no zoom or transform scale); configure both `--np-device-width` and `--np-device-height`; verify scroll reachability even if reviewer browser is narrower than the target desktop.
- App has its own 44px minimum tap-target Token and does **not** inherit this Web Sidebar. A phone-sized Web drawer preview is not an App pixel-fidelity deliverable.

## Color, typography, motion and accessibility
- Use generated Nession colors: `--nession-sidebar`, `--nession-background`, `--nession-sidebar-accent`, `--nession-foreground`, `--nession-muted-foreground`, `--nession-border`, `--nession-ring`. The prototype owns only a **pinned read-only snapshot** of these tokens.
- Text uses the product chrome typography roles. Workload hints may use the technical mono family; Agent name and recency remain product sans. Do not use mono for entire Session meta lines or new independent type ramps.
- Standard spacing comes from `--nession-shell-space-{1..5}` = 4/8/12/16/24px and radius from the generated semantic/pattern variables, not arbitrary border radii.
- Use `prefers-reduced-motion`; ensure visible focus (ring width/offset tokens), accessible names for icon-only controls, and adequate text contrast on selected fills.
- No decorative capability colors, brand-logo header, big badges, or stacked cards in the sidebar.

## Fidelity ledger / acceptance evidence
1. **Static token parity:** pin the exact `main` revision and compare all referenced source variable names/values against `design/generated/web.css`. A local mock snapshot is *not* a production token change.
2. **Real Chromium geometry:** at 1280×800 and 1440×900 measure computed Sidebar width (246px), toggle bbox (36px), Session title/metadata computed fonts/line heights, row pad/radius, 5px status dot, and expanded/collapsed main bbox delta.
3. **Responsive:** at 390×844/375×812 test drawer overlay, scroll ownership, no rail, no body overflow; switch Web → narrow Web → Web without reload, and inspect selected work persistence. Test real **AppLayout** separately in production regression.
4. **Interaction:** search/select/empty/error, context action, explicit create and confirmation, keyboard focus, ESC and scrim close.
5. **Visual:** compare screenshot crops to the current Nession production fixture for unchanged patterns. Mark **candidate** differences as purposeful; do not update golden images solely because a new mock looks different.
6. **Terminal boundary:** the HTML prototype still shows plain text rather than xterm, so terminal glyph size/fit, 96 fixed columns or tmux resize are **not** established by the mock. Production attach/resize must be tested separately.
7. **Publication evidence:** verified GitHub commit is source proof; only a Pages HTTPS readback and matching `prototypes/manifest.json` SHA establishes live preview. Mock checks do not count as product Acceptance.

### Changed since initial #2851 prototype
Initial mock used Sidebar **272px**, icon button **37px**, Session title **13px**, metadata **11px**, row radius **11px**, status mark **7px**, and a drawer width of **272px**. Those values were **not authorized design changes**; the updated source corrects those mismatches to the relevant Nession values.

**Next production step:** review this spec, approve new IA and 0px collapsed geometry, update `docs/design/interaction/web.md` and the relevant pattern/contracts/fixtures in the actual Web PR, then run `design-system-full` and browser Cases with measured evidence. Do not label this prototype production-pixel-parity before doing so.
