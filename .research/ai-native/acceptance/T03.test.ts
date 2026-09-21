import { describe, expect, it, vi } from 'vitest';
import { SessionAttachController } from '@/platform/attach/SessionAttachController';
import { AttachStateMachine } from '@/platform/attach/AttachStateMachine';
import type { AttachResult, TerminalAgentApi } from '@/product/terminal';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('research acceptance T03', () => {
  it('late attach failure after cancellation is a no-op', async () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const controller = new SessionAttachController(sm);
    const outcomes: unknown[] = [];
    controller.subscribeOutcomes((result) => outcomes.push(result));

    let resolveAttach!: (result: AttachResult) => void;
    const attach = vi.fn(() => new Promise<AttachResult>((resolve) => {
      resolveAttach = resolve;
    }));
    const api = {
      attach,
      sendInput: vi.fn(),
      sendResize: vi.fn(),
      onOutput: vi.fn(() => () => {}),
      onResize: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      ping: vi.fn(),
    } as unknown as TerminalAgentApi;

    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 7,
    });

    controller.cancelActiveAttach();
    resolveAttach({ ok: false, error: 'timeout' });
    await flushMicrotasks();

    expect(outcomes).toHaveLength(0);
    expect(sm.phase).toBe('connecting');
    expect(sm.reconnectCount).toBe(0);
  });
});
