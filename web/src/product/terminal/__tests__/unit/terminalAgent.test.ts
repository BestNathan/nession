import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACH_TIMEOUT_MS, createTerminalAgentApi, type TerminalAgentApi } from '@/product/terminal';
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
        type: 'agent.attach',
        payload: { session_name: 'work', width: 120, height: 40 },
        options: { timeoutMs: ATTACH_TIMEOUT_MS },
      });

      surface.resolveNext('agent.attach', {});
      await expect(pending).resolves.toMatchObject({ ok: true, controlRole: 'controller' });
    });

    it('honors a custom timeout', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 }, { timeoutMs: 500 });
      expect(surface.requests[0]?.payload).toEqual({ session_name: 'work', width: 80, height: 24 });
      expect(surface.requests[0]?.options).toEqual({ timeoutMs: 500 });

      surface.resolveNext('agent.attach', {});
      await expect(pending).resolves.toMatchObject({ ok: true, controlRole: 'controller' });
    });

    it('omits width/height when no viewport size is given, and says why', async () => {
      const pending = api.attach('work');
      // Columns left unsent are not "80×24": the payload's own default would
      // put that on the wire and the agent would resize the **shared** window
      // to it and back, repainting an inline-drawing application into the
      // scrollback twice for a size nothing measured (#1265).
      expect(surface.requests[0]?.payload).toEqual({ session_name: 'work', size_known: false });
      expect(surface.requests[0]?.options).toEqual({ timeoutMs: ATTACH_TIMEOUT_MS });

      surface.resolveNext('agent.attach', {});
      await expect(pending).resolves.toMatchObject({ ok: true, controlRole: 'controller' });
    });

    it('maps a remote error ack to { ok: false, error } instead of throwing', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('agent.attach', new Error('no such session'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'no such session' });
    });

    it('maps a request timeout to { ok: false, error: "timeout" }', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('agent.attach', new Error('Request timeout: client.attach'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' });
    });

    it('passes through agent error prose that merely mentions "timeout"', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('agent.attach', new Error('agent: attach timed out while starting'));

      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'agent: attach timed out while starting',
      });
    });

    it('never rejects — any transport failure converges into an AttachResult', async () => {
      const pending = api.attach('work', { cols: 80, rows: 24 });
      surface.rejectNext('agent.attach', new Error('Connection lost'));

      await expect(pending).resolves.toEqual({ ok: false, error: 'Connection lost' });
    });
  });

  describe('sendInput', () => {
    it('sends terminal.input under the short session name with base64 data', () => {
      api.sendInput('work', 'hello');

      expect(surface.sent).toEqual([
        { type: 'agent.terminal.input', payload: { session_name: 'work', data: 'aGVsbG8=' } },
      ]);
    });
  });

  describe('sendResize', () => {
    it('sends terminal.resize with cols/rows for the session', () => {
      api.sendResize('work', 120, 40);

      expect(surface.sent).toEqual([
        { type: 'agent.terminal.resize', payload: { session_name: 'work', cols: 120, rows: 40 } },
      ]);
    });
  });

  describe('onOutput', () => {
    it('decodes base64 frames to raw bytes', () => {
      const cb = vi.fn();
      api.onOutput(cb);

      surface.pushMessage('agent.terminal.output', { session_name: 'work', data: 'aGVsbG8=' });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0].data).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    it('skips frames without data (no decode, no callback)', () => {
      const cb = vi.fn();
      api.onOutput(cb);

      surface.pushMessage('agent.terminal.output', { session_name: 'work', data: '' });
      surface.pushMessage('agent.terminal.output', { session_name: 'work' });

      expect(cb).not.toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', () => {
      const cb = vi.fn();
      const unsub = api.onOutput(cb);
      unsub();

      surface.pushMessage('agent.terminal.output', { session_name: 'work', data: 'aGk=' });

      expect(cb).not.toHaveBeenCalled();
    });

    it('carries the bootstrap marker with the metadata that qualifies it (#1305)', () => {
      const cb = vi.fn();
      api.onOutput(cb);

      surface.pushMessage('agent.terminal.output', {
        session_name: 'work',
        data: 'aGk=',
        bootstrap: { requested_lines: 5000, truncated: true },
      });
      surface.pushMessage('agent.terminal.output', { session_name: 'work', data: 'aGk=' });

      // Whether the agent had to cut the snapshot short decides whether the
      // consumer may replace its buffer with it — a fact this decode step used
      // to throw away by collapsing the payload to `true`.
      expect(cb.mock.calls[0]?.[0].bootstrap).toEqual({ requestedLines: 5000, truncated: true });
      // A live frame says `undefined`, which is not a marker with no contents:
      // absence is the only thing that means "append" (#321).
      expect(cb.mock.calls[1]?.[0].bootstrap).toBeUndefined();
    });
  });

  describe('onResize', () => {
    it('passes cols/rows through from terminal.resize frames', () => {
      const cb = vi.fn();
      api.onResize(cb);

      surface.pushMessage('agent.terminal.resize', { session_name: 'work', cols: 150, rows: 50 });

      expect(cb).toHaveBeenCalledWith({ cols: 150, rows: 50 });
    });

    it('surfaces the stream position of a recorded resize (#1303)', () => {
      // A resize the agent logged consumed a sequence number, and the client
      // cannot place it without one — the decode is where a position the agent
      // sent is either carried through or thrown away.
      const cb = vi.fn();
      api.onResize(cb);

      surface.pushMessage('agent.terminal.resize', {
        session_name: 'work',
        cols: 150,
        rows: 50,
        stream_epoch: 1_790_771_445_798_089,
        stream_seq: 7,
      });

      expect(cb).toHaveBeenCalledWith({
        cols: 150,
        rows: 50,
        streamEpoch: 1_790_771_445_798_089,
        streamSeq: 7,
      });
    });

    it('reads a half-written position as the level it still is (#1303)', () => {
      // The agent sets both fields together, so one without the other is not a
      // position — and half-applying it would put a resize in the timeline at
      // a sequence number nothing can be ordered against.
      const cb = vi.fn();
      api.onResize(cb);

      surface.pushMessage('agent.terminal.resize', {
        session_name: 'work',
        cols: 150,
        rows: 50,
        stream_seq: 7,
      });

      expect(cb).toHaveBeenCalledWith({ cols: 150, rows: 50 });
    });

    it('stops delivering after unsubscribe', () => {
      const cb = vi.fn();
      const unsub = api.onResize(cb);
      unsub();

      surface.pushMessage('agent.terminal.resize', { session_name: 'work', cols: 150, rows: 50 });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('onError', () => {
    it('delivers agent error frames with the message and the notAttached flag', () => {
      const cb = vi.fn();
      api.onError(cb);

      surface.pushMessage('error', { message: 'no such session: work' });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]?.[0]).toEqual({ message: 'no such session: work', notAttached: false });

      surface.pushMessage('error', { message: 'not attached to session: work' });
      expect(cb).toHaveBeenCalledTimes(2);
      expect(cb.mock.calls[1]?.[0]).toEqual({
        message: 'not attached to session: work',
        notAttached: true,
      });
    });

    it('drops keepalive-ping errors (legacy ka- ids)', () => {
      const cb = vi.fn();
      api.onError(cb);

      surface.pushMessage('error', { message: 'session not found' }, { id: 'ka-1730000000000' });
      surface.pushMessage('error', { message: 'session not found' });

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('defaults an empty message to Remote error', () => {
      const cb = vi.fn();
      api.onError(cb);

      surface.pushMessage('error', {});

      expect(cb).toHaveBeenCalledWith({ message: 'Remote error', notAttached: false });
    });

    it('stops delivering after unsubscribe', () => {
      const cb = vi.fn();
      const unsub = api.onError(cb);
      unsub();

      surface.pushMessage('error', { message: 'boom' });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('ping', () => {
    it('requests control.ping, carrying a deadline, so a missed pong is observable', async () => {
      // The mutation this pins is reverting to `send`. A fire-and-forget ping
      // registers nothing pending, so it cannot tell a live agent from one that
      // stopped answering — and a peer that stopped answering is the *only*
      // way a browser ever learns its socket went half-open, because the
      // socket fires no `close` (#1233).
      const pending = api.ping(1_234);

      expect(surface.requests[0]).toMatchObject({
        type: 'control.ping',
        payload: {},
        options: { timeoutMs: 1_234 },
      });
      expect(surface.sent).toEqual([]);

      surface.resolveNext('control.ping', {});
      await expect(pending).resolves.toBeUndefined();
    });

    it('rejects when the deadline passes with no pong', async () => {
      const pending = api.ping(10);
      surface.rejectNext('control.ping', new Error('Request timeout: control.ping'));

      await expect(pending).rejects.toThrow(/timeout/i);
    });
  });
});
