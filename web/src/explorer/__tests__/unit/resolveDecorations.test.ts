import { describe, expect, it } from 'vitest';

import { resolveDecorations } from '@/explorer/decorations/resolveDecorations';
import type { ExplorerDecorationProvider } from '@/explorer/decorations/types';
import type { ExplorerNode } from '@/explorer/types';

const FILE_NODE: ExplorerNode = {
  id: 'src/main.ts',
  uri: 'src/main.ts',
  name: 'main.ts',
  kind: 'file',
  capabilities: { rename: true, delete: true, move: true },
};

function provider(
  provide: ExplorerDecorationProvider['provide'],
): ExplorerDecorationProvider {
  return { provide };
}

describe('resolveDecorations', () => {
  it('returns empty icons when no providers match', () => {
    const result = resolveDecorations(FILE_NODE, [
      provider(() => undefined),
    ]);

    expect(result).toEqual({ icons: [] });
  });

  it('higher priority wins for badge and className', () => {
    const result = resolveDecorations(FILE_NODE, [
      provider(() => ({
        badge: 'LOW',
        className: 'text-low',
        priority: 1,
      })),
      provider(() => ({
        badge: 'HIGH',
        className: 'text-high',
        priority: 10,
      })),
      provider(() => ({
        badge: 'MID',
        className: 'text-mid',
        priority: 5,
      })),
    ]);

    expect(result.badge).toBe('HIGH');
    expect(result.className).toBe('text-high');
  });

  it('concatenates icons from all providers', () => {
    const iconA = 'icon-a';
    const iconB = 'icon-b';
    const iconC = 'icon-c';

    const result = resolveDecorations(FILE_NODE, [
      provider(() => ({ icon: iconA, priority: 1 })),
      provider(() => ({ icon: iconB, priority: 10 })),
      provider(() => ({ icon: iconC, priority: 5 })),
    ]);

    expect(result.icons).toEqual([iconA, iconB, iconC]);
  });

  it('picks highest-priority tooltip when multiple are present', () => {
    const result = resolveDecorations(FILE_NODE, [
      provider(() => ({ tooltip: 'low tooltip', priority: 1 })),
      provider(() => ({ tooltip: 'high tooltip', priority: 10 })),
    ]);

    expect(result.tooltip).toBe('high tooltip');
  });

  it('falls through to next priority when highest lacks a field', () => {
    const result = resolveDecorations(FILE_NODE, [
      provider(() => ({ priority: 10, icon: 'only-icon' })),
      provider(() => ({ badge: 'FALLBACK', priority: 5 })),
    ]);

    expect(result.badge).toBe('FALLBACK');
    expect(result.icons).toEqual(['only-icon']);
  });
});
