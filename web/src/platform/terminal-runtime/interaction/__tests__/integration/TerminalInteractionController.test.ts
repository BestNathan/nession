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
