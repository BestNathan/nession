import {
  WIRE as CREATE_WIRE,
  type ProjectCreatePayload,
  type ProjectCreateResponsePayload,
} from '@/generated/protocol/core/server-project-create/v1';
import {
  WIRE as DELETE_WIRE,
  type ProjectDeleteResponsePayload,
} from '@/generated/protocol/core/server-project-delete/v1';
import {
  WIRE as GET_WIRE,
  type ProjectGetResponsePayload,
} from '@/generated/protocol/core/server-project-get/v1';
import {
  WIRE as LIST_WIRE,
  type Project,
  type ProjectListResponsePayload,
} from '@/generated/protocol/core/server-project-list/v1';
import {
  WIRE as UPDATE_WIRE,
  type ProjectUpdatePayload,
  type ProjectUpdateResponsePayload,
} from '@/generated/protocol/core/server-project-update/v1';
import type { PluginSurface, TransportPlugin } from '@/platform/socket/types';

/**
 * Project capability — the five `server.project.*` units from #3021.
 *
 * The Server owns persistence; this plugin is the typed Web projection of the
 * generated bindings. There is no change notification for Projects, so list and
 * detail reads are explicit and every mutation is followed by a refresh by the
 * calling owner.
 */
export class ProjectsPlugin implements TransportPlugin {
  readonly name = 'projects';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private connectionListeners = new Set<() => void>();

  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;
    for (const listener of this.connectionListeners) {
      listener();
    }
    return () => {
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
        for (const listener of this.connectionListeners) {
          listener();
        }
      }
    };
  }

  /** Opaque identity of the installed transport, `0` when unbound. */
  connectionRevision(): number {
    return this.connection ? this.generation : 0;
  }

  onConnectionChange(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  async listProjects(): Promise<Project[]> {
    const response = await this.requireConnection().request<ProjectListResponsePayload>(
      LIST_WIRE,
      {},
    );
    if (response.error) {
      throw new Error(response.error);
    }
    return response.projects;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const response = await this.requireConnection().request<ProjectGetResponsePayload>(
      GET_WIRE,
      { project_id: projectId },
    );
    if (!response.success) {
      if (response.error_kind === 'not_found') {
        return null;
      }
      throw new Error(response.error ?? 'Project could not be loaded');
    }
    return response.project ?? null;
  }

  async createProject(input: ProjectCreatePayload): Promise<Project> {
    const response = await this.requireConnection().request<ProjectCreateResponsePayload>(
      CREATE_WIRE,
      input,
    );
    if (!response.success || !response.project) {
      throw new Error(response.error ?? 'Project could not be saved');
    }
    return response.project;
  }

  async updateProject(input: ProjectUpdatePayload): Promise<Project> {
    const response = await this.requireConnection().request<ProjectUpdateResponsePayload>(
      UPDATE_WIRE,
      input,
    );
    if (!response.success || !response.project) {
      throw new Error(response.error ?? 'Project could not be saved');
    }
    return response.project;
  }

  async deleteProject(projectId: string): Promise<void> {
    const response = await this.requireConnection().request<ProjectDeleteResponsePayload>(
      DELETE_WIRE,
      { project_id: projectId },
    );
    if (!response.success) {
      throw new Error(response.error ?? 'Project could not be deleted');
    }
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('Project transport is not connected');
    }
    return this.connection;
  }
}
