---
title: "Web Session-first navigation, reserved rail and explicit experience mode"
description: "The Web sidebar leads with flat Session history and explicit creation, reveals Agent context below it, collapses to a reserved 56px in-flow navigation rail instead of tucking away to 0px, and keeps the App's narrow spatial shell independent through an explicit experience route"
topic: web
categories: ["web", "navigation", "sidebar", "interaction", "ownership", "responsive"]
status: verified
created_at: 2026-11-06T14:33:00Z
updated_at: 2026-11-09T14:27:17Z
sources: ["https://github.com/BestNathan/nession/issues/2851", "https://github.com/BestNathan/nession/pull/2866", "https://github.com/BestNathan/nession/issues/3075", "https://github.com/BestNathan/nession/pull/3123", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/docs/design/interaction/web.md", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/docs/design/composition.md", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/docs/design/design-system/patterns/session-list.md", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/app/experiences/web/WebLayout.tsx", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/app/patterns/SidebarRail.tsx", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/app/Sidebar.tsx", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/app/patterns/serverStatusLabel.ts", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/app/experienceMode.ts", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/web/src/product/session/patterns/SessionItem.tsx", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/e2e/tests/browser/sidebar-navigation-rail.spec.ts", "https://github.com/BestNathan/nession/blob/8a6e2a115a12d15b23e4c8fe0379fb481761578c/e2e/tests/browser/sidebar-session-first.spec.ts"]
---

# Web Session-first navigation, reserved rail and explicit experience mode

## Decision

The Web sidebar is a **return-to-work navigator**, not an Agent administration
column. Its expanded shape is:

1. one stable sidebar toggle and one explicit New Session action;
2. one Session-scoped search field, with status filter, sort and refresh behind
   the field's secondary Filter disclosure;
3. flat Session history, optionally grouped by Today / Previous 7 days / Older;
4. one compact Agents / locations entry that reveals Agent detail only on
   request;
5. one Server-only footer.

Agent and location context remains **secondary infrastructure**, never a parent
of the Session list. A Session on an unreachable Agent stays in the list with a
local reachability notice. The Server connection mark is its own dimension; an
offline Agent does not recolor it.

## Reserved navigation rail

Collapse reserves a **56px in-flow rail** (`--nession-shell-rail-width`) and
returns only the released `--nession-shell-sidebar-width` remainder (246px →
56px) to the work surface. The rail is a real flex sibling of `Main`: the work
surface starts at its right edge and no control floats over it. This supersedes
the #2851 0px tuck-away and its floating reopen control.

The rail carries one Expand plus distinct purposeful shortcuts, each delegating
to its existing owner:

| Control | Outcome |
|---|---|
| Expand | restores the 246px column; focus returns to the column's collapse toggle |
| New Session | opens the existing create flow; it never creates implicitly |
| Search | expands the column and focuses the one existing Session search field |
| Projects | opens only when Projects are navigable; lists them and opens the standalone ProjectDetail in Main |
| Server status | passive `role="img"` signal; never a button or an Agent aggregate |

A shortcut with no real destination is not rendered; the Projects entry is
conditional on the Project shell actually exposing projects. Each icon-only
control has an accessible name, tooltip, keyboard focus and a visible focus
state. Reduced motion removes the width transition.

The expanded column stays **mounted while the rail is shown**. Its inactive
controls are `inert` and excluded from the accessibility tree, but the Session
list's scroll position, the selected Session and the search state survive the
round trip. The Terminal is not unmounted or re-attached; the work surface
receives the width through its normal layout and resize path. A standalone
Project destination layers over a still-mounted `ShellMain`, so opening a
Project from the rail preserves the active Session and Terminal; returning
through the selected Session does not reconnect.

The collapsed/expanded state has one owner, `WebLayout`. `Sidebar` only renders
its view of that state; `SidebarRail` renders the rail and delegates every
action. A component may not privately hold a second collapsed boolean while the
frame around it still reserves the expanded width.

## Metrics and ownership

The redesign reuses the generated Nession vocabulary rather than inventing a
new palette or type scale:

| Property | Value |
|---|---|
| Expanded column | `--nession-shell-sidebar-width` = 246px |
| Collapsed rail | `--nession-shell-rail-width` = 56px |
| Shell icon controls and New Session | 36px (`control.lg` / `shell.iconButtonSize`) |
| Search field | 36px, control radius |
| Session title | 14px / 550 / 1.3 |
| Session metadata | 11.5px / 475 / 1.3 |
| Session row padding / radius | 7px vertical / 7px |
| Server status mark | 5px |
| Top action group | 52px = 36px control + two 8px insets (a derived arrangement, not a new permanent header token) |

