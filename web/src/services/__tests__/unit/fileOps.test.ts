import { describe, it, expect, vi } from 'vitest';
import { createFileOps } from '@/services/fileOps';
import type { P2PConnection, P2PMessage } from '@/hooks/useP2PConnection';

interface MockP2P extends P2PConnection {
  _respond: (id: string, msgType: string, payload: unknown) => void;
}

/**
 * Flush pending microtasks. sendRequest now awaits waitForConnection() before
 * sending, so the sendMessage call lands on a microtask rather than
 * synchronously — tests must flush before inspecting mock.calls.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeP2PConnection(state: P2PConnection['connectionState'] = 'connected'): MockP2P {
  const handlers = new Set<(msg: P2PMessage) => void>();
  return {
    connectionState: state,
    reconnectAttempt: 0,
    sendMessage: vi.fn(),
    close: vi.fn(),
    waitForConnection: vi.fn(() =>
      state === 'disconnected'
        ? Promise.reject(new Error('Connection lost'))
        : Promise.resolve(),
    ),
    onMessage: vi.fn((handler: (msg: P2PMessage) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    }),
    _respond(id: string, msgType: string, payload: unknown) {
      handlers.forEach((h) => h({ msg_type: msgType, id, timestamp: Date.now(), payload }));
    },
  };
}

describe('fileOps', () => {
  describe('base64 codec', () => {
    it('base64Encode roundtrips through base64Decode', () => {
      const ops = createFileOps(makeP2PConnection());
      const original = 'Hello, World!';
      const encoded = ops.base64Encode(original);
      expect(typeof encoded).toBe('string');
      expect(ops.base64Decode(encoded)).toBe(original);
    });

    it('base64Encode handles empty string', () => {
      const ops = createFileOps(makeP2PConnection());
      expect(ops.base64Decode(ops.base64Encode(''))).toBe('');
    });

    it('base64Encode handles unicode', () => {
      const ops = createFileOps(makeP2PConnection());
      const original = '你好世界 🎉';
      expect(ops.base64Decode(ops.base64Encode(original))).toBe(original);
    });
  });

  describe('listDir', () => {
    it('sends file.list message and resolves with entries', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.listDir('/tmp');
      await flush();
      // Extract the message ID from the send call
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const id = sendCall.id;
      expect(sendCall.msg_type).toBe('file.list');
      expect(sendCall.payload.path).toBe('/tmp');

      p2p._respond(id, 'ok', {
        entries: [{ name: 'test.txt', path: '/tmp/test.txt', is_dir: false, size: 100, modified: 12345 }],
      });
      const result = await promise;
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('test.txt');
    });
  });

  describe('readFile', () => {
    it('sends file.read and resolves with file data', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.readFile('/etc/hosts');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.read');

      p2p._respond(sendCall.id, 'ok', {
        path: '/etc/hosts', content: 'MTI3LjAuMC4x', mime_type: 'text/plain',
      });
      const result = await promise;
      expect(result.path).toBe('/etc/hosts');
      expect(result.content).toBe('MTI3LjAuMC4x');
    });
  });

  describe('writeFile', () => {
    it('sends file.write with base64 content', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.writeFile('/tmp/new.txt', 'hello');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.write');
      expect(sendCall.payload.path).toBe('/tmp/new.txt');
      // Content should be base64-encoded
      expect(sendCall.payload.content).toBe(ops.base64Encode('hello'));

      p2p._respond(sendCall.id, 'ok', { path: '/tmp/new.txt', written: 5 });
      const result = await promise;
      expect(result.written).toBe(5);
    });
  });

  describe('deleteFile', () => {
    it('sends file.delete and resolves', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.deleteFile('/tmp/old.txt');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.delete');

      p2p._respond(sendCall.id, 'ok', { path: '/tmp/old.txt', success: true });
      const result = await promise;
      expect(result.success).toBe(true);
    });

    it('defaults recursive to false', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.deleteFile('/tmp/old.txt');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.payload).toEqual({ path: '/tmp/old.txt', recursive: false });

      p2p._respond(sendCall.id, 'ok', { path: '/tmp/old.txt', success: true });
      await promise;
    });

    it('forwards recursive for directories', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.deleteFile('/tmp/folder', true);
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.payload).toEqual({ path: '/tmp/folder', recursive: true });

      p2p._respond(sendCall.id, 'ok', { path: '/tmp/folder', success: true });
      await promise;
    });
  });

  describe('createDir', () => {
    it('sends file.create_dir', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.createDir('/tmp/newdir');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.create_dir');

      p2p._respond(sendCall.id, 'ok', { path: '/tmp/newdir', success: true });
      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  describe('renameFile', () => {
    it('sends file.rename', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.renameFile('/tmp/a', '/tmp/b');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.rename');
      expect(sendCall.payload.from).toBe('/tmp/a');
      expect(sendCall.payload.to).toBe('/tmp/b');

      p2p._respond(sendCall.id, 'ok', { from: '/tmp/a', to: '/tmp/b', success: true });
      const result = await promise;
      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('rejects on error response', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const promise = ops.listDir('/nonexistent');
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];

      p2p._respond(sendCall.id, 'error', { message: 'Not found' });
      await expect(promise).rejects.toThrow('Not found');
    });

    it('rejects when disconnected', async () => {
      const p2p = makeP2PConnection('disconnected');
      const ops = createFileOps(p2p);
      await expect(ops.listDir('/tmp')).rejects.toThrow('Connection lost');
    });

    it('waits for the connection before sending (does not fire while connecting)', async () => {
      // Simulate a socket that starts 'connecting' then resolves once ready —
      // mirrors a fresh P2P attach where FileBrowser loads on mount.
      const handlers = new Set<(msg: P2PMessage) => void>();
      let resolveConn!: () => void;
      const connReady = new Promise<void>((r) => { resolveConn = r; });
      const p2p: MockP2P = {
        connectionState: 'connecting',
        reconnectAttempt: 0,
        sendMessage: vi.fn(),
        close: vi.fn(),
        waitForConnection: vi.fn(() => connReady),
        onMessage: vi.fn((h: (msg: P2PMessage) => void) => {
          handlers.add(h);
          return () => { handlers.delete(h); };
        }),
        _respond(id, msgType, payload) {
          handlers.forEach((h) => h({ msg_type: msgType, id, timestamp: Date.now(), payload }));
        },
      };
      const ops = createFileOps(p2p);

      const promise = ops.listDir('/tmp');
      await flush();
      // Not connected yet → nothing sent.
      expect((p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);

      // Connection becomes ready → request is flushed.
      resolveConn();
      await flush();
      const sendCall = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sendCall.msg_type).toBe('file.list');

      p2p._respond(sendCall.id, 'ok', { entries: [] });
      await expect(promise).resolves.toEqual({ entries: [] });
    });
  });

  describe('uploadFile', () => {
    it('reads file and sends as base64', async () => {
      const p2p = makeP2PConnection();
      const ops = createFileOps(p2p);

      const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });
      const promise = ops.uploadFile('/remote/test.txt', file);

      // Wait for FileReader to complete (async)
      await new Promise((r) => setTimeout(r, 50));

      // Find the file.write send call
      const sendCalls = (p2p.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const writeCall = sendCalls.find((c) => (c[0] as Record<string, unknown>).msg_type === 'file.write');
      expect(writeCall).toBeTruthy();

      // Respond to resolve
      const callId = writeCall![0].id;
      p2p._respond(callId, 'ok', { path: '/remote/test.txt', written: 11 });

      const result = await promise;
      expect(result.written).toBe(11);
    });
  });
});
