import type { FileOps } from '../types';
import { fileErrorMessage } from '../model/fileErrors';

import { fileEntryToExplorerNode, type ExplorerDataProvider, type ExplorerNode } from '@/platform/explorer';

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
        // Create is not an overwrite: the provider, not the caller, owns the
        // no-replace decision.
        await fileOps.writeFile(path, '', { createOnly: true });
      } else {
        await fileOps.createDir(path, { createOnly: true });
      }
    },

    async rename(node, name) {
      const trimmed = name.trim();
      const newPath = joinPath(parentPath(node.uri), trimmed);
      try {
        await fileOps.renameFile(node.uri, newPath, { noReplace: true });
      } catch (error) {
        // The explorer shows this message verbatim under its toast; translate
        // the wire's `already_exists`/`conflict` token into the action the user
        // can take instead of leaving a raw protocol prefix in the UI.
        throw new Error(fileErrorMessage(error, 'rename'));
      }
    },

    async delete(node) {
      await fileOps.deleteFile(node.uri, node.kind === 'directory');
    },
  };
}
