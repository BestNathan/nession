import { useContext } from 'react';
import type { NodeRendererProps } from 'react-arborist';

import type { ArboristNode } from '../adapters/arboristAdapter';
import type { ExplorerContextMenuContext } from '../commands/types';
import { resolveDecorations } from '../decorations/resolveDecorations';
import type { ExplorerStore } from '../ExplorerStore';
import { ExplorerRegistryContext } from '../ExplorerRegistryContext';
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
  onFileActivate: (node: ExplorerNode) => boolean | void;
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
  const registry = useContext(ExplorerRegistryContext);
  const explorerNode = store.getNode(node.id);
  if (!explorerNode) {
    return null;
  }

  const decorations = resolveDecorations(
    explorerNode,
    registry?.getDecorationProviders() ?? [],
  );
  const contextMenuItems = (registry?.getContextMenuContributions(explorerNode) ?? []).map(
    (contribution) => contribution.render(explorerNode, menuContext),
  );

  return (
    <ExplorerNodeRenderer
      node={explorerNode}
      style={style}
      dragHandle={dragHandle}
      decorations={decorations}
      contextMenuItems={contextMenuItems}
      isRenaming={renamingId === node.id}
      isSelected={node.isSelected}
      isOpen={node.isOpen}
      isLeaf={node.isLeaf}
      onToggle={() => node.toggle()}
      renameValue={renameValue}
      onRenameChange={onRenameChange}
      onRenameSubmit={() => {
        void onRenameSubmit(explorerNode);
      }}
      onRenameCancel={onRenameCancel}
      onActivate={() => {
        // A file activation may be rejected by the host (a dirty-file
        // navigation guard). Select only after the host accepts, so the row
        // highlight can never point at a file the viewer did not open.
        if (explorerNode.kind !== 'directory' && onFileActivate(explorerNode) === false) {
          return;
        }
        store.setSelection([explorerNode.id]);
        store.setActive(explorerNode.id);
        node.select();
        if (explorerNode.kind === 'directory') {
          node.toggle();
        }
      }}
    />
  );
}
