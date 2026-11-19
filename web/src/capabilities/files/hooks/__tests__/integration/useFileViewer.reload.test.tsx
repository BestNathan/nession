import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { base64Decode, base64Encode, type FileData, type FileOps } from '@/capabilities/files';
import { useFileViewer } from '../../useFileViewer';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * A FileOps whose whole-file reads are settled by the test, one at a time, so
 * a reload flight and its successor can be completed out of order.
 */
function controlledFileOps() {
  const reads: Deferred<FileData>[] = [];
  const readFile = vi.fn(() => {
    const request = deferred<FileData>();
    reads.push(request);
    return request.promise;
  });
  const fileOps: FileOps = {
    listDir: vi.fn(async () => ({ entries: [] })),
    readFile,
    writeFile: vi.fn(async () => ({ path: '/notes.txt', written: 0, revision: 'rev-written' })),
    deleteFile: vi.fn(async () => ({ path: '', success: true })),
    createDir: vi.fn(async () => ({ path: '', success: true })),
    renameFile: vi.fn(async () => ({ from: '', to: '', success: true })),
    getCwd: vi.fn(async () => ({ path: '' })),
    uploadFile: vi.fn(async () => ({ path: '', written: 0 })),
    base64Decode,
    base64Encode,
  };
  return { fileOps, reads };
}

function data(text: string, revision = 'rev-1'): FileData {
  return { path: '/notes.txt', content: base64Encode(text), mime_type: 'text/plain', revision };
}

describe('useFileViewer conflict reload transaction (#3743 SC-02)', () => {
  it('a superseded failed reload cannot clear dirty or leak into the successor', async () => {
    const { fileOps, reads } = controlledFileOps();
    const onDirtyChange = vi.fn();
    const { result } = renderHook(() =>
      useFileViewer({ fileOps, path: '/notes.txt', filename: 'notes.txt', onDirtyChange }),
    );

    await waitFor(() => expect(reads).toHaveLength(1));
    await act(async () => { reads[0].resolve(data('hello')); });
    await waitFor(() => expect(result.current.content).toBe('hello'));

    act(() => result.current.handleContentChange('hello!'));
    expect(result.current.isDirty).toBe(true);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // Conflict reload flight A, then a newer load B supersedes it.
    act(() => result.current.handleReloadAfterConflict());
    await waitFor(() => expect(reads).toHaveLength(2));
    act(() => result.current.reloadFile());
    await waitFor(() => expect(reads).toHaveLength(3));

    // A fails late, but B owns the viewer: no error and no dirty clear.
    await act(async () => { reads[1].reject(new Error('stale read failed')); });
    expect(result.current.error).toBeNull();
    expect(result.current.isDirty).toBe(true);
    expect(onDirtyChange.mock.calls.some(([dirty]) => dirty === false)).toBe(false);

    // B's committed replacement is the one that makes the document clean.
    await act(async () => { reads[2].resolve(data('new disk', 'rev-2')); });
    await waitFor(() => expect(result.current.content).toBe('new disk'));
    expect(result.current.originalContent).toBe('new disk');
    expect(result.current.isDirty).toBe(false);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
