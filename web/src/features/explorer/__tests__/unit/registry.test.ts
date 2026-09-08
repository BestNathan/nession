import { describe, expect, it, vi } from 'vitest';

import type { ExplorerExtension } from '@/features/explorer/commands/types';
import { ExplorerRegistry } from '@/features/explorer/registry';
import type { ExplorerNode } from '@/features/explorer/types';

const FILE_NODE: ExplorerNode = {
  id: 'readme.md',
  uri: 'readme.md',
  name: 'readme.md',
  kind: 'file',
  capabilities: { rename: true, delete: true, move: true },
};

const DIR_NODE: ExplorerNode = {
  id: 'src',
  uri: 'src',
  name: 'src',
  kind: 'directory',
  capabilities: { rename: true, delete: true, createChild: true },
};

describe('ExplorerRegistry', () => {
  it('register and getExtensions return registered extensions', () => {
    const registry = new ExplorerRegistry();
    const extA: ExplorerExtension = { id: 'ext-a' };
    const extB: ExplorerExtension = { id: 'ext-b' };

    registry.register(extA);
    registry.register(extB);

    expect(registry.getExtensions()).toEqual([extA, extB]);
  });

  it('throws when the same extension id is registered twice', () => {
    const registry = new ExplorerRegistry();

    registry.register({ id: 'dup' });

    expect(() => registry.register({ id: 'dup' })).toThrow(/already registered/);
  });

  it('unregister removes an extension and tolerates unknown ids', () => {
    const registry = new ExplorerRegistry();

    registry.register({ id: 'ext-a' });
    registry.unregister('ext-a');
    registry.unregister('ext-a');

    expect(registry.getExtensions()).toEqual([]);
  });

  it('bumps version and notifies subscribers on register/unregister', () => {
    const registry = new ExplorerRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.register({ id: 'ext-a' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getVersion()).toBe(1);

    registry.unregister('ext-a');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getVersion()).toBe(2);

    unsubscribe();
    registry.register({ id: 'ext-b' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.getVersion()).toBe(3);
  });

  it('getDecorationProviders flattens providers from all extensions', () => {
    const registry = new ExplorerRegistry();
    const providerA = { provide: () => ({ badge: 'A' }) };
    const providerB = { provide: () => ({ badge: 'B' }) };

    registry.register({ id: 'one', decorations: [providerA] });
    registry.register({ id: 'two', decorations: [providerB] });

    expect(registry.getDecorationProviders()).toEqual([providerA, providerB]);
  });

  it('getContextMenuContributions filters by when predicate', () => {
    const registry = new ExplorerRegistry();

    registry.register({
      id: 'menus',
      contextMenus: [
        {
          id: 'all-nodes',
          render: () => null,
        },
        {
          id: 'files-only',
          when: (node) => node.kind === 'file',
          render: () => null,
        },
        {
          id: 'dirs-only',
          when: (node) => node.kind === 'directory',
          render: () => null,
        },
      ],
    });

    const fileMenus = registry.getContextMenuContributions(FILE_NODE);
    expect(fileMenus.map((item) => item.id)).toEqual(['all-nodes', 'files-only']);

    const dirMenus = registry.getContextMenuContributions(DIR_NODE);
    expect(dirMenus.map((item) => item.id)).toEqual(['all-nodes', 'dirs-only']);
  });
});
