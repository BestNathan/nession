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
| `hooks/useAgentProcesses.ts` | Per-Agent Session list plus on-demand read-only process snapshots (#2514) |
| `hooks/useAgentProbe.ts` | Credentialed, attach-context address probes |
| `state/probe.ts` | Agent-keyed cached browser probe results |
| `components/AgentProcesses.tsx` | Contextual Sessions & Processes section inside AgentDetail (#2514) |
| `components/ProcessTree.tsx` | Pane-grouped PPID process tree with linked-Window memberships |
| `components/ProcessInspector.tsx` | Command-first process detail and per-PID/subtree resource scope |
| `model/processSnapshot.ts` | Pure tree, descendant-subtree and metric helpers |

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

## Process discovery ownership (#2514)

Session process discovery **deepens the existing Agent capability**; it does
not add a Process capability, a permanent tab, or a second navigation owner.
`AgentDetail` keeps node identity/connectivity first, then renders the
`AgentProcesses` section: Session list → Pane → process tree → command-first
inspector → per-PID/subtree resources → diagnostics. The snapshot is read-only
and on demand; the browser never probes the OS, and the sanitized command is the
only command string that exists here. The truth contract (methods, coverage,
metric states, redaction) is owned by
[docs/architecture/agent-process-discovery.md](../../../docs/architecture/agent-process-discovery.md).

The live shell imports Agent patterns from `@/product/agent/...`.
The old `@/features/agents` path and `components/AgentDetail.tsx` /
`components/AgentContext.tsx` locations are **not** current APIs. Keep the
public capability boundary under `product/agent` and avoid adding a parallel
agent feature tree.
