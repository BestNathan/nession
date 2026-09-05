import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type {
  AttachInfo,
  CreateSessionResponse,
  EnvFileRef,
  KillSessionResponse,
  Session,
  SessionsListResponse,
} from './types';

/**
 * sessions capability — `client.sessions.list` / `client.session.create|kill|
 * attach|capture_preview` plus the two change notifications that keep the UI's
 * session list fresh. Wire strings live only in this file; the typed API is
 * what consumers import (module singleton in index.ts).
 */
export class SessionsPlugin implements CapabilityPlugin {
  readonly name = 'sessions';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private callbacks = new Set<(sessions: Session[]) => void>();

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsubs = [
      connection.subscribe('sessions.changed', (payload) => {
        const sessions = (payload as { sessions?: Session[] })?.sessions;
        if (sessions) {
          this.notify(sessions);
        }
      }),
      connection.subscribe('client.sessions.list.response', (payload) => {
        const sessions = (payload as { sessions?: Session[] })?.sessions;
        if (sessions) {
          this.notify(sessions);
        }
      }),
    ];

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
      // A released plugin must never notify stale consumers.
      this.callbacks.clear();
    };
  }

  /**
   * Fetch sessions and return the full response, including `stale_agents`.
   *
   * With `force: true` the server queries every online agent for its live
   * tmux state before answering, so the list is strongly consistent rather
   * than whatever the last watcher poll left in the registry. Agents that
   * fail to answer are named in `stale_agents` — their sessions are still
   * returned, but may be out of date.
   */
  async fetchSessions(
    opts: { agentId?: string; force?: boolean } = {},
  ): Promise<SessionsListResponse> {
    const payload: Record<string, unknown> = {};
    if (opts.agentId) {
      payload.agent_id = opts.agentId;
    }
    if (opts.force) {
      payload.force = true;
    }
    const response = await this.requireConnection().request<SessionsListResponse>(
      'client.sessions.list',
      payload,
    );
    return { sessions: response.sessions, stale_agents: response.stale_agents ?? [] };
  }

  /** Fetch sessions for all agents (or one agent) as a bare list. */
  async listSessions(agentId?: string): Promise<Session[]> {
    const response = await this.fetchSessions({ agentId });
    return response.sessions;
  }

  /**
   * Ask the server for attach information (server-side session attach;
   * distinct from the P2P `client.attach` used by the terminal runtime).
   */
  async requestAttach(
    sessionId: string,
    mode: 'p2p' | 'relay' = 'p2p',
    relayUrl?: string,
  ): Promise<AttachInfo> {
    const payload: Record<string, unknown> = {
      session_id: sessionId,
      preferred_mode: mode,
    };
    if (relayUrl) {
      payload.relay_url = relayUrl;
    }
    return this.requireConnection().request<AttachInfo>('client.session.attach', payload);
  }

  /** Create a tmux session on an agent, optionally sourcing env files. */
  async createSession(
    agentId: string,
    name: string,
    envFiles: EnvFileRef[] = [],
  ): Promise<CreateSessionResponse> {
    return this.requireConnection().request<CreateSessionResponse>('client.session.create', {
      agent_id: agentId,
      name,
      env_files: envFiles,
    });
  }

  /** Kill a tmux session (`"agentId:sessionName"`). */
  async killSession(sessionId: string): Promise<KillSessionResponse> {
    return this.requireConnection().request<KillSessionResponse>('client.session.kill', {
      session_id: sessionId,
    });
  }

  /**
   * Capture tmux session scrollback as ANSI text.
   * @param sessionId — "agentId:sessionName"
   * @param lines — number of lines to capture (must be > 0)
   * @returns object with decoded UTF-8 ANSI string and optional cols/rows (may
   *   be empty if session has no history)
   */
  async capturePreview(
    sessionId: string,
    lines: number,
  ): Promise<{ ansi: string; cols?: number; rows?: number }> {
    const connection = this.requireConnection();
    if (!Number.isInteger(lines) || lines <= 0) {
      throw new Error(`Invalid lines: ${lines}`);
    }
    const response = await connection.request<{
      ansi_b64?: string;
      cols?: number;
      rows?: number;
      error?: string;
    }>('client.session.capture_preview', { session_id: sessionId, lines });
    if (response.error) {
      throw new Error(response.error);
    }
    if (response.ansi_b64 === null || response.ansi_b64 === undefined) {
      throw new Error('Capture failed: no data returned');
    }
    const { decodeBase64Utf8 } = await import('@/lib/encoding');
    return {
      ansi: decodeBase64Utf8(response.ansi_b64),
      cols: response.cols,
      rows: response.rows,
    };
  }

  /** Subscribe to session list changes (server push or list response). */
  onSessionsChanged(cb: (sessions: Session[]) => void): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  private notify(sessions: Session[]): void {
    for (const cb of this.callbacks) {
      cb(sessions);
    }
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('sessions feature is not connected');
    }
    return this.connection;
  }
}
