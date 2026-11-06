---
title: "Web Session-first navigation, full tuck-away and explicit experience mode"
description: "The Web sidebar leads with flat Session history and explicit creation, reveals Agent context below it, returns its full 246px to the work surface on collapse, and keeps the App's narrow spatial shell independent through an explicit experience route"
topic: web
categories: ["web", "navigation", "sidebar", "interaction", "ownership", "responsive"]
status: verified
created_at: 2026-11-06T14:33:00Z
updated_at: 2026-11-06T15:00:56Z
sources: ["https://github.com/BestNathan/nession/issues/2851", "https://github.com/BestNathan/nession/pull/2866", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/docs/design/interaction/web.md", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/docs/design/design-system/patterns/session-list.md", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/app/experiences/web/WebLayout.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/app/Sidebar.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/app/experienceMode.ts", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/app/patterns/SidebarTopActions.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/app/patterns/SidebarAgentsEntry.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/product/session/patterns/SessionItem.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/web/src/product/session/components/SessionMetadataSection.tsx", "https://github.com/BestNathan/nession/blob/cba6fd3665a6dcefc05759164654761fb5dde97c/e2e/tests/browser/sidebar-session-first.spec.ts"]
---

# Web Session-first navigation, full tuck-away and explicit experience mode

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

## Full tuck-away

Collapse returns the complete `--nession-shell-sidebar-width` (246px) to the
work surface. The old 50px static-summary rail is gone: no rail icons, no
miniature Session list and no extra navigation bar remain. One floating 36px
control at the work surface's top-left reopens the column.

The column stays **mounted while clipped to 0px**. Its inactive controls are
`inert`, but the Session list's scroll position, the selected Session and the
search state survive the round trip. The Terminal is not unmounted or
re-attached; the work surface receives the width through its normal layout and
resize path.

The collapse state has one owner, `WebLayout`. `Sidebar` only renders its view
of that state. A component may not privately hold a second collapsed boolean
while the frame around it still reserves the expanded width.

## Metrics and ownership

The redesign reuses the generated Nession vocabulary rather than inventing a
new palette or type scale:

| Property | Value |
|---|---|
| Expanded column | `--nession-shell-sidebar-width` = 246px |
| Shell icon controls and New Session | 36px (`control.lg` / `shell.iconButtonSize`) |
| Search field | 36px, control radius |
| Session title | 14px / 550 / 1.3 |
| Session metadata | 11.5px / 475 / 1.3 |
| Session row padding / radius | 7px vertical / 7px |
| Server status mark | 5px |
| Top action group | 52px = 36px control + two 8px insets (a derived arrangement, not a new permanent header token) |

`WebLayout` owns the column geometry and collapse state; `Sidebar` owns the
composition; `SessionList`/`SessionItem` own flat Session identity and
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
model and never inherits Web collapse state.

## Evidence

- Requirement: [#2851](https://github.com/BestNathan/nession/issues/2851);
  implementation PR [#2866](https://github.com/BestNathan/nession/pull/2866).
- Implementation commit: `cba6fd3665a6dcefc05759164654761fb5dde97c`.
- Source-aligned pre-merge Cases SC-01…SC-06 cover Session-first composition,
  search/actions/empty states, 0px collapse and state preservation, narrow Web
  versus App, Server/Agent separation, and the measured 246/36/14/11.5/7/5
  metrics with keyboard focus.
- `e2e/tests/browser/sidebar-session-first.spec.ts` runs at 1280×800,
  1440×900 and 390×844 against the canonical fixture.

## Limits / when to revisit

The high-fidelity prototype remains candidate source, not production
Acceptance. Canonical visual baselines are Linux Chromium renders; macOS was
used for controlled interaction inspection only. The explicit narrow-Web route
is the reachable test and product path for the drawer until the default
experience model changes. Revisit if the Web and App experiences stop being
viewport-derived, if Session grouping becomes a user-configurable hierarchy, or
if the sidebar gains another persistent navigation layer.

### Related knowledge

- [App mobile spatial navigation and Terminal touch ownership](../app/app-mobile-spatial-navigation-and-terminal-touch-ownership.md) — the independent narrow App shell and its touch-owned navigation.
- [Session metadata and display identity ownership](../engineering/session-metadata-and-display-identity-ownership.md) — the display title rendered by each Session row without renaming tmux.
