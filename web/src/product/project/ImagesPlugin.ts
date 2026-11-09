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

/** The scoped bearer grant a Project receives for one digest. */
export interface ImageAccessGrant {
  token: string;
  expires_at: number;
  path: string;
}

/**
 * Global EROFS Image Manager (#3022) — the typed Web projection of the four
 * `server.image.*` units.
 *
 * Images are a Server-owned global resource, not a Project type. A Project
 * references a digest; this plugin is how Web code builds, lists, reads and
 * obtains a scoped byte grant for that digest. There is no Web UI here: the
 * Project surface that consumes it is owned by #3025.
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

  async listImages(): Promise<ImageDescriptor[]> {
    const response = await this.requireConnection().request<ImageListResponsePayload>(
      LIST_WIRE,
      {},
    );
    if (response.error) {
      throw new Error(response.error);
    }
    return response.images;
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

  async accessImage(projectId: string, digest: string): Promise<ImageAccessGrant> {
    const response = await this.requireConnection().request<ImageAccessResponsePayload>(
      ACCESS_WIRE,
      { project_id: projectId, digest },
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
