# Layout / Composition

> Upstream: [`VISION.md`](../../VISION.md) → [`PRINCIPLE.md`](../../PRINCIPLE.md) → [product-model.md](product-model.md) → [information-architecture.md](information-architecture.md) → [interaction](interaction/) → [visual-language.md](visual-language.md)

This document defines page-level relationships for the Session-first shell: what owns space, how chrome yields to work, how contextual layers appear, and how Web/App differ.

Exact values belong in [design-system/tokens.md](design-system/tokens.md) and measurable rules in [design-system/contracts.md](design-system/contracts.md).

## Composition invariant

> **The current work owns the frame. Persistent chrome must justify every pixel. Contextual depth overlays, replaces, or temporarily shares attention only when the user asks for it.**

For the current implementation, Terminal is the dominant work surface of an active Session.

## 1. Session working frame

The default active Session should read approximately as:

```text
┌──────────────┬────────────────────────────────────────────────┐
│ Agents       │                                                │
│ Sessions     │            TERMINAL / CURRENT WORK             │
│ ────────────  │                                    [▤][⊞]     │
│ connected ·3 │                                                │
│              │                                                │
│              │         [ contextual interaction capsule ]     │
└──────────────┴────────────────────────────────────────────────┘
```

The drawing intentionally does not prescribe a permanent Session sidebar, permanent `Terminal | Workspace` switcher, or permanent Workspace tool bar. Those may be current implementation mechanisms, but they are not composition invariants.

