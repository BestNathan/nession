import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { base64Decode, base64Encode, type FileData, type FileOps } from '@/capabilities/files';
import { useFileViewer } from '../../useFileViewer';

const BIG_FILE = 11 * 1024 * 1024;

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
 * A FileOps whose chunked reads are settled by the test, one request at a
 * time. Completion order is exactly the order the test resolves them in.
 */
function chunkedFileOps() {
  const requests: Deferred<FileData>[] = [];
  const readFile = vi.fn<
    (path: string, options?: { offset?: number; limit?: number }) => Promise<FileData>
  >(() => {
    const request = deferred<FileData>();
    requests.push(request);
    return request.promise;
  });
  const fileOps: FileOps = {
    listDir: vi.fn(async () => ({ entries: [] })),
    readFile,
    writeFile: vi.fn(async () => ({ path: '', written: 0 })),
    deleteFile: vi.fn(async () => ({ path: '', success: true })),
    createDir: vi.fn(async () => ({ path: '', success: true })),
    renameFile: vi.fn(async () => ({ from: '', to: '', success: true })),
    getCwd: vi.fn(async () => ({ path: '' })),
    uploadFile: vi.fn(async () => ({ path: '', written: 0 })),
    base64Decode,
    base64Encode,
  };
  return { fileOps, readFile, requests };
}

function chunkData(offset: number, text: string, hasMore: boolean): FileData {
  return {
    path: '/logs/big.txt',
    content: base64Encode(text),
    mime_type: 'text/plain',
    offset,
    total_size: BIG_FILE,
    has_more: hasMore,
  };
}

function renderChunkedViewer() {
  const { fileOps, readFile, requests } = chunkedFileOps();
  const view = renderHook(() =>
    useFileViewer({
      fileOps,
      path: '/logs/big.txt',
      filename: 'big.txt',
      fileSize: BIG_FILE,
    }),
  );
  return { ...view, fileOps, readFile, requests };
}

/** Resolve one deferred chunk and let the reader advance a step. */
async function settle(
  requests: Deferred<FileData>[],
  index: number,
  data: FileData,
): Promise<void> {
  await act(async () => {
    requests[index].resolve(data);
    await requests[index].promise;
  });
}

describe('useFileViewer chunked-load flight ownership', () => {
  it('cancelling while the final chunk is in flight settles without committing it (SC-01)', async () => {
    const { result, requests } = renderChunkedViewer();
    expect(requests).toHaveLength(1);

    // First chunk lands; the reader issues the final chunk request.
    await settle(requests, 0, chunkData(0, 'first chunk ', true));
    expect(requests).toHaveLength(2);
    const progressAfterFirstChunk = result.current.loadedBytes;
    expect(progressAfterFirstChunk).toBeGreaterThan(0);
    expect(result.current.loading).toBe(true);
    expect(result.current.isChunkedLoading).toBe(true);

    // Cancel while that final request is still in flight.
    act(() => result.current.handleCancelLoad());
    expect(result.current.loading).toBe(false);
    expect(result.current.isChunkedLoading).toBe(false);

    // The deferred final chunk settles after the cancel. It must not resolve
    // into content, progress, an error or a loading state.
    await settle(requests, 1, chunkData(12, 'final chunk', false));
    expect(result.current.content).toBe('');
    expect(result.current.originalContent).toBe('');
    expect(result.current.loadedBytes).toBe(progressAfterFirstChunk);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.isChunkedLoading).toBe(false);
  });

  it('a superseded flight cannot publish over the newer load, whose result is authoritative (SC-02)', async () => {
    const { result, requests } = renderChunkedViewer();
    expect(requests).toHaveLength(1);

    // Flight A: first chunk lands, A's final chunk is in flight.
    await settle(requests, 0, chunkData(0, 'A first ', true));
    expect(requests).toHaveLength(2);

    // Refresh starts flight B, cancelling A and resetting progress.
    act(() => { void result.current.loadFile(); });
    expect(requests).toHaveLength(3);
    expect(result.current.loadedBytes).toBe(0);
    expect(result.current.loading).toBe(true);

    // A's final chunk settles late with stale content.
    await settle(requests, 1, chunkData(10, 'A final', false));
    expect(result.current.content).toBe('');
    expect(result.current.originalContent).toBe('');
    expect(result.current.loadedBytes).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.isChunkedLoading).toBe(true);

    // B's result is the one the viewer keeps.
    await settle(requests, 2, chunkData(0, 'B content', false));
    expect(result.current.content).toBe('B content');
    expect(result.current.originalContent).toBe('B content');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.isChunkedLoading).toBe(false);
  });

  it('keeps the newer flight cancellable after the superseded flight settles (SC-02)', async () => {
    const { result, requests } = renderChunkedViewer();

    await settle(requests, 0, chunkData(0, 'A first ', true));
    expect(requests).toHaveLength(2);
    act(() => { void result.current.loadFile(); });
    expect(requests).toHaveLength(3);

    // A settles late; B must still own the cancel control.
    await settle(requests, 1, chunkData(10, 'A final', false));
    expect(result.current.loading).toBe(true);

    act(() => result.current.handleCancelLoad());
    expect(result.current.loading).toBe(false);
    expect(result.current.isChunkedLoading).toBe(false);

    // B's in-flight chunk settling after the cancel publishes nothing.
    await settle(requests, 2, chunkData(0, 'B late', false));
    expect(result.current.content).toBe('');
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
