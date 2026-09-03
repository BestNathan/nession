const MAX_RECONNECT_DELAY = 30_000;

export function buildAgentWsUrl(agentUrl: string, connectionToken?: string): string {
  if (!connectionToken) {
    return agentUrl;
  }
  return `${agentUrl}${agentUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(connectionToken)}`;
}

export interface AgentSocketClientConfig {
  agentUrl: string;
  connectionToken?: string;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  onError?: (error: Error) => void;
}

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
export const DEFAULT_RECONNECT_BASE_DELAY = 1_000;

export function reconnectDelayMs(attempt: number, baseDelay: number): number {
  return Math.min(baseDelay * Math.pow(2, attempt), MAX_RECONNECT_DELAY);
}
