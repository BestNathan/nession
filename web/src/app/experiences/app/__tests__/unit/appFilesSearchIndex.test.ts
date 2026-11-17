import { describe, expect, it, vi } from 'vitest';
import type { FileEntry, FileOps } from '@/capabilities/files';
import {
  APP_FILES_SEARCH_MAX_DIRECTORIES,
  APP_FILES_SEARCH_MAX_FILES,
  buildAppFilesSearchIndex,
} from '@/app/experiences/app/appFilesSearchIndex';

function makeFileOps(listDir: FileOps['listDir']): FileOps {
  return {
    listDir,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    createDir: vi.fn(),
    renameFile: vi.fn(),
    getCwd: vi.fn(),
    uploadFile: vi.fn(),
    base64Decode: vi.fn(),
    base64Encode: vi.fn(),
  };
}

function dir(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, full_path: `/${path}`, is_dir: true, size: 0, modified: 0 };
}

function file(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, full_path: `/${path}`, is_dir: false, size: 1, modified: 0 };
}

describe('buildAppFilesSearchIndex', () => {
  it('bounds listDir requests by the documented directory budget, independent of directory count', async () => {
    const requestCounts: number[] = [];

    for (const directoryCount of [1_000, 10_000, 50_000]) {
      const listDir = vi.fn((path: string) => {
        if (path !== '') {
          return Promise.resolve({ entries: [] });
        }
        return Promise.resolve({
          entries: Array.from({ length: directoryCount }, (_, i) => dir(`empty-${String(i).padStart(5, '0')}`)),
        });
      });

      const result = await buildAppFilesSearchIndex(
        makeFileOps(listDir),
        new AbortController().signal,
      );

      // The tree is deliberately larger than the request budget: the scan
      // must stop at the same documented ceiling for every tree size.
      expect(listDir).toHaveBeenCalledTimes(APP_FILES_SEARCH_MAX_DIRECTORIES);
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe('directory-limit');
      expect(result.files).toEqual([]);
      requestCounts.push(listDir.mock.calls.length);
    }

    expect(new Set(requestCounts).size).toBe(1);
  });

  it('launches no further listDir after cancellation, even while a request is in flight', async () => {
    let resolveRoot: ((value: { entries: FileEntry[] }) => void) | undefined;
    let resolveFirstChild: ((value: { entries: FileEntry[] }) => void) | undefined;
    const listDir = vi.fn((path: string) => {
      return new Promise<{ entries: FileEntry[] }>((resolve) => {
        if (path === '') {
          resolveRoot = resolve;
        } else {
          resolveFirstChild = resolve;
        }
      });
    });
    const controller = new AbortController();
    const scan = buildAppFilesSearchIndex(makeFileOps(listDir), controller.signal);

    expect(listDir).toHaveBeenCalledTimes(1);
    expect(listDir).toHaveBeenLastCalledWith('');
    resolveRoot?.({ entries: [dir('a'), dir('b'), dir('c')] });

    // The next request is already in flight when the scan is cancelled.
    await vi.waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
    expect(listDir).toHaveBeenLastCalledWith('a');

    controller.abort();
    resolveFirstChild?.({ entries: [file('a/one.txt')] });

    const result = await scan;
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('cancelled');

    // Let any stray continuation run; cancellation is checked when the
    // in-flight response arrives, and no third request may be launched.
    await Promise.resolve();
    expect(listDir).toHaveBeenCalledTimes(2);
    expect(listDir).not.toHaveBeenCalledWith('b');
    expect(listDir).not.toHaveBeenCalledWith('c');
  });

  it('reports a file beyond the file budget as incomplete rather than absent', async () => {
    const filler = Array.from({ length: APP_FILES_SEARCH_MAX_FILES }, (_, i) =>
      file(`bulk/filler-${String(i).padStart(5, '0')}.txt`),
    );
    const listDir = vi.fn((path: string) => {
      if (path === '') {
        return Promise.resolve({ entries: [dir('bulk'), dir('late')] });
      }
      if (path === 'bulk') {
        return Promise.resolve({ entries: filler });
      }
      return Promise.resolve({ entries: [file('late/needle.txt')] });
    });

    const result = await buildAppFilesSearchIndex(
      makeFileOps(listDir),
      new AbortController().signal,
    );

    expect(result.files).toHaveLength(APP_FILES_SEARCH_MAX_FILES);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('file-limit');
    expect(result.files.some((entry) => entry.path === 'late/needle.txt')).toBe(false);
    // The walk stopped at the budget: the directory holding the late match
    // was never requested.
    expect(listDir).not.toHaveBeenCalledWith('late');
  });

  it('reports a scan that fits both budgets as complete with no reason', async () => {
    const listDir = vi.fn((path: string) => {
      if (path === '') {
        return Promise.resolve({ entries: [dir('docs')] });
      }
      return Promise.resolve({ entries: [file('docs/guide.md')] });
    });

    const result = await buildAppFilesSearchIndex(
      makeFileOps(listDir),
      new AbortController().signal,
    );

    expect(result.files.map((entry) => entry.path)).toEqual(['docs/guide.md']);
    expect(result.complete).toBe(true);
    expect(result.incompleteReason).toBeNull();
  });
});
