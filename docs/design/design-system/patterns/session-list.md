# SessionList

Primary navigation: a **flat** list of Sessions. Not an Agent directory.

## Purpose

Let the user find and switch Sessions the way an IM client finds conversations — without importing an IM data model and without requiring Agent → Sessions drill-down.

Must not:

- Group rows by Agent by default.
- Treat Agent as a navigation parent.
- Hide Sessions whose Agent is currently unreachable (those rows stay, with reachability from [SessionItem](session-item.md)).

Related shipping/overlap: dashboard `SessionList.tsx` is a predecessor (it still mixes `session.status` with attachment). Refresh/global session state: [#343](https://github.com/BestNathan/nession/issues/343) — coordinate; this spec does not redefine that issue.

## Anatomy

```text
┌─ SessionList ─────────────────────────────────┐
│ [ search / filter ]                           │  optional chrome
│                                               │
│  SessionItem                                  │
│  SessionItem  ← selected                      │
│  SessionItem                                  │
│  …                                            │
│                                               │
│  [ empty | loading | error ]                  │
└───────────────────────────────────────────────┘
```

Parts:

| Part | Role |
|------|------|
| List viewport | Scrolls rows. No Agent section headers. |
| SessionItem | One Session. Spec: [session-item.md](session-item.md). |
| Search/filter | Optional. Filters the flat list; must not switch the list into Agent grouping. |
| Empty | No Sessions (or no matches). Copy talks about Sessions, not “no agents”. |
| Loading | Skeleton rows or equivalent; does not flash an Agent grid. |
| Error | List-level failure to fetch. Distinct from per-row Agent offline. |

Create-session / kill actions may live as list chrome or on the item. They are not Agent-card actions.

## States

SessionList itself has **container** states. Per-row domain state belongs on SessionItem / ConnectionStatus.

| Container state | Meaning | Must not imply |
|-----------------|---------|----------------|
| `populated` | One or more rows | — |
| `empty` | Zero Sessions (or zero matches) | Agents are offline |
| `loading` | First load or explicit refresh in flight | Sessions are `exited` |
| `error` | Client could not load the list | Every Agent is `offline` |

Partial failure (some Agents missed refresh): keep those Sessions visible; mark the row (see SessionItem reachability). Do not drop the rows and do not paint the whole list as error.

Domain dimensions **not** collapsed at list level: Agent connection, Session lifecycle, attachment. The list does not show a single “system status”.

## Tokens

| Surface | Token layer |
|---------|-------------|
| List background | Semantic `surface.*` / Domain `workspace.surface` as appropriate for the nav column |
| Row hover/selected | Semantic `accent` / `surface` — not Primitive palettes |
| Empty/error copy | Semantic `text.secondary` / `danger` |
| Density | Experience `row.*` (Web compact, App larger touch rows) |

No Primitive color classes on the list or its empty states.

## Web vs App

| | Web | App |
|--|-----|-----|
| Placement | Persistent left column ([interaction/web.md](../../interaction/web.md)) | Spatial **Sessions** layer: drawer/stack left of Terminal ([interaction/app.md](../../interaction/app.md), [#473](https://github.com/BestNathan/nession/issues/473)) |
| How it opens | Always visible at desktop shell width | Gesture **and** a visible control. Gesture-only is not acceptable. |
| Density | Experience Web `row.md` (~36px) | Experience App `row.md` / `touchTarget.min` |
| Grouping | Flat | Flat. Do not introduce Agent sections on mobile “for space.” |

Same SessionItem content on both platforms.

## Visual Contract

Derived from [visual-language.md](../../visual-language.md) and the Web Active Terminal canonical screen ([#563](https://github.com/BestNathan/nession/pull/563)).

### Dominance

- SessionList is **navigation chrome** — it must recede so the Terminal (or Workspace when active) dominates the frame (P1, P2).
- The list never draws more visual weight than the active work surface in the shell split.

### Information hierarchy

- **Primary within the list:** the selected [SessionItem](session-item.md) name.
- **Container chrome** (search, empty, error): `secondary` at most — never product-title scale.
- No list-level "system status" that competes with row-level domain facts.

### Alignment

- Rows share one left gutter; optional search/filter aligns to the same inset.
- Flat vertical stack — no Agent section headers breaking alignment.

### Density

- **Session navigation density** — comfortable, scannable rows ([visual-language.md](../../visual-language.md) §4).
- List viewport scrolls; chrome above the list (search) is compact and optional.

### Whitespace

- Background shift separates navigation surface from app canvas — whitespace and surface shift before borders.
- Empty and loading states use vertical whitespace; do not fill with Agent card grids.

### Contrast

- List background: navigation surface — quieter than primary work surface.
- Empty/error copy: `secondary`; danger only for list-fetch failure, not per-Agent offline.

### Surface treatment

- Navigation surface: background shift vs canvas; hairline border only if shift alone is illegible (R-S5 — no elevation on healthy chrome).
- No card wrapper around the entire list.

### State-driven emphasis

| Container state | Emphasis |
|-----------------|----------|
| `populated` | Default — quiet chrome, row selection carries accent |
| `empty` | Informative copy at `secondary` — not alarm |
| `loading` | Skeleton at `tertiary` — no flash of Agent grid |
| `error` | List-level `conditional-prominent` — distinct from row Agent offline |
| Partial Agent refresh miss | Rows stay; per-row reachability escalates on [SessionItem](session-item.md) only |

### Anti-patterns

- Agent-grouped sections or Agent card grid as primary nav.
- Dropping Sessions when Agent is unreachable (hides the connectivity problem).
- List-level error styling when only one Agent missed refresh.
- Decorative color on the list chrome.
- Search/filter that switches the list into Agent-parent grouping.

### Canonical reference

- Web: `/#/fixture` 1440×900 — left Sessions column with six rows ([#563](https://github.com/BestNathan/nession/pull/563)).
- App: `/#/fixture/app` 390×844 — Sessions spatial layer (drawer/stack) ([#568](https://github.com/BestNathan/nession/pull/568)).

## Acceptance

- [ ] Primary nav is a Session list, not an Agent card grid.
- [ ] No default grouping by Agent.
- [ ] Selecting a row activates that Session (Terminal default surface).
- [ ] Empty copy refers to Sessions.
- [ ] Sessions whose Agent missed refresh or is offline remain listed.
- [ ] App: Sessions layer is reachable without a swipe.
