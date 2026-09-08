# Agents feature — ownership

The agents feature owns the nession agent **wire capability** (AgentsPlugin,
`agentsApi`) and the **agent registry UI** — cards, detail panel, delete
confirm (Dashboard shell) and the workspace agent page + header chip
(session-first shell) — plus the agent data/rename hooks. The `Agent` type
stays in the shared barrel (`@/types`); the feature adds no parallel model.

It does **not** own probe/connectivity state (`atoms/probe.ts` +
`atoms/connection.ts`) — those describe attach routing latency, consumed by
`features/terminal` and the P2P attach domain, and therefore stay shared.

## Module map

| Module | Responsibility |
|---|---|
| `AgentsPlugin.ts`, `types.ts`, `index.ts` | Agent RPC capability (`client.agents.list/rename/delete` + `agents.changed` push) installed per WebSocketService; `agentsApi` module singleton with generation-tagged install/teardown |
| `components/AgentCard.tsx` | Registry card: inline rename (`hooks/useAgentRename`), delete-when-offline, hostname/uptime/version row. The rename button id (`rename-<agentId>`) is the DOM anchor the Dashboard detail panel clicks — keep when the legacy shell lives |
| `components/AgentSection.tsx` | Card grid (md+) + mobile strip, skeletons, empty states (Dashboard shell) |
| `components/AgentDetailPanel.tsx` | Dashboard detail **Sheet** (stats, heartbeat history, system info, sessions, quick actions). Distinct component from `AgentDetail` — a guard test pins the divergence; do not unify silently |
| `components/DeleteAgentConfirmDialog.tsx` | Type-to-confirm delete → `agentsApi.deleteAgent` |
| `components/AgentDetail.tsx` | Session-workspace agent tool page (read-only info + extension slot `agent-detail` via `@/extensions/registry`) |
| `components/AgentContext.tsx` | Agent chip in the session header (channel-colored label + offline copy) |
| `hooks/useAgentData.ts` | Per-mount agent list state, fetch, heartbeat-history Map (capped at 5), dedupe (`agentsEqual`, last_heartbeat excluded) |
| `hooks/useAgentRename.ts` | Rename-in-place state machine calling `agentsApi.renameAgent` |

## State ownership

Rules follow #649: transient render state stays in the component; state shared
across a capability lives in feature/model; transport/connection lifecycle
belongs to core runtime; layout/selection state belongs to app/workbench.

| State | Owner today | Lifetime / scope |
|---|---|---|
| Agent list + loading/error + heartbeat history | `hooks/useAgentData` per mount | Composed by `useDashboard` (app-layer composer, both shells). Deliberately **no** list atom — the shells never mount together; per-mount duplication is benign and shell-toggle refetches |
| Push updates (`agents.changed`) + refetch on reconnect | `hooks/useRealtimeUpdates` (app layer) | One bridge for agents+sessions subscriptions keyed on `wsService` identity; kept app-layer while it fuses both domains |
| Rename machine (editing/editingValue/saving) | `hooks/useAgentRename` per AgentCard | Optimistic-by-response; `agents.changed` re-notifies anyway |
| Delete target | `hooks/useDashboardDialogs` (app layer) | Dashboard-shell dialog state; session-first has no delete affordance (read-only `AgentDetail` only) |
| Detail selection | `hooks/useDashboardModals` (app layer) | Dashboard shell |
| Probe results / latencies | `atoms/probe.ts` (shared) | Written by `useProbePolling` (mounted once per shell), read by the P2P attach domain — connectivity, not agent registry |
| Wire registration | `AgentsPlugin` instance (module singleton `agentsApi`) | One binding per WebSocketService lifetime; re-install after reconnect with generation-tagged teardown (`AgentsPlugin.ts`) |

## Cross-feature dependency

`AgentDetail`/`AgentContext` render the session-workspace channel status
(`agent · session · attachment`) and read their state through the **sessions
feature** public surface (`features/sessions/model/domainState` types +
`components/ConnectionStatus`) — the channel vocabulary is session-workspace
state, so sessions owns it. Mirrors the `features/files → features/explorer`
direction. The agent channel derivation itself (`agent.status` +
staleness → channel) stays in `domainState`; moving it here would invert the
dependency for session list rows.

## Legacy consumers

`components/DashboardMainView.tsx` and the (test-only) `Dashboard.tsx`
re-export removed — the grid/panel/dialog now import through
`@/features/agents/...` directly. Session-first shell chrome
(`patterns/SessionHeader`, `workspace/tools/agent.tsx`) imports the feature
components through the same subpaths. `useDashboard` (app layer) re-exports
data through feature hooks. Tests mock `@/features/agents` — the alias is the
feature's own public entry and stays stable.
