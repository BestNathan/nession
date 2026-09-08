# Sessions feature — ownership

The sessions feature owns the nession session **wire capability** (SessionsPlugin,
`sessionsApi`) and the **session list / details UI** (the sidebar list of the
app shell, plus the shared CRUD/attach dialogs). It also owns the
**domain-state model** (`mapDomainState`) that derives the per-session
`agent · session · attachment` channel view used across the session workspace,
and the **filter vocabulary** (`StatusFilter`/`SortField`/`SortDirection`,
declared in `types.ts`) shared with app-layer composers.

It does **not** own the attach/terminal runtime — that lives in `atoms/` +
`runtime/` + `core/terminal-runtime` (connectivity domain). The Dashboard
predecessor shell (with its own `components/SessionList` + `SessionsSection`
rows and preview dialogs) was deleted in Phase 5 (#655).

## Module map

| Module | Responsibility |
|---|---|
| `SessionsPlugin.ts`, `types.ts`, `index.ts` | Session RPC capability (`client.session.create/kill/list/…`) installed per WebSocketService; `sessionsApi` module singleton with generation-tagged install/teardown |
| `model/domainState.ts` | Pure model: `mapDomainState` + `AgentChannel`/`SessionChannel`/`AttachmentChannel` channel types (input: session + agent + attachment identity) |
| `components/SessionList.tsx` + `SessionItem.tsx` | Sidebar list rows (select-to-attach + hover-kill; per-row `DomainState` derivation). The legacy Dashboard `components/SessionList` copy was deleted with its shell (#655) — name collision resolved by deletion, not coexistence |
| `components/ConnectionStatus.tsx` | Compact 3-channel (`agent·session·attachment`) render of `DomainState`; consumed by the session header/details and by `features/agents` AgentDetail |
| `components/SessionDetails.tsx` | Session workspace-tool detail page (metadata + ConnectionStatus) |
| `components/CreateSessionDialog.tsx`, `KillConfirmDialog.tsx`, `AttachDialog.tsx`, `SearchBar.tsx` | Shared dialogs/list chrome; call `sessionsApi`; env-file picker UI comes from `@/features/env/components/EnvFileMultiSelect` (sessions → env direction); AttachDialog holds the mode/address picker for terminal attach |
| `hooks/useSessionData.ts` | Per-mount session list state + `fetchSessions({force})` via `sessionsApi` |
| `hooks/useDebouncedInput.ts` | Generic debounce used by `SearchBar` |

## State ownership

Rules follow #649: transient render state stays in the component; state shared
across a capability lives in feature/model; transport/connection lifecycle
belongs to core runtime; layout/selection state belongs to app/workbench.

| State | Owner today | Lifetime / scope |
|---|---|---|
| Session list + loading/error | `features/sessions/hooks/useSessionData` per mount | Composed by `app/useDashboard` (the one app-layer composer; the shell mounts one list copy). Deliberately **no** list atom |
| Push updates (`sessions.changed`) + refetch on reconnect | `app/useRealtimeUpdates` | Registers `sessionsApi.onSessionsChanged(setSessions)` keyed on `wsService` identity — one subscription bridge for agents+sessions; not moved into the feature while it fuses both domains |
| Filter/sort/search state | `app/useDashboardFilter` | Per mount; types (`StatusFilter`/`SortField`/`SortDirection`) declared in `features/sessions/types.ts` and consumed by `SearchBar` + sidebar chrome `SessionListHeader` |
| Dialog targets (create/kill/attach) | `app/useDashboardModals` | Per mount; wired by `SessionFirstShell` through `SessionFirstDialogs` |
| Wire registration | `SessionsPlugin` instance (module singleton `sessionsApi`) | One binding per WebSocketService lifetime; `WebSocketService.use()` re-installs after reconnect with generation-tagged teardown (`SessionsPlugin.ts`) |
| Attach identity (`clientSessionId`, attach in-flight/failed, dialog session) | `atoms/session.ts` (shared) | Connectivity domain — NOT sessions-list domain; stays in `atoms/` alongside `atoms/connection.ts` |
| Per-row `DomainState` | `model/domainState` `mapDomainState` | Pure function of (session, agent, attachment) inputs; no stored state |

## Cross-feature dependency

`features/agents` imports `model/domainState` (types) and
`components/ConnectionStatus` for its in-workspace agent surfaces — the
channel vocabulary is session-workspace state, so sessions owns it. This
mirrors the `features/files → features/explorer` direction (owner of the
contract stays in one feature; the peer imports its public surface).

## Consumers

The app shell (`app/` — `SessionFirstSidebar`, `SessionListHeader`,
`SessionFirstDialogs`, `useSessionFirstShellState`) composes the feature
through `@/features/sessions/...` subpaths; `app/useDashboard` +
`app/useRealtimeUpdates` re-export data through the feature hooks. The former
Dashboard-only consumers (`DashboardDialogs`, `TerminalWorkspace`,
`SessionPreviewDialog`, legacy list chrome) were deleted with the Dashboard
shell in #655.
