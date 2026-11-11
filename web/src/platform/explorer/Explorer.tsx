import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { RefreshCw } from 'lucide-react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';

import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';

import {
  EXPLORER_ROW_HEIGHT,
  flatDataToArboristTree,
  type ArboristNode,
} from './adapters/arboristAdapter';
import { createCoreExplorerExtension } from './commands/coreContributions';
import type { ExplorerExtension } from './commands/types';
import { ExplorerStore, ROOT_ID } from './ExplorerStore';
import { ExplorerRegistryContext } from './ExplorerRegistryContext';
import { useExplorerFileActions } from './hooks/useExplorerFileActions';
import { useExplorerRegistry } from './hooks/useExplorerRegistry';
import { useExplorerStore } from './hooks/useExplorerStore';
import { useExplorerControlledSelection } from './hooks/useExplorerControlledSelection';
import { useExplorerRevealPath } from './hooks/useExplorerRevealPath';
import { useExplorerTreeHeight } from './hooks/useExplorerTreeHeight';
import { useWorkspaceClearancePx } from './hooks/useWorkspaceClearancePx';
import type { ExplorerDataProvider } from './providers/types';
import { ExplorerArboristNode } from './renderers/ExplorerArboristNode';
import type { ExplorerNode } from './types';

export interface ExplorerComponentProps {
  provider: ExplorerDataProvider;
  extensions?: ExplorerExtension[];
  /** Return false to reject the activation; the tree keeps its selection. */
  onFileActivate: (node: ExplorerNode) => boolean | void;
  onFileDeleted?: (node: ExplorerNode) => void;
  onFileRenamed?: (node: ExplorerNode, newName: string) => void;
  /** Intercept context-menu delete (e.g. confirmation dialog) instead of deleting immediately. */
  onDeleteRequest?: (node: ExplorerNode) => void;
  initialPath?: string;
  /** Reveal and focus this path when it changes (e.g. parent navigation, terminal CWD). */
  revealPath?: string;
  /** Hide the built-in refresh toolbar (when an outer shell provides its own). */
  hideToolbar?: boolean;
  /** The host's open file. Guarded transitions move the row when the host commits. */
  selectedPath?: string | null;
  /** Receives the ExplorerStore instance for refresh/navigation from a parent shell. */
  storeRef?: MutableRefObject<ExplorerStore | null>;
  className?: string;
}

function ExplorerRefreshToolbar({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex items-center px-2 py-1 border-b border-border">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7"
        aria-label="Refresh explorer"
        onClick={onRefresh}
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function Explorer({
  provider,
  extensions,
  onFileActivate,
  selectedPath,
  onFileDeleted,
  onFileRenamed,
  onDeleteRequest,
  initialPath,
  revealPath,
  hideToolbar = false,
  storeRef,
  className,
}: ExplorerComponentProps) {
  const store = useExplorerStore(provider);
  // Stabilize the default: a bare `extensions ?? []` would hand the effect a
  // fresh array per render, re-registering (and re-rendering) every time.
  const extensionList = useMemo(() => extensions ?? [], [extensions]);
  const registry = useExplorerRegistry();
  const treeRef = useRef<TreeApi<ArboristNode> | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const treeHeight = useExplorerTreeHeight(containerRef);
  // #1347 SC-12: the virtualizer's trailing scroll clearance — the same
  // published measurement the CSS class spends, in the unit a virtualized
  // list needs (see the hook for why the class cannot reach this scroller).
  const clearancePx = useWorkspaceClearancePx(containerRef);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const fileActions = useExplorerFileActions({
    provider,
    store,
    onFileDeleted,
    onFileRenamed,
    onDeleteRequest,
  });

  useEffect(() => {
    if (storeRef) {
      storeRef.current = store;
    }
  }, [store, storeRef]);

  useEffect(() => {
    const toRegister = [createCoreExplorerExtension(), ...extensionList];
    for (const extension of toRegister) {
      registry.register(extension);
    }
    return () => {
      for (const extension of toRegister) {
        registry.unregister(extension.id);
      }
    };
  }, [extensionList, registry]);

  useEffect(() => {
    void store.ensureRootLoaded();
  }, [store]);

  const { flatData } = store.getSnapshot();
  const treeData = useMemo(
    () => flatDataToArboristTree(flatData, store.getChildren(ROOT_ID)),
    [flatData, store],
  );

  useExplorerRevealPath({ store, treeRef, treeData, initialPath, revealPath });

  useExplorerControlledSelection({ store, treeRef, treeData, selectedPath, selectionRevision });

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
        onFileActivate={(node) => {
          const accepted = onFileActivate(node);
          if (accepted === false) {
            setSelectionRevision((revision) => revision + 1);
          }
          return accepted;
        }}
      />
    ),
    [fileActions, onFileActivate, store],
  );

  return (
    <div className={cn('flex flex-col h-full min-h-0', className)}>
      {!hideToolbar && (
        <ExplorerRefreshToolbar
          onRefresh={() => {
            void store.refresh(ROOT_ID);
          }}
        />
      )}
      <div ref={containerRef} className="flex-1 min-h-0">
        <ExplorerRegistryContext.Provider value={registry}>
          <Tree
            ref={treeRef}
            data={treeData}
            width="100%"
            height={treeHeight}
            paddingBottom={clearancePx}
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
        </ExplorerRegistryContext.Provider>
      </div>
    </div>
  );
}
