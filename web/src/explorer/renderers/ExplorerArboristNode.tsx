import type { NodeRendererProps } from 'react-arborist';

import type { ArboristNode } from '../adapters/arboristAdapter';
import type { ExplorerContextMenuContext } from '../commands/types';
import { resolveDecorations } from '../decorations/resolveDecorations';
import type { ExplorerStore } from '../ExplorerStore';
import { getContextMenuContributions, getDecorationProviders } from '../registry';
import type { ExplorerNode } from '../types';

import { ExplorerNodeRenderer } from './ExplorerNodeRenderer';

export interface ExplorerArboristNodeProps {
  nodeProps: NodeRendererProps<ArboristNode>;
  store: ExplorerStore;
  menuContext: ExplorerContextMenuContext;
  renamingId: string | null;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: (node: ExplorerNode) => void;
  onRenameCancel: () => void;
  onFileActivate: (node: ExplorerNode) => void;
}

export function ExplorerArboristNode({
  nodeProps,
  store,
  menuContext,
  renamingId,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onFileActivate,
}: ExplorerArboristNodeProps) {
  const { node, style, dragHandle } = nodeProps;
  const explorerNode = store.getNode(node.id);
  if (!explorerNode) {
    return null;
  }

  const decorations = resolveDecorations(explorerNode, getDecorationProviders());
  const contextMenuItems = getContextMenuContributions(explorerNode).map((contribution) =>
    contribution.render(explorerNode, menuContext),
  );

  return (
    <ExplorerNodeRenderer
      node={explorerNode}
      style={style}
      dragHandle={dragHandle}
      decorations={decorations}
      contextMenuItems={contextMenuItems}
      isRenaming={renamingId === node.id}
      renameValue={renameValue}
      onRenameChange={onRenameChange}
      onRenameSubmit={() => {
        void onRenameSubmit(explorerNode);
      }}
      onRenameCancel={onRenameCancel}
      onActivate={() => {
        if (explorerNode.kind === 'directory') {
          node.toggle();
          return;
        }
        store.setActive(explorerNode.id);
        onFileActivate(explorerNode);
      }}
    />
  );
}
