# App Workspace · Unified layout & interaction (#3971)

**Owning Requirement:** [#3971](https://github.com/BestNathan/nession/issues/3971)  
**Direct HTML (after verified Pages publication):** `https://bestnathan.github.io/nession/prototypes/app-workspace-3971/index.html`  
**Branch:** `prototype/app-workspace-3971/` on the single shared orphan `prototype` branch  
**Design decision:** App-owned one stack header, semantic content regions, icon-first actions, and one gesture arbitration path for nested Workspace navigation.

## Motion revision — 2026-11-20 (#4185)

The inner Pop/Forward preview now follows the finger directly to **125px**, then continues with continuous resistance to an absolute **180px** limit (`preferred + room·(1−e^(−excess/room))`), instead of stopping flat at 125px. A contact that arrives while a return/commit settle is still on screen **catches the settle up** and becomes the next candidate instead of being ignored. The mock now uses the same resistance curve as production `resistedTravel`.

Scope and status: this revision changes only the mock's **motion hypothesis**; it does not change the stack, Header, content or token decisions above. It is **not** production or product approval — the production frame path and rapid-contact behavior are asserted by the #4185 browser Cases, and the prototype's old hard-cap/settle behavior is superseded here rather than silently retained. Browser/Pages evidence for this revision is recorded in the #4185 Issue and PR.

## Unified App Workspace review — 2026-11-19

This revision **converges the existing #3971 prototype** rather than spawning another product shell. Four reviewer-only scenario buttons now jump to representative states *inside the same App Host*. They are not App navigation tabs, not extension discovery and not a substitute for the contextual Capability Capsule. A dirty Files editor invokes the **same leave guard** when a reviewer chooses another preset.

| Reviewer preset | Visible route | Semantic content | Critical interaction |
|---|---|---|---|
| Claude · Reader | `Claude/root` | One continuous conversation + contextual resources | Browse → Transcripts → Record → Raw, Back / Forward / Stack |
| Git · Collection | `Git/root` | Staged/unstaged groups, zero gap between peer rows | Push to Diff, content-owned horizontal scrolling |
| Sandbox · Config | `Sandbox/root → policy` | Section / field / facts relationships | Host ancestry Back; controls retain interaction |
| Files · Editor | `Files/root → file → edit` | Capability-local full-width editing surface | Dirty draft → leave guard → cancel/discard |

**Product ownership and IA:** `AppLayout → AppLayers (Sessions ← Terminal → Workspace) → WorkspacePanel / single AppPageHeader → WorkspaceShell / Capability Capsule → capability content`. App Host alone owns Header, Back, Stack depth, safe-area and bottom Capsule; named Recipes own stable Section/Row/Form relationships; capability-local Reader/Collection/Configuration/Editor owns the actual business content. The editor, diff and terminal retain renderer-specific layout. No second toolbar, duplicate Back, universal card grid or permanent four-capability navigation may be inferred from the mock.

**Spatial relationship alignment:** [#4045](https://github.com/BestNathan/nession/issues/4045) defines one inset/gap/margin owner per relationship; [#4050](https://github.com/BestNathan/nession/issues/4050) added the `--nession-rhythm-*` roles to **staging** (generated Web CSS blob `85ea3987ef08c8c713db306046a42e4f3387c757`). The prototype separately snapshots `section-stack:20px`, `section-content:8px`, `text-stack:4px`, `inline:8px` and related roles. These augment the older **main** visual-token snapshot below, not replace or claim production-shipped styles. Header title/secondary, resource label/metadata, Section grouping and inline/fact relationships consume the named roles. The 36px icon slot plus a 12px row gap yields a visually larger glyph-to-text distance: inspect the *painted* icon edge, not just its CSS box. Do not use negative margins as compensation.

**Scope of proof:** tested synthetic state transitions and source contracts are mock-only. Real Chromium inspection at 375/390/430, independent public Pages manifest/SHA readback, production PR Gates and actual App Case acceptance are **separate, still required**. A prototype revision must not mark #3971 product SCs complete.

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

1. **Reviewer preset:** Choose Claude, Git, Sandbox or Files above the preview to compare shared App chrome. A dirty Files editor must confirm before a different reviewer preset takes over.
2. **Claude Reader:** Default Claude current conversation is the dominant reading surface. Header Browse (grid icon) → Transcripts → Session transcript → Tool result → Raw JSON. Header primary/subtitle reflect resource and ancestry. Tap subtitle to jump to any visible ancestor; use Header Back or horizontal right drag on unobstructed content to Pop. After Pop, left drag Forwards to the previously visited resource; from a never-opened root there is no invented forward route.
3. **Git Collection:** Capability capsule Git → Working tree, Staged/Unstaged Sections → file diff. Observe grouped rows, not card-per-row, a single Diff Reader, Back and More.
4. **Sandbox Configuration:** Capsule Sandbox → root Overview → Filesystem / Mounts or Policies. Observe clearly bounded Rootfs, Mounts, Workspace / Policy groups and readonly-vs-editable distinction.
5. **Files dirty guard:** Capsule Files → AppPageHeader.tsx → Edit file. Modify textarea, then Header Back or switch capability: unsaved draft confirmation shows. Keep editing leaves input in place; Discard confirms navigation. For swipe, the editor's own gesture is protected; swipe from unobstructed content instead. Save is mock-only and disables leave guard.
6. **Spatial continuity:** At any Workspace capability root, Header Back or right horizontal drag returns to Terminal; the Terminal shell mock has an Open Workspace action and a Sessions navigation context. The simulated terminal layer DOM stays mounted but there is no real xterm/tmux.
7. **Negative and recovery:** Reviewer controls outside the App viewport set Empty, Unavailable, and Switch Session. Empty/error surfaces display honest local affordances. Switch Session invalidates old resource stack and restores Claude root.
8. **App sizes:** 375, 390, 430 CSS pixel widths via the *shared* #2758 review frame. The App content is actually resized, never zoomed. Touch and mouse can drive the prototype; keyboard Alt+Left / Alt+Right also navigates the stack.

## Gesture and accessibility decision

- One active contact: gesture candidate → horizontal claimed or yielded to vertical/content → release commit/cancel. At pushed depth, non-interactive content can claim the inner stack swipe. At Workspace root, the outer spatial return remains limited to a 28px shell-owned left band **after** the 18px native platform guard (#2724). Controls, editable fields, code/diff, row actions and Capsule always retain touch ownership.
- **Rightward** = Pop existing stack depth; from root leave to Terminal. **Leftward** = Forward **only** when a recorded forward item exists. Missing route resists and cancels.
- The internal work area translates under the finger; the underlying surface indicates the destination; release threshold ~75 CSS px is an **illustrative mock value**, *not* the established production #2724 threshold. The preview follows directly to 125px and then resists continuously to a hard 180px bound (#4185); a rejected or committed return is interruptible by the next contact, which catches it up rather than waiting.
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
| Local interaction smoke | 12/12 #3971/#4185 mock assertions pass in V8 DOM-stub (including inner resistance and settle catch-up); the older "Review presets" header-copy assertion also fails at the prior branch tip and is unrelated (not Chromium) |
| Revised motion browser check (#4185) | Chromium 390×844: inner preview 125px → 168.3px (below the 180px bound); a new contact applied the pending Pop (index 1 → 0) and owned the next edge gesture to Terminal. **Mock-only**, not production UI |
| Published preview | **Unverified until Pages manifest SHA + HTTPS HTML readback** |
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
