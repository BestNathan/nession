import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalServerPlugin, decodeTerminalData, terminalServerApi } from '@/features/terminal';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

function b64Bytes(bytes: number[]): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe('decodeTerminalData', () => {
  it('returns an empty byte array for an empty string', () => {
    expect(decodeTerminalData('')).toEqual(new Uint8Array(0));
  });

  it('decodes valid base64 to raw bytes', () => {
    expect(decodeTerminalData('aGVsbG8=')).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it('falls back to UTF-8 encoding when the frame is not valid base64', () => {
    expect(decodeTerminalData('not base64 !!')).toEqual(new TextEncoder().encode('not base64 !!'));
  });
});

describe('TerminalServerPlugin', () => {
  let surface: MockPluginSurface;
  let plugin: TerminalServerPlugin;

  beforeEach(() => {
    surface = createMockPluginSurface();
    plugin = new TerminalServerPlugin();
    plugin.install(surface);
  });

  it('exposes the "terminal-server" capability name', () => {
    expect(plugin.name).toBe('terminal-server');
  });

  describe('relay lifecycle sends', () => {
    it('beginRelay sends client.session.relay.begin with just the session id', () => {
      plugin.beginRelay('sess-1');

      expect(surface.sent).toEqual([
        { type: 'client.session.relay.begin', payload: { session_id: 'sess-1' } },
      ]);
    });

    it('beginRelay includes relay_url and the viewport only when given', () => {
      plugin.beginRelay('sess-1', 'ws://agent:19090/ws', 120, 40);

      expect(surface.sent).toEqual([
        {
          type: 'client.session.relay.begin',
          payload: { session_id: 'sess-1', relay_url: 'ws://agent:19090/ws', cols: 120, rows: 40 },
        },
      ]);
    });

    it('beginRelay omits relay_url when absent and rows when only cols is given', () => {
      plugin.beginRelay('sess-1', undefined, 100);

      expect(surface.sent).toEqual([
        { type: 'client.session.relay.begin', payload: { session_id: 'sess-1', cols: 100 } },
      ]);
    });

    it('endRelay sends client.session.relay.end with the session id', () => {
      plugin.endRelay('sess-1');

      expect(surface.sent).toEqual([
        { type: 'client.session.relay.end', payload: { session_id: 'sess-1' } },
      ]);
    });

    it('sendRelayInput base64-wraps the data under the short session name', () => {
      plugin.sendRelayInput('work', 'hello');

      expect(surface.sent).toEqual([
        { type: 'terminal.input', payload: { session_name: 'work', data: 'aGVsbG8=' } },
      ]);
    });

    it('sendRelayResize sends terminal.resize with cols/rows', () => {
      plugin.sendRelayResize('work', 120, 40);

      expect(surface.sent).toEqual([
        { type: 'terminal.resize', payload: { session_name: 'work', cols: 120, rows: 40 } },
      ]);
    });
  });

  describe('onRelayOutput', () => {
    it('routes relay frames per session_name and decodes base64 to raw bytes', () => {
      const cbWork = vi.fn();
      const cbOther = vi.fn();
      plugin.onRelayOutput('work', cbWork);
      plugin.onRelayOutput('other', cbOther);

      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGVsbG8=' });
      expect(cbWork).toHaveBeenCalledTimes(1);
      expect(cbWork.mock.calls[0]?.[0]).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
      expect(cbOther).not.toHaveBeenCalled();

      surface.pushMessage('terminal.output', { session_name: 'other', data: 'aGk=' });
      expect(cbOther.mock.calls[0]?.[0]).toEqual(new Uint8Array([104, 105]));
    });

    it('routes by session_id when the frame carries no session_name (non-relay decode)', () => {
      const cb = vi.fn();
      plugin.onRelayOutput('direct', cb);

      surface.pushMessage('terminal.output', { session_id: 'direct', data: 'aGk=' });

      // Non-relay frames carry a plain byte string — no base64 decoding.
      expect(cb.mock.calls[0]?.[0]).toEqual(new TextEncoder().encode('aGk='));
    });

    it('preserves non-UTF-8 octets through relay decode', () => {
      const cb = vi.fn();
      plugin.onRelayOutput('work', cb);

      surface.pushMessage('terminal.output', { session_name: 'work', data: b64Bytes([104, 105, 200]) });

      expect(cb.mock.calls[0]?.[0]).toEqual(new Uint8Array([104, 105, 200]));
    });

    it('falls back to UTF-8 for a relay frame with invalid base64', () => {
      const cb = vi.fn();
      plugin.onRelayOutput('work', cb);

      surface.pushMessage('terminal.output', { session_name: 'work', data: '!!!' });

      expect(cb.mock.calls[0]?.[0]).toEqual(new Uint8Array([33, 33, 33]));
    });

    it('delivers an empty byte array for an empty data frame', () => {
      const cb = vi.fn();
      plugin.onRelayOutput('work', cb);

      surface.pushMessage('terminal.output', { session_name: 'work', data: '' });

      expect(cb.mock.calls[0]?.[0]).toEqual(new Uint8Array(0));
    });

    it('fires every callback registered for the session', () => {
      const cbOne = vi.fn();
      const cbTwo = vi.fn();
      plugin.onRelayOutput('work', cbOne);
      plugin.onRelayOutput('work', cbTwo);

      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });

      expect(cbOne).toHaveBeenCalledTimes(1);
      expect(cbTwo).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe removes only that callback; the last one empties the key', () => {
      const cbOne = vi.fn();
      const cbTwo = vi.fn();
      const unsubOne = plugin.onRelayOutput('work', cbOne);
      plugin.onRelayOutput('work', cbTwo);

      unsubOne();
      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });
      expect(cbOne).not.toHaveBeenCalled();
      expect(cbTwo).toHaveBeenCalledTimes(1);

      cbTwo.mockClear();
      const reSub = vi.fn();
      plugin.onRelayOutput('work', reSub);
      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });
      expect(cbTwo).toHaveBeenCalledTimes(1);
      expect(reSub).toHaveBeenCalledTimes(1);
    });
  });

  describe('onRelayResize', () => {
    it('routes resize frames per session with cols/rows passthrough', () => {
      const cbWork = vi.fn();
      const cbOther = vi.fn();
      plugin.onRelayResize('work', cbWork);
      plugin.onRelayResize('other', cbOther);

      surface.pushMessage('terminal.resize', { session_name: 'work', cols: 150, rows: 50 });
      expect(cbWork).toHaveBeenCalledWith(150, 50);
      expect(cbOther).not.toHaveBeenCalled();

      surface.pushMessage('terminal.resize', { session_name: 'other', cols: 90, rows: 30 });
      expect(cbOther).toHaveBeenCalledWith(90, 30);
    });

    it('coalesces missing dimensions to zero', () => {
      const cb = vi.fn();
      plugin.onRelayResize('work', cb);

      surface.pushMessage('terminal.resize', { session_name: 'work' });

      expect(cb).toHaveBeenCalledWith(0, 0);
    });
  });

  describe('binding lifecycle', () => {
    it('double-mount replaces the binding; stale teardown keeps the newer one live', () => {
      const surfaceA = createMockPluginSurface();
      const surfaceB = createMockPluginSurface();

      const teardownA = plugin.install(surfaceA);
      const staleCb = vi.fn();
      plugin.onRelayOutput('work', staleCb);

      const teardownB = plugin.install(surfaceB); // replace semantics — no throw
      teardownA(); // stale release from the old generation

      const liveCb = vi.fn();
      plugin.onRelayOutput('work', liveCb);
      plugin.beginRelay('sess-1');
      expect(surfaceA.sent).toHaveLength(0);
      expect(surfaceB.sent).toHaveLength(1);

      // The stale teardown dropped the old generation's consumers; only the
      // new binding's subscribers are notified.
      surfaceA.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });
      surfaceB.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });
      expect(staleCb).not.toHaveBeenCalled();
      expect(liveCb).toHaveBeenCalledTimes(1);

      teardownB();
      expect(() => plugin.beginRelay('sess-1')).toThrow('terminal-server feature is not connected');
    });

    it('teardown is idempotent', () => {
      const teardown = plugin.install(surface);
      expect(() => {
        teardown();
        teardown();
      }).not.toThrow();
    });

    it('teardown clears consumers registered on the released binding', () => {
      const teardown = plugin.install(surface);
      const staleCb = vi.fn();
      plugin.onRelayOutput('work', staleCb);
      teardown();

      const surface2 = createMockPluginSurface();
      plugin.install(surface2);
      const liveCb = vi.fn();
      plugin.onRelayOutput('work', liveCb);

      surface2.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });

      expect(staleCb).not.toHaveBeenCalled();
      expect(liveCb).toHaveBeenCalledTimes(1);
    });
  });

  describe('unbound plugin', () => {
    it('throws "terminal-server feature is not connected" and sends nothing', () => {
      const fresh = new TerminalServerPlugin();

      expect(() => fresh.beginRelay('s')).toThrow('terminal-server feature is not connected');
      expect(() => fresh.endRelay('s')).toThrow('terminal-server feature is not connected');
      expect(() => fresh.sendRelayInput('s', 'x')).toThrow('terminal-server feature is not connected');
      expect(() => fresh.sendRelayResize('s', 1, 1)).toThrow('terminal-server feature is not connected');
      expect(surface.sent).toHaveLength(0);
    });
  });

  describe('terminalServerApi singleton', () => {
    it('is a TerminalServerPlugin bound for the application server connection', () => {
      expect(terminalServerApi).toBeInstanceOf(TerminalServerPlugin);
      expect(terminalServerApi.name).toBe('terminal-server');
    });
  });
});
