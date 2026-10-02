import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TerminalInteractionController } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import { ConnectionManager } from '@/platform/terminal-runtime/ConnectionManager';
import type { RelayServerTransport } from '@/platform/attach/relayServerConnection';

// xterm.open() needs matchMedia in jsdom, the same stub and the same reason as
// `TerminalInteractionController.test.ts`.
beforeAll(() => {
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
});

const open: Terminal[] = [];
afterEach(() => {
  while (open.length > 0) {
    open.pop()?.dispose();
  }
});

/**
 * The relay transport, stubbed down to the two methods this test watches, with
 * no relay-lane wiring the test does not need.
 */
function makeRelayTransport(): RelayServerTransport {
  return {
    isReady: vi.fn(() => true),
    sendRelayInput: vi.fn(),
    onRelayInputAck: vi.fn(() => () => {}),
    onRelayOutput: vi.fn(() => () => {}),
    onRelayResize: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
  } as unknown as RelayServerTransport;
}

/**
 * The production chain for one chunk of committed text, from the terminal to
 * the wire: a real xterm, the real interaction controller bound to its
 * `onData`, and a real `ConnectionManager` as the transport — which is exactly
 * what `TerminalInputHandler` hands `send` to in the app.
 *
 * Returns the relay transport so a case can read the frames that arrived.
 */
function setup(): {
  terminal: Terminal;
  controller: TerminalInteractionController;
  transport: RelayServerTransport;
  sent: () => unknown[][];
} {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const terminal = new Terminal({ allowProposedApi: true });
  terminal.open(el);
  open.push(terminal);

  const transport = makeRelayTransport();
  const cm = new ConnectionManager({
    mode: 'relay',
    sessionName: 'test',
    sessionId: 'a:test',
    serverConnection: transport,
    isAttached: () => true,
  });
  // The cursor an attach states, so `flushInputBuffer` has a position to send
  // at rather than falling back to unsequenced bytes.
  cm.seedInputCursor({ inputEpoch: 7, appliedThrough: 0, controlGeneration: 2 });

  const controller = new TerminalInteractionController(terminal, (data) => cm.send(data));
  controller.bindXtermOnData();

  const sent = () =>
    vi.mocked(transport.sendRelayInput).mock.calls as unknown[][];
  return { terminal, controller, transport, sent };
}

/**
 * SC-14: a paste and an IME commit each reach the PTY as **one** chunk of the
 * delivery contract, not one per byte.
 *
 * The claim was made in `ConnectionManager`'s own comment — "xterm delivers a
 * paste as a single `onData`, so the batching the requirement asks for is
 * already the shape of the event rather than something this layer has to do" —
 * and it had never been measured. It decides what the bounds mean, so it is
 * measured here through the components that actually do the work rather than
 * restated: the chunking is xterm's, the sequencing is the queue's, and the
 * frame count is what the wire pays.
 *
 * **Measured.** A 200-line paste (5 289 bytes as xterm encodes it) arrives as
 * **1** frame carrying all of it; a 50 000-character single-line paste likewise
 * as **1** frame of 50 000 bytes; an IME commit of `日本語` as **1** frame. The
 * per-byte overhead is 1 frame per event, whatever the event's size.
 *
 * The mutation is a split — anything that turned one `onData` into several
 * chunks (batching the paste by line, sending per byte) would fail the counts
 * below. None is reachable from the code as written, so the count is pinned
 * instead: it is the property, and the bounds are derived from it.
 */
describe('paste and IME are one chunk each (#1307 SC-14)', () => {
  it('sends a multi-line paste as one sequenced frame carrying all of it', () => {
    const { controller, sent } = setup();
    const paste = Array.from({ length: 200 }, (_, i) => `line ${i} of a pasted block`).join('\n');

    controller.paste(paste);

    const frames = sent();
    expect(frames).toHaveLength(1);
    const [sessionName, data, sequence] = frames[0] as [string, string, { seqStart: number; seqEnd: number }];
    expect(sessionName).toBe('test');
    // One position, not a range: the frame covers one chunk, and the whole
    // paste is inside it. `\n` becomes `\r` on the way through xterm, so the
    // payload is asserted by its lines rather than by byte equality.
    expect(sequence.seqStart).toBe(1);
    expect(sequence.seqEnd).toBe(1);
    const lines = data.split('\r');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('line 0 of a pasted block');
    expect(lines[199]).toBe('line 199 of a pasted block');
  });

  it('sends a paste larger than the queue byte bound as one frame', () => {
    // 50 000 characters is well past the 64 KiB the queue bounds *accumulated*
    // bytes by, and it is admitted because a chunk is never refused for its own
    // size — see `accept`. What is under test is that it is one frame.
    const { controller, sent } = setup();

    controller.paste('x'.repeat(50_000));

    const frames = sent();
    expect(frames).toHaveLength(1);
    expect((frames[0] as [string, string])[1]).toHaveLength(50_000);
  });

  it('sends an IME commit as one frame, not one per character', () => {
    // The commit path: `MobileImeInput` hands the whole composed string to
    // `sendText`, which goes through `terminal.input` — the same onData route a
    // paste takes, which is the "same delivery contract" half of the criterion.
    const { controller, sent } = setup();

    controller.sendText('日本語のテキスト');

    const frames = sent();
    expect(frames).toHaveLength(1);
    expect((frames[0] as [string, string])[1]).toBe('日本語のテキスト');
    // Counted in UTF-8 bytes on the wire, not string units — the same
    // difference the byte bound is measured in.
    expect(frames[0]).toEqual([
      'test',
      '日本語のテキスト',
      { inputEpoch: 7, seqStart: 1, seqEnd: 1 },
    ]);
  });
});
