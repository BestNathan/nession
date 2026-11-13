import { describe, expect, it } from 'vitest';
import { fixtureImagesSurface } from '../../fixtureImages';

describe('fixture Images surfaces', () => {
  it('returns a complete-inventory page and filters by query', async () => {
    const surface = fixtureImagesSurface('');
    const first = await surface.request<{
      images: { image_id: string }[];
      total: number;
      next_offset?: number;
    }>('server.image.list', { offset: 0, limit: 50, query: '' });
    expect(first.total).toBe(235);
    expect(first.images).toHaveLength(50);
    expect(first.next_offset).toBe(50);
    const filtered = await surface.request<{ images: { image_id: string }[]; total: number }>(
      'server.image.list',
      { offset: 0, limit: 50, query: 'fixture-image-234' },
    );
    expect(filtered.total).toBe(1);
    expect(filtered.images[0].image_id).toBe('image-fixture-234');
  });

  it('submits a durable asynchronous build and reports its stage', async () => {
    const surface = fixtureImagesSurface('?images=lifecycle');
    const submitted = await surface.request<{
      success: boolean;
      build: { build_id: string; status: string; stage: string; progress: { files: number } };
    }>('server.image.build.submit', {
      source: {
        kind: 'github',
        repository_url: 'https://github.com/BestNathan/nession',
        ref: 'main',
      },
      alias: 'fixture-new-build',
    });
    expect(submitted.success).toBe(true);
    expect(submitted.build.status).toBe('running');
    expect(submitted.build.stage).toBe('packaging');
    expect(submitted.build.progress.files).toBeGreaterThan(0);

    const page = await surface.request<{
      builds: { build_id: string }[];
      total: number;
    }>('server.image.build.list', { offset: 0, limit: 50 });
    expect(page.builds[0].build_id).toBe(submitted.build.build_id);
    expect(page.total).toBeGreaterThanOrEqual(5);

    const read = await surface.request<{ success: boolean; build: { build_id: string } }>(
      'server.image.build.get',
      { build_id: submitted.build.build_id },
    );
    expect(read.success).toBe(true);

    const canceled = await surface.request<{
      success: boolean;
      build: { status: string };
    }>('server.image.build.cancel', { build_id: submitted.build.build_id });
    expect(canceled.build.status).toBe('canceled');
  });

  it('serves the lifecycle fixture with running, failed and succeeded builds', async () => {
    const surface = fixtureImagesSurface('?images=lifecycle');
    const page = await surface.request<{
      builds: { build_id: string; status: string; stage?: string }[];
      total: number;
    }>('server.image.build.list', { offset: 0, limit: 50 });
    expect(page.total).toBeGreaterThanOrEqual(4);
    for (const [buildId, status] of [
      ['build-fixture-running', 'running'],
      ['build-fixture-failed', 'failed'],
      ['build-fixture-canceled', 'canceled'],
      ['build-fixture-succeeded', 'succeeded'],
    ]) {
      expect(
        page.builds.some((build) => build.build_id === buildId && build.status === status),
        buildId,
      ).toBe(true);
    }
  });

  it('models an explicit build failure without changing any reference', async () => {
    const surface = fixtureImagesSurface('?images=buildfail');
    const result = await surface.request<{ success: boolean; error?: string }>(
      'server.image.build',
      {
        source: {
          kind: 'github',
          repository_url: 'https://github.com/BestNathan/nession',
          ref: 'main',
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('could not be packaged');
  });
});
