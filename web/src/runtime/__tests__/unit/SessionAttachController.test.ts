import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionAttachController } from '@/runtime/SessionAttachController';
import {
  AttachStateMachine,
  ATTACH_TIMEOUT_MS,
  type AttachTransitionResult,
} from '@/runtime/AttachStateMachine';
import type { AttachResult, TerminalAgentApi } from '@/features/terminal';

/** Two microtask ticks — enough for a resolved attach's .then chain to run. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve());
}

interface AgentApiHarness {
  api: TerminalAgentApi;
  attach: ReturnType<typeof vi.fn>;
  /** Resolvers in call order — resolve attach call N via attachResolvers[N]. */
  attachResolvers: Array<(result: AttachResult) => void>;
}

/** Deferred attach — the test controls when (and with what) attach resolves. */
function makeAgentApi(): AgentApiHarness {
  const attachResolvers: Array<(result: AttachResult) => void> = [];
  const attach = vi.fn((): Promise<AttachResult> => new Promise((resolve) => {
    attachResolvers.push(resolve);
  }));
  const api = {
    attach,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onResize: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    ping: vi.fn(),
  };
  return { api: api as unknown as TerminalAgentApi, attach, attachResolvers };
}

/** Attach resolves { ok: false, error: 'timeout' } on its own timeout budget. */
function makeTimedAgentApi(): AgentApiHarness {
  const attach = vi.fn(
    (_sessionName: string, _size?: unknown, opts?: { timeoutMs?: number }): Promise<AttachResult> =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, error: 'timeout' }), opts?.timeoutMs ?? ATTACH_TIMEOUT_MS);
      }),
  );
  const api = {
    attach,
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onResize: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    ping: vi.fn(),
  };
  return { api: api as unknown as TerminalAgentApi, attach, attachResolvers: [] };
}

function makeController(): { sm: AttachStateMachine; controller: SessionAttachController; outcomes: AttachTransitionResult[] } {
  const sm = new AttachStateMachine({ transportFirst: true });
  sm.dispatch({ type: 'SESSION_SELECTED' });
  const controller = new SessionAttachController(sm);
  const outcomes: AttachTransitionResult[] = [];
  controller.subscribeOutcomes((r) => outcomes.push(r));
  return { sm, controller, outcomes };
}

describe('SessionAttachController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches ATTACH_OK when the agent api resolves ok', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api, attach, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });

    expect(attach).toHaveBeenCalledWith('s1', undefined, { timeoutMs: ATTACH_TIMEOUT_MS });
    expect(sm.phase).toBe('connecting');

    attachResolvers[0]?.({ ok: true });
    await flushMicrotasks();

    expect(outcomes.map((r) => r.phase)).toContain('attached');
    expect(sm.phase).toBe('attached');
    // In-flight attach canceled after ATTACH_OK — a re-drive may start fresh.
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it('sends the known viewport with attach', () => {
    const { controller } = makeController();
    const { api, attach } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: { cols: 120, rows: 40 },
      transportGeneration: 0,
    });
    expect(attach).toHaveBeenCalledWith('s1', { cols: 120, rows: 40 }, { timeoutMs: ATTACH_TIMEOUT_MS });
  });

  it('signals force-relay after ATTACH_TIMEOUT budget exhausted', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api } = makeTimedAgentApi();
    for (let i = 0; i <= 10; i += 1) {
      controller.startP2PAttach({
        sessionName: 's1',
        agentApi: api,
        manualRoute: false,
        lastResize: null,
        transportGeneration: i,
      });
      vi.advanceTimersByTime(ATTACH_TIMEOUT_MS);
      await flushMicrotasks();
    }

    expect(outcomes.some((r) => r.forceRelay)).toBe(true);
    expect(sm.phase).toBe('connecting');
  });

  it('does not send duplicate attach for the same transport generation', () => {
    const { controller } = makeController();
    const { api, attach } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 3,
    });
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 3,
    });
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['timeout'],
    ['Connection lost'],
    ['MessageRouter disposed'],
    ['WebSocketService disposed'],
    ['WebSocket not connected'],
    ['Connection timeout'],
    ['WebSocket connection failed'],
    ['WebSocketService is closed'],
  ])('maps attach error %s to ATTACH_TIMEOUT (transport-level failure)', async (error) => {
    const { sm, controller, outcomes } = makeController();
    const { api, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });
    attachResolvers[0]?.({ ok: false, error });
    await flushMicrotasks();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ retryAttach: true, forceRelay: false });
    expect(sm.reconnectCount).toBe(1);
    expect(sm.phase).toBe('reconnecting');
  });

  it('maps a genuine agent error ack (prose) to ATTACH_ERROR with force-relay on auto route', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api, attach, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });
    attachResolvers[0]?.({ ok: false, error: 'session does not exist' });
    await flushMicrotasks();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ forceRelay: true, retryAttach: false });
    expect(sm.phase).toBe('connecting');
    // ATTACH_ERROR cancels the in-flight attach — the next drive sends fresh.
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it('fails the session on a genuine agent error ack under a manual route', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: true,
      lastResize: null,
      transportGeneration: 0,
    });
    attachResolvers[0]?.({ ok: false, error: 'session does not exist' });
    await flushMicrotasks();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ forceRelay: false });
    expect(sm.phase).toBe('failed');
  });

  it('ignores a late attach resolution after cancel (epoch guard)', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });
    controller.cancelActiveAttach();
    attachResolvers[0]?.({ ok: true });
    await flushMicrotasks();

    expect(outcomes).toHaveLength(0);
    expect(sm.phase).toBe('connecting');
  });

  it('ignores a superseded attach resolution — only the latest generation counts', async () => {
    const { sm, controller, outcomes } = makeController();
    const { api, attachResolvers } = makeAgentApi();
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 0,
    });
    controller.startP2PAttach({
      sessionName: 's1',
      agentApi: api,
      manualRoute: false,
      lastResize: null,
      transportGeneration: 1,
    });
    // The first attach's resolution lands after the supersede — a no-op.
    attachResolvers[0]?.({ ok: true });
    await flushMicrotasks();
    expect(outcomes).toHaveLength(0);
    expect(sm.phase).toBe('connecting');

    // The in-flight (second) attach still resolves normally.
    attachResolvers[1]?.({ ok: true });
    await flushMicrotasks();
    expect(outcomes.map((r) => r.phase)).toContain('attached');
    expect(sm.phase).toBe('attached');
  });
});
