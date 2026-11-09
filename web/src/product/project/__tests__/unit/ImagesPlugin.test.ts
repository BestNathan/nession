import { beforeEach, describe, expect, it } from 'vitest';
import { ImagesPlugin } from '@/product/project/ImagesPlugin';
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

  it('lists through server.image.list and surfaces a refused read', async () => {
    plugin.install(surface);
    const pending = plugin.listImages();
    expect(surface.requests[0].type).toBe('server.image.list');
    surface.resolveNext('server.image.list', {
      images: [],
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
    const pending = plugin.accessImage('project-123e4567-e89b-42d3-a456-426614174000', DIGEST);
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

  it('surfaces a foreign-Project grant refusal', async () => {
    plugin.install(surface);
    const pending = plugin.accessImage('project-123e4567-e89b-42d3-a456-426614174000', DIGEST);
    surface.resolveNext('server.image.access', {
      success: false,
      error: 'Project does not reference this image',
      error_kind: 'forbidden',
    });
    await expect(pending).rejects.toThrow('Project does not reference this image');
  });
});
