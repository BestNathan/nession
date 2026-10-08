export interface FullStackRuntimeOptions {
  repoRoot: string;
  targetSha?: string;
  profile?: string;
  home: string;
  tmuxSocket: string;
  serverPort: number;
  agentPort: number;
  webPort: number;
  stalledProbePort?: number;
  readyTimeoutMs?: number;
  agentStartDelayMs?: number;
  cleanupHome?: boolean;
  serverConfigTemplate?: string;
  agentConfigTemplate?: string;
}

export interface FullStackRuntime {
  schema_version: 1;
  target_sha: string;
  profile: string;
  home: string;
  tmux_socket: string;
  server_port: number;
  agent_port: number;
  web_port: number;
  base_url: string;
  stop(): Promise<void>;
}

export function startFullStackRuntime(options: FullStackRuntimeOptions): Promise<FullStackRuntime>;
export function assertTargetSha(repoRoot: string, targetSha?: string): string;
export function renderServerConfig(
  template: string,
  options: { serverPort: number; home: string },
): string;
export function renderAgentConfig(
  template: string,
  options: {
    serverPort: number;
    agentPort: number;
    stalledProbePort: number;
    home: string;
  },
): string;
