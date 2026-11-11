import { describe, expect, it } from 'vitest';
import { createMockPluginSurface } from '@/test/mockPluginSurface';
import { SandboxPlugin } from '../../SandboxPlugin';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const images = [{ role: 'base' as const, digest: DIGEST, mode: 'read_only' as const }];

describe('SandboxPlugin image composition', () => {
  it('carries image selections on preflight and enter', async () => {
    const plugin = new SandboxPlugin();
    const surface = createMockPluginSurface();
    plugin.install(surface);

    const preflight = plugin.preflight({
      sessionId: 'a1:s1',
      generation: 'gen-1',
      probeGeneration: 'probe-1',
      policy: { version: 1, enabled: true, resource: [], syscall: [], enforcement: 'required' },
      images,
      workingDir: '/workspace',
    });
    expect(surface.requests[0]?.payload.images).toEqual(images);
    surface.resolveNext('server.session.sandbox.preflight', { ok: true });
    await preflight;

    const enter = plugin.enter({
      sessionId: 'a1:s1',
      generation: 'gen-1',
      probeGeneration: 'probe-1',
      enterId: 'enter-1',
      policy: { version: 1, enabled: true, resource: [], syscall: [], enforcement: 'required' },
      images,
      workingDir: '/workspace',
    });
    expect(surface.requests[0]?.payload.images).toEqual(images);
    surface.resolveNext('server.session.sandbox.enter', { success: true });
    await enter;
  });

  it('reads per-digest cache statuses through the authenticated context', async () => {
    const plugin = new SandboxPlugin();
    const surface = createMockPluginSurface();
    plugin.install(surface);
    const pending = plugin.imageCacheStatuses('a1:s1', [DIGEST]);
    expect(surface.requests[0]?.payload).toEqual({
      session_id: 'a1:s1',
      cache_digests: [DIGEST],
    });
    surface.resolveNext('server.session.sandbox.context', {
      success: true,
      cache_statuses: [{ digest: DIGEST, state: 'verified' }],
    });
    await expect(pending).resolves.toEqual([{ digest: DIGEST, state: 'verified' }]);
  });
});
