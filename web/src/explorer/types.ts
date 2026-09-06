import type { FileEntry } from '@/features/files';

import type { ExplorerDataProvider } from './providers/types';

export type NodeId = string;

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export interface ExplorerNode {
  id: NodeId;
  uri: string;
  name: string;
  kind: 'file' | 'directory';
  parentId?: NodeId;
  capabilities: {
    rename?: boolean;
    delete?: boolean;
    move?: boolean;
    createChild?: boolean;
  };
  metadata?: {
    size?: number;
    modifiedAt?: number;
    isBinary?: boolean;
    fullPath?: string;
  };
}

/** Public Explorer component props — expanded in later tasks. */
export interface ExplorerProps {
  provider: ExplorerDataProvider;
  onFileActivate?: (node: ExplorerNode) => void;
}

export function fileEntryToExplorerNode(entry: FileEntry, parentId?: NodeId): ExplorerNode {
  const kind = entry.is_dir ? 'directory' : 'file';

  return {
    id: entry.path,
    uri: entry.path,
    name: entry.name,
    kind,
    parentId,
    capabilities:
      kind === 'directory'
        ? { rename: true, delete: true, createChild: true }
        : { rename: true, delete: true, move: true },
    metadata: {
      size: entry.size,
      modifiedAt: entry.modified,
      isBinary: entry.is_binary,
      fullPath: entry.full_path,
    },
  };
}
