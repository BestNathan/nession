import { describe, expect, it, vi } from 'vitest';

import { ExplorerStore, ROOT_ID } from '@/platform/explorer/ExplorerStore';
import type { ExplorerDataProvider } from '@/platform/explorer/providers/types';
import type { ExplorerNode } from '@/platform/explorer/types';

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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDeferredProvider(): {
  provider: ExplorerDataProvider;
  requests: Array<{ node: ExplorerNode | null; deferred: Deferred<ExplorerNode[]> }>;
} {
  const requests: Array<{ node: ExplorerNode | null; deferred: Deferred<ExplorerNode[]> }> = [];
  const loadChildren = vi.fn((node: ExplorerNode | null) => {
    const request = deferred<ExplorerNode[]>();
    requests.push({ node, deferred: request });
    return request.promise;
  });
  return { provider: { loadChildren }, requests };
}

async function createLoadedSrcStore(initialChildren: ExplorerNode[]) {
  const { provider, requests } = createDeferredProvider();
  const store = new ExplorerStore(provider);
  const rootLoad = store.ensureRootLoaded();
  requests[0].deferred.resolve([makeNode('src', 'directory')]);
  await rootLoad;

  store.expand('src');
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2);
  });
  requests[1].deferred.resolve(initialChildren);
  await vi.waitFor(() => {
    expect(store.getChildren('src')).toEqual(initialChildren.map((child) => child.id));
  });
  return { store, requests };
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

  it('commits only the newest load when responses resolve newest-first (#2864)', async () => {
    const keep = makeNode('src/keep.ts', 'file', 'src');
    const old = makeNode('src/old.ts', 'file', 'src');
    const newer = makeNode('src/newer.ts', 'file', 'src');
    const { store, requests } = await createLoadedSrcStore([keep, old]);
    store.setSelection(['src/keep.ts']);
    store.setActive('src/keep.ts');

    const staleRefresh = store.refresh('src');
    const currentRefresh = store.refresh('src');
    requests[3].deferred.resolve([keep, newer]);
    await currentRefresh;
    expect(store.getChildren('src')).toEqual(['src/keep.ts', 'src/newer.ts']);

    requests[2].deferred.resolve([keep, old]);
    await staleRefresh;
    expect(store.getChildren('src')).toEqual(['src/keep.ts', 'src/newer.ts']);
    expect(store.getFlatData()).toContainEqual({
      id: 'src',
      name: 'src',
      children: ['src/keep.ts', 'src/newer.ts'],
    });
    expect(store.getSnapshot().selectedIds).toEqual(new Set(['src/keep.ts']));
    expect(store.getSnapshot().activeId).toBe('src/keep.ts');

    // A stale failure cannot turn a newer success into an error or revert it.
    const staleFailureRefresh = store.refresh('src');
    const successfulRefresh = store.refresh('src');
    requests[5].deferred.resolve([keep, newer]);
    await successfulRefresh;
    requests[4].deferred.reject(new Error('stale response failed'));
    await staleFailureRefresh;
    expect(store.getChildren('src')).toEqual(['src/keep.ts', 'src/newer.ts']);
    expect(store.getFlatData()).toContainEqual({
      id: 'src',
      name: 'src',
      children: ['src/keep.ts', 'src/newer.ts'],
    });

    // A stale success cannot overwrite a newer failure's error state.
    const staleSuccessRefresh = store.refresh('src');
    const failingRefresh = store.refresh('src');
    requests[7].deferred.reject(new Error('current response failed'));
    await failingRefresh;
    expect(store.getFlatData()).toContainEqual({ id: 'src', name: 'src', children: true });

    requests[6].deferred.resolve([keep]);
    await staleSuccessRefresh;
    expect(store.getChildren('src')).toEqual(['src/keep.ts', 'src/newer.ts']);
    expect(store.getFlatData()).toContainEqual({ id: 'src', name: 'src', children: true });
  });

  it('replays create events over an older pending directory snapshot (#2864)', async () => {
    const old = makeNode('src/old.ts', 'file', 'src');
    const created = makeNode('src/new.ts', 'file', 'src');
    const { store, requests } = await createLoadedSrcStore([old]);

    const load = store.refresh('src');
    store.applyEvent({ type: 'create', parentId: 'src', node: created });
    expect(store.getChildren('src')).toEqual(['src/old.ts', 'src/new.ts']);

    requests[2].deferred.resolve([old]);
    await load;
    expect(store.getChildren('src')).toEqual(['src/old.ts', 'src/new.ts']);

    // The provider may already include the event in its response; replaying
    // the create must not duplicate the child.
    const overlappingLoad = store.refresh('src');
    store.applyEvent({ type: 'create', parentId: 'src', node: created });
    requests[3].deferred.resolve([old, created]);
    await overlappingLoad;
    expect(store.getChildren('src')).toEqual(['src/old.ts', 'src/new.ts']);
  });

  it('replays delete and rename events over an older pending directory snapshot (#2864)', async () => {
    const old = makeNode('src/old.ts', 'file', 'src');
    const keep = makeNode('src/keep.ts', 'file', 'src');
    const { store, requests } = await createLoadedSrcStore([old, keep]);
    store.setSelection(['src/keep.ts']);
    store.setActive('src/keep.ts');

    const deleteLoad = store.refresh('src');
    store.applyEvent({ type: 'delete', nodeId: 'src/keep.ts' });
    expect(store.getChildren('src')).toEqual(['src/old.ts']);
    requests[2].deferred.resolve([old, keep]);
    await deleteLoad;
    expect(store.getChildren('src')).toEqual(['src/old.ts']);
    expect(store.getFlatData().some((node) => node.id === 'src/keep.ts')).toBe(false);
    expect(store.getSnapshot().selectedIds.size).toBe(0);
    expect(store.getSnapshot().activeId).toBeNull();

    const renameLoad = store.refresh('src');
    store.applyEvent({
      type: 'rename',
      nodeId: 'src/old.ts',
      name: 'renamed.ts',
      newId: 'src/renamed.ts',
    });
    requests[3].deferred.resolve([old, keep]);
    await renameLoad;
    expect(store.getChildren('src')).toEqual(['src/renamed.ts', 'src/keep.ts']);
    expect(store.getFlatData().some((node) => node.id === 'src/old.ts')).toBe(false);
  });

  it('converges to a fresh provider snapshot after an overlapping event (#2864)', async () => {
    const old = makeNode('src/old.ts', 'file', 'src');
    const created = makeNode('src/new.ts', 'file', 'src');
    const fresh = makeNode('src/fresh.ts', 'file', 'src');
    const { store, requests } = await createLoadedSrcStore([old]);

    const overlappingLoad = store.refresh('src');
    store.applyEvent({ type: 'create', parentId: 'src', node: created });
    requests[2].deferred.resolve([old]);
    await overlappingLoad;
    expect(store.getChildren('src')).toEqual(['src/old.ts', 'src/new.ts']);

    const freshLoad = store.refresh('src');
    requests[3].deferred.resolve([fresh]);
    await freshLoad;
    expect(store.getChildren('src')).toEqual(['src/fresh.ts']);
  });

  it('settles a renamed directory instead of leaving its load pending (#2864)', async () => {
    const old = makeNode('src/old.ts', 'file', 'src');
    const { store, requests } = await createLoadedSrcStore([old]);

    const load = store.refresh('src');
    store.applyEvent({ type: 'rename', nodeId: 'src', name: 'source', newId: 'source' });
    requests[2].deferred.resolve([old]);
    await load;

    expect(store.getChildren('source')).toEqual(['src/old.ts']);
    expect(store.getFlatData()).toContainEqual({
      id: 'source',
      name: 'source',
      children: ['src/old.ts'],
    });
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
