import {
  WIRE as BUILD_WIRE,
  type ImageBuildResponsePayload,
  type ImageDescriptor,
  type ImageSource,
} from '@/generated/protocol/core/server-image-build/v1';
import {
  WIRE as LIST_WIRE,
  type ImageListResponsePayload,
} from '@/generated/protocol/core/server-image-list/v1';
import {
  WIRE as GET_WIRE,
  type ImageGetResponsePayload,
} from '@/generated/protocol/core/server-image-get/v1';
import {
  WIRE as ACCESS_WIRE,
  type ImageAccessResponsePayload,
} from '@/generated/protocol/core/server-image-access/v1';
import {
  WIRE as BUILD_SUBMIT_WIRE,
  type ImageBuildDescriptor,
  type ImageBuildSubmitResponsePayload,
} from '@/generated/protocol/core/server-image-build-submit/v1';
import {
  WIRE as BUILD_GET_WIRE,
  type ImageBuildGetResponsePayload,
} from '@/generated/protocol/core/server-image-build-get/v1';
import {
  WIRE as BUILD_LIST_WIRE,
  type ImageBuildListResponsePayload,
} from '@/generated/protocol/core/server-image-build-list/v1';
import {
  WIRE as BUILD_CANCEL_WIRE,
  type ImageBuildCancelResponsePayload,
} from '@/generated/protocol/core/server-image-build-cancel/v1';
import {
  WIRE as BUILD_RETRY_WIRE,
  type ImageBuildRetryResponsePayload,
} from '@/generated/protocol/core/server-image-build-retry/v1';
import type { ConnectionState, PluginSurface, TransportPlugin } from '@/platform/socket/types';

export type { ImageBuildDescriptor, ImageDescriptor, ImageSource };

/** The Server-pushed durable build transition (#3334). */
export const IMAGE_BUILD_UPDATED_WIRE = 'server.image.build.updated';

/** One complete-inventory page returned by `server.image.list`. */
export interface ImagePage {
  images: ImageDescriptor[];
  total: number;
  next_offset?: number | null;
}

/** One durable build page returned by `server.image.build.list`. */
export interface ImageBuildPage {
  builds: ImageBuildDescriptor[];
  total: number;
  next_offset?: number | null;
}

/** The scoped bearer grant a consumer receives for one digest. */
export interface ImageAccessGrant {
  token: string;
  expires_at: number;
  path: string;
}

/**
 * Server-owned global EROFS Image Manager (#3022, #3181, #3334) — the typed
 * Web projection of the `server.image.*` units.
 *
 * Images are a Server resource, not a Project or Sandbox type. This transport
 * exposes the registry, the durable asynchronous build lifecycle and a
 * consumer-scoped byte grant. Project selection and Sandbox composition each
 * own their own UI and reference model; they consume this registry through
 * this one transport boundary rather than re-implementing it.
 */
export class ImagesPlugin implements TransportPlugin {
  readonly name = 'images';

  private connection: PluginSurface | null = null;
  private generation = 0;
  private readonly buildListeners = new Set<(build: ImageBuildDescriptor) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  install(connection: PluginSurface): () => void {
    const generation = ++this.generation;
    this.connection = connection;

    const unsubBuild = connection.subscribe(IMAGE_BUILD_UPDATED_WIRE, (payload) => {
      const build = (payload as { build?: ImageBuildDescriptor } | null)?.build;
      if (build) {
        for (const listener of this.buildListeners) {
          listener(build);
        }
      }
    });
    const unsubState = connection.onConnectionStateChange((state) => {
      for (const listener of this.stateListeners) {
        listener(state);
      }
    });
    // A listener that subscribed before this install learns the current state
    // rather than waiting for the first transition.
    for (const listener of this.stateListeners) {
      listener(connection.connectionState);
    }

    return () => {
      unsubBuild();
      unsubState();
      if (this.generation === generation && this.connection === connection) {
        this.connection = null;
      }
    };
  }

  private requireConnection(): PluginSurface {
    if (!this.connection) {
      throw new Error('Images transport is not connected');
    }
    return this.connection;
  }

  /**
   * Legacy synchronous path (`server.image.build` v1).
   *
   * Kept as the documented compatibility projection: it submits the durable
   * background build and resolves to the ready descriptor. New UI code uses
   * {@link submitBuild} and observes the durable record instead of holding a
   * request open.
   */
  async buildImage(source: ImageSource, alias?: string): Promise<ImageDescriptor> {
    const payload = alias ? { source, alias } : { source };
    const response = await this.requireConnection().request<ImageBuildResponsePayload>(
      BUILD_WIRE,
      payload,
    );
    if (!response.success || !response.image) {
      throw new Error(response.error ?? 'Image build failed');
    }
    return response.image;
  }

