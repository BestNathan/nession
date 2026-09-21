import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouterImpl } from '@/platform/socket/MessageRouter';
import type { SocketMessage } from '@/platform/socket/types';

describe('MessageRouterImpl', () => {
  let router: MessageRouterImpl;
  let sendFn: (msg: SocketMessage) => void;

  beforeEach(() => {
    sendFn = vi.fn<(msg: SocketMessage) => void>();
    router = new MessageRouterImpl({ send: sendFn, generateId: () => 'id-1' });
  });

  afterEach(() => {
    router.dispose();
  });

  it('correlates response by message id', async () => {
    const p = router.request<{ ok: boolean }>('agent.file.list', { path: '/' });
    router.handleIncoming({ msg_type: 'agent.file.list', id: 'id-1', timestamp: 0, payload: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const p = router.request('agent.file.read', {}, { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow('Request timeout');
    vi.useRealTimers();
  });

  it('dispatches typed handlers without consuming correlated responses', async () => {
    const handler = vi.fn();
    router.subscribe('agent.terminal.output', handler);
    router.handleIncoming({ msg_type: 'agent.terminal.output', id: 'x', timestamp: 0, payload: 'data' });
    expect(handler).toHaveBeenCalledWith('data', expect.objectContaining({ msg_type: 'agent.terminal.output' }));
  });

  it('passes binary without JSON parse', () => {
    const binHandler = vi.fn();
    router.onBinary(binHandler);
    const buf = new ArrayBuffer(4);
    router.handleBinary(buf);
    expect(binHandler).toHaveBeenCalledWith(buf);
  });

  it('rejects correlated error responses', async () => {
    const p = router.request('agent.file.read', { path: '/missing' });
    router.handleIncoming({
      msg_type: 'error',
      id: 'id-1',
      timestamp: 0,
      payload: { message: 'Not found' },
    });
    await expect(p).rejects.toThrow('Not found');
  });

  it('rejects pending requests on dispose', async () => {
    const p = router.request('agent.file.read', {});
    router.dispose();
    await expect(p).rejects.toThrow('MessageRouter disposed');
  });

  it('failPending rejects in-flight requests immediately', async () => {
    const p = router.request('agent.file.read', {});
    router.failPending(new Error('Connection lost'));
    await expect(p).rejects.toThrow('Connection lost');
  });

  it('rejects request immediately when already disposed', async () => {
    router.dispose();
    await expect(router.request('agent.file.read', {})).rejects.toThrow('MessageRouter disposed');
    expect(sendFn).not.toHaveBeenCalled();
  });
});
