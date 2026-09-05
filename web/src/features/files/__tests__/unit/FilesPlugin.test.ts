// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHUNK_SIZE,
  FilesPlugin,
  base64Decode,
  base64Encode,
  createFilesApi,
  readFileChunked,
  type FileData,
  type FileEntry,
  type FileOps,
} from '@/features/files';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

const sampleEntry: FileEntry = {
  name: 'a.txt',
  path: '/tmp/a.txt',
  full_path: '/tmp/a.txt',
  is_dir: false,
  size: 4,
  modified: 1700000000,
  mime_type: 'text/plain',
};

function emptyFile(path: string): FileData {
  return { path, content: '', mime_type: 'text/plain', offset: 0, total_size: 0, has_more: false };
}

function chunk(offset: number, text: string, hasMore: boolean): FileData {
  return {
    path: '/f.txt',
    content: base64Encode(text),
    mime_type: 'text/plain',
    offset,
    total_size: 12,
    has_more: hasMore,
  };
}

function stubFileOps(overrides: { readFile?: (path: string, options?: { offset?: number; limit?: number }) => Promise<FileData> } = {}): FileOps {
  return {
    listDir: vi.fn(async () => ({ entries: [] })),
    readFile: overrides.readFile ?? vi.fn(async () => emptyFile('')),
    writeFile: vi.fn(async () => ({ path: '', written: 0 })),
    deleteFile: vi.fn(async () => ({ path: '', success: true })),
    createDir: vi.fn(async () => ({ path: '', success: true })),
    renameFile: vi.fn(async () => ({ from: '', to: '', success: true })),
    getCwd: vi.fn(async () => ({ path: '' })),
    uploadFile: vi.fn(async () => ({ path: '', written: 0 })),
    base64Decode,
    base64Encode,
  };
}

describe('base64 helpers', () => {
  it('encodes UTF-8 text and decodes it back losslessly', () => {
    const text = 'héllo 世界 — ünïcode';
    const encoded = base64Encode(text);
    expect(encoded).not.toContain('é');
    expect(base64Decode(encoded)).toBe(text);
  });

  it('round-trips ASCII through the known fixture', () => {
    expect(base64Encode('hello')).toBe('aGVsbG8=');
    expect(base64Decode('aGVsbG8=')).toBe('hello');
  });
});

