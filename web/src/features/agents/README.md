# Agents feature — ownership

The agents feature owns the nession agent **wire capability** (AgentsPlugin,
`agentsApi`) and the **agent UI** — the session-workspace agent page, the
header chip, and the agent data hooks. The Dashboard-shell registry UI
(cards grid `AgentCard`/`AgentSection`, detail Sheet `AgentDetailPanel`,
`DeleteAgentConfirmDialog`, `useAgentRename`) was deleted with the Dashboard
shell in #655 — the v2 IA treats Agent as metadata + a Workspace tool, not a
nav parent. The `Agent` type stays in the shared barrel (`@/types`); the
feature adds no parallel model.

It does **not** own probe/connectivity state (`atoms/probe.ts` +
`atoms/connection.ts`) — those describe attach routing latency, consumed by
`features/terminal` and the P2P attach domain, and therefore stay shared.

## Module map

| Module | Responsibility |
|---|---|
| `AgentsPlugin.ts`, `types.ts`, `index.ts` | Agent RPC capability (`client.agents.list/rename/delete` + `agents.changed` push) installed per WebSocketService; `agentsApi` module singleton with generation-tagged install/teardown |
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
| Agent list + loading/error + heartbeat history | `features/agents/hooks/useAgentData` per mount | Composed by `app/useDashboard`. Deliberately **no** list atom |
| Push updates (`agents.changed`) + refetch on reconnect | `app/useRealtimeUpdates` | One bridge for agents+sessions subscriptions keyed on `wsService` identity; kept app-layer while it fuses both domains |
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

## Consumers

The app shell (`app/patterns/SessionHeader` chip, `app/workspace/tools/agent.tsx`)
imports the feature components through `@/features/agents/...` subpaths.
`app/useDashboard` re-exports data through the feature hooks. The Dashboard
registry UI that previously consumed this feature was deleted with its shell
in #655. Tests mock `@/features/agents` — the alias is the feature's own
public entry and stays stable.
