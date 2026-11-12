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
import type { PluginSurface, TransportPlugin } from '@/platform/socket/types';

export type { ImageDescriptor, ImageSource };

/** One complete-inventory page returned by `server.image.list`. */
export interface ImagePage {
  images: ImageDescriptor[];
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
 * Server-owned global EROFS Image Manager (#3022, #3181) — the typed Web
 * projection of the four `server.image.*` units.
 *
 * Images are a Server resource, not a Project or Sandbox type. This transport
 * exposes the registry, the build request and a consumer-scoped byte grant.
 * Project selection and Sandbox composition each own their own UI and
 * reference model; they consume this registry through this one transport
 * boundary rather than re-implementing it.
 */
export class ImagesPlugin implements TransportPlugin {
  readonly name = 'images';

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
      throw new Error('Images transport is not connected');
    }
    return this.connection;
  }

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
