# Session capability — ownership

The Session product module owns session wire operations
(`SessionsPlugin`, `sessionsApi`), list / dialog / details UI,
Session-domain status derivation and attachment identity. It does **not**
own terminal or attach execution: those runtimes live under
`platform/{session-runtime,attach,terminal-runtime}/`.
The retired Dashboard-specific list and preview surfaces were deleted
under #655.

## Current module map

| Path | Responsibility |
|---|---|
| `SessionsPlugin.ts`, `types.ts`, `index.ts` | Session wire capability, types and `sessionsApi` binding |
| `model/domainState.ts` | Pure `mapDomainState` for Agent / Session / attachment channels |
| `model/sessionChrome.ts`, `sessionFromCreateAck.ts` | Session UI chrome projection and create acknowledgment mapping |
| `patterns/SessionList.tsx`, `patterns/SessionItem.tsx` | Session sidebar rows and interaction |
| `patterns/ConnectionStatus.tsx` | Shared three-channel status presentation |
| `components/SessionDetails.tsx` | Workspace Session details |
| `components/{CreateSessionDialog,KillConfirmDialog,AttachDialog,SearchBar}.tsx` | Session CRUD / attach dialogs and list search |
| `hooks/useSessionData.ts`, `hooks/useDebouncedInput.ts` | Per-mount list state and search debounce |
| `state/session.ts`, `state/route.ts` | Attachment identity, route and dialog/session state |

## State ownership

- List/loading/error state stays per `useSessionData` mount and is composed
  by `app/useDashboard.ts`, not another global session-list atom.
- Filter/sort/search and modal composition belong to app-layer hooks
  (`app/useDashboardFilter.ts`, `app/useDashboardModals.ts`).
- `app/useRealtimeUpdates.ts` owns the bridge for both Agents and Sessions
  push updates and reconnect refetch.
- Session attachment identity/route state belongs to
  `product/session/state/`; transport generation, WebSocket attachment and
  terminal rendering/replay are separate `platform/` concerns.
- `model/domainState.ts` derives the `agent · session · attachment`
  presentation; `@/product/agent` consumes its public types and
  `patterns/ConnectionStatus.tsx` rather than duplicating channel semantics.
- `SessionsPlugin` installs a generation-aware WebSocketService binding.

The live shell composes these modules through `@/product/session/...` and
`app/`. Earlier `@/features/sessions` and
`components/SessionList.tsx` / `components/ConnectionStatus.tsx` paths
are obsolete; the corresponding live components now reside in `patterns/`.
Keep the API and runtime ownership split explicit when adding new
Session capabilities.