**Current implementation (2026-09-28, #1204).** The shell is two columns — a sidebar and the work surface — with **no permanent top band**. Session navigation, infrastructure identity and service status live in the sidebar; Terminal ↔ Workspace switching is a pair of reciprocal circular destination actions beside the local bottom controls — "Open Workspace" right of the TerminalCapsule, "Open Terminal" left of the capability dock (superseding the floating top-right switcher of #748, which could cover live surface content). The `[context]` slot the earlier drawing showed at top-right is gone with the header: the same information is reachable in the sidebar, which is where the composition invariant puts it (chrome stays close to the edges and does not consume a band the work surface could use).

Relationships:

- active work receives the majority of horizontal and vertical space;
- chrome stays close to the edges and is content-sized;
- infrastructure metadata stays quiet unless it threatens work continuity;
- the TerminalCapsule floats over/within the work surface without creating a new global chrome band;
- capability presence appears contextually rather than reserving permanent slots;
- Workspace is explicit contextual depth and preserves the active Session.

## 2. Session navigation

Session navigation must remain fast and discoverable while yielding space to the active work.

Preferred composition families include:

- overlay drawer;
- collapsible sidebar (expanded column or reserved rail);
- compact Session switcher;
- search/command entry with a visible navigation affordance.

A wide permanent sidebar is not an invariant. On a layout where it materially helps repeated Session switching, it must still remain visually secondary and should collapse when space or focus requires it.

The collapsed form is a **reserved navigation rail**: the column keeps 56px in
flow and offers a small set of purposeful shortcuts (Expand, New Session,
Search, and Projects when navigable) — its anatomy and interaction rules are
specified in [interaction/web.md](interaction/web.md) (#3075, superseding
#2851's 0px floating control and #1196's static rail). What this layer owns is
the composition rule behind it: **collapse is one state, held by the shell
composition** (#1195). The composition decides both what the navigation column
renders and how much width it reserves; a navigation component must not
privately know it is collapsed while the frame around it keeps reserving the
expanded width — that split is what made collapse free no space for the work
surface. The rail is a sibling of Main, so the work surface can never sit behind
navigation; the narrow overlay drawer keeps its own opening control and never
reserves a rail.

Extra viewport width belongs to the work surface before it belongs to navigation — including the width a collapse releases, which the work surface reclaims through the normal resize pipeline, not by rebuilding the surface.

## 3. Top chrome

Top chrome should communicate only what the current work needs: Session identity, meaningful location/Agent context, recovery state, and explicit navigation affordances.

Rules:

- avoid multiple stacked toolbars for the same region;
- avoid persistent product branding inside the active work shell when it adds no task value — the Web shell ships with **no product wordmark**, and adding one is a product decision, not a styling choice;
- a permanent top band must earn its height; the current Web shell has none, and Session identity is carried by the selected row in the sidebar's Sessions section;
- healthy state is represented quietly rather than as a row of badges;
- Workspace access may be visible, but the exact widget is not a product invariant;
- a capability should not add permanent top chrome merely because it is installed.

## 4. Terminal surface

Terminal is flush within its work region:

- no card treatment around xterm;
- no decorative border/radius around the hero surface;
- only the Terminal's own comfort padding and interaction-clearance rules apply;
- chrome yields before terminal viewport space is sacrificed.

When contextual overlays/panels are opened, they should preserve the user's sense of the same Session rather than navigating to an unrelated dashboard.

## 5. TerminalCapsule

The TerminalCapsule is a floating interaction surface, not a bottom toolbar band.

Composition rules:

- compact at rest;
- allowed to grow only as input or explicitly opened contextual content requires;
- safe-area aware on App;
- bounded/inset appropriately on Web;
- capability presence is lightweight and state-driven;
- `+`/expansion opens secondary controls without permanently widening the resting capsule;
- deeper capability surfaces may open as popover, sheet, overlay, or contextual panel chosen by Nession.

See [design-system/patterns/terminal-capsule.md](design-system/patterns/terminal-capsule.md).

## 6. Workspace composition

Workspace is contextual depth around the logical work, not a tool lobby.

A Workspace root may contain resources, capability summaries, locations, and contextual sections. Its composition should follow what exists and matters in the current Workspace.

Do not reserve a fixed navigation slot for every registered capability.

Individual capability layouts remain local:

- Files may use tree + editor master/detail on wide Web;
- App Files may push an editor;
- Git may use changes/status/detail regions;
- Claude Code may expose state/history/configuration;
- Agent/location detail may use a contained information layout.

Workspace-level navigation should be compact or on-demand and must not create a second app shell.

## 7. Web composition

Web has more horizontal space but should not spend it automatically on chrome.

Typical wide state:

```text
[quiet top context]
┌───────────────────────────────────────────────────────────────┐
│                    active work surface                       │
│                                                               │
│                 [interaction capsule]                        │
└───────────────────────────────────────────────────────────────┘

Session navigation / Workspace / capability depth open as needed.
```

Rules:

- the shell is generally full-bleed;
- extra width grows work capacity first;
- drawers/side panels overlay or consume space only when intentionally opened;
- reading/configuration content inside Workspace may use max widths;
- Terminal should not be centered inside a decorative page column;
- narrow Web remains Web interaction, not an accidental App clone.

## 8. App composition

App follows the spatial model:

```text
Sessions  ←  Terminal / current Session  →  Workspace
```

The Terminal gets the maximum usable central region. Visible controls provide alternatives to gestures but stay visually quiet.

App-specific rules:

- respect top/bottom safe areas;
- prefer touch-target sizes over desktop compactness;
- use native push/pop or sheets for deeper capability content;
- the host owns **one** stack header per depth: Back, a two-line primary
  title/truthful secondary ancestry, at most two capability-contributed priority
  icons and More. The secondary line may open the optional Stack Sheet; a
  capability never renders a second bar (#3971);
- the host owns the Workspace canvas and its semantic content roles
  (`WorkspaceSurface` / `Section` / `Group` / `Row`). A capability chooses the
  role; Nession owns the geometry and rhythm (#3971);
- nested capability navigation must not fight top-level spatial gestures. The
  same coordinator routes a claimed contact to the capability's guarded inner
  stack: right Pop, left Forward only to a recorded destination (#3971);
- capsule placement should support thumb reach without covering critical Terminal rows;
- Workspace transition should feel spatially continuous with the Session.

## 9. Responsive sacrifice order

When space becomes constrained:

```text
optional chrome yields
    ↓
secondary metadata compresses/hides
    ↓
on-demand navigation replaces persistent navigation
    ↓
work surface yields last
```

Do not preserve a toolbar/sidebar at the cost of making the actual work unusable.

## 10. Surface and inset rules

| Content | Default treatment |
|---------|-------------------|
| Terminal/current live work | Flush / maximum region |
| Session list | Fill its opened navigation region |
| Workspace resource lists | Fill local region, modest contextual inset as needed |
| Editors / reading content | Inset; optional max width where readability benefits |
| Forms / settings / details | Contained, using the shared [ConfigurationForm](design-system/patterns/configuration-form.md) / [ResourceDetail](design-system/patterns/resource-detail.md) grammar |
| TerminalCapsule | Floating contained surface |
| Capability overlay/sheet | Contained/elevated contextual layer |

Containment is a content decision, not a default desire to put everything in cards.
A detail or configuration region does not gain a second shell, header or scroll
owner when it adopts a recipe; the host composition in §7/§8 still owns those.

The relationship of container inset, adjacent peers and mixed content is specified
once by [Spatial Relationships / Content Rhythm](design-system/spatial-relationships.md).
The Host owns page-level outer insets; a semantic recipe owns its internal
Padding/Gap; capabilities must not add compensating margins to recreate either.

## 11. Large-screen whitespace

Whitespace is not unused product surface that must be filled with features.

On large screens:

- do not widen navigation indefinitely;
- do not add feature cards merely because space exists;
- allow work surfaces and meaningful contextual views to breathe;
- keep reading-width constraints local to prose/configuration content.

## 12. Current contracts and canonical screenshots

Existing `design/contracts/*`, fixture screens, and visual-regression baselines encode the previously approved Session-first implementation. They remain useful evidence and migration protection, but some still encode assumptions from that shell. The Workspace tool bar has since converged on contextual presentation, and the SurfaceSwitcher's permanence was reviewed again and **reversed** (#748): it is now a floating icon capsule and the permanent Session header is gone (see [surface-switcher.md](design-system/patterns/surface-switcher.md)).

That reversal is an instance of the rule this section exists to enforce: the previous review's conclusion was a decision with a named condition attached — replace the control only after shipping an alternative that keeps Workspace reachable — and the condition was met, so the conclusion moved.

After this product convergence, those assumptions must be reviewed against [`PRINCIPLE.md`](../../PRINCIPLE.md).

Do not silently change executable contracts in a documentation-only edit. Instead:

1. mark the product-level relationship here;
2. identify mismatched executable contracts/screens as implementation debt;
3. update implementation + contracts + baselines together in follow-up work.

A golden screenshot protects an intentional implementation. It does not outrank the product contract.

## 13. Tokenization rule

Tokenize stable reusable values, not product relationships.

Good token candidates:

- control heights;
- touch-target minimums;
- capsule radius/insets;
- standard spacing;
- drawer/sheet dimensions after the interaction pattern stabilizes.

Do not tokenize:

- "Workspace is contextual depth";
- capability relevance rules;
- Session-first navigation semantics;
- progressive-disclosure behavior.

Those belong in product/interaction documentation.

## 14. Layout ownership and shared recipes (#3194)

A valid collection of Tailwind classes does not prove a consistent semantic
layout. Composition has three owners, and only the first two may claim a host
role:

| Layer | Owns | Examples |
|---|---|---|
| **Experience host** | page/surface geometry, navigation frame, scroll ancestry, safe areas, the one App page header/Back, the single App gesture coordinator | `WebLayout`, `AppLayout`/`AppLayers`, `ShellMain`, `WorkspacePanel`, `AppPageHeader`, `AppHeaderActions`, `AppStackSheet`, `useSwipePager`/`swipeGesture`/`appInnerStackMotion` |
| **Semantic layout recipe** | a repeated stable content relationship used by independent consumers | `WorkspaceMasterDetail`, `WorkspaceScrollRegion`; `ResourceDetail`, `ConfigurationForm`, `OperationSurface`, `WorkspaceSurface`/`Section`/`Group`/`Row` |
| **Capability-local composition** | its own content arrangement inside the host | local `flex` / `grid` / `min-w-0` / `min-h-0` / `flex-1`; a capability's internal list or editor |

Rules:

- Capability and product content must not take page geometry (`h-screen`,
  `h-dvh`/`h-svh`/`h-lvh`, `min-h-[100dvh]`, `fixed inset-0`, …), render the App
  page header/Back/actions/Stack Sheet, or publish Workspace host chrome
  (`workspace-shell` / `workspace-tool-bar` / `workspace-tool-content` /
  `workspace-surface-navigation`).
- Capability and product content must not install a second App gesture owner:
  it contributes inner-stack destinations through `WorkspaceDepthControl`
  (`setPush`/`setForward`), never imports the pager engine or publishes the
  shell's swipe/stack markers. `data-swipe-owner` remains the explicit,
  bounded way for a surface to claim its own gesture.
- A stable relationship repeated by two independent consumers is promoted to a
  recipe under `web/src/app/workspace/layout/workspaceLayout.tsx`; a consumer
  must not restate the recipe's stable class.
- Local mechanisms remain legal when they stay inside the component's content.
  `cn('flex min-w-0 flex-col', condition && 'min-h-0 flex-1')` is a valid local
  composition, not a violation.
- A Web scroll region that reaches the pane bottom uses
  `WorkspaceScrollRegion`. It must not create a second page-level scroll owner.
- Web vs App is an Experience decision, not a media-width guess: constrained
  Web stays Web, forced App stays App.

### App page scroll ownership (#4115)

The App Workspace host owns the default page scroll. A capability contributes
content; it does not choose the page's scroll container, calculate the Capsule
geometry, or add trailing padding to compensate for the floating overlay.

| Role | Owner | Contract |
|---|---|---|
| Default App page scroll | `AppWorkspaceScrollRegion` (host) | one bounded `overflow-y-auto` scrollport per depth, in natural document flow; trailing extent measured from the scrollport's own bottom to the floating bar's top |
| Bounded surface | host adapter `AppWorkspaceBoundedRegion` + a binding declaration `appScroll: 'bounded'` | the capability keeps its internal scroll owners (collection, reader, diff, editor), each rendered through `WorkspaceBoundedScrollport` (or an equivalent declared adapter); it never measures the Capsule |
| Bottom actions | host `workspace-bottom-actions` slot | capability owns the action semantics; the host positions the band below the scrollport, above the Capsule, and applies the measured safe-area/Capsule inset |
| Capsule clearance | `useWorkspaceCapsuleClearance` | publishes the whole band and the actions-slot inset, and measures **every declared bounded owner** from that element's own visible bottom to the floating bar's top; safe area is counted once |

Consequences that are part of the contract:

- At rest content may continue behind the translucent Capsule Zone. At the end
  of scrolling, the final row or control is fully visible and tappable above the
  Capsule; the scroll end does not reserve a permanent fake footer or shrink the
  whole canvas.
- A Host-owned actions row reduces the scrollport's trailing extent to what is
  actually left below it. Actions are not a capability's floating footer and do
  not move by capability-specific magic numbers.
- A capability does not get correct scrolling by opting in: a newly added view
  with ordinary block/section/row content uses the host scrollport with no
  clearance class at all. `appScroll: 'bounded'` is the explicit exception for
  surfaces that genuinely scroll internally.
- A split bounded surface may have more than one internal scroller (a list plus
  a pinned footer, an editor plus its warnings/review). Each owner is measured
  from its own visible bottom, so one shared shell number cannot under- or
  over-clear a sibling; siblings that already end above the Capsule must not
  reserve the band again. Nested routes of a bounded capability (a Git section,
  a GitHub reader, an Env split surface) follow the same rule — a bounded
  declaration is not satisfied by the root view alone. A capability must not
  substitute a Capsule-sized fixed `pb-*` band for the measured inset
  (`layout-ownership` rejects it).
- **Reusable scrollport recipe (#4222).** A bounded owner renders through
  `WorkspaceBoundedScrollport`. The recipe puts the scroll role, the stable
  `min-h-0/flex-1/overflow` constraints and the measured trailing inset on the
  **viewport**, and the caller's spacing/layout `className` on an **inner
  content wrapper**. A caller's `p-2`, `pb-6` or `py-3` therefore cannot win
  Tailwind's merge and erase the host inset. A declared third-party viewport
  (MessageScroller, CodeMirror, a virtualized list) may keep its own element,
  but must publish the same marker and spend the inset outside content spacing.
- **Persistent siblings declare a role.** Ordinary explanation, errors,
  warnings, status, Load-more and final rows live *inside* their scroll area.
  Only an intentionally persistent context is a fixed sibling, marked
  `data-workspace-fixed-role="context"` and listed in the route coverage; the
  Gate rejects an unregistered fixed footer in capability content.

### Route-complete scroll coverage (#4222)

`web/src/app/workspace/scrollCoverage.ts` is the inventory of every reachable
App route/depth/tab/section variant for every Workspace view binding, with its
surface mode and the observable scroll owners a browser Case must exercise.
It is not a second capability registry: `scrollCoverage.test.ts` proves it is
exhaustive against `WORKSPACE_VIEW_BINDINGS` and the Claude `AppRoute`,
Environment, Sandbox section/policy and Git section unions, and that each
route's mode matches its binding's `appScroll`. The design Gate then rejects a
reachable union member with no coverage, a bounded route with no owner, a
document route naming an inner owner, an empty scenario, and an owner
identifier that appears nowhere in shipped source. Adding a nested route
without a contract therefore fails deterministically rather than shipping on
the parent's `appScroll` declaration.

### Representative inventory

| Surface | Current owner | Expected role | Action |
|---|---|---|---|
| Web shell / App layers | `WebLayout`, `AppLayout`/`AppLayers` | Experience frame | keep; page geometry is allowed only in this layer |
| App page header / Back | `WorkspacePanel` → `AppPageHeader` | Experience host | keep exactly one per depth; actions/Stack Sheet are host-rendered |
| App Workspace content roles | `components/ui/workspace-content.tsx` | Semantic recipe | primary/secondary surface, Section/Group/Row; no card-per-row |
| App inner-stack gesture | `AppLayers` → `useSwipePager` → capability Pop/Forward | Experience host | one coordinator; no second touch owner |
| Files master/detail (Web) | `FilesWebLayout` | `WorkspaceMasterDetail` | migrated (#3194) |
| Environment master/detail (Web) | `EnvWebLayout` | `WorkspaceMasterDetail` | migrated |
| Agent / Session detail (App) | `workspaceViews.tsx` | host `AppWorkspaceScrollRegion` | migrated (#4115); the view contributes content only |
| Project Workspace view (App) | `ProjectWorkspaceView` | host `AppWorkspaceScrollRegion` | migrated (#4115); Web keeps `WorkspaceScrollRegion` |
| Sandbox (App) | `SandboxAppLayout` | host `AppWorkspaceScrollRegion` | migrated (#4115) |
| Files / Env / Git / Claude (App) | capability views | bounded adapter + one internal scroller | declared `appScroll: 'bounded'`; spend the host scroll inset at that scroller |
| Files bulk actions (App) | `AppFilesSelectionBottomBar` content in the host actions slot | host Bottom Actions role | host owns placement and the Capsule/safe-area inset |

### Enforcement

`design/scripts/layout-ownership.mjs` is part of `design-system-fast`. It
rejects capability/product page geometry (including `dvh`/`svh`/`lvh`/`dvw`
utilities and fixed inset variants), capability-local App headers/Back/actions
/markers, host chrome, a second App gesture owner (pager imports or published
swipe/stack markers), duplicated master/detail or scroll-owner markers, and raw
numeric spacing in the shared recipe owner. From #4115 it also rejects a
capability-owned App page scroll, a capability claiming the host App surface
marker, and a reintroduction of the retired per-scroller Capsule padding; from
#4188 it rejects a capability scroll owner that hardcodes a Capsule-sized
`pb-*` band. From #4222 it rejects a capability/shared consumer that restates
the bounded clearance class outside `WorkspaceBoundedScrollport` (or the
documented third-party adapter), an unregistered `shrink-0 border-t` footer in
capability content, and a scroll-coverage inventory that misses a reachable
route or owner. It accepts the declared bounded-surface recipe and a local
list/editor scroller. It
accepts local flex/grid composition, `data-swipe-owner` surfaces, and the
Issue's control sample. It also owns the keyboard-avoidance binding from §15:
only the App Experience scrollport may publish the keyboard scroll owner, and
only the App viewport environment may read `window.visualViewport`.
`layout-ownership.test.mjs` holds the negative and positive fixtures. Browser
evidence for the single scroll owner, alignment, overflow, the one App header
and the inner-stack gesture lives in `ui-contract-web` / `ui-contract-matrix`
and the staging Cases for `#3971`; the `#4115` Cases additionally measure the
last actionable element against the actual Capsule top.

## 15. App viewport environment and keyboard avoidance (#3523)

The App shell's frame height is CSS layout space. A soft keyboard changes the
**visible** region, not that layout box, and the two must not be spent by the
same owner. This section is the composition contract; the executable owner is
`web/src/platform/viewport/` (read/coordinate snapshots),
`web/src/app/experiences/app/AppKeyboardAvoidanceScrollport.tsx` (the one
Experience scroll ancestor) and `web/src/platform/terminal-runtime/view/TerminalGeometry.ts`
(terminal rows).

| Owner | Reads / writes | Must not do |
|---|---|---|
| **App Environment** (`platform/viewport`, mounted by `AppLayout`) | `window.visualViewport` available geometry, the shell's layout rect, editable focus, safe-area probe; publishes one shell-local snapshot (`layoutBounds`, `visibleBounds`, `safeArea`, `occludedEdges`, `keyboard`, `revision`) | Mutate terminal geometry; infer a keyboard from a viewport delta alone; write `Shell.style.height` or a global `100dvh` |
| **Experience Layout** (`Shell`, `AppLayout`, `AppLayers`, active layer) | Frame, the one App header, active-layer scroll ancestry, the ephemeral avoidance extent, focus reveal and layer-leave blur | Resize xterm/PTY for a keyboard; make `body` scroll; own all vertical gestures |
| **Surface Layout** (`TerminalWell`, `TerminalSurface`, Capsule) | Real header/composer heights and the existing composer/upper-panel clearances | Count the keyboard as composer/panel height; translate the shell or claim a global scroll range |
| **Terminal Runtime** (`TerminalViewport`, `TerminalGeometry`, IME, scroll) | Actual content box and scroll mode; cursor-anchored IME; mode-aware buffer/TUI routing; ControlLease-gated rows | Resize on visual-viewport movement, focus, or avoidance-scroll offset; apply two transforms/scroll owners to one gesture |

Three dimensions stay separate:

1. **`layoutBounds`** — stable CSS geometry consumed by flex/grid. The
   Terminal well and its observed content box live here.
2. **`visibleBounds`** — the browser-visible rectangle translated into the
   same shell-local space. Keyboard, browser toolbar, pan/zoom and orientation
   can move it.
3. **`surfaceOcclusion`** — measured floating internal overlap (composer vs
   upper panel) published by the Capsule. It is not interchangeable with
   `visibleBounds`.

A keyboard avoidance session is inferred from **editable focus plus reduced
visibility**, and always reads the real visible rectangle. Browser toolbar
changes without focus, zoom/pan and a missing `visualViewport` API do not create
an avoidance state, and never a terminal resize.

The Terminal layer's scroll ancestor is a real browser scroller with a real
`scrollTop`/`scrollHeight`. Its temporary bottom extent is placed **after** the
measured work surface, so `TerminalWell`, xterm's observed box, rows, PTY and
tmux never change while the user focus-reveals a Capsule composer or mobile-IME
caret. The Session header stays outside the scrollport: the work surface
scrolls, the one App header does not. On blur or keyboard close the extent is
removed and the browser clamps the position; the Terminal stays mounted with
its buffer and history.

While a legal avoidance range exists, a vertical touch drag that begins in the
Terminal viewport belongs to the outer scroll owner and the same delta is not
also dispatched to `CapsuleOcclusionScroll`. Ownership is decided at axis lock
and frozen for that contact; when no range exists in the drag direction the
Terminal's existing mode-aware history/TUI path keeps the gesture. Horizontal
edge navigation, selection, long-press direction pad and multitouch keep their
own owners. Leaving the layer blurs the control that owned the keyboard.

Resize policy follows from the ownership split: orientation, real container
size, header/composer height and other layout-space changes may remeasure rows;
keyboard/visual-viewport changes, focus and avoidance-scroll offset must not.
Expanded-panel policy remains [#2710/#3492](design-system/patterns/terminal-surface.md):
normal-buffer/no-mouse keeps reversible scroll clearance; alternate-screen or
mouse-reporting TUIs keep the bounded authorized row reserve. A simultaneous
keyboard must not add another reserve or a second resize.

| Context | Expected visible/scroll behavior | May change xterm/PTY rows? |
|---|---|---|
| Capsule focus opens IME | Composer above the visible bottom; shell/layout intact; real bounded outer scroll | No |
| Tap Terminal + cursor-tethered IME | Caret/control revealable; no clipped dead end | No |
| IME hide, or candidate/toolbar height changes | Extent reconciles; no remount, no resize storm | No |
| Browser toolbar / visual-viewport scroll / zoom without editable focus | Stable layout; no keyboard reserve, no scroll jump | No |
| Composer 1 → multi → 1 lines | Existing composer-only measured fit changes | Only if integer rows change |
| Open/close Peek in a normal shell | Reversible local scroll clearance; history anchor preserved | No |
| Open/close Peek in alternate-screen/mouse TUI | Bounded authorized row reserve, or compact fallback | Only current Controller, by #3492 |
| Keyboard + Peek in normal shell or TUI | No double-spend of keyboard and panel pixels; one owner | Panel policy only |
| Sessions/Workspace navigation while keyboard visible | One active scroll owner; covered focus released; Terminal mounted | No |
| Portrait/landscape + nonzero safe area | Correct mapping; focused control and controls reachable | Only true layout/orientation change |

Interaction rules (touch arbitration, header visibility, layer switching) are
in [interaction/app.md](interaction/app.md); the fixed-column terminal sizing
boundary is in [terminal/terminal-sizing.md](terminal/terminal-sizing.md).

## Anti-patterns

- permanent chrome preserved only because a prior screenshot contained it;
- every capability claiming a toolbar/tab slot;
- wide-screen layouts filling empty space with feature cards;
- stacked chrome bands around the Terminal;
- nested full-height sidebars for Workspace + Files + capability navigation;
- multiple floating controls competing with the TerminalCapsule;
- responsive behavior that protects chrome before the work surface.

## Ownership boundaries

- product direction → [`VISION.md`](../../VISION.md)
- product decisions → [`PRINCIPLE.md`](../../PRINCIPLE.md)
- product entities → [product-model.md](product-model.md)
- IA → [information-architecture.md](information-architecture.md)
- interaction → [interaction/](interaction/)
- Workspace semantics → [workspace.md](workspace.md)
- visual hierarchy → [visual-language.md](visual-language.md)
- values → [design-system/tokens.md](design-system/tokens.md)
- measurable rules → [design-system/contracts.md](design-system/contracts.md)
- layout ownership / shared recipes → §14 here + `web/src/app/workspace/layout/workspaceLayout.tsx`
