# Sessions feature — ownership

The sessions feature owns the nession session **wire capability** (SessionsPlugin,
`sessionsApi`) and the **session list / details UI** shared by both shells: the
session-first sidebar list and the legacy Dashboard rows both render through
feature components. It also owns the **domain-state model** (`mapDomainState`)
that derives the per-session `agent · session · attachment` channel view used
across the session workspace.

It does **not** own the attach/terminal runtime — that lives in `atoms/` +
`runtime/` + `core/terminal-runtime` (connectivity domain), and the legacy
Dashboard-only list (`components/SessionList` + `SessionsSection`) stays behind
the Dashboard shell until that shell is retired (Phase-5 cleanup).

## Module map

| Module | Responsibility |
|---|---|
| `SessionsPlugin.ts`, `types.ts`, `index.ts` | Session RPC capability (`client.session.create/kill/list/…`) installed per WebSocketService; `sessionsApi` module singleton with generation-tagged install/teardown |
| `model/domainState.ts` | Pure model: `mapDomainState` + `AgentChannel`/`SessionChannel`/`AttachmentChannel` channel types (input: session + agent + attachment identity) |
| `components/SessionList.tsx` + `SessionItem.tsx` | Session-first list rows (select + hover-kill; per-row `DomainState` derivation). **Not** the legacy Dashboard `components/SessionList` — different component, different shell (name collision resolved by deletion of the legacy copy, not coexistence) |
| `components/ConnectionStatus.tsx` | Compact 3-channel (`agent·session·attachment`) render of `DomainState`; consumed by the session header/details and by `features/agents` AgentDetail |
| `components/SessionDetails.tsx` | Session workspace-tool detail page (metadata + ConnectionStatus) |
| `components/CreateSessionDialog.tsx`, `KillConfirmDialog.tsx`, `SessionPreviewDialog.tsx` | Shared modals (both shells + legacy terminal chrome); call `sessionsApi`; env-file picker UI comes from `@/components/env/EnvFileMultiSelect` (env feature not yet converged) |
| `hooks/useSessionData.ts` | Per-mount session list state + `fetchSessions({force})` via `sessionsApi` |
| `hooks/useSessionPreview.ts` | Per-mount capture-preview state machine (abort + error localization) |
| `hooks/useTerminalSessions.ts` | Second, independent per-mount list for the legacy terminal dropdown (`features/terminal` `TerminalWorkspace`) |

## State ownership

Rules follow #649: transient render state stays in the component; state shared
across a capability lives in feature/model; transport/connection lifecycle
belongs to core runtime; layout/selection state belongs to app/workbench.

| State | Owner today | Lifetime / scope |
|---|---|---|
| Session list + loading/error | `hooks/useSessionData` per mount | Composed by `useDashboard` (app-layer composer used by **both** shells — the shells are mutually exclusive in `App.tsx`, so exactly one list copy is live; shell toggle remounts and refetches). Deliberately **no** list atom |
| Push updates (`sessions.changed`) + refetch on reconnect | `hooks/useRealtimeUpdates` (app layer) | Registers `sessionsApi.onSessionsChanged(setSessions)` keyed on `wsService` identity — one subscription bridge for agents+sessions; not moved into the feature while it fuses both domains |
| Filter/sort/search state | `hooks/useDashboardFilter` (app layer) | Per mount; types (`StatusFilter`/`SortField`/`SortDirection`) consumed by sidebar chrome `SessionListHeader` |
| Dialog targets (create/kill/preview, delete-agent) | `hooks/useDashboardModals` / `useDashboardDialogs` (app layer) | Per mount, Dashboard-shell chrome |
| Wire registration | `SessionsPlugin` instance (module singleton `sessionsApi`) | One binding per WebSocketService lifetime; `WebSocketService.use()` re-installs after reconnect with generation-tagged teardown (`SessionsPlugin.ts`) |
| Attach identity (`clientSessionId`, attach in-flight/failed, dialog session) | `atoms/session.ts` (shared) | Connectivity domain — NOT sessions-list domain; stays in `atoms/` alongside `atoms/connection.ts` |
| Per-row `DomainState` | `model/domainState` `mapDomainState` | Pure function of (session, agent, attachment) inputs; no stored state |

## Cross-feature dependency

`features/agents` imports `model/domainState` (types) and
`components/ConnectionStatus` for its in-workspace agent surfaces — the
channel vocabulary is session-workspace state, so sessions owns it. This
mirrors the `features/files → features/explorer` direction (owner of the
contract stays in one feature; the peer imports its public surface).

## Legacy consumers

`session-first/` shell chrome (sidebar, main, spatial layout, fixtures,
`useSessionFirstShellState`), `components/DashboardDialogs.tsx`, and
`features/terminal/components/TerminalWorkspace.tsx` compose the feature
through `@/features/sessions/...` subpaths. `useDashboard` +
`useRealtimeUpdates` (app-layer composers in `hooks/`) re-export data through
feature hooks. Legacy `components/SessionList.tsx` + `SessionsSection.tsx`
(Dashboard predecessor) and dead `SessionPanel.tsx` (deleted) never coexist
with the feature copy — the Dashboard-only list is scheduled for deletion
with the Dashboard shell.
