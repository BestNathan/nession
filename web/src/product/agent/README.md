# Agent capability — ownership

The agent product module owns the agent wire capability (`AgentsPlugin`,
`agentsApi`), read-only Agent workspace surfaces, agent data hooks and
browser-measured address latency. Agent is **context in a Session workspace**,
not a permanent navigation parent; the retired Dashboard Agent registry
was deleted under #655. The shared `Agent` type remains in `@/types`.

## Current module map

| Path | Responsibility |
|---|---|
| `AgentsPlugin.ts`, `types.ts`, `index.ts` | Agent protocol capability, module-level `agentsApi` binding per WebSocketService lifetime |
| `patterns/AgentDetail.tsx` | Workspace Agent details and extension contribution slot |
| `patterns/AgentContext.tsx` | Session-header Agent context / status |
| `hooks/useAgentData.ts` | Per-mount list, refresh, dedupe and bounded heartbeat history |
| `hooks/useAgentProbe.ts` | Credentialed, attach-context address probes |
| `state/probe.ts` | Agent-keyed cached browser probe results |

## State and dependencies

- Agent list/loading/error state lives in `useAgentData` and is composed by
  `app/useDashboard.ts`; there is no separate global list atom.
- Realtime push and reconnect refetch are composed by
  `app/useRealtimeUpdates.ts`, since they span Agent and Session domains.
- P2P probe results live under `product/agent/state/probe.ts`;
  transport/route generation belongs to `platform/attach/state/`.
  After #1013 probes **require a credential from an attach reply**, not an
  unauthenticated periodic poll. `useAgentProbe` is driven by those inputs.
- Agent / Session / attachment channel vocabulary is defined in the Session
  domain (`@/product/session/model/domainState`). Agent patterns may consume
  that public Session model instead of defining a duplicate status contract.
- `AgentsPlugin` uses generation-aware binding/teardown on reconnect.

The live shell imports Agent patterns from `@/product/agent/...`.
The old `@/features/agents` path and `components/AgentDetail.tsx` /
`components/AgentContext.tsx` locations are **not** current APIs. Keep the
public capability boundary under `product/agent` and avoid adding a parallel
agent feature tree.
