# SessionList

> Upstream: [`VISION.md`](../../../../VISION.md) → [`PRINCIPLE.md`](../../../../PRINCIPLE.md) → [information architecture](../../information-architecture.md) → [interaction](../../interaction/)

SessionList is the primary **work-return navigation pattern**: a flat list of Sessions, not an Agent directory.

Its information model is stable; its placement is not required to be a permanent left column.

> Existing contract: `design/contracts/patterns/session-list.json` — measurable layout rules ([contracts.md](../contracts.md)). Contracts that assume a permanently visible Web column should be reviewed with the shell implementation.

## Purpose

Let the user find and switch Sessions quickly without requiring Agent → Sessions drill-down and without forcing the active work surface to permanently surrender space to navigation.

Must not:

- Group rows by Agent by default.
- Treat Agent as a navigation parent.
- Hide Sessions whose Agent/location is currently unreachable.
- Require a permanent sidebar solely because Session is the primary navigation object.

## Anatomy

```text
SessionList
┌────────────────────────────────────────────────┐
│ [ search / filter ]                           │  optional
│                                               │
│  SessionItem                                  │
│  SessionItem  ← selected                      │
│  SessionItem                                  │
│  …                                            │
│                                               │
│  [ empty | loading | error ]                  │
└───────────────────────────────────────────────┘
```

| Part | Role |
|------|------|
| List viewport | Scrolls Session rows. No Agent section headers. |
| SessionItem | One Session. See [session-item.md](session-item.md). |
| Search/filter | Optional. Filters the flat list; does not turn Agent into a hierarchy. |
| Empty | No Sessions / no matches. Copy talks about Sessions, not Agents. |
| Loading | Skeleton rows or equivalent. |
| Error | Failure to load the Session list, distinct from per-row reachability. |

Create/kill actions may be reachable from list or row context where useful. Destructive controls should use progressive disclosure rather than permanently dominating navigation.

## Placement

SessionList is a navigation **capability/pattern**, not a guarantee of a fixed shell column.

### Web

Acceptable placements include:

- collapsible sidebar/rail;
- overlay drawer;
- compact Session switcher that opens the list;
- on-demand panel combined with search/command navigation.

A persistent left column may still be appropriate on some desktop compositions, but it is an implementation choice. It must remain secondary to the active Session and should yield when space/focus makes that beneficial.

### App

SessionList lives in the Sessions spatial layer to the left of Terminal conceptually:

```text
Sessions ← Terminal → Workspace
```

Swipe-right may accelerate access, but a visible non-gesture control is required.

## States

SessionList itself has container states. Per-row Agent/location, Session lifecycle, and attachment state belong to SessionItem / ConnectionStatus.

| Container state | Meaning | Must not imply |
|-----------------|---------|----------------|
| `populated` | One or more Sessions | — |
| `empty` | Zero Sessions or zero matches | Agents are offline |
| `loading` | First load / refresh | Sessions are exited |
| `error` | List could not be loaded | Every Agent is offline |

Partial reachability failure must not remove the affected Session rows. Keep the work discoverable and surface the infrastructure problem locally.

## Session row content

The list is flat, but rows can carry compact context to help users distinguish work:

```text
Fix terminal reconnect
Claude Code · devbox-01 · 2m
```

Session name is primary. Workload hint, Workspace Location/Agent identity, recency, and reachability are secondary metadata.

This supports work-first navigation without importing an IM/chat domain model or an Agent-first tree.

## Tokens

| Surface | Token layer |
|---------|-------------|
| List/navigation surface | Semantic `surface.*` |
| Row hover/selected | Semantic surface/accent |
| Empty/error copy | Semantic `text.secondary` / state semantics |
| Density | Experience `row.*` |

Do not introduce feature-specific palette literals or decorative per-Agent coloring.

## Web vs App

| | Web | App |
|--|-----|-----|
| Placement | On-demand, collapsible, compact, or persistent when justified | Sessions spatial layer |
| Opening | Must remain fast/discoverable; exact shell control may vary | Gesture + visible control |
| Density | Web Experience row density | App/touch Experience density |
| Grouping | Flat by default | Flat by default |
| Infrastructure metadata | Secondary | Secondary |

## Visual contract

Derived from [visual-language.md](../../visual-language.md) and [composition.md](../../composition.md).

### Dominance

- SessionList is navigation chrome and remains visually secondary to the active work surface.
- When temporarily opened as an overlay/drawer, it may dominate local attention for selection, then recede again.
- A wide screen does not automatically justify a permanently wider Session list.

### Information hierarchy

- Primary within a row/list: Session identity.
- Search/filter and metadata: secondary.
- Reachability problems: conditional emphasis on affected rows only.

### Surface treatment

- Flat navigation surface; whitespace/background shift before borders/elevation.
- No Agent card grid.
- No nested cards per Session row.

### Progressive disclosure

- Search/filter appears when useful.
- Destructive actions appear on hover/focus/selection/overflow or equivalent touch affordance.
- Infrastructure detail stays compact until explicitly opened or degraded.

## Anti-patterns

- Agent-grouped sections or Agent-card navigation.
- Dropping Sessions when their Agent/location is unreachable.
- Permanent destructive actions in every row.
- Treating “primary navigation” as “must always consume a fixed column.”
- Expanding navigation width because additional capability metadata exists.
- A list-level global health indicator that collapses independent state dimensions.

## Acceptance for future implementation work

- [ ] Session navigation remains flat by default and never requires Agent drill-down.
- [ ] Sessions remain visible when their execution location is unreachable.
- [ ] Selecting a Session returns to that Session's current work surface.
- [ ] Web placement can collapse/go on demand without changing SessionList semantics.
- [ ] App Sessions layer is reachable without a swipe.
- [ ] Navigation chrome yields before the active work surface yields.
