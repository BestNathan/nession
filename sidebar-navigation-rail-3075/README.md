# Persistent Web Sidebar Navigation Rail · Issue #3075

**Requirement:** https://github.com/BestNathan/nession/issues/3075
**Parent design:** #2851 (Session-first Web Sidebar / PR #2866); #1196 is historical static rail.
**Related:** #3025 standalone ProjectDetail and Project management.

## Decision / comparison
This is an **approved candidate change** to the collapsed state only. In #2851 the Web sidebar collapses to **0px** and puts an absolutely positioned reopen icon over Main. This prototype replaces that with an in-flow **56 CSS px rail**, whose expand, New Session, Search Sessions, and available Projects controls perform different actions. Expanded Web remains 246px and Session-first, not the old Agent-first sidebar. The Project rail icon is conditional on #3025 navigation actually existing; don't ship a dead shortcut. Server status remains a passive independent signal. Settings is intentionally excluded (no verified destination yet).

The **production Web geometry owner is `web/src/app/experiences/web/WebLayout.tsx`**. It must own a single expanded/rail state and pass it down to the sidebar; do not duplicate the collapse boolean. Main retains `min-w-0 flex-1`, while Terminal/Workspace/independent ProjectDetail occupy only Main and never sit behind navigation. `Sidebar` itself must remain mounted with saved Session list scroll/search/filter state, marked `inert` and accessibility-hidden while the rail is interactive. Remove the desktop floating reopen button, but leave the narrow Web drawer opener alone.

## Interaction contract / mock walkthrough
1. Open [index.html](index.html), choose Web 1280 and collapse the expanded Sidebar. The left 56px rail still consumes real flex-column width; the Terminal work area starts to its right, with no reopen icon floating inside it.
2. Click **Expand** to recover the original 246px Session-first list; filter search, select work, collapse, return. Search, selected Session and the list's scroll offset are kept in the same mounted Sidebar in the mock (DOM `#full-sidebar` remains present and is `inert` while collapsed).
3. From rail click **New Session**: a local mock dialog opens; blank name and offline Agent are rejected; only explicit Confirm creates a local Session. Cancel does nothing. From rail click **Search**: the sidebar expands and the **existing** Session search gets keyboard focus; no duplicate search state.
4. From rail click **Projects**: enter independent Project list in Main and ProjectDetail. Return to previous Terminal/Workspace without modifying selected Session. Toggle `Projects 能力可用` below preview to verify that the rail and expanded entry disappear rather than turn into dead controls.
5. Toggle zero Sessions and open Projects anyway. Toggle disconnected Server and see the passive status mark independently of Agent counts.
6. Switch Web 1440, 1180 and 1024; observe the live geometry ruler under preview. Switch to **Narrow Web 390 / 375**, whose navigation opens as an overlay Drawer **without** a reserved rail; close via scrim, close button, or Escape. Switch to **App 390**: the separate App spatial Sessions / Terminal / Workspace is not a small Web rail. Switch back to Web 1280 and interact again. Use Reset to restore the initial state.

## Product ancestry and fidelity
| Surface | Current/baseline owner → visible children | Candidate delta |
| --- | --- | --- |
| Wide Web | `WebLayout → Sidebar(TopActions + Search + flat Session list + secondary Agent/Server) + ShellMain → Terminal or WorkspacePanel` | `WebLayout → NavigationColumn(246px Sidebar or **56px Rail**) + Main`; Rail is interactive with purposeful shortcuts. The current 0px/canvas-floating reopen is superseded. |
| Projects | #3025 Web Sidebar → independent ProjectDetail main-region destination | Rail exposes Projects only when navigable; mocked Project views preserve selected Session and can appear at zero Sessions. |
| Narrow Web | `WebLayout → SessionDrawer(Sidebar) overlay + ShellMain` | Preserved; no rail. |
| App | `AppLayers → Sessions ← Terminal → Workspace` | Preserved; no Web Rail. |

**Source style baseline:** `design/generated/web.css`, Nession semantic `--nession-*` palette/typography, shell expanded width 246px, icon button 36px, Session title 14px, metadata 11.5px. Prototype captures a *local snapshot* of these canonical values; candidate **56px** is new and must be introduced through owned design tokens before production use. The review frame is the shared `../prototype-frame-2758/frame.css` / `frame.js`, never product chrome. The only child of its product viewport is the mock shell; no duplicate product-global header.

## Representative states and edge handling
- Initial: Web 1280 expanded, Session selected and Terminal visible.
- Collapsed: full Sidebar stays in DOM but `inert`; rail has accessible, focusable controls plus passive Server status; status, search and scroll persist on expand.
- Missing Project capability: its two navigation entries are hidden.
- Empty Session population: Project view still reachable; Terminal main surface shows honest empty state.
- New Session: explicit submit; blank name/offline Agent errors; Cancel is non-mutating.
- Detached/offline: independent server mock signal; Terminal is **not** a network-connected runtime.
- Narrow Web: drawer overlay with Escape/scrim/close and a narrow opener; no reserved column.
- App: separate spatial views; no Rail. Resizes/return are driven by selected **inner product viewport width**, not review browser width.
- `prefers-reduced-motion`: CSS disables rail width transitions.

## Verification status
- **Source/artifact:** index.html + README in new `sidebar-navigation-rail-3075/`, linked from gallery. Relative shared frame assets from `prototype-frame-2758/`.
- **Interactive/browser:** Mock code performs local deterministic action→result changes. Any real Chromium measurements, browser errors, or click-through must be recorded from an actual browser run; source presence alone is not proof.
- **Publication:** source pin must be exact remote prototype commit. Public preview is `https://bestnathan.github.io/nession/prototypes/sidebar-navigation-rail-3075/index.html`; **do not call it verified until Pages manifest SHA and public HTML match**. The trusted main-owned Pages publisher rewrites the structured frame's single Source anchor to the published immutable SHA.
- **Limitations:** No live React/Playwright production fixture parity, no xterm.js/PT﻿Y/rendered terminal sizing authority, no real tmux/session attachment, Server/Agent transport, Project CRUD or main/regression Acceptance. A CSS pixel 1:1 preview is not proof of production visual pixel parity.
- **Implementation proof needed:** Source-aligned Chromium PR cases measure `nav.right <= main.left`, `main.right <= viewport.right`, widths 246/56, focus/ARIA/keyboard, preserved mount/search/scroll, terminal resize pipeline, exact narrow/App breakpoint behavior. See #3075 SC-01..SC-05.
