import type { WebSocketPlugin, WebSocketServiceCore } from '../types';
import type {
  Agent,
  Session,
  AttachInfo,
  AgentsListResponse,
  CreateSessionResponse,
  KillSessionResponse,
  EnvFileRef,
  EnvListResponse,
  EnvGetResponse,
  EnvWriteResponse,
  EnvDeleteResponse,
  SessionEnvResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
  ServerInfo,
  SessionsListResponse,
  CommandsListResponse,
  CommandsAddResponse,
  CommandsRemoveResponse,
  CommandsUpdateResponse,
} from '../../../types';

/**
 * RequestPlugin — all request/response WebSocket operations.
 *
 * Each public method sends a typed request via the core and awaits the
 * correlated response.  Authentication state is checked before every
 * request so callers get a clear error instead of a timeout.
 */
export class RequestPlugin implements WebSocketPlugin {
  name = 'requests';

  private core!: WebSocketServiceCore;

  install(core: WebSocketServiceCore): void {
    this.core = core;
  }

  // ── Helpers ───────────────────────────────────────────────────

  private requireAuth(): void {
    if (!this.core.isAuthenticated()) {
      throw new Error('Not authenticated');
    }
  }

  // ── Agents ────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    this.requireAuth();
    const response = await this.core.request<AgentsListResponse>('client.agents.list', {});
    return response.agents;
  }

  /** Rename an agent's display name. Pass null to clear (reset to config/hostname). */
  async renameAgent(agentId: string, displayName: string | null): Promise<Agent> {
    this.requireAuth();

    const response = await this.core.request<{
      success: boolean;
      error?: string;
      agent?: Agent;
    }>('client.agent.rename', {
      agent_id: agentId,
      display_name: displayName,
    });

    if (!response.success || !response.agent) {
      throw new Error(response.error || 'Rename failed');
    }

    return response.agent;
  }

  // ── Server ────────────────────────────────────────────────────

  /** Fetch server info (version, uptime, counts). */
  async serverInfo(): Promise<ServerInfo> {
    this.requireAuth();
    return this.core.request<ServerInfo>('client.server.info', {});
  }

  // ── Sessions ──────────────────────────────────────────────────

  async listSessions(agentId?: string): Promise<Session[]> {
    this.requireAuth();
    const payload = agentId ? { agent_id: agentId } : {};
    const response = await this.core.request<SessionsListResponse>('client.sessions.list', payload);
    return response.sessions;
  }

  async requestAttach(
    sessionId: string,
    mode: 'p2p' | 'relay' = 'p2p',
    relayUrl?: string,
  ): Promise<AttachInfo> {
    this.requireAuth();

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      preferred_mode: mode,
    };
    if (relayUrl) {
      payload.relay_url = relayUrl;
    }

    return this.core.request<AttachInfo>('client.session.attach', payload);
  }

  async createSession(
    agentId: string,
    name: string,
    envFiles: EnvFileRef[] = [],
  ): Promise<CreateSessionResponse> {
    this.requireAuth();
    return this.core.request<CreateSessionResponse>('client.session.create', {
      agent_id: agentId,
      name,
      env_files: envFiles,
    });
  }

  async killSession(sessionId: string): Promise<KillSessionResponse> {
    this.requireAuth();
    return this.core.request<KillSessionResponse>('client.session.kill', {
      session_id: sessionId,
    });
  }

  // ── Environment-variable file management ──────────────────────

  async listEnvFiles(): Promise<EnvListResponse> {
    this.requireAuth();
    return this.core.request<EnvListResponse>('client.env.list', {});
  }

  async getEnvFile(ref: EnvFileRef): Promise<EnvGetResponse> {
    this.requireAuth();
    return this.core.request<EnvGetResponse>('client.env.get', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  async writeEnvFile(
    ref: EnvFileRef,
    content: string,
    overwrite: boolean,
  ): Promise<EnvWriteResponse> {
    this.requireAuth();
    return this.core.request<EnvWriteResponse>('client.env.write', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
      content,
      overwrite,
    });
  }

  async deleteEnvFile(ref: EnvFileRef): Promise<EnvDeleteResponse> {
    this.requireAuth();
    return this.core.request<EnvDeleteResponse>('client.env.delete', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  async applySessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    this.requireAuth();
    return this.core.request<SessionEnvResponse>('client.session.env.apply', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  async unsetSessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    this.requireAuth();
    return this.core.request<SessionEnvResponse>('client.session.env.unset', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  async getSessionEnvActive(sessionId: string): Promise<SessionEnvActiveResponse> {
    this.requireAuth();
    return this.core.request<SessionEnvActiveResponse>('client.session.env.active', {
      session_id: sessionId,
    });
  }

  async queryAgentEnvState(sessionId: string): Promise<SessionEnvQueryResponse> {
    this.requireAuth();
    return this.core.request<SessionEnvQueryResponse>('client.session.env.query', {
      session_id: sessionId,
    });
  }

  // ── Quick Commands (issue #95) ────────────────────────────────

  async listCommands(): Promise<CommandsListResponse> {
    this.requireAuth();
    return this.core.request<CommandsListResponse>('client.commands.list', {});
  }

  async addCommand(
    label: string,
    command: string,
    raw = false,
  ): Promise<CommandsAddResponse> {
    this.requireAuth();
    return this.core.request<CommandsAddResponse>('client.commands.add', {
      label,
      command,
      raw,
    });
  }

  async removeCommand(id: string): Promise<CommandsRemoveResponse> {
    this.requireAuth();
    return this.core.request<CommandsRemoveResponse>('client.commands.remove', { id });
  }

  async updateCommand(
    id: string,
    fields: { label?: string; command?: string; raw?: boolean },
  ): Promise<CommandsUpdateResponse> {
    this.requireAuth();
    return this.core.request<CommandsUpdateResponse>('client.commands.update', {
      id,
      ...fields,
    });
  }
}
