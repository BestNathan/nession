# Design: Dashboard Search, Filter & Agent Detail

**Issue:** [#21](https://github.com/BestNathan/nession/issues/21)
**Requirements:** [2026-07-03-dashboard-search-filter-detail-requirement.md](../requirement/2026-07-03-dashboard-search-filter-detail-requirement.md)
**Status:** Approved
**Created:** 2026-07-03

## Architecture Decision

**Chosen: Extend `useDashboardHandlers`** — all search/filter/sort/heartbeat state lives in the existing hook. Dashboard stays a thin render layer.

Rejected alternatives:
- Local state + independent hooks: more prop drilling, Dashboard becomes state container
- Context + useReducer: over-engineered for 5 components sharing this state

## File Changes

```
Modified:
  web/src/components/Dashboard.tsx              — integrate SearchBar + AgentDetailPanel
  web/src/components/AgentCard.tsx              — onClick opens detail panel (no longer filters)
  web/src/components/SessionList.tsx            — sortable headers + empty state
  web/src/components/useDashboardHandlers.ts   — search/filter/sort/heartbeat tracking
  web/src/types.ts                             — no changes needed (Agent.metadata covers detail fields)

New:
  web/src/components/SearchBar.tsx             — search input (debounce 200ms) + status toggle
  web/src/components/AgentDetailPanel.tsx      — Sheet slide-out with full agent metadata

Add shadcn:
  web/src/components/ui/sheet.tsx              — npx shadcn@latest add sheet --yes
```

## Component Tree

```
Dashboard
├── Header (existing)
├── SearchBar (NEW)
│   ├── Input — search with debounce 200ms
│   └── ToggleGroup/Buttons — All | Online | Offline
├── Agent Grid (existing)
│   └── AgentCard[] (MODIFIED — click → open detail panel)
├── Session Section
│   └── SessionList (MODIFIED)
│       ├── Sortable table header (Name ↑↓ | Activity ↑↓)
│       ├── Session rows (existing)
│       └── Empty state (SearchX icon + message + "Clear search" link)
└── AgentDetailPanel (NEW — Sheet overlay)
    ├── Header (agent name + status badge + close X)
    ├── Connection section (hostname, IP, port)
    ├── Versions section (nession, tmux, OS)
    ├── Uptime section (relative + absolute)
    ├── Heartbeat History (color-coded timeline, max 10 entries)
    └── Session Count
```

## Data Flow

### Computed Values (in useDashboardHandlers)

```
searchQuery ─────────────────┐
statusFilter ────────────────┤
agents ──────────────────────┼──→ filteredAgents
sessions ────────────────────┤
                              └──→ filteredSessions ──→ sortedSessions
sortField ───────────────────┘
sortDirection ───────────────┘
```

**filteredAgents:** agents filtered by `statusFilter` + `searchQuery` (hostname, agent_id)

**filteredSessions:** sessions filtered by `statusFilter` (via agent lookup) + `searchQuery` (session_name, agent_id)

**sortedSessions:** filteredSessions sorted by `sortField` (`name` → `localeCompare`, `activity` → `last_activity` date comparison) in `sortDirection` order.

### Heartbeat Tracking

Client-side `useRef<Map<string, string[]>>` — each `agents.changed` event appends `last_heartbeat` to the agent's history array (capped at 10 entries). Heartbeat color coding: < 60s = green, 60-180s = yellow, > 180s = gray/muted.

### Hook Interface Changes

```ts
// Removed from return:
//   selectedAgentId, handleAgentClick

// Added to return:
searchQuery: string
setSearchQuery: (q: string) => void
statusFilter: 'all' | 'online' | 'offline'
setStatusFilter: (f) => void
filteredAgents: Agent[]
filteredSessions: Session[]  // replaces old filteredSessions
sortField: 'name' | 'activity'
sortDirection: 'asc' | 'desc'
toggleSort: (field: 'name' | 'activity') => void
selectedAgent: Agent | null
setSelectedAgent: (a: Agent | null) => void
getHeartbeatHistory: (agentId: string) => string[]
isSearchActive: boolean
```

## Component Details

### SearchBar

```
┌──────────────────────────────────────────────────────────────┐
│  [🔍 Search agents and sessions...            ]  [All|Online|Offline] │
└──────────────────────────────────────────────────────────────┘
```

- Input uses shadcn `<Input>`, `onChange` → debounce 200ms → `setSearchQuery`
- Toggle: 3 `<Button>` elements with `variant={statusFilter === x ? 'default' : 'outline'}`
- No search button — real-time filtering

### AgentDetailPanel

Uses shadcn `<Sheet>` with `side="right"`. Sections:

| Section | Data Source | Fallback |
|---------|------------|----------|
| Status + Name | `agent.status`, `agent.hostname` | — |
| Connection | `agent.hostname`, `agent.ip_address`, `agent.port` | — |
| Versions | `agent.metadata.{nession_version,tmux_version,os_version}` | "Unknown" |
| Uptime | `getHeartbeatHistory()` — diff first/last entry | "Just connected" |
| Heartbeat | `getHeartbeatHistory()` — last 10 entries, color-coded | "No heartbeat data yet" |
| Sessions | `agent.session_count` | — |

Panel auto-updates when `agents` array changes (WebSocket events).

### SessionList

Adds a sortable header row above session entries:

```
┌─────────────────────────────────────────────────┐
│  ● Name ▲         Activity    Actions          │  ← clickable headers
│  ─────────────────────────────────────────────  │
│  ● dev-session    2m ago      [Attach] [Kill]  │
│  ● prod-api       1h ago      [Attach] [Kill]  │
└─────────────────────────────────────────────────┘
```

Sort indicator: show `▲` or `▼` on active sort column using lucide `ArrowUp`/`ArrowDown`.

### Empty States

| Condition | Display |
|-----------|---------|
| No agents connected | "No agents connected" (existing) |
| Search/filter has results | SearchBar + filtered grid + filtered list |
| Search/filter no results | SearchBar + SearchX icon + "No agents or sessions match your search" + "Clear search" link |
| New agent (no heartbeat history) | "No heartbeat data yet" in detail panel |

## Testing Strategy

| Layer | Tool | What |
|-------|------|------|
| Hook logic | `renderHook` + Vitest | search/filter/sort computed values, heartbeat accumulation, toggleSort direction flip |
| SearchBar | Testing Library | debounce behavior, toggle click calls setStatusFilter |
| SessionList | Testing Library | header click calls toggleSort, empty state rendering |
| AgentDetailPanel | Testing Library | all sections render, fallback for missing metadata, fallback for empty heartbeat |
| AgentCard | Testing Library | onClick calls setSelectedAgent (not filter) |
| Dashboard | Testing Library | integration: search → filtered agents, status toggle → filtered view |

## Constraints

- shadcn Sheet: `npx shadcn@latest add sheet --yes`
- No new npm dependencies
- Debounce: `lodash.throttle` already in deps, or inline setTimeout pattern
- ESLint `--max-warnings 0` enforced
- Tailwind v4 + shadcn dark theme — no CSS file changes needed
