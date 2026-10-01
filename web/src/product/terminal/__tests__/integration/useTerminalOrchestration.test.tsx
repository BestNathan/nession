import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { useTerminalOrchestration } from '@/product/terminal/useTerminalOrchestration';
import { attachInfoAtom, sessionIdAtom, sessionNameAtom } from '@/product/session/state';
import type { TerminalAgentApi } from '@/product/terminal';
import type { UseTerminalOptions } from '@/product/terminal/hooks/useTerminal';
import type { ResumeReply } from '@/platform/terminal-runtime/streamReconciler';
import type { ConnectionState } from '@/platform/socket/types';
import type { AttachInfo } from '@/types';

/**
 * What the mocked collaborators hand back, set per test.
 *
 * `runtime` is the session lifecycle owner the orchestration's truncation
 * callback is supposed to reach; `api` is the agent capability the transport
 * factory binds its ConnectionManager to.
 */
const { deps, terminalOptions } = vi.hoisted(() => ({
  deps: {
    runtime: null as unknown,
    api: null as unknown,
  },
  terminalOptions: { current: null as unknown },
}));

vi.mock('@/product/terminal/hooks/useP2PAttachTransport', () => ({
  useP2PAttachTransport: () => ({
    waitingForAddressPlan: false,
    agentTerminalApi: deps.api,
    connectionState: 'connected' as ConnectionState,
    runtime: deps.runtime,
    snapshot: { phase: 'attached' as const, reconnectCount: 0 },
    fileOps: null,
  }),
}));

/**
 * The orchestration hands the transport factory to `useTerminal`, which is the
 * only thing that builds the transport. The mock is where the test takes the
 * factory from — everything downstream of it is the production object.
 */
vi.mock('@/product/terminal/hooks/useTerminal', () => ({
  useTerminal: (options: unknown) => {
    terminalOptions.current = options;
    return null;
  },
}));

vi.mock('@/product/terminal/useTerminalAttach', () => ({
  useTerminalAttach: () => ({ terminalState: 'attached', reconnectCount: 0 }),
}));

vi.mock('@/shared/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connectionState: 'connected',
    onConnectionStateChange: () => () => {},
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onRelayOutput: vi.fn(() => () => {}),
    onRelayResize: vi.fn(() => () => {}),
  }),
}));

function makeAttachInfo(): AttachInfo {
  return {
    mode: 'p2p',
    session_id: 'agent:s1',
    agent_address: 'ws://a/ws',
    connection_token: 'tok',
    addresses: [
      { url: 'ws://a/ws', label: 'A', network_type: 'lan', priority: 10, status: 'reachable' },
    ],
  };
}

/** The options the orchestration passed to `useTerminal` on its last render. */
function capturedOptions(): UseTerminalOptions {
  const options = terminalOptions.current as UseTerminalOptions | null;
  if (options === null) {
    throw new Error('useTerminal was never called');
  }
  return options;
}

interface AgentApiHarness {
  api: TerminalAgentApi;
  /** The live-frame handler ConnectionManager subscribed with. */
  emitOutput: (frame: { data: Uint8Array; streamEpoch: number; streamSeq: number }) => void;
  /** Resolve the resume request the reconciler makes. */
  answerResume: (reply: ResumeReply) => void;
}

function makeAgentApi(): AgentApiHarness {
  let resolveResume: ((reply: ResumeReply) => void) | null = null;
  let outputHandler: ((frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number }) => void) | null = null;
  const api = {
    attach: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    getControlState: vi.fn(() => ({ role: 'controller' as const })),
    acquireControl: vi.fn(),
    onControlChanged: vi.fn(() => () => {}),
    resumeStream: vi.fn(
      () => new Promise<ResumeReply>((resolve) => {
        resolveResume = resolve;
      }),
    ),
    onOutput: vi.fn((cb: (frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number }) => void) => {
      outputHandler = cb;
      return () => {};
    }),
    onResize: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    ping: vi.fn().mockResolvedValue(undefined),
  };
  return {
    api: api as unknown as TerminalAgentApi,
    emitOutput: (frame) => {
      if (outputHandler === null) {
        throw new Error('ConnectionManager never subscribed to output');
      }
      outputHandler(frame);
    },
    answerResume: (reply) => {
      if (resolveResume === null) {
        throw new Error('no resume request was made');
      }
      resolveResume(reply);
    },
  };
}

function wrapper(store: ReturnType<typeof createStore>) {
  return function JotaiWrapper({ children }: { children: ReactNode }) {
    return createElement(Provider, { store }, children);
  };
}

/** Let the reconciler's `.then` handlers run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('useTerminalOrchestration', () => {
  it('carries a truncation the transport sees through to the session runtime (#1304)', async () => {
    // The last hop of #1304's chain, and the only one nothing else pinned: the
    // transport is told an answer was not the whole stretch it asked for, and
    // the runtime is what remembers that a snapshot is owed. Every other link
    // has its own test — the agent's floor and verdict (Rust), the decode, the
    // reconciler's decision, the transport's forward to its options — which
    // makes this one exactly the kind of wiring that can be dropped without
    // any of them noticing: an empty arrow here is type-valid, and it leaves
    // the reconciler stating a loss that reaches nobody.
    //
    // So the truncation is driven *through the orchestration*: the transport
    // below is the real ConnectionManager the options are handed to, not a
    // stand-in that would only restate the arrow.
    const runtime = { noteStreamTruncated: vi.fn(), probeLivenessNow: vi.fn() };
    const agent = makeAgentApi();
    deps.runtime = runtime;
    deps.api = agent.api;

    const store = createStore();
    store.set(sessionIdAtom, 'agent:s1');
    store.set(sessionNameAtom, 's1');
    store.set(attachInfoAtom, makeAttachInfo());
    const view = renderHook(
      () => useTerminalOrchestration({ onDisconnect: vi.fn(), onError: vi.fn() }),
      { wrapper: wrapper(store) },
    );

    const transport = capturedOptions().transportFactory();

    // The shape the reconciler reads as a hole: two frames with a gap between
    // them, and an agent that says its retained window begins above the
    // cursor it was asked from.
    agent.emitOutput({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
    agent.emitOutput({ data: new TextEncoder().encode('twelve'), streamEpoch: 1, streamSeq: 12 });
    agent.answerResume({
      streamEpoch: 1,
      epochMatch: true,
      firstAvailableSeq: 11,
      complete: false,
      events: [
        { kind: 'output', streamEpoch: 1, streamSeq: 11, data: btoa('eleven') },
        { kind: 'output', streamEpoch: 1, streamSeq: 12, data: btoa('twelve') },
      ],
    });
    await flushMicrotasks();

    expect(runtime.noteStreamTruncated).toHaveBeenCalledTimes(1);

    transport.dispose();
    view.unmount();
  });
});
