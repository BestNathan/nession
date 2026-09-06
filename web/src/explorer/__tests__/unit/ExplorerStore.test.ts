import { describe, expect, it, vi } from 'vitest';

import { ExplorerStore, ROOT_ID } from '@/explorer/ExplorerStore';
import type { ExplorerDataProvider } from '@/explorer/providers/types';
import type { ExplorerNode } from '@/explorer/types';

function makeNode(
  id: string,
  kind: 'file' | 'directory',
  parentId?: string,
): ExplorerNode {
  return {
    id,
    uri: id,
    name: id.split('/').pop() ?? id,
    kind,
    parentId,
    capabilities: kind === 'directory' ? { createChild: true } : { move: true },
  };
}

function createMockProvider(
  tree: Record<string, ExplorerNode[]>,
): ExplorerDataProvider & { loadChildren: ReturnType<typeof vi.fn> } {
  const loadChildren = vi.fn(async (node: ExplorerNode | null) => {
    const key = node?.id ?? ROOT_ID;
    return tree[key] ?? [];
  });

  return { loadChildren };
}

describe('ExplorerStore', () => {
  it('ensureRootLoaded loads root via provider', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory'), makeNode('readme.md', 'file')],
    });
    const store = new ExplorerStore(provider);

    await store.ensureRootLoaded();

    expect(provider.loadChildren).toHaveBeenCalledWith(null);
    expect(store.getChildren(ROOT_ID)).toEqual(['src', 'readme.md']);
  });

  it('expand sets expanded and triggers lazy load when not loaded', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory')],
      src: [makeNode('src/main.ts', 'file')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    store.expand('src');
    await vi.waitFor(() => {
      expect(store.getChildren('src')).toEqual(['src/main.ts']);
    });

    expect(provider.loadChildren).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src', kind: 'directory' }),
    );
    expect(store.getSnapshot().expandedIds.has('src')).toBe(true);
  });

  it('collapse removes node from expanded set', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    store.expand('src');
    store.collapse('src');

    expect(store.getSnapshot().expandedIds.has('src')).toBe(false);
  });

  it('getChildren returns cached child ids', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('a', 'file'), makeNode('b', 'file')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    expect(store.getChildren(ROOT_ID)).toEqual(['a', 'b']);
  });

  it('refresh reloads a branch', async () => {
    const tree: Record<string, ExplorerNode[]> = {
      [ROOT_ID]: [makeNode('src', 'directory')],
      src: [makeNode('src/old.ts', 'file')],
    };
    const provider = createMockProvider(tree);
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();
    store.expand('src');
    await vi.waitFor(() => {
      expect(store.getChildren('src')).toEqual(['src/old.ts']);
    });

    tree.src = [makeNode('src/new.ts', 'file', 'src')];
    await store.refresh('src');

    expect(provider.loadChildren).toHaveBeenCalledTimes(3);
    expect(store.getChildren('src')).toEqual(['src/new.ts']);
    expect(store.getFlatData()).toEqual([
      { id: 'src', name: 'src', children: ['src/new.ts'] },
      { id: 'src/new.ts', name: 'new.ts', children: false },
    ]);
  });

  it('applyEvent delete removes node and prunes it from parent', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory'), makeNode('readme.md', 'file')],
      src: [makeNode('src/main.ts', 'file', 'src')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();
    store.expand('src');
    await vi.waitFor(() => {
      expect(store.getChildren('src')).toEqual(['src/main.ts']);
    });

    store.applyEvent({ type: 'delete', nodeId: 'src/main.ts' });

    expect(store.getChildren('src')).toEqual([]);
    expect(store.getFlatData().some((node) => node.id === 'src/main.ts')).toBe(false);
  });

  it('applyEvent create adds node under parent', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    store.applyEvent({
      type: 'create',
      parentId: 'src',
      node: makeNode('src/new.ts', 'file', 'src'),
    });

    expect(store.getChildren('src')).toEqual(['src/new.ts']);
    expect(store.getFlatData()).toContainEqual({
      id: 'src/new.ts',
      name: 'new.ts',
      children: false,
    });
  });

  it('applyEvent modify updates cached node', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('readme.md', 'file')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    store.applyEvent({
      type: 'modify',
      node: {
        ...makeNode('readme.md', 'file'),
        metadata: { size: 2048 },
      },
    });

    expect(store.getFlatData()).toContainEqual({
      id: 'readme.md',
      name: 'readme.md',
      children: false,
    });
  });

  it('applyEvent rename updates node name and id', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('old.txt', 'file')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();
    store.setSelection(['old.txt']);
    store.setActive('old.txt');

    store.applyEvent({
      type: 'rename',
      nodeId: 'old.txt',
      name: 'new.txt',
      newId: 'new.txt',
    });

    expect(store.getFlatData()).toContainEqual({
      id: 'new.txt',
      name: 'new.txt',
      children: false,
    });
    expect(store.getSnapshot().selectedIds.has('new.txt')).toBe(true);
    expect(store.getSnapshot().activeId).toBe('new.txt');
  });

  it('setSelection and setActive update snapshot state', () => {
    const store = new ExplorerStore(createMockProvider({}));

    store.setSelection(['a', 'b']);
    store.setActive('a');

    expect(store.getSnapshot().selectedIds).toEqual(new Set(['a', 'b']));
    expect(store.getSnapshot().activeId).toBe('a');
  });

  it('getFlatData returns react-arborist adapter rows', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('src', 'directory'), makeNode('readme.md', 'file')],
      src: [makeNode('src/main.ts', 'file', 'src')],
    });
    const store = new ExplorerStore(provider);
    await store.ensureRootLoaded();

    expect(store.getFlatData()).toEqual([
      { id: 'src', name: 'src', children: true },
      { id: 'readme.md', name: 'readme.md', children: false },
    ]);

    store.expand('src');
    await vi.waitFor(() => {
      expect(store.getFlatData()).toEqual([
        { id: 'src', name: 'src', children: ['src/main.ts'] },
        { id: 'readme.md', name: 'readme.md', children: false },
        { id: 'src/main.ts', name: 'main.ts', children: false },
      ]);
    });
  });

  it('subscribe notifies listeners on state changes', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('a', 'file')],
    });
    const store = new ExplorerStore(provider);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.ensureRootLoaded();

    expect(listener).toHaveBeenCalled();
  });
});
