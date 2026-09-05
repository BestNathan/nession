import type { CapabilityPlugin, PluginSurface } from '@/services/socket/types';
import type {
  EnvDeleteResponse,
  EnvFileRef,
  EnvGetResponse,
  EnvListResponse,
  EnvWriteResponse,
  SessionEnvActiveResponse,
  SessionEnvQueryResponse,
  SessionEnvResponse,
} from './types';

/**
 * env capability — `client.env.list|get|write|delete` plus the per-session
 * env-file operations `client.session.env.apply|unset|active|query`. Wire
 * strings live only in this file; the typed API is what consumers import
 * (module singleton in index.ts).
 */
export class EnvPlugin implements CapabilityPlugin {
  readonly name = 'env';

  private connection: PluginSurface | null = null;
  private generation = 0;

  /**
   * Bind the plugin to a connection. A later install replaces an earlier
   * binding (same instance, new surface — StrictMode remount); the returned
   * teardown is generation-guarded so a stale release can never detach the
   * newer binding.
   */
  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  /** List all environment-variable files visible to the server. */
  async listEnvFiles(): Promise<EnvListResponse> {
    return this.requireConnection().request<EnvListResponse>('client.env.list', {});
  }

  /** Fetch a single env file's content and usage state. */
  async getEnvFile(ref: EnvFileRef): Promise<EnvGetResponse> {
    return this.requireConnection().request<EnvGetResponse>('client.env.get', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  /**
   * Write an env file. `overwrite: false` refuses when the file exists;
   * `force: true` overrides in-use protection.
   */
  async writeEnvFile(
    ref: EnvFileRef,
    content: string,
    overwrite: boolean,
    force = false,
  ): Promise<EnvWriteResponse> {
    return this.requireConnection().request<EnvWriteResponse>('client.env.write', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
      content,
      overwrite,
      force,
    });
  }

  /** Delete an env file. */
  async deleteEnvFile(ref: EnvFileRef): Promise<EnvDeleteResponse> {
    return this.requireConnection().request<EnvDeleteResponse>('client.env.delete', {
      name: ref.name,
      source: ref.source,
      agent_id: ref.agent_id,
    });
  }

  /** Source env files into a running session. */
  async applySessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    return this.requireConnection().request<SessionEnvResponse>('client.session.env.apply', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  /** Unset the variables a set of env files had sourced into a session. */
  async unsetSessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    return this.requireConnection().request<SessionEnvResponse>('client.session.env.unset', {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  /** List the env files currently sourced into a session. */
  async getSessionEnvActive(sessionId: string): Promise<SessionEnvActiveResponse> {
    return this.requireConnection().request<SessionEnvActiveResponse>(
      'client.session.env.active',
      { session_id: sessionId },
    );
  }

  /** Query an agent's full env-file state for a session. */
  async queryAgentEnvState(sessionId: string): Promise<SessionEnvQueryResponse> {
    return this.requireConnection().request<SessionEnvQueryResponse>(
      'client.session.env.query',
      { session_id: sessionId },
    );
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('env feature is not connected');
    }
    return this.connection;
  }
}
