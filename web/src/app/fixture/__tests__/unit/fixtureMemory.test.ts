import { describe, expect, it } from 'vitest';
import { fixtureTranscriptsSurface } from '@/app/fixture/fixtureTranscripts';
import { FIXTURE_AGENTS } from '@/app/fixture/fixtureData';
import type { MemoryResponse } from '@/generated/protocol/claude-code/memory/v1';
import type { ReadResponseV1 } from '@/generated/protocol/claude-code/memory-read/v1';

/**
 * The fixture's Auto Memory half (#2689).
 *
 * A wire lives in two places — the manifest the agents advertise and the
 * surface that answers it — and `addressed()` resolves against the manifest
 * before a request is sent. Both are asserted here, as the conversation fixture
 * test does for its units.
 */
describe('fixture Auto Memory surface', () => {
  const surface = fixtureTranscriptsSurface('');

  it('advertises the memory wires it answers', () => {
    const advertised = Object.keys(FIXTURE_AGENTS[0]?.protocols?.protocols ?? {});
    expect(advertised).toContain('claude-code.memory');
    expect(advertised).toContain('claude-code.memory-read');
  });

  it('answers the index and a topic file by their reported relative paths', async () => {
    const memory = await surface.request<MemoryResponse>('claude-code.memory', {});
    expect(memory.state).toBe('ready');
    expect(memory.repository_root).toBe('/work/nession');
    expect(memory.repository_kind).toBe('git');
    expect(memory.files.map((file) => file.path)).toEqual([
      'MEMORY.md',
      'feedback_testing.md',
    ]);

    const index = await surface.request<ReadResponseV1>('claude-code.memory-read', {
      path: 'MEMORY.md',
    });
    expect('error' in index).toBe(false);
    if (!('error' in index)) {
      expect(index.content).toContain('# Memory');
      expect(index.content_type).toBe('markdown');
    }

    const unknown = await surface.request<ReadResponseV1>('claude-code.memory-read', {
      path: 'missing.md',
    });
    expect(unknown).toEqual({ error: 'not_found' });
  });

  it('models every provider state as its own input', async () => {
    for (const scenario of [
      'unavailable',
      'no_memory',
      'disabled',
      'unsupported_override',
      'error',
    ]) {
      const response = await fixtureTranscriptsSurface(`?memory=${scenario}`).request<MemoryResponse>(
        'claude-code.memory',
        {},
      );
      expect(response.state).toBe(scenario);
      expect(response.files).toEqual([]);
    }

    const missing = await fixtureTranscriptsSurface('?memory=no_memory').request<MemoryResponse>(
      'claude-code.memory',
      {},
    );
    expect(missing.memory_directory).toBe(
      '/home/fixture/.claude/projects/-work-scratch/memory',
    );
  });
});
