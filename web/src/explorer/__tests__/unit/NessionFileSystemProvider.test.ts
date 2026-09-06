import { describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileOps } from '@/features/files';
import { createNessionFileSystemProvider } from '@/explorer/providers/NessionFileSystemProvider';
import type { ExplorerNode } from '@/explorer/types';

const DIR_NODE: ExplorerNode = {
  id: 'src',
  uri: 'src',
  name: 'src',
  kind: 'directory',
  capabilities: { rename: true, delete: true, createChild: true },
};

const FILE_NODE: ExplorerNode = {
  id: 'src/index.ts',
  uri: 'src/index.ts',
  name: 'index.ts',
  kind: 'file',
  parentId: 'src',
  capabilities: { rename: true, delete: true, move: true },
};

function makeFileOps(overrides: Partial<FileOps> = {}): FileOps {
  return {
    listDir: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue({ path: '', written: 0 }),
    deleteFile: vi.fn().mockResolvedValue({ path: '', success: true }),
    createDir: vi.fn().mockResolvedValue({ path: '', success: true }),
    renameFile: vi.fn().mockResolvedValue({ from: '', to: '', success: true }),
    getCwd: vi.fn(),
    uploadFile: vi.fn(),
    base64Decode: vi.fn(),
    base64Encode: vi.fn(),
    ...overrides,
  };
}

const ROOT_ENTRIES: FileEntry[] = [
  { name: 'zebra.txt', path: 'zebra.txt', full_path: '/root/zebra.txt', is_dir: false, size: 1, modified: 0 },
  { name: 'Alpha', path: 'Alpha', full_path: '/root/Alpha', is_dir: true, size: 0, modified: 0 },
  { name: 'beta', path: 'beta', full_path: '/root/beta', is_dir: true, size: 0, modified: 0 },
  { name: 'apple.txt', path: 'apple.txt', full_path: '/root/apple.txt', is_dir: false, size: 1, modified: 0 },
];

describe('createNessionFileSystemProvider', () => {
  it('loadChildren(null) calls listDir("") and maps entries', async () => {
    const fileOps = makeFileOps({
      listDir: vi.fn().mockResolvedValue({ entries: ROOT_ENTRIES }),
    });
    const provider = createNessionFileSystemProvider(fileOps);

    const children = await provider.loadChildren(null);

    expect(fileOps.listDir).toHaveBeenCalledWith('');
    expect(children).toHaveLength(4);
    expect(children.map((node) => node.id)).toEqual(['Alpha', 'beta', 'apple.txt', 'zebra.txt']);
    expect(children[0]).toMatchObject({ name: 'Alpha', kind: 'directory', parentId: undefined });
    expect(children[2]).toMatchObject({ name: 'apple.txt', kind: 'file', parentId: undefined });
  });

  it('loadChildren(dirNode) calls listDir(dirNode.uri)', async () => {
    const nested: FileEntry[] = [
      { name: 'index.ts', path: 'src/index.ts', full_path: '/root/src/index.ts', is_dir: false, size: 1, modified: 0 },
    ];
    const fileOps = makeFileOps({
      listDir: vi.fn().mockResolvedValue({ entries: nested }),
    });
    const provider = createNessionFileSystemProvider(fileOps);

    const children = await provider.loadChildren(DIR_NODE);

    expect(fileOps.listDir).toHaveBeenCalledWith('src');
    expect(children).toEqual([
      {
        id: 'src/index.ts',
        uri: 'src/index.ts',
        name: 'index.ts',
        kind: 'file',
        parentId: 'src',
        capabilities: { rename: true, delete: true, move: true },
        metadata: {
          size: 1,
          modifiedAt: 0,
          isBinary: undefined,
          fullPath: '/root/src/index.ts',
        },
      },
    ]);
  });

  it('sorts directories before files, then name ascending case-insensitively', async () => {
    const fileOps = makeFileOps({
      listDir: vi.fn().mockResolvedValue({ entries: ROOT_ENTRIES }),
    });
    const provider = createNessionFileSystemProvider(fileOps);

    const children = await provider.loadChildren(null);

    expect(children.map((node) => `${node.kind}:${node.name}`)).toEqual([
      'directory:Alpha',
      'directory:beta',
      'file:apple.txt',
      'file:zebra.txt',
    ]);
  });

  it('create file delegates to writeFile', async () => {
    const fileOps = makeFileOps();
    const provider = createNessionFileSystemProvider(fileOps);

    await provider.create?.(DIR_NODE, 'file', 'new.ts');

    expect(fileOps.writeFile).toHaveBeenCalledWith('src/new.ts', '');
    expect(fileOps.createDir).not.toHaveBeenCalled();
  });

  it('create directory at root delegates to createDir', async () => {
    const fileOps = makeFileOps();
    const provider = createNessionFileSystemProvider(fileOps);

    await provider.create?.(null, 'directory', 'docs');

    expect(fileOps.createDir).toHaveBeenCalledWith('docs');
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });

  it('rename delegates to renameFile', async () => {
    const fileOps = makeFileOps();
    const provider = createNessionFileSystemProvider(fileOps);

    await provider.rename?.(FILE_NODE, 'main.ts');

    expect(fileOps.renameFile).toHaveBeenCalledWith('src/index.ts', 'src/main.ts');
  });

  it('delete file delegates to deleteFile without recursive', async () => {
    const fileOps = makeFileOps();
    const provider = createNessionFileSystemProvider(fileOps);

    await provider.delete?.(FILE_NODE);

    expect(fileOps.deleteFile).toHaveBeenCalledWith('src/index.ts', false);
  });

  it('delete directory delegates to deleteFile with recursive', async () => {
    const fileOps = makeFileOps();
    const provider = createNessionFileSystemProvider(fileOps);

    await provider.delete?.(DIR_NODE);

    expect(fileOps.deleteFile).toHaveBeenCalledWith('src', true);
  });
});
