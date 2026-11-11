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
