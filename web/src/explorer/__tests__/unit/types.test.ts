import { describe, expect, it } from 'vitest';
import type { FileEntry } from '@/features/files';
import { fileEntryToExplorerNode, type ExplorerNode } from '@/explorer/types';

const FILE_ENTRY: FileEntry = {
  name: 'readme.txt',
  path: 'docs/readme.txt',
  full_path: '/workspace/docs/readme.txt',
  is_dir: false,
  size: 1024,
  modified: 1700000000,
  is_binary: false,
};

const DIR_ENTRY: FileEntry = {
  name: 'src',
  path: 'src',
  full_path: '/workspace/src',
  is_dir: true,
  size: 0,
  modified: 1690000000,
};

describe('fileEntryToExplorerNode', () => {
  it('maps a file entry to an ExplorerNode', () => {
    const node = fileEntryToExplorerNode(FILE_ENTRY);

    expect(node).toEqual<ExplorerNode>({
      id: 'docs/readme.txt',
      uri: 'docs/readme.txt',
      name: 'readme.txt',
      kind: 'file',
      parentId: undefined,
      capabilities: { rename: true, delete: true, move: true },
      metadata: {
        size: 1024,
        modifiedAt: 1700000000,
        isBinary: false,
        fullPath: '/workspace/docs/readme.txt',
      },
    });
  });

  it('maps a directory entry to an ExplorerNode', () => {
    const node = fileEntryToExplorerNode(DIR_ENTRY);

    expect(node).toEqual<ExplorerNode>({
      id: 'src',
      uri: 'src',
      name: 'src',
      kind: 'directory',
      parentId: undefined,
      capabilities: { rename: true, delete: true, createChild: true },
      metadata: {
        size: 0,
        modifiedAt: 1690000000,
        isBinary: undefined,
        fullPath: '/workspace/src',
      },
    });
  });

  it('sets parentId when provided', () => {
    const node = fileEntryToExplorerNode(FILE_ENTRY, 'docs');

    expect(node.parentId).toBe('docs');
  });

  it('maps is_binary on file entries', () => {
    const binaryEntry: FileEntry = { ...FILE_ENTRY, is_binary: true };
    const node = fileEntryToExplorerNode(binaryEntry);

    expect(node.metadata?.isBinary).toBe(true);
  });
});
