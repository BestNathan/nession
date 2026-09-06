import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Explorer } from '@/explorer/Explorer';
import { ROOT_ID } from '@/explorer/ExplorerStore';
import { resetExplorerRegistry } from '@/explorer/registry';
import { mockExplorerExtension } from '@/explorer/testing/mockExtension';
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
  beforeEach(() => {
    resetExplorerRegistry();
  });

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
});
