// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createFileOpsFromRouter } from '@/services/fileOps';
import type { MessageRouter } from '@/services/socket/types';

function makeRouter(): MessageRouter & { waitForConnection: () => Promise<void> } {
  return {
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
    request: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      switch (type) {
        case 'file.list':
          return { entries: [] };
        case 'file.read':
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
    }),
    waitForConnection: vi.fn(async () => {}),
  } as unknown as MessageRouter & { waitForConnection: () => Promise<void> };
}

describe('createFileOpsFromRouter', () => {
  it('delegates all file operations through router.request', async () => {
    const router = makeRouter();
    const ops = createFileOpsFromRouter(router);

    await ops.listDir('/');
    await ops.readFile('/a', { offset: 1, limit: 2 });
    await ops.writeFile('/a', 'hi');
    await ops.deleteFile('/a', true);
    await ops.createDir('/dir');
    await ops.renameFile('/a', '/b');
    await ops.getCwd('sess-1');

    expect(router.request).toHaveBeenCalledWith('file.list', { path: '/' });
    expect(router.request).toHaveBeenCalledWith('file.read', { path: '/a', offset: 1, limit: 2 });
    expect(router.request).toHaveBeenCalledWith('file.write', expect.objectContaining({ path: '/a' }));
    expect(router.request).toHaveBeenCalledWith('file.delete', { path: '/a', recursive: true });
    expect(router.request).toHaveBeenCalledWith('file.create_dir', { path: '/dir' });
    expect(router.request).toHaveBeenCalledWith('file.rename', { from: '/a', to: '/b' });
    expect(router.request).toHaveBeenCalledWith('file.cwd', { session_id: 'sess-1' });
  });

  it('uploadFile reads file and writes base64 payload', async () => {
    const router = makeRouter();
    const ops = createFileOpsFromRouter(router);
    const file = new File(['payload'], 'data.bin', { type: 'application/octet-stream' });

    const promise = ops.uploadFile('/remote/data.bin', file);
    await new Promise((r) => setTimeout(r, 20));
    await promise;

    expect(router.request).toHaveBeenCalledWith(
      'file.write',
      expect.objectContaining({ path: '/remote/data.bin', content: expect.any(String) }),
    );
  });

  it('uploadFile rejects when FileReader fails', async () => {
    const router = makeRouter();
    const ops = createFileOpsFromRouter(router);
    const file = new File(['x'], 'bad.txt');
    const original = globalThis.FileReader;

    class FailingReader {
      onerror: ((ev: Event) => void) | null = null;
      onload: ((ev: Event) => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onerror?.(new Event('error')));
      }
    }
    globalThis.FileReader = FailingReader as unknown as typeof FileReader;

    await expect(ops.uploadFile('/remote/bad.txt', file)).rejects.toThrow('Failed to read file for upload');
    globalThis.FileReader = original;
  });
});
