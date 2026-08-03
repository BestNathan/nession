import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventPlugin, decodeTerminalData } from '../EventPlugin';
import type { WebSocketServiceCore } from '../../types';

/**
 * Build a mock core that records message handlers registered via onMessage.
 * The returned `fireMessage` helper lets tests invoke those handlers.
 */
function createMockCore(): { core: WebSocketServiceCore; fireMessage: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    core: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
      isAuthenticated: vi.fn(() => true),
      getConnectionStatus: vi.fn(() => 'authenticated' as const),
      onConnectionChange: vi.fn(() => vi.fn()),
      send: vi.fn(),
      onMessage: vi.fn((type: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(type)) {
          handlers.set(type, new Set());
        }
        handlers.get(type)!.add(handler);
        return () => {
          const set = handlers.get(type);
          if (set) {
            set.delete(handler);
          }
        };
      }),
      request: vi.fn(),
      generateMessageId: vi.fn(() => 'msg_ep_1'),
      getP2PConnectionInfo: vi.fn(),
    },
    fireMessage: (type: string, payload: unknown) => {
      const set = handlers.get(type);
      if (set) {
        set.forEach((h) => h(payload));
      }
    },
  };
}

describe('decodeTerminalData', () => {
  it('decodes base64 to raw bytes', () => {
    const result = decodeTerminalData(btoa('hello world'));
    expect([...result]).toEqual([104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100]);
  });

  it('returns empty Uint8Array for empty input', () => {
    expect(decodeTerminalData('')).toHaveLength(0);
  });

  it('falls back to UTF-8 encode when base64 decoding fails', () => {
    const result = decodeTerminalData('\x00\x01\x02');
    expect(ArrayBuffer.isView(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('roundtrips bytes correctly', () => {
    const input = 'ls -la /tmp';
    const encoded = btoa(input);
    const result = decodeTerminalData(encoded);
    expect([...result]).toEqual([...new TextEncoder().encode(input)]);
  });
});

describe('EventPlugin', () => {
  let plugin: EventPlugin;
  let core: WebSocketServiceCore;
  let fireMessage: (type: string, payload: unknown) => void;

  beforeEach(() => {
    plugin = new EventPlugin();
    const mock = createMockCore();
    core = mock.core;
    fireMessage = mock.fireMessage;
    vi.clearAllMocks();
    plugin.install(core); // install AFTER clearAllMocks so mock.calls reflect install
  });

  it('has name "events"', () => {
    expect(plugin.name).toBe('events');
  });

  describe('install registers handlers', () => {
    it('registers for all expected message types', () => {
      const registeredTypes = (core.onMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0],
      );
      expect(registeredTypes).toContain('client.agents.list.response');
      expect(registeredTypes).toContain('client.sessions.list.response');
      expect(registeredTypes).toContain('terminal.output');
      expect(registeredTypes).toContain('terminal.resize');
      expect(registeredTypes).toContain('agents.changed');
      expect(registeredTypes).toContain('sessions.changed');
      expect(registeredTypes).toContain('server.commands.changed');
    });
  });

  describe('callback subscription', () => {
    it('onAgentsChanged returns unsubscribe', () => {
      const cb = vi.fn();
      const unsub = plugin.onAgentsChanged(cb);
      expect(typeof unsub).toBe('function');
    });

    it('onSessionsChanged returns unsubscribe', () => {
      const cb = vi.fn();
      const unsub = plugin.onSessionsChanged(cb);
      expect(typeof unsub).toBe('function');
    });

    it('onCommandsChanged returns unsubscribe', () => {
      const cb = vi.fn();
      const unsub = plugin.onCommandsChanged(cb);
      expect(typeof unsub).toBe('function');
    });

    it('onTerminalOutput returns unsubscribe', () => {
      const cb = vi.fn();
      const unsub = plugin.onTerminalOutput('s1', cb);
      expect(typeof unsub).toBe('function');
    });

    it('onTerminalResize returns unsubscribe', () => {
      const cb = vi.fn();
      const unsub = plugin.onTerminalResize('s1', cb);
      expect(typeof unsub).toBe('function');
    });
  });

  describe('message handling', () => {
    it('client.agents.list.response triggers agents callbacks', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      const agents = [{ agent_id: 'a1' }];
      fireMessage('client.agents.list.response', { agents });
      expect(cb).toHaveBeenCalledWith(agents);
    });

    it('client.sessions.list.response triggers sessions callbacks', () => {
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      const sessions = [{ session_id: 's1' }];
      fireMessage('client.sessions.list.response', { sessions });
      expect(cb).toHaveBeenCalledWith(sessions);
    });

    it('agents.changed triggers agents callbacks', () => {
      const cb = vi.fn();
      plugin.onAgentsChanged(cb);
      const agents = [{ agent_id: 'a1' }];
      fireMessage('agents.changed', { agents });
      expect(cb).toHaveBeenCalledWith(agents);
    });

    it('sessions.changed triggers sessions callbacks', () => {
      const cb = vi.fn();
      plugin.onSessionsChanged(cb);
      const sessions = [{ session_id: 's1' }];
      fireMessage('sessions.changed', { sessions });
      expect(cb).toHaveBeenCalledWith(sessions);
    });

    it('server.commands.changed triggers commands callbacks', () => {
      const cb = vi.fn();
      plugin.onCommandsChanged(cb);
      fireMessage('server.commands.changed', {});
      expect(cb).toHaveBeenCalled();
    });

    it('terminal.output in P2P mode (has session_id) dispatches as Uint8Array', () => {
      const cb = vi.fn();
      plugin.onTerminalOutput('s1', cb);
      fireMessage('terminal.output', { session_id: 's1', data: 'hello' });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(ArrayBuffer.isView(cb.mock.calls[0][0])).toBe(true);
      expect([...cb.mock.calls[0][0] as ArrayLike<number>]).toEqual([104, 101, 108, 108, 111]);
    });

    it('terminal.output in relay mode (has session_name, base64 data) decodes to Uint8Array', () => {
      const cb = vi.fn();
      plugin.onTerminalOutput('my-session', cb);
      const encoded = btoa('decoded-text');
      fireMessage('terminal.output', { session_name: 'my-session', data: encoded });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(ArrayBuffer.isView(cb.mock.calls[0][0])).toBe(true);
      expect([...cb.mock.calls[0][0] as ArrayLike<number>]).toEqual([...new TextEncoder().encode('decoded-text')]);
    });

    it('terminal.resize dispatches cols/rows to callbacks', () => {
      const cb = vi.fn();
      plugin.onTerminalResize('s1', cb);
      fireMessage('terminal.resize', { session_id: 's1', cols: 120, rows: 40 });
      expect(cb).toHaveBeenCalledWith(120, 40);
    });

    it('terminal.resize with session_name works', () => {
      const cb = vi.fn();
      plugin.onTerminalResize('relay-session', cb);
      fireMessage('terminal.resize', { session_name: 'relay-session', cols: 80, rows: 24 });
      expect(cb).toHaveBeenCalledWith(80, 24);
    });

    it('ignores messages for sessions with no callbacks', () => {
      // Should not throw when no callbacks registered for the session
      expect(() => {
        fireMessage('terminal.output', { session_id: 'unknown', data: 'x' });
        fireMessage('terminal.resize', { session_id: 'unknown', cols: 1, rows: 1 });
      }).not.toThrow();
    });
  });

  describe('unsubscribe', () => {
    it('unsubscribing stops callbacks', () => {
      const cb = vi.fn();
      const unsub = plugin.onCommandsChanged(cb);
      unsub();
      fireMessage('server.commands.changed', {});
      expect(cb).not.toHaveBeenCalled();
    });

    it('unsubscribing terminal output for one session does not affect others', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = plugin.onTerminalOutput('s1', cb1);
      plugin.onTerminalOutput('s2', cb2);
      unsub1();
      fireMessage('terminal.output', { session_id: 's1', data: 'x' });
      fireMessage('terminal.output', { session_id: 's2', data: 'y' });
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledTimes(1);
      expect([...cb2.mock.calls[0][0] as ArrayLike<number>]).toEqual([121]);
    });
  });
});
