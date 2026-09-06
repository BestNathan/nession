import { describe, expect, it, beforeEach } from 'vitest';

import type { ExplorerExtension } from '@/explorer/commands/types';
import {
  getContextMenuContributions,
  getDecorationProviders,
  getExtensions,
  registerExtension,
  resetExplorerRegistry,
} from '@/explorer/registry';
import type { ExplorerNode } from '@/explorer/types';

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

beforeEach(() => {
  resetExplorerRegistry();
});

describe('explorer registry', () => {
  it('registerExtension and getExtensions return registered extensions', () => {
    const extA: ExplorerExtension = { id: 'ext-a' };
    const extB: ExplorerExtension = { id: 'ext-b' };

    registerExtension(extA);
    registerExtension(extB);

    expect(getExtensions()).toEqual([extA, extB]);
  });

  it('getDecorationProviders flattens providers from all extensions', () => {
    const providerA = { provide: () => ({ badge: 'A' }) };
    const providerB = { provide: () => ({ badge: 'B' }) };

    registerExtension({ id: 'one', decorations: [providerA] });
    registerExtension({ id: 'two', decorations: [providerB] });

    expect(getDecorationProviders()).toEqual([providerA, providerB]);
  });

  it('getContextMenuContributions filters by when predicate', () => {
    registerExtension({
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

    const fileMenus = getContextMenuContributions(FILE_NODE);
    expect(fileMenus.map((item) => item.id)).toEqual(['all-nodes', 'files-only']);

    const dirMenus = getContextMenuContributions(DIR_NODE);
    expect(dirMenus.map((item) => item.id)).toEqual(['all-nodes', 'dirs-only']);
  });
});
