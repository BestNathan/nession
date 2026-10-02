import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type {
  TerminalControlRole,
  TerminalControlState,
} from '@/product/terminal/state/terminalControl';
import { createStore, Provider } from 'jotai';
import { createElement, type ReactNode } from 'react';
import { useTerminalOrchestration } from '@/product/terminal/useTerminalOrchestration';
import { attachInfoAtom, sessionIdAtom, sessionNameAtom } from '@/product/session/state';
import type { TerminalAgentApi } from '@/product/terminal';
import type { UseTerminalOptions } from '@/product/terminal/hooks/useTerminal';
import type { ResumeReply } from '@/platform/terminal-runtime/streamReconciler';
import type { ConnectionState } from '@/platform/socket/types';
import type { AttachInfo } from '@/types';
import { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import type { SessionRuntime } from '@/platform/session-runtime/SessionRuntime';
import { inputDropAtomFamily } from '@/product/terminal/state/ui';
import type { TerminalSession } from '@/product/terminal/state/session';

// xterm.open() requires window.matchMedia in jsdom — the same local stub
// `TerminalController.test.ts` installs, kept local rather than added to the
// shared setup so no other suite's notion of a media query changes.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

/**
 * What the mocked collaborators hand back, set per test.
 *
 * `runtime` is the session lifecycle owner the orchestration's truncation
 * callback is supposed to reach; `api` is the agent capability the transport
 * factory binds its ConnectionManager to; `snapshot` is the attach state the
 * orchestration derives `terminalState` from, so a test can drive the
 * transitions a reconnect produces; and `makeController` lets a test install a
 * real `TerminalController` instead of the usual `null`.
 */
const { deps } = vi.hoisted(() => ({
  deps: {
    runtime: null as unknown,
    api: null as unknown,
    snapshot: { phase: 'attached' as 'attached' | 'reconnecting', reconnectCount: 0 },
    makeController: null as ((factory: () => TerminalTransport) => TerminalController) | null,
  },
}));

vi.mock('@/product/terminal/hooks/useP2PAttachTransport', () => ({
  useP2PAttachTransport: () => ({
    waitingForAddressPlan: false,
    agentTerminalApi: deps.api,
    connectionState: 'connected' as ConnectionState,
    runtime: deps.runtime,
    snapshot: deps.snapshot,
    fileOps: null,
  }),
}));

/**
 * The real `useTerminal` builds the controller's transports through the
 * runtime (`runtime.buildTransport()`, #1309). The mock does the same with the
 * test's runtime harness — everything downstream of the build is the
 * production object.
 *
 * A test that needs the controller in the loop installs `makeController`; it
 * is handed a factory over the runtime's own `buildTransport`, so the
 * transport the controller wires is the production `ConnectionManager` and
 * not a stand-in for it.
 */
vi.mock('@/product/terminal/hooks/useTerminal', () => ({
  useTerminal: (options: unknown) => {
    const opts = options as UseTerminalOptions;
    return deps.makeController?.(() => (opts.runtime as SessionRuntime).buildTransport()) ?? null;
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

interface AgentApiHarness {
  api: TerminalAgentApi;
  /** The lease the capability reports; flip `role` to make this client an observer. */
  lease: { role: TerminalControlRole };
  /** Input that actually left the client, in order. */
  wire: Array<{
    sessionName: string;
    data: string;
    sequence?: { inputEpoch: number; seqStart: number; seqEnd: number };
  }>;
  /** The live-frame handler ConnectionManager subscribed with. */
  emitOutput: (frame: { data: Uint8Array; streamEpoch: number; streamSeq: number }) => void;
  /** Resolve the resume request the reconciler makes. */
  answerResume: (reply: ResumeReply) => void;
  /**
   * Push a lease change the way the agent's notification does.
   *
   * Delivered to every subscriber rather than the last one registered: two
   * layers legitimately watch this — the control bridge that mirrors the role
   * into Jotai, and the transport that has to drop input numbered against the
   * generation it is leaving (#1307 SC-08).
   */
  deliverControlChanged: (state: TerminalControlState) => void;
}

function makeAgentApi(): AgentApiHarness {
  let resolveResume: ((reply: ResumeReply) => void) | null = null;
  let outputHandler: ((frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number }) => void) | null = null;
  const controlChangedHandlers: Array<(sessionName: string, state: TerminalControlState) => void> = [];
  /** The lease this capability reports. Flipping it makes this client an observer. */
  const lease: { role: TerminalControlRole } = { role: 'controller' };
  /** What actually left the client. `sendInput`'s calls are not the same fact. */
  const wire: Array<{ sessionName: string; data: string; sequence?: { inputEpoch: number; seqStart: number; seqEnd: number } }> = [];
  const api = {
    attach: vi.fn(),
    // Faithful to the capability, not a stand-in for it: `agent.ts` refuses an
    // observer's input before it reaches the wire (#1095), so a harness that
    // recorded every call would report bytes the agent never receives. What is
    // asserted on is `wire` — the calls are only what the layer below offered.
    sendInput: vi.fn((sessionName: string, data: string, sequence?: { inputEpoch: number; seqStart: number; seqEnd: number }) => {
      if (lease.role === 'observer') { return; }
      wire.push({ sessionName, data, ...(sequence ? { sequence } : {}) });
    }),
    sendResize: vi.fn(),
    getControlState: vi.fn(() => ({ role: lease.role })),
    acquireControl: vi.fn(),
    onControlChanged: vi.fn((cb: (sessionName: string, state: TerminalControlState) => void) => {
      controlChangedHandlers.push(cb);
      return () => {};
    }),
    // Subscribed but not driven: this case is about the output timeline
    // (#1304), and the manager needs only for the subscription to exist. The
    // input cursor this feeds has its own tests (#1307).
    onInputAck: vi.fn(() => () => {}),
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
    lease,
    wire,
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
    deliverControlChanged: (state) => {
      if (controlChangedHandlers.length === 0) {
        throw new Error('nothing subscribed to control changes');
      }
      for (const handler of controlChangedHandlers) {
        handler('s1', state);
      }
    },
  };
}

function makeSession(): TerminalSession {
  return { id: 'agent:s1', name: 's1', status: 'idle', mode: 'p2p', startedAt: 0 };
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

/** What an attach states about the session's cursors (#1094, #1307). */
interface TerminalSeed {
  inputEpoch?: number;
  inputAppliedThrough?: number;
  controlGeneration?: number;
  streamEpoch?: number;
  streamCursor?: number;
}

interface RuntimeHarness {
  runtime: SessionRuntime;
  probeLivenessNow: ReturnType<typeof vi.fn>;
  noteStreamTruncated: ReturnType<typeof vi.fn>;
  /**
   * The runtime's half of an attach completing: apply the attach's seed to the
   * live transport, in the real runtime's order (#1309 moved this out of the
   * React tree — `SessionRuntime.applyAttachSeedToLiveTransport`).
   */
  applyAttach: (seed: TerminalSeed) => void;
}

/**
 * The runtime the orchestration's collaborators see in these tests. It builds
 * the REAL `ConnectionManager` — the point of every test below is that nothing
 * between the keystroke and the wire is a stand-in — with the same options the
 * production runtime hands it.
 */
function makeRuntimeHarness(opts: {
  store: ReturnType<typeof createStore>;
  isAttached?: () => boolean;
}): RuntimeHarness {
  const probeLivenessNow = vi.fn();
  const noteStreamTruncated = vi.fn();
  let live: TerminalTransport | null = null;
  const runtime = {
    buildTransport: () => {
      live = new ConnectionManager({
        mode: 'p2p',
        sessionName: 's1',
        sessionId: 'agent:s1',
        agentApi: deps.api as TerminalAgentApi,
        isAttached: opts.isAttached ?? (() => true),
        onInputSent: () => probeLivenessNow(),
        onStreamTruncated: () => noteStreamTruncated(),
        onInputDrop: (drop) => {
          opts.store.set(inputDropAtomFamily('agent:s1'), drop);
        },
      });
      return live;
    },
    subscribeTransportSwap: () => () => {},
    setTransportReady: () => {},
    updateViewportSize: () => {},
  } as unknown as SessionRuntime;
  return {
    runtime,
    probeLivenessNow,
    noteStreamTruncated,
    applyAttach: (seed) => {
      const transport = live;
      if (transport === null) {
        throw new Error('applyAttach before the runtime built a transport');
      }
      // The production order: reconcile the input cursor BEFORE the flush (the
      // flush is numbered against it), seed the stream cursor AFTER it.
      transport.seedInputCursor?.({
        inputEpoch: seed.inputEpoch,
        appliedThrough: seed.inputAppliedThrough,
        controlGeneration: seed.controlGeneration,
      });
      transport.flushAllOutbound();
      transport.seedStreamCursor?.(seed.streamEpoch, seed.streamCursor);
    },
  };
}

const hosts: HTMLDivElement[] = [];
const controllers: TerminalController[] = [];

/**
 * A session on the production stack: the real `TerminalController`, attached to
 * a real container, over the real `ConnectionManager` the runtime built — with
 * input typed through the controller, which is what xterm does.
 *
 * The point of the whole arrangement is that nothing between the keystroke and
 * the wire is a stand-in. A harness that restated any of it would be testing
 * the restatement, and the last hop of a chain is exactly where a restatement
 * and the real thing drift apart unnoticed.
 */
function startSession(initialSeed: TerminalSeed) {
  const agent = makeAgentApi();
  deps.api = agent.api;
  let seed = initialSeed;

  const store = createStore();
  store.set(sessionIdAtom, 'agent:s1');
  store.set(sessionNameAtom, 's1');
  store.set(attachInfoAtom, makeAttachInfo());

  const harness = makeRuntimeHarness({
    store,
    isAttached: () => deps.snapshot.phase === 'attached',
  });
  deps.runtime = harness.runtime;

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const built: { controller: TerminalController | null } = { controller: null };
  deps.makeController = (factory) => {
    if (built.controller === null) {
      built.controller = new TerminalController(makeSession(), factory, { rendererType: 'canvas' });
      built.controller.attach(host);
      controllers.push(built.controller);
    }
    return built.controller;
  };

  const view = renderHook(
    () => useTerminalOrchestration({ onDisconnect: vi.fn(), onError: vi.fn() }),
    { wrapper: wrapper(store) },
  );
  const controller = built.controller;
  if (controller === null) {
    throw new Error('the orchestration never asked for a controller');
  }
  // The mount attach completing: the runtime applies the seed it stated to the
  // transport it built. Done outside the hook because #1309 made it the
  // runtime's half of the handoff, not a React effect's.
  harness.applyAttach(seed);

  return {
    view,
    controller,
    agent,
    /** What the runtime states on the next attach. */
    reseed: (next: TerminalSeed) => { seed = next; },
    /** The transition a P2P reconnect produces: re-attach, seed and all. */
    reattach: () => {
      deps.snapshot = { phase: 'reconnecting', reconnectCount: 1 };
      view.rerender();
      deps.snapshot = { phase: 'attached', reconnectCount: 1 };
      harness.applyAttach(seed);
      view.rerender();
    },
  };
}

describe('useTerminalOrchestration', () => {
  afterEach(() => {
    for (const controller of controllers) {
      controller.detach();
    }
    controllers.length = 0;
    for (const host of hosts) {
      host.remove();
    }
    hosts.length = 0;
    deps.makeController = null;
    deps.runtime = null;
    deps.api = null;
    deps.snapshot = { phase: 'attached', reconnectCount: 0 };
  });

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
    // below is the real ConnectionManager the runtime builds, not a stand-in
    // that would only restate the arrow.
    const agent = makeAgentApi();
    deps.api = agent.api;

    const store = createStore();
    store.set(sessionIdAtom, 'agent:s1');
    store.set(sessionNameAtom, 's1');
    store.set(attachInfoAtom, makeAttachInfo());
    const harness = makeRuntimeHarness({ store });
    deps.runtime = harness.runtime;
    const view = renderHook(
      () => useTerminalOrchestration({ onDisconnect: vi.fn(), onError: vi.fn() }),
      { wrapper: wrapper(store) },
    );

    // Built the way the production caller builds it: through the runtime,
    // which is what wires the truncation report back to itself (#1309).
    const transport = harness.runtime.buildTransport();

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

    expect(harness.noteStreamTruncated).toHaveBeenCalledTimes(1);

    transport.dispose();
    view.unmount();
  });

  it('reconciles the cursor an attach states before flushing, so a reconnect re-sends only what the agent has not applied (#1307 SC-04)', () => {
    // The last hop of #1307's reconnect chain and the one with no test at all.
    // Every link below the orchestration is unit-tested — the queue's
    // reconcile, the manager's cursor-derived numbering, the controller's
    // delegation — and each of those tests hands its subject the cursor
    // directly. That is precisely how a seed whose *field name* the reader
    // never reads stays green: `getP2pAttachSeed` states
    // `inputAppliedThrough`, and an inline structural type with every field
    // optional accepts an object that has no `appliedThrough` at all, so the
    // reconcile quietly becomes `reconcile(identity, undefined)` and the queue
    // re-sends everything it holds.
    //
    // So the flow is driven end to end: the real `TerminalController`, attached
    // to a real container, over the real `ConnectionManager` the orchestration
    // built, with the input typed through the controller the way xterm types
    // it. What is asserted is what the agent would receive.
    const { view, controller, agent, reseed, reattach } = startSession({
      inputEpoch: 7,
      inputAppliedThrough: 10,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });

    // The mount attach states a cursor, so these two chunks are numbered above
    // it rather than from zero. A client that ignored the stated cursor would
    // number them 1 and 2 — positions the agent, holding cursor 10, refuses as
    // a gap, which is the whole reason the attach states a position.
    //
    // No acknowledgement arrives: it is the second keystroke's flush that
    // re-offers the first chunk, because a chunk the agent has not applied
    // stays in the queue until it says otherwise. The agent refuses the repeat
    // by position, so what matters here is only that each chunk carries the
    // position it was numbered with.
    controller.send('a');
    controller.send('b');
    expect(agent.wire.slice(0, 1)).toEqual([
      { sessionName: 's1', data: 'a', sequence: { inputEpoch: 7, seqStart: 11, seqEnd: 11 } },
    ]);
    expect(agent.wire.slice(-1)).toEqual([
      { sessionName: 's1', data: 'b', sequence: { inputEpoch: 7, seqStart: 12, seqEnd: 12 } },
    ]);
    agent.wire.length = 0;

    // The reconnect. The agent applied the first chunk and the acknowledgement
    // was lost with the transport, so the attach states 11 — one past where
    // this client last heard from it.
    reseed({
      inputEpoch: 7,
      inputAppliedThrough: 11,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });
    reattach();

    // Only what is above the stated cursor leaves, at the position the stated
    // cursor gives it. Re-sending 'a' would be the client replaying bytes it
    // has been told reached the PTY; the retained queue is what makes the
    // single surviving chunk still sendable at its original position.
    expect(agent.wire).toEqual([
      { sessionName: 's1', data: 'b', sequence: { inputEpoch: 7, seqStart: 12, seqEnd: 12 } },
    ]);

    view.unmount();
  });

  it('drops the input a controller typed before the lease moved, so it never reaches the PTY under the next controller (#1307 SC-08)', () => {
    // The case the queue's own comment names: a client that held the lease,
    // typed without being acknowledged, lost the lease, and — the part that
    // matters — is still holding what it typed. Nothing about the queue is
    // wrong at that point. The chunk is real, it is numbered, and it is
    // contiguous with the cursor. It is simply no longer *this client's* input
    // to deliver, and the next flush would hand it over.
    const { view, controller, agent } = startSession({
      inputEpoch: 7,
      inputAppliedThrough: 0,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });

    controller.send('rm -rf build');
    expect(agent.wire).toEqual([
      {
        sessionName: 's1',
        data: 'rm -rf build',
        sequence: { inputEpoch: 7, seqStart: 1, seqEnd: 1 },
      },
    ]);
    agent.wire.length = 0;

    // Another client takes the session. The lease generation is the agent's
    // statement of that, and it arrives over the live socket — no attach, no
    // reconnect, just the notification.
    act(() => agent.deliverControlChanged({ role: 'observer', generation: 3 }));

    // The controller regains the lease and types again. What the agent sees
    // must be the new chunk alone: the bytes from the previous generation are
    // not this controller's to send any more, and delivering them here would
    // execute input under a lease it was never typed for (#1095).
    act(() => agent.deliverControlChanged({ role: 'controller', generation: 4 }));
    controller.send('ls');
    expect(agent.wire).toEqual([
      { sessionName: 's1', data: 'ls', sequence: { inputEpoch: 7, seqStart: 1, seqEnd: 1 } },
    ]);

    view.unmount();
  });

  it('never queues an observer’s keystrokes, so nothing of them can be delivered later (#1307 SC-10)', () => {
    // The requirement's constraint, worded as the queue's own failure: an
    // observer "must not bypass the control lease through the retry queue".
    // The capability already refuses an observer's `sendInput` (#1095), and
    // that is what keeps the bytes off the wire — but it runs *after* the
    // transport has accepted, numbered and retained them, so an observer's
    // keystrokes sit in the queue as a contiguous run above the cursor. They
    // are not merely inert there: they hold the positions the client's real
    // input is numbered against.
    //
    // The generation is deliberately held still, because that is what isolates
    // this from SC-08. A lease change that moves the generation clears the
    // queue on its own, which is the ordinary shape of regaining control — and
    // it is exactly why the enqueue has to be tested with the handoff frozen,
    // or the clearing would answer for it and the queue would keep a privilege
    // nothing checks.
    const { view, controller, agent } = startSession({
      inputEpoch: 7,
      inputAppliedThrough: 0,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });

    agent.lease.role = 'observer';
    controller.send('secret');
    expect(agent.wire).toEqual([]);

    agent.lease.role = 'controller';
    controller.send('ls');

    // Position 1, not 2: the withheld keystroke never became a position, so it
    // has nothing to be retried from and nothing the next chunk has to skip.
    // Leaving it queued would put `ls` at 2, and the agent — holding cursor 0 —
    // reads a frame at 2 as a gap and refuses every chunk after it.
    expect(agent.wire).toEqual([
      { sessionName: 's1', data: 'ls', sequence: { inputEpoch: 7, seqStart: 1, seqEnd: 1 } },
    ]);

    view.unmount();
  });

  it('carries a delivery-unknown reconnect up to the surface, and clears it when dismissed (#1307 SC-09)', () => {
    // The last hop of SC-09, and the one that decides whether the state is
    // visible at all. The queue records the loss and the surface knows what to
    // say about it; between them sit the transport option, the factory's ref
    // and the session's atom, and any one of those can be dropped without a
    // single other test noticing — the queue still records, the surface still
    // renders, and nobody is ever told.
    //
    // The epoch is what makes this delivery-unknown rather than a plain loss:
    // a *different* agent process holds the cursor now, so the bytes this one
    // was holding can be neither proven applied nor proven unapplied.
    const { view, controller, agent, reseed, reattach } = startSession({
      inputEpoch: 7,
      inputAppliedThrough: 0,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });

    controller.send('rm -rf build');
    expect(agent.wire).toHaveLength(1);
    expect(view.result.current.inputDrop).toBeNull();

    reseed({
      inputEpoch: 8,
      inputAppliedThrough: 0,
      controlGeneration: 2,
      streamEpoch: 1,
      streamCursor: 0,
    });
    reattach();

    expect(agent.wire).toHaveLength(1);
    expect(view.result.current.inputDrop).toMatchObject({ reason: 'epoch', chunks: 1 });

    act(() => view.result.current.dismissInputDrop());

    expect(view.result.current.inputDrop).toBeNull();

    view.unmount();
  });
});
