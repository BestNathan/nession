import type { Agent } from '@/types';

/**
 * Process discovery wire types (`#2514`).
 *
 * Re-exported from the generated contract rather than restated: the Rust
 * contract is the owner and the generated file is its projection.
 */
export type {
  DiscoveredProcess,
  PaneProcessSnapshot,
  ProcessCoverage,
  ProcessDiscoveryLimits,
  ProcessDiscoveryMethod,
  ProcessMetric,
  ProcessMetricState,
  ProcessSnapshot,
} from '@/generated/protocol/core/server-session-processes/v1';

/** Wire response of `client.agents.list` (correlated by request id). */
export interface AgentsListResponse {
  agents: Agent[];
}

/** Wire response of `client.agent.rename`. */
export interface AgentRenameResponse {
  success: boolean;
  error?: string;
  agent?: Agent;
}

/** Wire response of `client.agent.delete`. */
export interface AgentDeleteResponse {
  success: boolean;
  error?: string;
}
