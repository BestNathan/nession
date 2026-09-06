import type { FileOps } from '@/features/files';

import { fileEntryToExplorerNode, type ExplorerNode } from '../types';
import type { ExplorerDataProvider } from './types';

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(uri: string): string {
  const lastSlash = uri.lastIndexOf('/');
  return lastSlash >= 0 ? uri.slice(0, lastSlash) : '';
}

function sortExplorerNodes(nodes: ExplorerNode[]): ExplorerNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function createNessionFileSystemProvider(fileOps: FileOps): ExplorerDataProvider {
  return {
    async loadChildren(node) {
      const path = node === null ? '' : node.uri;
      const { entries } = await fileOps.listDir(path);
      const parentId = node?.id;
      const nodes = entries.map((entry) => fileEntryToExplorerNode(entry, parentId));
      return sortExplorerNodes(nodes);
    },

    async create(parent, kind, name) {
      const trimmed = name.trim();
      const parentPath = parent?.uri ?? '';
      const path = joinPath(parentPath, trimmed);
      if (kind === 'file') {
        await fileOps.writeFile(path, '');
      } else {
        await fileOps.createDir(path);
      }
    },

    async rename(node, name) {
      const trimmed = name.trim();
      const newPath = joinPath(parentPath(node.uri), trimmed);
      await fileOps.renameFile(node.uri, newPath);
    },

    async delete(node) {
      await fileOps.deleteFile(node.uri, node.kind === 'directory');
    },
  };
}
