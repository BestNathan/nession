import { describe, it, expect, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TerminalInteractionController } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';

// xterm.open() needs matchMedia in jsdom.
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

const open: Terminal[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.dispose();
  }
});

/**
 * A real xterm over a real DOM, with the same wiring production uses: the
 * interaction layer is bound to onData, which is what carries bytes to the PTY.
 */
function setup(): {
  terminal: Terminal;
  controller: TerminalInteractionController;
  sent: string[];
  unbind: () => void;
} {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const terminal = new Terminal({ allowProposedApi: true });
  terminal.open(el);
  open.push(terminal);

  const sent: string[] = [];
  const controller = new TerminalInteractionController(terminal, (data) => {
    sent.push(data);
  });
  const unbind = controller.bindXtermOnData();
  return { terminal, controller, sent, unbind };
}

/** Resolve once xterm has parsed the write, so mode changes are in effect. */
function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, () => resolve());
  });
}

describe('TerminalInteractionController — semantic keys', () => {
  it('delivers a semantic key to the PTY at all (#1096)', () => {
    // The regression: sendSemanticKey used to dispatch a constructed
    // KeyboardEvent, which carries keyCode 0. xterm's key evaluator is
    // keyCode-driven, so it recognised nothing and sent nothing — silently. The
    // capsule's arrows, Home/End/PgUp/PgDn and Del are all semantic keys, so
    // they produced no bytes at all.
    const { controller, sent, unbind } = setup();

    controller.sendSemanticKey('ArrowUp');

    expect(sent).toEqual(['\x1b[A']);
    unbind();
  });

  it('follows application cursor mode (#1096)', async () => {
    // Same call, different terminal mode — this pair is the point. A constant
    // encoder passes one of these and fails the other.
    const { terminal, controller, sent, unbind } = setup();

    await write(terminal, '\x1b[?1h'); // DECSET 1 — application cursor keys
    const modes = terminal.modes as unknown as { applicationCursorKeysMode: boolean };
    expect(modes.applicationCursorKeysMode).toBe(true);

    controller.sendSemanticKey('ArrowUp');

    expect(sent).toEqual(['\x1bOA']);
    unbind();
  });

  it('encodes every cursor key for the active cursor mode (#1096)', async () => {
    const normal = setup();
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
      normal.controller.sendSemanticKey(key);
    }
    expect(normal.sent).toEqual(['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C']);
    normal.unbind();

    const application = setup();
    await write(application.terminal, '\x1b[?1h');
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
      application.controller.sendSemanticKey(key);
    }
    expect(application.sent).toEqual(['\x1bOA', '\x1bOB', '\x1bOD', '\x1bOC']);
    application.unbind();
  });

  it('encodes Home/End for the active cursor mode (#1096)', async () => {
    const normal = setup();
    normal.controller.sendSemanticKey('Home');
    normal.controller.sendSemanticKey('End');
    expect(normal.sent).toEqual(['\x1b[H', '\x1b[F']);
    normal.unbind();

    const application = setup();
    await write(application.terminal, '\x1b[?1h');
    application.controller.sendSemanticKey('Home');
    application.controller.sendSemanticKey('End');
    expect(application.sent).toEqual(['\x1bOH', '\x1bOF']);
    application.unbind();
  });

  it('encodes the remaining semantic keys as a physical keyboard would (#1096)', () => {
    const { controller, sent, unbind } = setup();

    controller.sendSemanticKey('PageUp');
    controller.sendSemanticKey('PageDown');
    controller.sendSemanticKey('Delete');
    controller.sendSemanticKey('Escape');
    controller.sendSemanticKey('Tab');
    controller.sendSemanticKey('Enter');
    controller.sendSemanticKey('Backspace');
    controller.sendSemanticKey('Space');

    expect(sent).toEqual([
      '\x1b[5~',
      '\x1b[6~',
      '\x1b[3~',
      '\x1b',
      '\t',
      '\r',
      '\x7f',
      ' ',
    ]);
    unbind();
  });

  it('does not send when an observer client has stdin disabled (#1095)', () => {
    const { terminal, controller, sent, unbind } = setup();
    terminal.options.disableStdin = true;

    controller.sendSemanticKey('ArrowUp');

    expect(sent).toEqual([]);
    unbind();
  });
});

/** The mode a TUI just asked for, read the way production reads it. */
function mouseTrackingMode(terminal: Terminal): string {
  // Read `modes` fresh every time. It is a new object per access, and
  // `mouseTrackingMode` is computed as the object is built — so a captured
  // reference answers `none` for ever, however many DECSETs arrive afterwards.
  // The fields that read through to `decPrivateModes` (application cursor keys,
  // bracketed paste) survive capture; this one does not. Production reads it
  // fresh (`occlusionScroll`), and so must a test.
  return (terminal.modes as unknown as { mouseTrackingMode: string }).mouseTrackingMode;
}

