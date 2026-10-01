import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager, INPUT_QUEUE_BOUNDS } from '@/platform/terminal-runtime/ConnectionManager';
import type { AgentError, TerminalAgentApi, TerminalInputAck, TerminalResizeFrame } from '@/product/terminal';
import type { ResumeReply } from '@/platform/terminal-runtime/streamReconciler';
import type { TerminalBootstrap } from '@/platform/terminal-runtime/bootstrap';
import type { ConnectionState } from '@/platform/socket/types';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';

const attached = { isAttached: () => true };

/** Stream replay is promise-based, not timer-based — drain microtasks, not clocks. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/** A resume answer the test releases by hand, so the interleaving is stated. */
function deferredReply(): {
  promise: Promise<ResumeReply>;
  resolve: (reply: ResumeReply) => void;
} {
  let resolve!: (reply: ResumeReply) => void;
  const promise = new Promise<ResumeReply>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A replay answer carrying `seq -> text` for the frames it covers. */
function replayOf(frames: Record<number, string>): ResumeReply {
  return {
    streamEpoch: 1,
    epochMatch: true,
    events: Object.entries(frames).map(([seq, text]) => ({
      kind: 'output' as const,
      streamEpoch: 1,
      streamSeq: Number(seq),
      data: btoa(text),
    })),
  };
}

interface AgentApiHarness {
  api: TerminalAgentApi;
  outputHandlers: Array<(frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number; bootstrap?: TerminalBootstrap }) => void>;
  resizeHandlers: Array<(frame: TerminalResizeFrame) => void>;
  errorHandlers: Array<(error: AgentError) => void>;
  inputAckHandlers: Array<(ack: TerminalInputAck) => void>;
  controlChangedHandlers: Array<(sessionName: string, state: { role: 'controller' | 'observer'; generation?: number }) => void>;
}

function makeAgentApi(): AgentApiHarness & { unsubs: { output: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; inputAck: ReturnType<typeof vi.fn>; controlChanged: ReturnType<typeof vi.fn> } } {
  const outputHandlers: Array<(frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number; bootstrap?: TerminalBootstrap }) => void> = [];
  const resizeHandlers: Array<(frame: TerminalResizeFrame) => void> = [];
  const errorHandlers: Array<(error: AgentError) => void> = [];
  const inputAckHandlers: Array<(ack: TerminalInputAck) => void> = [];
  const controlChangedHandlers: Array<(sessionName: string, state: { role: 'controller' | 'observer'; generation?: number }) => void> = [];
  const unsubs = {
    output: vi.fn(() => {}),
    resize: vi.fn(() => {}),
    error: vi.fn(() => {}),
    inputAck: vi.fn(() => {}),
    controlChanged: vi.fn(() => {}),
  };
  const api = {
    attach: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    getControlState: vi.fn(() => ({ role: 'controller' as const })),
    acquireControl: vi.fn(),
    onControlChanged: vi.fn((cb: (sessionName: string, state: { role: 'controller' | 'observer'; generation?: number }) => void) => {
      controlChangedHandlers.push(cb);
      return unsubs.controlChanged;
    }),
    onInputAck: vi.fn((cb: (ack: TerminalInputAck) => void) => {
      inputAckHandlers.push(cb);
      return unsubs.inputAck;
    }),
    resumeStream: vi.fn(async () => ({ streamEpoch: 1, epochMatch: true, events: [] })),
    onOutput: vi.fn((cb: (frame: { data: Uint8Array }) => void) => {
      outputHandlers.push(cb);
      return unsubs.output;
    }),
    onResize: vi.fn((cb: (frame: TerminalResizeFrame) => void) => {
      resizeHandlers.push(cb);
      return unsubs.resize;
    }),
    onError: vi.fn((cb: (error: AgentError) => void) => {
      errorHandlers.push(cb);
      return unsubs.error;
    }),
    // Resolves, because the real `ping` returns a promise and the keepalive
    // attaches a `.catch` to it: a mock returning `undefined` would throw a
    // TypeError and pass for the wrong reason (#1233).
    ping: vi.fn().mockResolvedValue(undefined),
  };
  return {
    api: api as unknown as TerminalAgentApi,
    outputHandlers,
    resizeHandlers,
    errorHandlers,
    inputAckHandlers,
    controlChangedHandlers,
    unsubs,
  };
}

