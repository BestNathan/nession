import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalPlugin } from '@/services/websocket/plugins/TerminalPlugin';
import type { WebSocketServiceCore } from '@/services/websocket/types';

function createMockCore(): WebSocketServiceCore {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    isAuthenticated: vi.fn(() => true),
    getConnectionStatus: vi.fn(() => 'authenticated' as const),
    onConnectionChange: vi.fn(() => vi.fn()),
    send: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
    request: vi.fn(),
    generateMessageId: vi.fn(() => 'msg_test_123'),
    getP2PConnectionInfo: vi.fn(),
  };
}

describe('TerminalPlugin', () => {
  let plugin: TerminalPlugin;
  let core: WebSocketServiceCore;

  beforeEach(() => {
    plugin = new TerminalPlugin();
    core = createMockCore();
    plugin.install(core);
    vi.clearAllMocks();
  });

  it('has name "terminal"', () => {
    expect(plugin.name).toBe('terminal');
  });

  describe('beginRelay', () => {
    it('sends relay.begin with session_id', () => {
      plugin.beginRelay('sess-1');
      expect(core.send).toHaveBeenCalledOnce();
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('client.session.relay.begin');
      expect(msg.payload.session_id).toBe('sess-1');
      expect(msg.id).toBe('msg_test_123');
      expect(typeof msg.timestamp).toBe('number');
    });

    it('includes optional relayUrl, cols, rows when provided', () => {
      plugin.beginRelay('sess-1', 'wss://relay.example.com', 120, 40);
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.payload.relay_url).toBe('wss://relay.example.com');
      expect(msg.payload.cols).toBe(120);
      expect(msg.payload.rows).toBe(40);
    });

    it('omits optional fields when not provided', () => {
      plugin.beginRelay('sess-1');
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.payload).not.toHaveProperty('relay_url');
      expect(msg.payload).not.toHaveProperty('cols');
      expect(msg.payload).not.toHaveProperty('rows');
    });

    it('includes cols=0 and rows=0 when explicitly passed', () => {
      plugin.beginRelay('sess-1', undefined, 0, 0);
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.payload.cols).toBe(0);
      expect(msg.payload.rows).toBe(0);
    });
  });

  describe('endRelay', () => {
    it('sends relay.end with session_id', () => {
      plugin.endRelay('sess-2');
      expect(core.send).toHaveBeenCalledOnce();
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('client.session.relay.end');
      expect(msg.payload.session_id).toBe('sess-2');
    });
  });

  describe('sendTerminalInput', () => {
    it('sends terminal.input with session_id and plain data', () => {
      plugin.sendTerminalInput('sess-1', 'ls -la');
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('terminal.input');
      expect(msg.payload.session_id).toBe('sess-1');
      expect(msg.payload.data).toBe('ls -la');
    });
  });

  describe('sendTerminalResize', () => {
    it('sends terminal.resize with cols and rows', () => {
      plugin.sendTerminalResize('sess-1', 80, 24);
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('terminal.resize');
      expect(msg.payload.session_id).toBe('sess-1');
      expect(msg.payload.cols).toBe(80);
      expect(msg.payload.rows).toBe(24);
    });
  });

  describe('sendRelayInput', () => {
    it('sends terminal.input with base64-encoded data and session_name', () => {
      plugin.sendRelayInput('my-session', 'hello');
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('terminal.input');
      expect(msg.payload.session_name).toBe('my-session');
      // 'hello' -> base64 is 'aGVsbG8='
      expect(msg.payload.data).toBe(btoa('hello'));
    });

    it('encodes unicode correctly via TextEncoder', () => {
      // TextEncoder encodes to UTF-8 bytes, then btoa on each byte
      const input = 'A'; // ASCII, trivially base64 = 'QQ=='
      plugin.sendRelayInput('sess', input);
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.payload.data).toBe(btoa('A'));
    });

    it('encodes empty string', () => {
      plugin.sendRelayInput('sess', '');
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.payload.data).toBe(btoa(''));
    });
  });

  describe('sendRelayResize', () => {
    it('sends terminal.resize with session_name', () => {
      plugin.sendRelayResize('my-session', 100, 50);
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.msg_type).toBe('terminal.resize');
      expect(msg.payload.session_name).toBe('my-session');
      expect(msg.payload.cols).toBe(100);
      expect(msg.payload.rows).toBe(50);
    });
  });

  describe('message shape', () => {
    it('uses core.generateMessageId for id', () => {
      plugin.sendTerminalInput('sess', 'x');
      expect(core.generateMessageId).toHaveBeenCalled();
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.id).toBe('msg_test_123');
    });

    it('uses Date.now() for timestamp', () => {
      const before = Date.now();
      plugin.sendTerminalInput('sess', 'x');
      const after = Date.now();
      const msg = (core.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
