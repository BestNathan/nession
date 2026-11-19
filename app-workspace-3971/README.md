# App Workspace · Unified layout & interaction (#3971)

**Owning Requirement:** [#3971](https://github.com/BestNathan/nession/issues/3971)  
**Direct HTML (after verified Pages publication):** `https://bestnathan.github.io/nession/prototypes/app-workspace-3971/index.html`  
**Branch:** `prototype/app-workspace-3971/` on the single shared orphan `prototype` branch  
**Design decision:** App-owned one stack header, semantic content regions, icon-first actions, and one gesture arbitration path for nested Workspace navigation.

## Design token convergence — 2026-11-19

This revision deliberately **does not change the approved navigation/interaction flows**. It replaces prototype-local visual numbers with a traceable snapshot of actual Nession Web/App tokens.

**Upstream source of truth:** [`design/generated/web.css`](https://github.com/BestNathan/nession/blob/a5f5813d56df2cdad0181610ce6999ce085e173e/design/generated/web.css), main `a5f5813d56df2cdad0181610ce6999ce085e173e`, blob `0bd2219b2541cf85bb3284d47299701a9bce52b5`. The checked-in **`tokens.css`** mirrors only the needed canonical roles (light/dark palettes, App `[data-experience="app"]` typography, density and shape). The extra `--aw-*` variables are **aliases**, not another palette.

| Semantic role | Canonical App source | Effect on the prototype |
|---|---|---|
| Type | `--nession-typography-{title,primary,body,secondary,metadata,caption,code}-size` | **17 / 16 / 14 / 13 / 12 / 11.5 / 13px**; resource names no longer 13px beside 10px captions |
| Weight | `--nession-typography-role-*-weight` | Header / section / row / metadata hierarchy uses one Nession weight ramp |
| Colors | `--nession-background/card/surface/muted/border/foreground/action` | Product canvas = subtle Nession surface; primary cards = Nession card; secondary groups = muted; no new hex/OKLCH palette |
| Radius | `--nession-radius-{control,surface,capsule}` | Controls, content regions and bottom Capsule no longer each invent radii |
| Density | `--nession-control-md/row-lg/icon-sm/icon-md/panel-padding` | 44px icon-hit targets, 56px content rows, 18/20px icons, 16px App insets |
| Capsule label | `--nession-terminal-capsule-capability-label-font-size` | 12px text, icon above text instead of cramped 9px inline labels |
| State / dark | `.dark` canonical roles | External **Light / Dark** review toggle switches only product tokens; review-page appearance stays stable |

**Intentional proposal:** Canonical `workspace-background` currently aliases the light ground, which made the #3971 surfaces visually blend into it. This candidate renders the existing `--nession-surface` role as the App **Canvas**, and `--nession-card` as the primary **Content Surface**. This changes the *role placement*, not the underlying tokens. Production design must explicitly approve that composition if implemented.

**Isolation:** `../prototype-frame-2758/frame.css` / `review.css` own the review harness (`--np-*`). `tokens.css` and `styles.css` own only the simulated product (`--nession-*`, `--aw-*`). No shared review palette styles the product and no copied generated output is edited in `main`. Other prototypes should adopt the same canonical-source/snapshot model incrementally, **not** all import a new ad-hoc token package.

**Fidelity limitation:** a static token snapshot does not automatically track future `main` token changes and is not a pixel-verified match to real App React components. No runtime UI functionality changed; all prior #3971 mock flows should continue. The reviewer may compare the Light/Dark product tokens and 375/390/430px widths without modifying routing.

**Proof:** `node --test app-workspace-3971/prototype.test.mjs app-workspace-3971/interaction.test.mjs` for deterministic mock contracts; Chromium review of light/dark, 375/390/430px layout, sections, and touch/scroll when available. Such mock results **do not** satisfy production #3971 Acceptance Criteria.

## What is the product viewport?

**Current production ownership (source reviewed on 2026-11-19):**

`AppLayout → AppLayers (Sessions ← Terminal → Workspace) → ShellMain → WorkspacePanel (single AppPageHeader) → WorkspaceShell (capability and bottom Capsule) → capability-local view.`

The real Terminal remains mounted below spatial layers; pushed capability depth causes AppLayers to suppress shell paging. These are deliberate invariants preserved in the candidate.

**Proposed changes in the mock:** The single header now projects a primary resource title and truthful secondary ancestry/context, supplies icon-first Browse/More actions and a Stack Sheet. Canvas shows semantic grouped content surfaces instead of free-floating rows. A new Workspace-internal gesture owner performs Pop/Forward before outer App spatial leave, while the existing native/work-surface guard remains authoritative. This is *not* what current production code already does.

### Source alignment

- `VISION.md`, `PRINCIPLE.md`, `docs/design/interaction/app.md`, `docs/design/composition.md`, `docs/design/visual-language.md`.
- `design/generated/web.css` color/typography/radius semantics (main review baseline; copied selectively as **static snapshot** into `.product`, not a modified generated artifact).
- `web/src/app/patterns/AppPageHeader.tsx`, `app/WorkspacePanel.tsx`, `app/experiences/app/AppLayers.tsx`, `workSurface.ts`, `edgeBand.ts`, `app/workspace/CapabilityCapsule.tsx`.
- Staging Claude `components/claude-app/useClaudeAppNavigation.ts` for conversation-first + Browse + stack composition.
- Existing owners: #3194 layout ownership, #3137 product recipes, #2724 outer swipe, #1051 one App Back, #2780 active capability depth guard, #3829 Claude App presentation.

## Interactive walkthroughs

1. **Claude Reader:** Default Claude current conversation is the dominant reading surface. Header Browse (grid icon) → Transcripts → Session transcript → Tool result → Raw JSON. Header primary/subtitle reflect resource and ancestry. Tap subtitle to jump to any visible ancestor; use Header Back or horizontal right drag on unobstructed content to Pop. After Pop, left drag Forwards to the previously visited resource; from a never-opened root there is no invented forward route.
2. **Git Collection:** Capability capsule Git → Working tree, Staged/Unstaged Sections → file diff. Observe grouped rows, not card-per-row, a single Diff Reader, Back and More.
3. **Sandbox Configuration:** Capsule Sandbox → root Overview → Filesystem / Mounts or Policies. Observe clearly bounded Rootfs, Mounts, Workspace / Policy groups and readonly-vs-editable distinction.
4. **Files dirty guard:** Capsule Files → AppPageHeader.tsx → Edit file. Modify textarea, then Header Back or switch capability: unsaved draft confirmation shows. Keep editing leaves input in place; Discard confirms navigation. For swipe, the editor's own gesture is protected; swipe from unobstructed content instead. Save is mock-only and disables leave guard.
5. **Spatial continuity:** At any Workspace capability root, Header Back or right horizontal drag returns to Terminal; the Terminal shell mock has an Open Workspace action and a Sessions navigation context. The simulated terminal layer DOM stays mounted but there is no real xterm/tmux.
6. **Negative and recovery:** Reviewer controls outside the App viewport set Empty, Unavailable, and Switch Session. Empty/error surfaces display honest local affordances. Switch Session invalidates old resource stack and restores Claude root.
7. **App sizes:** 375, 390, 430 CSS pixel widths via the *shared* #2758 review frame. The App content is actually resized, never zoomed. Touch and mouse can drive the prototype; keyboard Alt+Left / Alt+Right also navigates the stack.

## Gesture and accessibility decision

- One active contact: gesture candidate → horizontal claimed or yielded to vertical/content → release commit/cancel. At pushed depth, non-interactive content can claim the inner stack swipe. At Workspace root, the outer spatial return remains limited to a 28px shell-owned left band **after** the 18px native platform guard (#2724). Controls, editable fields, code/diff, row actions and Capsule always retain touch ownership.
- **Rightward** = Pop existing stack depth; from root leave to Terminal. **Leftward** = Forward **only** when a recorded forward item exists. Missing route resists and cancels.
- The internal work area translates under the finger; the underlying surface indicates the destination; release threshold ~75 CSS px is an **illustrative mock value**, *not* the established production #2724 threshold.
- Button labels are accessible; header touch targets ~44px; no icon-only destructive final confirmation; long content is scrollable; reduced motion applies.
- There is one App header and one visible bottom Capability Capsule at every Workspace depth. Sheet/dialog content is a temporary overlay, not another global page header.

## Fidelity and verification

| Category | Fidelity |
|---|---|
| Business data | Synthetic names, transcript entries, Git status, policies, file code |
| Backend/provider | No network, no CLI/Agent/MCP calls, no persistent file mutation |
| Gesture behavior | Browser-only exploration; **not** actual iOS/Safari/TUI gesture proof |
| UI tokens | Canonical App color/type/density snapshot in `tokens.css` (main SHA pinned above), `--aw-*` semantic aliases; role placement is a proposal, not pixel-verified React/shadcn |
| Navigation | Local mock state, not Nession routing or stored Session history |
| Local interaction smoke | 11/11 mock state transitions passed in V8 DOM-stub (not Chromium) |\n| Published preview | **Unverified until Pages manifest SHA + HTTPS HTML readback** |
| Production Acceptance | Not attempted; Issue #3971 SCs remain Pending |

## Validation commands

```sh
node --check app-workspace-3971/app.js
node --test app-workspace-3971/prototype.test.mjs app-workspace-3971/interaction.test.mjs
```

Browser walkthrough (if supported): serve the shared `prototype` checkout as static files and open `app-workspace-3971/index.html`. Inspect 375/390/430, focus, zero console errors, single header, Stack Sheet, Browse, Pop/Forward, dirty confirmation, long Reader and bottom Capsule clearance. A static test is not a Chromium proof.

## Historical prototypes and supersession

- [Claude App #3829](../claude-app-3829/index.html): conversation-first IA and Browse remains authoritative, but its *old header/surface/inner swipe appearance* is historical and is superseded by this #3971 exploration. Update its own presentation/README and pins before relying on the old mock as a current specification.
- [Mobile swipe #2724](../mobile-swipe-2724/index.html): top-level shell gesture ownership and Terminal constraints remain valid; its “Workspace pushed depth disables shell swipe” is extended here to allow an **inner** stack swipe, without reopening top-level gestures.
- [Layout #3194](../layout-consistency-3194/index.html): ownership Gate and approved semantic layout recipes remain; this demonstrates their App visual/interaction application.

Prototype design evidence does **not** close or verify #3971 production SCs.