function makeMockWs(): RelayServerTransport {
  return {
    sendRelayInput: vi.fn(),
    isReady: vi.fn(() => true),
    sendRelayResize: vi.fn(),
    onRelayOutput: vi.fn().mockReturnValue(() => {}),
    onRelayResize: vi.fn().mockReturnValue(() => {}),
    onRelayInputAck: vi.fn().mockReturnValue(() => {}),
    onConnectionStateChange: vi.fn().mockReturnValue(() => {}),
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
  };
}

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('P2P mode', () => {
    it('routes send input through agentApi.sendInput with the session name', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.send('hello');
      expect(api.sendInput).toHaveBeenCalledWith('test', 'hello');
      cm.dispose();
    });

    it('reports input to the owner so it can question the link (#1264)', () => {
      const { api } = makeAgentApi();
      const onInputSent = vi.fn();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
        onInputSent,
      });
      cm.send('hello');
      // Once per send, not once per state: this is the signal the liveness
      // check hangs off, and a missing call here leaves the whole input-side
      // detection dead while every runtime test still passes.
      expect(onInputSent).toHaveBeenCalledTimes(1);
      cm.dispose();
    });

    it('does not report input it buffered rather than sent (#1264)', () => {
      const { api } = makeAgentApi();
      const onInputSent = vi.fn();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api,
        isAttached: () => false,
        onInputSent,
      });
      cm.send('hello');
      // Buffered input never reached a transport, so there is no link to
      // question — and an unattached transport is the attach budget's job.
      expect(onInputSent).not.toHaveBeenCalled();
      cm.dispose();
    });

    it('buffers input until attached and flushes on the next send', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      expect(api.sendInput).not.toHaveBeenCalled();

      isAttached = true;
      cm.send('world');
      expect(api.sendInput).toHaveBeenCalledTimes(2);
      expect((api.sendInput as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['test', 'hello']);
      cm.dispose();
    });

    it('send is a no-op after dispose', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      cm.send('hello');
      expect(api.sendInput).not.toHaveBeenCalled();
    });

    it('does not re-apply replayed events the live stream already delivered (#1148)', async () => {
      // The seed path hands the gap fetch the cursor from the attach response.
      // When that cursor is behind what the live stream has already written,
      // the replay re-applies the whole stream on top of itself — every byte
      // reaching xterm twice, so xterm answers each capability query twice.
      const { api, outputHandlers } = makeAgentApi();
      const received: string[] = [];
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.onOutput = (data) => received.push(new TextDecoder().decode(data));

      outputHandlers[0]({ data: new TextEncoder().encode('one'), streamEpoch: 1, streamSeq: 1 });
      outputHandlers[0]({ data: new TextEncoder().encode('two'), streamEpoch: 1, streamSeq: 2 });
      expect(received).toEqual(['one', 'two']);

      (api.resumeStream as ReturnType<typeof vi.fn>).mockResolvedValue({
        streamEpoch: 1,
        epochMatch: true,
        events: [1, 2, 3].map((seq) => ({
          kind: 'output' as const,
          streamEpoch: 1,
          streamSeq: seq,
          data: btoa(['one', 'two', 'three'][seq - 1]),
        })),
      });

      // A stale cursor for the same epoch — the replay answers 1 and 2 as well.
      cm.seedStreamCursor(1, 0);
      await flushMicrotasks();

      // `three` is the only thing that was actually missing.
      expect(received).toEqual(['one', 'two', 'three']);
      cm.dispose();
    });

    it('does not deliver a live frame the gap replay already carried (#1148)', async () => {
      // The replay answers "every event after the cursor" with no upper bound,
      // so it already contains the frame that is about to arrive live.
      // Delivering that frame again writes its bytes to the terminal twice —
      // which is what made xterm answer each DA/OSC query twice in P2P.
      const { api, outputHandlers } = makeAgentApi();
      const received: string[] = [];
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.onOutput = (data) => received.push(new TextDecoder().decode(data));

      // A first live frame establishes the stream cursor at 5.
      outputHandlers[0]({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
      expect(received).toEqual(['five']);

      (api.resumeStream as ReturnType<typeof vi.fn>).mockResolvedValue({
        streamEpoch: 1,
        epochMatch: true,
        events: [6, 7, 8].map((seq) => ({
          kind: 'output' as const,
          streamEpoch: 1,
          streamSeq: seq,
          data: btoa(`frame-${seq}`),
        })),
      });

      // Frame 8 arrives live after a gap — and sits inside that same replay.
      outputHandlers[0]({ data: new TextEncoder().encode('frame-8'), streamEpoch: 1, streamSeq: 8 });
      await flushMicrotasks();

      // `frame-8` exactly once: the replay's copy, not the replay's plus a
      // second live delivery.
      expect(received).toEqual(['five', 'frame-6', 'frame-7', 'frame-8']);
      cm.dispose();
    });

    it('does not lose the frames a concurrent live frame jumped over (#1303)', async () => {
      // The sequence from the issue. The second live frame used to find the
      // first frame's resume in flight, skip its own gap recovery, and commit
      // itself over the gap; the resume then answered 6,7,8,9 and was filtered
      // against the cursor that second frame had already advanced, so 6, 7 and
      // 8 were dropped with nothing left to ask for them.
      const { api, outputHandlers } = makeAgentApi();
      const received: string[] = [];
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.onOutput = (data) => received.push(new TextDecoder().decode(data));

      const reply = deferredReply();
      (api.resumeStream as ReturnType<typeof vi.fn>).mockReturnValue(reply.promise);

      outputHandlers[0]({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
      outputHandlers[0]({ data: new TextEncoder().encode('eight'), streamEpoch: 1, streamSeq: 8 });
      expect(api.resumeStream).toHaveBeenCalledTimes(1);
      // Asked for from the last frame actually committed, not from the frame
      // that happened to notice the gap.
      expect((api.resumeStream as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['test', 1, 5]);

      // The second frame that skips the gap joins the recovery in flight: one
      // request, and nothing on screen ahead of the frames it is missing.
      outputHandlers[0]({ data: new TextEncoder().encode('nine'), streamEpoch: 1, streamSeq: 9 });
      expect(api.resumeStream).toHaveBeenCalledTimes(1);
      expect(received).toEqual(['five']);

      // The replay carries 8 and 9 as well; the copies already held live are
      // the ones delivered, so nothing is written twice.
      reply.resolve(replayOf({ 6: 'six', 7: 'seven', 8: 'replay-8', 9: 'replay-9' }));
      await flushMicrotasks();

      expect(received).toEqual(['five', 'six', 'seven', 'eight', 'nine']);
      cm.dispose();
    });

    it('carries a stated truncation out to the session owner (#1304)', async () => {
      // The reconciler is React-free and owns only the cursor; "my buffer now
      // has a hole in it" belongs to whoever owns the session, and this is the
      // hop that carries it there. An answer the agent states is incomplete is
      // not a filled gap, however much of a tail it carries.
      const { api, outputHandlers } = makeAgentApi();
      const received: string[] = [];
      let truncated = 0;
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
        onStreamTruncated: () => { truncated += 1; },
      });
      cm.onOutput = (data) => received.push(new TextDecoder().decode(data));

      const reply = deferredReply();
      (api.resumeStream as ReturnType<typeof vi.fn>).mockReturnValue(reply.promise);

      outputHandlers[0]({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
      outputHandlers[0]({ data: new TextEncoder().encode('twelve'), streamEpoch: 1, streamSeq: 12 });
      reply.resolve({
        ...replayOf({ 11: 'eleven', 12: 'twelve' }),
        firstAvailableSeq: 11,
        complete: false,
      });
      await flushMicrotasks();

      expect(truncated).toBe(1);
      // And the frames that are still there are delivered: a stated loss is not
      // a reason to freeze the terminal on what it already holds.
      expect(received).toEqual(['five', 'eleven', 'twelve']);
      cm.dispose();
    });

    it('discards a gap replay that lands after the transport was disposed (#1303)', async () => {
      // A resume is in flight across a transport rewire or teardown; its answer
      // describes a stream nobody is listening to any more.
      const { api, outputHandlers } = makeAgentApi();
      const received: string[] = [];
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.onOutput = (data) => received.push(new TextDecoder().decode(data));

      const reply = deferredReply();
      (api.resumeStream as ReturnType<typeof vi.fn>).mockReturnValue(reply.promise);

      outputHandlers[0]({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
      outputHandlers[0]({ data: new TextEncoder().encode('eight'), streamEpoch: 1, streamSeq: 8 });
      cm.dispose();

      reply.resolve(replayOf({ 6: 'six', 7: 'seven', 8: 'eight' }));
      await flushMicrotasks();

      expect(received).toEqual(['five']);
    });

    it('does not start a second recovery while one is in flight', async () => {
      const { api, outputHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const reply = deferredReply();
      (api.resumeStream as ReturnType<typeof vi.fn>).mockReturnValue(reply.promise);

      outputHandlers[0]({ data: new TextEncoder().encode('five'), streamEpoch: 1, streamSeq: 5 });
      outputHandlers[0]({ data: new TextEncoder().encode('eight'), streamEpoch: 1, streamSeq: 8 });
      outputHandlers[0]({ data: new TextEncoder().encode('nine'), streamEpoch: 1, streamSeq: 9 });
      outputHandlers[0]({ data: new TextEncoder().encode('ten'), streamEpoch: 1, streamSeq: 10 });

      // Overlapping requests would race their answers against each other and
      // duplicate the replay payload for no gain.
      expect(api.resumeStream).toHaveBeenCalledTimes(1);
      cm.dispose();
    });

    it('keepalive pings are sent every 30 seconds', () => {
      const { api } = makeAgentApi();
      new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      vi.advanceTimersByTime(30_000);
      expect(api.ping).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(api.ping).toHaveBeenCalledTimes(2);
    });

    it('keepalive stops after dispose', () => {
      const { api } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      vi.advanceTimersByTime(60_000);
      expect(api.ping).not.toHaveBeenCalled();
    });

    it('routes agent output frames to onOutput', () => {
      const { api, outputHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const onOutput = vi.fn();
      cm.onOutput = onOutput;

      const bytes = new Uint8Array([104, 105]);
      outputHandlers[0]?.({ data: bytes });
      // `undefined`, not `false`: absence is the whole meaning of the marker's
      // absence (#321), and a consumer that conflated the two could not tell a
      // live frame from a bootstrap declared not to be one.
      expect(onOutput).toHaveBeenCalledWith(bytes, undefined);
      cm.dispose();
    });

    it('carries the bootstrap marker through to onOutput, metadata included', () => {
      const { api, outputHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const onOutput = vi.fn();
      cm.onOutput = onOutput;

      const bytes = new Uint8Array([104, 105]);
      // The transport hands on what the agent said about the snapshot, not a
      // boolean — the consumer's decision depends on it (#1305).
      outputHandlers[0]?.({ data: bytes, bootstrap: { requestedLines: 5000, truncated: true } });
      expect(onOutput).toHaveBeenCalledWith(bytes, { requestedLines: 5000, truncated: true });
      cm.dispose();
    });

    it('routes a level resize frame straight to onResize', () => {
      const { api, resizeHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      const onResize = vi.fn();
      cm.onResize = onResize;

      // No stream position: a `%window-resize` echo, which never had one to
      // account for and is applied on arrival exactly as it always was (#1303).
      resizeHandlers[0]?.({ cols: 120, rows: 40 });
      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });

    it('lets a level resize supersede the recorded one the client is holding (#1350)', async () => {
      // This class is what puts a level in front of the buffer it supersedes,
      // and nothing downstream can recover from missing that: the frame with
      // no position is the newest size there is, so a held one that commits
      // after it leaves xterm on a grid the pane has left. Tested here as well
      // as on the reconciler because routing the level *around* the reconciler
      // passes every one of the reconciler's own tests.
      const { api, resizeHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      const onResize = vi.fn();
      cm.onResize = onResize;
      const reply = deferredReply();
      (api.resumeStream as ReturnType<typeof vi.fn>).mockReturnValue(reply.promise);

      // Seeded at 4, with the recorded resize at 6: 5 is missing, so there is
      // a real gap for it to wait behind rather than "not yet" being
      // indistinguishable from "never".
      cm.seedStreamCursor(1, 4);
      resizeHandlers[0]?.({ cols: 120, rows: 40, streamEpoch: 1, streamSeq: 6 });
      expect(onResize).not.toHaveBeenCalled();

      // While it waits, another connection reflows the shared pane. The agent
      // recorded nothing, so the frame states no position — it is the size now.
      resizeHandlers[0]?.({ cols: 100, rows: 30 });
      expect(onResize).toHaveBeenCalledWith(100, 30);
      onResize.mockClear();

      // The gap fills and the held resize reaches its turn.
      reply.resolve(replayOf({ 5: 'five' }));
      await flushMicrotasks();

      // It consumed its position and applied no size: the pane's is still the
      // last one on screen.
      expect(onResize).not.toHaveBeenCalled();
      cm.dispose();
    });

    it('does not apply a recorded resize until its place in the timeline arrives (#1303)', () => {
      // A resize the agent recorded consumed a sequence number. Applying it
      // here would show the right size and leave its position unaccounted for,
      // so the next live frame would be held behind a hole the client had
      // already been handed the contents of. It waits for its slot instead.
      const { api, resizeHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      const onResize = vi.fn();
      cm.onResize = onResize;
      // Seeded at 4, so the resize at 6 has 5 missing ahead of it — a real
      // gap, which is the only state in which "not yet" is distinguishable
      // from "never".
      cm.seedStreamCursor(1, 4);

      resizeHandlers[0]?.({ cols: 120, rows: 40, streamEpoch: 1, streamSeq: 6 });
      expect(onResize).not.toHaveBeenCalled();

      cm.dispose();
    });

    it('routes resize outbound through agentApi.sendResize', () => {
      const { api } = makeAgentApi();
      const manager = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'sess-1', agentApi: api, ...attached,
      });
      manager.sendResize(120, 40);
      expect(api.sendResize).toHaveBeenCalledWith('test', 120, 40);
      manager.dispose();
    });

    it('buffers sendResize until attached and coalesces to the latest size', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.sendResize(80, 24);
      cm.sendResize(100, 30);
      cm.sendResize(120, 40);
      expect(api.sendResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushPendingResize();
      expect(api.sendResize).toHaveBeenCalledTimes(1);
      expect(api.sendResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    it('flushAllOutbound sends buffered input first, then coalesced resize', () => {
      const { api } = makeAgentApi();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });

      cm.send('hello');
      cm.sendResize(120, 40);
      expect(api.sendInput).not.toHaveBeenCalled();
      expect(api.sendResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushAllOutbound();

      // Input first, then resize — agent expects a live session before
      // accepting terminal.* I/O.
      expect(api.sendInput).toHaveBeenCalledTimes(1);
      expect(api.sendResize).toHaveBeenCalledTimes(1);
      const inputOrder = (api.sendInput as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const resizeOrder = (api.sendResize as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(inputOrder).toBeLessThan(resizeOrder);
      cm.dispose();
    });

    it('suppresses not_attached errors while state !== attached', () => {
      const { api, errorHandlers } = makeAgentApi();
      const onError = vi.fn();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => isAttached,
      });
      cm.onError = onError;

      errorHandlers[0]?.({ message: 'not attached to session: test', notAttached: true });
      expect(onError).not.toHaveBeenCalled();

      isAttached = true;
      errorHandlers[0]?.({ message: 'not attached to session: test', notAttached: true });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(new Error('not attached to session: test'));
      cm.dispose();
    });

    it('forwards non-not_attached errors even while detached', () => {
      const { api, errorHandlers } = makeAgentApi();
      const onError = vi.fn();
      const cm = new ConnectionManager({
        mode: 'p2p',
        sessionName: 'test',
        sessionId: 'a:test',
        agentApi: api,
        isAttached: () => false,
      });
      cm.onError = onError;

      errorHandlers[0]?.({ message: 'session terminated', notAttached: false });
      expect(onError).toHaveBeenCalledWith(new Error('session terminated'));
      cm.dispose();
    });

    it('does not forward output, resize, or errors after dispose', () => {
      const { api, outputHandlers, resizeHandlers, errorHandlers } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      const onOutput = vi.fn();
      const onResize = vi.fn();
      const onError = vi.fn();
      cm.onOutput = onOutput;
      cm.onResize = onResize;
      cm.onError = onError;

      cm.dispose();
      outputHandlers[0]?.({ data: new Uint8Array([1]) });
      resizeHandlers[0]?.({ cols: 80, rows: 24 });
      errorHandlers[0]?.({ message: 'boom', notAttached: false });
      expect(onOutput).not.toHaveBeenCalled();
      expect(onResize).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });

    it('unsubscribes from the agent api on dispose', () => {
      const { api, unsubs } = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      cm.dispose();
      expect(unsubs.output).toHaveBeenCalledTimes(1);
      expect(unsubs.resize).toHaveBeenCalledTimes(1);
      expect(unsubs.error).toHaveBeenCalledTimes(1);
    });

    it('a thrown agent send does not escape while the transport is reconnecting', () => {
      const { api } = makeAgentApi();
      (api.sendInput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('WebSocket not connected');
      });
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: api, ...attached,
      });
      expect(() => cm.send('hello')).not.toThrow();
      cm.dispose();
    });
  });

  describe('sequenced input delivery (#1307)', () => {
    /** A manager over the p2p harness, with the agent's cursor already seeded. */
    function seeded(over: { inputEpoch?: number; appliedThrough?: number; controlGeneration?: number } = {}) {
      const harness = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: harness.api, ...attached,
      });
      cm.seedInputCursor({
        inputEpoch: over.inputEpoch ?? 7,
        appliedThrough: over.appliedThrough ?? 0,
        controlGeneration: over.controlGeneration ?? 2,
      });
      return { harness, cm };
    }

    /** Push one acknowledgement to every subscriber the manager registered. */
    function deliverAck(
      harness: AgentApiHarness,
      ack: { inputEpoch: number; appliedThrough: number; controlGeneration?: number },
    ) {
      for (const handler of harness.inputAckHandlers) {
        handler({ sessionName: 'test', ...ack });
      }
    }

    /**
     * The mutation is dropping the sequence from the frame: the agent would
     * write the bytes and move no cursor, so nothing the user typed could ever
     * be acknowledged and no retry could be checked against anything.
     */
    it('sends input at a position once the agent has stated one', () => {
      const { harness, cm } = seeded({ appliedThrough: 4 });
      cm.send('a');
      expect(harness.api.sendInput).toHaveBeenCalledWith('test', 'a', {
        inputEpoch: 7,
        seqStart: 5,
        seqEnd: 5,
      });
      cm.dispose();
    });

    /**
     * A cursor is cumulative, so the next chunk continues it — this is the
     * derivation the whole retry story rests on, and a stored counter would
     * drift from it the first time an acknowledgement arrived.
     */
    it('numbers consecutive chunks from the cursor', () => {
      const { harness, cm } = seeded({ appliedThrough: 4 });
      cm.send('a');
      deliverAck(harness, { inputEpoch: 7, appliedThrough: 5 });
      cm.send('b');
      expect(harness.api.sendInput).toHaveBeenLastCalledWith('test', 'b', {
        inputEpoch: 7,
        seqStart: 6,
        seqEnd: 6,
      });
      cm.dispose();
    });

    /**
     * SC-03 at the client's end: the chunk an acknowledgement covered is gone
     * from the queue, so the flush after a reconnect re-sends the rest and not
     * the whole run. Sending it again would be a duplicate the agent has to
     * refuse, and the acknowledgement exists precisely so the client can stop
     * offering bytes the PTY already has.
     */
    it('does not re-send a chunk the agent has acknowledged', () => {
      const { harness, cm } = seeded();
      cm.send('a');
      cm.send('b');
      deliverAck(harness, { inputEpoch: 7, appliedThrough: 1 });
      vi.mocked(harness.api.sendInput).mockClear();
      cm.flushInputBuffer();
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);
      expect(harness.api.sendInput).toHaveBeenCalledWith('test', 'b', {
        inputEpoch: 7,
        seqStart: 2,
        seqEnd: 2,
      });
      cm.dispose();
    });

    /**
     * SC-04: the attach reply is the reconcile, and the queue keeps exactly the
     * run above the cursor it states. The mutation is flushing before
     * reconciling, or ignoring the stated cursor — either re-sends chunks the
     * agent already applied.
     */
    it('resends only what is above the cursor an attach states', () => {
      const { harness, cm } = seeded({ appliedThrough: 0 });
      cm.send('a');
      cm.send('b');
      cm.send('c');
      vi.mocked(harness.api.sendInput).mockClear();
      // The reattach: two of the three were applied and their acks were lost.
      cm.seedInputCursor({ inputEpoch: 7, appliedThrough: 2, controlGeneration: 2 });
      cm.flushInputBuffer();
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);
      expect(harness.api.sendInput).toHaveBeenCalledWith('test', 'c', {
        inputEpoch: 7,
        seqStart: 3,
        seqEnd: 3,
      });
      cm.dispose();
    });

    /**
     * SC-09 at the client's end: an epoch that moved means the agent that could
     * say whether these bytes landed is gone. Re-sending them would be
     * replaying input that may already have run.
     */
    it('discards pending input rather than replaying it when the epoch moves', () => {
      const { harness, cm } = seeded({ inputEpoch: 7 });
      cm.send('a');
      cm.send('b');
      vi.mocked(harness.api.sendInput).mockClear();
      cm.seedInputCursor({ inputEpoch: 8, appliedThrough: 0, controlGeneration: 2 });
      cm.flushInputBuffer();
      expect(harness.api.sendInput).not.toHaveBeenCalled();
      cm.dispose();
    });

    /**
     * SC-08: the lease moved to another client, so bytes typed under the old
     * generation must not arrive under the new one's name — which is what would
     * happen to a client that got the lease back and simply flushed what it had
     * been holding.
     */
    it('discards pending input when the control generation moves', () => {
      const { harness, cm } = seeded({ controlGeneration: 2 });
      cm.send('a');
      vi.mocked(harness.api.sendInput).mockClear();
      for (const handler of harness.controlChangedHandlers) {
        handler('test', { role: 'controller', generation: 3 });
      }
      cm.flushInputBuffer();
      expect(harness.api.sendInput).not.toHaveBeenCalled();
      cm.dispose();
    });

    /** A control change for another session says nothing about this one's input. */
    it('ignores a control change for another session', () => {
      const { harness, cm } = seeded({ controlGeneration: 2 });
      cm.send('a');
      vi.mocked(harness.api.sendInput).mockClear();
      for (const handler of harness.controlChangedHandlers) {
        handler('other', { role: 'controller', generation: 9 });
      }
      cm.flushInputBuffer();
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);
      cm.dispose();
    });

    /**
     * SC-07's last leg. Session, input epoch and control generation are named
     * in `InputIdentity`, and the runtime/transport generation is the odd one
     * out: it is not a field, because the queue *belongs* to a generation
     * rather than being tagged by one. A `ConnectionManager` owns its queue, so
     * a new generation starts empty and cannot flush what the previous one was
     * still holding.
     *
     * The binding is by ownership, and that is deliberate rather than a
     * shortcut. A transport *swap* inside one generation keeps its queue — a
     * P2P client that falls back to the relay is still the same runtime against
     * the same agent holding the same epoch, so those bytes are still this
     * session's to send and throwing them away would discard input the user
     * really typed. What must never happen is the reverse: a queue that
     * outlives its generation. That is what this pins, and the mutation is
     * hoisting `pendingInput` into a module- or session-keyed singleton, at
     * which point the second generation flushes the first's bytes.
     */
    it('does not let a new runtime generation deliver what the previous one held', () => {
      const first = seeded({ appliedThrough: 0 });
      first.cm.send('a');
      vi.mocked(first.harness.api.sendInput).mockClear();

      // A reattach builds a new generation over the same session: a fresh
      // transport and, here, a fresh queue.
      const second = seeded({ appliedThrough: 0 });
      second.cm.flushInputBuffer();
      expect(second.harness.api.sendInput).not.toHaveBeenCalled();

      // The first still holds its own, so this is two independent queues
      // rather than two empty ones.
      first.cm.flushInputBuffer();
      expect(first.harness.api.sendInput).toHaveBeenCalledWith('test', 'a', {
        inputEpoch: 7,
        seqStart: 1,
        seqEnd: 1,
      });

      first.cm.dispose();
      second.cm.dispose();
    });

    /** An acknowledgement for another run is not this queue's to apply. */
    it('ignores an acknowledgement for another epoch', () => {
      const { harness, cm } = seeded({ inputEpoch: 7 });
      cm.send('a');
      deliverAck(harness, { inputEpoch: 8, appliedThrough: 1 });
      vi.mocked(harness.api.sendInput).mockClear();
      cm.flushInputBuffer();
      expect(harness.api.sendInput).toHaveBeenCalledWith('test', 'a', {
        inputEpoch: 7,
        seqStart: 1,
        seqEnd: 1,
      });
      cm.dispose();
    });

    /**
     * An agent built before the input contract states no epoch, and a client
     * that numbered input anyway would be numbering against a cursor nobody
     * holds. The frame stays what it was: a keystroke with no position.
     */
    it('sends unsequenced input when the agent states no epoch', () => {
      const harness = makeAgentApi();
      const cm = new ConnectionManager({
        mode: 'p2p', sessionName: 'test', sessionId: 'a:test', agentApi: harness.api, ...attached,
      });
      cm.seedInputCursor({ inputEpoch: undefined, appliedThrough: undefined });
      cm.send('a');
      expect(harness.api.sendInput).toHaveBeenCalledWith('test', 'a');
      cm.dispose();
    });

    /**
     * A relay client with no cursor still sends what it always sent.
     *
     * The transport split that used to be *is* the split that remains, stated
     * by the one thing actually true about it: neither an agent built before
     * the contract nor a relay attach states a position, so there is nothing to
     * number against and the queue is a buffer rather than a retry log.
     */
    it('sends unsequenced relay input when no cursor was stated', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      cm.send('a');
      expect(ws.sendRelayInput).toHaveBeenCalledWith('test', 'a');
      cm.dispose();
    });

    /**
     * A bound refuses the newest input rather than evicting the oldest, because
     * the oldest carries the front position and evicting it would leave a run
     * the agent refuses forever. The refusal is recorded, not swallowed.
     */
    it('refuses input past the byte bound and keeps what it already holds', () => {
      const { harness, cm } = seeded({ appliedThrough: 0 });
      // Read from the policy rather than restated: the bound is a measured
      // figure and it moved once already (#1307 stage 5). A copy here would
      // have kept passing against the old number while testing nothing.
      cm.send('x'.repeat(INPUT_QUEUE_BOUNDS.maxBytes));
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);
      vi.mocked(harness.api.sendInput).mockClear();
      cm.send('y');
      expect(harness.api.sendInput).not.toHaveBeenCalled();
      // And the flush still offers the run it kept, at the position it had.
      cm.flushInputBuffer();
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);
      cm.dispose();
    });

    /**
     * The measurement the byte bound is set from (#1307 SC-14).
     *
     * A paste is one chunk, so the byte bound is the only thing that can refuse
     * one — and it refuses it whole. Measured: a realistic paste runs 50 KB
     * (a 200-line source block) to ~500 KB (a source file from this
     * repository's own corpus, its largest being 326 KB). At the 64 KiB this
     * bound shipped with, a user who pasted a file while a single keystroke was
     * pending lost the entire paste.
     *
     * The mutation is the bound's value: restore `64 * 1024` and the paste
     * below is refused, so `sendInput` is called once instead of twice.
     */
    it('admits a paste the size real ones measure at, alongside pending input', () => {
      const { harness, cm } = seeded({ appliedThrough: 0 });
      // One keystroke already pending, so the empty-queue exception does not
      // apply — this is the case the bound actually governs.
      cm.send('x');
      expect(harness.api.sendInput).toHaveBeenCalledTimes(1);

      cm.send('p'.repeat(500 * 1024));

      // Three frames, not two: the paste was admitted, so the flush offered the
      // whole unacknowledged run — the keystroke that was already pending, then
      // the paste at the position after it. What is asserted is that the paste
      // is *on the wire* at all, which is the half the bound decides.
      const calls = vi.mocked(harness.api.sendInput).mock.calls;
      expect(calls).toHaveLength(3);
      const [, pasted] = calls[2];
      expect(pasted).toHaveLength(500 * 1024);
      cm.dispose();
    });
  });

  describe('Relay mode', () => {
    it('send routes data via serverConnection.sendRelayInput', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      cm.send('hello');
      expect(ws.sendRelayInput).toHaveBeenCalledWith('test', 'hello');
      cm.dispose();
    });

    it('subscribes to terminal output on construction', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      expect(ws.onRelayOutput).toHaveBeenCalledWith('test', expect.any(Function));
      cm.dispose();
    });

    it('reports only the durable connection edges — intra-budget loss is a no-op', () => {
      const ws = makeMockWs();
      let stateCb: (state: ConnectionState) => void = () => {};
      (ws.onConnectionStateChange as ReturnType<typeof vi.fn>).mockImplementation(
        (cb: (state: ConnectionState) => void) => { stateCb = cb; return () => {}; },
      );
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
      });
      const calls: string[] = [];
      cm.onStateChange = (s) => calls.push(s);

      // Post-handshake 'connected' (old 'authenticated') and budget-exhausted
      // 'disconnected' are the only edges this transport reports — the
      // intra-budget window surfaces as 'connecting'/'reconnecting', which the
      // manager mirrors by staying silent (old facade collapsed them onto
      // 'connecting', which ConnectionManager also ignored).
      stateCb('connected');
      stateCb('disconnected');
      stateCb('connecting');
      stateCb('reconnecting');

      expect(calls).toEqual([
        'connected',
        'disconnected',
      ]);
      cm.dispose();
    });

    it('should send terminal.resize message in relay mode via sendRelayResize', () => {
      const ws = makeMockWs();
      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws, ...attached,
      });

      cm.sendResize(120, 40);

      expect(ws.sendRelayResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    it('subscribes to terminal resize and invokes onResize callback', () => {
      const onResize = vi.fn();
      let resizeHandler: (cols: number, rows: number) => void = () => {};
      const ws = makeMockWs();
      (ws.onRelayResize as ReturnType<typeof vi.fn>).mockImplementation(
        (_sid: string, cb: (cols: number, rows: number) => void) => {
          resizeHandler = cb;
          return () => {};
        },
      );

      const cm = new ConnectionManager({
        mode: 'relay', sessionName: 'test', sessionId: 'sess-1', serverConnection: ws,
      });
      cm.onResize = onResize;

      expect(ws.onRelayResize).toHaveBeenCalledWith('test', expect.any(Function));

      // Simulate server broadcasting terminal.resize for this session
      resizeHandler(120, 40);

      expect(onResize).toHaveBeenCalledWith(120, 40);
      cm.dispose();
    });

    it('buffers sendResize until attached in relay mode too (same outbound gate)', () => {
      const ws = makeMockWs();
      let isAttached = false;
      const cm = new ConnectionManager({
        mode: 'relay',
        sessionName: 'test',
        sessionId: 'a:test',
        serverConnection: ws,
        isAttached: () => isAttached,
      });

      cm.sendResize(120, 40);
      expect(ws.sendRelayResize).not.toHaveBeenCalled();

      isAttached = true;
      cm.flushPendingResize();
      expect(ws.sendRelayResize).toHaveBeenCalledWith('test', 120, 40);
      cm.dispose();
    });

    describe('sequenced input delivery (#1307 SC-05, SC-13)', () => {
      /**
       * A relay manager with the attach's cursor already reconciled.
       *
       * `seedInputCursor` is the entry point a relay attach reaches through the
       * same orchestration effect a direct one does — see the note on the
       * production wiring in the report, which is the one thing these tests
       * cannot show.
       */
      function seededRelay(
        over: { inputEpoch?: number; appliedThrough?: number } = {},
      ): {
        ws: ReturnType<typeof makeMockWs>;
        send: ReturnType<typeof vi.mocked<RelayServerTransport['sendRelayInput']>>;
        cm: ConnectionManager;
        deliverAck: (ack: Omit<TerminalInputAck, 'sessionName'>) => void;
      } {
        const ws = makeMockWs();
        let ackHandler: ((ack: TerminalInputAck) => void) | null = null;
        (ws.onRelayInputAck as ReturnType<typeof vi.fn>).mockImplementation(
          (_sid: string, cb: (ack: TerminalInputAck) => void) => {
            ackHandler = cb;
            return () => {};
          },
        );
        const cm = new ConnectionManager({
          mode: 'relay', sessionName: 'test', sessionId: 'a:test', serverConnection: ws, ...attached,
        });
        cm.seedInputCursor({
          inputEpoch: over.inputEpoch ?? 7,
          appliedThrough: over.appliedThrough ?? 0,
          controlGeneration: 2,
        });
        return {
          ws,
          send: vi.mocked(ws.sendRelayInput),
          cm,
          deliverAck: (ack) => ackHandler?.({ sessionName: 'test', ...ack }),
        };
      }

      /**
       * SC-05 on the client's half: a relay frame states its position.
       *
       * The mutation is **both** guards, and it has to be both — restoring the
       * `mode === 'relay'` branch in `flushInputBuffer` alone still sends
       * unsequenced bytes, and restoring the `mode !== 'p2p'` return in
       * `seedInputCursor` alone means the cursor never binds so `outbound()`
       * answers `null` and the frame goes out with no position. Only removing
       * the pair reaches this assertion, which is why the requirement's own
       * report recorded that a single-guard test proves nothing about the pair.
       */
      it('sequences relay input against the cursor the attach stated', () => {
        const { send, cm } = seededRelay({ appliedThrough: 4 });
        cm.send('a');
        expect(send).toHaveBeenCalledWith('test', 'a', {
          inputEpoch: 7,
          seqStart: 5,
          seqEnd: 5,
        });
        cm.dispose();
      });

      /**
       * Ordering is the invariant the requirement states outright: input A
       * before input B means the PTY sees A before B. On the relay that is a
       * property of the positions, because the Server's merge carries every
       * byte of a burst into one frame and the range it states is the range
       * those bytes occupy.
       */
      it('numbers consecutive relay chunks from the cursor, in order', () => {
        const { send, cm, deliverAck } = seededRelay({ appliedThrough: 0 });
        // Acknowledged between keystrokes so each flush offers exactly the run
        // standing above the cursor. Without the acknowledgements every flush
        // re-offers the whole unacknowledged run — that is what a retry log is
        // for, and the last flush would still show the order, but this states
        // the numbering rather than the retransmission.
        cm.send('a');
        deliverAck({ inputEpoch: 7, appliedThrough: 1 });
        cm.send('b');
        deliverAck({ inputEpoch: 7, appliedThrough: 2 });
        cm.send('c');
        expect(send.mock.calls).toEqual([
          ['test', 'a', { inputEpoch: 7, seqStart: 1, seqEnd: 1 }],
          ['test', 'b', { inputEpoch: 7, seqStart: 2, seqEnd: 2 }],
          ['test', 'c', { inputEpoch: 7, seqStart: 3, seqEnd: 3 }],
        ]);
        cm.dispose();
      });

      /**
       * SC-13's ACK propagation, end to end at the client's end.
       *
       * Before this, the server forwarded the agent's `agent.terminal.input.ack`
       * exactly as it forwards every other agent frame, and **nothing in the
       * browser was subscribed to it** — so a relay client's queue never
       * drained, every chunk stayed pending until the TTL discarded it, and
       * each flush re-offered bytes the PTY already had.
       *
       * The mutation is the missing `onRelayInputAck` subscription in
       * `setupRelay` (or the missing `agent.terminal.input.ack` subscribe in the
       * server plugin): the ack is delivered to nobody, and the flush below
       * re-sends both chunks.
       */
      it('drains acknowledged relay input, so a retry re-sends only the rest', () => {
        const { send, cm, deliverAck } = seededRelay({ appliedThrough: 0 });
        cm.send('a');
        cm.send('b');
        deliverAck({ inputEpoch: 7, appliedThrough: 1 });
        send.mockClear();
        cm.flushInputBuffer();
        expect(send.mock.calls).toEqual([
          ['test', 'b', { inputEpoch: 7, seqStart: 2, seqEnd: 2 }],
        ]);
        cm.dispose();
      });

      /**
       * A cursor names a position *in a run*, so an acknowledgement for another
       * epoch says nothing about this queue's — the same rule the direct path
       * applies, through the same reader, which is what keeps the two
       * transports from disagreeing about what an acknowledgement is.
       */
      it('ignores a relay acknowledgement that names another epoch', () => {
        const { send, cm, deliverAck } = seededRelay({ appliedThrough: 0 });
        cm.send('a');
        deliverAck({ inputEpoch: 8, appliedThrough: 1 });
        send.mockClear();
        cm.flushInputBuffer();
        expect(send).toHaveBeenCalledWith('test', 'a', {
          inputEpoch: 7,
          seqStart: 1,
          seqEnd: 1,
        });
        cm.dispose();
      });

      /**
       * SC-13's reconnect: the relay transport drops, the user keeps typing,
       * and the flush after it comes back re-sends the run at the positions it
       * already had.
       *
       * The mutation is deriving the position at flush time instead of
       * deriving it from the cursor — a renumbering would leave the run
       * continuing nothing, and the agent refuses a frame that does not
       * continue its cursor, so no later input could ever land.
       */
      it('re-sends what a dropped relay transport could not carry, at the same positions', () => {
        const { ws, send, cm, deliverAck } = seededRelay({ appliedThrough: 0 });
        cm.send('a');
        deliverAck({ inputEpoch: 7, appliedThrough: 1 });

        let ready = false;
        (ws.isReady as ReturnType<typeof vi.fn>).mockImplementation(() => ready);
        cm.send('b');
        cm.send('c');
        expect(send).toHaveBeenCalledTimes(1);

        ready = true;
        cm.flushInputBuffer();
        expect(send.mock.calls.slice(1)).toEqual([
          ['test', 'b', { inputEpoch: 7, seqStart: 2, seqEnd: 2 }],
          ['test', 'c', { inputEpoch: 7, seqStart: 3, seqEnd: 3 }],
        ]);
        cm.dispose();
      });

      /**
       * SC-11: healthy input costs one frame per keystroke.
       *
       * `flushInputBuffer` re-offers **everything above the cursor**, and that
       * is deliberate — it is the retry, and a lost acknowledgement costs
       * nothing because the next one says the same thing. The cost of that
       * decision is invisible until the acknowledgements stop, which is why it
       * is measured here rather than asserted in prose:
       *
       * * **Measured, acknowledgements keeping up:** 64 keystrokes produce
       *   **64** frames — one each. That is the bound below.
       * * **Measured, acknowledgements stalled:** the same 64 keystrokes
       *   produce **2080** frames, i.e. `K(K+1)/2`. Each keystroke re-offers
       *   the whole unacknowledged run, so the cost is quadratic in the run
       *   length rather than linear in the keystrokes. That number is *not*
       *   pinned — it is the present shape of the retry, and a later change
       *   that offered only the new chunk would be an improvement this test
       *   must not fail.
       *
       * The healthy figure is what SC-11 promises, and it holds only while the
       * acknowledgement is consumed. The mutation is that consumption —
       * dropping the `pendingInput.acknowledge` call in `applyInputAck` (or the
       * `onRelayInputAck` subscription that feeds it) leaves the cursor at 0,
       * and this test then measures the quadratic case instead: 2080 frames
       * for 64 keystrokes.
       */
      it('offers one frame per keystroke while acknowledgements keep up', () => {
        const { send, cm, deliverAck } = seededRelay({ appliedThrough: 0 });

        const keystrokes = 64;
        for (let i = 1; i <= keystrokes; i += 1) {
          cm.send('a');
          // The agent answers each frame before the next keystroke — the
          // healthy round trip, which is the state this bound is about.
          deliverAck({ inputEpoch: 7, appliedThrough: i });
        }

        expect(send).toHaveBeenCalledTimes(keystrokes);
        cm.dispose();
      });
    });
  });
});
