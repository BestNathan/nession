import { WIRE as ENV_DELETE_WIRE } from '@/generated/protocol/core/server-env-delete/v1';
import { WIRE as ENV_GET_WIRE } from '@/generated/protocol/core/server-env-get/v1';
import { WIRE as ENV_LIST_WIRE } from '@/generated/protocol/core/server-env-list/v1';
import { WIRE as ENV_WRITE_WIRE } from '@/generated/protocol/core/server-env-write/v1';
import { WIRE as SESSION_ENV_ACTIVE_WIRE } from '@/generated/protocol/core/server-session-env-active/v1';
import { WIRE as SESSION_ENV_APPLY_WIRE } from '@/generated/protocol/core/server-session-env-apply/v1';
import { WIRE as SESSION_ENV_QUERY_WIRE } from '@/generated/protocol/core/server-session-env-query/v1';
import { WIRE as SESSION_ENV_UNSET_WIRE } from '@/generated/protocol/core/server-session-env-unset/v1';
import type { TransportPlugin, PluginSurface } from '@/platform/socket/types';
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
 * env capability — `server.env.list|get|write|delete` plus the per-session
 * env-file operations `client.session.env.apply|unset|active|query`. The wire
 * strings are the generated bindings, so one that drifts from the Rust fails
 * the build; the typed API is what consumers import (module singleton in
 * index.ts).
 */
export class EnvPlugin implements TransportPlugin {
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
    return this.requireConnection().request<EnvListResponse>(ENV_LIST_WIRE, {});
  }

  /** Fetch a single env file's content and usage state. */
  async getEnvFile(ref: EnvFileRef): Promise<EnvGetResponse> {
    return this.requireConnection().request<EnvGetResponse>(ENV_GET_WIRE, {
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
    return this.requireConnection().request<EnvWriteResponse>(ENV_WRITE_WIRE, {
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
    return this.requireConnection().request<EnvDeleteResponse>(ENV_DELETE_WIRE, {
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
    return this.requireConnection().request<SessionEnvResponse>(SESSION_ENV_APPLY_WIRE, {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  /** Unset the variables a set of env files had sourced into a session. */
  async unsetSessionEnv(
    sessionId: string,
    envFiles: EnvFileRef[],
  ): Promise<SessionEnvResponse> {
    return this.requireConnection().request<SessionEnvResponse>(SESSION_ENV_UNSET_WIRE, {
      session_id: sessionId,
      env_files: envFiles,
    });
  }

  /** List the env files currently sourced into a session. */
  async getSessionEnvActive(sessionId: string): Promise<SessionEnvActiveResponse> {
    return this.requireConnection().request<SessionEnvActiveResponse>(
      SESSION_ENV_ACTIVE_WIRE,
      { session_id: sessionId },
    );
  }

  /** Query an agent's full env-file state for a session. */
  async queryAgentEnvState(sessionId: string): Promise<SessionEnvQueryResponse> {
    return this.requireConnection().request<SessionEnvQueryResponse>(
      SESSION_ENV_QUERY_WIRE,
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