describe('readFileChunked', () => {
  it('concatenates multiple chunks, advancing the offset by decoded length', async () => {
    const responses = [chunk(0, 'Hello ', true), chunk(6, 'world!', false)];
    const readFile = vi.fn(async (_path: string, options?: { offset?: number; limit?: number }) => {
      const want = options?.offset ?? 0;
      return responses.find((r) => r.offset === want) ?? emptyFile('/f.txt');
    });
    const fileOps = stubFileOps({ readFile });
    const progress = vi.fn();

    const handle = readFileChunked(fileOps, '/f.txt', progress);

    await expect(handle.promise).resolves.toBe('Hello world!');
    expect(progress.mock.calls).toEqual([
      [6, 12],
      [12, 12],
    ]);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenNthCalledWith(1, '/f.txt', { offset: 0, limit: DEFAULT_CHUNK_SIZE });
    expect(readFile).toHaveBeenNthCalledWith(2, '/f.txt', { offset: 6, limit: DEFAULT_CHUNK_SIZE });
  });

  it('resolves empty text for an empty file', async () => {
    const readFile = vi.fn(async () => emptyFile('/e.txt'));
    const fileOps = stubFileOps({ readFile });
    const progress = vi.fn();

    const handle = readFileChunked(fileOps, '/e.txt', progress);

    await expect(handle.promise).resolves.toBe('');
    expect(progress).toHaveBeenCalledWith(0, 0);
  });

  it('reports zero total size when the backend omits it', async () => {
    const readFile = vi.fn(async () => ({
      path: '/n.txt',
      content: base64Encode('x'),
      mime_type: 'text/plain',
      has_more: false,
    }));
    const fileOps = stubFileOps({ readFile });
    const progress = vi.fn();

    const handle = readFileChunked(fileOps, '/n.txt', progress);

    await expect(handle.promise).resolves.toBe('x');
    expect(progress).toHaveBeenCalledWith(1, 0);
  });

  it('runs without a progress callback', async () => {
    const readFile = vi.fn(async () => chunk(0, 'solo', false));
    const fileOps = stubFileOps({ readFile });

    const handle = readFileChunked(fileOps, '/f.txt');

    await expect(handle.promise).resolves.toBe('solo');
  });

  it('cancel while a read is in flight aborts at the next loop top', async () => {
    let resolveRead: ((data: FileData) => void) | undefined;
    const readFile = vi.fn(() => new Promise<FileData>((resolve) => { resolveRead = resolve; }));
    const fileOps = stubFileOps({ readFile });
    const progress = vi.fn();

    // The loop-top check only runs between reads — an already-issued read
    // always completes, then cancellation stops any further reads.
    const handle = readFileChunked(fileOps, '/f.txt', progress);
    handle.cancel();
    resolveRead?.(chunk(0, 'x', true));

    await expect(handle.promise).rejects.toMatchObject({ name: 'AbortError', message: 'Read cancelled' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(1, 12);
  });
});

describe('FilesPlugin', () => {
  let plugin: FilesPlugin;
  let surface: MockPluginSurface;

  beforeEach(() => {
    plugin = new FilesPlugin();
    surface = createMockPluginSurface();
  });

  it('exposes the "files" capability name', () => {
    expect(plugin.name).toBe('files');
  });

  it('createFilesApi returns a fresh unbound plugin', async () => {
    const api = createFilesApi();
    expect(api).toBeInstanceOf(FilesPlugin);
    expect(api.name).toBe('files');
    await expect(api.listDir('/')).rejects.toThrow('files feature is not connected');
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer binding active', async () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const pending = plugin.listDir('/');
      expect(surfaceA.requests).toHaveLength(0);
      expect(surfaceB.requests).toHaveLength(1);
      surfaceB.resolveNext('file.list', { entries: [] });
      await expect(pending).resolves.toEqual({ entries: [] });

      teardownB();
      await expect(plugin.listDir('/')).rejects.toThrow('files feature is not connected');
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });
  });

  describe('requests', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('listDir sends file.list with the path', async () => {
      const pending = plugin.listDir('/tmp');
      expect(surface.requests[0]).toMatchObject({ type: 'file.list', payload: { path: '/tmp' } });

      surface.resolveNext('file.list', { entries: [sampleEntry] });
      await expect(pending).resolves.toEqual({ entries: [sampleEntry] });
    });

    it('readFile without options sends only the path', async () => {
      const pending = plugin.readFile('/tmp/a.txt');
      expect(surface.requests[0]?.payload).toEqual({ path: '/tmp/a.txt' });

      surface.resolveNext('file.read', {
        path: '/tmp/a.txt',
        content: 'aGVsbG8=',
        mime_type: 'text/plain',
      });
      await expect(pending).resolves.toEqual({
        path: '/tmp/a.txt',
        content: 'aGVsbG8=',
        mime_type: 'text/plain',
      });
    });

    it('readFile forwards offset and limit when given', async () => {
      const pending = plugin.readFile('/tmp/a.txt', { offset: 100, limit: 512 });
      expect(surface.requests[0]).toMatchObject({
        type: 'file.read',
        payload: { path: '/tmp/a.txt', offset: 100, limit: 512 },
      });

      surface.resolveNext('file.read', {
        path: '/tmp/a.txt',
        content: 'Yg==',
        mime_type: 'text/plain',
        offset: 100,
        total_size: 600,
        has_more: true,
      });
      await expect(pending).resolves.toMatchObject({ offset: 100, total_size: 600, has_more: true });
    });

    it('writeFile passes base64 content through unchanged', async () => {
      const pending = plugin.writeFile('/tmp/a.txt', 'aGVsbG8=');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.write',
        payload: { path: '/tmp/a.txt', content: 'aGVsbG8=' },
      });

      surface.resolveNext('file.write', { path: '/tmp/a.txt', written: 5 });
      await expect(pending).resolves.toEqual({ path: '/tmp/a.txt', written: 5 });
    });

    it('deleteFile defaults recursive to false', async () => {
      const pending = plugin.deleteFile('/tmp/a.txt');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.delete',
        payload: { path: '/tmp/a.txt', recursive: false },
      });

      surface.resolveNext('file.delete', { path: '/tmp/a.txt', success: true });
      await expect(pending).resolves.toEqual({ path: '/tmp/a.txt', success: true });
    });

    it('deleteFile forwards recursive when requested', async () => {
      const pending = plugin.deleteFile('/tmp/dir', true);
      expect(surface.requests[0]?.payload).toEqual({ path: '/tmp/dir', recursive: true });
      surface.resolveNext('file.delete', { path: '/tmp/dir', success: false, error: 'busy' });
      await expect(pending).resolves.toEqual({ path: '/tmp/dir', success: false, error: 'busy' });
    });

    it('createDir sends file.create_dir with the path', async () => {
      const pending = plugin.createDir('/tmp/newdir');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.create_dir',
        payload: { path: '/tmp/newdir' },
      });

      surface.resolveNext('file.create_dir', { path: '/tmp/newdir', success: true });
      await expect(pending).resolves.toEqual({ path: '/tmp/newdir', success: true });
    });

    it('renameFile sends file.rename with from and to', async () => {
      const pending = plugin.renameFile('/tmp/a.txt', '/tmp/b.txt');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.rename',
        payload: { from: '/tmp/a.txt', to: '/tmp/b.txt' },
      });

      surface.resolveNext('file.rename', { from: '/tmp/a.txt', to: '/tmp/b.txt', success: true });
      await expect(pending).resolves.toEqual({ from: '/tmp/a.txt', to: '/tmp/b.txt', success: true });
    });

    it('getCwd sends file.cwd with the session id', async () => {
      const pending = plugin.getCwd('a1:work');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.cwd',
        payload: { session_id: 'a1:work' },
      });

      surface.resolveNext('file.cwd', { path: '/home/agent' });
      await expect(pending).resolves.toEqual({ path: '/home/agent' });
    });

    it('propagates transport rejections', async () => {
      const pending = plugin.listDir('/');
      surface.rejectNext('file.list', new Error('Connection lost'));
      await expect(pending).rejects.toThrow('Connection lost');
    });

    it('uploadFile reads the file and sends its base64 payload', async () => {
      const file = new File(['payload'], 'data.bin', { type: 'text/plain' });
      const pending = plugin.uploadFile('/remote/data.bin', file);
      await vi.waitFor(() => expect(surface.requests).toHaveLength(1));
      expect(surface.requests[0]).toMatchObject({
        type: 'file.write',
        payload: { path: '/remote/data.bin', content: 'cGF5bG9hZA==' },
      });

      surface.resolveNext('file.write', { path: '/remote/data.bin', written: 7 });
      await expect(pending).resolves.toEqual({ path: '/remote/data.bin', written: 7 });
    });

    it('uploadFile rejects when the transport write fails', async () => {
      const file = new File(['x'], 'x.bin');
      const pending = plugin.uploadFile('/remote/x.bin', file);
      await vi.waitFor(() => expect(surface.requests).toHaveLength(1));

      surface.rejectNext('file.write', new Error('Connection lost'));
      await expect(pending).rejects.toThrow('Connection lost');
    });
  });

  describe('toFileOps adapter', () => {
    beforeEach(() => {
      plugin.install(surface);
    });

    it('writeFile base64-encodes plaintext content before sending', async () => {
      const ops = plugin.toFileOps();
      const pending = ops.writeFile('/tmp/a.txt', 'héllo');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.write',
        payload: { path: '/tmp/a.txt', content: base64Encode('héllo') },
      });

      surface.resolveNext('file.write', { path: '/tmp/a.txt', written: 7 });
      await expect(pending).resolves.toEqual({ path: '/tmp/a.txt', written: 7 });
    });

    it('delegates the remaining methods and exposes the base64 helpers', async () => {
      const ops = plugin.toFileOps();

      // Settled requests leave the recorded array — every next request is index 0.
      const pendingList = ops.listDir('/');
      expect(surface.requests[0]).toMatchObject({ type: 'file.list', payload: { path: '/' } });
      surface.resolveNext('file.list', { entries: [] });
      await expect(pendingList).resolves.toEqual({ entries: [] });

      const pendingRead = ops.readFile('/a', { offset: 1, limit: 2 });
      expect(surface.requests[0]).toMatchObject({
        type: 'file.read',
        payload: { path: '/a', offset: 1, limit: 2 },
      });
      surface.resolveNext('file.read', { path: '/a', content: 'YQ==', mime_type: 'text/plain' });
      await expect(pendingRead).resolves.toEqual({ path: '/a', content: 'YQ==', mime_type: 'text/plain' });

      const pendingDelete = ops.deleteFile('/a');
      expect(surface.requests[0]).toMatchObject({
        type: 'file.delete',
        payload: { path: '/a', recursive: false },
      });
      surface.resolveNext('file.delete', { path: '/a', success: true });
      await expect(pendingDelete).resolves.toEqual({ path: '/a', success: true });

      const pendingMkdir = ops.createDir('/d');
      expect(surface.requests[0]).toMatchObject({ type: 'file.create_dir', payload: { path: '/d' } });
      surface.resolveNext('file.create_dir', { path: '/d', success: true });
      await expect(pendingMkdir).resolves.toEqual({ path: '/d', success: true });

      const pendingRename = ops.renameFile('/a', '/b');
      expect(surface.requests[0]).toMatchObject({ type: 'file.rename', payload: { from: '/a', to: '/b' } });
      surface.resolveNext('file.rename', { from: '/a', to: '/b', success: true });
      await expect(pendingRename).resolves.toEqual({ from: '/a', to: '/b', success: true });

      const pendingCwd = ops.getCwd('sess-1');
      expect(surface.requests[0]).toMatchObject({ type: 'file.cwd', payload: { session_id: 'sess-1' } });
      surface.resolveNext('file.cwd', { path: '/cwd' });
      await expect(pendingCwd).resolves.toEqual({ path: '/cwd' });

      expect(ops.base64Encode('hello')).toBe('aGVsbG8=');
      expect(ops.base64Decode('aGVsbG8=')).toBe('hello');
    });
  });

  describe('unbound plugin', () => {
    it('rejects every method with "files feature is not connected" and sends nothing', async () => {
      await expect(plugin.listDir('/')).rejects.toThrow('files feature is not connected');
      await expect(plugin.readFile('/a')).rejects.toThrow('files feature is not connected');
      await expect(plugin.writeFile('/a', 'YQ==')).rejects.toThrow('files feature is not connected');
      await expect(plugin.deleteFile('/a')).rejects.toThrow('files feature is not connected');
      await expect(plugin.createDir('/d')).rejects.toThrow('files feature is not connected');
      await expect(plugin.renameFile('/a', '/b')).rejects.toThrow('files feature is not connected');
      await expect(plugin.getCwd('sess-1')).rejects.toThrow('files feature is not connected');
      expect(surface.requests).toHaveLength(0);
    });
  });
});
