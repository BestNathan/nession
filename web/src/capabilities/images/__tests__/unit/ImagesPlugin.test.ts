import { beforeEach, describe, expect, it } from 'vitest';
import { ImagesPlugin } from '../../ImagesPlugin';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = {
  image_id: 'image-123e4567-e89b-42d3-a456-426614174000',
  digest: DIGEST,
  size_bytes: 12,
  source: { kind: 'local_directory' as const, path: '/var/lib/nession/base' },
  packaging: {
    compression: 'none',
    block_size: 4096,
    fixed_timestamp: 0,
    fixed_uuid: '11111111-1111-4111-8111-111111111111',
  },
  status: 'ready' as const,
  aliases: [],
  created_at: 1,
  updated_at: 2,
};

describe('ImagesPlugin', () => {
  let plugin: ImagesPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new ImagesPlugin();
    surface = createMockPluginSurface();
  });

  it('names its transport "images"', () => {
    expect(plugin.name).toBe('images');
  });

  it('refuses to request before a transport is installed', async () => {
    await expect(plugin.listImages()).rejects.toThrow('not connected');
  });

  it('builds through server.image.build and returns the descriptor', async () => {
    plugin.install(surface);
    const pending = plugin.buildImage(
      { kind: 'local_directory', path: '/var/lib/nession/base' },
      'latest',
    );
    expect(surface.requests[0].type).toBe('server.image.build');
    expect(surface.requests[0].payload).toEqual({
      source: { kind: 'local_directory', path: '/var/lib/nession/base' },
      alias: 'latest',
    });
    surface.resolveNext('server.image.build', { success: true, image: IMAGE });
    await expect(pending).resolves.toEqual(IMAGE);
  });

  it('lists one complete-inventory page through server.image.list', async () => {
    plugin.install(surface);
    const pending = plugin.listImages({ offset: 50, limit: 50, query: 'node' });
    expect(surface.requests[0].type).toBe('server.image.list');
    expect(surface.requests[0].payload).toEqual({ offset: 50, limit: 50, query: 'node' });
    surface.resolveNext('server.image.list', {
      images: [IMAGE],
      total: 235,
      next_offset: 100,
    });
    await expect(pending).resolves.toEqual({
      images: [IMAGE],
      total: 235,
      next_offset: 100,
    });
  });

  it('surfaces a refused registry read', async () => {
    plugin.install(surface);
    const pending = plugin.listImages();
    surface.resolveNext('server.image.list', {
      images: [],
      total: 0,
      error: 'Images could not be loaded',
    });
    await expect(pending).rejects.toThrow('Images could not be loaded');
  });

  it('reads by alias through server.image.get', async () => {
    plugin.install(surface);
    const pending = plugin.getImage({ alias: 'latest' });
    expect(surface.requests[0].type).toBe('server.image.get');
    surface.resolveNext('server.image.get', { success: true, image: IMAGE });
    await expect(pending).resolves.toEqual(IMAGE);
  });

  it('obtains a Project-scoped grant through server.image.access', async () => {
    plugin.install(surface);
    const pending = plugin.accessImage({
      projectId: 'project-123e4567-e89b-42d3-a456-426614174000',
      digest: DIGEST,
    });
    expect(surface.requests[0].type).toBe('server.image.access');
    expect(surface.requests[0].payload).toEqual({
      project_id: 'project-123e4567-e89b-42d3-a456-426614174000',
      digest: DIGEST,
    });
    surface.resolveNext('server.image.access', {
      success: true,
      token: 'token',
      expires_at: 100,
      path: `/images/blobs/${DIGEST}`,
    });
    await expect(pending).resolves.toEqual({
      token: 'token',
      expires_at: 100,
      path: `/images/blobs/${DIGEST}`,
    });
  });

  it('obtains a Session-scoped grant for an allowed digest', async () => {
    plugin.install(surface);
    const pending = plugin.accessImage({ sessionId: 'a1:s1', digest: DIGEST });
    expect(surface.requests[0].payload).toEqual({ session_id: 'a1:s1', digest: DIGEST });
    surface.resolveNext('server.image.access', {
      success: true,
      token: 'session-token',
      expires_at: 100,
      path: `/images/blobs/${DIGEST}`,
    });
    await expect(pending).resolves.toMatchObject({ token: 'session-token' });
  });

  it('surfaces a foreign-Project grant refusal', async () => {
    plugin.install(surface);
    const pending = plugin.accessImage({
      projectId: 'project-123e4567-e89b-42d3-a456-426614174000',
      digest: DIGEST,
    });
    surface.resolveNext('server.image.access', {
      success: false,
      error: 'Project does not reference this image',
      error_kind: 'forbidden',
    });
    await expect(pending).rejects.toThrow('Project does not reference this image');
  });
});
