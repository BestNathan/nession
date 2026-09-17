import type { Agent } from '@/types';

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
