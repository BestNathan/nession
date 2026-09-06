import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ContextMenuItem } from '@/components/ui/context-menu';
import { ExplorerNodeRenderer } from '@/explorer/renderers/ExplorerNodeRenderer';
import type { ExplorerNode } from '@/explorer/types';

const FILE_NODE: ExplorerNode = {
  id: 'src/main.ts',
  uri: 'src/main.ts',
  name: 'main.ts',
  kind: 'file',
  capabilities: { rename: true, delete: true, move: true },
  metadata: {
    size: 2048,
    modifiedAt: 1_700_000_000,
    isBinary: false,
    fullPath: '/workspace/src/main.ts',
  },
};

const DIR_NODE: ExplorerNode = {
  id: 'src',
  uri: 'src',
  name: 'src',
  kind: 'directory',
  capabilities: { rename: true, delete: true, createChild: true },
};

describe('ExplorerNodeRenderer', () => {
  it('renders file name, directory icon, and decoration badge', () => {
    render(
      <ExplorerNodeRenderer
        node={DIR_NODE}
        style={{ height: 24 }}
        decorations={{ icons: [], badge: 'MOCK' }}
        contextMenuItems={[]}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText('src')).toBeInTheDocument();
    expect(document.querySelector('.text-info')).toBeInTheDocument();
    expect(screen.getByText('MOCK')).toBeInTheDocument();
  });

  it('renders file row with name and metadata columns', () => {
    render(
      <ExplorerNodeRenderer
        node={FILE_NODE}
        style={{ height: 24 }}
        decorations={{ icons: [] }}
        contextMenuItems={[]}
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText('main.ts')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('shows context menu items on right-click', async () => {
    render(
      <ExplorerNodeRenderer
        node={FILE_NODE}
        style={{ height: 24 }}
        decorations={{ icons: [] }}
        contextMenuItems={[
          <ContextMenuItem key="mock-action" onClick={() => undefined}>
            Mock action
          </ContextMenuItem>,
        ]}
        onActivate={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText('main.ts'));

    expect(await screen.findByText('Mock action')).toBeInTheDocument();
  });
});
