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

const BUILD = {
  build_id: 'build-123e4567-e89b-42d3-a456-426614174000',
  image_id: 'image-123e4567-e89b-42d3-a456-426614174000',
  attempt: 1,
  source: { kind: 'github' as const, repository_url: 'https://github.com/BestNathan/nession', ref: 'main' },
  packaging: {
    compression: 'none',
    block_size: 4096,
    fixed_timestamp: 0,
    fixed_uuid: '11111111-1111-4111-8111-111111111111',
  },
  status: 'running' as const,
  stage: 'packaging' as const,
  progress: { files: 12, bytes: 4096, elapsed_ms: 1200 },
  size_bytes: 0,
  deduplicated: false,
  alias: 'latest',
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

  it('submits the asynchronous durable build unit', async () => {
    plugin.install(surface);
    const pending = plugin.submitBuild(
      { kind: 'github', repository_url: 'https://github.com/BestNathan/nession', ref: 'main' },
      { alias: 'latest', clientRequestId: 'project-build-1' },
    );
    expect(surface.requests[0].type).toBe('server.image.build.submit');
    expect(surface.requests[0].payload).toEqual({
      source: {
        kind: 'github',
        repository_url: 'https://github.com/BestNathan/nession',
        ref: 'main',
      },
      alias: 'latest',
      client_request_id: 'project-build-1',
    });
    surface.resolveNext('server.image.build.submit', { success: true, build: BUILD });
    await expect(pending).resolves.toEqual(BUILD);
  });

  it('reads, cancels and retries durable build records', async () => {
    plugin.install(surface);
    const read = plugin.getBuild(BUILD.build_id);
    expect(surface.requests[0].type).toBe('server.image.build.get');
    expect(surface.requests[0].payload).toEqual({ build_id: BUILD.build_id });
    surface.resolveNext('server.image.build.get', { success: true, build: BUILD });
    await expect(read).resolves.toEqual(BUILD);

    const page = plugin.listBuilds({ offset: 0, limit: 10 });
    expect(surface.requests[0].type).toBe('server.image.build.list');
    surface.resolveNext('server.image.build.list', { builds: [BUILD], total: 1 });
    await expect(page).resolves.toEqual({ builds: [BUILD], total: 1, next_offset: undefined });

    const canceled = plugin.cancelBuild(BUILD.build_id);
    expect(surface.requests[0].type).toBe('server.image.build.cancel');
    surface.resolveNext('server.image.build.cancel', {
      success: true,
      build: { ...BUILD, status: 'canceled', stage: null },
    });
    await expect(canceled).resolves.toMatchObject({ status: 'canceled' });

    const retried = plugin.retryBuild(BUILD.build_id);
    expect(surface.requests[0].type).toBe('server.image.build.retry');
    surface.resolveNext('server.image.build.retry', {
      success: true,
      build: { ...BUILD, attempt: 2 },
    });
    await expect(retried).resolves.toMatchObject({ attempt: 2 });
  });

  it('delivers pushed build transitions and connection state', () => {
    plugin.install(surface);
    const builds: string[] = [];
    const states: string[] = [];
    const offBuild = plugin.onBuildChanged((build) => builds.push(build.build_id));
    const offState = plugin.onConnectionStateChange((state) => states.push(state));
    surface.pushMessage('server.image.build.updated', { build: BUILD });
    surface.setConnectionState('reconnecting');
    surface.setConnectionState('connected');
    expect(builds).toEqual([BUILD.build_id]);
    expect(states).toEqual(['connected', 'reconnecting', 'connected']);
    offBuild();
    offState();
    surface.pushMessage('server.image.build.updated', { build: BUILD });
    expect(builds).toEqual([BUILD.build_id]);
  });

});
