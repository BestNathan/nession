import { describe, expect, it, vi } from 'vitest';
import { AttachStateMachine } from '@/platform/attach/AttachStateMachine';
import { SessionAttachController } from '@/platform/attach/SessionAttachController';
import type { TerminalAgentApi } from '@/product/terminal';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('research acceptance T19', () => {
  it('uses typed transport failure kind instead of transport error prose', async () => {
    const sm = new AttachStateMachine({ transportFirst: true });
    sm.dispatch({ type: 'SESSION_SELECTED' });
    const controller = new SessionAttachController(sm);
    const outcomes: Array<{ retryAttach?: boolean; forceRelay?: boolean }> = [];
    controller.subscribeOutcomes((r) => outcomes.push(r));

    const api = {
      attach: vi.fn(() => Promise.resolve({
        ok: false,
        kind: 'transport',
        error: 'wording changed and matches no legacy transport string',
      })),
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
      transportGeneration: 0,
    });
    await flush();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ retryAttach: true, forceRelay: false });
  });
});