`WebLayout` owns the column geometry and expanded/rail state; `Sidebar` owns
the composition; `SidebarRail` owns the collapsed shortcuts and their
delegation; `SessionList`/`SessionItem` own flat Session identity and
selection; the lower `SidebarAgentsEntry` reveals the existing inert
`SidebarAgents` rows. The canonical design owners are the Web interaction model
and the Session list pattern.

## One anchored row-action menu

Every Web Session row opens the same anchored `···` menu on wide and narrow
viewports:

| Action | Owner |
|---|---|
| Session details | read the target Session without selecting it |
| Edit details | `SessionDetails` / `SessionMetadataSection` alias editor |
| Attach settings | existing `AttachDialog` configure intent |
| Project… | existing Project membership/association owner |
| Kill session | existing `KillConfirmDialog`, separated from the non-destructive actions |

Wide Web reveals the trigger on hover/focus/selection; narrow Web keeps a 44px
target visible. The menu overlays the list and never selects the row by itself;
Escape, outside click and list scroll dismiss it. Details resolve their own
DomainState, so an offline Agent's Session remains readable while its metadata
editor is explicitly unavailable. Editing writes title/description/tags through
the existing revision-guarded metadata owner and never renames tmux or changes
`session_id`. Kill keeps the existing typed exact-tmux-name confirmation.

## Explicit experience mode

The default composition remains a viewport decision: wide is Web, narrow is the
App spatial shell. The Web shell can also be selected explicitly with
`experience=web` in the URL; at a narrow viewport it renders the existing
overlay SessionDrawer instead of a squeezed column. The drawer closes on
selection, its Close action, Escape or the scrim, and leaves a visible floating
control to reopen it. `experience=app` is the symmetric override for a wide
viewport. The App keeps its independent `Sessions ← Terminal → Workspace`
model and never inherits Web collapse state or a rail.

The same Experience decision also selects the operation-surface composition for
Attach and Session/Project creation — Web's content-capable dialogs versus the
App quick sheet and full-height operation depths. That contract is owned by
[Session and Project operation surface presentation by Experience](session-and-project-operation-surface-presentation-by-experience.md).

## Evidence

- Requirement: [#3075](https://github.com/BestNathan/nession/issues/3075);
  implementation PR [#3123](https://github.com/BestNathan/nession/pull/3123),
  merged at `8a6e2a115a12d15b23e4c8fe0379fb481761578c`.
- Ancestry: the Session-first information architecture is
  [#2851](https://github.com/BestNathan/nession/issues/2851) / PR
  [#2866](https://github.com/BestNathan/nession/pull/2866); #3075 supersedes only
  its collapsed-state behavior. The #2851 fully-tucked-away prototype is
  historical; [#3075's prototype](https://bestnathan.github.io/nession/prototypes/sidebar-navigation-rail-3075/index.html)
  is the review artifact for the rail.
- Source-aligned pre-merge Cases SC-01…SC-05 cover measured 56/246 geometry and
  Main adjacency at 1024/1180/1280/1440, shortcut outcomes and focus, mounted
  Sidebar/search/scroll/Terminal/Workspace continuity through rail and Project
  round trips, narrow-Web/App separation with reduced motion and degraded
  Server, and the published prototype source readback plus Chromium
  click-through.
- `e2e/tests/browser/sidebar-navigation-rail.spec.ts` runs the rail geometry and
  shortcut flows; `sidebar-session-first.spec.ts` keeps the expanded
  composition, menu and narrow/App contracts.

## Limits / when to revisit

The high-fidelity prototype remains candidate source, not production
Acceptance. Canonical visual baselines are Linux Chromium renders; macOS was
used for controlled interaction inspection only. The explicit narrow-Web route
is the reachable test and product path for the drawer until the default
experience model changes. Revisit if the Web and App experiences stop being
viewport-derived, if Session grouping becomes a user-configurable hierarchy, if
the sidebar gains another persistent navigation layer, or if a rail shortcut
outgrows the 56px one-action-per-destination contract.

### Related knowledge

- [App mobile spatial navigation and Terminal touch ownership](../app/app-mobile-spatial-navigation-and-terminal-touch-ownership.md) — the independent narrow App shell and its touch-owned navigation.
- [Session metadata and display identity ownership](../engineering/session-metadata-and-display-identity-ownership.md) — the display title rendered by each Session row without renaming tmux.
- [Nession public Pages source publication and orphan-branch signals](../workflows/nession-public-pages-source-publication-and-orphan-branch-signals.md) — how the linked rail prototype is published from the orphan branch.
