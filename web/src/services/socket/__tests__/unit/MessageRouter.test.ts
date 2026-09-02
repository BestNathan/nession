import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouterImpl } from '@/services/socket/MessageRouter';
import type { SocketMessage } from '@/services/socket/types';

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
    const p = router.request<{ ok: boolean }>('file.list', { path: '/' });
    router.handleIncoming({ msg_type: 'file.list', id: 'id-1', timestamp: 0, payload: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const p = router.request('file.read', {}, { timeoutMs: 100 });
    vi.advanceTimersByTime(101);
    await expect(p).rejects.toThrow('Request timeout');
    vi.useRealTimers();
  });

  it('dispatches typed handlers without consuming correlated responses', async () => {
    const handler = vi.fn();
    router.subscribe('terminal.output', handler);
    router.handleIncoming({ msg_type: 'terminal.output', id: 'x', timestamp: 0, payload: 'data' });
    expect(handler).toHaveBeenCalledWith('data', expect.objectContaining({ msg_type: 'terminal.output' }));
  });

  it('passes binary without JSON parse', () => {
    const binHandler = vi.fn();
    router.onBinary(binHandler);
    const buf = new ArrayBuffer(4);
    router.handleBinary(buf);
    expect(binHandler).toHaveBeenCalledWith(buf);
  });

  it('rejects pending requests on dispose', async () => {
    const p = router.request('file.read', {});
    router.dispose();
    await expect(p).rejects.toThrow('MessageRouter disposed');
  });
});
