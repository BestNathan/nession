import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { Explorer } from '@/platform/explorer/Explorer';
import { ROOT_ID } from '@/platform/explorer/ExplorerStore';
import type { ExplorerExtension } from '@/platform/explorer/commands/types';
import type { ExplorerDataProvider } from '@/platform/explorer/providers/types';
import { mockExplorerExtension } from '@/platform/explorer/testing/mockExtension';
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
    capabilities:
      kind === 'directory'
        ? { rename: true, delete: true, createChild: true }
        : { rename: true, delete: true, move: true },
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

describe('Explorer integration', () => {
  it('renders tree with mock provider and loads children when expanding a folder once', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory'), makeNode('root/b', 'directory')],
      'root/a': [
        makeNode('root/a/file.txt', 'file', 'root/a'),
        makeNode('root/a/test-file.txt', 'file', 'root/a'),
      ],
      'root/b': [],
    });

    render(
      <div style={{ height: 400 }}>
        <Explorer
          provider={provider}
          extensions={[mockExplorerExtension]}
          onFileActivate={vi.fn()}
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });
    expect(provider.loadChildren).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('root'));

    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
      expect(screen.getByText('b')).toBeInTheDocument();
    });
    expect(provider.loadChildren).toHaveBeenCalledTimes(2);
    expect(provider.loadChildren).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'root', kind: 'directory' }),
    );

    fireEvent.click(screen.getByText('root'));
    fireEvent.click(screen.getByText('root'));

    expect(provider.loadChildren).toHaveBeenCalledTimes(2);
  });

  it('calls onFileActivate when clicking a file', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/file.txt', 'file', 'root/a')],
    });
    const onFileActivate = vi.fn();

    render(
      <div style={{ height: 400 }}>
        <Explorer provider={provider} extensions={[]} onFileActivate={onFileActivate} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('file.txt'));

    expect(onFileActivate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'root/a/file.txt', kind: 'file' }),
    );
  });

  it('shows mock extension badge on test-file.txt', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/test-file.txt', 'file', 'root/a')],
    });

    render(
      <div style={{ height: 400 }}>
        <Explorer
          provider={provider}
          extensions={[mockExplorerExtension]}
          onFileActivate={vi.fn()}
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('test-file.txt')).toBeInTheDocument();
      expect(screen.getByText('MOCK')).toBeInTheDocument();
    });
  });

  it('includes mock extension context menu item on files', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/file.txt', 'file', 'root/a')],
    });

    render(
      <div style={{ height: 400 }}>
        <Explorer
          provider={provider}
          extensions={[mockExplorerExtension]}
          onFileActivate={vi.fn()}
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByText('file.txt'));

    expect(await screen.findByText('Mock action')).toBeInTheDocument();
  });

  it('re-resolves decorations incrementally when extensions change without remounting', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/file.txt', 'file', 'root/a')],
    });
    const extA: ExplorerExtension = {
      id: 'deco-a',
      decorations: [
        {
          provide: (node) => (node.kind === 'file' ? { badge: 'A' } : undefined),
        },
      ],
    };
    const extB: ExplorerExtension = {
      id: 'deco-b',
      decorations: [
        {
          provide: (node) => (node.kind === 'file' ? { badge: 'B' } : undefined),
        },
      ],
    };
    const onFileActivate = vi.fn();

    const { rerender } = render(
      <div style={{ height: 400 }}>
        <Explorer provider={provider} extensions={[extA]} onFileActivate={onFileActivate} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
      expect(screen.getByText('A')).toBeInTheDocument();
    });
    const loadsBefore = provider.loadChildren.mock.calls.length;

    rerender(
      <div style={{ height: 400 }}>
        <Explorer provider={provider} extensions={[extB]} onFileActivate={onFileActivate} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('B')).toBeInTheDocument();
    });
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    // The tree was not remounted: replacing the extension did not reload
    // already-loaded children through the provider.
    expect(provider.loadChildren.mock.calls.length).toBe(loadsBefore);
  });

  it('renders a disclosure caret and one selected-row surface', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/file.txt', 'file', 'root/a')],
    });

    render(
      <div style={{ height: 400 }}>
        <Explorer provider={provider} extensions={[]} onFileActivate={vi.fn()} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });

    const treeitem = (label: string) =>
      screen.getByText(label).closest('[role="treeitem"]') as HTMLElement;
    const trigger = (label: string) =>
      treeitem(label).querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;

    // The caret is the disclosure control. It expands without selecting the
    // row, and does not change the browse path or activate the directory.
    const caretFor = (label: string) => within(treeitem(label)).getByTestId('explorer-caret');
    expect(caretFor('root')).toHaveAttribute('aria-label', 'Expand folder');
    fireEvent.click(caretFor('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });
    expect(treeitem('root')).toHaveAttribute('aria-expanded', 'true');
    expect(treeitem('root')).toHaveAttribute('aria-selected', 'false');
    expect(trigger('root')).toHaveAttribute('data-selected', 'false');
    expect(within(treeitem('root')).getByTestId('explorer-caret')).toHaveAttribute(
      'aria-label',
      'Collapse folder',
    );

    // Activating a directory selects it and shows the one selection cue: the
    // row surface. Expansion is not a second visual state on the row.
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });
    expect(treeitem('a')).toHaveAttribute('aria-selected', 'true');
    expect(trigger('a')).toHaveAttribute('data-selected', 'true');
    expect(trigger('a').className.split(/\s+/)).toContain('bg-muted');

    // A file has no caret; selecting it moves the surface off its parent.
    expect(within(treeitem('file.txt')).queryByTestId('explorer-caret')).toBeNull();
    fireEvent.click(screen.getByText('file.txt'));
    await waitFor(() => {
      expect(treeitem('file.txt')).toHaveAttribute('aria-selected', 'true');
    });
    expect(trigger('file.txt').className.split(/\s+/)).toContain('bg-muted');
    expect(treeitem('a')).toHaveAttribute('aria-selected', 'false');
    expect(trigger('a').className.split(/\s+/)).not.toContain('bg-muted');

    // Expanding/collapsing a folder does not steal the selection. Collapsing
    // root hides the open file, so re-expand it through the caret first.
    fireEvent.click(caretFor('root'));
    await waitFor(() => {
      expect(treeitem('root')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('file.txt')).not.toBeInTheDocument();
    });
    fireEvent.click(caretFor('root'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });
    expect(treeitem('file.txt')).toHaveAttribute('aria-selected', 'true');
    expect(trigger('file.txt').className.split(/\s+/)).toContain('bg-muted');
  });

  it('keeps a folder collapsed after a file inside it was opened', async () => {
    const provider = createMockProvider({
      [ROOT_ID]: [makeNode('root', 'directory')],
      root: [makeNode('root/a', 'directory')],
      'root/a': [makeNode('root/a/file.txt', 'file', 'root/a')],
    });

    render(
      <div style={{ height: 400 }}>
        <Explorer provider={provider} extensions={[]} onFileActivate={vi.fn()} />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByText('root')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('root'));
    await waitFor(() => {
      expect(screen.getByText('a')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.getByText('file.txt')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('file.txt'));

    // Opening the file is not a standing reveal request: collapsing its parent
    // must stay collapsed instead of being undone by the file's path.
    fireEvent.click(screen.getByText('a'));
    await waitFor(() => {
      expect(screen.queryByText('file.txt')).not.toBeInTheDocument();
    });
    expect(screen.getByText('a').closest('[role="treeitem"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
