import { beforeEach, describe, expect, it } from 'vitest';

import { createCoreExplorerExtension } from '@/explorer/commands/coreContributions';
import type { ExplorerContextMenuContribution } from '@/explorer/commands/types';
import {
  getContextMenuContributions,
  registerExtension,
  resetExplorerRegistry,
} from '@/explorer/registry';
import type { ExplorerNode } from '@/explorer/types';

const CORE_MENU_IDS = [
  'core.copy-path',
  'core.copy-full-path',
  'core.rename',
  'core.separator-before-delete',
  'core.delete',
] as const;

const FILE_NODE: ExplorerNode = {
  id: 'docs/readme.txt',
  uri: 'docs/readme.txt',
  name: 'readme.txt',
  kind: 'file',
  capabilities: { rename: true, delete: true, move: true },
  metadata: { fullPath: '/workspace/docs/readme.txt' },
};

const READ_ONLY_FILE: ExplorerNode = {
  id: 'locked.txt',
  uri: 'locked.txt',
  name: 'locked.txt',
  kind: 'file',
  capabilities: {},
};

const FILE_WITHOUT_FULL_PATH: ExplorerNode = {
  ...FILE_NODE,
  metadata: { size: 100 },
};

function findContribution(id: string): ExplorerContextMenuContribution | undefined {
  return createCoreExplorerExtension().contextMenus?.find((item) => item.id === id);
}

function matchesWhen(id: string, node: ExplorerNode): boolean {
  const contribution = findContribution(id);
  if (!contribution) {
    return false;
  }
  return contribution.when === undefined || contribution.when(node);
}

beforeEach(() => {
  resetExplorerRegistry();
  registerExtension(createCoreExplorerExtension());
});

describe('createCoreExplorerExtension', () => {
  it('returns an extension with id core', () => {
    expect(createCoreExplorerExtension().id).toBe('core');
  });

  it('registers the expected context menu contribution ids', () => {
    const ids = createCoreExplorerExtension().contextMenus?.map((item) => item.id);

    expect(ids).toEqual([...CORE_MENU_IDS]);
  });

  it('filters contributions by when predicates via registry', () => {
    const menus = getContextMenuContributions(READ_ONLY_FILE);

    expect(menus.map((item) => item.id)).toEqual(['core.copy-path']);
  });

  it('includes rename and delete when capabilities allow', () => {
    const menus = getContextMenuContributions(FILE_NODE);

    expect(menus.map((item) => item.id)).toEqual([...CORE_MENU_IDS]);
  });

  describe('when predicates', () => {
    it('copy-path is always visible', () => {
      expect(matchesWhen('core.copy-path', READ_ONLY_FILE)).toBe(true);
      expect(matchesWhen('core.copy-path', FILE_NODE)).toBe(true);
    });

    it('copy-full-path requires metadata.fullPath', () => {
      expect(matchesWhen('core.copy-full-path', FILE_NODE)).toBe(true);
      expect(matchesWhen('core.copy-full-path', FILE_WITHOUT_FULL_PATH)).toBe(false);
    });

    it('rename requires capabilities.rename', () => {
      expect(matchesWhen('core.rename', FILE_NODE)).toBe(true);
      expect(matchesWhen('core.rename', READ_ONLY_FILE)).toBe(false);
    });

    it('delete and separator require capabilities.delete', () => {
      expect(matchesWhen('core.delete', FILE_NODE)).toBe(true);
      expect(matchesWhen('core.separator-before-delete', FILE_NODE)).toBe(true);
      expect(matchesWhen('core.delete', READ_ONLY_FILE)).toBe(false);
      expect(matchesWhen('core.separator-before-delete', READ_ONLY_FILE)).toBe(false);
    });
  });
});
