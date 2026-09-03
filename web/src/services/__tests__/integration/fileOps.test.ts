// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createFileOpsFromRouter, readFileChunked, DEFAULT_CHUNK_SIZE, type FileData } from '@/services/fileOps';
import type { MessageRouter } from '@/services/socket/types';

/**
 * Router-backed FileOps harness. The wire-level request correlation the old
 * fileOps integration suite exercised is gone (delegated to MessageRouter /
 * AgentSocketClient / FileCapability tests); this file covers the remaining
 * fileOps.ts surface that needs a live FileOps object: base64 codec exposure
 * and chunked reads.
 */
function makeOps(opts?: { readFileImpl?: (path: string, options?: { offset?: number; limit?: number }) => Promise<FileData> }) {
  const request = vi.fn(
    async (type: string, payload: Record<string, unknown>) => {
      switch (type) {
        case 'file.list':
          return { entries: [] };
        case 'file.read':
          if (opts?.readFileImpl) {
            return opts.readFileImpl(String(payload.path), {
              offset: payload.offset as number | undefined,
              limit: payload.limit as number | undefined,
            });
          }
          return { path: payload.path, content: 'YQ==', mime_type: 'text/plain' };
        case 'file.write':
          return { path: payload.path, written: 4 };
        case 'file.delete':
          return { path: payload.path, success: true };
        case 'file.create_dir':
          return { path: payload.path, success: true };
        case 'file.rename':
          return { from: payload.from, to: payload.to, success: true };
        case 'file.cwd':
          return { path: '/cwd' };
        default:
          throw new Error(`unexpected ${type}`);
      }
    },
  );
  const router = {
    request,
    waitForConnection: vi.fn(async () => {}),
  } as unknown as MessageRouter & { waitForConnection: () => Promise<void> };
  return { ops: createFileOpsFromRouter(router), router };
}

describe('fileOps', () => {
  describe('base64 codec', () => {
    it('base64Encode roundtrips through base64Decode', () => {
      const { ops } = makeOps();
      const original = 'Hello, World!';
      const encoded = ops.base64Encode(original);
      expect(typeof encoded).toBe('string');
      expect(ops.base64Decode(encoded)).toBe(original);
    });

    it('base64Encode handles empty string', () => {
      const { ops } = makeOps();
      expect(ops.base64Decode(ops.base64Encode(''))).toBe('');
    });

    it('base64Encode handles unicode', () => {
      const { ops } = makeOps();
      const original = '你好世界 🎉';
      expect(ops.base64Decode(ops.base64Encode(original))).toBe(original);
    });
  });

  describe('readFileChunked', () => {
    it('fetches chunks until has_more is false and concatenates decoded text', async () => {
      const chunks = ['chunk-1', 'chunk-2', 'chunk-3'];
      const readFileImpl = vi.fn(async (_path: string, options?: { offset?: number }) => {
        const index = (options?.offset ?? 0) / chunks[0].length;
        const isLast = index === chunks.length - 1;
        return {
          path: '/big.txt',
          content: btoa(chunks[index]),
          mime_type: 'text/plain',
          offset: options?.offset ?? 0,
          total_size: chunks.join('').length,
          has_more: !isLast,
        } as FileData;
      });
      const { ops } = makeOps({ readFileImpl });
      const progress = vi.fn();

      const p = readFileChunked(ops, '/big.txt', progress).promise;

      const fullText = await p;
      expect(fullText).toBe(chunks.join(''));
      // Offset advances by the decoded chunk length between requests.
      expect(readFileImpl).toHaveBeenNthCalledWith(1, '/big.txt', { offset: 0, limit: DEFAULT_CHUNK_SIZE });
      expect(readFileImpl).toHaveBeenNthCalledWith(2, '/big.txt', { offset: chunks[0].length, limit: DEFAULT_CHUNK_SIZE });
      // Progress fires once per chunk with cumulative offsets.
      expect(progress).toHaveBeenCalledTimes(chunks.length);
      expect(progress.mock.calls[chunks.length - 1][0]).toBe(chunks.join('').length);
      expect(progress.mock.calls[chunks.length - 1][1]).toBe(chunks.join('').length);
    });

    it('cancel() stops further requests and rejects with AbortError', async () => {
      // Gate the first response so cancellation lands between the loop
      // iterations (an always-resolving mock would let the whole loop drain in
      // microtasks before cancel() ever runs).
      let releaseFirst: (r: FileData) => void = () => {};
      const firstGate = new Promise<FileData>((resolve) => { releaseFirst = resolve; });
      const readFileImpl = vi.fn(async () => {
        if (readFileImpl.mock.calls.length === 1) {
          return firstGate;
        }
        throw new Error('unreachable: cancelled before the second request');
      });
      const { ops } = makeOps({ readFileImpl });

      const handle = readFileChunked(ops, '/big.txt');

      // Wait one macrotask so the first request is in flight, then cancel and
      // release the first chunk (has_more=true so the loop wants to continue).
      await new Promise((r) => setTimeout(r, 0));
      handle.cancel();
      releaseFirst({
        path: '/big.txt',
        content: btoa('first'),
        mime_type: 'text/plain',
        total_size: 100,
        has_more: true,
      });

      await expect(handle.promise).rejects.toThrow(/cancelled/i);
      // Only the first chunk was requested — cancellation stopped the loop.
      expect(readFileImpl).toHaveBeenCalledTimes(1);
    });

    it('returns single-chunk content immediately when has_more is false on first response', async () => {
      const readFileImpl = vi.fn(async () => ({
        path: '/small.txt',
        content: btoa('only-chunk'),
        mime_type: 'text/plain',
        total_size: 10,
        has_more: false,
      }) as FileData);
      const { ops } = makeOps({ readFileImpl });
      const progress = vi.fn();

      const text = await readFileChunked(ops, '/small.txt', progress).promise;
      expect(text).toBe('only-chunk');
      expect(progress).toHaveBeenCalledTimes(1);
    });
  });
});
