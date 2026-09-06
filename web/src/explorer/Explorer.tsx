import { useCallback, useEffect, useMemo, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import {
  EXPLORER_ROW_HEIGHT,
  flatDataToArboristTree,
  type ArboristNode,
} from './adapters/arboristAdapter';
import { createCoreExplorerExtension } from './commands/coreContributions';
import type { ExplorerExtension } from './commands/types';
import { ROOT_ID } from './ExplorerStore';
import { useExplorerFileActions } from './hooks/useExplorerFileActions';
import { useExplorerStore } from './hooks/useExplorerStore';
import { useExplorerTreeHeight } from './hooks/useExplorerTreeHeight';
import type { ExplorerDataProvider } from './providers/types';
import { registerExtension, unregisterExtension } from './registry';
import { ExplorerArboristNode } from './renderers/ExplorerArboristNode';
import type { ExplorerNode } from './types';

export interface ExplorerComponentProps {
  provider: ExplorerDataProvider;
  extensions?: ExplorerExtension[];
  onFileActivate: (node: ExplorerNode) => void;
  onFileDeleted?: (node: ExplorerNode) => void;
  onFileRenamed?: (node: ExplorerNode, newName: string) => void;
  initialPath?: string;
  className?: string;
}

export function Explorer({
  provider,
  extensions = [],
  onFileActivate,
  onFileDeleted,
  onFileRenamed,
  initialPath,
  className,
}: ExplorerComponentProps) {
  const store = useExplorerStore(provider);
  const treeRef = useRef<TreeApi<ArboristNode> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeHeight = useExplorerTreeHeight(containerRef);
  const fileActions = useExplorerFileActions({
    provider,
    store,
    onFileDeleted,
    onFileRenamed,
  });

  useEffect(() => {
    const toRegister = [createCoreExplorerExtension(), ...extensions];
    for (const extension of toRegister) {
      registerExtension(extension);
    }
    return () => {
      for (const extension of toRegister) {
        unregisterExtension(extension.id);
      }
    };
  }, [extensions]);

  useEffect(() => {
    void store.ensureRootLoaded();
  }, [store]);

  const { revision, flatData } = store.getSnapshot();
  const treeData = useMemo(
    () => flatDataToArboristTree(flatData, store.getChildren(ROOT_ID)),
    [flatData, revision, store],
  );

  useEffect(() => {
    if (!initialPath) {
      return;
    }

    const segments = initialPath.split('/').filter(Boolean);
    let path = '';
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      store.expand(path);
    }

    treeRef.current?.openParents(initialPath);
    treeRef.current?.open(initialPath);
  }, [initialPath, store, treeData]);

  const handleToggle = useCallback(
    (id: string) => {
      if (treeRef.current?.isOpen(id)) {
        store.expand(id);
      } else {
        store.collapse(id);
      }
    },
    [store],
  );

  const renderNode = useCallback(
    (nodeProps: NodeRendererProps<ArboristNode>) => (
      <ExplorerArboristNode
        nodeProps={nodeProps}
        store={store}
        menuContext={fileActions.menuContext}
        renamingId={fileActions.renamingId}
        renameValue={fileActions.renameValue}
        onRenameChange={fileActions.setRenameValue}
        onRenameSubmit={fileActions.handleRenameSubmit}
        onRenameCancel={fileActions.handleRenameCancel}
        onFileActivate={onFileActivate}
      />
    ),
    [fileActions, onFileActivate, store],
  );

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      <div className="flex items-center px-2 py-1 border-b border-border">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Refresh explorer"
          onClick={() => {
            void store.refresh(ROOT_ID);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0">
        <Tree
          ref={treeRef}
          data={treeData}
          width="100%"
          height={treeHeight}
          rowHeight={EXPLORER_ROW_HEIGHT}
          indent={16}
          openByDefault={false}
          onToggle={handleToggle}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
        >
          {renderNode}
        </Tree>
      </div>
    </div>
  );
}
