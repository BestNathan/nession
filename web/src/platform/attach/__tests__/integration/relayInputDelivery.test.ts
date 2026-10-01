import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayServerHandle } from '@/platform/attach/relayServerConnection';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import { WebSocketService } from '@/platform/socket/WebSocketService';
import { terminalServerApi } from '@/product/terminal';
import { MockWebSocket } from '@/test/mockWebSocket';
import type { SocketMessage } from '@/platform/socket/types';

const OriginalWebSocket = globalThis.WebSocket;

/** Parse every JSON frame a mock socket sent over the wire. */
function frames(socket: MockWebSocket): SocketMessage[] {
  return socket.send.mock.calls.map((call) => JSON.parse(String(call[0])) as SocketMessage);
}

/** The input frames the server relay would have been asked to carry. */
function inputFrames(socket: MockWebSocket): SocketMessage[] {
  return frames(socket).filter((m) => m.msg_type === 'agent.terminal.input');
}

/**
 * The relay input contract across every seam it crosses (#1307 SC-05, SC-13).
 *
 * The unit tests either side of this each pass with the other wrong — that is
 * exactly how stage 3 shipped a reconcile that type-checked and did nothing:
 * a field-name divergence is invisible while the two halves are mocked apart.
 * This one wires the real `TerminalServerPlugin`, the real `relayServerHandle`
 * delegation, a real `WebSocketService` over a mock socket, and a real
 * `ConnectionManager` together, so the name the manager subscribes with, the
 * name the plugin routes by, and the name on the wire all have to agree for
 * anything to arrive.
 *
 * Live under `integration/` rather than `unit/` because it is the *agreement*
 * being asserted, not either side's behaviour.
 */
describe('relay input delivery, end to end across the seam', () => {
  beforeEach(() => {
    // `instances` is static and never cleared by the class, so without this a
    // second test would open the *first* test's socket while `connect()` waited
    // on its own — the timeout reads as a product defect and is a stale handle.
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = OriginalWebSocket;
    vi.useRealTimers();
  });

  /**
   * Build the production relay wiring over a mock socket: the app's own
   * terminal-server singleton installed on a fresh service, the handle the
   * runtime builds from it, and a manager in relay mode over that handle.
   */
  async function wired(sessionName: string) {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const service = new WebSocketService('ws://server/ws', [terminalServerApi]);
    const connected = service.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await connected;

    const handle = relayServerHandle(service, terminalServerApi);
    const cm = new ConnectionManager({
      mode: 'relay',
      sessionName,
      sessionId: `a:${sessionName}`,
      serverConnection: handle,
      isAttached: () => true,
    });
    return { service, socket, cm };
  }

  /**
   * The cursor the agent states on attach is what the client numbers against,
   * and the position reaches the wire — through the plugin's payload builder,
   * the handle's delegation and the socket's encoder.
   */
  it('sends input at the position the attach stated', async () => {
    const { service, socket, cm } = await wired('work');

    cm.seedInputCursor({ inputEpoch: 7, appliedThrough: 4, controlGeneration: 2 });
    cm.send('a');

    expect(inputFrames(socket)).toEqual([
      expect.objectContaining({
        payload: {
          session_name: 'work',
          data: btoa('a'),
          input_epoch: 7,
          seq_start: 5,
          seq_end: 5,
        },
      }),
    ]);

    cm.dispose();
    service.dispose();
  });

  /**
   * SC-13's acknowledgement, all the way in.
   *
   * The Server forwards `agent.terminal.input.ack` to the browser exactly as it
   * forwards every other agent frame, so the only question was whether anything
   * on this side read it. Before this change nothing did: the frame arrived and
   * was dropped, the queue never drained, and every later flush re-offered
   * bytes the PTY already had — until the TTL discarded them and reported input
   * the user had actually typed as lost.
   *
   * The assertion is the *effect* — the queue is empty — rather than that a
   * callback ran, because a callback that runs and does not acknowledge is the
   * same defect wearing a green test.
   */
  it('drains the queue when the agent acknowledges, on the relay lane', async () => {
    const { service, socket, cm } = await wired('work');
    cm.seedInputCursor({ inputEpoch: 7, appliedThrough: 0, controlGeneration: 2 });
    cm.send('a');
    expect(inputFrames(socket)).toHaveLength(1);

    socket.message(
      JSON.stringify({
        msg_type: 'agent.terminal.input.ack',
        id: 'ack-1',
        timestamp: 0,
        payload: { session_name: 'work', input_epoch: 7, applied_through: 1 },
      }),
    );

    // The queue is empty, so the flush that a retry would perform offers
    // nothing: the chunk the agent applied is gone, not merely re-sent.
    cm.flushInputBuffer();
    expect(inputFrames(socket)).toHaveLength(1);

    cm.dispose();
    service.dispose();
  });

  /**
   * The same acknowledgement, routed by the *wrong* session.
   *
   * The agent broadcasts its cursor to every peer of a session, and a browser
   * holds one connection for all of them, so a frame for another session
   * arrives on this socket as a matter of course. Applying it here would move
   * this queue's cursor to a position another session's agent stated — the
   * bytes above it would be dropped as applied and never reach the PTY.
   */
  it('ignores an acknowledgement routed to another session', async () => {
    const { service, socket, cm } = await wired('work');
    cm.seedInputCursor({ inputEpoch: 7, appliedThrough: 0, controlGeneration: 2 });
    cm.send('a');

    socket.message(
      JSON.stringify({
        msg_type: 'agent.terminal.input.ack',
        id: 'ack-1',
        timestamp: 0,
        payload: { session_name: 'other', input_epoch: 7, applied_through: 1 },
      }),
    );

    cm.flushInputBuffer();
    expect(inputFrames(socket)).toHaveLength(2);

    cm.dispose();
    service.dispose();
  });
});
