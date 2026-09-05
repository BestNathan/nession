import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACH_TIMEOUT_MS, createTerminalAgentApi, type TerminalAgentApi } from '@/features/terminal';
import { createMockPluginSurface, type MockPluginSurface } from '@/test/mockPluginSurface';

describe('createTerminalAgentApi', () => {
  let surface: MockPluginSurface;
  let api: TerminalAgentApi;

  beforeEach(() => {
    surface = createMockPluginSurface();
    api = createTerminalAgentApi(surface);
  });

  describe('attach', () => {
    it('requests client.attach with session_name and the viewport as width/height', async () => {
      const pending = api.attach('work', { cols: 120, rows: 40 });
      expect(surface.requests[0]).toMatchObject({
        type: 'client.attach',
        payload: { session_name: 'work', width: 120, height: 40 },
        options: { timeoutMs: ATTACH_TIMEOUT_MS },
      });

      surface.resolveNext('client.attach', {});
      await expect(pending).resolves.toEqual({ ok: true });
    });

    it('honors a custom timeout', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 }, { timeoutMs: 500 });
      expect(surface.requests[0]?.payload).toEqual({ session_name: 'work', width: 80, height: 24 });
      expect(surface.requests[0]?.options).toEqual({ timeoutMs: 500 });

      surface.resolveNext('client.attach', {});
      await expect(pending).resolves.toEqual({ ok: true });
    });

    it('maps a remote error ack to { ok: false, error } instead of throwing', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('client.attach', new Error('no such session'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'no such session' });
    });

    it('maps a request timeout to { ok: false, error: "timeout" }', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('client.attach', new Error('Request timeout: client.attach'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    });

    it('passes through agent error prose that merely mentions "timeout"', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('client.attach', new Error('agent: attach timed out while starting'));

      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'agent: attach timed out while starting',
      });
    });

    it('never rejects — any transport failure converges into an AttachResult', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('client.attach', new Error('Connection lost'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'Connection lost' });
    });
  });

  describe('sendInput', () => {
    it('sends terminal.input under the short session name with base64 data', () => {
      api.sendInput('work', 'hello');

      expect(surface.sent).toEqual([
        { type: 'terminal.input', payload: { session_name: 'work', data: 'aGVsbG8=' } },
      ]);
    });
  });

  describe('sendResize', () => {
    it('sends terminal.resize with cols/rows for the session', () => {
      api.sendResize('work', 120, 40);

      expect(surface.sent).toEqual([
        { type: 'terminal.resize', payload: { session_name: 'work', cols: 120, rows: 40 } },
      ]);
    });
  });

  describe('onOutput', () => {
    it('decodes base64 frames to raw bytes', () => {
      const cb = vi.fn();
      api.onOutput(cb);

      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGVsbG8=' });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0]).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    it('skips frames without data (no decode, no callback)', () => {
      const cb = vi.fn();
      api.onOutput(cb);

      surface.pushMessage('terminal.output', { session_name: 'work', data: '' });
      surface.pushMessage('terminal.output', { session_name: 'work' });

      expect(cb).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', () => {
      const cb = vi.fn();
      const unsub = api.onOutput(cb);
      unsub();

      surface.pushMessage('terminal.output', { session_name: 'work', data: 'aGk=' });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onResize', () => {
    it('passes cols/rows through from terminal.resize frames', () => {
      const cb = vi.fn();
      api.onResize(cb);

      surface.pushMessage('terminal.resize', { session_name: 'work', cols: 150, rows: 50 });

      expect(cb).toHaveBeenCalledWith(150, 50);
    });

    it('stops delivering after unsubscribe', () => {
      const cb = vi.fn();
      const unsub = api.onResize(cb);
      unsub();

      surface.pushMessage('terminal.resize', { session_name: 'work', cols: 150, rows: 50 });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('ping', () => {
    it('sends keepalive.ping with an empty payload', () => {
      api.ping();

      expect(surface.sent).toEqual([{ type: 'keepalive.ping', payload: {} }]);
    });
  });
});
