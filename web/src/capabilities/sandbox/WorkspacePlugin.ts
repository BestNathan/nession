import {
  WIRE as LIST_WIRE,
  type WorkspaceListResponse,
  type AgentWorkspaceDescriptor,
} from '@/generated/protocol/core/server-workspace-list/v1';
import {
  WIRE as CREATE_WIRE,
  type WorkspaceCreateResponse,
  type ClientWorkspaceCreatePayload,
} from '@/generated/protocol/core/server-workspace-create/v1';
import {
  WIRE as DELETE_WIRE,
  type WorkspaceDeleteResponse,
} from '@/generated/protocol/core/server-workspace-delete/v1';
import type { PluginSurface, TransportPlugin } from '@/platform/socket/types';

export type { AgentWorkspaceDescriptor };

/**
 * Agent-owned managed Workspace resources (#3407).
 *
 * A transport projection only: the Server authenticates and routes every unit
 * to the current Session's Agent, which owns the registry, names, stable ids
 * and durable bytes. This plugin caches nothing and synthesizes no inventory.
 */
export class WorkspacePlugin implements TransportPlugin {
  readonly name = 'workspaces';

  private connection: PluginSurface | null = null;

  install(connection: PluginSurface): () => void {
    this.connection = connection;
    return () => {
      if (this.connection === connection) {
        this.connection = null;
      }
    };
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('Workspace transport is not connected');
    }
    return this.connection;
  }

  /** The current Session Agent's measured managed Workspace inventory. */
  async list(sessionId: string, namespace?: string): Promise<AgentWorkspaceDescriptor[]> {
    const payload = namespace
      ? { session_id: sessionId, namespace }
      : { session_id: sessionId };
    const response = await this.requireConnection().request<WorkspaceListResponse>(
      LIST_WIRE,
      payload,
    );
    if (!response.success) {
      throw new Error(response.error ?? 'Workspace inventory read failed');
    }
    return response.workspaces;
  }

  /**
   * Idempotent get-or-create by name. The Server routes to the Session's
   * Agent; the Agent returns one stable id and never overwrites a collision.
   */
  async create(
    sessionId: string,
    name: string,
    options: { namespace?: string; autoCreated?: boolean } = {},
  ): Promise<AgentWorkspaceDescriptor> {
    const payload: ClientWorkspaceCreatePayload = {
      session_id: sessionId,
      name,
      auto_created: options.autoCreated ?? false,
      ...(options.namespace ? { namespace: options.namespace } : {}),
    };
    const response = await this.requireConnection().request<WorkspaceCreateResponse>(
      CREATE_WIRE,
      payload,
    );
    if (!response.success || !response.workspace) {
      throw new Error(response.error ?? 'Workspace creation was refused');
    }
    return response.workspace;
  }

  /** Delete one managed Workspace after the Agent's attachment check. */
  async remove(sessionId: string, workspaceId: string): Promise<void> {
    const response = await this.requireConnection().request<WorkspaceDeleteResponse>(
      DELETE_WIRE,
      { session_id: sessionId, workspace_id: workspaceId },
    );
    if (!response.success) {
      throw new Error(response.error ?? 'Workspace deletion was refused');
    }
  }
}

export const workspaceApi = new WorkspacePlugin();