  /**
   * Submit one durable asynchronous build. Returns the queued record promptly;
   * completion arrives as a push or through {@link getBuild}.
   */
  async submitBuild(
    source: ImageSource,
    options: { alias?: string; clientRequestId?: string } = {},
  ): Promise<ImageBuildDescriptor> {
    const payload: Record<string, unknown> = { source };
    if (options.alias) {
      payload.alias = options.alias;
    }
    if (options.clientRequestId) {
      payload.client_request_id = options.clientRequestId;
    }
    const response = await this.requireConnection().request<ImageBuildSubmitResponsePayload>(
      BUILD_SUBMIT_WIRE,
      payload,
    );
    if (!response.success || !response.build) {
      throw new Error(response.error ?? 'Image build submission was refused');
    }
    return response.build;
  }

  /** Read the authoritative durable build record. */
  async getBuild(buildId: string): Promise<ImageBuildDescriptor> {
    const response = await this.requireConnection().request<ImageBuildGetResponsePayload>(
      BUILD_GET_WIRE,
      { build_id: buildId },
    );
    if (!response.success || !response.build) {
      throw new Error(response.error ?? 'Image build not found');
    }
    return response.build;
  }

  /** One page of the durable build inventory, newest first. */
  async listBuilds(
    options: { offset?: number; limit?: number } = {},
  ): Promise<ImageBuildPage> {
    const response = await this.requireConnection().request<ImageBuildListResponsePayload>(
      BUILD_LIST_WIRE,
      { offset: options.offset ?? 0, limit: options.limit ?? 50 },
    );
    if (response.error) {
      throw new Error(response.error);
    }
    return {
      builds: response.builds,
      total: response.total,
      next_offset: response.next_offset,
    };
  }

  /** Cancel one build and return its truthful (possibly still running) record. */
  async cancelBuild(buildId: string): Promise<ImageBuildDescriptor> {
    const response = await this.requireConnection().request<ImageBuildCancelResponsePayload>(
      BUILD_CANCEL_WIRE,
      { build_id: buildId },
    );
    if (!response.success || !response.build) {
      throw new Error(response.error ?? 'Image build cancellation was refused');
    }
    return response.build;
  }

  /** Retry one failed/canceled build as a new attempt in the same record. */
  async retryBuild(buildId: string): Promise<ImageBuildDescriptor> {
    const response = await this.requireConnection().request<ImageBuildRetryResponsePayload>(
      BUILD_RETRY_WIRE,
      { build_id: buildId },
    );
    if (!response.success || !response.build) {
      throw new Error(response.error ?? 'Image build retry was refused');
    }
    return response.build;
  }

  /** Every pushed durable build transition. */
  onBuildChanged(listener: (build: ImageBuildDescriptor) => void): () => void {
    this.buildListeners.add(listener);
    return () => {
      this.buildListeners.delete(listener);
    };
  }

  /** The connection state this plugin is bound to, or `null` when uninstalled. */
  connectionState(): ConnectionState | null {
    return this.connection?.connectionState ?? null;
  }

  /** Connection transitions, with the current state delivered on subscribe. */
  onConnectionStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    const current = this.connectionState();
    if (current !== null) {
      listener(current);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Read one complete-inventory page. */
  async listImages(
    options: { offset?: number; limit?: number; query?: string } = {},
  ): Promise<ImagePage> {
    const response = await this.requireConnection().request<ImageListResponsePayload>(
      LIST_WIRE,
      {
        offset: options.offset ?? 0,
        limit: options.limit ?? 50,
        query: options.query ?? '',
      },
    );
    if (response.error) {
      throw new Error(response.error);
    }
    return {
      images: response.images,
      total: response.total,
      next_offset: response.next_offset,
    };
  }

  async getImage(locator: { digest?: string; alias?: string }): Promise<ImageDescriptor> {
    const response = await this.requireConnection().request<ImageGetResponsePayload>(
      GET_WIRE,
      { ...locator },
    );
    if (!response.success || !response.image) {
      throw new Error(response.error ?? 'Image not found');
    }
    return response.image;
  }

  /**
   * Mint a scoped read grant. Exactly one consumer context is supplied: a
   * Project's durable reference or an existing Session's resolved context.
   */
  async accessImage(locator: {
    digest: string;
    projectId?: string;
    sessionId?: string;
  }): Promise<ImageAccessGrant> {
    const payload = locator.projectId
      ? { project_id: locator.projectId, digest: locator.digest }
      : { session_id: locator.sessionId, digest: locator.digest };
    const response = await this.requireConnection().request<ImageAccessResponsePayload>(
      ACCESS_WIRE,
      payload,
    );
    if (
      !response.success
      || !response.token
      || response.expires_at === null
      || response.expires_at === undefined
      || !response.path
    ) {
      throw new Error(response.error ?? 'Image access was refused');
    }
    return { token: response.token, expires_at: response.expires_at, path: response.path };
  }
}

export const imagesApi = new ImagesPlugin();