/**
 * Mode transitions, driven the way an application drives them — by writing the
 * DECSET/DECRST the TUI would emit, into the same xterm the bytes come back
 * from (#1096 criterion 13).
 *
 * This is the encoder-and-decision half of the mode matrix. It is deterministic
 * and needs no shell, no TUI and no account: the terminal state is established
 * by the escape sequence itself rather than by a stub, which is what makes the
 * assertions about *reachability* and not only about branch selection.
 */
describe('TerminalInteractionController — terminal mode transitions', () => {
  it('wraps a paste only while the application has asked for bracketed paste (#1096)', async () => {
    // Criterion 6. Previously asserted as "terminal.paste was called with the
    // text", which is not the property: the property is what the PTY receives,
    // and it is xterm's mode — not our call — that decides.
    const { terminal, controller, sent, unbind } = setup();

    controller.paste('a\nb');
    expect(sent).toEqual(['a\rb']);

    await write(terminal, '\x1b[?2004h'); // DECSET 2004 — bracketed paste
    sent.length = 0;
    controller.paste('a\nb');
    expect(sent).toEqual(['\x1b[200~a\rb\x1b[201~']);

    await write(terminal, '\x1b[?2004l');
    sent.length = 0;
    controller.paste('a\nb');
    expect(sent).toEqual(['a\rb']);

    unbind();
  });

  it('reaches the mouse-tracking mode the scroll policy branches on (#1096)', async () => {
    // `occlusionScroll` decides whether a wheel event belongs to the TUI or to
    // local scrollback by reading exactly this. Its unit test hands the branch a
    // hand-written `modes` literal, so nothing until now established that the
    // mode a real TUI asks for is reachable at all.
    const { terminal, unbind } = setup();

    expect(mouseTrackingMode(terminal)).toBe('none');

    await write(terminal, '\x1b[?1000h'); // VT200 — click reporting
    expect(mouseTrackingMode(terminal)).toBe('vt200');

    await write(terminal, '\x1b[?1002h'); // DRAG — button-event tracking
    expect(mouseTrackingMode(terminal)).toBe('drag');

    // SGR is an encoding of the reports, not a different tracking mode, so the
    // protocol must not move when only the encoding does.
    await write(terminal, '\x1b[?1006h');
    expect(mouseTrackingMode(terminal)).toBe('drag');

    await write(terminal, '\x1b[?1000l\x1b[?1002l\x1b[?1006l');
    expect(mouseTrackingMode(terminal)).toBe('none');

    unbind();
  });

  it('keeps cursor-key encoding tied to the cursor mode, not to the screen buffer (#1096)', async () => {
    // Two different modes that a TUI flips at nearly the same moment, and the
    // requirement warns against treating either as a proxy for the other. An
    // alternate screen on its own changes nothing about how a key is encoded.
    const { terminal, controller, sent, unbind } = setup();

    await write(terminal, '\x1b[?1049h'); // DECSET 1049 — alternate screen
    expect(terminal.buffer.active.type).toBe('alternate');

    controller.sendSemanticKey('ArrowUp');
    expect(sent).toEqual(['\x1b[A']);

    await write(terminal, '\x1b[?1049l');
    expect(terminal.buffer.active.type).toBe('normal');

    sent.length = 0;
    await write(terminal, '\x1b[?1h'); // the mode that *does* decide
    controller.sendSemanticKey('ArrowUp');
    expect(sent).toEqual(['\x1bOA']);

    unbind();
  });

  it('passes committed CJK text through unchanged and in one piece (#1096)', () => {
    // What the IME hands over once composition commits. Byte-for-byte, and not
    // split per code point — the PTY is UTF-8 and the application decides how to
    // measure it.
    const { controller, sent, unbind } = setup();

    controller.sendText('日本語');

    expect(sent).toEqual(['日本語']);
    unbind();
  });

  it('passes raw control bytes to the PTY without interpreting them (#1096)', () => {
    // Criterion 1's other half: Nession does not read meaning into a byte the
    // terminal produced. Ctrl+D in particular used to be intercepted as a
    // Nession disconnect.
    const { controller, sent, unbind } = setup();

    controller.sendPtyBytes('\x03');
    controller.sendPtyBytes('\x04');

    expect(sent).toEqual(['\x03', '\x04']);
    unbind();
  });
});
