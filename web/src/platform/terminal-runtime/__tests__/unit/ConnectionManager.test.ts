import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import type { AgentError, TerminalAgentApi, TerminalResizeFrame } from '@/product/terminal';
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
}

function makeAgentApi(): AgentApiHarness & { unsubs: { output: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } } {
  const outputHandlers: Array<(frame: { data: Uint8Array; streamEpoch?: number; streamSeq?: number; bootstrap?: TerminalBootstrap }) => void> = [];
  const resizeHandlers: Array<(frame: TerminalResizeFrame) => void> = [];
  const errorHandlers: Array<(error: AgentError) => void> = [];
  const unsubs = {
    output: vi.fn(() => {}),
    resize: vi.fn(() => {}),
    error: vi.fn(() => {}),
  };
  const api = {
    attach: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    getControlState: vi.fn(() => ({ role: 'controller' as const })),
    acquireControl: vi.fn(),
    onControlChanged: vi.fn(() => () => {}),
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
    unsubs,
  };
}

function makeMockWs(): RelayServerTransport {
  return {
    sendRelayInput: vi.fn(),
    sendRelayResize: vi.fn(),
    onRelayOutput: vi.fn().mockReturnValue(() => {}),
    onRelayResize: vi.fn().mockReturnValue(() => {}),
    onConnectionStateChange: vi.fn().mockReturnValue(() => {}),
    beginRelay: vi.fn(),
    endRelay: vi.fn(),
    isReady: () => true,
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
  });
});
